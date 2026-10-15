// Network page: an interactive 3D model of the owner's network.
//
// The owner arranges zones and items on a grid; Helmsman lays them out,
// draws them as blocks on a floor, and colours each one from live data it
// already has (Proxmox nodes and guests, Portainer containers, configured
// services). Items Helmsman cannot see are added by hand with a manual state.
//
// Everything here works under the shell's Content-Security-Policy: the 3D
// scene is built with DOM calls and positioned through the CSSOM (never
// style attributes), and the panel markup goes through the page's
// trusted-types policy with every value escaped.

export const NETWORK_LIMITS = Object.freeze({
  zones: 40,
  items: 400,
  links: 1_000,
  columns: 24,
  rows: 40,
  zoneRows: 20,
  nameLength: 64,
  addressLength: 120,
  roleLength: 80,
  notesLength: 600,
  labelLength: 80
});

export const ITEM_KINDS = Object.freeze([
  ["internet", "Internet"],
  ["cloud", "Cloud service"],
  ["modem", "Modem"],
  ["router", "Router"],
  ["firewall", "Firewall"],
  ["switch", "Switch"],
  ["access-point", "Access point"],
  ["wireless", "Wireless clients"],
  ["camera", "Camera"],
  ["iot", "IoT device"],
  ["device", "Device"],
  ["laptop", "Laptop or PC"],
  ["server", "Server"],
  ["host", "Proxmox or Docker host"],
  ["vm", "Virtual machine"],
  ["lxc", "LXC container"],
  ["container", "Container"],
  ["service", "Service"],
  ["storage", "Storage"],
  ["other", "Other"]
]);
const KIND_LABELS = new Map(ITEM_KINDS);

export const MANUAL_STATES = Object.freeze([
  ["online", "Online"],
  ["offline", "Offline"],
  ["degraded", "Degraded"],
  ["stopped", "Powered off"],
  ["planned", "Planned"],
  ["retired", "Retired"],
  ["unknown", "Unknown"]
]);

export const LINK_KINDS = Object.freeze([
  ["wired", "Wired"],
  ["wan", "WAN uplink"],
  ["wifi", "Wi-Fi"],
  ["tunnel", "Tunnel"],
  ["flow", "Service flow"]
]);
const LINK_LABELS = new Map(LINK_KINDS);

const TONE_LABELS = Object.freeze({
  healthy: "Healthy",
  limited: "Limited",
  degraded: "Degraded",
  down: "Down",
  stopped: "Stopped",
  planned: "Planned",
  retired: "Retired",
  unknown: "Unknown"
});

const BOXES = Object.freeze({
  plate: { w: 150, d: 52, h: 8 },
  edge: { w: 150, d: 52, h: 18 },
  switch: { w: 178, d: 46, h: 14 },
  ap: { w: 140, d: 50, h: 12 },
  host: { w: 172, d: 60, h: 40 },
  guest: { w: 168, d: 50, h: 14 },
  storage: { w: 150, d: 52, h: 26 },
  device: { w: 140, d: 50, h: 14 }
});
const KIND_BOX = Object.freeze({
  internet: "plate", cloud: "plate", wireless: "plate", laptop: "plate",
  modem: "edge", router: "edge", firewall: "edge",
  switch: "switch", "access-point": "ap",
  host: "host", server: "host",
  vm: "guest", lxc: "guest", container: "guest", service: "guest",
  storage: "storage",
  camera: "device", iot: "device", device: "device", other: "device"
});
const KIND_CATEGORY = Object.freeze({
  internet: "external", cloud: "external",
  modem: "edge", router: "edge", firewall: "edge", switch: "edge", "access-point": "edge", wireless: "edge",
  camera: "edge", iot: "edge", device: "edge", laptop: "edge",
  host: "host", server: "host", storage: "host",
  vm: "guest", lxc: "guest", container: "container", service: "service", other: "edge"
});

// Grid geometry, in world units (CSS px before zoom).
const CELL_W = 200;
const CELL_H = 80;
const ZONE_PAD_X = 26;
const ZONE_PAD_TOP = 40;
const ZONE_PAD_BOTTOM = 22;
const ZONE_GAP = 70;
const ROW_GAP = 80;
const FLOOR_MARGIN = 70;
const PERSPECTIVE = 2000;
const FLOW_RISE = 90;

const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,47}$/u;

// ---------------------------------------------------------------- model --

export function emptyMap() {
  return { zones: [], items: [], links: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function slugId(base, taken) {
  const stem = String(base || "item").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 36) || "item";
  let candidate = /^[a-z0-9]/u.test(stem) ? stem : `n-${stem}`.slice(0, 36);
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${stem.slice(0, 40)}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function takenIds(map) {
  return new Set([...map.zones.map(({ id }) => id), ...map.items.map(({ id }) => id), ...map.links.map(({ id }) => id)]);
}

function zoneGrid(map, zoneId) {
  const items = map.items.filter((item) => item.zone === zoneId);
  const cols = Math.max(1, ...items.map((item) => item.col + 1));
  const rows = Math.max(1, ...items.map((item) => item.row + 1));
  return { items, cols, rows };
}

export function freeCell(map, zoneId, preferredColumns = 3) {
  const occupied = new Set(map.items.filter((item) => item.zone === zoneId).map((item) => `${item.col}:${item.row}`));
  const { cols } = zoneGrid(map, zoneId);
  const width = Math.min(NETWORK_LIMITS.columns, Math.max(preferredColumns, cols));
  for (let row = 0; row < NETWORK_LIMITS.rows; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!occupied.has(`${col}:${row}`)) return { col, row };
    }
  }
  return null;
}

// ---------------------------------------------------------------- layout --

export function boxFor(kind) {
  return BOXES[KIND_BOX[kind] || "device"];
}

/**
 * Lays the map out in world coordinates: zones in rows (by zone.row, then
 * zone.order), each zone a grid of cells, and the whole model centred on the
 * origin. Pure and deterministic.
 */
export function layoutNetworkMap(map) {
  const zones = [...map.zones].sort((left, right) => left.row - right.row || left.order - right.order || left.title.localeCompare(right.title));
  const sized = zones.map((zone) => {
    const grid = zoneGrid(map, zone.id);
    return {
      ...zone,
      cols: grid.cols,
      gridRows: grid.rows,
      w: grid.cols * CELL_W + ZONE_PAD_X * 2,
      h: grid.rows * CELL_H + ZONE_PAD_TOP + ZONE_PAD_BOTTOM
    };
  });
  const rowKeys = [...new Set(sized.map((zone) => zone.row))].sort((left, right) => left - right);
  let cursorY = 0;
  const placedZones = [];
  for (const key of rowKeys) {
    const row = sized.filter((zone) => zone.row === key);
    const width = row.reduce((sum, zone) => sum + zone.w, 0) + ZONE_GAP * (row.length - 1);
    const height = Math.max(...row.map((zone) => zone.h));
    let cursorX = -width / 2;
    for (const zone of row) {
      placedZones.push({ ...zone, x0: cursorX, y0: cursorY });
      cursorX += zone.w + ZONE_GAP;
    }
    cursorY += height + ROW_GAP;
  }
  const totalHeight = Math.max(0, cursorY - ROW_GAP);
  const offsetY = -totalHeight / 2;
  placedZones.forEach((zone) => { zone.y0 += offsetY; });

  const zoneById = new Map(placedZones.map((zone) => [zone.id, zone]));
  const items = map.items.flatMap((item) => {
    const zone = zoneById.get(item.zone);
    if (!zone) return [];
    const box = boxFor(item.kind);
    return [{
      id: item.id,
      zone: zone.id,
      x: zone.x0 + ZONE_PAD_X + (item.col + 0.5) * CELL_W,
      y: zone.y0 + ZONE_PAD_TOP + (item.row + 0.5) * CELL_H,
      zoneTop: zone.y0,
      zoneBottom: zone.y0 + zone.h,
      ...box
    }];
  });
  const bounds = placedZones.length
    ? {
        minX: Math.min(...placedZones.map((zone) => zone.x0)) - FLOOR_MARGIN,
        maxX: Math.max(...placedZones.map((zone) => zone.x0 + zone.w)) + FLOOR_MARGIN,
        minY: Math.min(...placedZones.map((zone) => zone.y0)) - FLOOR_MARGIN,
        maxY: Math.max(...placedZones.map((zone) => zone.y0 + zone.h)) + FLOOR_MARGIN
      }
    : { minX: -400, maxX: 400, minY: -250, maxY: 250 };
  return { zones: placedZones, items, itemById: new Map(items.map((item) => [item.id, item])), bounds };
}

/**
 * Floor route for a link: straight when aligned inside a zone, otherwise an
 * orthogonal path whose horizontal run sits in the open gap between zones,
 * like a cable tray, instead of cutting across other items.
 */
export function linkRoute(from, to) {
  const sameZone = from.zone !== undefined && from.zone === to.zone;
  if (Math.abs(from.x - to.x) < 1 && (sameZone || from.zone === undefined)) return [[from.x, from.y], [to.x, to.y]];
  if (Math.abs(from.y - to.y) < 1 && (sameZone || from.zone === undefined)) return [[from.x, from.y], [to.x, to.y]];
  let runY = (from.y + to.y) / 2;
  if (!sameZone && from.zoneBottom !== undefined && to.zoneBottom !== undefined) {
    if (to.zoneTop >= from.zoneBottom) runY = (from.zoneBottom + to.zoneTop) / 2;
    else if (from.zoneTop >= to.zoneBottom) runY = (to.zoneBottom + from.zoneTop) / 2;
    else runY = Math.max(from.zoneBottom, to.zoneBottom) + ROW_GAP / 2;
  }
  if (Math.abs(from.x - to.x) < 1) return [[from.x, from.y], [from.x, runY], [to.x, to.y]];
  return [[from.x, from.y], [from.x, runY], [to.x, runY], [to.x, to.y]];
}

// ------------------------------------------------------------ live state --

function text(value, maximum = 120) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

export function buildLiveIndex(live = {}) {
  return {
    nodes: Array.isArray(live.nodes) ? live.nodes : [],
    workloads: (Array.isArray(live.workloads) ? live.workloads : []).filter((workload) => !workload.template),
    containers: Array.isArray(live.containers) ? live.containers : [],
    services: Array.isArray(live.services) ? live.services : [],
    environments: Array.isArray(live.environments) ? live.environments : [],
    portainerEnvironments: Array.isArray(live.portainerEnvironments) ? live.portainerEnvironments : []
  };
}

