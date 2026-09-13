import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initProject, InitConflictError } from "../src/init.ts";

test("init creates a secret-free project template rooted at the selected directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "event-hub unit "));
  const projectRoot = join(temporaryRoot, "arbitrary project");
  try {
    await initProject(projectRoot);
    const config = JSON.parse(await readFile(join(projectRoot, "event-hub.json"), "utf8"));
    assert.deepEqual(config.paths, {
      sources: "sources",
      consumers: "consumers",
      data: ".event-hub",
    });
    assert.deepEqual(config.secrets, {});
    assert.equal(config.sourceDefaults.backfill, "24h");
    await readFile(join(projectRoot, "sources", "README.md"));
    await readFile(join(projectRoot, "consumers", "README.md"));
    await readFile(join(projectRoot, ".event-hub", "README.md"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("running init again does not modify existing configuration or data", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "event-hub existing "));
  try {
    await initProject(projectRoot);
    const configPath = join(projectRoot, "event-hub.json");
    const dataPath = join(projectRoot, ".event-hub", "state.sqlite");
    await writeFile(configPath, "user-edited configuration\n");
    await writeFile(dataPath, "stored data");

    await assert.rejects(initProject(projectRoot), InitConflictError);
    assert.equal(await readFile(configPath, "utf8"), "user-edited configuration\n");
    assert.equal(await readFile(dataPath, "utf8"), "stored data");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
