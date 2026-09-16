import assert from "node:assert/strict";
import test from "node:test";

import {
  probeProxmox,
  probeProxmoxEndpoint,
  buildProxmoxProbePlan,
  PROXMOX_PROBE_LIMITS
} from "../server/proxmox-probes.mjs";
import { authorizeProxmoxRoute, PROXMOX_ROUTE_IDS } from "../server/routes.mjs";

const CHECKED_AT = "2026-09-13T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(CHECKED_AT) / 1000);
const RAW_SECRET = "01234567-89ab-4cde-8fab-0123456789ab";

function healthyFixtures() {
  return {
    permissions: { data: { "/": { "Sys.Audit": 1 } } },
    version: { data: { version: "9.1.7", release: "9.1" } },
    clusterStatus: {
      data: [
        { type: "cluster", name: "example-cluster", nodes: 2, quorate: 1 },
        { type: "node", name: "pve-a", nodeid: 1, online: 1, local: 1 },
        { type: "node", name: "pve-b", nodeid: 2, online: 1, local: 0 }
      ]
    },
    nodes: {
      data: [
        { node: "pve-a", status: "online", uptime: 86_400, maxcpu: 8, maxmem: 16_000, maxdisk: 100_000 },
        { node: "pve-b", status: "online", uptime: 172_800, maxcpu: 16, maxmem: 32_000, maxdisk: 100_000 }
      ]
    },
    nodeResources: {
      data: [
        { node: "pve-a", status: "online", cpu: 0.25, maxcpu: 8, mem: 8_000, maxmem: 16_000, disk: 20_000, maxdisk: 100_000, uptime: 86_400 },
        { node: "pve-b", status: "online", cpu: 0.5, maxcpu: 16, mem: 12_000, maxmem: 32_000, disk: 30_000, maxdisk: 100_000, uptime: 172_800 }
      ]
    },
    guests: {
      data: [
        { vmid: 2101, type: "qemu", node: "pve-a", name: "example-media-vm", status: "running", cpu: 0.2, maxcpu: 4, mem: 4_000, maxmem: 8_000, disk: 10_000, maxdisk: 100_000, uptime: 3_600 },
        { vmid: 2201, type: "lxc", node: "pve-b", name: "example-requests-lxc", status: "running", cpu: 0.1, maxcpu: 2, mem: 1_000, maxmem: 2_000, disk: 4_000, maxdisk: 20_000, uptime: 7_200 },
        { vmid: 2202, type: "lxc", node: "pve-b", name: "example-lab-lxc", status: "stopped", maxcpu: 2, maxmem: 2_000, maxdisk: 20_000 }
      ]
    },
    storage: {
      data: [
        { node: "pve-a", storage: "example-local", status: "available", disk: 20_000, maxdisk: 100_000 },
        { node: "pve-b", storage: "example-backups", status: "available", disk: 50_000, maxdisk: 100_000 }
      ]
    },
    tasks: {
      data: [
        { type: "qmstart", node: "pve-a", status: "OK", endtime: NOW_SECONDS - 30 }
      ]
    },
    backups: {
      data: [
        { type: "vzdump", id: 2101, node: "pve-a", status: "OK", endtime: NOW_SECONDS - 3_600 }
      ]
    }
  };
}

