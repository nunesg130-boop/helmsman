import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  unlink
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const EVENT_JOURNAL_SCHEMA = 1;

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAXIMUM_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAXIMUM_SEGMENT_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_EVENT_BYTES = 2 * 1024;
const DEFAULT_MAXIMUM_QUERY_LIMIT = 200;
const MAX_DIRECTORY_ENTRIES = 4_096;
const SEGMENT_NAME = /^helmsman-events-(\d{4}-\d{2}-\d{2})-(\d{4})\.jsonl$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EVENT_TOKEN = /^[a-z][a-z0-9._-]{0,63}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;
const OPERATION_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u;
const TARGET_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const QUERY_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,100}$/u;
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u;

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const CATEGORIES = new Set([
  "application",
  "authentication",
  "configuration",
  "connector",
  "health",
  "action",
  "security"
]);
const OUTCOMES = new Set([
  "started",
  "succeeded",
  "failed",
  "denied",
  "changed",
  "recovered"
]);
const INPUT_KEYS = new Set([
  "at",
  "level",
  "category",
  "event",
  "outcome",
  "service",
  "capability",
  "operation",
  "code",
  "httpStatus",
  "targetType",
  "targetId"
]);
const STORED_KEYS = new Set(["schema", "id", ...INPUT_KEYS]);
const QUERY_KEYS = new Set(["limit", "cursor", "level", "category", "service", "from", "to", "q"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains an unsupported field: ${key}.`);
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || value.length > 40) throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function timestampFromClock(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("The event-journal clock returned an invalid time.");
  return new Date(Math.trunc(milliseconds)).toISOString();
}

function requiredSetValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is not supported.`);
  }
  return value;
}

function requiredPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function optionalPattern(output, input, key, pattern, label) {
  const value = input[key];
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw new TypeError(`${label} is invalid.`);
  if (JWT_SHAPED.test(value)) throw new TypeError(`${label} resembles a credential and is not allowed.`);
  output[key] = requiredPattern(value, pattern, label);
}

function normalizeEvent(input, options = {}) {
  const stored = options.stored === true;
  requireExactKeys(input, stored ? STORED_KEYS : INPUT_KEYS, stored ? "Stored event" : "Event");
  const output = {
    schema: EVENT_JOURNAL_SCHEMA,
    id: stored
      ? requiredPattern(input.id, UUID, "Stored event id")
      : String(options.idFactory()),
    at: stored
      ? canonicalTimestamp(input.at, "Stored event timestamp")
      : input.at === undefined
        ? timestampFromClock(options.clock)
        : canonicalTimestamp(input.at, "Event timestamp"),
    level: requiredSetValue(input.level, LEVELS, "Event level"),
    category: requiredSetValue(input.category, CATEGORIES, "Event category"),
    event: requiredPattern(input.event, EVENT_TOKEN, "Event name"),
    outcome: requiredSetValue(input.outcome, OUTCOMES, "Event outcome")
  };
  if (!UUID.test(output.id)) throw new TypeError("The event id factory returned an invalid identifier.");
  if (stored && input.schema !== EVENT_JOURNAL_SCHEMA) throw new TypeError("Stored event schema is unsupported.");
  optionalPattern(output, input, "service", IDENTIFIER, "Event service");
  optionalPattern(output, input, "capability", IDENTIFIER, "Event capability");
  optionalPattern(output, input, "operation", OPERATION_IDENTIFIER, "Event operation");
  optionalPattern(output, input, "code", SAFE_CODE, "Event code");
  optionalPattern(output, input, "targetType", IDENTIFIER, "Event target type");
  optionalPattern(output, input, "targetId", TARGET_IDENTIFIER, "Event target id");
  if (input.httpStatus !== undefined && input.httpStatus !== null) {
    if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
      throw new TypeError("Event HTTP status must be an integer from 100 through 599.");
    }
    output.httpStatus = input.httpStatus;
  }
  return output;
}

