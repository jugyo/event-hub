import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { launchAgentLabel, registerLaunchAgent, unregisterLaunchAgent } from "../src/launch-agent.ts";

test("generates a secret-free plist for an absolute path with spaces and only replaces the target service", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "event-hub launch agent "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = join(temporary, "project with spaces");
  const executable = join(temporary, "installed app", "event-hub");
  const nodeExecutable = join(temporary, "runtime with spaces", "node");
  const home = join(temporary, "fake home");
  const calls: string[][] = [];
  const runCommand = async (path: string, args: string[]) => { calls.push([path, ...args]); return args[0] === "bootout" ? 113 : 0; };

  const first = await registerLaunchAgent({ projectRoot, executable, nodeExecutable, home, launchctl: "/fake/launchctl", uid: 501, runCommand });
  const second = await registerLaunchAgent({ projectRoot, executable, nodeExecutable, home, launchctl: "/fake/launchctl", uid: 501, runCommand });
  assert.deepEqual(second, first);
  const plist = await readFile(first.plistPath, "utf8");
  assert.match(plist, new RegExp(executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(plist, new RegExp(nodeExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(plist.indexOf(nodeExecutable) < plist.indexOf(executable));
  assert.match(plist, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(plist, /EnvironmentVariables|TOKEN|SECRET/);
  const label = launchAgentLabel(projectRoot);
  assert.deepEqual(calls, [
    ["/fake/launchctl", "bootout", `gui/501/${label}`],
    ["/fake/launchctl", "bootstrap", "gui/501", first.plistPath],
    ["/fake/launchctl", "bootout", `gui/501/${label}`],
    ["/fake/launchctl", "bootstrap", "gui/501", first.plistPath],
  ]);

  await unregisterLaunchAgent({ projectRoot, executable, nodeExecutable, home, launchctl: "/fake/launchctl", uid: 501,
    runCommand: async (path, args) => { calls.push([path, ...args]); return 0; } });
  await assert.rejects(readFile(first.plistPath), { code: "ENOENT" });
  assert.deepEqual(calls.at(-1), ["/fake/launchctl", "bootout", `gui/501/${label}`]);
});

test("uses different labels for different project roots", () => {
  assert.notEqual(launchAgentLabel("/tmp/project-a"), launchAgentLabel("/tmp/project-b"));
});

test("adds --debug to tick ProgramArguments when registering in debug mode", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "event-hub debug launch agent "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const result = await registerLaunchAgent({
    projectRoot: join(temporary, "project"), executable: join(temporary, "event-hub"),
    home: join(temporary, "home"), debug: true, runCommand: async () => 0,
  });
  assert.match(await readFile(result.plistPath, "utf8"), /<string>--debug<\/string>/);
});

test("retains the plist and reports an error when unregistering fails", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "event-hub failed bootout "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const options = {
    projectRoot: join(temporary, "project"), executable: join(temporary, "event-hub"),
    home: join(temporary, "home"), uid: 501, runCommand: async () => 0,
  };
  const registered = await registerLaunchAgent(options);

  await assert.rejects(
    unregisterLaunchAgent({ ...options, runCommand: async () => 5 }),
    /launchctl bootout failed with exit code 5/,
  );
  assert.match(await readFile(registered.plistPath, "utf8"), /<key>Label<\/key>/);
});

test("removes the plist after bootstrap fails when bootout reports an unregistered service", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "event-hub failed bootstrap "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const options = {
    projectRoot: join(temporary, "project"), executable: join(temporary, "event-hub"),
    home: join(temporary, "home"), uid: 501,
  };
  await assert.rejects(
    registerLaunchAgent({ ...options, runCommand: async (_path, args) => args[0] === "bootstrap" ? 5 : 113 }),
    /launchctl bootstrap failed with exit code 5/,
  );
  const plistPath = join(options.home, "Library", "LaunchAgents", `${launchAgentLabel(options.projectRoot)}.plist`);
  await readFile(plistPath);

  await unregisterLaunchAgent({ ...options, runCommand: async () => 113 });
  await assert.rejects(readFile(plistPath), { code: "ENOENT" });
});
