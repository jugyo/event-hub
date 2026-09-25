#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

import { initProject } from "./init.ts";
import type { SecretBackend } from "./secrets/backend.ts";
import { KeychainSecretBackend } from "./secrets/keychain.ts";
import { SecretConfigurationError, SecretService } from "./secrets/service.ts";
import { registerLaunchAgent, unregisterLaunchAgent } from "./launch-agent.ts";
import { projectStatus, tickProject, updateInvocation } from "./operations.ts";
import { JsonLogger } from "@jugyo/duex";
import { TextLogger } from "./text-logger.ts";
import { serveWeb } from "./web-server.ts";

interface CliDependencies {
  projectRoot: string;
  backend?: SecretBackend;
  createBackend?(projectRoot: string): SecretBackend;
  readSecret(): Promise<string>;
  out(message: string): void;
  error(message: string): void;
  executable?: string;
  nodeExecutable?: string;
  home?: string;
  launchctl?: string;
  uid?: number;
  runLaunchctl?(path: string, args: string[]): Promise<number>;
  serveWeb?(options: {
    projectRoot: string;
    port: number;
    signal: AbortSignal;
    onStarted(url: string): void;
  }): Promise<string>;
}

async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/\r?\n$/, "");
  }

  process.stderr.write("Secret value: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          process.stderr.write("\n");
          return value;
        }
        if (character === "\u0003") throw new Error("Secret input was cancelled");
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    }
    return value;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function defaultDependencies(): CliDependencies {
  const projectRoot = process.cwd();
  return {
    projectRoot,
    createBackend: (root) => new KeychainSecretBackend({ projectRoot: root }),
    readSecret: readSecretInput,
    out: (message) => console.log(message),
    error: (message) => console.error(message),
  };
}

function usage(error: (message: string) => void): number {
  error("Usage: event-hub init [directory]");
  error("          event-hub tick [--root <directory>] [--max-runs <n>] [--debug] [--json]");
  error("          event-hub status [--root <directory>] [--json]");
  error("          event-hub web [--root <directory>] [--port <number>]");
  error("          event-hub invocation retry|cancel <id> [--root <directory>] [--json]");
  error("          event-hub launch-agent register|unregister [--root <directory>] [--debug]");
  error("          event-hub secret add|update <reference>");
  error("          event-hub secret list");
  error("          event-hub secret delete <reference>");
  return 2;
}

