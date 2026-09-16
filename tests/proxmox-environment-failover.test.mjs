import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBroker, createHttpServer } from "../server/broker.mjs";

const TOKEN_ID = "helmsman@pve!monitoring";
const TOKEN_SECRET = "cluster-failover-test-token";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, pathname, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.csrf ? { "X-Jellofin-Csrf": options.csrf } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          json: bytes.length ? JSON.parse(bytes.toString("utf8")) : null
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

function fixture(routeId) {
  const now = Math.floor(Date.now() / 1_000);
  const values = {
    permissions: { data: { "/": { "Sys.Audit": 1 } } },
    version: { data: { version: "9.1.7" } },
    clusterStatus: { data: [
      { type: "cluster", name: "HomeLab", nodes: 2, quorate: 1 },
      { type: "node", name: "pve-1", nodeid: 1, online: 1, local: 1 },
      { type: "node", name: "pve-2", nodeid: 2, online: 1, local: 0 }
    ] },
    nodes: { data: [
      { node: "pve-1", status: "online", maxcpu: 8, maxmem: 16_000, maxdisk: 100_000, uptime: 86_400 },
      { node: "pve-2", status: "online", maxcpu: 8, maxmem: 16_000, maxdisk: 100_000, uptime: 172_800 }
    ] },
    nodeResources: { data: [
      { node: "pve-1", status: "online", cpu: 0.2, maxcpu: 8, mem: 4_000, maxmem: 16_000, disk: 20_000, maxdisk: 100_000, uptime: 86_400 },
      { node: "pve-2", status: "online", cpu: 0.3, maxcpu: 8, mem: 5_000, maxmem: 16_000, disk: 30_000, maxdisk: 100_000, uptime: 172_800 }
    ] },
    guests: { data: [
      { vmid: 100, type: "qemu", node: "pve-1", name: "Jellyfin", status: "running", mem: 2_000, maxmem: 4_000 },
      { vmid: 104, type: "lxc", node: "pve-2", name: "Seerr", status: "running", mem: 1_000, maxmem: 2_000 }
    ] },
    storage: { data: [{ node: "pve-1", storage: "local-zfs", status: "available", disk: 20_000, maxdisk: 100_000 }] },
    tasks: { data: [{ type: "qmstart", node: "pve-1", status: "OK", endtime: now - 60 }] },
    backups: { data: [{ type: "vzdump", id: 100, node: "pve-1", status: "OK", endtime: now - 3_600 }] }
  };
  return values[routeId];
}

