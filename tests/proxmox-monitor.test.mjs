import assert from "node:assert/strict";
import test from "node:test";

import { createHealthIncidentEngine } from "../server/health-engine.mjs";
import { createOperationsMonitor } from "../server/monitor.mjs";

const TARGET_ID = "12345678-1234-4234-8234-123456789abc";
const TARGET_REVISION = "87654321-4321-4321-8321-cba987654321";
const START = Date.parse("2026-09-13T12:00:00.000Z");

function result(checkedAt) {
  return {
    schema: 1,
    type: "proxmox",
    state: "healthy",
    connectionState: "connected",
    checkedAt,
    latencyMs: 12,
    version: "9.1.7",
    checks: [{
      id: "nodes",
      label: "Node availability",
      ok: true,
      state: "healthy",
      importance: "critical",
      metrics: { nodeTotal: 2, nodeOnline: 2, nodeOffline: 0 },
      reports: [{ severity: "notice", source: "Cluster", message: "Both nodes are online." }]
    }],
    metrics: { nodeTotal: 2, nodeOnline: 2, nodeOffline: 0 }
  };
}

test("publishes Proxmox targets in a separate bounded infrastructure snapshot", async () => {
  let now = START;
  let calls = 0;
  let revision = TARGET_REVISION;
  const target = {
    id: TARGET_ID,
    type: "proxmox",
    displayName: "Example Proxmox",
    url: "https://10.44.0.11:8006",
    targetRevision: TARGET_REVISION,
    tlsMode: "pinned",
    certificateFingerprint: "a".repeat(64),
    approvedHostCidrs: ["10.44.0.11/32"],
    tokenSecret: "raw-target-secret-must-not-survive",
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 60
  };
  const monitor = createOperationsMonitor({
    now: () => now,
    loadServices: () => [],
    probe: () => { throw new Error("media probe should not run"); },
    loadInfrastructureTargets: () => [{ ...target, targetRevision: revision }],
    probeInfrastructure: (_target, context) => {
      calls += 1;
      return {
        ...result(context.checkedAt),
        body: "raw-probe-secret-must-not-survive",
        authorization: "PVEAPIToken=also-secret"
      };
    }
  });

  let snapshot = await monitor.refresh();
  assert.equal(calls, 1);
  assert.equal(snapshot.overall.state, "stale", "media summary must remain independent of infrastructure health");
  assert.deepEqual(snapshot.services, []);
  assert.equal(snapshot.infrastructure.state, "healthy");
  assert.equal(snapshot.infrastructure.targetCount, 1);
  assert.equal(snapshot.infrastructure.affectedTargetCount, 0);
  assert.deepEqual(snapshot.infrastructure.targets[0], {
    id: TARGET_ID,
    targetRevision: TARGET_REVISION,
    type: "proxmox",
    displayName: "Example Proxmox",
    state: "healthy",
    connectionState: "connected",
    latencyMs: 12,
    checkedAt: "2026-09-13T12:00:00.000Z",
    version: "9.1.7",
    capabilities: [{
      id: "nodes",
      state: "healthy",
      ok: true,
      impact: "critical",
      code: null,
      httpStatus: null,
      latencyMs: 0,
      checkedAt: "2026-09-13T12:00:00.000Z",
      metrics: { nodeOnline: 2, nodeOffline: 0, nodeTotal: 2 },
      reports: [{ severity: "notice", source: "Cluster", message: "Both nodes are online." }],
      label: "Node availability"
    }],
    metrics: { nodeOnline: 2, nodeOffline: 0, nodeTotal: 2 },
    discovery: {
      kind: "unknown",
      name: "Proxmox environment",
      clusterName: null,
      quorate: null,
      nodeNames: [],
      localNode: null
    },
    selectedEndpointId: null,
    endpoints: [],
    nodes: [],
    workloads: [],
    storage: [],
    activity: [],
    reports: [{
      capability: "nodes",
      severity: "notice",
      source: "Cluster",
      message: "Both nodes are online."
    }]
  });
  const serialized = JSON.stringify(snapshot.infrastructure);
  assert.equal(serialized.includes("10.44.0.11"), false);
  assert.equal(serialized.includes("certificateFingerprint"), false);
  assert.equal(serialized.includes("approvedHostCidrs"), false);
  assert.equal(serialized.includes("raw-target-secret"), false);
  assert.equal(serialized.includes("raw-probe-secret"), false);
  assert.equal(serialized.includes("also-secret"), false);

  now += 10_000;
  snapshot = await monitor.refresh();
  assert.equal(calls, 2, "an explicit refresh must bypass the per-target cache");
  assert.equal(snapshot.infrastructure.targets[0].checkedAt, "2026-09-13T12:00:10.000Z");

  now += 20_000;
  snapshot = await monitor.refresh({ bypassInfrastructureCache: false });
  assert.equal(calls, 2, "a scheduled-style cycle should reuse its sanitized snapshot until due");
  assert.equal(snapshot.infrastructure.targets[0].checkedAt, "2026-09-13T12:00:10.000Z");

  revision = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  snapshot = await monitor.refresh({ bypassInfrastructureCache: false });
  assert.equal(calls, 3);
  assert.equal(snapshot.infrastructure.targets[0].checkedAt, "2026-09-13T12:00:30.000Z");

  now += 61_000;
  snapshot = await monitor.refresh({ bypassInfrastructureCache: false });
  assert.equal(calls, 4);
  assert.equal(snapshot.infrastructure.targets[0].checkedAt, "2026-09-13T12:01:31.000Z");
});