export async function run(argv = process.argv.slice(2), dependencies = defaultDependencies()): Promise<number> {
  const portIndex = argv.indexOf("--port");
  if (portIndex !== -1) {
    const value = argv[portIndex + 1];
    const port = Number(value);
    if (!value || !Number.isInteger(port) || port < 1 || port > 65_535) {
      dependencies.error("Invalid port: expected an integer from 1 to 65535");
      return 2;
    }
  }
  const parsed = parseOptions(argv);
  if (!parsed) return usage(dependencies.error);
  const { positionals, root, json, debug, maxRuns, port } = parsed;
  const [command, subject, name, ...extra] = positionals;
  const projectRoot = resolve(root ?? dependencies.projectRoot);

  try {
    if (command === "init" && name === undefined && extra.length === 0) {
      const result = await initProject(subject);
      dependencies.out(`Initialized: ${result.projectRoot}`);
      return 0;
    }
    if (command === "web" && subject === undefined && !json && !debug && maxRuns === undefined) {
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const serving = dependencies.serveWeb ?? serveWeb;
        const urlPromise = serving({
          projectRoot,
          port: port ?? 3000,
          signal: controller.signal,
          onStarted: (url) => dependencies.out(`Web UI: ${url}`),
        });
        await urlPromise;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      return 0;
    }
    if (port !== undefined) return usage(dependencies.error);
    const backend =
      dependencies.backend ?? dependencies.createBackend?.(projectRoot) ?? new KeychainSecretBackend({ projectRoot });
    const secrets = new SecretService(projectRoot, backend);
    if (command === "tick" && subject === undefined) {
      // `--json` keeps stdout parseable, so its diagnostics stay JSON Lines on stderr.
      const level = debug ? "debug" : "info";
      const logger = json
        ? new JsonLogger({ level, write: dependencies.error })
        : new TextLogger({ level, write: dependencies.out });
      const result = await tickProject(projectRoot, secrets, maxRuns, logger);
      dependencies.out(
        json
          ? JSON.stringify(result)
          : `Tick complete: ${result.runs.length} run(s), ${result.materialized.length} invocation(s) created${result.skipped ? " (another runner is active)" : ""}`,
      );
      return 0;
    }
    if (command === "status" && subject === undefined) {
      const statuses = await projectStatus(projectRoot, secrets);
      if (json) dependencies.out(JSON.stringify({ plugins: statuses }));
      else if (statuses.length === 0) dependencies.out("No plugins found");
      else
        for (const status of statuses)
          dependencies.out(
            [
              status.id,
              status.kind,
              status.state,
              `lastRun=${status.lastRunAt ?? "-"}`,
              `invocation=${status.lastInvocationId ?? "-"}`,
              `pending=${status.pending}`,
              ...(status.failure ? [`failure=${status.failure}`] : []),
            ].join("\t"),
          );
      return 0;
    }
    if (command === "invocation" && (subject === "retry" || subject === "cancel") && name && extra.length === 0) {
      const invocation = await updateInvocation(projectRoot, secrets, subject, name);
      dependencies.out(
        json
          ? JSON.stringify(invocation)
          : `Invocation ${name} ${subject === "retry" ? "was scheduled for retry" : "was cancelled"}`,
      );
      return 0;
    }
    if (command === "launch-agent" && (subject === "register" || subject === "unregister") && name === undefined) {
      const executable = dependencies.executable ?? (process.argv[1] ? realpathSync(process.argv[1]) : "event-hub");
      const options = {
        projectRoot,
        executable,
        nodeExecutable: dependencies.nodeExecutable ?? process.execPath,
        home: dependencies.home,
        launchctl: dependencies.launchctl,
        uid: dependencies.uid,
        runCommand: dependencies.runLaunchctl,
        debug,
      };
      const result = subject === "register" ? await registerLaunchAgent(options) : await unregisterLaunchAgent(options);
      dependencies.out(`LaunchAgent ${subject === "register" ? "registered" : "unregistered"}: ${result.label}`);
      return 0;
    }
    if (command !== "secret" || subject === undefined || extra.length > 0) return usage(dependencies.error);
    const service = secrets;
    if (subject === "list" && name === undefined) {
      for (const reference of await service.listStatuses()) dependencies.out(`${reference.name}\t${reference.status}`);
      return 0;
    }
    if (subject === "delete" && name !== undefined) {
      await service.delete(name);
      dependencies.out(`Secret deleted: ${name}`);
      return 0;
    }
    if ((subject === "add" || subject === "update") && name !== undefined) {
      const value = await dependencies.readSecret();
      if (value.length === 0) throw new SecretConfigurationError("A secret cannot be empty");
      if (subject === "add") await service.create(name, value);
      else await service.update(name, value);
      dependencies.out(`Secret ${subject === "add" ? "added" : "updated"}: ${name}`);
      return 0;
    }
    return usage(dependencies.error);
  } catch (error) {
    dependencies.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

function parseOptions(argv: string[]): {
  positionals: string[];
  root?: string;
  json: boolean;
  debug: boolean;
  maxRuns?: number;
  port?: number;
} | null {
  const positionals: string[] = [];
  let root: string | undefined;
  let maxRuns: number | undefined;
  let port: number | undefined;
  let json = false;
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--debug") {
      debug = true;
      continue;
    }
    if (value === "--root") {
      root = argv[++index];
      if (!root) return null;
      continue;
    }
    if (value === "--max-runs") {
      const raw = argv[++index];
      maxRuns = Number(raw);
      if (!raw || !Number.isInteger(maxRuns) || maxRuns < 0) return null;
      continue;
    }
    if (value === "--port") {
      const raw = argv[++index];
      port = Number(raw);
      if (!raw || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
      continue;
    }
    if (value.startsWith("--")) return null;
    positionals.push(value);
  }
  return { positionals, root, json, debug, maxRuns, port };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  process.exitCode = await run();
}