test("cluster inventory fails over once without duplicating nodes or workloads", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-proxmox-failover-"));
  const calls = [];
  let primaryUnavailable = false;
  const broker = await createBroker({
    dataDir,
    monitorIntervalMs: 60_000,
    lookup: async (hostname) => [{ address: hostname === "pve-1.test" ? "10.20.30.41" : "10.20.30.42", family: 4 }],
    dispatchProxmox: async ({ targetResolution, route, credentials }) => {
      const endpointPort = targetResolution.target.port;
      calls.push({
        endpointPort,
        routeId: route.routeId,
        actionId: route.actionId,
        operation: route.operation,
        node: route.node || null,
        type: route.type,
        vmid: route.vmid
      });
      assert.equal(Buffer.isBuffer(credentials.tokenId), true);
      assert.equal(Buffer.isBuffer(credentials.tokenSecret), true);
      if (primaryUnavailable && endpointPort === 8006) throw new Error("simulated primary TLS failure");
      if (route.actionId === "workload") {
        return { status: 200, body: Buffer.from('{"data":"not-a-valid-upid"}', "utf8") };
      }
      return { status: 200, body: Buffer.from(JSON.stringify(fixture(route.routeId)), "utf8") };
    }
  });
  const server = createHttpServer(broker.handler);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    broker.beginShutdown();
    await close(server);
    await broker.drain();
    await rm(dataDir, { recursive: true, force: true });
  });

  const claimed = await request(port, "/api/v2/setup/claim", {
    method: "POST",
    origin,
    body: {
      setupToken: broker.setupToken,
      deviceName: "Failover test browser",
      origin,
      allowedCidrs: ["10.20.30.0/24"],
      allowPublicHttps: false
    }
  });
  assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
  const authentication = {
    origin,
    cookie: claimed.headers["set-cookie"][0].split(";", 1)[0],
    csrf: claimed.json.csrfToken
  };

  const environment = await request(port, "/api/v2/infrastructure/environments", {
    method: "POST",
    ...authentication,
    body: {
      type: "proxmox",
      displayName: "HomeLab",
      url: "https://pve-1.test:8006",
      enabled: true,
      monitoringEnabled: true,
      monitoringIntervalSeconds: 60,
      tlsMode: "system",
      credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
    }
  });
  assert.equal(environment.status, 201, JSON.stringify(environment.json));
  assert.equal(environment.json.environmentKind, "cluster");

  const alternate = await request(
    port,
    `/api/v2/infrastructure/environments/${environment.json.id}/endpoints`,
    {
      method: "POST",
      ...authentication,
      body: {
        label: "pve-2 failover",
        url: "https://pve-2.test:8007",
        enabled: true,
        tlsMode: "system",
        credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
      }
    }
  );
  assert.equal(alternate.status, 201, JSON.stringify(alternate.json));

  await request(port, "/api/v2/operations/refresh", { method: "POST", ...authentication, body: {} });
  primaryUnavailable = true;
  calls.length = 0;
  const refreshed = await request(port, "/api/v2/operations/refresh", {
    method: "POST",
    ...authentication,
    body: {}
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  const observed = refreshed.json.infrastructure.environments[0];
  assert.equal(observed.state, "limited");
  assert.equal(observed.selectedEndpointId, alternate.json.id);
  assert.equal(observed.endpoints.find(({ id }) => id === environment.json.primaryEndpointId).state, "down");
  assert.equal(observed.endpoints.find(({ id }) => id === alternate.json.id).state, "healthy");
  assert.deepEqual(observed.nodes.map(({ name }) => name), ["pve-1", "pve-2"]);
  assert.deepEqual(observed.workloads.map(({ vmid }) => vmid), [100, 104]);
  assert.equal(observed.nodes.find(({ name }) => name === "pve-1").status, "online", "node health remains independent from its failed API endpoint");

  const clusterResources = calls.filter(({ routeId }) => ["nodes", "nodeResources", "guests", "storage"].includes(routeId));
  assert.equal(clusterResources.length, 4, "cluster-wide resources must be collected only once per cycle");
  const nodeHistory = calls.filter(({ routeId }) => ["tasks", "backups"].includes(routeId));
  assert.deepEqual(
    nodeHistory.map(({ routeId, node }) => ({ routeId, node })).sort((left, right) => `${left.routeId}:${left.node}`.localeCompare(`${right.routeId}:${right.node}`)),
    [
      { routeId: "backups", node: "pve-1" },
      { routeId: "backups", node: "pve-2" },
      { routeId: "tasks", node: "pve-1" },
      { routeId: "tasks", node: "pve-2" }
    ]
  );
  assert.equal(
    [...clusterResources, ...nodeHistory].every(({ endpointPort }) => endpointPort === 8007),
    true,
    "the available alternate supplies the one inventory collection and node-scoped history"
  );

  await t.test("an invalid 2xx Proxmox action acknowledgement has an unknown outcome and a retry cooldown", async () => {
    const body = {
      environmentId: environment.json.id,
      node: "pve-1",
      type: "qemu",
      vmid: 100,
      operation: "reboot",
      targetRevision: observed.targetRevision
    };
    const action = await request(port, "/api/v2/actions/proxmox/workload", {
      method: "POST",
      ...authentication,
      body
    });
    assert.equal(action.status, 502);
    assert.equal(action.json.code, "ACTION_OUTCOME_UNKNOWN");
    assert.equal(Object.hasOwn(action.json, "taskId"), false);
    const retry = await request(port, "/api/v2/actions/proxmox/workload", {
      method: "POST",
      ...authentication,
      body
    });
    assert.equal(retry.status, 409);
    assert.equal(retry.json.code, "ACTION_RECENTLY_ACCEPTED");
    const actionCalls = calls.filter(({ actionId }) => actionId === "workload");
    assert.equal(actionCalls.length, 1, "the cooldown must prevent a duplicate Proxmox task");
    assert.equal(actionCalls[0].endpointPort, 8007);
  });
});
