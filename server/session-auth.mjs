import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

const SESSION_STATE_VERSION = 4;
const LEGACY_SESSION_STATE_VERSION = 1;
const ACCESS_KEY_SESSION_STATE_VERSION = 2;
const JELLYFIN_OWNER_SESSION_STATE_VERSION = 3;
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 64;
const MAX_SESSION_STATE_BYTES = 256 * 1_024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0020\u007f-\u009f/@?#\\]/u;
const DEFAULT_COOKIE_NAME = "JFC_SESSION";
const DEFAULT_CSRF_HEADER = "x-jellofin-csrf";
const JELLYFIN_PROVIDER = "jellyfin";
const PREPARED_OWNER_SESSION_PLANS = new WeakMap();

export class SessionAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SessionAuthError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new SessionAuthError(status, code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function tokenHash(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

function accessKeyMatches(storedHash, presentedKey) {
  if (typeof storedHash !== "string" || !TOKEN_HASH_PATTERN.test(storedHash) || !validToken(presentedKey)) {
    return false;
  }
  const expected = Buffer.from(storedHash, "hex");
  const presented = Buffer.from(tokenHash(presentedKey), "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

function safeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function nowMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("The session clock returned an invalid time.");
  return Math.trunc(milliseconds);
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function parseIsoTime(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && isoTime(milliseconds) === value ? milliseconds : null;
}

function safeSessionName(value) {
  if (typeof value !== "string") {
    fail(400, "INVALID_SESSION_NAME", "Enter a name for this browser session.");
  }
  const normalized = value.trim();
  if (!normalized
    || normalized.length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    fail(400, "INVALID_SESSION_NAME", "Enter a browser session name between 1 and 80 characters.");
  }
  return normalized;
}

function safeIdentityText(value, fieldName, maximumLength = 256) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new Error(`The Jellyfin ${fieldName} is invalid.`);
  }
  return value;
}

function canonicalJellyfinUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new Error("The Jellyfin URL is invalid.");
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !parsed.hostname
      || parsed.pathname.includes("//")) {
      throw new Error("invalid URL shape");
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
    const canonical = `${parsed.origin}${pathname}`;
    if (canonical !== value) throw new Error("non-canonical URL");
    return canonical;
  } catch {
    throw new Error("The Jellyfin URL is invalid.");
  }
}

function normalizeOwner(value, enrolledAt) {
  if (!isPlainObject(value)
    || value.provider !== JELLYFIN_PROVIDER
    || !hasExactKeys(value, value.enrolledAt === undefined
      ? ["provider", "serverId", "userId", "username", "jellyfinUrl", "targetRevision", "boundaryHash"]
      : ["provider", "serverId", "userId", "username", "jellyfinUrl", "targetRevision", "boundaryHash", "enrolledAt"])) {
    throw new Error("The Jellyfin owner identity is invalid.");
  }
  const normalizedEnrolledAt = value.enrolledAt === undefined ? enrolledAt : value.enrolledAt;
  if (parseIsoTime(normalizedEnrolledAt) === null) {
    throw new Error("The Jellyfin owner enrollment time is invalid.");
  }
  const targetRevision = safeIdentityText(value.targetRevision, "target revision", 128);
  if (!UUID_PATTERN.test(targetRevision)) throw new Error("The Jellyfin target revision is invalid.");
  const boundaryHash = safeIdentityText(value.boundaryHash, "authorization boundary", 64);
  if (!TOKEN_HASH_PATTERN.test(boundaryHash)) throw new Error("The Jellyfin authorization boundary is invalid.");
  return {
    provider: JELLYFIN_PROVIDER,
    serverId: safeIdentityText(value.serverId, "server ID"),
    userId: safeIdentityText(value.userId, "user ID"),
    username: safeIdentityText(value.username, "username"),
    jellyfinUrl: canonicalJellyfinUrl(value.jellyfinUrl),
    targetRevision,
    boundaryHash,
    enrolledAt: normalizedEnrolledAt
  };
}

function normalizePrincipal(value, verifiedAt) {
  if (!isPlainObject(value)
    || value.provider !== JELLYFIN_PROVIDER
    || !hasExactKeys(value, value.verifiedAt === undefined
      ? ["provider", "serverId", "userId", "username", "deviceId", "jellyfinUrl", "targetRevision", "boundaryHash"]
      : ["provider", "serverId", "userId", "username", "deviceId", "jellyfinUrl", "targetRevision", "boundaryHash", "verifiedAt"])) {
    throw new Error("The Jellyfin session identity is invalid.");
  }
  const normalizedVerifiedAt = value.verifiedAt === undefined ? verifiedAt : value.verifiedAt;
  if (parseIsoTime(normalizedVerifiedAt) === null) {
    throw new Error("The Jellyfin session verification time is invalid.");
  }
  const deviceId = safeIdentityText(value.deviceId, "device ID", 128);
  if (!UUID_PATTERN.test(deviceId)) throw new Error("The Jellyfin device ID is invalid.");
  const targetRevision = safeIdentityText(value.targetRevision, "target revision", 128);
  if (!UUID_PATTERN.test(targetRevision)) throw new Error("The Jellyfin target revision is invalid.");
  const boundaryHash = safeIdentityText(value.boundaryHash, "authorization boundary", 64);
  if (!TOKEN_HASH_PATTERN.test(boundaryHash)) throw new Error("The Jellyfin authorization boundary is invalid.");
  return {
    provider: JELLYFIN_PROVIDER,
    serverId: safeIdentityText(value.serverId, "server ID"),
    userId: safeIdentityText(value.userId, "user ID"),
    username: safeIdentityText(value.username, "username"),
    deviceId,
    jellyfinUrl: canonicalJellyfinUrl(value.jellyfinUrl),
    targetRevision,
    boundaryHash,
    verifiedAt: normalizedVerifiedAt
  };
}

