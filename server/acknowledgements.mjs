import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

// Operator acknowledgements ("Ignore") for individual health reports.
//
// A report is identified by a stable fingerprint of where it came from and
// what it says. While a report is acknowledged it no longer lowers health. An
// acknowledgement is retired automatically once its report has been absent
// for RETENTION_MS, so a problem that clears and later recurs alerts again.
//
// The store lives beside state.json in its own file so the security-critical
// broker state schema is untouched. It holds only report text the operator
// already sees in the dashboard; it never contains credentials.

const FILE_NAME = "acknowledgements.json";
const FILE_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1_000;
const REPORT_ID = /^[a-f0-9]{32}$/u;
const SEVERITIES = new Set(["notice", "warning", "error"]);
const MONITOR_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/u;
const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const ACKNOWLEDGEMENT_LIMITS = Object.freeze({
  entries: MAX_ENTRIES,
  retentionMs: RETENTION_MS
});

export function isReportId(value) {
  return typeof value === "string" && REPORT_ID.test(value);
}

/**
 * Stable 128-bit identity for one report from one check of one monitored
 * connection. Connection ids include their UUID, so re-creating a connection
 * starts with a clean slate.
 */
export function reportFingerprint(monitorId, capability, report) {
  return createHash("sha256")
    .update(JSON.stringify([
      "helmsman-report-v1",
      String(monitorId ?? ""),
      String(capability ?? ""),
      String(report?.severity ?? ""),
      String(report?.source ?? ""),
      String(report?.message ?? "")
    ]))
    .digest("hex")
    .slice(0, 32);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !CONTROL.test(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validEntry(value) {
  return isPlainObject(value)
    && isReportId(value.id)
    && typeof value.monitor === "string" && MONITOR_ID.test(value.monitor)
    && typeof value.capability === "string" && CAPABILITY_ID.test(value.capability)
    && SEVERITIES.has(value.severity)
    && boundedText(value.source, 96)
    && boundedText(value.message, 600)
    && (value.label === undefined || boundedText(value.label, 80))
    && canonicalTimestamp(value.acknowledgedAt) !== null
    && canonicalTimestamp(value.lastSeenAt) !== null;
}

function publicEntry(entry) {
  return {
    id: entry.id,
    monitor: entry.monitor,
    capability: entry.capability,
    severity: entry.severity,
    source: entry.source,
    message: entry.message,
    ...(entry.label ? { label: entry.label } : {}),
    acknowledgedAt: entry.acknowledgedAt,
    lastSeenAt: entry.lastSeenAt
  };
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
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Acknowledgements exceeded their size limit.");
  const temporary = path.join(dataDir, `.acknowledgements-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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

export async function createAcknowledgementStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The acknowledgement store requires an absolute data directory.");
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
      if (validEntry(entry) && !entries.has(entry.id)) entries.set(entry.id, publicEntry(entry));
    }
  }

  function nowIso() {
    return new Date(Math.trunc(Number(clock()))).toISOString();
  }

  function persist() {
    const snapshot = { version: FILE_VERSION, entries: [...entries.values()].map(publicEntry) };
    const operation = writeChain.catch(() => {}).then(async () => {
      await guard();
      await atomicWrite(dataDir, filePath, snapshot);
    });
    writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  function prune(nowMs) {
    let changed = false;
    for (const [id, entry] of entries) {
      if (nowMs - canonicalTimestamp(entry.lastSeenAt) > RETENTION_MS) {
        entries.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  return {
    has(id) {
      return entries.has(id);
    },

    list() {
      return [...entries.values()]
        .map(publicEntry)
        .sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
    },

    async add(report) {
      const at = nowIso();
      const entry = publicEntry({
        id: report?.id,
        monitor: report?.monitor,
        capability: report?.capability,
        severity: report?.severity,
        source: report?.source,
        message: report?.message,
        ...(report?.label ? { label: report.label } : {}),
        acknowledgedAt: at,
        lastSeenAt: at
      });
      if (!validEntry(entry)) throw new TypeError("That report cannot be ignored.");
      if (!entries.has(entry.id) && entries.size >= MAX_ENTRIES) {
        const error = new Error("Too many warnings are ignored. Restore some before ignoring more.");
        error.code = "ACKNOWLEDGEMENT_LIMIT";
        throw error;
      }
      entries.set(entry.id, entry);
      await persist();
      return publicEntry(entry);
    },

    async remove(id) {
      if (!isReportId(id) || !entries.delete(id)) return false;
      await persist();
      return true;
    },

    /**
     * Called once per monitoring cycle with every acknowledged report id that
     * is still being reported. Refreshes their last-seen time (coarsely, to
     * avoid a disk write every cycle) and retires acknowledgements whose
     * report has been gone for longer than the retention window.
     */
    async observe(seenIds) {
      const nowMs = Math.trunc(Number(clock()));
      const at = new Date(nowMs).toISOString();
      let changed = false;
      for (const id of seenIds || []) {
        const entry = entries.get(id);
        if (entry && nowMs - canonicalTimestamp(entry.lastSeenAt) >= TOUCH_INTERVAL_MS) {
          entries.set(id, { ...entry, lastSeenAt: at });
          changed = true;
        }
      }
      if (prune(nowMs)) changed = true;
      if (changed) await persist();
      return changed;
    }
  };
}
