import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { parseServiceUrl } from "./network.mjs";

const STATE_VERSION = 5;
const MAX_STATE_BYTES = 1024 * 1024;
const TOKEN_BYTES = 32;
const TOKEN_HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SERVICE_IDS = new Set(["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent"]);
const MAX_APPROVED_HOST_CIDRS = 32;
// Seven media connectors, 25 Proxmox endpoint records, and eight infrastructure
// services can all be duplicated once during an atomic
// policy/credential-binding migration without exceeding the encrypted store's
// 96-namespace ceiling.
const MAX_INFRASTRUCTURE_TARGETS = 25;
const MAX_INFRASTRUCTURE_ENDPOINTS = 25;
const MAX_ENDPOINTS_PER_ENVIRONMENT = 4;
const MAX_INFRASTRUCTURE_SERVICES = 8;
const INFRASTRUCTURE_TYPES = new Set(["proxmox"]);
const INFRASTRUCTURE_SERVICE_TYPES = new Set(["portainer", "loki"]);
const LOKI_AUTH_MODES = new Set(["none", "basic", "bearer"]);
const LOKI_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameStringsForValidation(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function isExactHostCidr(value) {
  if (typeof value !== "string" || value.length > 128 || /\s/u.test(value)) return false;
  const parts = value.split("/");
  if (parts.length !== 2 || !/^\d{1,3}$/u.test(parts[1])) return false;
  const version = isIP(parts[0]);
  return (version === 4 && parts[1] === "32") || (version === 6 && parts[1] === "128");
}

function isEnvironmentIdentity(value) {
  return value === null || (
    isPlainObject(value)
    && Object.keys(value).length === 2
    && ["cluster", "standalone"].includes(value.kind)
    && typeof value.name === "string"
    && value.name.length >= 1
    && value.name.length <= 80
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.name)
  );
}

function initialState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    instanceId: randomUUID(),
    claimed: false,
    setupTokenHash: null,
    claimedAt: null,
    policy: {
      allowedCidrs: [],
      allowPublicHttps: false,
      revision: 1
    },
    devices: {},
    connections: {},
    infrastructureTargets: {},
    infrastructureServices: {}
  };
}

function endpointFromLegacyTarget(target) {
  return {
    id: target.id,
    label: "Primary endpoint",
    url: target.url,
    targetRevision: target.targetRevision,
    enabled: true,
    tlsMode: target.tlsMode,
    certificateFingerprint: target.certificateFingerprint,
    approvedHostCidrs: [...(target.approvedHostCidrs || [])],
    createdAt: target.createdAt,
    updatedAt: target.updatedAt
  };
}

function migrateLoadedState(value) {
  if (!isPlainObject(value)) throw new Error("Unsupported or malformed broker state.");
  let changed = false;
  if (value.version === 1) {
    value.version = 2;
    value.infrastructureTargets = {};
    changed = true;
  }
  if (value.version === 2) {
    for (const target of Object.values(value.infrastructureTargets || {})) {
      if (!isPlainObject(target)) continue;
      target.primaryEndpointId = target.id;
      target.endpoints = [endpointFromLegacyTarget(target)];
      target.environmentIdentity = null;
    }
    value.version = 3;
    changed = true;
  }
  if (value.version === 3) {
    value.infrastructureServices = {};
    value.version = 4;
    changed = true;
  }
  if (value.version === 4) {
    // Version 5 adds Loki as an infrastructure service. Existing Portainer
    // records deliberately retain their exact shape so their destination-bound
    // encrypted credential namespaces remain stable across the migration.
    value.version = STATE_VERSION;
    changed = true;
  }
  return { state: value, changed };
}

