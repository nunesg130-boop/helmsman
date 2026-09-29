import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACKNOWLEDGEMENT_LIMITS,
  createAcknowledgementStore,
  isReportId,
  reportFingerprint
} from "../server/acknowledgements.mjs";
import { createOperationsMonitor } from "../server/monitor.mjs";

const START = Date.parse("2026-09-29T16:00:00.000Z");
const HOUR = 60 * 60 * 1_000;

async function withDataDir(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "helmsman-ack-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const rootFolder = {
  severity: "warning",
  source: "DownloadClientRootFolderCheck",
  message: "Download client qBittorrent places downloads in the root folder /data/media."
};

test("report fingerprints are stable, opaque, and specific to connection, check, and text", () => {
  const id = reportFingerprint("radarr", "health", rootFolder);
  assert.ok(isReportId(id));
  assert.equal(reportFingerprint("radarr", "health", { ...rootFolder }), id);
  assert.notEqual(reportFingerprint("sonarr", "health", rootFolder), id);
  assert.notEqual(reportFingerprint("radarr", "queue", rootFolder), id);
  assert.notEqual(reportFingerprint("radarr", "health", { ...rootFolder, message: `${rootFolder.message} ` }), id);
  assert.equal(isReportId("../../etc/passwd"), false);
  assert.equal(isReportId(id.toUpperCase()), false);
});