export function findSource(source, index) {
  if (!source) return null;
  if (source.type === "node") {
    return index.nodes.find((node) => node.name === source.name
      && (!source.environment || node.environmentId === source.environment)) || null;
  }
  if (source.type === "guest") {
    return index.workloads.find((workload) => workload.vmid === source.vmid
      && (!source.environment || workload.environmentId === source.environment)) || null;
  }
  if (source.type === "container") {
    return index.containers.find((container) => container.name === source.name
      && (!source.server || container.serverId === source.server)
      && (!source.environment || String(container.environmentId) === source.environment)) || null;
  }
  if (source.type === "service") return index.services.find((service) => service.id === source.id) || null;
  return null;
}

const SERVICE_TONES = Object.freeze({
  healthy: "healthy",
  limited: "limited",
  degraded: "degraded",
  down: "down",
  "authentication-required": "degraded",
  "auth-required": "degraded",
  disabled: "stopped"
});
const MANUAL_TONES = Object.freeze({
  online: "healthy",
  offline: "down",
  degraded: "degraded",
  stopped: "stopped",
  planned: "planned",
  retired: "retired",
  unknown: "unknown"
});

/**
 * Returns { tone, label, detail, live } for an item: live state when the
 * item names a source Helmsman can see, its manual state otherwise.
 */
export function resolveItemStatus(item, index) {
  if (!item.source) {
    const tone = MANUAL_TONES[item.state] || "unknown";
    return { tone, label: TONE_LABELS[tone], detail: "Set by hand", live: null, linked: false };
  }
  const live = findSource(item.source, index);
  if (!live) {
    return { tone: "unknown", label: "Not found", detail: "Not in the latest inventory", live: null, linked: true };
  }
  if (item.source.type === "node") {
    const tone = live.status === "online" ? "healthy" : live.status === "offline" ? "down" : "unknown";
    return { tone, label: TONE_LABELS[tone], detail: `Proxmox node · ${live.status}`, live, linked: true };
  }
  if (item.source.type === "guest") {
    const node = index.nodes.find((entry) => entry.name === live.node && entry.environmentId === live.environmentId);
    if (node?.status === "offline") {
      return { tone: "down", label: "Down", detail: `Node ${live.node} is offline`, live, linked: true };
    }
    const tone = live.status === "running" ? "healthy"
      : live.status === "stopped" ? "stopped"
        : ["paused", "suspended"].includes(live.status) ? "limited" : "unknown";
    const label = tone === "unknown" ? "Unknown" : live.status.charAt(0).toUpperCase() + live.status.slice(1);
    return { tone, label, detail: `${live.kind} ${live.vmid ?? ""} on ${live.node}`.trim(), live, linked: true };
  }
  if (item.source.type === "container") {
    const state = String(live.state || "unknown");
    let tone = "unknown";
    if (state === "running") tone = live.health === "unhealthy" ? "degraded" : "healthy";
    else if (["exited", "created"].includes(state)) tone = "stopped";
    else if (["restarting", "paused"].includes(state)) tone = "limited";
    else if (state === "dead" || state === "removing") tone = "down";
    const label = tone === "degraded" ? "Unhealthy" : state.charAt(0).toUpperCase() + state.slice(1);
    return { tone, label, detail: text(live.status, 120) || state, live, linked: true };
  }
  const tone = SERVICE_TONES[live.state] || "unknown";
  return { tone, label: TONE_LABELS[tone], detail: `Service · ${live.state || "unknown"}`, live, linked: true };
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "";
}

function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function liveFacts(item, status) {
  const live = status.live;
  if (!live) return [];
  const facts = [];
  const add = (key, value) => { if (value) facts.push([key, value]); };
  if (item.source.type === "node") {
    add("Environment", text(live.environmentName, 80));
    add("CPU", percent(live.cpuPercent));
    if (Number.isFinite(live.memoryUsedBytes) && Number.isFinite(live.memoryTotalBytes)) add("Memory", `${bytes(live.memoryUsedBytes)} of ${bytes(live.memoryTotalBytes)}`);
    add("Guests", Number.isFinite(live.workloadCount) ? `${live.runningWorkloadCount || 0} running of ${live.workloadCount}` : "");
    add("Uptime", duration(live.uptimeSeconds));
    add("Version", text(live.version, 80));
  } else if (item.source.type === "guest") {
    add("Node", text(live.node, 64));
    add("VMID", Number.isFinite(live.vmid) ? String(live.vmid) : "");
    add("CPU", percent(live.cpuPercent));
    if (Number.isFinite(live.memoryUsedBytes) && Number.isFinite(live.memoryTotalBytes)) add("Memory", `${bytes(live.memoryUsedBytes)} of ${bytes(live.memoryTotalBytes)}`);
    add("Uptime", duration(live.uptimeSeconds));
    add("Tags", Array.isArray(live.tags) ? live.tags.slice(0, 6).join(", ") : "");
  } else if (item.source.type === "container") {
    add("Environment", text(live.environmentName, 80));
    add("Image", text(live.image, 120));
    add("Status", text(live.status, 120));
    add("Stack", text(live.stack, 96));
    if (Array.isArray(live.ports) && live.ports.length) {
      add("Ports", live.ports.slice(0, 6).map((port) => (port.publicPort ? `${port.publicPort}→${port.privatePort}` : `${port.privatePort}`) + `/${port.protocol}`).join(", "));
    }
  } else if (item.source.type === "service") {
    add("Service", text(live.name, 64));
    add("Connection", text(live.connectionState, 40));
  }
  return facts;
}

/** Everything Helmsman can see that an item could be linked to. */
export function discoveredSources(index) {
  const environmentName = (id) => index.environments.find((environment) => environment.id === id)?.name || "";
  return [
    {
      group: "Proxmox nodes",
      entries: index.nodes.map((node) => ({
        source: { type: "node", name: node.name, environment: node.environmentId },
        label: node.environmentName || environmentName(node.environmentId) ? `${node.name} · ${node.environmentName || environmentName(node.environmentId)}` : node.name,
        name: node.name,
        kind: "host"
      }))
    },
    {
      group: "Proxmox guests",
      entries: [...index.workloads]
        .sort((left, right) => (left.vmid ?? 0) - (right.vmid ?? 0))
        .filter((workload) => Number.isFinite(workload.vmid))
        .map((workload) => ({
          source: { type: "guest", vmid: workload.vmid, environment: workload.environmentId },
          label: `${workload.name} · ${workload.kind} ${workload.vmid} on ${workload.node}`,
          name: workload.name,
          kind: workload.type === "lxc" ? "lxc" : "vm"
        }))
    },
    {
      group: "Containers",
      entries: [...index.containers]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((container) => ({
          source: { type: "container", name: container.name.replace(/^\/+/u, ""), server: container.serverId, environment: String(container.environmentId) },
          label: `${container.name.replace(/^\/+/u, "")} · ${container.environmentName}`,
          name: container.name.replace(/^\/+/u, ""),
          kind: "container"
        }))
    },
    {
      group: "Services",
      entries: index.services.map((service) => ({
        source: { type: "service", id: service.id },
        label: service.name || service.id,
        name: service.name || service.id,
        kind: "service"
      }))
    }
  ].filter((group) => group.entries.length);
}

export function sourceKey(source) {
  if (!source) return "";
  if (source.type === "node") return `node|${source.environment || ""}|${source.name}`;
  if (source.type === "guest") return `guest|${source.environment || ""}|${source.vmid}`;
  if (source.type === "container") return `container|${source.server || ""}|${source.environment || ""}|${source.name}`;
  if (source.type === "service") return `service|${source.id}`;
  return "";
}

/** True when two source references point at the same live object. */
function sameSource(left, right) {
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "guest") return left.vmid === right.vmid && (!left.environment || !right.environment || left.environment === right.environment);
  if (left.type === "node") return left.name === right.name && (!left.environment || !right.environment || left.environment === right.environment);
  if (left.type === "container") {
    return left.name === right.name
      && (!left.server || !right.server || left.server === right.server)
      && (!left.environment || !right.environment || left.environment === right.environment);
  }
  return left.id === right.id;
}

// ------------------------------------------------------- inventory seeds --

/** Adds a zone for a Proxmox node with the node and each of its guests. */
export function addNodeWithGuests(map, index, nodeId) {
  const node = index.nodes.find((entry) => entry.id === nodeId);
  if (!node) return { map, added: 0 };
  const next = clone(map);
  const taken = takenIds(next);
  const zoneId = slugId(node.name, taken);
  taken.add(zoneId);
  next.zones.push({ id: zoneId, title: node.name, row: nextZoneRow(next), order: 0 });
  let added = 0;
  const placed = next.items.map((item) => item.source).filter(Boolean);
  const nodeSource = { type: "node", name: node.name, environment: node.environmentId };
  if (!placed.some((source) => sameSource(source, nodeSource))) {
    const id = slugId(node.name, taken);
    taken.add(id);
    next.items.push({ id, name: node.name, kind: "host", zone: zoneId, col: 1, row: 0, address: "", role: "Proxmox node", notes: "", source: nodeSource, state: "unknown" });
    added += 1;
  }
  const guests = index.workloads
    .filter((workload) => workload.node === node.name && workload.environmentId === node.environmentId && Number.isFinite(workload.vmid))
    .sort((left, right) => left.vmid - right.vmid);
  let slot = 0;
  for (const workload of guests) {
    const source = { type: "guest", vmid: workload.vmid, environment: workload.environmentId };
    if (placed.some((entry) => sameSource(entry, source))) continue;
    if (next.items.length >= NETWORK_LIMITS.items) break;
    const id = slugId(workload.name, taken);
    taken.add(id);
    next.items.push({
      id,
      name: workload.name.slice(0, NETWORK_LIMITS.nameLength),
      kind: workload.type === "lxc" ? "lxc" : "vm",
      zone: zoneId,
      col: slot % 3,
      row: 1 + Math.floor(slot / 3),
      address: "",
      role: `${workload.kind} ${workload.vmid}`,
      notes: "",
      source,
      state: "unknown"
    });
    slot += 1;
    added += 1;
  }
  return { map: next, added };
}

