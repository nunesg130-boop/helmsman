import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Launchpad addresses: optional browser-facing addresses for connected
// services, such as a reverse-proxy hostname. Helmsman never requests these
// addresses itself; they are only returned to the signed-in dashboard so the
// Launchpad can open a service in a new tab. When no address is saved, the
// Launchpad falls back to the connection's own address.
//
// The store lives beside state.json in its own file so the security-critical
// broker state schema is untouched. It never contains credentials: addresses
// with embedded user information are rejected.

const FILE_NAME = "launchpad.json";
const FILE_VERSION = 1;
const MAX_ENTRIES = 64;
const MAX_URL_LENGTH = 500;
const MAX_FILE_BYTES = 128 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MEDIA_SERVICE_IDS = new Set(["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent"]);
const KINDS = new Set(["media", "environment", "service"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]/u;

export const LAUNCHPAD_LIMITS = Object.freeze({ entries: MAX_ENTRIES, urlLength: MAX_URL_LENGTH });

export function launchpadKey(kind, id) {
  if (!KINDS.has(kind) || typeof id !== "string") return null;
  if (kind === "media" ? !MEDIA_SERVICE_IDS.has(id) : !UUID.test(id)) return null;
  return `${kind}:${id}`;
}

/**
 * Returns the canonical form of a browser-facing http(s) address, or null when
 * the value is not one. Rejects embedded credentials, control characters and
 * anything other than http: or https:, so the dashboard can only ever render a
 * plain web link.
 */
export function canonicalLaunchUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH || CONTROL.test(value)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    return null;
  }
  const href = parsed.href;
  return href.length <= MAX_URL_LENGTH ? href : null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function parseKey(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return launchpadKey(kind, id) === value ? { kind, id } : null;
}

function validEntry(value) {
  return isPlainObject(value)
    && parseKey(value.key) !== null
    && canonicalLaunchUrl(value.url) === value.url
    && canonicalTimestamp(value.updatedAt) !== null;
}

function publicEntry(entry) {
  const { kind, id } = parseKey(entry.key);
  return { kind, id, url: entry.url, updatedAt: entry.updatedAt };
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
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Launchpad addresses exceeded their size limit.");
  const temporary = path.join(dataDir, `.launchpad-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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

export async function createLaunchpadStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The Launchpad store requires an absolute data directory.");
  }
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const filePath = path.join(dataDir, FILE_NAME);
  const entries = new Map();
  let writeChain = Promise.resolve();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const loaded = await readFileSafely(filePath);
  if (isPlainObject(loaded) && loaded.version === FILE_VERSION && Array.isArray(loaded.entries)) {
    for (const entry of loaded.entries.slice(0, MAX_ENTRIES)) {
      if (validEntry(entry) && !entries.has(entry.key)) {
        entries.set(entry.key, { key: entry.key, url: entry.url, updatedAt: entry.updatedAt });
      }
    }
  }

  function persist() {
    const snapshot = { version: FILE_VERSION, entries: [...entries.values()] };
    const operation = writeChain.catch(() => {}).then(async () => {
      await guard();
      await atomicWrite(dataDir, filePath, snapshot);
    });
    writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  return {
    list() {
      return [...entries.values()].map(publicEntry).sort((left, right) =>
        `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    },

    async set(kind, id, url) {
      const key = launchpadKey(kind, id);
      const canonical = canonicalLaunchUrl(url);
      if (!key || !canonical) throw new TypeError("Enter an http or https address without a user name or password.");
      if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
        const error = new Error("Too many Launchpad addresses are saved. Remove one before adding another.");
        error.code = "LAUNCHPAD_LIMIT";
        throw error;
      }
      const entry = { key, url: canonical, updatedAt: new Date(Math.trunc(Number(clock()))).toISOString() };
      entries.set(key, entry);
      await persist();
      return publicEntry(entry);
    },

    async remove(kind, id) {
      const key = launchpadKey(kind, id);
      if (!key || !entries.delete(key)) return false;
      await persist();
      return true;
    }
  };
}