test("Proxmox internal routes are a fixed GET-only allowlist", () => {
  assert.deepEqual(PROXMOX_ROUTE_IDS, [
    "permissions",
    "version",
    "clusterStatus",
    "nodes",
    "nodeResources",
    "guests",
    "storage",
    "tasks",
    "backups"
  ]);
  for (const routeId of PROXMOX_ROUTE_IDS) {
    const route = authorizeProxmoxRoute(
      routeId,
      "GET",
      ["tasks", "backups"].includes(routeId) ? { node: "pve-a" } : {}
    );
    assert.equal(route.allowed, true);
    assert.equal(route.service, "proxmox");
    assert.equal(route.internalOnly, true);
    assert.match(route.upstreamPathAndQuery, /^\/api2\/json\//u);
    assert.doesNotMatch(route.upstreamPathAndQuery, /(?:token|secret|password|authorization)=/iu);
    assert.equal(Object.isFrozen(route), true);
  }
  assert.equal(
    authorizeProxmoxRoute("tasks", "GET", { node: "pve-a" }).upstreamPathAndQuery,
    "/api2/json/nodes/pve-a/tasks?source=archive&limit=100"
  );
  assert.equal(
    authorizeProxmoxRoute("backups", "GET", { node: "pve-b" }).upstreamPathAndQuery,
    "/api2/json/nodes/pve-b/tasks?source=archive&typefilter=vzdump&limit=100"
  );
  assert.doesNotMatch(authorizeProxmoxRoute("tasks", "GET", { node: "pve-a" }).upstreamPathAndQuery, /statusfilter/iu);
  assert.doesNotMatch(authorizeProxmoxRoute("backups", "GET", { node: "pve-a" }).upstreamPathAndQuery, /statusfilter/iu);
  assert.doesNotMatch(
    PROXMOX_ROUTE_IDS.map((routeId) => authorizeProxmoxRoute(
      routeId,
      "GET",
      ["tasks", "backups"].includes(routeId) ? { node: "pve-a" } : {}
    ).upstreamPathAndQuery).join("\n"),
    /\/cluster\/tasks/u
  );
  for (const node of [undefined, "", " pve-a", "pve-a ", ".", "..", "../access", "pve-a/../access", "pve-a\\tasks", "pve-a%2ftasks", "pve-a\u0000evil", `a${"b".repeat(63)}`]) {
    assert.equal(authorizeProxmoxRoute("tasks", "GET", { node }).code, "ROUTE_NOT_ALLOWED");
    assert.equal(authorizeProxmoxRoute("backups", "GET", { node }).code, "ROUTE_NOT_ALLOWED");
  }
  const hostileParameters = new Proxy({}, { get() { throw new Error("do not inspect"); } });
  assert.equal(authorizeProxmoxRoute("tasks", "GET", hostileParameters).code, "ROUTE_NOT_ALLOWED");
  assert.deepEqual(authorizeProxmoxRoute("../../access/ticket", "GET"), {
    allowed: false,
    code: "ROUTE_NOT_ALLOWED",
    message: "That Proxmox monitoring capability is not allowed.",
    status: 404
  });
  assert.equal(authorizeProxmoxRoute("version", "POST").code, "METHOD_NOT_ALLOWED");
});

test("Proxmox probe plan exposes only bounded read-only capabilities", () => {
  const plan = buildProxmoxProbePlan({ timeoutMs: 1_234 });
  assert.equal(plan.length, 9);
  assert.deepEqual(plan.map(({ id }) => id), [
    "identity",
    "version",
    "environment",
    "nodes",
    "node-resources",
    "guests",
    "storage",
    "tasks",
    "backups"
  ]);
  for (const entry of plan) {
    assert.equal(entry.method, "GET");
    assert.equal(entry.timeoutMs, 1_234);
    assert.ok(entry.maxBytes > 0 && entry.maxBytes <= 2 * 1024 * 1024);
    assert.equal(Object.isFrozen(entry), true);
  }
});

test("returns a deterministic healthy Proxmox capability snapshot", async () => {
  const fixtures = healthyFixtures();
  const calls = [];
  const result = await probeProxmox(async (routeId, options) => {
    calls.push({ routeId, node: options.node || null, method: options.method, checkId: options.checkId });
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });

  assert.deepEqual(calls.map(({ routeId }) => routeId), [
    "permissions",
    "version",
    "clusterStatus",
    "nodes",
    "nodeResources",
    "guests",
    "storage",
    "tasks",
    "tasks",
    "backups",
    "backups"
  ]);
  assert.deepEqual(
    calls.filter(({ routeId }) => ["tasks", "backups"].includes(routeId)).map(({ routeId, node }) => ({ routeId, node })),
    [
      { routeId: "tasks", node: "pve-a" },
      { routeId: "tasks", node: "pve-b" },
      { routeId: "backups", node: "pve-a" },
      { routeId: "backups", node: "pve-b" }
    ]
  );
  assert.ok(calls.every(({ method }) => method === "GET"));
  assert.equal(result.schema, 2);
  assert.equal(result.type, "proxmox");
  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.version, "9.1.7");
  assert.equal(result.checkedAt, CHECKED_AT);
  assert.deepEqual(result.metrics, {
    nodeTotal: 2,
    nodeOnline: 2,
    nodeOffline: 0,
    nodeCpuUsagePercent: 38,
    nodeMemoryUsedBytes: 20_000,
    nodeMemoryTotalBytes: 48_000,
    nodeDiskUsedBytes: 50_000,
    nodeDiskTotalBytes: 200_000,
    guestTotal: 3,
    guestRunning: 2,
    guestStopped: 1,
    virtualMachineTotal: 1,
    containerTotal: 2,
    storageTotal: 2,
    storageAvailable: 2,
    storageUnavailable: 0,
    storageUsedBytes: 70_000,
    storageTotalBytes: 200_000,
    storageUsagePercent: 35,
    taskRecordsObserved: 1,
    failedTasks24h: 0,
    backupTasksObserved: 1,
    backupFailures24h: 0,
    lastBackupSuccessAgeSeconds: 3_600
  });
  assert.deepEqual(result.discovery, {
    kind: "cluster",
    name: "example-cluster",
    clusterName: "example-cluster",
    quorate: true,
    nodeNames: ["pve-a", "pve-b"],
    localNode: "pve-a",
    nodes: [
      { name: "pve-a", online: true, local: true, nodeId: 1 },
      { name: "pve-b", online: true, local: false, nodeId: 2 }
    ]
  });
  assert.equal(result.inventory.nodes.length, 2);
  assert.equal(result.inventory.nodes.find(({ name }) => name === "pve-a").virtualMachineCount, 1);
  assert.equal(result.inventory.nodes.find(({ name }) => name === "pve-b").containerCount, 2);
  assert.equal(result.inventory.workloads.length, 3);
  assert.deepEqual(result.inventory.workloads.find(({ vmid }) => vmid === 2101).backup, {
    status: "success",
    endedAt: new Date((NOW_SECONDS - 3_600) * 1_000).toISOString(),
    ageSeconds: 3_600
  });
  assert.equal(result.inventory.storage.length, 2);
  assert.equal(JSON.stringify(result).includes("body"), false);
  assert.equal(JSON.stringify(result).includes("routeId"), false);
});

