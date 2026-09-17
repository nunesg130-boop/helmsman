import { constants as fsConstants } from "node:fs";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const CREDENTIAL_STORE_SCHEMA = 1;

const ALGORITHM = "AES-256-GCM";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_FILE_BYTES = 256;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;
// The control plane can stage a destination-bound replacement for all seven
// media connectors, 25 Proxmox endpoints, and eight Portainer servers during
// one policy migration (80 namespaces). Up to 64 browser sessions may also
// hold a separately encrypted Jellyfin identity token. Keep bounded recovery
// headroom while rejecting unexpectedly large credential documents.
const MAX_SERVICES = 192;
const MAX_FIELDS_PER_SERVICE = 32;
const DEFAULT_KEY_NAME = "credentials.key";
const DEFAULT_STORE_NAME = "credentials.json";
const INSTANCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SERVICE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const FIELD_ID = /^[a-z][A-Za-z0-9_-]{0,63}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HEX_KEY = /^[a-fA-F0-9]{64}$/u;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class CredentialStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

function failure(code, message) {
  return new CredentialStoreError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function validateInstanceId(value) {
  if (typeof value !== "string" || !INSTANCE_ID.test(value)) {
    throw failure("INVALID_INSTANCE_ID", "A valid broker instance identity is required.");
  }
  return value;
}

function validateService(value) {
  if (typeof value !== "string" || !SERVICE_ID.test(value) || RESERVED_KEYS.has(value)) {
    throw failure("INVALID_CREDENTIAL_LOCATION", "The credential service identifier is invalid.");
  }
  return value;
}

function validateField(value) {
  if (typeof value !== "string" || !FIELD_ID.test(value) || RESERVED_KEYS.has(value)) {
    throw failure("INVALID_CREDENTIAL_LOCATION", "The credential field identifier is invalid.");
  }
  return value;
}

function decodeBase64url(value, expectedBytes, label) {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    throw failure("CREDENTIAL_STORE_MALFORMED", `The encrypted credential ${label} is malformed.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw failure("CREDENTIAL_STORE_MALFORMED", `The encrypted credential ${label} is malformed.`);
  }
  return decoded;
}

function parseKey(bytes) {
  if (bytes.length === KEY_BYTES) return Buffer.from(bytes);
  if (bytes.length < 1 || bytes.length > MAX_KEY_FILE_BYTES) {
    throw failure("CREDENTIAL_KEY_INVALID", "The credential encryption key is invalid.");
  }

  const decodedText = bytes.toString("utf8");
  if (!Buffer.from(decodedText, "utf8").equals(bytes)) {
    throw failure("CREDENTIAL_KEY_INVALID", "The credential encryption key is invalid.");
  }
  const text = decodedText.trim();
  if (HEX_KEY.test(text)) return Buffer.from(text, "hex");
  if (BASE64URL.test(text)) {
    const decoded = Buffer.from(text, "base64url");
    if (decoded.length === KEY_BYTES && decoded.toString("base64url") === text) return decoded;
    decoded.fill(0);
  }
  throw failure("CREDENTIAL_KEY_INVALID", "The credential encryption key is invalid.");
}

async function readRegularFile(filePath, maximumBytes, options = {}) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw failure(options.errorCode || "CREDENTIAL_STORE_MALFORMED", options.errorMessage || "The credential file is unsafe.");
    }
    if (options.hardenPermissions) await handle.chmod(0o600);
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) {
      bytes.fill(0);
      throw failure(options.errorCode || "CREDENTIAL_STORE_MALFORMED", options.errorMessage || "The credential file is incomplete.");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function fileExists(filePath) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is unsafe.");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms do not support opening or syncing directories. The file
    // itself is still fsynced before its atomic rename.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function createDefaultKey(dataDir, keyPath) {
  const key = randomBytes(KEY_BYTES);
  const encoded = Buffer.from(`${key.toString("base64url")}\n`, "ascii");
  let handle;
  try {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
    handle = await open(keyPath, flags, 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await syncDirectory(dataDir);
    return key;
  } catch (error) {
    key.fill(0);
    if (error?.code === "EEXIST") return null;
    throw error;
  } finally {
    encoded.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function loadKey(dataDir, keyPath, configured, mayCreate) {
  if (!configured && mayCreate) {
    const created = await createDefaultKey(dataDir, keyPath);
    if (created) return created;
  }
  try {
    const bytes = await readRegularFile(keyPath, MAX_KEY_FILE_BYTES, {
      hardenPermissions: !configured,
      errorCode: "CREDENTIAL_KEY_INVALID",
      errorMessage: "The credential encryption key is invalid."
    });
    try {
      return parseKey(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw failure("CREDENTIAL_KEY_UNAVAILABLE", "The credential encryption key is unavailable.");
    }
    throw error;
  }
}

function initialDocument(instanceId) {
  return {
    schema: CREDENTIAL_STORE_SCHEMA,
    instanceId,
    revision: 0,
    credentials: {},
    integrity: null
  };
}

function validateRecord(record, documentRevision) {
  if (!isPlainObject(record)
    || !hasExactKeys(record, ["schema", "algorithm", "revision", "updatedAt", "nonce", "ciphertext", "tag"])
    || record.schema !== CREDENTIAL_STORE_SCHEMA
    || record.algorithm !== ALGORITHM
    || !Number.isSafeInteger(record.revision)
    || record.revision < 1
    || record.revision > documentRevision
    || typeof record.updatedAt !== "string"
    || record.updatedAt.length > 40
    || !Number.isFinite(Date.parse(record.updatedAt))
    || new Date(record.updatedAt).toISOString() !== record.updatedAt
    || typeof record.ciphertext !== "string"
    || record.ciphertext.length < 2
    || record.ciphertext.length > Math.ceil(MAX_SECRET_BYTES * 4 / 3) + 4) {
    throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed.");
  }
  decodeBase64url(record.nonce, NONCE_BYTES, "nonce").fill(0);
  decodeBase64url(record.tag, TAG_BYTES, "tag").fill(0);
  const ciphertext = Buffer.from(record.ciphertext, "base64url");
  if (!BASE64URL.test(record.ciphertext)
    || ciphertext.length < 1
    || ciphertext.length > MAX_SECRET_BYTES
    || ciphertext.toString("base64url") !== record.ciphertext) {
    ciphertext.fill(0);
    throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed.");
  }
  ciphertext.fill(0);
}

function validateDocument(value, expectedInstanceId) {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["schema", "instanceId", "revision", "credentials", "integrity"])
    || value.schema !== CREDENTIAL_STORE_SCHEMA
    || value.instanceId !== expectedInstanceId
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !isPlainObject(value.credentials)
    || !isPlainObject(value.integrity)
    || !hasExactKeys(value.integrity, ["schema", "algorithm", "nonce", "tag"])
    || value.integrity.schema !== CREDENTIAL_STORE_SCHEMA
    || value.integrity.algorithm !== ALGORITHM) {
    throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed or belongs to another instance.");
  }

  const services = Object.entries(value.credentials);
  if (services.length > MAX_SERVICES) {
    throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed.");
  }
  const nonces = new Set();
  for (const [service, fields] of services) {
    validateService(service);
    if (!isPlainObject(fields)
      || Object.keys(fields).length < 1
      || Object.keys(fields).length > MAX_FIELDS_PER_SERVICE) {
      throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed.");
    }
    for (const [field, record] of Object.entries(fields)) {
      validateField(field);
      validateRecord(record, value.revision);
      if (nonces.has(record.nonce)) {
        throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store contains a repeated nonce.");
      }
      nonces.add(record.nonce);
    }
  }

  decodeBase64url(value.integrity.nonce, NONCE_BYTES, "manifest nonce").fill(0);
  decodeBase64url(value.integrity.tag, TAG_BYTES, "manifest tag").fill(0);
  if (nonces.has(value.integrity.nonce)) {
    throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store contains a repeated nonce.");
  }
  return value;
}

function valueAad(instanceId, service, field, record) {
  return Buffer.from(JSON.stringify([
    "jellofin-command/credential",
    record.schema,
    instanceId,
    service,
    field,
    record.revision,
    record.updatedAt
  ]), "utf8");
}

function manifestAad(document) {
  const records = [];
  for (const service of Object.keys(document.credentials).sort()) {
    for (const field of Object.keys(document.credentials[service]).sort()) {
      const record = document.credentials[service][field];
      records.push([
        service,
        field,
        record.schema,
        record.algorithm,
        record.revision,
        record.updatedAt,
        record.nonce,
        record.ciphertext,
        record.tag
      ]);
    }
  }
  return Buffer.from(JSON.stringify([
    "jellofin-command/credential-store",
    document.schema,
    document.instanceId,
    document.revision,
    records
  ]), "utf8");
}

function unusedNonce(usedNonces) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = randomBytes(NONCE_BYTES);
    const encoded = nonce.toString("base64url");
    if (!usedNonces.has(encoded)) {
      usedNonces.add(encoded);
      return nonce;
    }
    nonce.fill(0);
  }
  throw failure("CREDENTIAL_ENCRYPTION_FAILED", "A unique credential-encryption nonce could not be generated.");
}

function encryptValue(key, instanceId, service, field, cleartext, revision, updatedAt, usedNonces) {
  const nonce = unusedNonce(usedNonces);
  const record = {
    schema: CREDENTIAL_STORE_SCHEMA,
    algorithm: ALGORITHM,
    revision,
    updatedAt,
    nonce: nonce.toString("base64url"),
    ciphertext: "",
    tag: ""
  };
  const aad = valueAad(instanceId, service, field, record);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    record.ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]).toString("base64url");
    record.tag = cipher.getAuthTag().toString("base64url");
    return record;
  } catch {
    throw failure("CREDENTIAL_ENCRYPTION_FAILED", "The credential could not be encrypted.");
  } finally {
    nonce.fill(0);
    aad.fill(0);
  }
}

function decryptValue(key, instanceId, service, field, record) {
  const nonce = decodeBase64url(record.nonce, NONCE_BYTES, "nonce");
  const tag = decodeBase64url(record.tag, TAG_BYTES, "tag");
  const ciphertext = Buffer.from(record.ciphertext, "base64url");
  const aad = valueAad(instanceId, service, field, record);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw failure("CREDENTIAL_STORE_AUTH_FAILED", "The encrypted credential store could not be authenticated.");
  } finally {
    nonce.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}

function sealManifest(document, key, usedNonces) {
  const nonce = unusedNonce(usedNonces);
  const aad = manifestAad(document);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    cipher.final();
    document.integrity = {
      schema: CREDENTIAL_STORE_SCHEMA,
      algorithm: ALGORITHM,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url")
    };
  } catch {
    throw failure("CREDENTIAL_ENCRYPTION_FAILED", "The encrypted credential store could not be sealed.");
  } finally {
    nonce.fill(0);
    aad.fill(0);
  }
}

function authenticateDocument(document, key) {
  const nonce = decodeBase64url(document.integrity.nonce, NONCE_BYTES, "manifest nonce");
  const tag = decodeBase64url(document.integrity.tag, TAG_BYTES, "manifest tag");
  const aad = manifestAad(document);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    decipher.final();
    for (const [service, fields] of Object.entries(document.credentials)) {
      for (const [field, record] of Object.entries(fields)) {
        decryptValue(key, document.instanceId, service, field, record).fill(0);
      }
    }
  } catch (error) {
    if (error instanceof CredentialStoreError && error.code !== "CREDENTIAL_STORE_AUTH_FAILED") throw error;
    throw failure("CREDENTIAL_STORE_AUTH_FAILED", "The encrypted credential store could not be authenticated.");
  } finally {
    nonce.fill(0);
    tag.fill(0);
    aad.fill(0);
  }
}

function allNonces(document) {
  const result = new Set();
  for (const fields of Object.values(document.credentials)) {
    for (const record of Object.values(fields)) result.add(record.nonce);
  }
  if (document.integrity?.nonce) result.add(document.integrity.nonce);
  return result;
}

function secretBytes(value) {
  let result;
  if (typeof value === "string") {
    result = Buffer.from(value, "utf8");
    if (result.toString("utf8") !== value) {
      result.fill(0);
      throw failure("INVALID_CREDENTIAL_VALUE", "The credential value is not valid UTF-8 text.");
    }
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    result = Buffer.from(value);
  } else {
    throw failure("INVALID_CREDENTIAL_VALUE", "The credential value must be text or bytes.");
  }
  if (result.length < 1 || result.length > MAX_SECRET_BYTES) {
    result.fill(0);
    throw failure("INVALID_CREDENTIAL_VALUE", "The credential value has an invalid length.");
  }
  return result;
}

function normalizeEntries(entries) {
  if (!isPlainObject(entries)) {
    throw failure("INVALID_CREDENTIAL_VALUE", "Credentials must be supplied as a field-value object.");
  }
  const pairs = Object.entries(entries);
  if (pairs.length < 1 || pairs.length > MAX_FIELDS_PER_SERVICE) {
    throw failure("INVALID_CREDENTIAL_VALUE", "Supply between one and 32 credential fields.");
  }
  return pairs.map(([field, value]) => [validateField(field), secretBytes(value)]);
}

function publicMetadata(document) {
  const credentials = {};
  for (const [service, fields] of Object.entries(document.credentials)) {
    credentials[service] = {};
    for (const [field, record] of Object.entries(fields)) {
      credentials[service][field] = {
        configured: true,
        revision: record.revision,
        updatedAt: record.updatedAt
      };
    }
  }
  return {
    schema: document.schema,
    revision: document.revision,
    credentials
  };
}

async function readDocument(storePath, instanceId) {
  const bytes = await readRegularFile(storePath, MAX_STORE_BYTES, {
    hardenPermissions: true,
    errorCode: "CREDENTIAL_STORE_MALFORMED",
    errorMessage: "The encrypted credential store is unsafe."
  });
  try {
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw failure("CREDENTIAL_STORE_MALFORMED", "The encrypted credential store is malformed.");
    }
    return validateDocument(parsed, instanceId);
  } finally {
    bytes.fill(0);
  }
}

async function atomicWriteDocument(dataDir, storePath, document) {
  const serialized = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  if (serialized.length > MAX_STORE_BYTES) {
    serialized.fill(0);
    throw failure("CREDENTIAL_STORE_TOO_LARGE", "The encrypted credential store exceeded its safety limit.");
  }
  const temporary = path.join(dataDir, `.credentials-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  let renamed = false;
  try {
    const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
    handle = await open(temporary, flags, 0o600);
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporary, storePath);
    renamed = true;
    await syncDirectory(dataDir);
  } finally {
    serialized.fill(0);
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporary).catch(() => {});
  }
}

