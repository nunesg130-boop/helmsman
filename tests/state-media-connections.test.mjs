import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { StateStore } from "../server/state.mjs";
import { diskConnection, diskConnectionId, withLegacyConnections } from "./helpers/state-file.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function connection(port) {
  return {
    url: `http://10.20.30.40:${port}`,
    targetRevision: randomUUID(),
    updatedAt: "2026-01-02T03:04:05.000Z",
    authMode: "apiKey",
    monitoringEnabled: true,
    approvedHostCidrs: ["10.20.30.40/32"]
  };
}

async function readDisk(root) {
  return JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
}

async function writeDisk(root, value) {
  await writeFile(path.join(root, "state.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function withRoot(name, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), `helmsman-${name}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("state v5 migrates media connections to id-keyed storage without changing any record", async () => {
  await withRoot("state-v5-media", async (root) => {
    const first = new StateStore(root);
    await first.initialize();
    const radarr = connection(7878);
    const sonarr = connection(8989);
    await first.mutate((state) => {
      state.connections.radarr = radarr;
      state.connections.sonarr = sonarr;
    });
    const legacy = withLegacyConnections(await readDisk(root));
    legacy.version = 5;
    await writeDisk(root, legacy);

    const migratedStore = new StateStore(root);
    const migrated = await migratedStore.initialize();
    assert.equal(migrated.version, 6);
    assert.deepEqual(migrated.connections, { radarr, sonarr }, "the in-memory view is unchanged");

    const durable = await readDisk(root);
    assert.equal(durable.version, 6);
    assert.equal(Object.hasOwn(durable, "connections"), false);
    assert.equal(Object.keys(durable.mediaConnections).length, 2);
    for (const id of Object.keys(durable.mediaConnections)) assert.match(id, UUID);
    assert.deepEqual(diskConnection(durable, "radarr"), { type: "radarr", ...radarr });
    assert.deepEqual(diskConnection(durable, "sonarr"), { type: "sonarr", ...sonarr });

    const ids = migratedStore.connectionIds();
    assert.equal(ids.radarr, diskConnectionId(durable, "radarr"));
    assert.equal(ids.sonarr, diskConnectionId(durable, "sonarr"));
    assert.notEqual(ids.radarr, ids.sonarr);
  });
});

test("media connection ids stay stable across edits and restarts", async () => {
  await withRoot("state-media-stable", async (root) => {
    const store = new StateStore(root);
    await store.initialize();
    await store.mutate((state) => { state.connections.radarr = connection(7878); });
    const id = store.connectionIds().radarr;
    assert.match(id, UUID);

    await store.mutate((state) => { state.connections.radarr.url = "http://10.20.30.41:7878"; });
    await store.mutate((state) => { state.connections.radarr = { ...state.connections.radarr, monitoringEnabled: false }; });
    assert.equal(store.connectionIds().radarr, id);

    const reopened = new StateStore(root);
    const snapshot = await reopened.initialize();
    assert.equal(reopened.connectionIds().radarr, id);
    assert.equal(snapshot.connections.radarr.url, "http://10.20.30.41:7878");
    assert.equal(snapshot.connections.radarr.monitoringEnabled, false);
    assert.equal(diskConnectionId(await readDisk(root), "radarr"), id);
  });
});

test("a removed and re-added media connection gets a new id", async () => {
  await withRoot("state-media-readd", async (root) => {
    const store = new StateStore(root);
    await store.initialize();
    await store.mutate((state) => {
      state.connections.radarr = connection(7878);
      state.connections.sonarr = connection(8989);
    });
    const before = store.connectionIds();
    await store.mutate((state) => { delete state.connections.radarr; });
    assert.deepEqual(Object.keys(store.connectionIds()), ["sonarr"]);
    assert.equal(store.connectionIds().sonarr, before.sonarr);
    assert.deepEqual(Object.values((await readDisk(root)).mediaConnections).map(({ type }) => type), ["sonarr"]);

    await store.mutate((state) => { state.connections.radarr = connection(7878); });
    assert.match(store.connectionIds().radarr, UUID);
    assert.notEqual(store.connectionIds().radarr, before.radarr);
  });
});

test("a failed mutation keeps the previous ids", async () => {
  await withRoot("state-media-failed", async (root) => {
    const store = new StateStore(root);
    await store.initialize();
    await store.mutate((state) => { state.connections.radarr = connection(7878); });
    const before = store.connectionIds();
    await assert.rejects(store.mutate((state) => {
      state.connections.sonarr = connection(8989);
      state.connections.radarr.targetRevision = "not-a-uuid";
    }));
    assert.deepEqual(store.connectionIds(), before);
    assert.deepEqual(Object.keys((await readDisk(root)).mediaConnections), [before.radarr]);
  });
});

test("a version 6 file with two connections of one service fails with a clear message", async () => {
  await withRoot("state-media-duplicate", async (root) => {
    const store = new StateStore(root);
    await store.initialize();
    await store.mutate((state) => { state.connections.radarr = connection(7878); });
    const disk = await readDisk(root);
    disk.mediaConnections[randomUUID()] = { type: "radarr", ...connection(7879) };
    await writeDisk(root, disk);
    await assert.rejects(new StateStore(root).initialize(), /more than one radarr connection/u);
  });
});

test("version 6 files reject malformed media connection layouts", async () => {
  await withRoot("state-media-malformed", async (root) => {
    const store = new StateStore(root);
    await store.initialize();
    await store.mutate((state) => { state.connections.radarr = connection(7878); });
    const valid = await readDisk(root);
    const id = diskConnectionId(valid, "radarr");

    const cases = [
      (disk) => { disk.connections = {}; },
      (disk) => { delete disk.mediaConnections; },
      (disk) => { disk.mediaConnections["not-a-uuid"] = disk.mediaConnections[id]; delete disk.mediaConnections[id]; },
      (disk) => { disk.mediaConnections[id].type = "plex"; },
      (disk) => { delete disk.mediaConnections[id].type; },
      (disk) => { disk.mediaConnections[id].targetRevision = "not-a-uuid"; },
      (disk) => {
        for (let index = 0; index < 17; index += 1) disk.mediaConnections[randomUUID()] = { type: "radarr", ...connection(7000 + index) };
      }
    ];
    for (const [index, change] of cases.entries()) {
      const disk = structuredClone(valid);
      change(disk);
      await writeDisk(root, disk);
      await assert.rejects(new StateStore(root).initialize(), /broker|connection/u, `case ${index}`);
    }
  });
});