test("aggregates and deduplicates node-scoped task history while filtering backup rows defensively", async () => {
  const fixtures = healthyFixtures();
  const duplicateTask = {
    upid: "UPID:pve-a:00000001:00000001:00000001:qmstart:2101:helmsman@pam:",
    type: "qmstart",
    id: 2101,
    node: "pve-a",
    status: "OK",
    starttime: NOW_SECONDS - 120,
    endtime: NOW_SECONDS - 60
  };
  const duplicateBackup = {
    upid: "UPID:pve-a:00000002:00000002:00000002:vzdump:2101:helmsman@pam:",
    type: "vzdump",
    id: 2101,
    node: "pve-a",
    status: "OK",
    starttime: NOW_SECONDS - 7_300,
    endtime: NOW_SECONDS - 7_200
  };
  const result = await probeProxmox(async (routeId, options) => {
    if (routeId === "tasks") {
      return {
        status: 200,
        body: { data: options.node === "pve-a"
          ? [duplicateTask]
          : [duplicateTask, {
              upid: "UPID:pve-b:00000003:00000003:00000003:qmstop:2201:helmsman@pam:",
              type: "qmstop",
              id: 2201,
              node: "pve-b",
              status: "ERROR",
              starttime: NOW_SECONDS - 90,
              endtime: NOW_SECONDS - 30
            }] }
      };
    }
    if (routeId === "backups") {
      return {
        status: 200,
        body: { data: options.node === "pve-a"
          ? [duplicateBackup, {
              type: "qmstart",
              id: 999,
              node: "pve-a",
              status: "OK",
              endtime: NOW_SECONDS - 10
            }]
          : [duplicateBackup, {
              upid: "UPID:pve-b:00000004:00000004:00000004:vzdump:2201:helmsman@pam:",
              type: "vzdump",
              id: 2201,
              node: "pve-b",
              status: "OK",
              starttime: NOW_SECONDS - 3_700,
              endtime: NOW_SECONDS - 3_600
            }] }
      };
    }
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT), historyConcurrency: 2 });

  assert.equal(result.metrics.taskRecordsObserved, 2);
  assert.equal(result.metrics.failedTasks24h, 1);
  assert.equal(result.metrics.backupTasksObserved, 2);
  assert.equal(result.metrics.backupFailures24h, 0);
  assert.equal(result.inventory.activity.filter(({ type }) => type === "qmstart").length, 1);
  assert.equal(result.inventory.workloads.find(({ vmid }) => vmid === 2101).backup.status, "success");
  assert.equal(result.inventory.workloads.find(({ vmid }) => vmid === 2201).backup.status, "success");
  assert.equal(JSON.stringify(result).includes("UPID:"), false);
  assert.equal(JSON.stringify(result).includes("helmsman@pam"), false);
});

