import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StateStore } from "../server/state.mjs";

const TARGET_REVISION = "12345678-1234-4234-8234-123456789abc";

function connection(overrides = {}) {
  return {
    url: "http://media.test:7878",
    targetRevision: TARGET_REVISION,
    updatedAt: "2026-09-13T00:00:00.000Z",
    authMode: "apiKey",
    monitoringEnabled: true,
    ...overrides
  };
}

test("state accepts legacy connections and bounded exact-host approvals", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-approved-hosts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const store = new StateStore(dataDir);
  await store.initialize();
  await store.mutate((state) => {
    // Missing approvedHostCidrs is the frozen v0.5/v0.6 connection shape.
    state.connections.radarr = connection();
  });

  const legacyReopen = new StateStore(dataDir);
  const legacy = await legacyReopen.initialize();
  assert.equal(Object.hasOwn(legacy.connections.radarr, "approvedHostCidrs"), false);

  await legacyReopen.mutate((state) => {
    state.connections.radarr.approvedHostCidrs = [
      "10.20.30.40/32",
      "fd12:3456:789a::40/128"
    ];
  });
  const approvedReopen = new StateStore(dataDir);
  const approved = await approvedReopen.initialize();
  assert.deepEqual(approved.connections.radarr.approvedHostCidrs, [
    "10.20.30.40/32",
    "fd12:3456:789a::40/128"
  ]);

  for (const approvedHostCidrs of [
    ["10.20.30.0/24"],
    ["fd12:3456:789a::/64"],
    Array.from({ length: 33 }, (_, index) => `10.0.0.${index + 1}/32`)
  ]) {
    await assert.rejects(
      approvedReopen.mutate((state) => {
        state.connections.radarr.approvedHostCidrs = approvedHostCidrs;
      }),
      /Malformed broker connection state/u
    );
  }
});