test("retains bounded partial-history capability codes and actionable reports", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [],
    probe: () => null,
    loadInfrastructureTargets: () => [{
      id: TARGET_ID,
      type: "proxmox",
      displayName: "Partial history host",
      targetRevision: TARGET_REVISION,
      enabled: true,
      monitoringEnabled: true,
      monitoringIntervalSeconds: 60
    }],
    probeInfrastructure: (_target, context) => ({
      ...result(context.checkedAt),
      state: "limited",
      checks: [{
        id: "tasks",
        label: "Recent failed tasks",
        ok: false,
        state: "limited",
        importance: "important",
        code: "TASK_HISTORY_PARTIAL",
        httpStatus: null,
        metrics: { taskRecordsObserved: 1 },
        reports: [{
          severity: "warning",
          source: "Recent failed tasks",
          message: "Recent task history is incomplete: 1 of 2 discovered nodes could not be queried."
        }]
      }]
    })
  });

  const snapshot = await monitor.refresh();
  const capability = snapshot.infrastructure.targets[0].capabilities[0];
  assert.equal(capability.code, "TASK_HISTORY_PARTIAL");
  assert.equal(capability.state, "limited");
  assert.match(capability.reports[0].message, /1 of 2 discovered nodes/u);
});

test("a long target interval does not create a false stale incident while its cache is valid", async () => {
  let now = START;
  let calls = 0;
  const incidentEngine = createHealthIncidentEngine({ now: () => now, failureThreshold: 1 });
  const monitor = createOperationsMonitor({
    now: () => now,
    incidentEngine,
    loadServices: () => [],
    probe: () => null,
    loadInfrastructureTargets: () => [{
      id: TARGET_ID,
      type: "proxmox",
      displayName: "Slow cadence host",
      url: "https://proxmox.invalid:8006",
      targetRevision: TARGET_REVISION,
      enabled: true,
      monitoringEnabled: true,
      monitoringIntervalSeconds: 3_600
    }],
    probeInfrastructure: (_target, context) => {
      calls += 1;
      return result(context.checkedAt);
    }
  });

  await monitor.refresh();
  now += 6 * 60_000;
  const snapshot = await monitor.refresh({ bypassInfrastructureCache: false });
  assert.equal(calls, 1);
  assert.equal(snapshot.infrastructure.state, "healthy");
  assert.equal(snapshot.incidents.open.length, 0);
});

test("isolates infrastructure loader failure from a healthy media pipeline", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "jellyfin" }],
    probe: () => ({
      state: "healthy",
      connectionState: "connected",
      checks: [{ id: "status", ok: true, state: "healthy", importance: "core", stages: ["library"] }]
    }),
    loadInfrastructureTargets: () => {
      throw Object.assign(new Error("do not expose this raw loader error"), { code: "INFRASTRUCTURE_LOAD_FAILED" });
    },
    probeInfrastructure: () => { throw new Error("infrastructure probe should not run"); }
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services[0].state, "healthy");
  assert.deepEqual(snapshot.infrastructure, {
    state: "down",
    environmentCount: 0,
    targetCount: 0,
    affectedTargetCount: 0,
    serviceCount: 0,
    affectedServiceCount: 0,
    code: "INFRASTRUCTURE_LOAD_FAILED",
    environments: [],
    targets: [],
    services: [],
    portainer: []
  });
  assert.equal(snapshot.overall.state, "healthy", "infrastructure loader failure must not degrade Media");
  assert.equal(JSON.stringify(snapshot).includes("raw loader error"), false);
});