function isIsoDate(value) {
  return typeof value === "string"
    && value.length <= 40
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateLoadedState(value) {
  if (!isPlainObject(value) || value.version !== STATE_VERSION) {
    throw new Error("Unsupported or malformed broker state.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("Malformed broker state revision.");
  }
  if (typeof value.instanceId !== "string" || !UUID.test(value.instanceId)) {
    throw new Error("Malformed broker instance identity.");
  }
  if (typeof value.claimed !== "boolean") throw new Error("Malformed broker claim state.");
  if (value.setupTokenHash !== null
    && (typeof value.setupTokenHash !== "string" || !TOKEN_HASH.test(value.setupTokenHash))) {
    throw new Error("Malformed broker setup-token verifier.");
  }
  if (!isPlainObject(value.policy)
    || !Array.isArray(value.policy.allowedCidrs)
    || typeof value.policy.allowPublicHttps !== "boolean"
    || !Number.isSafeInteger(value.policy.revision)
    || value.policy.revision < 1) {
    throw new Error("Malformed broker network policy.");
  }
  if (!isPlainObject(value.devices) || !isPlainObject(value.connections)) {
    throw new Error("Malformed broker device or connection state.");
  }
  if (!isPlainObject(value.infrastructureTargets)
    || Object.keys(value.infrastructureTargets).length > MAX_INFRASTRUCTURE_TARGETS) {
    throw new Error("Malformed broker infrastructure target state.");
  }
  if (!isPlainObject(value.infrastructureServices)
    || Object.keys(value.infrastructureServices).length > MAX_INFRASTRUCTURE_SERVICES) {
    throw new Error("Malformed broker infrastructure service state.");
  }
  for (const [id, device] of Object.entries(value.devices)) {
    if (!UUID.test(id)
      || !isPlainObject(device)
      || typeof device.name !== "string"
      || !device.name
      || device.name.length > 80
      || typeof device.origin !== "string"
      || device.origin.length > 512
      || typeof device.tokenHash !== "string"
      || !TOKEN_HASH.test(device.tokenHash)
      || typeof device.createdAt !== "string") {
      throw new Error("Malformed broker device state.");
    }
  }
  for (const [service, connection] of Object.entries(value.connections)) {
    if (!SERVICE_IDS.has(service)
      || !isPlainObject(connection)
      || typeof connection.url !== "string"
      || connection.url.length < 1
      || connection.url.length > 2048
      || typeof connection.targetRevision !== "string"
      || !UUID.test(connection.targetRevision)
      || typeof connection.updatedAt !== "string"
      || (connection.authMode !== undefined && !["token", "apiKey", "login"].includes(connection.authMode))
      || (connection.monitoringEnabled !== undefined && typeof connection.monitoringEnabled !== "boolean")
      || (connection.approvedHostCidrs !== undefined
        && (!Array.isArray(connection.approvedHostCidrs)
          || connection.approvedHostCidrs.length > MAX_APPROVED_HOST_CIDRS
          || connection.approvedHostCidrs.some((value) => !isExactHostCidr(value))))) {
      throw new Error("Malformed broker connection state.");
    }
  }
  let infrastructureEndpointCount = 0;
  for (const [id, target] of Object.entries(value.infrastructureTargets)) {
    let canonicalUrl = null;
    let protocol = null;
    try {
      const parsed = parseServiceUrl(target?.url);
      canonicalUrl = parsed.url;
      protocol = parsed.protocol;
    } catch {
      // Report one stable state-integrity error below.
    }
    const endpoints = Array.isArray(target?.endpoints) ? target.endpoints : [];
    const primaryEndpoint = endpoints.find((endpoint) => endpoint?.id === target?.primaryEndpointId);
    infrastructureEndpointCount += endpoints.length;
    if (!UUID.test(id)
      || !isPlainObject(target)
      || target.id !== id
      || !INFRASTRUCTURE_TYPES.has(target.type)
      || typeof target.displayName !== "string"
      || !target.displayName
      || target.displayName.length > 80
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(target.displayName)
      || typeof target.url !== "string"
      || target.url !== canonicalUrl
      || protocol !== "https:"
      || typeof target.targetRevision !== "string"
      || !UUID.test(target.targetRevision)
      || typeof target.enabled !== "boolean"
      || typeof target.monitoringEnabled !== "boolean"
      || !Number.isSafeInteger(target.monitoringIntervalSeconds)
      || target.monitoringIntervalSeconds < 30
      || target.monitoringIntervalSeconds > 3600
      || !isEnvironmentIdentity(target.environmentIdentity ?? null)
      || !["system", "pinned"].includes(target.tlsMode)
      || (target.certificateFingerprint !== null
        && (typeof target.certificateFingerprint !== "string"
          || !/^[a-f0-9]{64}$/u.test(target.certificateFingerprint)))
      || (target.tlsMode === "pinned" && target.certificateFingerprint === null)
      || (target.tlsMode === "system" && target.certificateFingerprint !== null)
      || !isIsoDate(target.createdAt)
      || !isIsoDate(target.updatedAt)
      || Date.parse(target.updatedAt) < Date.parse(target.createdAt)
      || typeof target.primaryEndpointId !== "string"
      || !UUID.test(target.primaryEndpointId)
      || endpoints.length < 1
      || endpoints.length > MAX_ENDPOINTS_PER_ENVIRONMENT
      || !primaryEndpoint
      || !Array.isArray(target.approvedHostCidrs)
      || target.approvedHostCidrs.length > MAX_APPROVED_HOST_CIDRS
      || target.approvedHostCidrs.some((entry) => !isExactHostCidr(entry))) {
      throw new Error("Malformed broker infrastructure target state.");
    }
    const endpointIds = new Set();
    const endpointUrls = new Set();
    for (const endpoint of endpoints) {
      let endpointUrl = null;
      let endpointProtocol = null;
      try {
        const parsed = parseServiceUrl(endpoint?.url);
        endpointUrl = parsed.url;
        endpointProtocol = parsed.protocol;
      } catch {
        // Report one stable state-integrity error below.
      }
      if (!isPlainObject(endpoint)
        || !UUID.test(endpoint.id)
        || endpointIds.has(endpoint.id)
        || typeof endpoint.label !== "string"
        || !endpoint.label
        || endpoint.label.length > 80
        || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(endpoint.label)
        || endpoint.url !== endpointUrl
        || endpointProtocol !== "https:"
        || endpointUrls.has(endpoint.url)
        || typeof endpoint.targetRevision !== "string"
        || !UUID.test(endpoint.targetRevision)
        || typeof endpoint.enabled !== "boolean"
        || !["system", "pinned"].includes(endpoint.tlsMode)
        || (endpoint.certificateFingerprint !== null
          && (typeof endpoint.certificateFingerprint !== "string"
            || !/^[a-f0-9]{64}$/u.test(endpoint.certificateFingerprint)))
        || (endpoint.tlsMode === "pinned" && endpoint.certificateFingerprint === null)
        || (endpoint.tlsMode === "system" && endpoint.certificateFingerprint !== null)
        || !Array.isArray(endpoint.approvedHostCidrs)
        || endpoint.approvedHostCidrs.length > MAX_APPROVED_HOST_CIDRS
        || endpoint.approvedHostCidrs.some((entry) => !isExactHostCidr(entry))
        || !isIsoDate(endpoint.createdAt)
        || !isIsoDate(endpoint.updatedAt)
        || Date.parse(endpoint.updatedAt) < Date.parse(endpoint.createdAt)) {
        throw new Error("Malformed broker infrastructure endpoint state.");
      }
      endpointIds.add(endpoint.id);
      endpointUrls.add(endpoint.url);
    }
    if (target.url !== primaryEndpoint.url
      || target.tlsMode !== primaryEndpoint.tlsMode
      || target.certificateFingerprint !== primaryEndpoint.certificateFingerprint
      || !sameStringsForValidation(target.approvedHostCidrs, primaryEndpoint.approvedHostCidrs)) {
      throw new Error("Malformed broker primary infrastructure endpoint state.");
    }
  }
  if (infrastructureEndpointCount > MAX_INFRASTRUCTURE_ENDPOINTS) {
    throw new Error("Malformed broker infrastructure endpoint state.");
  }
  for (const [id, service] of Object.entries(value.infrastructureServices)) {
    let canonicalUrl = null;
    let protocol = null;
    try {
      const parsed = parseServiceUrl(service?.url);
      canonicalUrl = parsed.url;
      protocol = parsed.protocol;
    } catch {
      // Report one stable state-integrity error below.
    }
    const isPortainer = service?.type === "portainer";
    const isLoki = service?.type === "loki";
    const lokiTlsValid = isLoki && (
      (protocol === "http:"
        && service.tlsMode === "none"
        && service.certificateFingerprint === null
        && service.authMode === "none")
      || (protocol === "https:"
        && ["system", "pinned"].includes(service.tlsMode)
        && (service.tlsMode === "pinned"
          ? typeof service.certificateFingerprint === "string"
            && /^[a-f0-9]{64}$/u.test(service.certificateFingerprint)
          : service.certificateFingerprint === null))
    );
    if (!UUID.test(id)
      || !isPlainObject(service)
      || service.id !== id
      || !INFRASTRUCTURE_SERVICE_TYPES.has(service.type)
      || typeof service.displayName !== "string"
      || !service.displayName
      || service.displayName.length > 80
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(service.displayName)
      || typeof service.url !== "string"
      || service.url !== canonicalUrl
      || (isPortainer && protocol !== "https:")
      || (isLoki && !["http:", "https:"].includes(protocol))
      || typeof service.targetRevision !== "string"
      || !UUID.test(service.targetRevision)
      || typeof service.enabled !== "boolean"
      || typeof service.monitoringEnabled !== "boolean"
      || (isPortainer && !["system", "pinned"].includes(service.tlsMode))
      || (isPortainer && service.certificateFingerprint !== null
        && (typeof service.certificateFingerprint !== "string"
          || !/^[a-f0-9]{64}$/u.test(service.certificateFingerprint)))
      || (isPortainer && service.tlsMode === "pinned" && service.certificateFingerprint === null)
      || (isPortainer && service.tlsMode === "system" && service.certificateFingerprint !== null)
      || (isLoki && !lokiTlsValid)
      || (isLoki && !LOKI_AUTH_MODES.has(service.authMode))
      || (isLoki && service.tenantId !== null
        && (typeof service.tenantId !== "string" || !LOKI_TENANT_ID.test(service.tenantId)))
      || !Array.isArray(service.approvedHostCidrs)
      || service.approvedHostCidrs.length > MAX_APPROVED_HOST_CIDRS
      || service.approvedHostCidrs.some((entry) => !isExactHostCidr(entry))
      || !isIsoDate(service.createdAt)
      || !isIsoDate(service.updatedAt)
      || Date.parse(service.updatedAt) < Date.parse(service.createdAt)) {
      throw new Error("Malformed broker infrastructure service state.");
    }
  }
  return value;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function tokenMatches(storedHash, presentedToken) {
  if (typeof storedHash !== "string" || !TOKEN_HASH.test(storedHash)) return false;
  if (typeof presentedToken !== "string" || presentedToken.length < 32 || presentedToken.length > 256) return false;
  const expected = Buffer.from(storedHash, "hex");
  const presented = Buffer.from(hashToken(presentedToken), "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export function generateSecretToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

async function secureReadJson(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(filePath, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_STATE_BYTES) {
      throw new Error("Broker state has an unsafe size or type.");
    }
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) throw new Error("Broker state could not be read completely.");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(dataDir, filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Broker state exceeded its safety limit.");
  const temporary = path.join(dataDir, `.state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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

  // Best-effort directory sync keeps the rename durable on filesystems that
  // support fsync on directories. Unsupported platforms can safely continue.
  try {
    const directory = await open(dataDir, fsConstants.O_RDONLY);
    await directory.sync();
    await directory.close();
  } catch {
    // The state file itself was already fsynced and atomically renamed.
  }
}

export class StateStore {
  #state = null;
  #writeChain = Promise.resolve();
  #guard;

  constructor(dataDir, options = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
      throw new Error("The broker data directory must be an absolute path.");
    }
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, "state.json");
    this.#guard = typeof options.guard === "function" ? options.guard : async () => {};
  }

  async initialize() {
    await this.#guard();
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => {});
    try {
      const metadata = await stat(this.filePath);
      if (!metadata.isFile()) throw new Error("Broker state path is not a regular file.");
      const loaded = migrateLoadedState(await secureReadJson(this.filePath));
      this.#state = validateLoadedState(loaded.state);
      if (loaded.changed) await atomicWriteJson(this.dataDir, this.filePath, this.#state);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = initialState();
      await atomicWriteJson(this.dataDir, this.filePath, this.#state);
    }
    return this.snapshot();
  }

  snapshot() {
    if (!this.#state) throw new Error("Broker state is not initialized.");
    return structuredClone(this.#state);
  }

  async mutate(mutator) {
    const operation = this.#writeChain
      .catch(() => {})
      .then(async () => {
        await this.#guard();
        const next = this.snapshot();
        const result = await mutator(next);
        next.revision += 1;
        validateLoadedState(next);
        await atomicWriteJson(this.dataDir, this.filePath, next);
        this.#state = next;
        return result;
      });
    this.#writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  async rotateUnclaimedSetupToken() {
    const current = this.snapshot();
    if (current.claimed) return null;
    const token = generateSecretToken();
    await this.mutate((next) => {
      if (next.claimed) throw new Error("The broker was claimed while setup was starting.");
      next.setupTokenHash = hashToken(token);
    });
    return token;
  }

  async resetAccess() {
    return this.mutate((next) => {
      next.claimed = false;
      next.claimedAt = null;
      next.setupTokenHash = null;
      next.devices = {};
    });
  }
}
