import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

// Network map: the owner's own layout of their network for the 3D Network
// page, kept in the data volume beside state.json. Helmsman ships with an
// empty map.
//
// The map is plain owner-authored data: zones, items placed on a zone grid,
// and the links between items. An item may name a live source (a Proxmox
// node or guest, a Portainer container, or a configured service) whose
// current state the browser looks up in the snapshot it already has. The map
// never holds credentials, URLs Helmsman will contact, or markup; every
// string is bounded text that the dashboard escapes before display.

const FILE_NAME = "network-map.json";
const FILE_VERSION = 1;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const SOURCE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
// Single-line text: no C0/C1 controls, no line or paragraph separators.
const SINGLE_LINE_DISALLOWED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// Notes may contain line feeds and tabs only.
const NOTES_DISALLOWED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

export const NETWORK_MAP_LIMITS = Object.freeze({
  zones: 40,
  items: 400,
  links: 1_000,
  columns: 24,
  rows: 40,
  zoneRows: 20,
  zoneOrder: 100,
  nameLength: 64,
  addressLength: 120,
  roleLength: 80,
  notesLength: 600,
  labelLength: 80,
  bodyBytes: 512 * 1024
});

export const NETWORK_ITEM_KINDS = Object.freeze([
  "internet", "cloud", "modem", "router", "firewall", "switch", "access-point", "wireless",
  "camera", "iot", "device", "laptop", "server", "host", "vm", "lxc", "container",
  "service", "storage", "other"
]);
export const NETWORK_ITEM_STATES = Object.freeze(["online", "offline", "degraded", "stopped", "planned", "retired", "unknown"]);
export const NETWORK_LINK_KINDS = Object.freeze(["wired", "wan", "wifi", "tunnel", "flow"]);
export const NETWORK_SOURCE_TYPES = Object.freeze(["node", "guest", "container", "service"]);

const MAX_FILE_BYTES = NETWORK_MAP_LIMITS.bodyBytes + 4096;
const ITEM_KINDS = new Set(NETWORK_ITEM_KINDS);
const ITEM_STATES = new Set(NETWORK_ITEM_STATES);
const LINK_KINDS = new Set(NETWORK_LINK_KINDS);

export class NetworkMapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalid(message) {
  throw new NetworkMapError("INVALID_NETWORK_MAP", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional, where) {
  if (!isPlainObject(value)) invalid(`${where} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${where} has an unsupported field: ${key.slice(0, 40)}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${where} is missing ${key}.`);
  }
}

function text(value, { max, where, required = false, multiline = false }) {
  if (value === undefined || value === null || value === "") {
    if (required) invalid(`${where} is required.`);
    return "";
  }
  if (typeof value !== "string") invalid(`${where} must be text.`);
  const normalized = (multiline ? value.replace(/\r\n?/gu, "\n") : value).trim();
  if (required && !normalized) invalid(`${where} is required.`);
  if ((multiline ? NOTES_DISALLOWED : SINGLE_LINE_DISALLOWED).test(normalized)) {
    invalid(`${where} contains control characters.`);
  }
  if ([...normalized].length > max) invalid(`${where} must be ${max} characters or fewer.`);
  return normalized;
}

function integer(value, { min, max, where }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${where} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function identifier(value, where) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    invalid(`${where} must be 1-48 lower-case letters, digits or hyphens.`);
  }
  return value;
}

function scope(value, where) {
  if (value === undefined || value === null || value === "") return null;
  const candidate = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof candidate !== "string" || !SOURCE_SCOPE.test(candidate)) invalid(`${where} is not a valid identifier.`);
  return candidate;
}