export class CredentialStore {
  #document = null;
  #guard;
  #key = null;
  #now;
  #writeChain = Promise.resolve();
  #createdDuringInitialization = false;

  constructor(dataDir, options = {}) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
      throw failure("INVALID_DATA_DIRECTORY", "The credential data directory must be an absolute path.");
    }
    this.dataDir = path.resolve(dataDir);
    this.instanceId = validateInstanceId(options.instanceId);
    this.storePath = path.join(this.dataDir, DEFAULT_STORE_NAME);
    this.configuredKeyFile = options.keyFilePath !== undefined && options.keyFilePath !== null;
    if (this.configuredKeyFile
      && (typeof options.keyFilePath !== "string" || !path.isAbsolute(options.keyFilePath))) {
      throw failure("INVALID_KEY_PATH", "The credential key path must be an absolute, separate file.");
    }
    this.keyPath = this.configuredKeyFile
      ? path.resolve(options.keyFilePath)
      : path.join(this.dataDir, DEFAULT_KEY_NAME);
    if (this.keyPath === this.storePath) {
      throw failure("INVALID_KEY_PATH", "The credential key path must be an absolute, separate file.");
    }
    this.#guard = typeof options.guard === "function" ? options.guard : async () => {};
    this.#now = typeof options.now === "function" ? options.now : Date.now;
  }

  async initialize() {
    if (this.#document) return this.publicSnapshot();
    let key = null;
    try {
      await this.#guard();
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      let directory;
      try {
        directory = await open(this.dataDir, fsConstants.O_RDONLY);
        await directory.chmod(0o700);
      } finally {
        await directory?.close().catch(() => {});
      }
      const storeExists = await fileExists(this.storePath);
      this.#createdDuringInitialization = !storeExists;
      key = await loadKey(this.dataDir, this.keyPath, this.configuredKeyFile, !storeExists);

      let document;
      if (storeExists) {
        document = await readDocument(this.storePath, this.instanceId);
        authenticateDocument(document, key);
      } else {
        document = initialDocument(this.instanceId);
        sealManifest(document, key, new Set());
        await this.#guard();
        await atomicWriteDocument(this.dataDir, this.storePath, document);
      }
      this.#key = key;
      key = null;
      this.#document = document;
      return this.publicSnapshot();
    } catch (error) {
      key?.fill(0);
      if (error instanceof CredentialStoreError) throw error;
      throw failure("CREDENTIAL_STORE_UNAVAILABLE", "The encrypted credential store is unavailable.");
    }
  }

  #assertInitialized() {
    if (!this.#document || !this.#key) {
      throw failure("CREDENTIAL_STORE_NOT_INITIALIZED", "The encrypted credential store is not initialized.");
    }
  }

  publicSnapshot() {
    this.#assertInitialized();
    return publicMetadata(this.#document);
  }

  createdDuringInitialization() {
    this.#assertInitialized();
    return this.#createdDuringInitialization;
  }

  sessionStateIntegrityTag(payload) {
    this.#assertInitialized();
    if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > 256 * 1_024) {
      throw failure("INVALID_SESSION_STATE", "The browser authorization state could not be authenticated.");
    }
    const derivedKey = createHmac("sha256", this.#key)
      .update(`helmsman/session-state-integrity-key/v1\0${this.instanceId}`, "utf8")
      .digest();
    try {
      return createHmac("sha256", derivedKey)
        .update("helmsman/session-state-integrity/v1\0", "utf8")
        .update(payload)
        .digest("hex");
    } finally {
      derivedKey.fill(0);
    }
  }

  hasCredential(service, field) {
    this.#assertInitialized();
    validateService(service);
    validateField(field);
    return Boolean(this.#document.credentials[service]?.[field]);
  }

  async #persistMutation(mutator) {
    this.#assertInitialized();
    const operation = this.#writeChain
      .catch(() => {})
      .then(async () => {
        await this.#guard();
        const next = structuredClone(this.#document);
        const result = await mutator(next);
        if (!result.changed) return result.value;
        next.revision += 1;
        // Retain every nonce from the previous revision in the rejection set.
        // This also prevents the new manifest from reusing the prior manifest
        // nonce or the nonce of a credential removed by this mutation.
        const nonces = allNonces(next);
        result.seal(next, next.revision, nonces);
        sealManifest(next, this.#key, nonces);
        validateDocument(next, this.instanceId);
        authenticateDocument(next, this.#key);
        await this.#guard();
        await atomicWriteDocument(this.dataDir, this.storePath, next);
        this.#document = next;
        return result.value(next);
      });
    this.#writeChain = operation.then(() => {}, () => {});
    try {
      return await operation;
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw failure("CREDENTIAL_STORE_UNAVAILABLE", "The encrypted credential store could not be updated.");
    }
  }

  async setCredential(service, field, value) {
    const safeField = validateField(field);
    const metadata = await this.setCredentials(service, { [safeField]: value });
    return metadata[safeField];
  }

  async setCredentials(service, entries) {
    this.#assertInitialized();
    const safeService = validateService(service);
    const pairs = normalizeEntries(entries);
    try {
      return await this.#persistMutation(async () => ({
        changed: true,
        seal: (next, revision, usedNonces) => {
          const updatedAt = new Date(this.#now()).toISOString();
          const fields = next.credentials[safeService] || {};
          for (const [field, cleartext] of pairs) {
            fields[field] = encryptValue(
              this.#key,
              this.instanceId,
              safeService,
              field,
              cleartext,
              revision,
              updatedAt,
              usedNonces
            );
          }
          next.credentials[safeService] = fields;
        },
        value: (next) => structuredClone(publicMetadata(next).credentials[safeService])
      }));
    } finally {
      for (const [, cleartext] of pairs) cleartext.fill(0);
    }
  }

  async replaceServiceCredentials(service, entries) {
    this.#assertInitialized();
    const safeService = validateService(service);
    const pairs = normalizeEntries(entries);
    try {
      return await this.#persistMutation(async () => ({
        changed: true,
        seal: (next, revision, usedNonces) => {
          const updatedAt = new Date(this.#now()).toISOString();
          const fields = {};
          for (const [field, cleartext] of pairs) {
            fields[field] = encryptValue(
              this.#key,
              this.instanceId,
              safeService,
              field,
              cleartext,
              revision,
              updatedAt,
              usedNonces
            );
          }
          next.credentials[safeService] = fields;
        },
        value: (next) => structuredClone(publicMetadata(next).credentials[safeService])
      }));
    } finally {
      for (const [, cleartext] of pairs) cleartext.fill(0);
    }
  }

  async removeCredential(service, field) {
    this.#assertInitialized();
    const safeService = validateService(service);
    const safeField = validateField(field);
    return this.#persistMutation(async (next) => {
      if (!next.credentials[safeService]?.[safeField]) {
        return { changed: false, seal: () => {}, value: { removed: false } };
      }
      return {
        changed: true,
        seal: (updated) => {
          delete updated.credentials[safeService][safeField];
          if (!Object.keys(updated.credentials[safeService]).length) delete updated.credentials[safeService];
        },
        value: () => ({ removed: true })
      };
    });
  }

  async removeServiceCredentials(service) {
    this.#assertInitialized();
    const safeService = validateService(service);
    return this.#persistMutation(async (next) => {
      if (!next.credentials[safeService]) {
        return { changed: false, seal: () => {}, value: { removed: false } };
      }
      return {
        changed: true,
        seal: (updated) => { delete updated.credentials[safeService]; },
        value: () => ({ removed: true })
      };
    });
  }

  async useCredential(service, field, consumer) {
    this.#assertInitialized();
    const safeService = validateService(service);
    const safeField = validateField(field);
    if (typeof consumer !== "function") {
      throw failure("INVALID_CREDENTIAL_CONSUMER", "A credential consumer function is required.");
    }
    const record = this.#document.credentials[safeService]?.[safeField];
    if (!record) throw failure("CREDENTIAL_NOT_CONFIGURED", "The requested credential is not configured.");

    const cleartext = decryptValue(this.#key, this.instanceId, safeService, safeField, record);
    try {
      return await consumer(cleartext);
    } finally {
      cleartext.fill(0);
    }
  }

  async close() {
    await this.#writeChain.catch(() => {});
    this.#key?.fill(0);
    this.#key = null;
    this.#document = null;
  }
}
