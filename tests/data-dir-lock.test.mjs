import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDataDirLock, DATA_DIR_LOCK_STALE_AFTER_MS } from "../server/lock.mjs";

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helmsman-lock-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a live broker's lease is never waited out", async () => {
  await withDir(async (dir) => {
    const held = await acquireDataDirLock(dir);
    try {
      const started = Date.now();
      await assert.rejects(acquireDataDirLock(dir, { waitForStaleMs: 2_500 }), /already in use/u);
      assert.ok(Date.now() - started >= 2_000, "the wait budget should be used before giving up");
    } finally {
      await held.release();
    }
  });
});

test("a lease left by a killed process is reclaimed once it goes stale", async () => {
  await withDir(async (dir) => {
    const lockPath = path.join(dir, ".broker.lock");
    await writeFile(lockPath, `${JSON.stringify({ nonce: "orphaned" })}\n`, { mode: 0o600 });
    const almostStale = new Date(Date.now() - (DATA_DIR_LOCK_STALE_AFTER_MS - 1_000));
    await utimes(lockPath, almostStale, almostStale);
    await assert.rejects(acquireDataDirLock(dir), /already in use/u, "without a wait the fresh lease still blocks");
    const lock = await acquireDataDirLock(dir, { waitForStaleMs: 5_000 });
    await lock.assertHeld();
    await lock.release();
  });
});
