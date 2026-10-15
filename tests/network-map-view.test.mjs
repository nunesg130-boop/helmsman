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
  describeImportReport,
  discoveredSources,
  freeCell,
  layoutNetworkMap,
  linkRoute,
  mapFromInventory,
  normalizeImportedMap,
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

test("a clean imported map is kept exactly and reports no changes", () => {
  const map = {
    zones: [{ id: "edge", title: "Edge", row: 0, order: 0 }],
    items: [
      { id: "router", name: "Router", kind: "router", zone: "edge", col: 0, row: 0, address: "10.20.0.1", role: "", notes: "", source: null, state: "online" },
      { id: "switch", name: "Switch", kind: "switch", zone: "edge", col: 1, row: 0, address: "", role: "", notes: "", source: null, state: "unknown" }
    ],
    links: [{ id: "router-switch", from: "router", to: "switch", kind: "wired", label: "" }]
  };
  const { map: imported, report } = normalizeImportedMap(structuredClone(map));
  assert.deepEqual(imported, map);
  assert.deepEqual(report, { skippedZones: 0, skippedItems: 0, skippedLinks: 0, placedItems: 0 });
  assert.equal(describeImportReport(report), "");
  assert.deepEqual(canonicalNetworkMap(imported), canonicalNetworkMap(map));
});

test("imported items without a free cell are placed so the map saves", () => {
  const input = {
    zones: [
      { id: "edge", title: "Edge", row: 0, order: 0 },
      { id: "servers", title: "Servers", row: 1, order: 0 }
    ],
    items: [
      { id: "router", name: "Router", kind: "router", zone: "edge" },
      { id: "switch", name: "Switch", kind: "switch", zone: "edge" },
      { id: "ap", name: "Access point", kind: "access-point", zone: "edge", col: 0, row: 0 },
      { id: "pve", name: "pve", kind: "host", zone: "servers", col: 0, row: 0 },
      { id: "nas", name: "NAS", kind: "storage", zone: "servers", col: 0, row: 0 },
      { id: "far", name: "Far", kind: "device", zone: "servers", col: 99, row: -1 }
    ],
    links: [
      { id: "a", from: "router", to: "switch", kind: "wired" },
      { id: "b", from: "switch", to: "pve", kind: "wired" }
    ]
  };
  const { map, report } = normalizeImportedMap(input);
  assert.equal(map.items.length, 6);
  assert.deepEqual(
    map.items.filter(({ zone }) => zone === "edge").map(({ id, col, row }) => [id, col, row]),
    [["router", 1, 0], ["switch", 2, 0], ["ap", 0, 0]],
    "the item that gave a cell keeps it; the others fill free cells"
  );
  const pve = map.items.find(({ id }) => id === "pve");
  assert.deepEqual([pve.col, pve.row], [0, 0]);
  const cells = new Set(map.items.map(({ zone, col, row }) => `${zone}:${col}:${row}`));
  assert.equal(cells.size, map.items.length);
  assert.equal(report.placedItems, 4);
  assert.equal(report.skippedItems, 0);
  assert.doesNotThrow(() => canonicalNetworkMap(map));
  assert.equal(describeImportReport(report), "4 items moved to a free grid cell.");
});

test("imported entries that cannot be used are skipped and counted", () => {
  const input = {
    zones: [
      { id: "edge", title: "Edge", row: 0, order: 0 },
      { id: "edge", title: "Duplicate", row: 0, order: 1 },
      { id: "Bad Zone", title: "Bad", row: 0, order: 2 }
    ],
    items: [
      { id: "router", name: "Router", kind: "router", zone: "edge", col: 0, row: 0 },
      { id: "router", name: "Again", kind: "router", zone: "edge", col: 1, row: 0 },
      { id: "Bad Id", name: "Bad", kind: "device", zone: "edge", col: 2, row: 0 },
      { id: "lost", name: "Lost", kind: "device", zone: "nowhere", col: 0, row: 0 },
      { id: "switch", name: "Switch", kind: "made-up", zone: "edge", col: 1, row: 0, state: "on fire" },
      null
    ],
    links: [
      { id: "ok", from: "router", to: "switch", kind: "wired" },
      { id: "ok", from: "switch", to: "router", kind: "wifi" },
      { id: "same-pair", from: "switch", to: "router", kind: "wired" },
      { id: "self", from: "router", to: "router", kind: "wired" },
      { id: "missing", from: "router", to: "lost", kind: "wired" },
      { id: "odd-kind", from: "router", to: "switch", kind: "laser" }
    ]
  };
  const { map, report } = normalizeImportedMap(input);
  assert.deepEqual(map.zones.map(({ id }) => id), ["edge"]);
  assert.deepEqual(map.items.map(({ id }) => id), ["router", "switch"]);
  const switchItem = map.items.find(({ id }) => id === "switch");
  assert.equal(switchItem.kind, "other");
  assert.equal(switchItem.state, "unknown");
  assert.deepEqual(map.links.map(({ id }) => id), ["ok"]);
  assert.deepEqual(report, { skippedZones: 2, skippedItems: 4, skippedLinks: 5, placedItems: 0 });
  assert.doesNotThrow(() => canonicalNetworkMap(map));
  assert.equal(describeImportReport(report), "2 zones, 4 items, 5 connections skipped.");
});

test("imports keep at most the map's item limit", () => {
  const items = [];
  for (let row = 0; row < NETWORK_LIMITS.rows; row += 1) {
    for (let col = 0; col < NETWORK_LIMITS.columns; col += 1) {
      items.push({ id: `n-${col}-${row}`, name: "n", kind: "device", zone: "z", col, row });
    }
  }
  items.length = NETWORK_LIMITS.items - 1;
  // One slot is left; two more items arrive without a cell.
  items.push({ id: "extra-1", name: "extra", kind: "device", zone: "z" });
  items.push({ id: "extra-2", name: "extra", kind: "device", zone: "z" });
  const { map, report } = normalizeImportedMap({ zones: [{ id: "z", title: "Z", row: 0, order: 0 }], items, links: [] });
  assert.equal(map.items.length, NETWORK_LIMITS.items);
  assert.equal(report.skippedItems, 1, "the item-count limit applies before placement");
  assert.doesNotThrow(() => canonicalNetworkMap(map));
});