function canonicalSource(value, where) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || typeof value.type !== "string") invalid(`${where} must be an object with a type.`);
  switch (value.type) {
    case "node": {
      exactKeys(value, ["type", "name"], ["environment"], where);
      if (typeof value.name !== "string" || !SOURCE_NAME.test(value.name)) invalid(`${where} needs a valid node name.`);
      const environment = scope(value.environment, `${where} environment`);
      return environment ? { type: "node", name: value.name, environment } : { type: "node", name: value.name };
    }
    case "guest": {
      exactKeys(value, ["type", "vmid"], ["environment"], where);
      const vmid = integer(value.vmid, { min: 1, max: 999_999_999, where: `${where} VMID` });
      const environment = scope(value.environment, `${where} environment`);
      return environment ? { type: "guest", vmid, environment } : { type: "guest", vmid };
    }
    case "container": {
      exactKeys(value, ["type", "name"], ["server", "environment"], where);
      if (typeof value.name !== "string" || !SOURCE_NAME.test(value.name)) invalid(`${where} needs a valid container name.`);
      const server = scope(value.server, `${where} server`);
      const environment = scope(value.environment, `${where} environment`);
      return {
        type: "container",
        name: value.name,
        ...(server ? { server } : {}),
        ...(environment ? { environment } : {})
      };
    }
    case "service": {
      exactKeys(value, ["type", "id"], [], where);
      if (typeof value.id !== "string" || !SERVICE_ID.test(value.id)) invalid(`${where} needs a valid service id.`);
      return { type: "service", id: value.id };
    }
    default:
      return invalid(`${where} has an unsupported type.`);
  }
}

export function emptyNetworkMap() {
  return { zones: [], items: [], links: [] };
}

/**
 * Validates an owner-supplied network map and returns its canonical stored
 * form. Throws NetworkMapError("INVALID_NETWORK_MAP") with a short,
 * owner-readable reason when the map is not acceptable.
 */
export function canonicalNetworkMap(value) {
  exactKeys(value, ["zones", "items", "links"], [], "The map");
  const { zones: rawZones, items: rawItems, links: rawLinks } = value;
  if (!Array.isArray(rawZones) || rawZones.length > NETWORK_MAP_LIMITS.zones) {
    invalid(`The map can hold up to ${NETWORK_MAP_LIMITS.zones} zones.`);
  }
  if (!Array.isArray(rawItems) || rawItems.length > NETWORK_MAP_LIMITS.items) {
    invalid(`The map can hold up to ${NETWORK_MAP_LIMITS.items} items.`);
  }
  if (!Array.isArray(rawLinks) || rawLinks.length > NETWORK_MAP_LIMITS.links) {
    invalid(`The map can hold up to ${NETWORK_MAP_LIMITS.links} connections.`);
  }

  const zoneIds = new Set();
  const zones = rawZones.map((zone, index) => {
    const where = `Zone ${index + 1}`;
    exactKeys(zone, ["id", "title", "row", "order"], [], where);
    const id = identifier(zone.id, `${where} id`);
    if (zoneIds.has(id)) invalid(`${where} reuses the id ${id}.`);
    zoneIds.add(id);
    return {
      id,
      title: text(zone.title, { max: NETWORK_MAP_LIMITS.nameLength, where: `${where} title`, required: true }),
      row: integer(zone.row, { min: 0, max: NETWORK_MAP_LIMITS.zoneRows - 1, where: `${where} row` }),
      order: integer(zone.order, { min: 0, max: NETWORK_MAP_LIMITS.zoneOrder - 1, where: `${where} order` })
    };
  });

  const itemIds = new Set();
  const cells = new Set();
  const items = rawItems.map((item, index) => {
    const where = `Item ${index + 1}`;
    exactKeys(item, ["id", "name", "kind", "zone", "col", "row"], ["address", "role", "notes", "source", "state"], where);
    const id = identifier(item.id, `${where} id`);
    if (itemIds.has(id)) invalid(`${where} reuses the id ${id}.`);
    itemIds.add(id);
    const name = text(item.name, { max: NETWORK_MAP_LIMITS.nameLength, where: `${where} name`, required: true });
    if (typeof item.kind !== "string" || !ITEM_KINDS.has(item.kind)) invalid(`${name} has an unsupported kind.`);
    const zone = identifier(item.zone, `${name} zone`);
    if (!zoneIds.has(zone)) invalid(`${name} is placed in a zone that does not exist.`);
    const col = integer(item.col, { min: 0, max: NETWORK_MAP_LIMITS.columns - 1, where: `${name} column` });
    const row = integer(item.row, { min: 0, max: NETWORK_MAP_LIMITS.rows - 1, where: `${name} row` });
    const cell = `${zone}:${col}:${row}`;
    if (cells.has(cell)) invalid(`${name} shares its grid cell with another item.`);
    cells.add(cell);
    const state = item.state === undefined || item.state === null ? "unknown" : item.state;
    if (typeof state !== "string" || !ITEM_STATES.has(state)) invalid(`${name} has an unsupported state.`);
    const canonical = {
      id,
      name,
      kind: item.kind,
      zone,
      col,
      row,
      address: text(item.address, { max: NETWORK_MAP_LIMITS.addressLength, where: `${name} address` }),
      role: text(item.role, { max: NETWORK_MAP_LIMITS.roleLength, where: `${name} role` }),
      notes: text(item.notes, { max: NETWORK_MAP_LIMITS.notesLength, where: `${name} notes`, multiline: true }),
      source: canonicalSource(item.source, `${name} live source`),
      state
    };
    return canonical;
  });

  const linkIds = new Set();
  const pairs = new Set();
  const links = rawLinks.map((link, index) => {
    const where = `Connection ${index + 1}`;
    exactKeys(link, ["id", "from", "to", "kind"], ["label"], where);
    const id = identifier(link.id, `${where} id`);
    if (linkIds.has(id)) invalid(`${where} reuses the id ${id}.`);
    linkIds.add(id);
    const from = identifier(link.from, `${where} start`);
    const to = identifier(link.to, `${where} end`);
    if (!itemIds.has(from) || !itemIds.has(to)) invalid(`${where} points at an item that does not exist.`);
    if (from === to) invalid(`${where} connects an item to itself.`);
    if (typeof link.kind !== "string" || !LINK_KINDS.has(link.kind)) invalid(`${where} has an unsupported kind.`);
    const pair = `${[from, to].sort().join("|")}|${link.kind}`;
    if (pairs.has(pair)) invalid(`${where} duplicates another connection.`);
    pairs.add(pair);
    return {
      id,
      from,
      to,
      kind: link.kind,
      label: text(link.label, { max: NETWORK_MAP_LIMITS.labelLength, where: `${where} label` })
    };
  });

  const canonical = { zones, items, links };
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > NETWORK_MAP_LIMITS.bodyBytes) {
    invalid("The map exceeded its size limit.");
  }
  return canonical;
}