test("the store persists acknowledgements privately and survives a restart", async () => {
  await withDataDir(async (dataDir) => {
    let clock = START;
    const store = await createAcknowledgementStore({ dataDir, clock: () => clock });
    const id = reportFingerprint("radarr", "health", rootFolder);
    await store.add({ id, monitor: "radarr", capability: "health", label: "Radarr", ...rootFolder });
    assert.equal(store.has(id), true);

    const file = path.join(dataDir, "acknowledgements.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const reopened = await createAcknowledgementStore({ dataDir, clock: () => clock });
    assert.equal(reopened.has(id), true);
    assert.equal(reopened.list()[0].message, rootFolder.message);

    assert.equal(await reopened.remove(id), true);
    assert.equal(await reopened.remove(id), false);
    assert.equal((await createAcknowledgementStore({ dataDir })).has(id), false);
  });
});

test("the store rejects malformed entries and tolerates a corrupt file", async () => {
  await withDataDir(async (dataDir) => {
    await writeFile(path.join(dataDir, "acknowledgements.json"), "{ not json");
    const store = await createAcknowledgementStore({ dataDir });
    assert.deepEqual(store.list(), []);
    await assert.rejects(store.add({ id: "nope", monitor: "radarr", capability: "health", ...rootFolder }));
    await assert.rejects(store.add({
      id: reportFingerprint("radarr", "health", rootFolder),
      monitor: "radarr",
      capability: "health",
      ...rootFolder,
      message: "line one\nline two"
    }));
    assert.deepEqual(store.list(), []);
  });
});

test("acknowledgements retire only after their report has been absent for the retention window", async () => {
  await withDataDir(async (dataDir) => {
    let clock = START;
    const store = await createAcknowledgementStore({ dataDir, clock: () => clock });
    const id = reportFingerprint("radarr", "health", rootFolder);
    await store.add({ id, monitor: "radarr", capability: "health", ...rootFolder });

    // Still reported two days later: kept, because each cycle refreshes it.
    for (let hour = 1; hour <= 48; hour += 1) {
      clock = START + hour * HOUR;
      await store.observe([id]);
    }
    assert.equal(store.has(id), true);

    // Gone for just under the window: kept. Past it: retired.
    const lastSeen = clock;
    clock = lastSeen + ACKNOWLEDGEMENT_LIMITS.retentionMs - HOUR;
    await store.observe([]);
    assert.equal(store.has(id), true);
    clock = lastSeen + ACKNOWLEDGEMENT_LIMITS.retentionMs + HOUR;
    await store.observe([]);
    assert.equal(store.has(id), false);
    const persisted = JSON.parse(await readFile(path.join(dataDir, "acknowledgements.json"), "utf8"));
    assert.deepEqual(persisted.entries, []);
  });
});

function arrProbe(health) {
  return () => ({
    connectionState: "connected",
    checks: [
      { id: "api", state: "healthy", ok: true, importance: "critical" },
      {
        id: "health",
        state: health.some(({ severity }) => severity !== "notice") ? "limited" : "healthy",
        importance: "important",
        code: health.length ? "HEALTH_WARNING" : null,
        reports: health
      }
    ]
  });
}

test("an acknowledged warning stops lowering health, and a new warning still counts", async () => {
  await withDataDir(async (dataDir) => {
    const store = await createAcknowledgementStore({ dataDir, clock: () => START });
    let health = [rootFolder];
    const observed = [];
    const monitor = createOperationsMonitor({
      now: () => START,
      acknowledgements: store,
      incidentEngine: {
        recordResult(result) { observed.push(structuredClone(result)); },
        snapshot() { return { incidents: [], recentRecoveries: [], recentTransitions: [] }; }
      },
      loadServices: () => [{ id: "radarr" }],
      probe: () => arrProbe(health)()
    });

    let snapshot = await monitor.refresh();
    let radarr = snapshot.services[0];
    assert.equal(radarr.state, "limited");
    const report = radarr.checks.find(({ id }) => id === "health").reports[0];
    assert.equal(report.id, reportFingerprint("radarr", "health", rootFolder));

    await store.add({ id: report.id, monitor: "radarr", capability: "health", ...rootFolder });
    observed.length = 0;
    snapshot = await monitor.refreshAfterChange();
    radarr = snapshot.services[0];
    const check = radarr.checks.find(({ id }) => id === "health");
    assert.equal(radarr.state, "healthy", "the service recovers when its only warning is ignored");
    assert.equal(check.state, "healthy");
    assert.equal(check.acknowledged, true);
    assert.equal(Object.hasOwn(check, "reports"), false);
    assert.deepEqual(check.acknowledgedReports.map(({ id }) => id), [report.id]);
    assert.equal(snapshot.overall.affectedServiceCount, 0);
    assert.ok(observed.some((entry) => entry.capability === "health" && entry.ok === true),
      "the incident engine sees the check as recovered so incidents close");

    const indexer = { severity: "warning", source: "IndexerStatusCheck", message: "Indexers unavailable due to failures." };
    health = [rootFolder, indexer];
    snapshot = await monitor.refresh();
    radarr = snapshot.services[0];
    assert.equal(radarr.state, "limited", "an unrelated new warning still lowers health");
    assert.deepEqual(radarr.checks.find(({ id }) => id === "health").reports.map(({ message }) => message), [indexer.message]);
  });
});

test("acknowledgements never hide a connection failure or a check without reports", async () => {
  await withDataDir(async (dataDir) => {
    const store = await createAcknowledgementStore({ dataDir, clock: () => START });
    const id = reportFingerprint("radarr", "health", rootFolder);
    await store.add({ id, monitor: "radarr", capability: "health", ...rootFolder });
    const monitor = createOperationsMonitor({
      now: () => START,
      acknowledgements: store,
      loadServices: () => [{ id: "radarr" }],
      probe: () => ({
        state: "down",
        connectionState: "down",
        checks: [
          { id: "api", state: "down", importance: "critical", code: "UPSTREAM_UNREACHABLE" },
          { id: "health", state: "limited", importance: "important", code: "HEALTH_WARNING", reports: [rootFolder] }
        ]
      })
    });
    const snapshot = await monitor.refresh();
    assert.equal(snapshot.services[0].state, "down");
    assert.equal(snapshot.services[0].checks.find(({ id: checkId }) => checkId === "api").state, "down");
  });
});

test("Proxmox environments honour acknowledgements for their capability reports", async () => {
  await withDataDir(async (dataDir) => {
    const store = await createAcknowledgementStore({ dataDir, clock: () => START });
    const targetId = "33333333-3333-4333-8333-333333333333";
    const task = { severity: "warning", source: "Task vzdump", message: "pve: Proxmox reported this task as failed." };
    const monitor = createOperationsMonitor({
      now: () => START,
      acknowledgements: store,
      loadServices: () => [],
      probe: () => ({}),
      loadInfrastructureTargets: () => [{
        id: targetId,
        type: "proxmox",
        displayName: "Main",
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 300,
        targetRevision: "44444444-4444-4444-8444-444444444444"
      }],
      probeInfrastructure: () => ({
        state: "limited",
        connectionState: "connected",
        checks: [
          { id: "nodes", label: "Node availability", state: "healthy", ok: true, importance: "critical" },
          { id: "tasks", label: "Recent failed tasks", state: "limited", importance: "important", code: "RECENT_TASK_FAILURES", reports: [task] }
        ]
      })
    });
    let environment = (await monitor.refresh()).infrastructure.environments[0];
    assert.equal(environment.state, "limited");
    const reportId = environment.reports[0].id;
    assert.equal(reportId, reportFingerprint(`proxmox-${targetId}`, "tasks", task));

    await store.add({ id: reportId, monitor: `proxmox-${targetId}`, capability: "tasks", ...task });
    environment = (await monitor.refreshAfterChange()).infrastructure.environments[0];
    assert.equal(environment.state, "healthy");
    assert.equal(Object.hasOwn(environment, "reports"), false);
  });
});
