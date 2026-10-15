import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalNetworkMap, createNetworkMapStore, emptyNetworkMap, NETWORK_MAP_LIMITS } from "../server/network-map.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";


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
        resolve({ status: response.statusCode, headers: response.headers, json: bytes.length ? JSON.parse(bytes.toString("utf8")) : null });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-network-map-api-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const networkMap = await createNetworkMapStore({ dataDir: root });
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    networkMap,
    lookup: async () => [{ address: "10.20.30.40", family: 4 }]
  });
  const server = http.createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (!await controlPlane.handle(incoming, response, url)) {
        response.statusCode = 404;
        response.end();
      }
    } catch (error) {
      response.statusCode = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: error?.code || "INTERNAL_ERROR", message: error?.message || "failed" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return { root, store, server, controlPlane, networkMap, port, origin: `http://127.0.0.1:${port}`, setupToken };
}

async function stop(context) {
  await new Promise((resolve) => context.server.close(resolve));
  await context.controlPlane.close();
  await rm(context.root, { recursive: true, force: true });
}

async function claim(context) {
  const response = await request(context.port, "/api/v2/setup/claim", {
    method: "POST",
    origin: context.origin,
    body: {
      setupToken: context.setupToken,
      deviceName: "Network map test browser",
      origin: context.origin,
      allowedCidrs: ["10.0.0.0/8"],
      allowPublicHttps: false
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return {
    origin: context.origin,
    cookie: response.headers["set-cookie"][0].split(";", 1)[0],
    csrf: response.json.csrfToken
  };
}

function sampleMap() {
  return {
    zones: [
      { id: "edge", title: "Internet and network edge", row: 0, order: 0 },
      { id: "media-node", title: "Media node", row: 1, order: 0 }
    ],
    items: [
      { id: "internet", name: "Internet", kind: "internet", zone: "edge", col: 1, row: 0, address: "1 Gbps" },
      { id: "router", name: "Edge router", kind: "router", zone: "edge", col: 1, row: 1, address: "10.20.0.1", state: "online" },
      { id: "node", name: "media-node", kind: "host", zone: "media-node", col: 1, row: 0, source: { type: "node", name: "media-node" } },
      { id: "guest", name: "Media VM", kind: "vm", zone: "media-node", col: 0, row: 1, source: { type: "guest", vmid: 100, environment: "a1b2" } },
      { id: "app", name: "Request portal", kind: "container", zone: "media-node", col: 1, row: 1, source: { type: "container", name: "request-portal", server: "c3d4", environment: 2 } },
      { id: "svc", name: "Media server", kind: "service", zone: "media-node", col: 2, row: 1, source: { type: "service", id: "jellyfin" }, notes: "Line one\r\nLine two" }
    ],
    links: [
      { id: "l1", from: "internet", to: "router", kind: "wan", label: "WAN" },
      { id: "l2", from: "router", to: "node", kind: "wired" },
      { id: "l3", from: "app", to: "guest", kind: "flow", label: "Proxy" }
    ]
  };
}

test("network maps are canonicalized with defaults and bounded fields", () => {
  const canonical = canonicalNetworkMap(sampleMap());
  assert.equal(canonical.items.length, 6);
  assert.deepEqual(canonical.items[0], {
    id: "internet", name: "Internet", kind: "internet", zone: "edge", col: 1, row: 0,
    address: "1 Gbps", role: "", notes: "", source: null, state: "unknown"
  });
  assert.equal(canonical.items[5].notes, "Line one\nLine two");
  assert.deepEqual(canonical.items[4].source, { type: "container", name: "request-portal", server: "c3d4", environment: "2" });
  assert.equal(canonical.links[1].label, "");
  assert.deepEqual(canonicalNetworkMap(emptyNetworkMap()), { zones: [], items: [], links: [] });
});

test("network maps reject unsafe or inconsistent shapes", () => {
  const cases = [
    (map) => { map.extra = true; },
    (map) => { map.zones[0].id = "Edge"; },
    (map) => { map.zones.push({ ...map.zones[0] }); },
    (map) => { map.items[0].name = "bad\u0000name"; },
    (map) => { map.items[0].name = "line\nbreak"; },
    (map) => { map.items[0].kind = "spaceship"; },
    (map) => { map.items[0].zone = "missing"; },
    (map) => { map.items[0].col = 1; map.items[0].row = 1; },
    (map) => { map.items[0].col = NETWORK_MAP_LIMITS.columns; },
    (map) => { map.items[0].state = "exploded"; },
    (map) => { map.items[0].url = "http://10.0.0.1"; },
    (map) => { map.items[0].address = "x".repeat(NETWORK_MAP_LIMITS.addressLength + 1); },
    (map) => { map.items[2].source = { type: "guest", vmid: 0 }; },
    (map) => { map.items[2].source = { type: "node", name: "<script>" }; },
    (map) => { map.items[2].source = { type: "service", id: "Jellyfin" }; },
    (map) => { map.items[2].source = { type: "url", value: "x" }; },
    (map) => { map.items[2].source = { type: "node", name: "n", token: "secret" }; },
    (map) => { map.links[0].to = "missing"; },
    (map) => { map.links[0].to = map.links[0].from; },
    (map) => { map.links[0].kind = "laser"; },
    (map) => { map.links.push({ id: "l9", from: "router", to: "internet", kind: "wan" }); },
    (map) => { map.zones = Array.from({ length: NETWORK_MAP_LIMITS.zones + 1 }, (_, index) => ({ id: `z${index}`, title: "Z", row: 0, order: 0 })); }
  ];
  for (const [index, mutate] of cases.entries()) {
    const map = sampleMap();
    mutate(map);
    assert.throws(() => canonicalNetworkMap(map), (error) => error.code === "INVALID_NETWORK_MAP", `case ${index + 1}`);
  }
});

test("saving the network map requires a session, CSRF and the current revision", async () => {
  const context = await start();
  try {
    const anonymous = await request(context.port, "/api/v2/network-map", { origin: context.origin });
    assert.equal(anonymous.status, 401);

    const session = await claim(context);
    const empty = await request(context.port, "/api/v2/network-map", { cookie: session.cookie, origin: session.origin });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { networkMap: { map: { zones: [], items: [], links: [] }, revision: null, updatedAt: null } });

    const withoutCsrf = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      origin: session.origin,
      cookie: session.cookie,
      body: { map: sampleMap(), revision: null }
    });
    assert.equal(withoutCsrf.status, 403);

    const extraKeys = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      ...session,
      body: { map: sampleMap(), revision: null, title: "x" }
    });
    assert.equal(extraKeys.status, 400);

    const broken = sampleMap();
    broken.links[0].to = "missing";
    const invalid = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      ...session,
      body: { map: broken, revision: null }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_NETWORK_MAP");

    const saved = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      ...session,
      body: { map: sampleMap(), revision: null }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.match(saved.json.networkMap.revision, /^[a-f0-9-]{36}$/u);
    assert.equal(saved.json.networkMap.map.items.length, 6);

    const stale = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      ...session,
      body: { map: sampleMap(), revision: null }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "NETWORK_MAP_CONFLICT");

    const next = sampleMap();
    next.items.pop();
    const updated = await request(context.port, "/api/v2/network-map", {
      method: "PUT",
      ...session,
      body: { map: next, revision: saved.json.networkMap.revision }
    });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.json.networkMap.revision, saved.json.networkMap.revision);

    const persisted = JSON.parse(await readFile(path.join(context.root, "network-map.json"), "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.map.items.length, 5);
    const reloaded = await createNetworkMapStore({ dataDir: context.root });
    assert.equal(reloaded.get().revision, updated.json.networkMap.revision);

    const query = await request(context.port, "/api/v2/network-map?x=1", { cookie: session.cookie, origin: session.origin });
    assert.equal(query.status, 404);
    const deleted = await request(context.port, "/api/v2/network-map", { method: "DELETE", ...session });
    assert.equal(deleted.status, 405);
  } finally {
    await stop(context);
  }
});

test("a corrupt or invalid network map file loads as an empty map", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-network-map-corrupt-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(root, "network-map.json"), "{not json");
    const store = await createNetworkMapStore({ dataDir: root });
    assert.deepEqual(store.get(), { map: { zones: [], items: [], links: [] }, revision: null, updatedAt: null });

    await writeFile(path.join(root, "network-map.json"), JSON.stringify({
      version: 1,
      revision: "0b5f0d3c-7a2e-4c1d-9f3e-2a1b3c4d5e6f",
      updatedAt: "2026-10-14T00:00:00.000Z",
      map: { zones: [], items: [{ id: "x" }], links: [] }
    }));
    const invalidStore = await createNetworkMapStore({ dataDir: root });
    assert.equal(invalidStore.get().revision, null);
    const saved = await invalidStore.save(sampleMap(), null);
    assert.equal(saved.map.zones.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
