import assert from "node:assert/strict";
import test from "node:test";

import { canonicalNetworkMap, NETWORK_ITEM_KINDS, NETWORK_ITEM_STATES, NETWORK_LINK_KINDS } from "../server/network-map.mjs";
import {
  ITEM_KINDS,
  LINK_KINDS,
  MANUAL_STATES,
  NETWORK_LIMITS,
  addNodeWithGuests,
  buildLiveIndex,
  discoveredSources,
  freeCell,
  layoutNetworkMap,
  linkRoute,
  mapFromInventory,
  projector,
  resolveItemStatus,
  slugId
} from "../src/ui/network-map.js";

function inventory() {
  return buildLiveIndex({
    environments: [{ id: "env-a", name: "Lab" }],
    nodes: [
      { id: "env-a:alpha", name: "alpha", environmentId: "env-a", environmentName: "Lab", status: "online" },
      { id: "env-a:beta", name: "beta", environmentId: "env-a", environmentName: "Lab", status: "offline" }
    ],
    workloads: [
      { id: "w1", vmid: 100, type: "qemu", kind: "VM", name: "media-vm", node: "alpha", environmentId: "env-a", status: "running" },
      { id: "w2", vmid: 101, type: "lxc", kind: "LXC", name: "files", node: "alpha", environmentId: "env-a", status: "stopped" },
      { id: "w3", vmid: 200, type: "lxc", kind: "LXC", name: "proxy", node: "beta", environmentId: "env-a", status: "running" },
      { id: "w4", vmid: 900, type: "qemu", kind: "VM", name: "template", node: "alpha", environmentId: "env-a", status: "stopped", template: true }
    ],
    containers: [
      { key: "c1", id: "a".repeat(12), name: "request-portal", serverId: "srv", environmentId: 2, environmentName: "docker-host", state: "running", health: "healthy", status: "Up 3 days" },
      { key: "c2", id: "b".repeat(12), name: "/indexer", serverId: "srv", environmentId: 2, environmentName: "docker-host", state: "running", health: "unhealthy", status: "Up (unhealthy)" }
    ],
    portainerEnvironments: [{ id: 2, name: "docker-host", serverId: "srv", serverName: "Portainer" }],
    services: [{ id: "jellyfin", name: "Jellyfin", state: "degraded", connectionState: "connected" }]
  });
}

test("the client and server agree on kinds, states and link types", () => {
  assert.deepEqual(ITEM_KINDS.map(([value]) => value), [...NETWORK_ITEM_KINDS]);
  assert.deepEqual(MANUAL_STATES.map(([value]) => value), [...NETWORK_ITEM_STATES]);
  assert.deepEqual(LINK_KINDS.map(([value]) => value), [...NETWORK_LINK_KINDS]);
});

test("generated ids are valid and unique", () => {
  const taken = new Set(["router"]);
  assert.equal(slugId("Router", taken), "router-2");
  assert.match(slugId("  Ünïcode Name!!  ", new Set()), /^[a-z0-9][a-z0-9-]{0,47}$/u);
  assert.match(slugId("", new Set()), /^[a-z0-9][a-z0-9-]{0,47}$/u);
  assert.match(slugId("x".repeat(200), new Set()), /^[a-z0-9][a-z0-9-]{0,47}$/u);
});

test("layout places zones in rows and items on their grid, centred on the origin", () => {
  const map = {
    zones: [
      { id: "edge", title: "Edge", row: 0, order: 0 },
      { id: "left", title: "Left", row: 1, order: 0 },
      { id: "right", title: "Right", row: 1, order: 1 }
    ],
    items: [
      { id: "a", name: "A", kind: "router", zone: "edge", col: 0, row: 0 },
      { id: "b", name: "B", kind: "switch", zone: "edge", col: 0, row: 1 },
      { id: "c", name: "C", kind: "host", zone: "left", col: 0, row: 0 },
      { id: "d", name: "D", kind: "vm", zone: "right", col: 2, row: 0 }
    ],
    links: []
  };
  const layout = layoutNetworkMap(map);
  assert.equal(layout.zones.length, 3);
  const left = layout.zones.find(({ id }) => id === "left");
  const right = layout.zones.find(({ id }) => id === "right");
  assert.equal(left.y0, right.y0, "zones in the same row share a top edge");
  assert.ok(right.x0 > left.x0 + left.w, "zones in a row sit left to right without overlap");
  assert.equal(right.cols, 3);
  const a = layout.itemById.get("a");
  const b = layout.itemById.get("b");
  assert.equal(a.x, b.x);
  assert.ok(b.y > a.y);
  const centreY = (layout.bounds.minY + layout.bounds.maxY) / 2;
  assert.ok(Math.abs(centreY) < 1, "the model is centred vertically");
  assert.deepEqual(linkRoute(a, b).length, 2);
  assert.deepEqual(linkRoute(a, layout.itemById.get("d")).length, 4);
});