test("continues infrastructure monitoring when the media service loader fails", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => {
      throw Object.assign(new Error("raw media loader detail must not survive"), {
        code: "SERVICE_LOAD_FAILED"
      });
    },
    probe: () => { throw new Error("media probe should not run"); },
    loadInfrastructureTargets: () => [{
      id: TARGET_ID,
      type: "proxmox",
      displayName: "Independent host",
      url: "https://proxmox.invalid:8006",
      targetRevision: TARGET_REVISION,
      enabled: true,
      monitoringEnabled: true,
      monitoringIntervalSeconds: 30
    }],
    probeInfrastructure: (_target, context) => result(context.checkedAt)
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "down");
  assert.equal(snapshot.overall.code, "SERVICE_LOAD_FAILED");
  assert.equal(snapshot.infrastructure.state, "healthy");
  assert.equal(snapshot.infrastructure.targets[0].displayName, "Independent host");
  assert.equal(JSON.stringify(snapshot).includes("raw media loader detail"), false);
});

test("one failed Proxmox target does not hide another target or degrade Media", async () => {
  const secondId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const base = {
    type: "proxmox",
    url: "https://proxmox.invalid:8006",
    targetRevision: TARGET_REVISION,
    tlsMode: "system",
    certificateFingerprint: null,
    approvedHostCidrs: [],
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 30
  };
  const incidentEngine = {
    recordResult() {},
    retireService() {},
    snapshot() {
      return {
        incidents: [{
          service: `proxmox-${TARGET_ID}`,
          capability: "identity",
          state: "down",
          impact: "critical",
          code: "TLS_PIN_MISMATCH",
          firstSeen: "2026-09-13T12:00:00.000Z",
          lastSeen: "2026-09-13T12:00:00.000Z",
          occurrenceCount: 2
        }],
        recentRecoveries: [],
        recentTransitions: []
      };
    }
  };
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [{ id: "jellyfin" }],
    probe: () => ({
      state: "healthy",
      connectionState: "connected",
      checks: [{ id: "status", ok: true, state: "healthy", importance: "core", stages: ["library"] }]
    }),
    loadInfrastructureTargets: () => [
      { ...base, id: TARGET_ID, displayName: "Broken host" },
      { ...base, id: secondId, displayName: "Working host" }
    ],
    probeInfrastructure: (target, context) => {
      if (target.id === TARGET_ID) {
        throw Object.assign(new Error("credential=PVE-secret-must-not-survive"), { code: "TLS_PIN_MISMATCH" });
      }
      return result(context.checkedAt);
    }
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "healthy");
  assert.equal(snapshot.overall.openIncidentCount, 0);
  assert.equal(snapshot.history.at(-1).openIncidentCount, 0);
  assert.equal(snapshot.incidents.open.length, 1, "infrastructure incidents remain globally available");
  assert.equal(snapshot.infrastructure.state, "down");
  assert.equal(snapshot.infrastructure.targetCount, 2);
  assert.equal(snapshot.infrastructure.affectedTargetCount, 1);
  assert.equal(snapshot.infrastructure.targets.find(({ id }) => id === TARGET_ID).state, "down");
  assert.equal(snapshot.infrastructure.targets.find(({ id }) => id === secondId).state, "healthy");
  assert.equal(JSON.stringify(snapshot).includes("PVE-secret-must-not-survive"), false);
});

test("removed infrastructure targets retire incidents and invalidate cached results", async () => {
  let targets = [{
    id: TARGET_ID,
    type: "proxmox",
    displayName: "Temporary host",
    url: "https://proxmox.invalid:8006",
    targetRevision: TARGET_REVISION,
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 3_600
  }];
  let calls = 0;
  const retired = [];
  const incidentEngine = {
    recordResult() {},
    retireService(service) { retired.push(service); },
    snapshot() { return { incidents: [], recentRecoveries: [], recentTransitions: [] }; }
  };
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [],
    probe: () => null,
    loadInfrastructureTargets: () => targets,
    probeInfrastructure: (_target, context) => {
      calls += 1;
      return result(context.checkedAt);
    }
  });
  await monitor.refresh();
  assert.equal(calls, 1);
  targets = [];
  let snapshot = await monitor.refresh();
  assert.deepEqual(retired, [`proxmox-${TARGET_ID}`]);
  assert.equal(snapshot.infrastructure.targetCount, 0);

  targets = [{
    id: TARGET_ID,
    type: "proxmox",
    displayName: "Temporary host",
    url: "https://proxmox.invalid:8006",
    targetRevision: TARGET_REVISION,
    enabled: true,
    monitoringEnabled: true,
    monitoringIntervalSeconds: 3_600
  }];
  snapshot = await monitor.refresh();
  assert.equal(calls, 2, "a re-added target must not reuse the retired cached result");
  assert.equal(snapshot.infrastructure.targetCount, 1);
});