function encodeCursor(location) {
  return Buffer.from(JSON.stringify({
    segment: location.segment,
    line: location.line,
    id: location.id
  }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("Log cursor is invalid.");
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical cursor");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Log cursor is invalid.");
  }
  if (!isPlainObject(decoded)
    || Object.keys(decoded).length !== 3
    || !Object.hasOwn(decoded, "segment")
    || !Object.hasOwn(decoded, "line")
    || !Object.hasOwn(decoded, "id")
    || typeof decoded.segment !== "string"
    || !SEGMENT_NAME.test(decoded.segment)
    || !Number.isSafeInteger(decoded.line)
    || decoded.line < 0
    || decoded.line > 10_000_000
    || typeof decoded.id !== "string"
    || !UUID.test(decoded.id)) {
    throw new TypeError("Log cursor is invalid.");
  }
  return decoded;
}

function normalizeQuery(value, maximumLimit) {
  requireExactKeys(value, QUERY_KEYS, "Log query");
  const query = {
    limit: boundedInteger(value.limit, Math.min(100, maximumLimit), 1, maximumLimit, "Log query limit"),
    cursor: value.cursor === undefined || value.cursor === null || value.cursor === ""
      ? null
      : decodeCursor(value.cursor),
    level: value.level === undefined || value.level === null || value.level === ""
      ? null
      : requiredSetValue(value.level, LEVELS, "Log query level"),
    category: value.category === undefined || value.category === null || value.category === ""
      ? null
      : requiredSetValue(value.category, CATEGORIES, "Log query category"),
    service: value.service === undefined || value.service === null || value.service === ""
      ? null
      : requiredPattern(value.service, IDENTIFIER, "Log query service"),
    from: value.from === undefined || value.from === null || value.from === ""
      ? null
      : canonicalTimestamp(value.from, "Log query start"),
    to: value.to === undefined || value.to === null || value.to === ""
      ? null
      : canonicalTimestamp(value.to, "Log query end"),
    text: value.q === undefined || value.q === null || value.q === ""
      ? null
      : requiredPattern(value.q, QUERY_TEXT, "Log query text").toLowerCase()
  };
  if (query.from && query.to && query.from > query.to) {
    throw new TypeError("Log query start must not be after its end.");
  }
  return query;
}

function eventMatches(event, query) {
  if (query.level && event.level !== query.level) return false;
  if (query.category && event.category !== query.category) return false;
  if (query.service && event.service !== query.service) return false;
  if (query.from && event.at < query.from) return false;
  if (query.to && event.at > query.to) return false;
  if (query.text) {
    const searchable = [
      event.level,
      event.category,
      event.event,
      event.outcome,
      event.service,
      event.capability,
      event.operation,
      event.code,
      event.targetType,
      event.targetId
    ].filter(Boolean).join(" ").toLowerCase();
    if (!searchable.includes(query.text)) return false;
  }
  return true;
}

function clone(value) {
  return structuredClone(value);
}

export class EventJournal {
  #guard;
  #clock;
  #idFactory;
  #retentionDays;
  #retentionMs;
  #maximumBytes;
  #maximumSegmentBytes;
  #maximumEventBytes;
  #maximumQueryLimit;
  #initializePromise = null;
  #initialized = false;
  #writable = false;
  #closing = false;
  #closed = false;
  #writeChain = Promise.resolve();
  #issues = new Set();
  #segments = [];
  #activeSegment = null;
  #logsIdentity = null;
  #lastWriteAt = null;
  #totalBytes = 0;

