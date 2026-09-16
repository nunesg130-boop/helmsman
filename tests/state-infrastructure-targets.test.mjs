import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { StateStore } from "../server/state.mjs";

function target(id = randomUUID()) {
  const now = new Date().toISOString();
  const targetRevision = randomUUID();
  const saved = {
    id,
    type: "proxmox",
    displayName: "Example Proxmox",
    url: "https://10.20.30.40:8006",
    targetRevision,
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 60,
    tlsMode: "pinned",
    certificateFingerprint: "a".repeat(64),
    approvedHostCidrs: ["10.20.30.40/32"],
    createdAt: now,
    updatedAt: now
  };
  saved.primaryEndpointId = id;
  saved.endpoints = [{
    id,
    label: "Primary endpoint",
    url: saved.url,
    targetRevision,
    enabled: true,
    tlsMode: saved.tlsMode,
    certificateFingerprint: saved.certificateFingerprint,
    approvedHostCidrs: [...saved.approvedHostCidrs],
    createdAt: now,
    updatedAt: now
  }];
  return saved;
}

function infrastructureService(id = randomUUID()) {
  const now = new Date().toISOString();
  return {
    id,
    type: "portainer",
    displayName: "Example Portainer",
    url: "https://10.20.30.50:9443",
    targetRevision: randomUUID(),
    enabled: true,
    monitoringEnabled: true,
    tlsMode: "pinned",
    certificateFingerprint: "b".repeat(64),
    approvedHostCidrs: ["10.20.30.50/32"],
    createdAt: now,
    updatedAt: now
  };
}