function sameOwnerAccount(owner, identity) {
  return isPlainObject(owner)
    && isPlainObject(identity)
    && owner.provider === JELLYFIN_PROVIDER
    && identity.provider === JELLYFIN_PROVIDER
    && safeEqualText(owner.serverId, identity.serverId)
    && safeEqualText(owner.userId, identity.userId);
}

function sameOwnerIdentity(owner, identity) {
  return sameOwnerAccount(owner, identity)
    && safeEqualText(owner.jellyfinUrl, identity.jellyfinUrl)
    && safeEqualText(owner.targetRevision, identity.targetRevision)
    && safeEqualText(owner.boundaryHash, identity.boundaryHash);
}

function safeCookieName(value) {
  if (typeof value !== "string" || !COOKIE_NAME_PATTERN.test(value)) {
    throw new Error("The session cookie name is invalid.");
  }
  return value;
}

export function canonicalHost(value) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 255
    || CONTROL_CHARACTERS.test(value)) {
    fail(421, "HOST_REJECTED", "The request Host is not accepted.");
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
      || parsed.host.toLowerCase() !== value.toLowerCase()) {
      throw new Error("non-canonical host");
    }
    return parsed.host.toLowerCase();
  } catch {
    fail(421, "HOST_REJECTED", "The request Host is not accepted.");
  }
}

export function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value === "null") {
    fail(403, "ORIGIN_REJECTED", "The request Origin is not accepted.");
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin !== value
      || parsed.pathname !== "/"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
      throw new Error("non-canonical origin");
    }
    return parsed.origin;
  } catch {
    fail(403, "ORIGIN_REJECTED", "The request Origin is not accepted.");
  }
}

function cleanHostname(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

export function isSecureApplicationOrigin(value) {
  let origin;
  try {
    origin = canonicalOrigin(value);
  } catch {
    return false;
  }
  const url = new URL(origin);
  if (url.protocol === "https:") return true;
  const hostname = cleanHostname(url.hostname);
  return url.protocol === "http:"
    && (hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "::1"
      || hostname.startsWith("127."));
}

export function requestBinding(request, options = {}) {
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") {
    fail(400, "INVALID_REQUEST", "The request headers are unavailable.");
  }
  const host = canonicalHost(headers.host);
  const rawOrigin = headers.origin;
  if (rawOrigin === undefined && !options.requireOrigin) return { host, origin: null };
  if (typeof rawOrigin !== "string") {
    fail(403, "ORIGIN_REJECTED", "The request Origin is not accepted.");
  }
  const origin = canonicalOrigin(rawOrigin);
  if (new URL(origin).host.toLowerCase() !== host) {
    fail(403, "ORIGIN_REJECTED", "The request Origin does not match its Host.");
  }
  return { host, origin };
}

export function claimRequestBinding(request, expectedOrigin) {
  const binding = requestBinding(request, { requireOrigin: true });
  const claimedOrigin = canonicalOrigin(expectedOrigin);
  if (binding.origin !== claimedOrigin || !isSecureApplicationOrigin(claimedOrigin)) {
    fail(400, "SECURE_ORIGIN_REQUIRED", "First-time setup requires HTTPS or a localhost origin.");
  }
  return binding;
}

export function assertRequestBinding(request, expected, options = {}) {
  if (!isPlainObject(expected)) {
    fail(401, "SESSION_INVALID", "The browser session binding is invalid.");
  }
  let expectedOrigin;
  let expectedHost;
  try {
    expectedOrigin = canonicalOrigin(expected.origin);
    expectedHost = canonicalHost(expected.host);
  } catch {
    fail(401, "SESSION_INVALID", "The browser session binding is invalid.");
  }
  if (new URL(expectedOrigin).host.toLowerCase() !== expectedHost) {
    fail(401, "SESSION_INVALID", "The browser session binding is invalid.");
  }
  const actual = requestBinding(request, { requireOrigin: options.requireOrigin === true });
  if (actual.host !== expectedHost || (actual.origin && actual.origin !== expectedOrigin)) {
    fail(403, "ORIGIN_REJECTED", "This browser session is not valid for this application origin.");
  }
  return actual;
}

export function readSessionCookie(rawHeader, options = {}) {
  const cookieName = safeCookieName(options.cookieName || DEFAULT_COOKIE_NAME);
  if (rawHeader === undefined || rawHeader === null || rawHeader === "") return null;
  if (typeof rawHeader !== "string" || rawHeader.length > 8_192) {
    fail(401, "SESSION_INVALID", "The browser session cookie is invalid.");
  }
  const matches = [];
  for (const component of rawHeader.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1) continue;
    const name = component.slice(0, separator).trim();
    if (name !== cookieName) continue;
    matches.push(component.slice(separator + 1).trim());
  }
  if (matches.length > 1) {
    fail(400, "AMBIGUOUS_SESSION_COOKIE", "Multiple browser session cookies were rejected.");
  }
  if (!matches.length) return null;
  if (!validToken(matches[0])) {
    fail(401, "SESSION_INVALID", "The browser session cookie is invalid.");
  }
  return matches[0];
}