/** Adds a zone for one Portainer environment with each of its containers. */
export function addPortainerEnvironment(map, index, key) {
  const environment = index.portainerEnvironments.find((entry) => `${entry.serverId}:${entry.id}` === key);
  if (!environment) return { map, added: 0 };
  const next = clone(map);
  const taken = takenIds(next);
  const zoneId = slugId(environment.name, taken);
  taken.add(zoneId);
  next.zones.push({ id: zoneId, title: environment.name.slice(0, NETWORK_LIMITS.nameLength), row: nextZoneRow(next), order: 0 });
  const placed = next.items.map((item) => item.source).filter(Boolean);
  let slot = 0;
  for (const container of index.containers.filter((entry) => entry.serverId === environment.serverId && entry.environmentId === environment.id)
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const name = container.name.replace(/^\/+/u, "");
    const source = { type: "container", name, server: container.serverId, environment: String(container.environmentId) };
    if (placed.some((entry) => sameSource(entry, source))) continue;
    if (next.items.length >= NETWORK_LIMITS.items) break;
    const id = slugId(name, taken);
    taken.add(id);
    next.items.push({ id, name: name.slice(0, NETWORK_LIMITS.nameLength), kind: "container", zone: zoneId, col: slot % 3, row: Math.floor(slot / 3), address: "", role: container.stack ? `Stack ${container.stack}`.slice(0, NETWORK_LIMITS.roleLength) : "", notes: "", source, state: "unknown" });
    slot += 1;
  }
  return { map: next, added: slot };
}

function nextZoneRow(map) {
  return Math.min(NETWORK_LIMITS.zoneRows - 1, map.zones.length ? Math.max(...map.zones.map((zone) => zone.row)) + 1 : 0);
}

/** Builds a first map from everything Helmsman can see. */
export function mapFromInventory(index) {
  let map = emptyMap();
  for (const node of index.nodes) map = addNodeWithGuests(map, index, node.id).map;
  const rowCount = map.zones.length;
  map.zones.forEach((zone, position) => { zone.row = 1; zone.order = position; });
  for (const environment of index.portainerEnvironments) {
    map = addPortainerEnvironment(map, index, `${environment.serverId}:${environment.id}`).map;
  }
  map.zones.slice(rowCount).forEach((zone, position) => { zone.row = 2; zone.order = position; });
  return map;
}

// ------------------------------------------------------------ projection --

export function projector(camera, width, height) {
  const rz = camera.rz * Math.PI / 180;
  const rx = camera.rx * Math.PI / 180;
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  return (x, y, z) => {
    const x1 = x * cz - y * sz;
    const y1 = x * sz + y * cz;
    const y2 = y1 * cx - z * sx;
    const z2 = y1 * sx + z * cx;
    const X = x1 * camera.zoom;
    const Y = y2 * camera.zoom;
    const Z = z2 * camera.zoom;
    const f = PERSPECTIVE / Math.max(1, PERSPECTIVE - Z);
    return { x: width / 2 + (camera.panX + X) * f, y: height / 2 + (camera.panY + Y) * f, z: Z, X, Y };
  };
}

