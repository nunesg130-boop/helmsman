import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPersistentCache, PERSISTENT_CACHE_LIMITS } from "../server/persistent-cache.mjs";

const START = Date.parse("2026-09-21T12:00:00.000Z");

function snapshot(generatedAt = "2026-09-21T11:59:30.000Z") {
  return {
    version: 1,
    generatedAt,
    overall: { state: "healthy", serviceCount: 1, affectedServiceCount: 0, openIncidentCount: 0, code: null },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    infrastructure: { state: "healthy", environments: [], services: [], portainer: [], loki: [] },
    incidents: { open: [], recent: [] },
    media: { generatedAt, records: [], artwork: {} },
    workload: {},
    events: [],
    history: []
  };
}

async function temporaryDataDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "helmsman-cache-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("persists a checksummed normalized snapshot and restores it as read-only cached state", async (t) => {
  const dataDir = await temporaryDataDirectory(t);
  const cache = await createPersistentCache({ dataDir, clock: () => START });
  const live = { ...snapshot(), cache: { state: "cached", storedAt: "ignored" } };
  live.services.push({ id: "radarr", reports: [{ message: "bounded but transient service-authored text" }] });

  assert.equal(await cache.writeSnapshot(live), true);
  const restored = await cache.readSnapshot();
  assert.equal(restored.cache.state, "cached");
  assert.equal(restored.cache.storedAt, "2026-09-21T12:00:00.000Z");
  assert.equal(restored.cache.generatedAt, live.generatedAt);
  assert.equal(restored.overall.state, "healthy");
  assert.equal(restored.media.artwork && typeof restored.media.artwork, "object");
  assert.equal(restored.services[0].reports, undefined);

  const fileStatus = await stat(cache.paths.snapshotFilename);
  assert.equal(fileStatus.mode & 0o777, 0o600);
  assert.equal((await stat(cache.paths.cacheDirectory)).mode & 0o777, 0o700);
  const stored = JSON.parse(await readFile(cache.paths.snapshotFilename, "utf8"));
  assert.equal(stored.snapshot.cache, undefined);
  assert.match(stored.checksum, /^[a-f0-9]{64}$/u);
  await cache.close();
});

test("ignores expired, tampered, and symlinked snapshot files", async (t) => {
  const dataDir = await temporaryDataDirectory(t);
  let now = START;
  const cache = await createPersistentCache({
    dataDir,
    clock: () => now,
    maximumSnapshotAgeMs: 60_000
  });
  await cache.writeSnapshot(snapshot());
  now += 60_001;
  assert.equal(await cache.readSnapshot(), null);

  now = START;
  await cache.writeSnapshot(snapshot());
  const wrapper = JSON.parse(await readFile(cache.paths.snapshotFilename, "utf8"));
  wrapper.snapshot.overall.state = "down";
  await writeFile(cache.paths.snapshotFilename, JSON.stringify(wrapper), { mode: 0o600 });
  assert.equal(await cache.readSnapshot(), null);

  const outside = path.join(dataDir, "outside.json");
  await writeFile(outside, JSON.stringify(wrapper), { mode: 0o600 });
  await unlink(cache.paths.snapshotFilename);
  await symlink(outside, cache.paths.snapshotFilename);
  assert.equal(await cache.readSnapshot(), null);
  await cache.close();
});

test("persists validated artwork and prunes the least-recent entry within fixed bounds", async (t) => {
  const dataDir = await temporaryDataDirectory(t);
  let now = START;
  const cache = await createPersistentCache({
    dataDir,
    clock: () => now,
    maximumArtworkEntries: 1,
    artworkTtlMs: 60_000
  });
  const first = Buffer.from("first-image");
  const second = Buffer.from("second-image");
  assert.equal(await cache.artwork.set("first", { body: first, contentType: "image/png" }), true);
  now += 1_000;
  assert.equal(await cache.artwork.set("second", { body: second, contentType: "image/webp" }), true);
  assert.equal(await cache.artwork.get("first"), null);
  const restored = await cache.artwork.get("second");
  assert.deepEqual(restored.body, second);
  assert.equal(restored.contentType, "image/webp");
  assert.match(restored.etag, /^"[A-Za-z0-9_-]{20,100}"$/u);

  now += 60_001;
  assert.equal(await cache.artwork.get("second"), null);
  assert.equal(await cache.artwork.set("invalid", { body: Buffer.alloc(0), contentType: "image/svg+xml" }), false);
  assert.equal(PERSISTENT_CACHE_LIMITS.defaultMaximumArtworkBytes, 512 * 1024 * 1024);
  await cache.close();
});

test("does not follow an artwork-cache symlink", async (t) => {
  const dataDir = await temporaryDataDirectory(t);
  const cache = await createPersistentCache({ dataDir, clock: () => START });
  await cache.artwork.set("safe-key", { body: Buffer.from("image"), contentType: "image/jpeg" });
  // Derive the only entry name without reproducing the cache's hash logic.
  const entries = await readdir(cache.paths.artworkDirectory);
  assert.equal(entries.length, 1);
  const entryPath = path.join(cache.paths.artworkDirectory, entries[0]);
  const outside = path.join(dataDir, "outside-image");
  await writeFile(outside, "not-an-image", { mode: 0o600 });
  await unlink(entryPath);
  await symlink(outside, entryPath);
  assert.equal(await cache.artwork.get("safe-key"), null);
  await cache.close();
});