function secureCookie(origin) {
  return new URL(canonicalOrigin(origin)).protocol === "https:";
}

export function sessionCookie(token, options) {
  if (!validToken(token)) throw new Error("The session token is invalid.");
  if (!isPlainObject(options)) throw new Error("Session cookie options are required.");
  const name = safeCookieName(options.cookieName || DEFAULT_COOKIE_NAME);
  const expiresAt = options.expiresAt instanceof Date
    ? options.expiresAt.getTime()
    : Date.parse(String(options.expiresAt || ""));
  const currentTime = options.now instanceof Date
    ? options.now.getTime()
    : options.now === undefined
      ? Date.now()
      : Number(options.now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(currentTime) || expiresAt <= currentTime) {
    throw new Error("The session cookie expiration is invalid.");
  }
  const maxAge = Math.max(1, Math.floor((expiresAt - currentTime) / 1_000));
  const attributes = [
    `${name}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (secureCookie(options.origin)) attributes.push("Secure");
  return attributes.join("; ");
}

export function expiredSessionCookie(options) {
  if (!isPlainObject(options)) throw new Error("Session cookie options are required.");
  const name = safeCookieName(options.cookieName || DEFAULT_COOKIE_NAME);
  const attributes = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (secureCookie(options.origin)) attributes.push("Secure");
  return attributes.join("; ");
}

function csrfForRecord(record) {
  return createHmac("sha256", Buffer.from(record.tokenHash, "hex"))
    .update(`jellofin-command-csrf-v1\0${record.id}`, "utf8")
    .digest("base64url");
}

function requireCsrf(request, record, headerName) {
  const presented = request?.headers?.[headerName];
  if (typeof presented !== "string") {
    fail(403, "CSRF_TOKEN_REQUIRED", "A CSRF token is required for this request.");
  }
  if (!TOKEN_PATTERN.test(presented) || !safeEqualText(csrfForRecord(record), presented)) {
    fail(403, "CSRF_TOKEN_INVALID", "The CSRF token is invalid.");
  }
}

function initialSessionState() {
  return {
    version: SESSION_STATE_VERSION,
    revision: 0,
    accessKeyHash: null,
    owner: null,
    sessions: {},
    integrity: null
  };
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

function validStoredOwner(owner) {
  if (owner === null) return true;
  try {
    if (!hasExactKeys(owner, [
      "provider",
      "serverId",
      "userId",
      "username",
      "jellyfinUrl",
      "targetRevision",
      "boundaryHash",
      "enrolledAt"
    ])) return false;
    normalizeOwner(owner, owner.enrolledAt);
    return true;
  } catch {
    return false;
  }
}

function validStoredPrincipal(principal) {
  if (principal === null) return true;
  try {
    if (!hasExactKeys(principal, [
      "provider",
      "serverId",
      "userId",
      "username",
      "deviceId",
      "jellyfinUrl",
      "targetRevision",
      "boundaryHash",
      "verifiedAt"
    ])) return false;
    normalizePrincipal(principal, principal.verifiedAt);
    return true;
  } catch {
    return false;
  }
}

function validStoredRecord(id, record, options = {}) {
  const expectedKeys = options.legacy === true
    ? ["id", "name", "origin", "host", "tokenHash", "createdAt", "expiresAt"]
    : ["id", "name", "origin", "host", "tokenHash", "createdAt", "expiresAt", "principal"];
  if (!UUID_PATTERN.test(id)
    || !isPlainObject(record)
    || !hasExactKeys(record, expectedKeys)
    || record.id !== id
    || typeof record.name !== "string"
    || !record.name
    || record.name.length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(record.name)
    || typeof record.origin !== "string"
    || typeof record.host !== "string"
    || typeof record.tokenHash !== "string"
    || !TOKEN_HASH_PATTERN.test(record.tokenHash)
    || (options.legacy !== true && !validStoredPrincipal(record.principal))) return false;
  const createdAt = parseIsoTime(record.createdAt);
  const expiresAt = parseIsoTime(record.expiresAt);
  if (createdAt === null || expiresAt === null || expiresAt <= createdAt) return false;
  try {
    return canonicalOrigin(record.origin) === record.origin
      && canonicalHost(record.host) === record.host
      && new URL(record.origin).host.toLowerCase() === record.host;
  } catch {
    return false;
  }
}

export function jellyfinSessionCredentialBinding(record) {
  if (!isPlainObject(record)
    || typeof record.id !== "string"
    || !validStoredRecord(record.id, record)
    || record.principal === null) {
    throw new Error("The Jellyfin browser session binding is invalid.");
  }
  const principal = record.principal;
  return createHash("sha256").update(JSON.stringify([
    "helmsman-jellyfin-browser-credential-v1",
    record.id,
    record.tokenHash,
    record.origin,
    record.host,
    record.createdAt,
    record.expiresAt,
    principal.provider,
    principal.serverId,
    principal.userId,
    principal.deviceId,
    principal.jellyfinUrl,
    principal.targetRevision,
    principal.boundaryHash
  ]), "utf8").digest("hex");
}

function validateSessionRecords(value, maximumSessions, options = {}) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !isPlainObject(value.sessions)) {
    throw new Error("Unsupported or malformed session state.");
  }
  const entries = Object.entries(value.sessions);
  if (entries.length > maximumSessions
    || entries.some(([id, record]) => !validStoredRecord(id, record, options))) {
    throw new Error("Malformed browser session state.");
  }
}

function validateSessionState(value, maximumSessions, options = {}) {
  if (!isPlainObject(value)
    || value.version !== SESSION_STATE_VERSION
    || !hasExactKeys(value, ["version", "revision", "accessKeyHash", "owner", "sessions", "integrity"])
    || (value.accessKeyHash !== null
      && (typeof value.accessKeyHash !== "string" || !TOKEN_HASH_PATTERN.test(value.accessKeyHash)))
    || (value.integrity !== null
      && (typeof value.integrity !== "string" || !TOKEN_HASH_PATTERN.test(value.integrity)))
    || (options.requireIntegrity === true && value.integrity === null)
    || !validStoredOwner(value.owner)
    || (value.owner !== null && value.accessKeyHash !== null)) {
    throw new Error("Unsupported or malformed session state.");
  }
  validateSessionRecords(value, maximumSessions);
  if (value.owner === null
    && Object.values(value.sessions).some((record) => record.principal !== null)) {
    throw new Error("Malformed browser session state.");
  }
  if (value.owner !== null
    && Object.values(value.sessions).some((record) => record.principal === null
      || !sameOwnerIdentity(value.owner, record.principal))) {
    throw new Error("Malformed browser session state.");
  }
  return value;
}

function migrateSessionState(value, maximumSessions) {
  if (!isPlainObject(value)) {
    throw new Error("Unsupported or malformed session state.");
  }
  if (value.version === SESSION_STATE_VERSION) {
    return { state: validateSessionState(value, maximumSessions), changed: false };
  }
  if (value.version === JELLYFIN_OWNER_SESSION_STATE_VERSION) {
    if (!hasExactKeys(value, ["version", "revision", "accessKeyHash", "owner", "sessions"])
      || (value.accessKeyHash !== null
        && (typeof value.accessKeyHash !== "string" || !TOKEN_HASH_PATTERN.test(value.accessKeyHash)))
      || !validStoredOwner(value.owner)
      || (value.owner !== null && value.accessKeyHash !== null)) {
      throw new Error("Unsupported or malformed session state.");
    }
    validateSessionRecords(value, maximumSessions);
    if (value.owner === null
      && Object.values(value.sessions).some((record) => record.principal !== null)) {
      throw new Error("Malformed browser session state.");
    }
    if (value.owner !== null
      && Object.values(value.sessions).some((record) => record.principal === null
        || !sameOwnerIdentity(value.owner, record.principal))) {
      throw new Error("Malformed browser session state.");
    }
    return {
      state: validateSessionState({ ...value, version: SESSION_STATE_VERSION, integrity: null }, maximumSessions),
      changed: true
    };
  }
  if (value.version !== LEGACY_SESSION_STATE_VERSION
    && value.version !== ACCESS_KEY_SESSION_STATE_VERSION) {
    throw new Error("Unsupported or malformed session state.");
  }
  const isVersionOne = value.version === LEGACY_SESSION_STATE_VERSION;
  const expectedKeys = isVersionOne
    ? ["version", "revision", "sessions"]
    : ["version", "revision", "accessKeyHash", "sessions"];
  if (!hasExactKeys(value, expectedKeys)
    || (!isVersionOne
      && value.accessKeyHash !== null
      && (typeof value.accessKeyHash !== "string" || !TOKEN_HASH_PATTERN.test(value.accessKeyHash)))) {
    throw new Error("Unsupported or malformed session state.");
  }
  validateSessionRecords(value, maximumSessions, { legacy: true });
  const migrated = {
    version: SESSION_STATE_VERSION,
    revision: value.revision,
    accessKeyHash: isVersionOne ? null : value.accessKeyHash,
    owner: null,
    sessions: Object.fromEntries(Object.entries(value.sessions).map(([id, record]) => [
      id,
      { ...record, principal: null }
    ])),
    integrity: null
  };
  return { state: validateSessionState(migrated, maximumSessions), changed: true };
}

function sessionStateIntegrityPayload(state) {
  const owner = state.owner === null
    ? null
    : [
      state.owner.provider,
      state.owner.serverId,
      state.owner.userId,
      state.owner.username,
      state.owner.jellyfinUrl,
      state.owner.targetRevision,
      state.owner.boundaryHash,
      state.owner.enrolledAt
    ];
  const sessions = Object.keys(state.sessions).sort().map((id) => {
    const record = state.sessions[id];
    const principal = record.principal === null
      ? null
      : [
        record.principal.provider,
        record.principal.serverId,
        record.principal.userId,
        record.principal.username,
        record.principal.deviceId,
        record.principal.jellyfinUrl,
        record.principal.targetRevision,
        record.principal.boundaryHash,
        record.principal.verifiedAt
      ];
    return [
      record.id,
      record.name,
      record.origin,
      record.host,
      record.tokenHash,
      record.createdAt,
      record.expiresAt,
      principal
    ];
  });
  return Buffer.from(JSON.stringify([
    "helmsman-browser-authorization-state-v1",
    state.version,
    state.revision,
    state.accessKeyHash,
    owner,
    sessions
  ]), "utf8");
}

async function secureReadJson(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(filePath, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_SESSION_STATE_BYTES) {
      throw new Error("Session state has an unsafe size or type.");
    }
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) throw new Error("Session state could not be read completely.");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(dataDir, filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SESSION_STATE_BYTES) {
    throw new Error("Session state exceeded its safety limit.");
  }
  const temporary = path.join(dataDir, `.sessions-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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
  try {
    const directory = await open(dataDir, fsConstants.O_RDONLY);
    await directory.sync();
    await directory.close();
  } catch {
    // The file itself was fsynced and atomically renamed already.
  }
}

function publicSession(record) {
  const user = record.principal === null
    ? null
    : { provider: record.principal.provider, name: record.principal.username };
  return {
    id: record.id,
    name: record.name,
    origin: record.origin,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    provider: user?.provider || null,
    user
  };
}

export class SessionAuthStore {
  #state = null;
  #prunedSessions = [];
  #writeChain = Promise.resolve();
  #guard;
  #now;
  #ttlMs;
  #maxSessions;
  #cookieName;
  #csrfHeader;
  #stateIntegrityTag;
  #allowLegacyMigration;

  constructor(dataDir, options = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
      throw new Error("The session data directory must be an absolute path.");
    }
    const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : Number(options.ttlMs);
    const maxSessions = options.maxSessions === undefined ? DEFAULT_MAX_SESSIONS : Number(options.maxSessions);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
      throw new Error("The session lifetime is invalid.");
    }
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1_024) {
      throw new Error("The browser session limit is invalid.");
    }
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, "sessions.json");
    this.#guard = typeof options.guard === "function" ? options.guard : async () => {};
    this.#now = typeof options.now === "function" ? options.now : Date.now;
    this.#ttlMs = ttlMs;
    this.#maxSessions = maxSessions;
    this.#cookieName = safeCookieName(options.cookieName || DEFAULT_COOKIE_NAME);
    this.#csrfHeader = String(options.csrfHeader || DEFAULT_CSRF_HEADER).toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/u.test(this.#csrfHeader)) throw new Error("The CSRF header name is invalid.");
    this.#stateIntegrityTag = options.stateIntegrityTag === undefined
      ? null
      : options.stateIntegrityTag;
    if (this.#stateIntegrityTag !== null && typeof this.#stateIntegrityTag !== "function") {
      throw new Error("The session-state integrity provider is invalid.");
    }
    this.#allowLegacyMigration = options.allowLegacyMigration !== false;
  }

  #applyIntegrity(state) {
    if (!this.#stateIntegrityTag) {
      state.integrity = null;
      return;
    }
    const payload = sessionStateIntegrityPayload(state);
    try {
      const integrity = this.#stateIntegrityTag(payload);
      if (typeof integrity !== "string" || !TOKEN_HASH_PATTERN.test(integrity)) {
        throw new Error("The session-state integrity provider returned an invalid tag.");
      }
      state.integrity = integrity;
    } finally {
      payload.fill(0);
    }
  }

  #verifyIntegrity(state) {
    if (!this.#stateIntegrityTag) {
      if (state.integrity !== null) {
        throw new Error("The browser authorization state requires its integrity key.");
      }
      return;
    }
    if (typeof state.integrity !== "string" || !TOKEN_HASH_PATTERN.test(state.integrity)) {
      throw new Error("The browser authorization state is not authenticated.");
    }
    const payload = sessionStateIntegrityPayload(state);
    let expected = null;
    try {
      expected = this.#stateIntegrityTag(payload);
      if (typeof expected !== "string" || !TOKEN_HASH_PATTERN.test(expected)) {
        throw new Error("The session-state integrity provider returned an invalid tag.");
      }
      const storedBytes = Buffer.from(state.integrity, "hex");
      const expectedBytes = Buffer.from(expected, "hex");
      try {
        if (storedBytes.length !== expectedBytes.length || !timingSafeEqual(storedBytes, expectedBytes)) {
          throw new Error("The browser authorization state could not be authenticated.");
        }
      } finally {
        storedBytes.fill(0);
        expectedBytes.fill(0);
      }
    } finally {
      payload.fill(0);
      expected = null;
    }
  }

  async initialize() {
    await this.#guard();
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => {});
    try {
      const metadata = await stat(this.filePath);
      if (!metadata.isFile()) throw new Error("Session state path is not a regular file.");
      const loaded = migrateSessionState(await secureReadJson(this.filePath), this.#maxSessions);
      if (loaded.changed && !this.#allowLegacyMigration) {
        throw new Error("Legacy browser authorization state cannot replace sealed state.");
      }
      this.#state = loaded.state;
      if (loaded.changed) {
        this.#applyIntegrity(this.#state);
        validateSessionState(this.#state, this.#maxSessions, {
          requireIntegrity: Boolean(this.#stateIntegrityTag)
        });
        await atomicWriteJson(this.dataDir, this.filePath, this.#state);
      } else {
        this.#verifyIntegrity(this.#state);
      }
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = initialSessionState();
      this.#applyIntegrity(this.#state);
      await atomicWriteJson(this.dataDir, this.filePath, this.#state);
    }
    await this.pruneExpired();
    return this.list();
  }

  #snapshot() {
    if (!this.#state) throw new Error("Session authentication is not initialized.");
    return structuredClone(this.#state);
  }

  async #mutate(mutator) {
    const operation = this.#writeChain
      .catch(() => {})
      .then(async () => {
        await this.#guard();
        const next = this.#snapshot();
        const result = await mutator(next);
        next.revision += 1;
        this.#applyIntegrity(next);
        validateSessionState(next, this.#maxSessions, {
          requireIntegrity: Boolean(this.#stateIntegrityTag)
        });
        await atomicWriteJson(this.dataDir, this.filePath, next);
        this.#state = next;
        return result;
      });
    this.#writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  list() {
    const state = this.#snapshot();
    const now = nowMilliseconds(this.#now);
    return Object.values(state.sessions)
      .filter((record) => Date.parse(record.expiresAt) > now)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicSession);
  }

  accessKeyConfigured() {
    return this.#snapshot().accessKeyHash !== null;
  }

  ownerConfigured() {
    return this.#snapshot().owner !== null;
  }

  owner() {
    return structuredClone(this.#snapshot().owner);
  }

  ownerMatches(identity) {
    return sameOwnerIdentity(this.#snapshot().owner, identity);
  }

  ownerBoundaryMatches(identity) {
    const owner = this.#snapshot().owner;
    return isPlainObject(owner)
      && isPlainObject(identity)
      && safeEqualText(owner.jellyfinUrl, identity.jellyfinUrl)
      && safeEqualText(owner.targetRevision, identity.targetRevision)
      && safeEqualText(owner.boundaryHash, identity.boundaryHash);
  }

  getInternalSession(sessionId) {
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) return null;
    return structuredClone(this.#snapshot().sessions[sessionId] || null);
  }

  internalSessions() {
    return Object.values(this.#snapshot().sessions)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  prepareOwnerSession(options) {
    const prepared = this.#prepareIssue(options);
    if (prepared.record.principal === null) {
      throw new Error("A Jellyfin session identity is required for owner authentication.");
    }
    const plan = Object.freeze({
      sessionId: prepared.record.id,
      credentialBinding: jellyfinSessionCredentialBinding(prepared.record)
    });
    PREPARED_OWNER_SESSION_PLANS.set(plan, { store: this, prepared, consumed: false });
    return plan;
  }

  takePrunedSessions() {
    const pruned = structuredClone(this.#prunedSessions);
    this.#prunedSessions = [];
    return pruned;
  }

  #prepareIssue(options) {
    if (!isPlainObject(options)) throw new Error("Session issue options are required.");
    const name = safeSessionName(options.name);
    const origin = canonicalOrigin(options.origin);
    if (!isSecureApplicationOrigin(origin)) {
      fail(400, "SECURE_ORIGIN_REQUIRED", "Browser sessions require HTTPS or a localhost origin.");
    }
    const host = new URL(origin).host.toLowerCase();
    if (options.host !== undefined && canonicalHost(options.host) !== host) {
      fail(400, "ORIGIN_REJECTED", "The browser session Origin does not match its Host.");
    }
    const currentTime = nowMilliseconds(this.#now);
    const ttlMs = options.ttlMs === undefined ? this.#ttlMs : Number(options.ttlMs);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
      throw new Error("The session lifetime is invalid.");
    }
    const expiresAt = currentTime + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("The session expiration is invalid.");
    const sessionId = options.sessionId === undefined ? randomUUID() : options.sessionId;
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
      throw new Error("The browser session ID is invalid.");
    }
    const principal = options.principal === undefined || options.principal === null
      ? null
      : normalizePrincipal({
        provider: options.principal.provider,
        serverId: options.principal.serverId,
        userId: options.principal.userId,
        username: options.principal.username,
        deviceId: options.principal.deviceId,
        jellyfinUrl: options.principal.jellyfinUrl,
        targetRevision: options.principal.targetRevision,
        boundaryHash: options.principal.boundaryHash,
        verifiedAt: options.principal.verifiedAt ?? isoTime(currentTime)
      }, isoTime(currentTime));
    if (principal && Date.parse(principal.verifiedAt) > currentTime) {
      throw new Error("The Jellyfin session verification time is in the future.");
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const record = {
      id: sessionId,
      name,
      origin,
      host,
      tokenHash: tokenHash(token),
      createdAt: isoTime(currentTime),
      expiresAt: isoTime(expiresAt),
      principal
    };
    return { currentTime, record, token };
  }

  #insertPreparedSession(next, prepared) {
    const pruned = [];
    for (const [sessionId, session] of Object.entries(next.sessions)) {
      if (Date.parse(session.expiresAt) <= prepared.currentTime) {
        pruned.push(structuredClone(session));
        delete next.sessions[sessionId];
      }
    }
    if (next.sessions[prepared.record.id]) {
      fail(409, "SESSION_ID_CONFLICT", "The browser session could not be created. Try again.");
    }
    if (Object.keys(next.sessions).length >= this.#maxSessions) {
      fail(409, "SESSION_LIMIT_REACHED", "Revoke an existing browser session before adding another one.");
    }
    next.sessions[prepared.record.id] = structuredClone(prepared.record);
    return pruned;
  }

  #issuedResult(prepared) {
    return {
      session: publicSession(prepared.record),
      csrfToken: csrfForRecord(prepared.record),
      cookie: sessionCookie(prepared.token, {
        cookieName: this.#cookieName,
        origin: prepared.record.origin,
        expiresAt: prepared.record.expiresAt,
        now: prepared.currentTime
      })
    };
  }

  #preparedOwnerSession(options) {
    const plan = options?.preparedSession;
    if (!isPlainObject(plan)) return this.#prepareIssue(options);
    const entry = PREPARED_OWNER_SESSION_PLANS.get(plan);
    if (!entry || entry.store !== this || entry.consumed) {
      throw new Error("The prepared Jellyfin browser session is invalid or already used.");
    }
    entry.consumed = true;
    return entry.prepared;
  }

  async issue(options) {
    const prepared = this.#prepareIssue(options);
    const pruned = await this.#mutate((next) => {
      if (prepared.record.principal === null && next.owner !== null) {
        fail(409, "JELLYFIN_AUTH_REQUIRED", "New browser sessions must sign in with the Jellyfin owner account.");
      }
      if (prepared.record.principal !== null) {
        if (next.owner === null) {
          fail(409, "OWNER_NOT_CONFIGURED", "The Jellyfin owner account has not been configured.");
        }
        if (!sameOwnerIdentity(next.owner, prepared.record.principal)) {
          fail(401, "JELLYFIN_OWNER_MISMATCH", "The Jellyfin account is not the Helmsman owner.");
        }
      }
      return this.#insertPreparedSession(next, prepared);
    });
    this.#prunedSessions.push(...pruned);
    return this.#issuedResult(prepared);
  }

  async enrollOwnerAndIssue(options) {
    if (!isPlainObject(options)) throw new Error("Owner enrollment options are required.");
    const prepared = this.#preparedOwnerSession(options);
    if (prepared.record.principal === null) {
      throw new Error("A Jellyfin session identity is required for owner enrollment.");
    }
    const owner = normalizeOwner({
      provider: options.owner?.provider,
      serverId: options.owner?.serverId,
      userId: options.owner?.userId,
      username: options.owner?.username,
      jellyfinUrl: options.owner?.jellyfinUrl,
      targetRevision: options.owner?.targetRevision,
      boundaryHash: options.owner?.boundaryHash,
      enrolledAt: prepared.record.createdAt
    }, prepared.record.createdAt);
    if (!sameOwnerIdentity(owner, prepared.record.principal)
      || !safeEqualText(owner.username, prepared.record.principal.username)) {
      throw new Error("The Jellyfin owner and session identities do not match.");
    }
    const pruned = await this.#mutate((next) => {
      if (next.owner !== null) {
        fail(409, "OWNER_ALREADY_CONFIGURED", "The Jellyfin owner account is already configured.");
      }
      next.owner = owner;
      next.accessKeyHash = null;
      next.sessions = {};
      return this.#insertPreparedSession(next, prepared);
    });
    this.#prunedSessions.push(...pruned);
    return this.#issuedResult(prepared);
  }

  async loginOwner(options) {
    if (!isPlainObject(options)) throw new Error("Owner login options are required.");
    const prepared = this.#preparedOwnerSession(options);
    if (prepared.record.principal === null) {
      throw new Error("A Jellyfin session identity is required for owner login.");
    }
    const pruned = await this.#mutate((next) => {
      if (next.owner === null) {
        fail(409, "OWNER_NOT_CONFIGURED", "The Jellyfin owner account has not been configured.");
      }
      if (!sameOwnerIdentity(next.owner, prepared.record.principal)) {
        fail(401, "JELLYFIN_OWNER_MISMATCH", "The Jellyfin account is not the Helmsman owner.");
      }
      next.owner.username = prepared.record.principal.username;
      return this.#insertPreparedSession(next, prepared);
    });
    this.#prunedSessions.push(...pruned);
    return this.#issuedResult(prepared);
  }

  async rebindOwnerAndRevokeAll(expectedBoundary, nextBoundary) {
    const normalizeBoundary = (value) => {
      if (!isPlainObject(value)
        || !hasExactKeys(value, ["jellyfinUrl", "targetRevision", "boundaryHash"])) {
        throw new Error("The Jellyfin owner authorization boundary is invalid.");
      }
      const targetRevision = safeIdentityText(value.targetRevision, "target revision", 128);
      if (!UUID_PATTERN.test(targetRevision)) throw new Error("The Jellyfin target revision is invalid.");
      const boundaryHash = safeIdentityText(value.boundaryHash, "authorization boundary", 64);
      if (!TOKEN_HASH_PATTERN.test(boundaryHash)) {
        throw new Error("The Jellyfin authorization boundary is invalid.");
      }
      return {
        jellyfinUrl: canonicalJellyfinUrl(value.jellyfinUrl),
        targetRevision,
        boundaryHash
      };
    };
    const expected = normalizeBoundary(expectedBoundary);
    const replacement = normalizeBoundary(nextBoundary);
    return this.#mutate((next) => {
      if (!next.owner || !sameOwnerIdentity(next.owner, {
        provider: JELLYFIN_PROVIDER,
        serverId: next.owner.serverId,
        userId: next.owner.userId,
        ...expected
      })) {
        fail(409, "OWNER_BOUNDARY_CHANGED", "The Jellyfin owner authorization boundary changed; reset access and try again.");
      }
      const count = Object.keys(next.sessions).length;
      next.owner.jellyfinUrl = replacement.jellyfinUrl;
      next.owner.targetRevision = replacement.targetRevision;
      next.owner.boundaryHash = replacement.boundaryHash;
      next.sessions = {};
      return count;
    });
  }

  async markVerified(sessionId, identity, verifiedAt = undefined) {
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
      fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
    }
    if (!isPlainObject(identity) || identity.provider !== JELLYFIN_PROVIDER) {
      throw new Error("The verified Jellyfin identity is invalid.");
    }
    const verifiedIdentity = {
      provider: JELLYFIN_PROVIDER,
      serverId: safeIdentityText(identity.serverId, "server ID"),
      userId: safeIdentityText(identity.userId, "user ID"),
      username: safeIdentityText(identity.username, "username")
    };
    const verifiedTime = verifiedAt === undefined
      ? isoTime(nowMilliseconds(this.#now))
      : verifiedAt;
    const verifiedMilliseconds = parseIsoTime(verifiedTime);
    if (verifiedMilliseconds === null || verifiedMilliseconds > nowMilliseconds(this.#now)) {
      throw new Error("The Jellyfin session verification time is invalid.");
    }
    return this.#mutate((next) => {
      const record = next.sessions[sessionId];
      if (!record || record.principal === null) {
        fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
      }
      if (Date.parse(record.expiresAt) <= nowMilliseconds(this.#now)) {
        fail(401, "SESSION_EXPIRED", "The browser session has expired.");
      }
      if (!sameOwnerAccount(next.owner, verifiedIdentity)
        || !sameOwnerAccount(record.principal, verifiedIdentity)) {
        fail(401, "JELLYFIN_OWNER_MISMATCH", "The Jellyfin account is not the Helmsman owner.");
      }
      next.owner.username = verifiedIdentity.username;
      record.principal.username = verifiedIdentity.username;
      record.principal.verifiedAt = verifiedTime;
      return {
        session: publicSession(record),
        principal: structuredClone(record.principal),
        owner: structuredClone(next.owner)
      };
    });
  }

  async login(options) {
    if (!isPlainObject(options)) throw new Error("Access login options are required.");
    const prepared = this.#prepareIssue(options);
    const pruned = await this.#mutate((next) => {
      if (next.accessKeyHash === null) {
        fail(409, "ACCESS_KEY_NOT_CONFIGURED", "A reusable access key has not been configured.");
      }
      if (!accessKeyMatches(next.accessKeyHash, options.accessKey)) {
        fail(401, "ACCESS_KEY_INVALID", "The Helmsman access key is invalid.");
      }
      return this.#insertPreparedSession(next, prepared);
    });
    this.#prunedSessions.push(...pruned);
    return this.#issuedResult(prepared);
  }

  async clearAuthentication() {
    return this.#mutate((next) => {
      const count = Object.keys(next.sessions).length;
      next.accessKeyHash = null;
      next.owner = null;
      next.sessions = {};
      return count;
    });
  }

  async clearAccess() {
    return this.clearAuthentication();
  }

  async authenticateToken(token) {
    if (!validToken(token)) fail(401, "SESSION_REQUIRED", "A valid browser session is required.");
    const state = this.#snapshot();
    const presentedHash = Buffer.from(tokenHash(token), "hex");
    let matched = null;
    for (const record of Object.values(state.sessions)) {
      const storedHash = Buffer.from(record.tokenHash, "hex");
      if (storedHash.length === presentedHash.length && timingSafeEqual(storedHash, presentedHash)) matched = record;
    }
    if (!matched) fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
    if (Date.parse(matched.expiresAt) <= nowMilliseconds(this.#now)) {
      await this.revoke(matched.id);
      this.#prunedSessions.push(structuredClone(matched));
      fail(401, "SESSION_EXPIRED", "The browser session has expired.");
    }
    return { session: publicSession(matched), csrfToken: csrfForRecord(matched) };
  }

  async authenticateRequest(request, options = {}) {
    const token = readSessionCookie(request?.headers?.cookie, { cookieName: this.#cookieName });
    if (!token) fail(401, "SESSION_REQUIRED", "A valid browser session is required.");
    const authenticated = await this.authenticateToken(token);
    const state = this.#snapshot();
    const record = state.sessions[authenticated.session.id];
    if (!record) fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
    assertRequestBinding(request, record, { requireOrigin: options.requireOrigin === true || options.requireCsrf === true });
    if (options.requireCsrf === true) requireCsrf(request, record, this.#csrfHeader);
    return authenticated;
  }

  async revoke(sessionId) {
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) return false;
    return this.#mutate((next) => {
      if (!next.sessions[sessionId]) return false;
      delete next.sessions[sessionId];
      return true;
    });
  }

  async revokeToken(token) {
    if (!validToken(token)) return false;
    let matchedId = null;
    const presentedHash = Buffer.from(tokenHash(token), "hex");
    for (const record of Object.values(this.#snapshot().sessions)) {
      const storedHash = Buffer.from(record.tokenHash, "hex");
      if (storedHash.length === presentedHash.length && timingSafeEqual(storedHash, presentedHash)) matchedId = record.id;
    }
    return matchedId ? this.revoke(matchedId) : false;
  }

  async revokeAll() {
    return this.#mutate((next) => {
      const count = Object.keys(next.sessions).length;
      next.sessions = {};
      return count;
    });
  }

  async pruneExpired() {
    const currentTime = nowMilliseconds(this.#now);
    const expired = Object.values(this.#snapshot().sessions)
      .filter((record) => Date.parse(record.expiresAt) <= currentTime)
      .map((record) => record.id);
    if (!expired.length) return 0;
    const removed = await this.#mutate((next) => {
      const records = [];
      for (const id of expired) {
        if (next.sessions[id] && Date.parse(next.sessions[id].expiresAt) <= currentTime) {
          records.push(structuredClone(next.sessions[id]));
          delete next.sessions[id];
        }
      }
      return records;
    });
    this.#prunedSessions.push(...removed);
    return removed.length;
  }

  expiredCookie(origin) {
    return expiredSessionCookie({ cookieName: this.#cookieName, origin });
  }
}

export const SESSION_COOKIE_NAME = DEFAULT_COOKIE_NAME;
export const CSRF_HEADER_NAME = DEFAULT_CSRF_HEADER;