test("keeps successful node history and reports partial task and backup coverage safely", async () => {
  const fixtures = healthyFixtures();
  const rawSecret = "partial-history-secret-must-not-escape";
  const result = await probeProxmox(async (routeId, options) => {
    if (routeId === "tasks" && options.node === "pve-b") {
      return { status: 500, body: { message: rawSecret } };
    }
    if (routeId === "backups" && options.node === "pve-b") {
      return { status: 403, body: { message: rawSecret } };
    }
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT), historyConcurrency: 2 });

  assert.equal(result.state, "limited");
  assert.equal(result.connectionState, "connected");
  const tasks = result.checks.find(({ id }) => id === "tasks");
  const backups = result.checks.find(({ id }) => id === "backups");
  assert.equal(tasks.state, "limited");
  assert.equal(tasks.code, "TASK_HISTORY_PARTIAL");
  assert.equal(tasks.httpStatus, null);
  assert.match(tasks.reports[0].message, /1 of 2 discovered nodes/u);
  assert.equal(tasks.reports[1].source, "Recent failed tasks · Node pve-b");
  assert.match(tasks.reports[1].message, /GET \/api2\/json\/nodes\/pve-b\/tasks\?source=archive&limit=100 failed/u);
  assert.match(tasks.reports[1].message, /HTTP 500/u);
  assert.match(tasks.reports[1].message, /Review the Proxmox service logs/u);
  assert.equal(backups.state, "limited");
  assert.equal(backups.code, "BACKUP_HISTORY_PARTIAL");
  assert.match(backups.reports[0].message, /1 of 2 discovered nodes/u);
  assert.equal(backups.reports[1].source, "Backup freshness · Node pve-b");
  assert.match(backups.reports[1].message, /GET \/api2\/json\/nodes\/pve-b\/tasks\?source=archive&typefilter=vzdump&limit=100 failed/u);
  assert.match(backups.reports[1].message, /Sys\.Audit/u);
  assert.match(backups.reports[1].message, /HTTP 403/u);
  assert.equal(result.metrics.taskRecordsObserved, 1);
  assert.equal(result.metrics.backupTasksObserved, 1);
  assert.equal(JSON.stringify(result).includes(rawSecret), false);
});

