import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILENAME } from "./init.ts";
import { readProjectStatus, type PluginStatus } from "./operations.ts";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STATIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "web");
const EVENT_HUB_VERSION = "0.2.0";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface WebServerOptions {
  projectRoot: string;
  port?: number;
  signal?: AbortSignal;
  staticRoot?: string;
  onStarted?(url: string): void;
  statusProvider?(projectRoot: string): Promise<PluginStatus[]>;
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export interface RunningWebServer {
  url: string;
  close(): Promise<void>;
}

export class WebServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebServerError";
  }
}

async function validateProjectRoot(projectRoot: string): Promise<void> {
  try {
    if (!(await stat(projectRoot)).isDirectory()) throw new Error("not a directory");
    const config = JSON.parse(await readFile(resolve(projectRoot, CONFIG_FILENAME), "utf8"));
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config");
  } catch {
    throw new WebServerError(`Invalid event-hub project: ${CONFIG_FILENAME} is missing or invalid`);
  }
}

function apiNotFound(response: import("node:http").ServerResponse): void {
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "API route not found", details: null } });
}

function publicPlugin(status: PluginStatus) {
  return {
    id: status.id,
    kind: status.displayKind,
    loadState: status.loadState,
    lastRun: status.lastRunAt
      ? {
          startedAt: status.lastRunStartedAt,
          finishedAt: status.lastRunFinishedAt,
          status: status.lastRunStatus,
        }
      : null,
    pendingWork: status.pending,
    failure: status.failure
      ? {
          code: "PLUGIN_EXECUTION_FAILED",
          message: "The plugin did not complete successfully",
          occurredAt: status.lastRunAt,
        }
      : null,
    diagnostics: status.diagnostics,
  };
}

async function existingAsset(staticRoot: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(staticRoot, `.${decoded}`);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${sep}`)) return null;
  try {
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function sendFile(response: import("node:http").ServerResponse, path: string): void {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(path).pipe(response);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  const port = options.port ?? 3000;
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;
  await validateProjectRoot(options.projectRoot);
  try {
    await access(resolve(staticRoot, "index.html"));
  } catch {
    throw new WebServerError("Web UI assets are unavailable");
  }
  const startedAt = new Date().toISOString();
  const projectName = options.projectRoot.split(sep).filter(Boolean).at(-1) ?? "event-hub";
  const statusProvider = options.statusProvider ?? readProjectStatus;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
        response.end(
          JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed", details: null } }),
        );
        return;
      }
      if (pathname !== "/api/v1/dashboard" && pathname !== "/api/v1/plugins") {
        apiNotFound(response);
        return;
      }
      if ([...url.searchParams].length > 0) {
        sendJson(response, 400, {
          error: {
            code: "INVALID_QUERY",
            message: "Invalid query",
            details: { fields: [...new Set(url.searchParams.keys())] },
          },
        });
        return;
      }
      try {
        const plugins = (await statusProvider(options.projectRoot)).map(publicPlugin);
        if (pathname === "/api/v1/plugins") {
          sendJson(response, 200, { plugins });
          return;
        }
        sendJson(response, 200, {
          project: { name: projectName, version: EVENT_HUB_VERSION, startedAt },
          summary: {
            sources: plugins.filter(({ kind }) => kind === "source").length,
            consumers: plugins.filter(({ kind }) => kind === "consumer").length,
            unhealthy: plugins.filter(
              ({ loadState, failure, diagnostics }) => loadState !== "loaded" || failure || diagnostics.length > 0,
            ).length,
            pendingWork: plugins.reduce((sum, plugin) => sum + plugin.pendingWork, 0),
          },
          plugins,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        sendJson(response, 500, {
          error: { code: "INTERNAL_ERROR", message: "An internal error occurred", details: null },
        });
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" });
      response.end("Method not allowed");
      return;
    }
    const asset = pathname === "/" ? null : await existingAsset(staticRoot, pathname);
    sendFile(response, asset ?? resolve(staticRoot, "index.html"));
  });

  try {
    await listen(server, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") throw new WebServerError(`Port ${port} is already in use`);
    throw new WebServerError("Could not start the Web UI server");
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const close = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  };
  return { url: `http://${LOOPBACK_HOST}:${boundPort}`, close };
}

export async function serveWeb(options: WebServerOptions): Promise<string> {
  const server = await startWebServer(options);
  options.onStarted?.(server.url);
  if (options.signal?.aborted) {
    await server.close();
  } else {
    await new Promise<void>((resolvePromise, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          void server.close().then(resolvePromise, reject);
        },
        { once: true },
      );
    });
  }
  return server.url;
}
