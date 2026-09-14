import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface LaunchAgentOptions {
  projectRoot: string;
  executable: string;
  nodeExecutable?: string;
  home?: string;
  launchctl?: string;
  uid?: number;
  intervalSeconds?: number;
  debug?: boolean;
  runCommand?: (path: string, args: string[]) => Promise<number>;
}

export interface LaunchAgentResult {
  label: string;
  plistPath: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchAgentLabel(projectRoot: string): string {
  const id = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
  return `com.event-hub.${id}`;
}

export function launchAgentPlist(
  projectRoot: string,
  executable: string,
  intervalSeconds = 60,
  nodeExecutable = process.execPath,
  debug = false,
): string {
  projectRoot = resolve(projectRoot);
  executable = resolve(executable);
  nodeExecutable = resolve(nodeExecutable);
  const label = launchAgentLabel(projectRoot);
  const data = resolve(projectRoot, ".event-hub");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodeExecutable)}</string><string>${xml(executable)}</string>
    <string>tick</string><string>--root</string><string>${xml(projectRoot)}</string>${debug ? "<string>--debug</string>" : ""}
  </array>
  <key>WorkingDirectory</key><string>${xml(projectRoot)}</string>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(resolve(data, "launch-agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(data, "launch-agent.error.log"))}</string>
</dict></plist>
`;
}

function defaultRun(path: string, args: string[]): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(path, args, { env: {}, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolveCode(code ?? 1));
  });
}

function settings(
  options: LaunchAgentOptions,
): Required<
  Pick<
    LaunchAgentOptions,
    "projectRoot" | "executable" | "nodeExecutable" | "home" | "launchctl" | "uid" | "intervalSeconds" | "runCommand"
  >
> {
  return {
    projectRoot: resolve(options.projectRoot),
    executable: resolve(options.executable),
    nodeExecutable: resolve(options.nodeExecutable ?? process.execPath),
    home: resolve(options.home ?? homedir()),
    launchctl: options.launchctl ?? "/bin/launchctl",
    uid: options.uid ?? process.getuid?.() ?? 0,
    intervalSeconds: options.intervalSeconds ?? 60,
    runCommand: options.runCommand ?? defaultRun,
  };
}

export async function registerLaunchAgent(options: LaunchAgentOptions): Promise<LaunchAgentResult> {
  const value = settings(options);
  const label = launchAgentLabel(value.projectRoot);
  const plistPath = resolve(value.home, "Library", "LaunchAgents", `${label}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(resolve(value.projectRoot, ".event-hub"), { recursive: true });
  const temporaryPath = `${plistPath}.tmp`;
  await writeFile(
    temporaryPath,
    launchAgentPlist(value.projectRoot, value.executable, value.intervalSeconds, value.nodeExecutable, options.debug),
    { mode: 0o600 },
  );
  await rename(temporaryPath, plistPath);
  const service = `gui/${value.uid}/${label}`;
  await value.runCommand(value.launchctl, ["bootout", service]);
  const code = await value.runCommand(value.launchctl, ["bootstrap", `gui/${value.uid}`, plistPath]);
  if (code !== 0) throw new Error(`launchctl bootstrap failed with exit code ${code}`);
  return { label, plistPath };
}

export async function unregisterLaunchAgent(options: LaunchAgentOptions): Promise<LaunchAgentResult> {
  const value = settings(options);
  const label = launchAgentLabel(value.projectRoot);
  const plistPath = resolve(value.home, "Library", "LaunchAgents", `${label}.plist`);
  const code = await value.runCommand(value.launchctl, ["bootout", `gui/${value.uid}/${label}`]);
  if (code !== 0 && code !== 113) {
    throw new Error(`launchctl bootout failed with exit code ${code}`);
  }
  try {
    await unlink(plistPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { label, plistPath };
}