test("bounds per-node history collection and marks omitted node history limited", async () => {
  const fixtures = healthyFixtures();
  const nodeCount = PROXMOX_PROBE_LIMITS.maximumHistoryNodes + 6;
  const names = Array.from({ length: nodeCount }, (_value, index) => `pve-${String(index + 1).padStart(2, "0")}`);
  fixtures.clusterStatus.data = [
    { type: "cluster", name: "LargeLab", nodes: nodeCount, quorate: 1 },
    ...names.map((name, index) => ({ type: "node", name, nodeid: index + 1, online: 1, local: index === 0 ? 1 : 0 }))
  ];
  fixtures.nodes.data = names.map((node) => ({ node, status: "online" }));
  const historyCalls = [];
  const result = await probeProxmox(async (routeId, options) => {
    if (["tasks", "backups"].includes(routeId)) {
      historyCalls.push({ routeId, node: options.node });
      return { status: 200, body: { data: [] } };
    }
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT), historyConcurrency: 4 });

  assert.equal(
    historyCalls.filter(({ routeId }) => routeId === "tasks").length,
    PROXMOX_PROBE_LIMITS.maximumHistoryNodes
  );
  assert.equal(
    historyCalls.filter(({ routeId }) => routeId === "backups").length,
    PROXMOX_PROBE_LIMITS.maximumHistoryNodes
  );
  assert.equal(result.checks.find(({ id }) => id === "tasks").code, "TASK_HISTORY_PARTIAL");
  assert.equal(result.checks.find(({ id }) => id === "backups").code, "BACKUP_HISTORY_PARTIAL");
  assert.match(result.checks.find(({ id }) => id === "tasks").reports[0].message, /6 of 70/u);
  assert.match(result.checks.find(({ id }) => id === "tasks").reports[0].message, /64-node history limit/u);
});

test("endpoint discovery does not collect cluster-wide inventory", async () => {
  const fixtures = healthyFixtures();
  const calls = [];
  const result = await probeProxmoxEndpoint(async (routeId) => {
    calls.push(routeId);
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });
  assert.deepEqual(calls, ["permissions", "version", "clusterStatus"]);
  assert.equal(result.connectionState, "connected");
  assert.equal(result.discovery.kind, "cluster");
  assert.equal(result.inventory.nodes.length, 2, "bounded discovery nodes may be retained");
  assert.deepEqual(result.inventory.workloads, []);
  assert.deepEqual(result.inventory.storage, []);
});

test("multiple nodes without a named cluster do not become a trusted environment identity", async () => {
  const fixtures = healthyFixtures();
  delete fixtures.clusterStatus.data[0].name;
  const result = await probeProxmoxEndpoint(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(result.connectionState, "connected");
  assert.equal(result.discovery.kind, "unknown");
  assert.equal(result.discovery.clusterName, null);
  assert.deepEqual(result.discovery.nodeNames, ["pve-a", "pve-b"]);
});

test("surfaces bounded service-reported infrastructure failures without leaking secrets", async () => {
  const fixtures = healthyFixtures();
  fixtures.nodes.data[1].status = "offline";
  fixtures.nodeResources.data[0].mem = 15_500;
  fixtures.storage.data[1].status = "offline";
  fixtures.tasks.data = [{
    type: "qmigrate",
    node: "pve-b",
    status: `failed token=${RAW_SECRET} <script>alert(1)</script>`,
    endtime: NOW_SECONDS - 60
  }];
  fixtures.backups.data = [
    { type: "vzdump", node: "pve-a", status: "OK", endtime: NOW_SECONDS - 86_400 },
    { type: "vzdump", node: "pve-a", status: "storage unavailable", endtime: NOW_SECONDS - 60 }
  ];

  const result = await probeProxmox(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(result.state, "degraded");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.metrics.nodeOffline, 1);
  assert.equal(result.metrics.storageUnavailable, 1);
  assert.equal(result.metrics.failedTasks24h, 1);
  assert.equal(result.metrics.backupFailures24h, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(RAW_SECRET), false);
  assert.equal(serialized.includes("<script>"), false);
  assert.match(serialized, /Proxmox reported this task as failed/u);
  assert.ok(result.reports.length <= 12);
  assert.equal(result.checks.find(({ id }) => id === "backups").code, "LATEST_BACKUP_FAILED");
});

test("stops immediately when the API token is rejected", async () => {
  const calls = [];
  const result = await probeProxmox(async (routeId) => {
    calls.push(routeId);
    return { status: 401, body: { data: null } };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });
  assert.deepEqual(calls, ["permissions"]);
  assert.equal(result.state, "auth_required");
  assert.equal(result.connectionState, "auth_required");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].code, "AUTH_REQUIRED");
  assert.equal(result.checks[0].httpStatus, 401);
});