function segmentTransform(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const horizontal = Math.hypot(dx, dy);
  const length = Math.hypot(horizontal, dz);
  const azimuth = Math.atan2(dy, dx) * 180 / Math.PI;
  const elevation = Math.atan2(dz, horizontal) * 180 / Math.PI;
  return {
    length,
    transform: `translate3d(${a[0].toFixed(1)}px, ${a[1].toFixed(1)}px, ${a[2].toFixed(1)}px) rotateZ(${azimuth.toFixed(2)}deg) rotateY(${(-elevation).toFixed(2)}deg)`
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// ------------------------------------------------------------ controller --

/**
 * Creates the Network page controller. `deps` supplies the page's escaping,
 * rendering and API plumbing so this module has no globals of its own:
 *   setMarkup(element, markup), escapeHtml(value), icon(name),
 *   loadMap() → { map, revision, updatedAt }, saveMap(map, revision),
 *   live() → raw inventory, toast(message, tone)
 */
export function createNetworkMapController(deps) {
  const escape = deps.escapeHtml;
  const icon = deps.icon;
  const doc = () => globalThis.document;
  const state = {
    loaded: false,
    loading: false,
    loadError: "",
    saved: emptyMap(),
    revision: null,
    updatedAt: null,
    draft: null,
    editing: false,
    saving: false,
    selected: null,
    selectedZone: null,
    showAllFlows: false,
    camera: { rx: 40, rz: 0, zoom: 0.6, panX: 0, panY: 0 },
    cameraTouched: false,
    view: "angled",
    panelHidden: false,
    panelMode: "",
    exportText: "",
    importError: ""
  };
  let root = null;
  let elements = null;
  let index = buildLiveIndex();
  let layout = layoutNetworkMap(emptyMap());
  let statuses = new Map();
  let labels = [];
  let zoneTitles = [];
  let size = { width: 800, height: 520 };
  let resizeObserver = null;
  let animation = 0;
  const pointers = new Map();
  let drag = null;
  let moved = false;
  let hovered = null;

  const currentMap = () => state.draft || state.saved;
  const dirty = () => Boolean(state.draft) && JSON.stringify(state.draft) !== JSON.stringify(state.saved);

  function refreshIndex() {
    try {
      index = buildLiveIndex(deps.live());
    } catch {
      index = buildLiveIndex();
    }
    statuses = new Map(currentMap().items.map((item) => [item.id, resolveItemStatus(item, index)]));
  }

  // -------------------------------------------------------------- shell --

  function shellMarkup() {
    return `
      <section class="page-intro network-intro">
        <div><span class="section-kicker" data-net-kicker>Network model</span><h2>Network</h2><p>Your network in 3D, coloured from live Proxmox, Portainer and service data. Items Helmsman cannot reach are added by hand.</p></div>
        <div class="network-intro__actions" data-net-actions></div>
      </section>
      <div class="network-layout">
        <div class="network-viewport" data-net-viewport>
          <div class="network-scene" data-net-scene><div class="network-stage" data-net-stage></div></div>
          <div class="network-overlay" data-net-overlay></div>
          <div class="network-toolbar" data-net-toolbar></div>
          <div class="network-legend" aria-hidden="true">
            <span class="network-legend__item"><i class="network-legend__wired"></i>Wired</span>
            <span class="network-legend__item"><i class="network-legend__wifi"></i>Wi-Fi</span>
            <span class="network-legend__item"><i class="network-legend__flow"></i>Service flow</span>
            <span class="network-legend__item"><i class="network-legend__down"></i>Down</span>
            <span class="network-legend__item"><i class="network-legend__off"></i>Stopped or planned</span>
            <span class="network-legend__hint">Drag to rotate · Shift-drag to pan · Scroll or pinch to zoom</span>
          </div>
          <div class="network-empty" data-net-empty hidden></div>
        </div>
        <aside class="network-panel" data-net-panel aria-label="Network details"></aside>
      </div>`;
  }

  function mount(element) {
    if (!element) return;
    if (root === element && elements) {
      refresh();
      return;
    }
    unmount();
    root = element;
    deps.setMarkup(root, shellMarkup());
    elements = {
      kicker: root.querySelector("[data-net-kicker]"),
      actions: root.querySelector("[data-net-actions]"),
      viewport: root.querySelector("[data-net-viewport]"),
      scene: root.querySelector("[data-net-scene]"),
      stage: root.querySelector("[data-net-stage]"),
      overlay: root.querySelector("[data-net-overlay]"),
      toolbar: root.querySelector("[data-net-toolbar]"),
      empty: root.querySelector("[data-net-empty]"),
      panel: root.querySelector("[data-net-panel]")
    };
    if (!elements.viewport || !elements.stage) {
      elements = null;
      return;
    }
    bindEvents();
    measure();
    if (typeof globalThis.ResizeObserver === "function") {
      resizeObserver = new globalThis.ResizeObserver(() => {
        measure();
        applyCamera();
      });
      resizeObserver.observe(elements.viewport);
    }
    if (!state.loaded && !state.loading) load();
    refresh({ fit: !state.cameraTouched });
  }

  function unmount() {
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    globalThis.cancelAnimationFrame?.(animation);
    pointers.clear();
    drag = null;
    root = null;
    elements = null;
  }

  function isMountedOn(element) {
    return Boolean(element) && element === root && Boolean(elements);
  }

  function measure() {
    if (!elements?.viewport?.getBoundingClientRect) return;
    const rect = elements.viewport.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) size = { width: rect.width, height: rect.height };
  }

  async function load() {
    state.loading = true;
    state.loadError = "";
    renderChrome();
    try {
      const payload = await deps.loadMap();
      state.saved = payload?.map && Array.isArray(payload.map.items) ? payload.map : emptyMap();
      state.revision = payload?.revision ?? null;
      state.updatedAt = payload?.updatedAt ?? null;
      state.loaded = true;
    } catch (error) {
      state.loadError = error?.code === "NETWORK_MAP_UNAVAILABLE"
        ? "The network map is unavailable because Helmsman could not open its data volume file."
        : "The network map could not be loaded. Check the Helmsman server and refresh.";
    } finally {
      state.loading = false;
    }
    if (root) refresh({ fit: !state.cameraTouched });
  }

  /** Re-reads live data and repaints everything. */
  function refresh({ fit = false } = {}) {
    if (!elements) return;
    refreshIndex();
    layout = layoutNetworkMap(currentMap());
    if (fit) fitCamera(false);
    renderChrome();
    renderScene();
    renderPanel();
  }

  /** Called on every monitor poll: recolour without disturbing the panel. */
  function refreshLive() {
    if (!elements) return;
    const before = JSON.stringify([...statuses.values()].map(({ tone, label, detail }) => [tone, label, detail]));
    refreshIndex();
    const after = JSON.stringify([...statuses.values()].map(({ tone, label, detail }) => [tone, label, detail]));
    if (before === after) return;
    renderChrome();
    renderScene();
    const active = doc()?.activeElement;
    if (!elements.panel.contains(active) || !state.editing) renderPanel();
  }

  // ------------------------------------------------------------- chrome --

  function counts() {
    const map = currentMap();
    const values = map.items.map((item) => statuses.get(item.id) || resolveItemStatus(item, index));
    return {
      items: map.items.length,
      linked: values.filter((status) => status.linked).length,
      healthy: values.filter((status) => status.tone === "healthy").length,
      down: values.filter((status) => status.tone === "down").length,
      attention: values.filter((status) => ["degraded", "limited"].includes(status.tone)).length,
      missing: values.filter((status) => status.linked && !status.live).length
    };
  }

  function renderChrome() {
    if (!elements) return;
    const summary = counts();
    elements.kicker.textContent = state.editing
      ? dirty() ? "Editing · unsaved changes" : "Editing"
      : summary.items
        ? `${summary.items} item${summary.items === 1 ? "" : "s"} · ${summary.linked} linked`
        : "Network model";
    const actions = state.editing
      ? `<button class="button" type="button" data-net-action="discard"${state.saving ? " disabled" : ""}>${dirty() ? "Discard" : "Done"}</button>
         <button class="button button--primary" type="button" data-net-action="save"${!dirty() || state.saving ? " disabled" : ""}>${icon("check")} ${state.saving ? "Saving" : "Save map"}</button>`
      : `<button class="button" type="button" data-net-action="edit"${state.loaded ? "" : " disabled"}>${icon("edit")} Edit map</button>`;
    deps.setMarkup(elements.actions, actions);

    const viewButton = (key, label) => `<button class="network-tool${state.view === key ? " is-on" : ""}" type="button" data-net-action="view" data-net-view="${key}" aria-pressed="${state.view === key}">${label}</button>`;
    deps.setMarkup(elements.toolbar, `
      <div class="network-toolgroup" role="group" aria-label="View">${viewButton("angled", "Angled")}${viewButton("top", "Top down")}</div>
      <div class="network-toolgroup" role="group" aria-label="Camera">
        <button class="network-tool network-tool--icon" type="button" data-net-action="rotate" data-net-step="-30" aria-label="Rotate left"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg></button>
        <button class="network-tool network-tool--icon" type="button" data-net-action="rotate" data-net-step="30" aria-label="Rotate right"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 4v5h-5"></path></svg></button>
        <button class="network-tool network-tool--icon" type="button" data-net-action="zoom" data-net-step="out" aria-label="Zoom out"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path></svg></button>
        <button class="network-tool network-tool--icon" type="button" data-net-action="zoom" data-net-step="in" aria-label="Zoom in"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg></button>
        <button class="network-tool" type="button" data-net-action="fit">Fit</button>
      </div>
      <div class="network-toolgroup" role="group" aria-label="Layers"><button class="network-tool${state.showAllFlows ? " is-on" : ""}" type="button" data-net-action="flows" aria-pressed="${state.showAllFlows}"><span class="network-tool__switch"></span>All service flows</button><button class="network-tool network-tool--panel${state.panelHidden ? "" : " is-on"}" type="button" data-net-action="panel" aria-pressed="${!state.panelHidden}"><span class="network-tool__switch"></span>Details panel</button></div>`);
    root.classList.toggle("is-panel-hidden", state.panelHidden && !state.editing);

    const map = currentMap();
    let empty = "";
    if (state.loadError) {
      empty = `<div class="network-empty__card">${icon("server")}<h3>Network map unavailable</h3><p>${escape(state.loadError)}</p><button class="button" type="button" data-net-action="reload">${icon("refresh")} Try again</button></div>`;
    } else if (!state.loaded) {
      empty = `<div class="network-empty__card">${icon("server")}<h3>Loading the network map</h3></div>`;
    } else if (!map.items.length && !map.zones.length) {
      const discovered = index.nodes.length + index.portainerEnvironments.length;
      empty = `<div class="network-empty__card">${icon("server")}<h3>Map your network</h3>
        <p>Start from what Helmsman already sees${discovered ? ` (${index.nodes.length} Proxmox node${index.nodes.length === 1 ? "" : "s"}, ${index.portainerEnvironments.length} Portainer environment${index.portainerEnvironments.length === 1 ? "" : "s"})` : ""}, then add your router, switch, access points and anything else by hand. The map is stored privately in <code>network-map.json</code> in the data volume.</p>
        <div class="button-row">${discovered ? `<button class="button button--primary" type="button" data-net-action="seed">${icon("plus")} Build from inventory</button>` : ""}<button class="button" type="button" data-net-action="start-empty">${icon("edit")} Start editing</button><button class="button" type="button" data-net-action="open-import">Import JSON</button></div></div>`;
    }
    elements.empty.hidden = !empty;
    if (empty) deps.setMarkup(elements.empty, empty);
    else deps.setMarkup(elements.empty, "");
  }

  // -------------------------------------------------------------- scene --

  function relatedIds() {
    const map = currentMap();
    if (!state.selected) return null;
    const related = new Set([state.selected]);
    for (const link of map.links) {
      if (link.from === state.selected) related.add(link.to);
      if (link.to === state.selected) related.add(link.from);
    }
    return related;
  }

  function createDiv(className) {
    const element = doc().createElement("div");
    element.className = className;
    return element;
  }

  function renderScene() {
    if (!elements) return;
    const stage = elements.stage;
    const map = currentMap();
    const related = relatedIds();
    const itemById = new Map(map.items.map((item) => [item.id, item]));
    const fragment = doc().createDocumentFragment();
    const { bounds } = layout;

    const floor = createDiv("network-floor");
    const floorW = bounds.maxX - bounds.minX;
    const floorH = bounds.maxY - bounds.minY;
    floor.style.width = `${floorW}px`;
    floor.style.height = `${floorH}px`;
    floor.style.transform = `translate3d(${bounds.minX}px, ${bounds.minY}px, 0px)`;
    fragment.append(floor);

    for (const zone of layout.zones) {
      const plate = createDiv(`network-zone${state.editing && state.selectedZone === zone.id ? " is-selected" : ""}`);
      plate.style.width = `${zone.w}px`;
      plate.style.height = `${zone.h}px`;
      plate.style.transform = `translate3d(${zone.x0}px, ${zone.y0}px, 1px)`;
      fragment.append(plate);
    }

    const addLine = (a, b, className, live, delay) => {
      const geometry = segmentTransform(a, b);
      const line = createDiv(`network-line ${className}`);
      line.style.width = `${geometry.length.toFixed(1)}px`;
      line.style.transform = geometry.transform;
      if (live) {
        const packet = doc().createElement("span");
        packet.className = "network-packet";
        packet.style.animationDelay = `${delay.toFixed(2)}s`;
        line.append(packet);
      }
      fragment.append(line);
    };

    map.links.forEach((link, position) => {
      const from = layout.itemById.get(link.from);
      const to = layout.itemById.get(link.to);
      if (!from || !to) return;
      const fromStatus = statuses.get(link.from);
      const toStatus = statuses.get(link.to);
      const touches = state.selected && (link.from === state.selected || link.to === state.selected);
      const dim = related && !touches;
      const tones = [fromStatus?.tone, toStatus?.tone];
      const isDown = tones.includes("down");
      const isOff = tones.some((tone) => ["stopped", "planned", "retired"].includes(tone));
      const delay = (position * 0.43) % 3;
      if (["flow", "tunnel"].includes(link.kind)) {
        if (!state.showAllFlows && !touches) return;
        const a = [from.x, from.y, from.h + 2];
        const b = [to.x, to.y, to.h + 2];
        const peak = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.max(a[2], b[2]) + FLOW_RISE];
        const kind = isDown || isOff ? "is-flow-off" : link.kind === "tunnel" ? "is-tunnel" : "is-flow";
        const classes = `${kind}${touches ? " is-hot" : ""}${dim ? " is-dim" : ""}`;
        addLine(a, peak, classes, !isDown && !isOff, delay);
        addLine(peak, b, classes, !isDown && !isOff, delay + 0.4);
        return;
      }
      const route = linkRoute(from, to);
      const kind = isDown ? "is-down" : isOff ? "is-off" : `is-${link.kind}`;
      const classes = `${kind}${touches ? " is-hot" : ""}${dim ? " is-dim" : ""}`;
      for (let step = 0; step < route.length - 1; step += 1) {
        addLine([route[step][0], route[step][1], 1], [route[step + 1][0], route[step + 1][1], 1], classes,
          !isDown && !isOff && step === route.length - 2, delay);
      }
    });

    for (const geometry of layout.items) {
      const item = itemById.get(geometry.id);
      const status = statuses.get(geometry.id) || resolveItemStatus(item, index);
      const selected = state.selected === item.id;
      const dim = related && !related.has(item.id);
      const node = createDiv(`network-node tone-${status.tone} cat-${KIND_CATEGORY[item.kind] || "edge"}${selected ? " is-selected" : ""}${dim ? " is-dim" : ""}`);
      node.style.transform = `translate3d(${geometry.x}px, ${geometry.y}px, 0px)`;
      const { w, d, h } = geometry;
      const faces = [
        ["network-face network-face--back", w, h, `translateY(${-d / 2}px) translateZ(${h / 2}px) rotateX(90deg)`],
        ["network-face network-face--left", h, d, `translateX(${-w / 2}px) translateZ(${h / 2}px) rotateY(-90deg)`],
        ["network-face network-face--right", h, d, `translateX(${w / 2}px) translateZ(${h / 2}px) rotateY(90deg)`],
        ["network-face network-face--front", w, h, `translateY(${d / 2}px) translateZ(${h / 2}px) rotateX(-90deg)`]
      ];
      for (const [className, width, height, transform] of faces) {
        const face = createDiv(className);
        face.style.width = `${width}px`;
        face.style.height = `${height}px`;
        face.style.margin = `${-height / 2}px 0 0 ${-width / 2}px`;
        face.style.transform = transform;
        node.append(face);
      }
      const top = doc().createElement("button");
      top.type = "button";
      top.className = "network-face network-face--top";
      top.dataset.netSelect = item.id;
      top.setAttribute("aria-label", `${item.name}${item.address ? `, ${item.address}` : ""}, ${status.label}`);
      top.setAttribute("aria-pressed", selected ? "true" : "false");
      top.style.width = `${w}px`;
      top.style.height = `${d}px`;
      top.style.margin = `${-d / 2}px 0 0 ${-w / 2}px`;
      top.style.transform = `translateZ(${h}px)`;
      node.append(top);
      fragment.append(node);
    }

    stage.replaceChildren(fragment);
    renderOverlay(related);
    applyCamera();
  }

  function renderOverlay(related = relatedIds()) {
    if (!elements) return;
    const map = currentMap();
    const itemById = new Map(map.items.map((item) => [item.id, item]));
    const fragment = doc().createDocumentFragment();
    zoneTitles = layout.zones.map((zone) => {
      const element = state.editing ? doc().createElement("button") : createDiv("");
      element.className = `network-zone-title${state.editing ? " is-editable" : ""}${state.selectedZone === zone.id ? " is-selected" : ""}`;
      if (state.editing) {
        element.type = "button";
        element.dataset.netZone = zone.id;
        element.setAttribute("aria-label", `Edit zone ${zone.title}`);
      } else element.setAttribute("aria-hidden", "true");
      element.textContent = zone.title;
      fragment.append(element);
      return { element, x: zone.x0 + 6, y: zone.y0 - 18 };
    });
    labels = layout.items.map((geometry) => {
      const item = itemById.get(geometry.id);
      const status = statuses.get(geometry.id) || resolveItemStatus(item, index);
      const category = KIND_CATEGORY[item.kind] || "edge";
      const size = item.kind === "host" ? " is-large" : ["guest", "container", "service"].includes(category) ? " is-small" : "";
      const label = createDiv(`network-label tone-${status.tone}${size}${state.selected === item.id ? " is-selected" : ""}${related && !related.has(item.id) ? " is-dim" : ""}`);
      label.setAttribute("aria-hidden", "true");
      const name = doc().createElement("span");
      name.className = "network-label__name";
      const dot = doc().createElement("i");
      const nameText = doc().createElement("span");
      nameText.textContent = item.name;
      name.append(dot, nameText);
      label.append(name);
      const sub = item.address || (status.linked && !status.live ? status.label : "");
      if (sub) {
        const address = doc().createElement("span");
        address.className = "network-label__address";
        address.textContent = sub;
        label.append(address);
      }
      fragment.append(label);
      return { element: label, id: item.id, guest: size === " is-small", x: geometry.x, y: geometry.y, z: geometry.h };
    });
    elements.overlay.replaceChildren(fragment);
  }

  function applyCamera() {
    if (!elements) return;
    const camera = state.camera;
    elements.stage.style.transform = `translate(${camera.panX.toFixed(1)}px, ${camera.panY.toFixed(1)}px) scale3d(${camera.zoom}, ${camera.zoom}, ${camera.zoom}) rotateX(${camera.rx.toFixed(2)}deg) rotateZ(${camera.rz.toFixed(2)}deg)`;
    const project = projector(camera, size.width, size.height);
    // Level of detail: labels never grow wider than a grid cell on screen, and
    // guest labels thin out as the model gets smaller so names never pile up.
    const cell = CELL_W * camera.zoom;
    const level = cell >= 150 ? "full" : cell >= 112 ? "compact" : cell >= 84 ? "names" : "minimal";
    if (elements.overlay.dataset.lod !== level) elements.overlay.dataset.lod = level;
    elements.overlay.style.setProperty("--network-cell", `${Math.max(56, Math.round(cell - 10))}px`);
    const related = relatedIds();
    for (const label of labels) {
      label.element.classList.toggle("is-forced", label.id === hovered || Boolean(related?.has(label.id)));
    }
    const depth = [];
    for (const label of labels) {
      const point = project(label.x, label.y, label.z);
      label.element.style.left = `${point.x.toFixed(1)}px`;
      label.element.style.top = `${point.y.toFixed(1)}px`;
      depth.push([point.z, label.element]);
    }
    depth.sort((left, right) => left[0] - right[0]).forEach(([, element], order) => { element.style.zIndex = String(order + 1); });
    for (const title of zoneTitles) {
      const point = project(title.x, title.y, 2);
      title.element.style.left = `${point.x.toFixed(1)}px`;
      title.element.style.top = `${point.y.toFixed(1)}px`;
    }
  }

  function fitCamera(animate = true) {
    const { bounds } = layout;
    const rx = state.view === "top" ? 0 : 40;
    const base = { rx, rz: 0, zoom: 1, panX: 0, panY: 0 };
    const project = projector(base, 0, 0);
    const corners = [
      project(bounds.minX, bounds.minY, 0), project(bounds.maxX, bounds.minY, 0),
      project(bounds.minX, bounds.maxY, 0), project(bounds.maxX, bounds.maxY, 0)
    ];
    const spanX = Math.max(...corners.map((point) => point.X)) - Math.min(...corners.map((point) => point.X));
    const spanY = Math.max(...corners.map((point) => point.Y)) - Math.min(...corners.map((point) => point.Y));
    // On a phone the whole model would be too small to read, so the fit stops
    // at a readable scale and the owner pans or pinches from the centre.
    const minimum = size.width < 600 ? 0.3 : 0.18;
    const zoom = clamp(Math.min((size.width - 40) / Math.max(1, spanX), (size.height - 120) / Math.max(1, spanY)) * 0.96, minimum, 1.6);
    const centred = projector({ ...base, zoom }, 0, 0)((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0);
    const target = { rx, rz: 0, zoom, panX: -centred.X, panY: -centred.Y + 16 };
    if (animate) tween(target);
    else {
      state.camera = target;
      applyCamera();
    }
  }

  function tween(target) {
    globalThis.cancelAnimationFrame?.(animation);
    if (typeof globalThis.requestAnimationFrame !== "function") {
      state.camera = { ...state.camera, ...target };
      applyCamera();
      return;
    }
    const from = { ...state.camera };
    if ("rz" in target) target.rz = from.rz + ((((target.rz - from.rz) % 360) + 540) % 360 - 180);
    const started = globalThis.performance?.now?.() ?? Date.now();
    const step = (now) => {
      const progress = Math.min(1, (now - started) / 450);
      const eased = 1 - (1 - progress) ** 3;
      const next = { ...state.camera };
      for (const key of Object.keys(target)) next[key] = from[key] + (target[key] - from[key]) * eased;
      state.camera = next;
      applyCamera();
      if (progress < 1) animation = globalThis.requestAnimationFrame(step);
    };
    animation = globalThis.requestAnimationFrame(step);
  }

  // -------------------------------------------------------------- panel --

  function statusPill(status) {
    return `<span class="network-pill tone-${status.tone}"><i></i>${escape(status.label)}</span>`;
  }

  function factsTable(rows) {
    if (!rows.length) return "";
    return `<dl class="network-facts">${rows.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>`;
  }

  function connectionsFor(itemId) {
    const map = currentMap();
    const itemById = new Map(map.items.map((item) => [item.id, item]));
    return map.links.filter((link) => link.from === itemId || link.to === itemId).map((link) => {
      const otherId = link.from === itemId ? link.to : link.from;
      return { link, other: itemById.get(otherId) };
    }).filter(({ other }) => other);
  }

  function itemListMarkup() {
    const map = currentMap();
    const zones = [...layout.zones];
    const groups = zones.map((zone) => {
      const items = map.items.filter((item) => item.zone === zone.id).sort((left, right) => left.row - right.row || left.col - right.col);
      if (!items.length) return "";
      return `<div class="network-list__group"><span class="section-kicker">${escape(zone.title)}</span>${items.map((item) => {
        const status = statuses.get(item.id) || resolveItemStatus(item, index);
        return `<button class="network-list__item${state.selected === item.id ? " is-selected" : ""}" type="button" data-net-select="${escape(item.id)}"><i class="network-dot tone-${status.tone}"></i><span>${escape(item.name)}</span><small>${escape(item.address || status.label)}</small></button>`;
      }).join("")}</div>`;
    }).join("");
    return groups ? `<div class="network-list">${groups}</div>` : "";
  }

  function viewPanelMarkup() {
    const map = currentMap();
    const item = map.items.find((entry) => entry.id === state.selected);
    if (!item) {
      const summary = counts();
      return `<section class="network-panel__section">
          <span class="section-kicker">Overview</span>
          <h3>${summary.items ? "Select a device" : "No items yet"}</h3>
          <p>${summary.items ? "Click any block in the model, or any row below, to see its address, live state and connections. Everything else fades so its connections stand out." : "Choose Edit map to add items, or build a first map from your Proxmox and Portainer inventory."}</p>
          ${summary.items ? factsTable([
            ["Items", String(summary.items)],
            ["Live-linked", String(summary.linked)],
            ["Healthy", String(summary.healthy)],
            ["Needs attention", String(summary.attention)],
            ["Down", String(summary.down)],
            ...(summary.missing ? [["Not found", String(summary.missing)]] : [])
          ]) : ""}
        </section>${itemListMarkup()}`;
    }
    const status = statuses.get(item.id) || resolveItemStatus(item, index);
    const zone = map.zones.find((entry) => entry.id === item.zone);
    const connections = connectionsFor(item.id);
    const openLink = item.source?.type === "guest" || item.source?.type === "node"
      ? `<a class="button" href="#/workloads">${icon("server")} Open Workloads</a>`
      : item.source?.type === "container" ? `<a class="button" href="#/portainer">${icon("containers")} Open Portainer</a>` : "";
    return `<section class="network-panel__section">
        <div class="network-panel__heading"><span class="section-kicker">${escape(KIND_LABELS.get(item.kind) || "Item")}${zone ? ` · ${escape(zone.title)}` : ""}</span><button class="button button--small" type="button" data-net-action="clear-selection">Clear</button></div>
        <h3>${escape(item.name)}</h3>
        <div class="network-panel__meta">${item.address ? `<span class="network-mono">${escape(item.address)}</span>` : ""}${statusPill(status)}</div>
        ${item.role ? `<p>${escape(item.role)}</p>` : ""}
        ${item.notes ? `<p class="network-notes">${escape(item.notes)}</p>` : ""}
        ${factsTable([["State", status.detail], ...liveFacts(item, status)])}
        ${connections.length ? `<div class="network-panel__group"><span class="section-kicker">Connected to</span>${connections.map(({ link, other }) => {
          const otherStatus = statuses.get(other.id) || resolveItemStatus(other, index);
          return `<button class="network-list__item" type="button" data-net-select="${escape(other.id)}"><i class="network-dot tone-${otherStatus.tone}"></i><span>${escape(other.name)}<small>${escape(link.label || LINK_LABELS.get(link.kind) || "")}</small></span><small>${escape(other.address)}</small></button>`;
        }).join("")}</div>` : ""}
        <div class="button-row">${openLink}<button class="button" type="button" data-net-action="centre">Center in view</button></div>
      </section>${itemListMarkup()}`;
  }

  function options(pairs, selected) {
    return pairs.map(([value, label]) => `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(label)}</option>`).join("");
  }

  function sourceOptions(item) {
    const current = sourceKey(item?.source);
    const placed = new Set(currentMap().items.filter((entry) => entry !== item && entry.source).map((entry) => sourceKey(entry.source)));
    const groups = discoveredSources(index);
    let found = !current;
    const markup = groups.map((group) => `<optgroup label="${escape(group.group)}">${group.entries.map((entry) => {
      const key = sourceKey(entry.source);
      const selected = item?.source && sameSource(item.source, entry.source);
      if (selected) found = true;
      return `<option value="${escape(key)}"${selected ? " selected" : ""}>${escape(entry.label)}${placed.has(key) ? " (on map)" : ""}</option>`;
    }).join("")}</optgroup>`).join("");
    const stale = !found ? `<option value="${escape(current)}" selected>Saved link (not in current inventory)</option>` : "";
    return `<option value=""${!current ? " selected" : ""}>None · state set by hand</option>${stale}${markup}`;
  }

  function editItemMarkup(item) {
    const map = currentMap();
    const status = statuses.get(item.id) || resolveItemStatus(item, index);
    const connections = connectionsFor(item.id);
    const others = map.items.filter((entry) => entry.id !== item.id).sort((left, right) => left.name.localeCompare(right.name));
    return `<section class="network-panel__section network-editor">
      <div class="network-panel__heading"><span class="section-kicker">Edit item</span><button class="button button--small" type="button" data-net-action="clear-selection">Close</button></div>
      <label class="network-field"><span>Name</span><input type="text" data-net-field="name" maxlength="${NETWORK_LIMITS.nameLength}" value="${escape(item.name)}" autocomplete="off" required /></label>
      <label class="network-field"><span>Live source</span><select data-net-field="source">${sourceOptions(item)}</select><small>Link a Proxmox node or guest, a container or a service to colour it from live data.</small></label>
      <div class="network-field-row">
        <label class="network-field"><span>Kind</span><select data-net-field="kind">${options(ITEM_KINDS, item.kind)}</select></label>
        <label class="network-field"><span>State</span><select data-net-field="state"${item.source ? " disabled" : ""}>${options(MANUAL_STATES, item.state)}</select>${item.source ? `<small>From live data: ${escape(status.label)}</small>` : ""}</label>
      </div>
      <label class="network-field"><span>Address</span><input type="text" data-net-field="address" maxlength="${NETWORK_LIMITS.addressLength}" value="${escape(item.address)}" placeholder="192.168.0.10 or 1 Gbps" autocomplete="off" spellcheck="false" /></label>
      <label class="network-field"><span>Role</span><input type="text" data-net-field="role" maxlength="${NETWORK_LIMITS.roleLength}" value="${escape(item.role)}" placeholder="Reverse proxy" autocomplete="off" /></label>
      <label class="network-field"><span>Notes</span><textarea data-net-field="notes" rows="3" maxlength="${NETWORK_LIMITS.notesLength}">${escape(item.notes)}</textarea></label>
      <div class="network-panel__group">
        <span class="section-kicker">Position</span>
        <label class="network-field"><span>Zone</span><select data-net-field="zone">${options(map.zones.map((zone) => [zone.id, zone.title]), item.zone)}</select></label>
        <div class="network-nudge" role="group" aria-label="Move in the zone grid">
          <button class="network-tool network-tool--icon" type="button" data-net-action="nudge" data-net-dx="-1" data-net-dy="0" aria-label="Move left">←</button>
          <button class="network-tool network-tool--icon" type="button" data-net-action="nudge" data-net-dx="0" data-net-dy="-1" aria-label="Move up">↑</button>
          <button class="network-tool network-tool--icon" type="button" data-net-action="nudge" data-net-dx="0" data-net-dy="1" aria-label="Move down">↓</button>
          <button class="network-tool network-tool--icon" type="button" data-net-action="nudge" data-net-dx="1" data-net-dy="0" aria-label="Move right">→</button>
          <span class="network-nudge__cell">Column ${item.col + 1}, row ${item.row + 1}</span>
        </div>
      </div>
      <div class="network-panel__group">
        <span class="section-kicker">Connections</span>
        ${connections.length ? connections.map(({ link, other }) => `<div class="network-connection"><span><strong>${escape(other.name)}</strong><small>${escape(LINK_LABELS.get(link.kind) || link.kind)}${link.label ? ` · ${escape(link.label)}` : ""}</small></span><button class="button button--small" type="button" data-net-action="remove-link" data-net-link="${escape(link.id)}" aria-label="Remove connection to ${escape(other.name)}">Remove</button></div>`).join("") : `<p class="network-muted">No connections yet.</p>`}
        ${others.length ? `<div class="network-connection-form">
          <label class="network-field"><span>Connect to</span><select data-net-new-link="to">${options(others.map((entry) => [entry.id, entry.name]), "")}</select></label>
          <div class="network-field-row">
            <label class="network-field"><span>Type</span><select data-net-new-link="kind">${options(LINK_KINDS, "wired")}</select></label>
            <label class="network-field"><span>Label</span><input type="text" data-net-new-link="label" maxlength="${NETWORK_LIMITS.labelLength}" placeholder="1 GbE" autocomplete="off" /></label>
          </div>
          <button class="button" type="button" data-net-action="add-link">${icon("plus")} Add connection</button>
        </div>` : ""}
      </div>
      <div class="button-row"><button class="button button--danger" type="button" data-net-action="delete-item">Delete item</button></div>
    </section>`;
  }

  function editZoneMarkup(zone) {
    const map = currentMap();
    const itemCount = map.items.filter((item) => item.zone === zone.id).length;
    return `<section class="network-panel__section network-editor">
      <div class="network-panel__heading"><span class="section-kicker">Edit zone</span><button class="button button--small" type="button" data-net-action="clear-selection">Close</button></div>
      <label class="network-field"><span>Title</span><input type="text" data-net-zone-field="title" maxlength="${NETWORK_LIMITS.nameLength}" value="${escape(zone.title)}" autocomplete="off" /></label>
      <div class="network-field-row">
        <label class="network-field"><span>Row</span><input type="number" data-net-zone-field="row" min="1" max="${NETWORK_LIMITS.zoneRows}" value="${zone.row + 1}" /></label>
        <label class="network-field"><span>Order in row</span><input type="number" data-net-zone-field="order" min="1" max="100" value="${zone.order + 1}" /></label>
      </div>
      <p class="network-muted">Zones in the same row sit side by side, ordered left to right. ${itemCount} item${itemCount === 1 ? "" : "s"} in this zone.</p>
      <div class="button-row"><button class="button" type="button" data-net-action="add-item-to-zone">${icon("plus")} Add item here</button><button class="button button--danger" type="button" data-net-action="delete-zone"${itemCount ? " disabled" : ""}>Delete zone</button></div>
      ${itemCount ? `<p class="network-muted">Move or delete its items before deleting the zone.</p>` : ""}
    </section>`;
  }

  function editOverviewMarkup() {
    const map = currentMap();
    const nodeOptions = index.nodes.map((node) => [node.id, `${node.name}${node.environmentName ? ` · ${node.environmentName}` : ""}`]);
    const portainerOptions = index.portainerEnvironments.map((environment) => [`${environment.serverId}:${environment.id}`, `${environment.name}${environment.serverName ? ` · ${environment.serverName}` : ""}`]);
    return `<section class="network-panel__section network-editor">
      <span class="section-kicker">Editing the map</span>
      <h3>Add or change items</h3>
      <p>Click a block to edit it, or a zone title to edit the zone. Changes stay in this browser until you choose <strong>Save map</strong>.</p>
      <div class="button-row"><button class="button button--primary" type="button" data-net-action="add-item"${map.zones.length ? "" : " disabled"}>${icon("plus")} Add item</button><button class="button" type="button" data-net-action="add-zone">${icon("plus")} Add zone</button></div>
      ${map.zones.length ? "" : `<p class="network-muted">Add a zone first: zones group items, such as "Network edge" or one per server.</p>`}
      ${nodeOptions.length ? `<div class="network-panel__group"><span class="section-kicker">From Proxmox</span>
        <label class="network-field"><span>Node</span><select data-net-pick="node">${options(nodeOptions, "")}</select></label>
        <button class="button" type="button" data-net-action="add-node">${icon("plus")} Add node with its guests</button></div>` : ""}
      ${portainerOptions.length ? `<div class="network-panel__group"><span class="section-kicker">From Portainer</span>
        <label class="network-field"><span>Environment</span><select data-net-pick="portainer">${options(portainerOptions, "")}</select></label>
        <button class="button" type="button" data-net-action="add-portainer">${icon("plus")} Add environment's containers</button></div>` : ""}
      <div class="network-panel__group"><span class="section-kicker">Backup and sharing</span>
        <div class="button-row"><button class="button" type="button" data-net-action="open-export">Export JSON</button><button class="button" type="button" data-net-action="open-import">Import JSON</button></div></div>
    </section>${itemListMarkup()}`;
  }

  function importExportMarkup() {
    const exporting = state.panelMode === "export";
    return `<section class="network-panel__section network-editor">
      <div class="network-panel__heading"><span class="section-kicker">${exporting ? "Export" : "Import"}</span><button class="button button--small" type="button" data-net-action="close-dialog">Close</button></div>
      <h3>${exporting ? "Map as JSON" : "Load a map from JSON"}</h3>
      <p>${exporting ? "Copy this to back up the map or move it to another Helmsman." : "Paste a map exported from Helmsman. It replaces the draft; nothing is saved until you choose Save map."}</p>
      <label class="network-field"><span>JSON</span><textarea class="network-json" data-net-json rows="14" spellcheck="false"${exporting ? " readonly" : ""}>${escape(exporting ? state.exportText : "")}</textarea></label>
      ${state.importError ? `<p class="network-error" role="alert">${escape(state.importError)}</p>` : ""}
      ${exporting ? "" : `<div class="button-row"><button class="button button--primary" type="button" data-net-action="apply-import">Load into the draft</button></div>`}
    </section>`;
  }

  function renderPanel({ top = false } = {}) {
    if (!elements) return;
    if (top) elements.panel.scrollTop = 0;
    let markup;
    if (state.panelMode === "export" || state.panelMode === "import") markup = importExportMarkup();
    else if (!state.editing) markup = viewPanelMarkup();
    else {
      const map = currentMap();
      const item = map.items.find((entry) => entry.id === state.selected);
      const zone = map.zones.find((entry) => entry.id === state.selectedZone);
      markup = item ? editItemMarkup(item) : zone ? editZoneMarkup(zone) : editOverviewMarkup();
    }
    deps.setMarkup(elements.panel, markup);
  }

  // ------------------------------------------------------------ editing --

  function ensureDraft() {
    if (!state.draft) state.draft = clone(state.saved);
    return state.draft;
  }

  function changed({ panel = false, fit = false } = {}) {
    refreshIndex();
    layout = layoutNetworkMap(currentMap());
    if (fit) fitCamera();
    renderChrome();
    renderScene();
    if (panel) renderPanel();
  }

  function selectItem(id) {
    state.selected = state.selected === id && !state.editing ? null : id;
    state.selectedZone = null;
    state.panelMode = "";
    renderScene();
    renderPanel({ top: true });
  }

  function addItem(zoneId) {
    const map = ensureDraft();
    if (map.items.length >= NETWORK_LIMITS.items) {
      deps.toast(`The map can hold up to ${NETWORK_LIMITS.items} items.`, "warning");
      return;
    }
    const zone = map.zones.find((entry) => entry.id === zoneId) || map.zones[0];
    if (!zone) return;
    const cell = freeCell(map, zone.id);
    if (!cell) {
      deps.toast("That zone is full.", "warning");
      return;
    }
    const id = slugId("new-item", takenIds(map));
    map.items.push({ id, name: "New item", kind: "device", zone: zone.id, col: cell.col, row: cell.row, address: "", role: "", notes: "", source: null, state: "online" });
    state.selected = id;
    state.selectedZone = null;
    changed({ panel: true });
    elements?.panel.querySelector("[data-net-field='name']")?.select?.();
  }

  function addZone() {
    const map = ensureDraft();
    if (map.zones.length >= NETWORK_LIMITS.zones) {
      deps.toast(`The map can hold up to ${NETWORK_LIMITS.zones} zones.`, "warning");
      return;
    }
    const id = slugId("zone", takenIds(map));
    const row = nextZoneRow(map);
    map.zones.push({ id, title: `Zone ${map.zones.length + 1}`, row, order: 0 });
    state.selectedZone = id;
    state.selected = null;
    changed({ panel: true, fit: true });
  }

  function moveItem(item, col, row, zoneId = item.zone) {
    const map = ensureDraft();
    const nextCol = clamp(col, 0, NETWORK_LIMITS.columns - 1);
    const nextRow = clamp(row, 0, NETWORK_LIMITS.rows - 1);
    const occupant = map.items.find((entry) => entry !== item && entry.zone === zoneId && entry.col === nextCol && entry.row === nextRow);
    if (occupant) {
      if (zoneId === item.zone) {
        occupant.col = item.col;
        occupant.row = item.row;
      } else {
        const cell = freeCell(map, zoneId);
        if (!cell) return false;
        item.zone = zoneId;
        item.col = cell.col;
        item.row = cell.row;
        return true;
      }
    }
    item.zone = zoneId;
    item.col = nextCol;
    item.row = nextRow;
    return true;
  }

  function normalizeGrid(map) {
    // Pull every zone's grid back to start at column 0 and row 0 so gaps left
    // by moves and deletions do not leave empty space in the model.
    for (const zone of map.zones) {
      const items = map.items.filter((item) => item.zone === zone.id);
      if (!items.length) continue;
      const minCol = Math.min(...items.map((item) => item.col));
      const minRow = Math.min(...items.map((item) => item.row));
      items.forEach((item) => {
        item.col -= minCol;
        item.row -= minRow;
      });
    }
  }

  function parseSourceKey(key) {
    if (!key) return null;
    const match = discoveredSources(index).flatMap((group) => group.entries).find((entry) => sourceKey(entry.source) === key);
    return match || null;
  }

  function onFieldInput(target) {
    const map = ensureDraft();
    const item = map.items.find((entry) => entry.id === state.selected);
    if (target.dataset.netField && item) {
      const field = target.dataset.netField;
      if (["name", "address", "role", "notes"].includes(field)) {
        item[field] = target.value;
        if (field === "name" && !target.value.trim()) return;
        changed();
        return;
      }
      if (field === "kind") {
        item.kind = target.value;
        changed();
        return;
      }
      if (field === "state") {
        item.state = target.value;
        changed();
        return;
      }
      if (field === "zone") {
        moveItem(item, item.col, item.row, target.value);
        normalizeGrid(map);
        changed({ panel: true });
        return;
      }
      if (field === "source") {
        if (!target.value) {
          item.source = null;
        } else {
          const entry = parseSourceKey(target.value);
          if (entry) {
            const wasDefault = item.name === "New item";
            item.source = clone(entry.source);
            if (wasDefault) item.name = entry.name.slice(0, NETWORK_LIMITS.nameLength);
            if (wasDefault || item.kind === "device") item.kind = entry.kind;
          }
        }
        changed({ panel: true });
      }
      return;
    }
    const zone = map.zones.find((entry) => entry.id === state.selectedZone);
    if (target.dataset.netZoneField && zone) {
      const field = target.dataset.netZoneField;
      if (field === "title") {
        zone.title = target.value;
        if (!target.value.trim()) return;
        changed();
        return;
      }
      const value = Number.parseInt(target.value, 10);
      if (!Number.isFinite(value)) return;
      if (field === "row") zone.row = clamp(value - 1, 0, NETWORK_LIMITS.zoneRows - 1);
      if (field === "order") zone.order = clamp(value - 1, 0, 99);
      changed({ fit: !state.cameraTouched });
    }
  }

  function validateDraft(map) {
    for (const zone of map.zones) {
      if (!zone.title.trim()) return "Every zone needs a title.";
    }
    for (const item of map.items) {
      if (!item.name.trim()) return "Every item needs a name.";
    }
    return "";
  }

  function trimmedDraft(map) {
    const next = clone(map);
    next.zones.forEach((zone) => { zone.title = zone.title.trim(); });
    next.items.forEach((item) => {
      for (const key of ["name", "address", "role", "notes"]) item[key] = String(item[key] || "").trim();
    });
    next.links.forEach((link) => { link.label = String(link.label || "").trim(); });
    return next;
  }

  async function save() {
    if (!state.draft || state.saving) return;
    const problem = validateDraft(state.draft);
    if (problem) {
      deps.toast(problem, "warning");
      return;
    }
    state.saving = true;
    renderChrome();
    try {
      const saved = await deps.saveMap(trimmedDraft(state.draft), state.revision);
      state.saved = saved.map;
      state.revision = saved.revision;
      state.updatedAt = saved.updatedAt;
      state.draft = null;
      state.editing = false;
      state.selectedZone = null;
      state.panelMode = "";
      deps.toast("Network map saved", "success");
    } catch (error) {
      deps.toast(error?.code === "NETWORK_MAP_CONFLICT"
        ? "The map changed in another session. Export your draft, reload, and apply it again."
        : error?.message || "The network map could not be saved.", "danger");
    } finally {
      state.saving = false;
    }
    changed({ panel: true });
  }

  function applyImport(textValue) {
    let parsed;
    try {
      parsed = JSON.parse(textValue);
    } catch {
      state.importError = "That is not valid JSON.";
      renderPanel();
      return;
    }
    const map = parsed?.map && Array.isArray(parsed.map.items) ? parsed.map : parsed;
    if (!map || !Array.isArray(map.zones) || !Array.isArray(map.items) || !Array.isArray(map.links)) {
      state.importError = "The JSON needs zones, items and links lists.";
      renderPanel();
      return;
    }
    const zones = map.zones.filter((zone) => zone && IDENTIFIER.test(zone.id));
    const zoneIds = new Set(zones.map(({ id }) => id));
    const items = map.items.filter((item) => item && IDENTIFIER.test(item.id) && zoneIds.has(item.zone)).map((item) => ({
      id: item.id,
      name: String(item.name || item.id).slice(0, NETWORK_LIMITS.nameLength),
      kind: KIND_LABELS.has(item.kind) ? item.kind : "other",
      zone: item.zone,
      col: Number.isSafeInteger(item.col) ? item.col : 0,
      row: Number.isSafeInteger(item.row) ? item.row : 0,
      address: String(item.address || "").slice(0, NETWORK_LIMITS.addressLength),
      role: String(item.role || "").slice(0, NETWORK_LIMITS.roleLength),
      notes: String(item.notes || "").slice(0, NETWORK_LIMITS.notesLength),
      source: item.source && typeof item.source === "object" ? item.source : null,
      state: MANUAL_STATES.some(([value]) => value === item.state) ? item.state : "unknown"
    }));
    const itemIds = new Set(items.map(({ id }) => id));
    state.draft = {
      zones: zones.map((zone) => ({
        id: zone.id,
        title: String(zone.title || zone.id).slice(0, NETWORK_LIMITS.nameLength),
        row: Number.isSafeInteger(zone.row) ? clamp(zone.row, 0, NETWORK_LIMITS.zoneRows - 1) : 0,
        order: Number.isSafeInteger(zone.order) ? clamp(zone.order, 0, 99) : 0
      })),
      items,
      links: map.links.filter((link) => link && IDENTIFIER.test(link.id) && itemIds.has(link.from) && itemIds.has(link.to) && link.from !== link.to).map((link) => ({
        id: link.id,
        from: link.from,
        to: link.to,
        kind: LINK_LABELS.has(link.kind) ? link.kind : "wired",
        label: String(link.label || "").slice(0, NETWORK_LIMITS.labelLength)
      }))
    };
    state.editing = true;
    state.importError = "";
    state.panelMode = "";
    state.selected = null;
    state.selectedZone = null;
    changed({ panel: true, fit: true });
    deps.toast("Map loaded into the draft. Review it, then choose Save map", "info");
  }

  // ------------------------------------------------------------- events --

  function onClick(event) {
    const selectTarget = event.target.closest?.("[data-net-select]");
    if (selectTarget && root.contains(selectTarget)) {
      if (moved) return;
      selectItem(selectTarget.dataset.netSelect);
      return;
    }
    const zoneTarget = event.target.closest?.("[data-net-zone]");
    if (zoneTarget && state.editing) {
      state.selectedZone = zoneTarget.dataset.netZone;
      state.selected = null;
      state.panelMode = "";
      renderScene();
      renderPanel({ top: true });
      return;
    }
    const actionTarget = event.target.closest?.("[data-net-action]");
    if (!actionTarget || !root.contains(actionTarget)) return;
    const action = actionTarget.dataset.netAction;
    const map = currentMap();
    const item = map.items.find((entry) => entry.id === state.selected);
    switch (action) {
      case "edit":
        state.editing = true;
        state.panelMode = "";
        changed({ panel: true });
        break;
      case "start-empty":
        state.editing = true;
        ensureDraft();
        if (!state.draft.zones.length) {
          state.draft.zones.push({ id: "network-edge", title: "Network edge", row: 0, order: 0 });
        }
        changed({ panel: true, fit: true });
        break;
      case "seed": {
        state.draft = mapFromInventory(index);
        state.editing = true;
        state.panelMode = "";
        changed({ panel: true, fit: true });
        deps.toast("Draft built from your inventory. Add your edge devices, then choose Save map", "info");
        break;
      }
      case "discard":
        state.draft = null;
        state.editing = false;
        state.selectedZone = null;
        state.panelMode = "";
        if (state.selected && !state.saved.items.some((entry) => entry.id === state.selected)) state.selected = null;
        changed({ panel: true, fit: !state.cameraTouched });
        break;
      case "save":
        save();
        break;
      case "reload":
        load();
        break;
      case "view":
        state.view = actionTarget.dataset.netView === "top" ? "top" : "angled";
        state.cameraTouched = false;
        renderChrome();
        fitCamera();
        break;
      case "rotate":
        state.cameraTouched = true;
        state.view = "";
        renderChrome();
        tween({ rz: state.camera.rz + Number(actionTarget.dataset.netStep || 0) });
        break;
      case "zoom":
        state.cameraTouched = true;
        tween({ zoom: clamp(state.camera.zoom * (actionTarget.dataset.netStep === "in" ? 1.2 : 1 / 1.2), 0.15, 2.2) });
        break;
      case "fit":
        state.cameraTouched = false;
        fitCamera();
        break;
      case "panel":
        state.panelHidden = !state.panelHidden;
        renderChrome();
        globalThis.requestAnimationFrame?.(() => {
          measure();
          if (!state.cameraTouched) fitCamera();
          else applyCamera();
        });
        break;
      case "flows":
        state.showAllFlows = !state.showAllFlows;
        renderChrome();
        renderScene();
        break;
      case "clear-selection":
        state.selected = null;
        state.selectedZone = null;
        renderScene();
        renderPanel();
        break;
      case "centre": {
        const geometry = layout.itemById.get(state.selected);
        if (!geometry) break;
        const point = projector(state.camera, size.width, size.height)(geometry.x, geometry.y, geometry.h / 2);
        state.cameraTouched = true;
        tween({ panX: -point.X, panY: -point.Y });
        break;
      }
      case "add-item":
        addItem(state.selectedZone || map.zones[0]?.id);
        break;
      case "add-item-to-zone":
        addItem(state.selectedZone);
        break;
      case "add-zone":
        addZone();
        break;
      case "delete-item":
        if (item) {
          const draft = ensureDraft();
          draft.items = draft.items.filter((entry) => entry.id !== item.id);
          draft.links = draft.links.filter((link) => link.from !== item.id && link.to !== item.id);
          normalizeGrid(draft);
          state.selected = null;
          changed({ panel: true });
        }
        break;
      case "delete-zone": {
        const draft = ensureDraft();
        if (draft.items.some((entry) => entry.zone === state.selectedZone)) break;
        draft.zones = draft.zones.filter((zone) => zone.id !== state.selectedZone);
        state.selectedZone = null;
        changed({ panel: true, fit: !state.cameraTouched });
        break;
      }
      case "nudge":
        if (item) {
          const draftItem = ensureDraft().items.find((entry) => entry.id === item.id);
          const nextCol = draftItem.col + Number(actionTarget.dataset.netDx || 0);
          const nextRow = draftItem.row + Number(actionTarget.dataset.netDy || 0);
          if (nextCol < 0 || nextRow < 0) {
            // Moving past the left or top edge shifts everything else instead.
            const draft = state.draft;
            draft.items.filter((entry) => entry.zone === draftItem.zone && entry !== draftItem).forEach((entry) => {
              if (nextCol < 0) entry.col += 1;
              if (nextRow < 0) entry.row += 1;
            });
            if (nextCol < 0) draftItem.col = 0;
            if (nextRow < 0) draftItem.row = 0;
          } else moveItem(draftItem, nextCol, nextRow);
          normalizeGrid(state.draft);
          changed({ panel: true });
        }
        break;
      case "add-link": {
        if (!item) break;
        const draft = ensureDraft();
        const to = elements.panel.querySelector("[data-net-new-link='to']")?.value;
        const kind = elements.panel.querySelector("[data-net-new-link='kind']")?.value || "wired";
        const label = String(elements.panel.querySelector("[data-net-new-link='label']")?.value || "").slice(0, NETWORK_LIMITS.labelLength);
        if (!to || to === item.id) break;
        const duplicate = draft.links.some((link) => link.kind === kind && ((link.from === item.id && link.to === to) || (link.from === to && link.to === item.id)));
        if (duplicate) {
          deps.toast("Those items already have that connection", "warning");
          break;
        }
        if (draft.links.length >= NETWORK_LIMITS.links) {
          deps.toast(`The map can hold up to ${NETWORK_LIMITS.links} connections.`, "warning");
          break;
        }
        draft.links.push({ id: slugId(`${item.id}-${to}`, takenIds(draft)), from: item.id, to, kind, label });
        changed({ panel: true });
        break;
      }
      case "remove-link": {
        const draft = ensureDraft();
        draft.links = draft.links.filter((link) => link.id !== actionTarget.dataset.netLink);
        changed({ panel: true });
        break;
      }
      case "add-node": {
        const nodeId = elements.panel.querySelector("[data-net-pick='node']")?.value;
        const result = addNodeWithGuests(ensureDraft(), index, nodeId);
        state.draft = result.map;
        changed({ panel: true, fit: true });
        deps.toast(result.added ? `Added ${result.added} item${result.added === 1 ? "" : "s"}` : "Everything on that node is already on the map", "info");
        break;
      }
      case "add-portainer": {
        const key = elements.panel.querySelector("[data-net-pick='portainer']")?.value;
        const result = addPortainerEnvironment(ensureDraft(), index, key);
        state.draft = result.map;
        changed({ panel: true, fit: true });
        deps.toast(result.added ? `Added ${result.added} container${result.added === 1 ? "" : "s"}` : "Every container there is already on the map", "info");
        break;
      }
      case "open-export":
        state.exportText = JSON.stringify(trimmedDraft(currentMap()), null, 2);
        state.panelMode = "export";
        renderPanel();
        elements.panel.querySelector("[data-net-json]")?.select?.();
        break;
      case "open-import":
        state.panelMode = "import";
        state.importError = "";
        renderPanel();
        elements.panel.querySelector("[data-net-json]")?.focus?.();
        break;
      case "close-dialog":
        state.panelMode = "";
        renderPanel();
        break;
      case "apply-import":
        applyImport(elements.panel.querySelector("[data-net-json]")?.value || "");
        break;
      default:
        break;
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!state.editing || !elements?.panel.contains(target)) return;
    if (target.dataset.netField || target.dataset.netZoneField) {
      if (["SELECT"].includes(target.tagName) && event.type === "input") return;
      if (target.tagName !== "SELECT" && event.type === "change") return;
      onFieldInput(target);
    }
  }

  function onPointerDown(event) {
    if (!elements?.scene.contains(event.target) || (event.button !== undefined && event.button !== 0)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    globalThis.cancelAnimationFrame?.(animation);
    moved = false;
    if (pointers.size === 1) {
      drag = { x: event.clientX, y: event.clientY, camera: { ...state.camera }, pan: event.shiftKey };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { pinch: Math.hypot(a.x - b.x, a.y - b.y), camera: { ...state.camera } };
    }
  }

  function onPointerMove(event) {
    if (!drag || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (drag.pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      state.camera.zoom = clamp(drag.camera.zoom * (distance / Math.max(1, drag.pinch)), 0.15, 2.2);
      moved = true;
      state.cameraTouched = true;
      applyCamera();
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!moved) elements.scene.setPointerCapture?.(event.pointerId);
    moved = true;
    state.cameraTouched = true;
    if (state.view) {
      state.view = "";
      renderChrome();
    }
    if (drag.pan) {
      state.camera.panX = drag.camera.panX + dx;
      state.camera.panY = drag.camera.panY + dy;
    } else {
      state.camera.rz = drag.camera.rz + dx * 0.3;
      state.camera.rx = clamp(drag.camera.rx - dy * 0.3, 0, 80);
    }
    applyCamera();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    const wasDrag = moved;
    if (pointers.size === 0) drag = null;
    if (!wasDrag && pointers.size === 0 && event.type === "pointerup"
      && !event.target.closest?.("[data-net-select]") && (state.selected || state.selectedZone)) {
      state.selected = null;
      state.selectedZone = null;
      renderScene();
      renderPanel();
    }
    if (wasDrag) setTimeout(() => { moved = false; }, 0);
  }

  function onWheel(event) {
    if (!elements?.viewport.contains(event.target)) return;
    event.preventDefault();
    state.cameraTouched = true;
    state.camera.zoom = clamp(state.camera.zoom * Math.exp(-event.deltaY * 0.0012), 0.15, 2.2);
    applyCamera();
  }

  function onHover(event) {
    const target = event.target.closest?.("[data-net-select]");
    const next = event.type === "mouseover" && target ? target.dataset.netSelect : null;
    if (next === hovered) return;
    hovered = next;
    for (const label of labels) label.element.classList.toggle("is-forced", label.id === hovered || Boolean(relatedIds()?.has(label.id)));
  }

  function bindEvents() {
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    elements.scene.addEventListener("pointerdown", onPointerDown);
    elements.scene.addEventListener("pointermove", onPointerMove);
    elements.scene.addEventListener("pointerup", onPointerUp);
    elements.scene.addEventListener("pointercancel", onPointerUp);
    elements.viewport.addEventListener("wheel", onWheel, { passive: false });
    elements.stage.addEventListener("mouseover", onHover);
    elements.stage.addEventListener("mouseout", onHover);
  }

  return {
    mount,
    unmount,
    isMountedOn,
    refreshLive,
    hasUnsavedChanges: dirty,
    reload: load
  };
}
