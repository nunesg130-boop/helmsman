import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  utimes
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const CACHE_SCHEMA = 1;
const SNAPSHOT_NAME = "operations-v1.json";
const ARTWORK_DIRECTORY = "artwork";
const ARTWORK_SUFFIX = ".art";
const DEFAULT_MAXIMUM_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_ARTWORK_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAXIMUM_ARTWORK_ENTRIES = 2_048;
const DEFAULT_ARTWORK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAXIMUM_ARTWORK_BODY_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ARTWORK_FILE_BYTES = MAXIMUM_ARTWORK_BODY_BYTES + 2_048;
const MAXIMUM_DIRECTORY_ENTRIES = 4_096;
const IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|jpeg|png|webp)$/u;
const ETAG = /^"[A-Za-z0-9_-]{20,100}"$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function timestampFromClock(clock) {
  const value = Number(clock());
  if (!Number.isFinite(value)) throw new TypeError("The persistent-cache clock returned an invalid time.");
  return new Date(Math.trunc(value)).toISOString();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artworkEtag(body) {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

async function requirePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Persistent cache path is not a private directory.");
  }
  await chmod(directory, 0o700);
}

async function readPrivateFile(filename, maximumBytes) {
  let handle;
  try {
    handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const status = await handle.stat();
    if (!status.isFile() || status.nlink !== 1 || status.size < 1 || status.size > maximumBytes) return null;
    return await handle.readFile();
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
    await handle.sync();
  } catch {
    // Some filesystems do not permit directory fsync. The file itself was
    // already synced before the atomic rename.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(directory, filename, body) {
  const temporary = path.join(directory, `.cache-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, filename);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function validSnapshot(value) {
  return isPlainObject(value)
    && value.version === 1
    && canonicalTimestamp(value.generatedAt)
    && isPlainObject(value.overall)
    && Array.isArray(value.services)
    && isPlainObject(value.pipeline)
    && isPlainObject(value.infrastructure)
    && isPlainObject(value.incidents)
    && isPlainObject(value.media)
    && Array.isArray(value.events)
    && Array.isArray(value.history);
}

function cloneWithoutTransientFields(value) {
  const snapshot = structuredClone(value);
  delete snapshot.cache;
  const pending = [snapshot];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current)) delete current.reports;
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return snapshot;
}

function artworkFileBody(keyHash, contentType, body, storedAt, expiresAt) {
  const etag = artworkEtag(body);
  const header = Buffer.from(`${JSON.stringify({
    schema: CACHE_SCHEMA,
    keyHash,
    contentType,
    etag,
    storedAt,
    expiresAt,
    size: body.length
  })}\n`, "utf8");
  return { bytes: Buffer.concat([header, body]), etag };
}

function parseArtworkFile(bytes, expectedKeyHash, now) {
  const newline = bytes.indexOf(0x0a);
  if (newline < 2 || newline > 1_024) return null;
  let header;
  try {
    header = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
  } catch {
    return null;
  }
  const body = bytes.subarray(newline + 1);
  if (!isPlainObject(header)
    || header.schema !== CACHE_SCHEMA
    || header.keyHash !== expectedKeyHash
    || !DIGEST.test(header.keyHash)
    || !IMAGE_CONTENT_TYPE.test(header.contentType)
    || !ETAG.test(header.etag)
    || !canonicalTimestamp(header.storedAt)
    || !canonicalTimestamp(header.expiresAt)
    || !Number.isSafeInteger(header.size)
    || header.size < 1
    || header.size > MAXIMUM_ARTWORK_BODY_BYTES
    || body.length !== header.size
    || Date.parse(header.expiresAt) <= now
    || artworkEtag(body) !== header.etag) return null;
  return {
    body: Buffer.from(body),
    contentType: header.contentType,
    etag: header.etag,
    storedAt: header.storedAt,
    expiresAt: header.expiresAt
  };
}

export async function createPersistentCache(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Persistent cache options must be an object.");
  }
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("The persistent-cache data directory must be absolute.");
  }
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const maximumSnapshotBytes = boundedInteger(
    options.maximumSnapshotBytes,
    DEFAULT_MAXIMUM_SNAPSHOT_BYTES,
    64 * 1024,
    32 * 1024 * 1024,
    "Maximum snapshot bytes"
  );
  const maximumSnapshotAgeMs = boundedInteger(
    options.maximumSnapshotAgeMs,
    DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS,
    60_000,
    90 * 24 * 60 * 60 * 1_000,
    "Maximum snapshot age"
  );
  const maximumArtworkBytes = boundedInteger(
    options.maximumArtworkBytes,
    DEFAULT_MAXIMUM_ARTWORK_BYTES,
    MAXIMUM_ARTWORK_BODY_BYTES,
    2 * 1024 * 1024 * 1024,
    "Maximum artwork-cache bytes"
  );
  const maximumArtworkEntries = boundedInteger(
    options.maximumArtworkEntries,
    DEFAULT_MAXIMUM_ARTWORK_ENTRIES,
    1,
    MAXIMUM_DIRECTORY_ENTRIES,
    "Maximum artwork-cache entries"
  );
  const artworkTtlMs = boundedInteger(
    options.artworkTtlMs,
    DEFAULT_ARTWORK_TTL_MS,
    60_000,
    90 * 24 * 60 * 60 * 1_000,
    "Artwork-cache lifetime"
  );
  const cacheDirectory = path.join(dataDir, "cache");
  const artworkDirectory = path.join(cacheDirectory, ARTWORK_DIRECTORY);
  const snapshotFilename = path.join(cacheDirectory, SNAPSHOT_NAME);
  await requirePrivateDirectory(cacheDirectory);
  await requirePrivateDirectory(artworkDirectory);

  let writeChain = Promise.resolve();
  let closing = false;

  function enqueue(operation) {
    if (closing) return Promise.resolve(false);
    const pending = writeChain.then(operation, operation);
    writeChain = pending.catch(() => {});
    return pending;
  }

  async function readSnapshot() {
    const bytes = await readPrivateFile(snapshotFilename, maximumSnapshotBytes);
    if (!bytes) return null;
    let wrapper;
    try {
      wrapper = JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
    if (!isPlainObject(wrapper)
      || Object.keys(wrapper).sort().join(",") !== "checksum,schema,snapshot,storedAt"
      || wrapper.schema !== CACHE_SCHEMA
      || !canonicalTimestamp(wrapper.storedAt)
      || typeof wrapper.checksum !== "string"
      || !DIGEST.test(wrapper.checksum)
      || !validSnapshot(wrapper.snapshot)) return null;
    const snapshotJson = JSON.stringify(wrapper.snapshot);
    if (digest(snapshotJson) !== wrapper.checksum) return null;
    const now = Number(clock());
    const storedAtMs = Date.parse(wrapper.storedAt);
    if (!Number.isFinite(now) || storedAtMs > now + 30_000 || now - storedAtMs > maximumSnapshotAgeMs) return null;
    return {
      ...structuredClone(wrapper.snapshot),
      cache: {
        state: "cached",
        storedAt: wrapper.storedAt,
        generatedAt: wrapper.snapshot.generatedAt
      }
    };
  }

  function writeSnapshot(value) {
    return enqueue(async () => {
      if (!validSnapshot(value)) return false;
      const snapshot = cloneWithoutTransientFields(value);
      const snapshotJson = JSON.stringify(snapshot);
      const wrapper = Buffer.from(JSON.stringify({
        schema: CACHE_SCHEMA,
        storedAt: timestampFromClock(clock),
        checksum: digest(snapshotJson),
        snapshot
      }), "utf8");
      if (wrapper.length > maximumSnapshotBytes) return false;
      await atomicWrite(cacheDirectory, snapshotFilename, wrapper);
      return true;
    });
  }

  async function artworkEntries() {
    const names = await readdir(artworkDirectory);
    if (names.length > MAXIMUM_DIRECTORY_ENTRIES) return [];
    const entries = [];
    for (const name of names) {
      if (!DIGEST.test(name.slice(0, -ARTWORK_SUFFIX.length)) || !name.endsWith(ARTWORK_SUFFIX)) continue;
      const filename = path.join(artworkDirectory, name);
      try {
        const status = await lstat(filename);
        if (status.isFile() && !status.isSymbolicLink() && status.nlink === 1 && status.size <= MAXIMUM_ARTWORK_FILE_BYTES) {
          entries.push({ filename, size: status.size, mtimeMs: status.mtimeMs });
        }
      } catch {
        // Concurrent pruning may remove an entry between readdir and lstat.
      }
    }
    return entries;
  }

  async function pruneArtwork() {
    const entries = await artworkEntries();
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.filename.localeCompare(right.filename));
    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let totalEntries = entries.length;
    for (const entry of entries) {
      if (totalEntries <= maximumArtworkEntries && totalBytes <= maximumArtworkBytes) break;
      await unlink(entry.filename).catch(() => {});
      totalEntries -= 1;
      totalBytes -= entry.size;
    }
  }

  async function getArtwork(key) {
    if (typeof key !== "string" || key.length < 1 || key.length > 1_024) return null;
    const keyHash = digest(key);
    const filename = path.join(artworkDirectory, `${keyHash}${ARTWORK_SUFFIX}`);
    const bytes = await readPrivateFile(filename, MAXIMUM_ARTWORK_FILE_BYTES);
    if (!bytes) return null;
    const now = Number(clock());
    if (!Number.isFinite(now)) return null;
    const entry = parseArtworkFile(bytes, keyHash, now);
    if (!entry) {
      await unlink(filename).catch(() => {});
      return null;
    }
    await utimes(filename, new Date(now), new Date(now)).catch(() => {});
    return entry;
  }

  function setArtwork(key, value) {
    return enqueue(async () => {
      if (typeof key !== "string" || key.length < 1 || key.length > 1_024) return false;
      const body = Buffer.isBuffer(value?.body) ? value.body : null;
      const contentType = String(value?.contentType || "").split(";", 1)[0].trim().toLowerCase();
      if (!body || body.length < 1 || body.length > MAXIMUM_ARTWORK_BODY_BYTES || !IMAGE_CONTENT_TYPE.test(contentType)) {
        return false;
      }
      const keyHash = digest(key);
      const storedAt = timestampFromClock(clock);
      const expiresAt = new Date(Date.parse(storedAt) + artworkTtlMs).toISOString();
      const entry = artworkFileBody(keyHash, contentType, body, storedAt, expiresAt);
      await atomicWrite(artworkDirectory, path.join(artworkDirectory, `${keyHash}${ARTWORK_SUFFIX}`), entry.bytes);
      await pruneArtwork();
      return true;
    });
  }

  async function clearArtwork() {
    return enqueue(async () => {
      for (const entry of await artworkEntries()) await unlink(entry.filename).catch(() => {});
      return true;
    });
  }

  async function close() {
    closing = true;
    await writeChain;
  }

  return Object.freeze({
    readSnapshot,
    writeSnapshot,
    artwork: Object.freeze({ get: getArtwork, set: setArtwork, clear: clearArtwork }),
    close,
    paths: Object.freeze({ cacheDirectory, artworkDirectory, snapshotFilename })
  });
}

export const PERSISTENT_CACHE_LIMITS = Object.freeze({
  schema: CACHE_SCHEMA,
  maximumArtworkBodyBytes: MAXIMUM_ARTWORK_BODY_BYTES,
  defaultMaximumArtworkBytes: DEFAULT_MAXIMUM_ARTWORK_BYTES,
  defaultMaximumArtworkEntries: DEFAULT_MAXIMUM_ARTWORK_ENTRIES,
  defaultArtworkTtlMs: DEFAULT_ARTWORK_TTL_MS,
  defaultMaximumSnapshotAgeMs: DEFAULT_MAXIMUM_SNAPSHOT_AGE_MS
});