test("does not mistake a public version response for valid API authorization", async () => {
  const fixtures = healthyFixtures();
  const calls = [];
  const result = await probeProxmox(async (routeId) => {
    calls.push(routeId);
    if (routeId === "nodes") return { status: 401, body: { data: null } };
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });
  assert.deepEqual(calls, ["permissions", "version", "clusterStatus", "nodes"]);
  assert.equal(result.connectionState, "auth_required");
  assert.equal(result.state, "auth_required");
  assert.equal(result.checks.find(({ id }) => id === "nodes").code, "AUTH_REQUIRED");
});

test("an authenticated but empty node inventory cannot appear healthy", async () => {
  const fixtures = healthyFixtures();
  fixtures.nodes.data = [];
  const result = await probeProxmox(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  const nodes = result.checks.find(({ id }) => id === "nodes");
  assert.equal(nodes.state, "degraded");
  assert.equal(nodes.code, "NO_NODES_VISIBLE");
  assert.equal(nodes.metrics.nodeTotal, 0);
  assert.match(nodes.reports[0].message, /audit permissions/u);
  assert.equal(result.state, "degraded");
});

test("omits backup age metrics when that outcome was not observed", async () => {
  const fixtures = healthyFixtures();
  fixtures.backups.data = [];
  let result = await probeProxmox(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(Object.hasOwn(result.metrics, "lastBackupSuccessAgeSeconds"), false);
  assert.equal(Object.hasOwn(result.metrics, "lastBackupFailureAgeSeconds"), false);
  assert.equal(result.checks.find(({ id }) => id === "backups").state, "healthy");
  assert.equal(result.checks.find(({ id }) => id === "backups").code, null);

  fixtures.backups.data = [{
    type: "vzdump",
    node: "pve-a",
    status: "--password hunter2 --token abc123 -p short",
    endtime: NOW_SECONDS - 30
  }];
  result = await probeProxmox(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(Object.hasOwn(result.metrics, "lastBackupSuccessAgeSeconds"), false);
  assert.equal(result.metrics.lastBackupFailureAgeSeconds, 30);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes("abc123"), false);
  assert.equal(JSON.stringify(result).includes("short"), false);
});

test("ignores in-progress task rows without an end time", async () => {
  const fixtures = healthyFixtures();
  fixtures.tasks.data.unshift({
    type: "qmigrate",
    node: "pve-a",
    status: "running"
  });
  fixtures.backups.data.unshift({
    type: "vzdump",
    node: "pve-a",
    status: "running"
  });
  const result = await probeProxmox(async (routeId) => ({ status: 200, body: fixtures[routeId] }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(result.metrics.taskRecordsObserved, 1);
  assert.equal(result.metrics.failedTasks24h, 0);
  assert.equal(result.metrics.backupTasksObserved, 1);
  assert.equal(result.metrics.backupFailures24h, 0);
});

test("reports unavailable node history with fixed actionable copy and no upstream details", async () => {
  const fixtures = healthyFixtures();
  const rawSecret = "upstream-task-error-secret-must-not-escape";
  const result = await probeProxmox(async (routeId) => {
    if (routeId === "tasks") return { status: 400, body: { message: rawSecret } };
    if (routeId === "backups") {
      throw Object.assign(new Error(rawSecret), { code: "UPSTREAM_TIMEOUT" });
    }
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT), historyConcurrency: 2 });

  const tasks = result.checks.find(({ id }) => id === "tasks");
  const backups = result.checks.find(({ id }) => id === "backups");
  assert.equal(tasks.code, "TASK_HISTORY_UNAVAILABLE");
  assert.equal(tasks.httpStatus, 400);
  assert.match(tasks.reports[0].message, /any of 2 discovered nodes/u);
  assert.equal(tasks.reports[1].source, "Recent failed tasks · Node pve-a");
  assert.match(tasks.reports[1].message, /GET \/api2\/json\/nodes\/pve-a\/tasks\?source=archive&limit=100 failed/u);
  assert.match(tasks.reports[1].message, /node-scoped task-history request \(HTTP 400\)/u);
  assert.match(tasks.reports[1].message, /Verify Proxmox API compatibility/u);
  assert.equal(backups.code, "BACKUP_HISTORY_UNAVAILABLE");
  assert.equal(backups.httpStatus, null);
  assert.match(backups.reports[0].message, /any of 2 discovered nodes/u);
  assert.equal(backups.reports[1].source, "Backup freshness · Node pve-a");
  assert.match(backups.reports[1].message, /GET \/api2\/json\/nodes\/pve-a\/tasks\?source=archive&typefilter=vzdump&limit=100 failed/u);
  assert.match(backups.reports[1].message, /timed out/u);
  assert.match(backups.reports[1].message, /Verify node reachability/u);
  assert.equal(JSON.stringify(result).includes(rawSecret), false);
});

test("maps non-history probe failures to fixed actionable reports", async () => {
  const fixtures = healthyFixtures();
  const rawSecret = "transport-error-secret-must-not-escape";
  const result = await probeProxmox(async (routeId) => {
    if (routeId === "version") {
      throw Object.assign(new Error(rawSecret), { code: "UPSTREAM_TIMEOUT" });
    }
    return { status: 200, body: fixtures[routeId] };
  }, { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });

  const version = result.checks.find(({ id }) => id === "version");
  assert.equal(version.code, "UPSTREAM_TIMEOUT");
  assert.match(version.reports[0].message, /did not respond/u);
  assert.equal(JSON.stringify(result).includes(rawSecret), false);
});

test("an unavailable optional version endpoint is limited without masking authenticated health", async () => {
  const fixtures = healthyFixtures();
  const result = await probeProxmox(async (routeId) => (
    routeId === "version"
      ? { status: 500, body: { data: null } }
      : { status: 200, body: fixtures[routeId] }
  ), { checkedAt: CHECKED_AT, clock: () => Date.parse(CHECKED_AT) });
  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "limited");
  assert.equal(result.checks.find(({ id }) => id === "version").state, "limited");
  assert.equal(result.checks.find(({ id }) => id === "identity").state, "healthy");
  assert.match(result.checks.find(({ id }) => id === "version").reports[0].message, /HTTP 500/u);
});

test("never reflects malformed Proxmox response bodies", async () => {
  const malicious = { raw: `<img src=x onerror=alert(1)> token=${RAW_SECRET}` };
  const result = await probeProxmox(async () => ({ status: 200, body: malicious }), {
    checkedAt: CHECKED_AT,
    clock: () => Date.parse(CHECKED_AT)
  });
  assert.equal(result.state, "down");
  assert.equal(result.checks[0].code, "INVALID_RESPONSE");
  assert.match(result.checks[0].reports[0].message, /unexpected API response/u);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(RAW_SECRET), false);
  assert.equal(serialized.includes("onerror"), false);
});