test("free cells fill rows left to right", () => {
  const map = {
    zones: [{ id: "z", title: "Z", row: 0, order: 0 }],
    items: [
      { id: "a", name: "A", kind: "vm", zone: "z", col: 0, row: 0 },
      { id: "b", name: "B", kind: "vm", zone: "z", col: 1, row: 0 }
    ],
    links: []
  };
  assert.deepEqual(freeCell(map, "z"), { col: 2, row: 0 });
  map.items.push({ id: "c", name: "C", kind: "vm", zone: "z", col: 2, row: 0 });
  assert.deepEqual(freeCell(map, "z"), { col: 0, row: 1 });
});

test("item status comes from live data when linked and from the manual state otherwise", () => {
  const index = inventory();
  const status = (item) => resolveItemStatus({ state: "unknown", ...item }, index);
  assert.equal(status({ state: "online" }).tone, "healthy");
  assert.equal(status({ state: "planned" }).tone, "planned");
  assert.equal(status({ source: { type: "node", name: "alpha" } }).tone, "healthy");
  assert.equal(status({ source: { type: "node", name: "beta" } }).tone, "down");
  assert.equal(status({ source: { type: "guest", vmid: 100 } }).tone, "healthy");
  assert.equal(status({ source: { type: "guest", vmid: 101, environment: "env-a" } }).tone, "stopped");
  assert.equal(status({ source: { type: "guest", vmid: 200 } }).tone, "down", "a guest on an offline node is down");
  assert.equal(status({ source: { type: "guest", vmid: 900 } }).label, "Not found", "templates are not live guests");
  assert.equal(status({ source: { type: "guest", vmid: 100, environment: "other" } }).label, "Not found");
  assert.equal(status({ source: { type: "container", name: "request-portal", server: "srv", environment: "2" } }).tone, "healthy");
  assert.equal(status({ source: { type: "container", name: "/indexer" } }).tone, "degraded");
  assert.equal(status({ source: { type: "service", id: "jellyfin" } }).tone, "degraded");
  assert.equal(status({ source: { type: "service", id: "missing" } }).linked, true);
});

test("inventory seeds produce maps the server accepts", () => {
  const index = inventory();
  const seeded = mapFromInventory(index);
  const canonical = canonicalNetworkMap(seeded);
  assert.equal(canonical.zones.length, 3);
  assert.ok(canonical.items.some((item) => item.source?.type === "guest" && item.source.vmid === 100));
  assert.ok(!canonical.items.some((item) => item.source?.type === "guest" && item.source.vmid === 900), "templates are skipped");
  assert.ok(canonical.items.some((item) => item.source?.type === "container" && item.source.name === "indexer"), "leading slashes are dropped");

  const again = addNodeWithGuests(seeded, index, "env-a:alpha");
  assert.equal(again.added, 0, "adding a node twice does not duplicate its guests");
  canonicalNetworkMap(again.map);

  const groups = discoveredSources(index).map(({ group }) => group);
  assert.deepEqual(groups, ["Proxmox nodes", "Proxmox guests", "Containers", "Services"]);
  assert.ok(NETWORK_LIMITS.items >= canonical.items.length);
});

test("the projector maps the origin to the viewport centre", () => {
  const project = projector({ rx: 40, rz: 15, zoom: 0.6, panX: 0, panY: 0 }, 1000, 600);
  const origin = project(0, 0, 0);
  assert.equal(Math.round(origin.x), 500);
  assert.equal(Math.round(origin.y), 300);
  const top = projector({ rx: 0, rz: 0, zoom: 1, panX: 10, panY: -20 }, 1000, 600)(100, 50, 0);
  assert.equal(Math.round(top.x), 610);
  assert.equal(Math.round(top.y), 330);
});