export function validNetworkMapRevision(value) {
  return value === null || (typeof value === "string" && REVISION.test(value));
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

async function readFileSafely(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function atomicWrite(dataDir, filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) {
    throw new NetworkMapError("INVALID_NETWORK_MAP", "The map exceeded its size limit.");
  }
  const temporary = path.join(dataDir, `.network-map-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function snapshotOf(current) {
  return { map: structuredClone(current.map), revision: current.revision, updatedAt: current.updatedAt };
}

export async function createNetworkMapStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The network map store requires an absolute data directory.");
  }
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const filePath = path.join(dataDir, FILE_NAME);
  let current = { map: emptyNetworkMap(), revision: null, updatedAt: null };
  let writeChain = Promise.resolve();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const loaded = await readFileSafely(filePath);
  if (isPlainObject(loaded)
    && loaded.version === FILE_VERSION
    && typeof loaded.revision === "string"
    && REVISION.test(loaded.revision)
    && canonicalTimestamp(loaded.updatedAt) !== null) {
    try {
      current = { map: canonicalNetworkMap(loaded.map), revision: loaded.revision, updatedAt: loaded.updatedAt };
    } catch {
      // A damaged file loads as an empty map; the next save replaces it.
    }
  }

  return {
    get() {
      return snapshotOf(current);
    },

    /**
     * Saves a new map when `expectedRevision` matches the stored revision
     * (null when nothing has been saved yet), so two open editors cannot
     * silently overwrite each other.
     */
    async save(map, expectedRevision) {
      const canonical = canonicalNetworkMap(map);
      if (!validNetworkMapRevision(expectedRevision)) {
        throw new NetworkMapError("INVALID_NETWORK_MAP", "The map revision is not valid.");
      }
      const operation = writeChain.catch(() => {}).then(async () => {
        if (expectedRevision !== current.revision) {
          throw new NetworkMapError("NETWORK_MAP_CONFLICT", "The network map changed since you opened it. Reload it and apply your edits again.");
        }
        const next = {
          map: canonical,
          revision: randomUUID(),
          updatedAt: new Date(Math.trunc(Number(clock()))).toISOString()
        };
        await guard();
        await atomicWrite(dataDir, filePath, { version: FILE_VERSION, ...next });
        current = next;
        return snapshotOf(next);
      });
      writeChain = operation.then(() => {}, () => {});
      return operation;
    }
  };
}