  constructor(dataDir, options = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
      throw new TypeError("The event-journal data directory must be an absolute path.");
    }
    if (!isPlainObject(options)) throw new TypeError("Event-journal options must be an object.");
    this.dataDir = path.resolve(dataDir);
    this.logsDir = path.join(this.dataDir, "logs");
    this.#guard = typeof options.guard === "function" ? options.guard : async () => {};
    this.#clock = typeof options.now === "function" ? options.now : Date.now;
    this.#idFactory = typeof options.idFactory === "function" ? options.idFactory : randomUUID;
    this.#retentionDays = boundedInteger(
      options.retentionDays,
      DEFAULT_RETENTION_DAYS,
      1,
      3_650,
      "Event-journal retentionDays"
    );
    this.#retentionMs = this.#retentionDays * 24 * 60 * 60 * 1_000;
    this.#maximumEventBytes = boundedInteger(
      options.maximumEventBytes,
      DEFAULT_MAXIMUM_EVENT_BYTES,
      256,
      64 * 1024,
      "Event-journal maximumEventBytes"
    );
    this.#maximumSegmentBytes = boundedInteger(
      options.maximumSegmentBytes,
      DEFAULT_MAXIMUM_SEGMENT_BYTES,
      this.#maximumEventBytes,
      64 * 1024 * 1024,
      "Event-journal maximumSegmentBytes"
    );
    this.#maximumBytes = boundedInteger(
      options.maximumBytes,
      DEFAULT_MAXIMUM_BYTES,
      this.#maximumSegmentBytes,
      1024 * 1024 * 1024,
      "Event-journal maximumBytes"
    );
    this.#maximumQueryLimit = boundedInteger(
      options.maximumQueryLimit,
      DEFAULT_MAXIMUM_QUERY_LIMIT,
      1,
      1_000,
      "Event-journal maximumQueryLimit"
    );
  }

  initialize() {
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = this.#initialize().catch(() => {
      this.#markIssue("LOG_INITIALIZATION_FAILED");
      this.#writable = false;
    }).finally(() => {
      this.#initialized = true;
    });
    return this.#initializePromise;
  }

  record(input) {
    if (this.#closing || this.#closed) throw new Error("The event journal is closed.");
    const event = normalizeEvent(input, { clock: this.#clock, idFactory: this.#idFactory });
    const serialized = `${JSON.stringify(event)}\n`;
    const byteLength = Buffer.byteLength(serialized);
    if (byteLength > this.#maximumEventBytes) {
      throw new RangeError("The event exceeded the event-journal size limit.");
    }
    const operation = this.#writeChain.catch(() => {}).then(async () => {
      if (!this.#initialized) await this.initialize();
      if (!this.#writable) return null;
      try {
        await this.#append(Buffer.from(serialized, "utf8"));
        return clone(event);
      } catch {
        this.#markIssue("LOG_WRITE_FAILED");
        this.#writable = false;
        return null;
      }
    });
    this.#writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  async query(options = {}) {
    const query = normalizeQuery(options, this.#maximumQueryLimit);
    if (!this.#initialized) await this.initialize();
    await this.#writeChain.catch(() => {});
    const segments = await this.#listSegments({ hardenPermissions: false });
    const names = segments.map(({ name }) => name).sort().reverse();
    let cursorStarted = query.cursor === null;
    if (query.cursor && !names.includes(query.cursor.segment)) {
      throw new TypeError("Log cursor is no longer available.");
    }
    const matches = [];
    let lastReturnedLocation = null;
    let hasMore = false;

    for (const name of names) {
      if (!cursorStarted && name !== query.cursor.segment) continue;
      const segment = segments.find((candidate) => candidate.name === name);
      const parsed = await this.#readSegment(segment);
      let lineIndex = parsed.events.length - 1;
      if (!cursorStarted) {
        const cursorEvent = parsed.events[query.cursor.line];
        if (!cursorEvent || cursorEvent.id !== query.cursor.id) {
          throw new TypeError("Log cursor is invalid for the current journal.");
        }
        lineIndex = query.cursor.line - 1;
        cursorStarted = true;
      }
      for (; lineIndex >= 0; lineIndex -= 1) {
        const event = parsed.events[lineIndex];
        if (!event || !eventMatches(event, query)) continue;
        if (matches.length >= query.limit) {
          hasMore = true;
          break;
        }
        matches.push(event);
        lastReturnedLocation = { segment: name, line: lineIndex, id: event.id };
      }
      if (hasMore) break;
    }

    return {
      schema: EVENT_JOURNAL_SCHEMA,
      generatedAt: timestampFromClock(this.#clock),
      storage: this.status(),
      entries: clone(matches),
      nextCursor: hasMore && lastReturnedLocation ? encodeCursor(lastReturnedLocation) : null
    };
  }

  status() {
    return {
      state: this.#issues.size ? "degraded" : "healthy",
      persistent: true,
      writable: this.#writable && !this.#closing && !this.#closed,
      closed: this.#closed,
      retentionDays: this.#retentionDays,
      maximumBytes: this.#maximumBytes,
      maximumSegmentBytes: this.#maximumSegmentBytes,
      maximumEventBytes: this.#maximumEventBytes,
      totalBytes: this.#totalBytes,
      lastWriteAt: this.#lastWriteAt,
      issueCodes: [...this.#issues].sort()
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closing = true;
    if (!this.#initialized) await this.initialize();
    await this.#writeChain.catch(() => {});
    this.#writable = false;
    this.#closed = true;
  }

  async #initialize() {
    await this.#guard();
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const dataMetadata = await lstat(this.dataDir);
    if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) {
      this.#markIssue("LOG_DATA_DIRECTORY_UNSAFE");
      return;
    }
    await chmod(this.dataDir, 0o700);
    await mkdir(this.logsDir, { recursive: true, mode: 0o700 });
    const logsMetadata = await lstat(this.logsDir);
    if (!logsMetadata.isDirectory() || logsMetadata.isSymbolicLink()) {
      this.#markIssue("LOG_DIRECTORY_UNSAFE");
      return;
    }
    await chmod(this.logsDir, 0o700);
    this.#logsIdentity = { dev: logsMetadata.dev, ino: logsMetadata.ino };
    this.#writable = true;
    await this.#refreshSegments({ prune: true, validate: true });
    this.#selectActiveSegment();
  }

  async #append(bytes) {
    await this.#guard();
    if (!await this.#verifyLogsDirectory()) {
      throw new Error("The event-journal directory changed unexpectedly.");
    }
    const writeTimestamp = timestampFromClock(this.#clock);
    const clockDate = writeTimestamp.slice(0, 10);
    const latestDate = this.#segments.at(-1)?.name.match(SEGMENT_NAME)?.[1];
    // Keep the segment namespace monotonic when the host clock moves backward
    // across UTC midnight. Query order is append order, not wall-clock order.
    const date = latestDate && latestDate > clockDate ? latestDate : clockDate;
    if (!this.#activeSegment
      || !this.#activeSegment.name.startsWith(`helmsman-events-${date}-`)
      || this.#activeSegment.size + bytes.length > this.#maximumSegmentBytes) {
      await this.#createSegment(date);
    }

    let handle;
    try {
      const flags = fsConstants.O_WRONLY
        | fsConstants.O_APPEND
        | (fsConstants.O_NOFOLLOW || 0)
        | (fsConstants.O_NONBLOCK || 0);
      handle = await open(this.#activeSegment.path, flags);
      const metadata = await handle.stat();
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== this.#activeSegment.dev
        || metadata.ino !== this.#activeSegment.ino
        || metadata.size !== this.#activeSegment.size
        || metadata.size + bytes.length > this.#maximumSegmentBytes) {
        throw new Error("The active event-journal segment changed unexpectedly.");
      }
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.datasync();
      this.#activeSegment.size += bytes.length;
      this.#activeSegment.mtimeMs = Date.parse(writeTimestamp);
      this.#totalBytes += bytes.length;
      this.#lastWriteAt = writeTimestamp;
    } finally {
      await handle?.close().catch(() => {});
    }
    // The record is durable after datasync. Retention is maintenance: a
    // subsequent maintenance failure must not make callers retry and create a
    // duplicate event that was already persisted.
    try {
      await this.#pruneSegments(this.#activeSegment.name);
    } catch {
      this.#markIssue("LOG_RETENTION_FAILED");
    }
  }

  async #createSegment(date) {
    if (!await this.#verifyLogsDirectory()) {
      throw new Error("The event-journal directory changed unexpectedly.");
    }
    const existingIndexes = this.#segments.flatMap(({ name }) => {
      const match = name.match(SEGMENT_NAME);
      return match?.[1] === date ? [Number(match[2])] : [];
    });
    let index = existingIndexes.length ? Math.max(...existingIndexes) + 1 : 0;
    for (; index <= 9_999; index += 1) {
      const name = `helmsman-events-${date}-${String(index).padStart(4, "0")}.jsonl`;
      const filePath = path.join(this.logsDir, name);
      let handle;
      try {
        const flags = fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_WRONLY
          | fsConstants.O_APPEND
          | (fsConstants.O_NOFOLLOW || 0)
          | (fsConstants.O_NONBLOCK || 0);
        handle = await open(filePath, flags, 0o600);
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1) {
          throw new Error("The event-journal segment is not a private regular file.");
        }
        await handle.chmod(0o600);
        await handle.sync();
        const segment = {
          name,
          path: filePath,
          size: 0,
          mtimeMs: metadata.mtimeMs,
          dev: metadata.dev,
          ino: metadata.ino,
          appendable: true
        };
        this.#segments.push(segment);
        this.#segments.sort((left, right) => left.name.localeCompare(right.name));
        this.#activeSegment = segment;
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        this.#markIssue("LOG_SEGMENT_COLLISION");
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    throw new Error("The event journal exhausted its daily segment namespace.");
  }

  async #refreshSegments(options = {}) {
    this.#segments = await this.#listSegments({ hardenPermissions: true });
    if (options.prune) await this.#pruneSegments(null);
    if (options.validate) {
      for (const segment of this.#segments) {
        const parsed = await this.#readSegment(segment);
        segment.appendable = parsed.complete && !parsed.malformed;
      }
    }
    this.#totalBytes = this.#segments.reduce((total, segment) => total + segment.size, 0);
  }

  async #listSegments(options = {}) {
    if (!await this.#verifyLogsDirectory()) return [];
    let entries;
    try {
      entries = await readdir(this.logsDir, { withFileTypes: true });
    } catch {
      this.#markIssue("LOG_DIRECTORY_UNAVAILABLE");
      this.#writable = false;
      return [];
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      this.#markIssue("LOG_DIRECTORY_ENTRY_LIMIT");
      // Do not add more data when the directory is outside the journal's
      // operational bound. Existing named segments are still inspected so
      // their bytes cannot disappear from accounting or retention.
      this.#writable = false;
    }
    const segments = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!SEGMENT_NAME.test(entry.name)) continue;
      const filePath = path.join(this.logsDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        this.#markIssue("LOG_SEGMENT_UNSAFE");
        continue;
      }
      try {
        const metadata = await lstat(filePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          this.#markIssue("LOG_SEGMENT_UNSAFE");
          continue;
        }
        const oversized = metadata.size > this.#maximumSegmentBytes;
        if (metadata.nlink !== 1) {
          this.#markIssue("LOG_SEGMENT_UNSAFE");
          continue;
        }
        if (oversized) this.#markIssue("LOG_SEGMENT_OVERSIZE");
        if (options.hardenPermissions) {
          let handle;
          try {
            const flags = fsConstants.O_RDONLY
              | (fsConstants.O_NOFOLLOW || 0)
              | (fsConstants.O_NONBLOCK || 0);
            handle = await open(filePath, flags);
            const openedMetadata = await handle.stat();
            if (!openedMetadata.isFile()
              || openedMetadata.nlink !== 1
              || openedMetadata.dev !== metadata.dev
              || openedMetadata.ino !== metadata.ino) {
              this.#markIssue("LOG_SEGMENT_UNSAFE");
              continue;
            }
            await handle.chmod(0o600);
          } finally {
            await handle?.close().catch(() => {});
          }
        }
        segments.push({
          name: entry.name,
          path: filePath,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          dev: metadata.dev,
          ino: metadata.ino,
          oversized,
          appendable: false
        });
      } catch {
        this.#markIssue("LOG_SEGMENT_UNAVAILABLE");
      }
    }
    segments.sort((left, right) => left.name.localeCompare(right.name));
    this.#totalBytes = segments.reduce((total, segment) => total + segment.size, 0);
    return segments;
  }

  async #readSegment(segment) {
    let handle;
    try {
      const flags = fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW || 0)
        | (fsConstants.O_NONBLOCK || 0);
      handle = await open(segment.path, flags);
      const metadata = await handle.stat();
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== segment.dev
        || metadata.ino !== segment.ino
        || metadata.size > this.#maximumSegmentBytes) {
        this.#markIssue("LOG_SEGMENT_UNSAFE");
        return { events: [], complete: false, malformed: true };
      }
      const bytes = Buffer.alloc(metadata.size);
      if (metadata.size) {
        const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
        if (bytesRead !== metadata.size) throw new Error("The event-journal segment could not be read completely.");
      }
      const text = bytes.toString("utf8");
      bytes.fill(0);
      const complete = text.length === 0 || text.endsWith("\n");
      if (!complete) this.#markIssue("LOG_SEGMENT_TRUNCATED");
      const rawLines = text.split("\n");
      if (rawLines.at(-1) === "") rawLines.pop();
      else rawLines.pop();
      const events = [];
      let malformed = false;
      for (const line of rawLines) {
        if (!line || Buffer.byteLength(line) + 1 > this.#maximumEventBytes) {
          malformed = true;
          events.push(null);
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          events.push(normalizeEvent(parsed, {
            stored: true,
            clock: this.#clock,
            idFactory: this.#idFactory
          }));
        } catch {
          malformed = true;
          events.push(null);
        }
      }
      if (malformed) this.#markIssue("LOG_SEGMENT_MALFORMED");
      return { events, complete, malformed };
    } catch {
      this.#markIssue("LOG_SEGMENT_UNAVAILABLE");
      return { events: [], complete: false, malformed: true };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #pruneSegments(protectedName) {
    await this.#guard();
    if (!await this.#verifyLogsDirectory()) return;
    const cutoff = Number(this.#clock()) - this.#retentionMs;
    const retained = [];
    for (const segment of this.#segments) {
      if (segment.name !== protectedName && segment.mtimeMs < cutoff) {
        if (!await this.#removeSegment(segment)) retained.push(segment);
      } else {
        retained.push(segment);
      }
    }
    this.#segments = retained;
    let total = this.#segments.reduce((sum, segment) => sum + segment.size, 0);
    for (const segment of [...this.#segments]) {
      if (total <= this.#maximumBytes) break;
      if (segment.name === protectedName) continue;
      if (await this.#removeSegment(segment)) {
        this.#segments = this.#segments.filter(({ name }) => name !== segment.name);
        total -= segment.size;
      }
    }
    this.#totalBytes = total;
    if (total > this.#maximumBytes) this.#markIssue("LOG_RETENTION_LIMIT");
  }

  async #removeSegment(segment) {
    try {
      const metadata = await lstat(segment.path);
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || metadata.dev !== segment.dev
        || metadata.ino !== segment.ino) {
        this.#markIssue("LOG_SEGMENT_UNSAFE");
        return false;
      }
      await unlink(segment.path);
      if (this.#activeSegment?.name === segment.name) this.#activeSegment = null;
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      this.#markIssue("LOG_RETENTION_FAILED");
      return false;
    }
  }

  #selectActiveSegment() {
    const clockDate = timestampFromClock(this.#clock).slice(0, 10);
    const latestDate = this.#segments.at(-1)?.name.match(SEGMENT_NAME)?.[1];
    const today = latestDate && latestDate > clockDate ? latestDate : clockDate;
    const latest = [...this.#segments].reverse().find((segment) => (
      segment.name.startsWith(`helmsman-events-${today}-`)
    ));
    // Once a newer segment exists, never append to an older same-day segment.
    // Doing so would make file order disagree with append order and could make
    // cursor pagination skip or repeat records.
    this.#activeSegment = latest?.appendable && latest.size < this.#maximumSegmentBytes
      ? latest
      : null;
  }

  #markIssue(code) {
    if (this.#issues.size < 32) this.#issues.add(code);
  }

  async #verifyLogsDirectory() {
    if (!this.#logsIdentity) return false;
    try {
      const metadata = await lstat(this.logsDir);
      const safe = metadata.isDirectory()
        && !metadata.isSymbolicLink()
        && metadata.dev === this.#logsIdentity.dev
        && metadata.ino === this.#logsIdentity.ino;
      if (safe) return true;
    } catch {
      // Fall through to one stable, non-sensitive status code.
    }
    this.#markIssue("LOG_DIRECTORY_UNSAFE");
    this.#writable = false;
    return false;
  }
}

export async function createEventJournal(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("Event-journal options must be an object.");
  const allowed = new Set([
    "dataDir",
    "guard",
    "now",
    "idFactory",
    "retentionDays",
    "maximumBytes",
    "maximumSegmentBytes",
    "maximumEventBytes",
    "maximumQueryLimit"
  ]);
  requireExactKeys(options, allowed, "Event-journal options");
  const journal = new EventJournal(options.dataDir, options);
  await journal.initialize();
  return journal;
}

export const EVENT_JOURNAL_LIMITS = Object.freeze({
  retentionDays: DEFAULT_RETENTION_DAYS,
  maximumBytes: DEFAULT_MAXIMUM_BYTES,
  maximumSegmentBytes: DEFAULT_MAXIMUM_SEGMENT_BYTES,
  maximumEventBytes: DEFAULT_MAXIMUM_EVENT_BYTES,
  maximumQueryLimit: DEFAULT_MAXIMUM_QUERY_LIMIT
});
