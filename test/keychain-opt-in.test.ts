import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KeychainSecretBackend } from "../src/index.ts";

test(
  "performs CRUD operations against the real macOS Keychain",
  { skip: process.env.EH_KEYCHAIN_TEST !== "1" },
  async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "event-hub-keychain-opt-in-"));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    const backend = new KeychainSecretBackend({ projectRoot });
    const name = `EH_OPT_IN_${process.pid}`;
    t.after(() => backend.delete(name).catch(() => {}));

    await backend.create(name, "temporary-first-value");
    assert.equal(await backend.get(name), "temporary-first-value");
    await backend.update(name, "temporary-second-value");
    assert.equal(await backend.get(name), "temporary-second-value");
    await backend.delete(name);
  },
);