test("state v1 migrates atomically without losing media connections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-state-v1-"));
  try {
    const first = new StateStore(root);
    await first.initialize();
    await first.mutate((state) => {
      state.connections.radarr = {
        url: "http://10.20.30.40:7878",
        targetRevision: randomUUID(),
        updatedAt: new Date().toISOString()
      };
    });
    const legacy = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    legacy.version = 1;
    delete legacy.infrastructureTargets;
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const migrated = new StateStore(root);
    const snapshot = await migrated.initialize();
    assert.equal(snapshot.version, 4);
    assert.deepEqual(snapshot.infrastructureTargets, {});
    assert.deepEqual(snapshot.infrastructureServices, {});
    assert.equal(snapshot.connections.radarr.url, "http://10.20.30.40:7878");

    const durable = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    assert.equal(durable.version, 4);
    assert.deepEqual(durable.infrastructureTargets, {});
    assert.deepEqual(durable.infrastructureServices, {});
    assert.equal(durable.connections.radarr.url, "http://10.20.30.40:7878");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state v2 keeps existing Proxmox targets separate while wrapping their primary endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-state-v2-infrastructure-"));
  try {
    const first = new StateStore(root);
    await first.initialize();
    const firstTarget = target();
    const secondTarget = target();
    secondTarget.displayName = "Second Proxmox";
    secondTarget.url = "https://10.20.30.41:8006";
    secondTarget.approvedHostCidrs = ["10.20.30.41/32"];
    secondTarget.endpoints[0].url = secondTarget.url;
    secondTarget.endpoints[0].approvedHostCidrs = [...secondTarget.approvedHostCidrs];
    await first.mutate((state) => {
      state.infrastructureTargets[firstTarget.id] = firstTarget;
      state.infrastructureTargets[secondTarget.id] = secondTarget;
    });

    const legacy = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    legacy.version = 2;
    for (const entry of Object.values(legacy.infrastructureTargets)) {
      delete entry.primaryEndpointId;
      delete entry.endpoints;
      delete entry.environmentIdentity;
    }
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const migratedStore = new StateStore(root);
    const migrated = await migratedStore.initialize();
    assert.equal(migrated.version, 4);
    assert.deepEqual(migrated.infrastructureServices, {});
    assert.deepEqual(Object.keys(migrated.infrastructureTargets).sort(), [firstTarget.id, secondTarget.id].sort());
    assert.equal(migrated.infrastructureTargets[firstTarget.id].environmentIdentity, null);
    assert.equal(migrated.infrastructureTargets[secondTarget.id].environmentIdentity, null);
    assert.deepEqual(
      migrated.infrastructureTargets[firstTarget.id].endpoints,
      [{
        id: firstTarget.id,
        label: "Primary endpoint",
        url: firstTarget.url,
        targetRevision: firstTarget.targetRevision,
        enabled: true,
        tlsMode: firstTarget.tlsMode,
        certificateFingerprint: firstTarget.certificateFingerprint,
        approvedHostCidrs: firstTarget.approvedHostCidrs,
        createdAt: firstTarget.createdAt,
        updatedAt: firstTarget.updatedAt
      }]
    );
    assert.equal(migrated.infrastructureTargets[secondTarget.id].endpoints[0].url, secondTarget.url);

    const durable = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    assert.equal(durable.version, 4);
    assert.deepEqual(durable.infrastructureServices, {});
    assert.equal(Object.keys(durable.infrastructureTargets).length, 2);
    assert.equal(durable.infrastructureTargets[firstTarget.id].primaryEndpointId, firstTarget.id);
    assert.equal(durable.infrastructureTargets[secondTarget.id].primaryEndpointId, secondTarget.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state v3 migration adds an independent infrastructure service collection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-state-v3-infrastructure-services-"));
  try {
    const first = new StateStore(root);
    await first.initialize();
    const legacy = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    legacy.version = 3;
    delete legacy.infrastructureServices;
    await writeFile(path.join(root, "state.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const migratedStore = new StateStore(root);
    const migrated = await migratedStore.initialize();
    assert.equal(migrated.version, 4);
    assert.deepEqual(migrated.infrastructureServices, {});
    const durable = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    assert.equal(durable.version, 4);
    assert.deepEqual(durable.infrastructureServices, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state accepts eight canonical Portainer services and rejects unsafe shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-state-infrastructure-services-"));
  try {
    const store = new StateStore(root);
    await store.initialize();
    const saved = infrastructureService();
    await store.mutate((state) => { state.infrastructureServices[saved.id] = saved; });
    assert.deepEqual(store.snapshot().infrastructureServices[saved.id], saved);

    await assert.rejects(
      store.mutate((state) => {
        const invalid = infrastructureService();
        invalid.url = "http://10.20.30.50:9000";
        state.infrastructureServices[invalid.id] = invalid;
      }),
      /Malformed broker infrastructure service state/u
    );
    await assert.rejects(
      store.mutate((state) => {
        const invalid = infrastructureService();
        invalid.certificateFingerprint = null;
        state.infrastructureServices[invalid.id] = invalid;
      }),
      /Malformed broker infrastructure service state/u
    );

    await store.mutate((state) => {
      while (Object.keys(state.infrastructureServices).length < 8) {
        const entry = infrastructureService();
        state.infrastructureServices[entry.id] = entry;
      }
    });
    await assert.rejects(
      store.mutate((state) => {
        const overflow = infrastructureService();
        state.infrastructureServices[overflow.id] = overflow;
      }),
      /Malformed broker infrastructure service state/u
    );
    assert.equal(Object.keys(store.snapshot().infrastructureServices).length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state accepts bounded canonical Proxmox targets and rejects unsafe shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-state-infrastructure-"));
  try {
    const store = new StateStore(root);
    await store.initialize();
    const saved = target();
    await store.mutate((state) => { state.infrastructureTargets[saved.id] = saved; });
    assert.deepEqual(store.snapshot().infrastructureTargets[saved.id], saved);

    await assert.rejects(
      store.mutate((state) => {
        const invalid = target();
        invalid.url = "https://10.20.30.40:8006/";
        state.infrastructureTargets[invalid.id] = invalid;
      }),
      /Malformed broker infrastructure target state/u
    );
    await assert.rejects(
      store.mutate((state) => {
        const invalid = target();
        invalid.tlsMode = "pinned";
        invalid.certificateFingerprint = null;
        state.infrastructureTargets[invalid.id] = invalid;
      }),
      /Malformed broker infrastructure target state/u
    );
    assert.equal(Object.keys(store.snapshot().infrastructureTargets).length, 1);

    await store.mutate((state) => {
      while (Object.keys(state.infrastructureTargets).length < 25) {
        const entry = target();
        state.infrastructureTargets[entry.id] = entry;
      }
    });
    await assert.rejects(
      store.mutate((state) => {
        const overflow = target();
        state.infrastructureTargets[overflow.id] = overflow;
      }),
      /Malformed broker infrastructure target state/u
    );
    assert.equal(Object.keys(store.snapshot().infrastructureTargets).length, 25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
