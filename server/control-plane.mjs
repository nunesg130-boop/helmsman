import { createHash, randomUUID } from "node:crypto";
import { canonicalServiceId, SERVICE_IDS } from "./routes.mjs";
import {
  normalizePolicy,
  parseServiceUrl,
  resolveAndAuthorizeExplicitTarget,
  resolveAndAuthorizeTarget
} from "./network.mjs";
import { CredentialStore, CredentialStoreError } from "./secrets.mjs";
import {
  claimRequestBinding,
  CSRF_HEADER_NAME,
  requestBinding,
  SessionAuthError,
  SessionAuthStore
} from "./session-auth.mjs";
import { generateSecretToken, hashToken, tokenMatches } from "./state.mjs";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const SAFE_SECRET = /^[^\u0000-\u001f\u007f-\u009f]{1,4096}$/u;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_INVITES = 16;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 10;
// Keep enough encrypted-store headroom to stage every destination-bound
// credential during an atomic network-policy migration (seven media
// connectors, 25 Proxmox endpoints, and eight infrastructure services).
const MAX_INFRASTRUCTURE_TARGETS = 25;
const MAX_INFRASTRUCTURE_ENDPOINTS = 25;
const MAX_ENDPOINTS_PER_ENVIRONMENT = 4;
const MAX_INFRASTRUCTURE_SERVICES = 8;
const DEFAULT_INFRASTRUCTURE_MONITOR_INTERVAL_SECONDS = 60;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROXMOX_TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MEDIA_ARTWORK_TOKEN = /^[a-f0-9]{16,64}$/u;
const MEDIA_ARTWORK_TYPE = /^image\/(?:avif|gif|jpeg|png|webp)$/u;

export const SERVICE_DEFINITIONS = Object.freeze({
  jellyfin: Object.freeze({
    name: "Jellyfin",
    role: "Library and playback",
    authMode: "token",
    credentialField: "token",
    credentialLabel: "API key or access token",
    credentialHint: "Use a Jellyfin Dashboard API key (easiest) or a user access token.",
    authOptions: Object.freeze([
      Object.freeze({
        id: "token",
        label: "API key or access token",
        input: "secret",
        credentialField: "token",
        credentialLabel: "API key or access token",
        credentialHint: "Use a Jellyfin Dashboard API key or an existing user access token."
      }),
      Object.freeze({
        id: "login",
        label: "Username + password",
        input: "login",
        credentialField: "token",
        identityLabel: "Jellyfin username",
        credentialHint: "Helmsman exchanges the login once for an access token, then discards the password."
      })
    ])
  }),
  seerr: Object.freeze({
    name: "Seerr",
    role: "Requests",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Use the global API key from Seerr Settings > General.",
    authOptions: Object.freeze([
      Object.freeze({
        id: "apiKey",
        label: "API key",
        input: "secret",
        credentialField: "apiKey",
        credentialLabel: "API key",
        credentialHint: "Use the global API key from Seerr Settings > General."
      }),
      Object.freeze({
        id: "login",
        label: "Email + password",
        input: "login",
        credentialField: "session",
        identityLabel: "Seerr account email",
        credentialHint: "Requires Seerr local sign-in. Helmsman stores only the resulting encrypted session and discards the password."
      })
    ])
  }),
  radarr: Object.freeze({
    name: "Radarr",
    role: "Movies",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Found in Radarr Settings > General > Security."
  }),
  sonarr: Object.freeze({
    name: "Sonarr",
    role: "Series",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Found in Sonarr Settings > General > Security."
  }),
  prowlarr: Object.freeze({
    name: "Prowlarr",
    role: "Indexers",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Found in Prowlarr Settings > General > Security."
  }),
  bazarr: Object.freeze({
    name: "Bazarr",
    role: "Subtitles",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Found in Bazarr Settings > General."
  }),
  qbittorrent: Object.freeze({
    name: "qBittorrent",
    role: "Downloads",
    authMode: "apiKey",
    credentialField: "apiKey",
    credentialLabel: "API key",
    credentialHint: "Requires qBittorrent 5.2+; the key begins with qbt_."
  })
});

export const INFRASTRUCTURE_DEFINITIONS = Object.freeze({
  proxmox: Object.freeze({
    name: "Proxmox VE",
    role: "Virtualization",
    credentialFields: Object.freeze(["tokenId", "tokenSecret"]),
    credentials: Object.freeze([
      Object.freeze({
        id: "tokenId",
        label: "API token ID",
        hint: "Use the complete Proxmox token ID, for example helmsman@pve!monitoring."
      }),
      Object.freeze({
        id: "tokenSecret",
        label: "API token secret",
        hint: "Paste the token secret shown once when the Proxmox API token is created."
      })
    ])
  })
});

export const INFRASTRUCTURE_SERVICE_DEFINITIONS = Object.freeze({
  portainer: Object.freeze({
    name: "Portainer",
    role: "Container management",
    credentialFields: Object.freeze(["accessToken"]),
    credentials: Object.freeze([
      Object.freeze({
        id: "accessToken",
        label: "Access token",
        hint: "Create an access token for a dedicated read-only Portainer user."
      })
    ])
  })
});

export class ControlPlaneError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ControlPlaneError(status, code, message);
}

function requirePlainObject(value, message = "The request body must be a JSON object.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "INVALID_REQUEST", message);
  return value;
}

function requireExactKeys(value, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(400, "INVALID_REQUEST", `Unsupported request field: ${key}.`);
  }
}

async function readBoundedJson(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) {
    fail(415, "JSON_REQUIRED", "Use an application/json request body.");
  }
  const encoding = request.headers["content-encoding"];
  if (encoding && String(encoding).toLowerCase() !== "identity") {
    fail(415, "CONTENT_ENCODING_NOT_ALLOWED", "Compressed request bodies are not accepted.");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > MAX_JSON_BODY_BYTES)) {
    fail(413, "REQUEST_TOO_LARGE", "The request body exceeded its safety limit.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      request.resume();
      fail(413, "REQUEST_TOO_LARGE", "The request body exceeded its safety limit.");
    }
    chunks.push(chunk);
  }
  try {
    return requirePlainObject(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    fail(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function setApiHeaders(response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  setApiHeaders(response);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.length));
  response.statusCode = status;
  response.end(body);
}

function noContent(response) {
  setApiHeaders(response);
  response.statusCode = 204;
  response.end();
}

function publicOperationsSnapshot(value) {
  const snapshot = structuredClone(value);
  if (snapshot?.media && typeof snapshot.media === "object" && !Array.isArray(snapshot.media)) {
    // Artwork source descriptors contain no secrets, but are still an
    // internal routing table. Browsers receive only the opaque artwork URLs
    // embedded in normalized media records.
    delete snapshot.media.artwork;
  }
  return snapshot;
}

function safeDeviceName(value) {
  if (typeof value !== "string") fail(400, "INVALID_SESSION_NAME", "Enter a name for this browser.");
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    fail(400, "INVALID_SESSION_NAME", "Enter a browser name between 1 and 80 characters.");
  }
  return normalized;
}

function normalizeSecret(service, value) {
  if (typeof value !== "string" || !SAFE_SECRET.test(value)) {
    fail(400, "INVALID_CREDENTIAL", "Enter a valid service credential.");
  }
  if (service === "qbittorrent" && !/^qbt_[A-Za-z0-9]{28}$/u.test(value)) {
    fail(400, "INVALID_CREDENTIAL", "qBittorrent API keys must begin with qbt_ and contain 32 characters.");
  }
  return value;
}

function safeInfrastructureDisplayName(value) {
  if (typeof value !== "string") fail(400, "INVALID_DISPLAY_NAME", "Enter a name for this infrastructure target.");
  const normalized = value.trim();
  if (!normalized
    || normalized.length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    fail(400, "INVALID_DISPLAY_NAME", "Enter a target name between 1 and 80 characters.");
  }
  return normalized;
}

function safeInfrastructureEndpointLabel(value, fallback = "Endpoint") {
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(400, "INVALID_ENDPOINT_LABEL", "Enter a name for this Proxmox endpoint.");
  const normalized = value.trim();
  if (!normalized
    || normalized.length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    fail(400, "INVALID_ENDPOINT_LABEL", "Enter an endpoint name between 1 and 80 characters.");
  }
  return normalized;
}

function normalizeDiscoveredEnvironmentIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = value.kind === "cluster" ? "cluster" : value.kind === "standalone" ? "standalone" : null;
  const rawName = kind === "cluster"
    ? value.clusterName
    : value.name || (Array.isArray(value.nodeNames) ? value.nodeNames[0] : "");
  if (!kind || typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (!name
    || name.length > 80
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) return null;
  return { kind, name };
}

function sameEnvironmentIdentity(left, right) {
  return Boolean(left && right && left.kind === right.kind && left.name.toLowerCase() === right.name.toLowerCase());
}

function normalizeInfrastructureType(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.hasOwn(INFRASTRUCTURE_DEFINITIONS, type)) {
    fail(400, "INFRASTRUCTURE_TYPE_NOT_SUPPORTED", "That infrastructure target type is not supported.");
  }
  return type;
}

function normalizeInfrastructureServiceType(value) {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.hasOwn(INFRASTRUCTURE_SERVICE_DEFINITIONS, type)) {
    fail(400, "INFRASTRUCTURE_SERVICE_TYPE_NOT_SUPPORTED", "That infrastructure service type is not supported.");
  }
  return type;
}

function normalizeMonitoringInterval(value, fallback = DEFAULT_INFRASTRUCTURE_MONITOR_INTERVAL_SECONDS) {
  const interval = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(interval) || interval < 30 || interval > 3600) {
    fail(400, "INVALID_MONITOR_INTERVAL", "Monitoring intervals must be between 30 and 3600 seconds.");
  }
  return interval;
}

function normalizeCertificateFingerprint(value) {
  if (typeof value !== "string") {
    fail(400, "INVALID_CERTIFICATE_FINGERPRINT", "Enter the server certificate SHA-256 fingerprint.");
  }
  const compact = value.trim().toLowerCase().replace(/^sha256:/u, "").replaceAll(":", "");
  if (!/^[a-f0-9]{64}$/u.test(compact)) {
    fail(400, "INVALID_CERTIFICATE_FINGERPRINT", "Enter a valid SHA-256 certificate fingerprint.");
  }
  return compact;
}

function normalizeInfrastructureServiceCredentials(type, value) {
  const definition = INFRASTRUCTURE_SERVICE_DEFINITIONS[type];
  const submitted = requirePlainObject(value, "Enter the Portainer access token.");
  requireExactKeys(submitted, definition.credentialFields);
  const accessToken = submitted.accessToken;
  if (typeof accessToken !== "string" || !SAFE_SECRET.test(accessToken)) {
    fail(400, "INVALID_CREDENTIAL", "Enter a valid Portainer access token.");
  }
  const credentials = { accessToken: Buffer.from(accessToken, "utf8") };
  submitted.accessToken = undefined;
  return credentials;
}

function normalizeInfrastructureTls(body, previous = null) {
  const tlsMode = body.tlsMode === undefined ? previous?.tlsMode || "system" : String(body.tlsMode);
  if (!["system", "pinned"].includes(tlsMode)) {
    fail(400, "INVALID_TLS_MODE", "Choose system certificate trust or a pinned certificate fingerprint.");
  }
  const rawFingerprint = body.certificateFingerprint;
  if (tlsMode === "pinned") {
    const certificateFingerprint = rawFingerprint === undefined
      ? previous?.tlsMode === "pinned" ? previous.certificateFingerprint : null
      : normalizeCertificateFingerprint(rawFingerprint);
    if (!certificateFingerprint) {
      fail(400, "CERTIFICATE_FINGERPRINT_REQUIRED", "Pinned certificate trust requires a SHA-256 fingerprint.");
    }
    return { tlsMode, certificateFingerprint };
  }
  if (rawFingerprint !== undefined && rawFingerprint !== null && rawFingerprint !== "") {
    fail(400, "CERTIFICATE_FINGERPRINT_NOT_ALLOWED", "A fingerprint is only used with pinned certificate trust.");
  }
  return { tlsMode, certificateFingerprint: null };
}

function normalizeInfrastructureCredentials(type, value) {
  const definition = INFRASTRUCTURE_DEFINITIONS[type];
  const submitted = requirePlainObject(value, "Enter the Proxmox API token ID and secret.");
  requireExactKeys(submitted, definition.credentialFields);
  const tokenId = submitted.tokenId;
  const tokenSecret = submitted.tokenSecret;
  if (typeof tokenId !== "string"
    || tokenId.length > 320
    || !SAFE_SECRET.test(tokenId)
    || !PROXMOX_TOKEN_ID.test(tokenId)) {
    fail(400, "INVALID_CREDENTIAL", "Enter the complete Proxmox API token ID in user@realm!token format.");
  }
  if (typeof tokenSecret !== "string" || !SAFE_SECRET.test(tokenSecret)) {
    fail(400, "INVALID_CREDENTIAL", "Enter a valid Proxmox API token secret.");
  }
  const buffers = {
    tokenId: Buffer.from(tokenId, "utf8"),
    tokenSecret: Buffer.from(tokenSecret, "utf8")
  };
  submitted.tokenId = undefined;
  submitted.tokenSecret = undefined;
  return buffers;
}

function clearInfrastructureCredentials(credentials) {
  if (!credentials) return;
  for (const value of Object.values(credentials)) value?.fill?.(0);
}

function authOptions(definition) {
  return definition.authOptions || [Object.freeze({
    id: definition.authMode,
    label: definition.credentialLabel,
    input: "secret",
    credentialField: definition.credentialField,
    credentialLabel: definition.credentialLabel,
    credentialHint: definition.credentialHint
  })];
}

function authOption(definition, value) {
  return authOptions(definition).find((option) => option.id === value) || null;
}

function normalizeAuthMode(definition, value) {
  const mode = value === undefined ? definition.authMode : String(value);
  if (!authOption(definition, mode)) {
    fail(400, "AUTH_MODE_NOT_SUPPORTED", "That authentication mode is not supported.");
  }
  return mode;
}

function credentialField(definition, connection) {
  return authOption(definition, connection?.authMode || definition.authMode)?.credentialField
    || definition.credentialField;
}

function normalizeLogin(service, value) {
  const login = requirePlainObject(value, "Enter both the account name and password.");
  requireExactKeys(login, ["username", "password"]);
  if (typeof login.username !== "string" || typeof login.password !== "string") {
    fail(400, "INVALID_LOGIN", "Enter both the account name and password.");
  }
  const username = login.username.trim();
  const password = login.password;
  if (!username
    || username.length > 320
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(username)
    || !SAFE_SECRET.test(password)) {
    fail(400, "INVALID_LOGIN", service === "seerr"
      ? "Enter a valid Seerr account email and password."
      : "Enter a valid Jellyfin username and password.");
  }
  const buffers = {
    username: Buffer.from(username, "utf8"),
    password: Buffer.from(password, "utf8")
  };
  login.username = undefined;
  login.password = undefined;
  return buffers;
}

function clearLogin(login) {
  login?.username?.fill(0);
  login?.password?.fill(0);
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function infrastructureEndpoints(target) {
  if (!target) return [];
  if (Array.isArray(target.endpoints) && target.endpoints.length) return target.endpoints;
  return [{
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
  }];
}

function primaryInfrastructureEndpoint(target) {
  const endpoints = infrastructureEndpoints(target);
  return endpoints.find(({ id }) => id === target?.primaryEndpointId)
    || endpoints.find(({ id }) => id === target?.id)
    || endpoints[0]
    || null;
}

function infrastructureEndpointCount(state) {
  return Object.values(state.infrastructureTargets || {})
    .reduce((total, target) => total + infrastructureEndpoints(target).length, 0);
}

// Credentials are stored under a destination-derived namespace. This makes a
// copied or edited state.json fail closed: changing a target cannot cause a
// credential encrypted for the old destination to be sent to the new one.
function legacyCredentialNamespace(service, connection) {
  if (!connection?.url) return null;
  const targetDigest = createHash("sha256")
    .update(connection.url, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-${targetDigest}`;
}

function credentialNamespace(service, connection, policy) {
  if (!connection?.url || !policy) return null;
  const binding = JSON.stringify({
    url: connection.url,
    authMode: connection.authMode || SERVICE_DEFINITIONS[service]?.authMode || "",
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(connection.approvedHostCidrs || [])].sort()
  });
  const targetDigest = createHash("sha256")
    .update(binding, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-b2-${targetDigest}`;
}

function credentialRecord(credentials, service, connection, policy) {
  const namespace = credentialNamespace(service, connection, policy);
  const definition = SERVICE_DEFINITIONS[service];
  return namespace
    ? credentials.credentials?.[namespace]?.[credentialField(definition, connection)]
    : null;
}

function credentialNamespacesForService(credentials, service) {
  const prefix = `${service}-`;
  return Object.keys(credentials.credentials || {}).filter((namespace) => namespace.startsWith(prefix));
}

function infrastructureCredentialNamespace(target, policy, endpoint = null) {
  const selectedEndpoint = endpoint || primaryInfrastructureEndpoint(target);
  if (!target?.id || !selectedEndpoint?.id || !selectedEndpoint?.url || !policy) return null;
  const binding = JSON.stringify({
    id: target.id,
    type: target.type,
    url: selectedEndpoint.url,
    targetRevision: selectedEndpoint.targetRevision,
    tlsMode: selectedEndpoint.tlsMode,
    certificateFingerprint: selectedEndpoint.certificateFingerprint,
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(selectedEndpoint.approvedHostCidrs || [])].sort()
  });
  const digest = createHash("sha256").update(binding, "utf8").digest("hex").slice(0, 16);
  // Keep every endpoint namespace under the existing environment prefix and
  // within the encrypted store's 64-character identifier bound. The digest
  // already includes both endpoint identity and all destination/trust fields,
  // so alternates remain independently bound without lengthening the key.
  return `infra-${target.id}-${digest}`;
}

function infrastructureCredentialNamespaces(credentials, targetId) {
  const prefix = `infra-${targetId}-`;
  return Object.keys(credentials.credentials || {}).filter((namespace) => namespace.startsWith(prefix));
}

function infrastructureServiceCredentialNamespace(service, policy) {
  if (!service?.id || !service?.url || !policy) return null;
  const binding = JSON.stringify({
    id: service.id,
    type: service.type,
    url: service.url,
    targetRevision: service.targetRevision,
    tlsMode: service.tlsMode,
    certificateFingerprint: service.certificateFingerprint,
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(service.approvedHostCidrs || [])].sort()
  });
  const digest = createHash("sha256").update(binding, "utf8").digest("hex").slice(0, 16);
  // This prefix is intentionally distinct from Proxmox's `infra-` namespace.
  // The complete identifier remains within the encrypted store's 64-character
  // service-ID bound: 10-character prefix + UUID + separator + 16 hex digits.
  return `infra-svc-${service.id}-${digest}`;
}

function infrastructureServiceCredentialNamespaces(credentials, serviceId) {
  const prefix = `infra-svc-${serviceId}-`;
  return Object.keys(credentials.credentials || {}).filter((namespace) => namespace.startsWith(prefix));
}

function infrastructureServiceCredentialMetadata(credentials, service, policy) {
  const namespace = infrastructureServiceCredentialNamespace(service, policy);
  const record = namespace ? credentials.credentials?.[namespace]?.accessToken : null;
  return {
    configured: record?.configured === true,
    updatedAt: record?.configured === true ? record.updatedAt || null : null
  };
}

function infrastructureCredentialMetadata(credentials, target, policy, endpoint = null) {
  const definition = INFRASTRUCTURE_DEFINITIONS[target.type];
  const namespace = infrastructureCredentialNamespace(target, policy, endpoint);
  const fields = namespace ? credentials.credentials?.[namespace] : null;
  const configured = definition.credentialFields.every((field) => fields?.[field]?.configured === true);
  const timestamps = definition.credentialFields
    .map((field) => fields?.[field]?.updatedAt)
    .filter((value) => typeof value === "string")
    .sort();
  return {
    configured,
    updatedAt: configured ? timestamps.at(-1) || null : null
  };
}

function infrastructureEndpointMetadata(state, credentials, target, endpoint, primaryEndpointId) {
  const credential = infrastructureCredentialMetadata(credentials, target, state.policy, endpoint);
  return {
    id: endpoint.id,
    label: endpoint.label,
    url: endpoint.url,
    enabled: endpoint.enabled,
    primary: endpoint.id === primaryEndpointId,
    tlsMode: endpoint.tlsMode,
    certificateFingerprint: endpoint.certificateFingerprint,
    targetRevision: endpoint.targetRevision,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
    credentialConfigured: credential.configured,
    credentialUpdatedAt: credential.updatedAt
  };
}

function infrastructureTargetMetadata(state, credentials, target) {
  const definition = INFRASTRUCTURE_DEFINITIONS[target.type];
  const primaryEndpoint = primaryInfrastructureEndpoint(target);
  const primaryEndpointId = primaryEndpoint?.id || target.id;
  const credential = infrastructureCredentialMetadata(credentials, target, state.policy, primaryEndpoint);
  const endpoints = infrastructureEndpoints(target)
    .map((endpoint) => infrastructureEndpointMetadata(
      state,
      credentials,
      target,
      endpoint,
      primaryEndpointId
    ));
  return {
    id: target.id,
    type: target.type,
    typeName: definition.name,
    role: definition.role,
    displayName: target.displayName,
    environmentKind: target.environmentIdentity?.kind || "unknown",
    environmentName: target.environmentIdentity?.name || target.displayName,
    clusterName: target.environmentIdentity?.kind === "cluster" ? target.environmentIdentity.name : null,
    primaryEndpointId,
    endpointCount: endpoints.length,
    endpoints,
    url: primaryEndpoint?.url || target.url,
    enabled: target.enabled,
    monitoringEnabled: target.monitoringEnabled,
    monitoringIntervalSeconds: target.monitoringIntervalSeconds,
    tlsMode: primaryEndpoint?.tlsMode || target.tlsMode,
    certificateFingerprint: primaryEndpoint?.certificateFingerprint ?? target.certificateFingerprint,
    targetRevision: target.targetRevision,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    credentialConfigured: credential.configured,
    credentialUpdatedAt: credential.updatedAt,
    credentialFields: definition.credentials.map(({ id, label, hint }) => ({ id, label, hint }))
  };
}

function infrastructureServiceMetadata(state, credentials, service) {
  const definition = INFRASTRUCTURE_SERVICE_DEFINITIONS[service.type];
  const credential = infrastructureServiceCredentialMetadata(credentials, service, state.policy);
  return {
    id: service.id,
    type: service.type,
    typeName: definition.name,
    role: definition.role,
    displayName: service.displayName,
    url: service.url,
    enabled: service.enabled,
    monitoringEnabled: service.monitoringEnabled,
    tlsMode: service.tlsMode,
    certificateFingerprint: service.certificateFingerprint,
    targetRevision: service.targetRevision,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    credentialConfigured: credential.configured,
    credentialUpdatedAt: credential.updatedAt,
    credentialFields: definition.credentials.map(({ id, label, hint }) => ({ id, label, hint }))
  };
}

function publicInfrastructureDefinitions() {
  return Object.entries(INFRASTRUCTURE_DEFINITIONS).map(([id, definition]) => ({
    id,
    name: definition.name,
    role: definition.role,
    credentialFields: definition.credentials.map(({ id: fieldId, label, hint }) => ({
      id: fieldId,
      label,
      hint
    }))
  }));
}

function publicInfrastructureServiceDefinitions() {
  return Object.entries(INFRASTRUCTURE_SERVICE_DEFINITIONS).map(([id, definition]) => ({
    id,
    name: definition.name,
    role: definition.role,
    credentialFields: definition.credentials.map(({ id: fieldId, label, hint }) => ({
      id: fieldId,
      label,
      hint
    }))
  }));
}

function connectionMetadata(state, credentials, service) {
  const definition = SERVICE_DEFINITIONS[service];
  const connection = state.connections[service];
  const credential = credentialRecord(credentials, service, connection, state.policy);
  return {
    id: service,
    name: definition.name,
    role: definition.role,
    configured: Boolean(connection),
    url: connection?.url || "",
    authMode: connection?.authMode || definition.authMode,
    monitoringEnabled: connection?.monitoringEnabled !== false,
    targetRevision: connection?.targetRevision || null,
    credentialConfigured: Boolean(credential?.configured),
    credentialUpdatedAt: credential?.updatedAt || null,
    credentialLabel: definition.credentialLabel,
    credentialHint: definition.credentialHint,
    authOptions: authOptions(definition).map((option) => ({
      id: option.id,
      label: option.label,
      input: option.input,
      credentialLabel: option.credentialLabel || null,
      identityLabel: option.identityLabel || null,
      hint: option.credentialHint
    }))
  };
}

function publicConfiguration(state, credentialStore) {
  const credentialMetadata = credentialStore.publicSnapshot();
  const infrastructureEnvironments = Object.values(state.infrastructureTargets)
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
    .map((target) => infrastructureTargetMetadata(state, credentialMetadata, target));
  const infrastructureServices = Object.values(state.infrastructureServices || {})
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
    .map((service) => infrastructureServiceMetadata(state, credentialMetadata, service));
  return {
    instanceId: state.instanceId,
    policy: {
      allowedCidrs: [...state.policy.allowedCidrs],
      allowPublicHttps: state.policy.allowPublicHttps,
      revision: state.policy.revision
    },
    services: SERVICE_IDS.map((service) => connectionMetadata(state, credentialMetadata, service)),
    infrastructureDefinitions: publicInfrastructureDefinitions(),
    infrastructureServiceDefinitions: publicInfrastructureServiceDefinitions(),
    infrastructureServices,
    infrastructureEnvironments,
    // Compatibility alias for v0.7 browsers during rolling container upgrades.
    infrastructureTargets: infrastructureEnvironments
  };
}

function translateStoreError(error) {
  if (error instanceof SessionAuthError) {
    return new ControlPlaneError(error.status || 401, error.code || "SESSION_INVALID", error.message);
  }
  if (error instanceof CredentialStoreError) {
    const status = error.code === "CREDENTIAL_NOT_CONFIGURED" ? 409 : 500;
    return new ControlPlaneError(status, error.code || "CREDENTIAL_STORE_UNAVAILABLE", error.message);
  }
  return error;
}

export async function createControlPlane(options) {
  const stateStore = options?.stateStore;
  if (!stateStore || typeof stateStore.snapshot !== "function" || typeof stateStore.mutate !== "function") {
    throw new Error("The control plane requires an initialized state store.");
  }
  const dataDir = options.dataDir;
  const version = String(options.version || "development");
  const lookup = options.lookup;
  const log = typeof options.log === "function" ? options.log : () => {};
  const testServiceConnection = typeof options.testServiceConnection === "function"
    ? options.testServiceConnection
    : null;
  const exchangeServiceLogin = typeof options.exchangeServiceLogin === "function"
    ? options.exchangeServiceLogin
    : null;
  const testInfrastructureConnection = typeof options.testInfrastructureConnection === "function"
    ? options.testInfrastructureConnection
    : null;
  const testInfrastructureServiceConnection = typeof options.testInfrastructureServiceConnection === "function"
    ? options.testInfrastructureServiceConnection
    : null;
  const fetchMediaArtwork = typeof options.fetchMediaArtwork === "function"
    ? options.fetchMediaArtwork
    : null;
  const credentialStore = options.credentialStore || new CredentialStore(dataDir, {
    instanceId: stateStore.snapshot().instanceId,
    keyFilePath: options.keyFilePath,
    guard: options.stateGuard
  });
  const sessionStore = options.sessionStore || new SessionAuthStore(dataDir, { guard: options.stateGuard });
  await credentialStore.initialize();
  await sessionStore.initialize();

  // beta.2 bound ciphertext to the canonical URL. Upgrade those records once
  // so beta.3 additionally binds authentication mode and the complete outbound
  // network authorization boundary. The old ciphertext remains intact until
  // the new authenticated record is durable, making an interrupted migration
  // retryable without ever exposing cleartext.
  async function migrateLegacyCredentialBindings() {
    const state = stateStore.snapshot();
    const metadata = credentialStore.publicSnapshot();
    let migrated = false;
    for (const service of SERVICE_IDS) {
      const connection = state.connections[service];
      if (!connection) continue;
      const definition = SERVICE_DEFINITIONS[service];
      const field = credentialField(definition, connection);
      const legacyNamespace = legacyCredentialNamespace(service, connection);
      const boundNamespace = credentialNamespace(service, connection, state.policy);
      const legacyConfigured = Boolean(metadata.credentials?.[legacyNamespace]?.[field]?.configured);
      const boundConfigured = Boolean(metadata.credentials?.[boundNamespace]?.[field]?.configured);
      if (legacyConfigured && !boundConfigured) {
        await credentialStore.useCredential(legacyNamespace, field, (credential) => (
          credentialStore.replaceServiceCredentials(boundNamespace, { [field]: credential })
        ));
        migrated = true;
      }
      if (legacyConfigured) {
        await credentialStore.removeServiceCredentials(legacyNamespace);
        migrated = true;
      }
    }
    if (migrated) log("Credential destination bindings upgraded.");
  }

  await migrateLegacyCredentialBindings();

  let monitor = options.monitor || null;
  const pairingInvites = new Map();
  const loginAttempts = new Map();
  let serviceMutationChain = Promise.resolve();

  async function serializeServiceMutation(operation) {
    const pending = serviceMutationChain.catch(() => {}).then(operation);
    serviceMutationChain = pending.then(() => {}, () => {});
    return pending;
  }

  function prunePairingInvites(now = Date.now()) {
    for (const [verifier, invite] of pairingInvites) {
      if (invite.expiresAt <= now) pairingInvites.delete(verifier);
    }
  }

  function consumeLoginAttempt(service, now = Date.now()) {
    // Deliberately scope this to the service, not the browser session. A new
    // pairing or renewed session must not reset the upstream password-guessing
    // budget. Since `service` is a validated SERVICE_IDS value, this map is
    // strictly bounded by the number of supported services.
    const current = loginAttempts.get(service);
    if (!current || current.startedAt + LOGIN_WINDOW_MS <= now) {
      loginAttempts.set(service, { startedAt: now, attempts: 1 });
      return;
    }
    if (current.attempts >= MAX_LOGIN_ATTEMPTS_PER_WINDOW) {
      fail(429, "LOGIN_RATE_LIMITED", "Too many service sign-in attempts. Wait a few minutes and try again.");
    }
    current.attempts += 1;
  }

  async function connectionsForPolicy(state, policy) {
    const exactMode = policy.allowedCidrs.length === 0;
    const entries = await Promise.all(Object.entries(state.connections).map(async ([service, connection]) => {
      try {
        if (!exactMode) {
          await resolveAndAuthorizeTarget(connection.url, policy, { lookup, approvedHostCidrs: [] });
          return [service, { ...connection, approvedHostCidrs: [] }];
        }

        // Clearing a manual network policy must not silently broaden access.
        // First prove the target is allowed by the current policy/connection,
        // then carry only its currently resolved exact private hosts forward.
        const current = await resolveAndAuthorizeTarget(connection.url, state.policy, {
          lookup,
          approvedHostCidrs: connection.approvedHostCidrs || []
        });
        const candidate = await resolveAndAuthorizeTarget(connection.url, policy, {
          lookup,
          approvedHostCidrs: current.approvedHostCidrs
        });
        return [service, { ...connection, approvedHostCidrs: candidate.approvedHostCidrs }];
      } catch {
        fail(409, "POLICY_BLOCKS_CONNECTION", `The proposed policy would block the configured ${service} target.`);
      }
    }));
    return Object.fromEntries(entries);
  }

  async function infrastructureTargetsForPolicy(state, policy) {
    const exactMode = policy.allowedCidrs.length === 0;
    const policyChanged = state.policy.allowPublicHttps !== policy.allowPublicHttps
      || !sameStrings(state.policy.allowedCidrs, policy.allowedCidrs);
    const entries = await Promise.all(Object.entries(state.infrastructureTargets || {}).map(async ([id, target]) => {
      const updatedEndpoints = [];
      let endpointChanged = false;
      for (const endpoint of infrastructureEndpoints(target)) {
        try {
          let approvedHostCidrs;
          if (!exactMode) {
            await resolveAndAuthorizeTarget(endpoint.url, policy, { lookup, approvedHostCidrs: [] });
            approvedHostCidrs = [];
          } else {
            const current = await resolveAndAuthorizeTarget(endpoint.url, state.policy, {
              lookup,
              approvedHostCidrs: endpoint.approvedHostCidrs || []
            });
            const candidate = await resolveAndAuthorizeTarget(endpoint.url, policy, {
              lookup,
              approvedHostCidrs: current.approvedHostCidrs
            });
            approvedHostCidrs = candidate.approvedHostCidrs;
          }
          const approvalChanged = !sameStrings(endpoint.approvedHostCidrs || [], approvedHostCidrs);
          const changed = policyChanged || approvalChanged;
          endpointChanged ||= changed;
          updatedEndpoints.push({
            ...endpoint,
            approvedHostCidrs,
            targetRevision: changed ? randomUUID() : endpoint.targetRevision,
            updatedAt: changed ? new Date().toISOString() : endpoint.updatedAt
          });
        } catch {
          fail(
            409,
            "POLICY_BLOCKS_INFRASTRUCTURE_TARGET",
            `The proposed policy would block the ${endpoint.label} endpoint for ${target.displayName}.`
          );
        }
      }
      const primaryEndpointId = target.primaryEndpointId || target.id;
      const primary = updatedEndpoints.find((endpoint) => endpoint.id === primaryEndpointId) || updatedEndpoints[0];
      return [id, {
        ...target,
        primaryEndpointId: primary.id,
        endpoints: updatedEndpoints,
        url: primary.url,
        tlsMode: primary.tlsMode,
        certificateFingerprint: primary.certificateFingerprint,
        approvedHostCidrs: [...primary.approvedHostCidrs],
        targetRevision: endpointChanged ? randomUUID() : target.targetRevision,
        updatedAt: endpointChanged ? new Date().toISOString() : target.updatedAt
      }];
    }));
    return Object.fromEntries(entries);
  }

  async function infrastructureServicesForPolicy(state, policy) {
    const exactMode = policy.allowedCidrs.length === 0;
    const policyChanged = state.policy.allowPublicHttps !== policy.allowPublicHttps
      || !sameStrings(state.policy.allowedCidrs, policy.allowedCidrs);
    const entries = await Promise.all(
      Object.entries(state.infrastructureServices || {}).map(async ([id, service]) => {
        try {
          let approvedHostCidrs;
          if (!exactMode) {
            await resolveAndAuthorizeTarget(service.url, policy, { lookup, approvedHostCidrs: [] });
            approvedHostCidrs = [];
          } else {
            const current = await resolveAndAuthorizeTarget(service.url, state.policy, {
              lookup,
              approvedHostCidrs: service.approvedHostCidrs || []
            });
            const candidate = await resolveAndAuthorizeTarget(service.url, policy, {
              lookup,
              approvedHostCidrs: current.approvedHostCidrs
            });
            approvedHostCidrs = candidate.approvedHostCidrs;
          }
          const approvalChanged = !sameStrings(service.approvedHostCidrs || [], approvedHostCidrs);
          const changed = policyChanged || approvalChanged;
          return [id, {
            ...service,
            approvedHostCidrs,
            targetRevision: changed ? randomUUID() : service.targetRevision,
            updatedAt: changed ? new Date().toISOString() : service.updatedAt
          }];
        } catch {
          fail(
            409,
            "POLICY_BLOCKS_INFRASTRUCTURE_SERVICE",
            `The proposed policy would block the ${service.displayName} infrastructure service.`
          );
        }
      })
    );
    return Object.fromEntries(entries);
  }

  async function authenticate(request, requireCsrf = false) {
    try {
      return await sessionStore.authenticateRequest(request, { requireCsrf });
    } catch (error) {
      throw translateStoreError(error);
    }
  }

  async function useServiceCredential(serviceValue, expectedConnection, consumer) {
    const service = canonicalServiceId(serviceValue);
    if (!service) fail(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    const definition = SERVICE_DEFINITIONS[service];
    const connection = stateStore.snapshot().connections[service];
    if (!connection) fail(409, "SERVICE_NOT_CONFIGURED", "That service is not configured.");
    if (!expectedConnection
      || expectedConnection.url !== connection.url
      || expectedConnection.targetRevision !== connection.targetRevision) {
      fail(409, "TARGET_CHANGED", "The service target changed while this check was starting.");
    }
    if (typeof consumer !== "function") fail(500, "INVALID_CREDENTIAL_CONSUMER", "The credential consumer is unavailable.");
    const namespace = credentialNamespace(service, expectedConnection, stateStore.snapshot().policy);
    try {
      return await credentialStore.useCredential(namespace, credentialField(definition, connection), consumer);
    } catch (error) {
      throw translateStoreError(error);
    }
  }

  async function useInfrastructureCredentials(targetId, expectedTarget, consumer, endpointId = null) {
    if (typeof targetId !== "string" || !UUID.test(targetId)) {
      fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That infrastructure target does not exist.");
    }
    const state = stateStore.snapshot();
    const target = state.infrastructureTargets?.[targetId];
    if (!target) fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That infrastructure target does not exist.");
    if (!expectedTarget
      || expectedTarget.id !== target.id
      || expectedTarget.targetRevision !== target.targetRevision) {
      fail(409, "TARGET_CHANGED", "The infrastructure target changed while this check was starting.");
    }
    const endpoint = endpointId
      ? infrastructureEndpoints(target).find((entry) => entry.id === endpointId)
      : primaryInfrastructureEndpoint(target);
    const expectedEndpoint = endpointId
      ? infrastructureEndpoints(expectedTarget).find((entry) => entry.id === endpointId)
      : primaryInfrastructureEndpoint(expectedTarget);
    if (!endpoint
      || !expectedEndpoint
      || endpoint.url !== expectedEndpoint.url
      || endpoint.targetRevision !== expectedEndpoint.targetRevision) {
      fail(409, "TARGET_CHANGED", "The Proxmox endpoint changed while this check was starting.");
    }
    if (typeof consumer !== "function") fail(500, "INVALID_CREDENTIAL_CONSUMER", "The credential consumer is unavailable.");
    const namespace = infrastructureCredentialNamespace(target, state.policy, endpoint);
    try {
      return await credentialStore.useCredential(namespace, "tokenId", (tokenId) => (
        credentialStore.useCredential(namespace, "tokenSecret", (tokenSecret) => (
          consumer({ tokenId, tokenSecret })
        ))
      ));
    } catch (error) {
      throw translateStoreError(error);
    }
  }

  async function useInfrastructureServiceCredentials(serviceId, expectedService, consumer) {
    if (typeof serviceId !== "string" || !UUID.test(serviceId)) {
      fail(404, "INFRASTRUCTURE_SERVICE_NOT_FOUND", "That infrastructure service does not exist.");
    }
    const state = stateStore.snapshot();
    const service = state.infrastructureServices?.[serviceId];
    if (!service) {
      fail(404, "INFRASTRUCTURE_SERVICE_NOT_FOUND", "That infrastructure service does not exist.");
    }
    if (!expectedService
      || expectedService.id !== service.id
      || expectedService.url !== service.url
      || expectedService.targetRevision !== service.targetRevision) {
      fail(409, "TARGET_CHANGED", "The infrastructure service changed while this check was starting.");
    }
    if (typeof consumer !== "function") {
      fail(500, "INVALID_CREDENTIAL_CONSUMER", "The credential consumer is unavailable.");
    }
    const namespace = infrastructureServiceCredentialNamespace(service, state.policy);
    try {
      return await credentialStore.useCredential(namespace, "accessToken", (accessToken) => (
        consumer({ accessToken })
      ));
    } catch (error) {
      throw translateStoreError(error);
    }
  }

  async function verifyInfrastructureIdentity({
    type,
    target,
    targetResolution,
    targetRevision,
    tlsMode,
    certificateFingerprint,
    credentials,
    expectedIdentity = null
  }) {
    if (!testInfrastructureConnection) {
      fail(503, "CONNECTION_TEST_UNAVAILABLE", "Proxmox discovery is temporarily unavailable.");
    }
    const result = await testInfrastructureConnection({
      type,
      target,
      targetResolution,
      targetRevision,
      tlsMode,
      certificateFingerprint,
      credentials,
      scope: "endpoint"
    });
    if (result?.connectionState !== "connected") {
      fail(400, "PROXMOX_VERIFICATION_FAILED", "Proxmox did not accept the endpoint trust and API token.");
    }
    const identity = normalizeDiscoveredEnvironmentIdentity(result.discovery);
    if (!identity) {
      fail(409, "ENVIRONMENT_DISCOVERY_REQUIRED", "Proxmox did not return a stable standalone-server or cluster identity.");
    }
    if (expectedIdentity && !sameEnvironmentIdentity(expectedIdentity, identity)) {
      fail(409, "ENVIRONMENT_IDENTITY_MISMATCH", "That endpoint reports a different Proxmox environment.");
    }
    return identity;
  }

  async function status(request, response) {
    if (request.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    try {
      requestBinding(request);
    } catch (error) {
      throw translateStoreError(error);
    }
    const state = stateStore.snapshot();
    let authenticated = null;
    try {
      authenticated = await sessionStore.authenticateRequest(request);
    } catch (error) {
      if (!(error instanceof SessionAuthError)) throw error;
    }
    sendJson(response, 200, {
      version,
      instanceId: state.instanceId,
      setupRequired: !state.claimed,
      authenticated: Boolean(authenticated),
      session: authenticated?.session || null,
      csrfToken: authenticated?.csrfToken || null,
      secureOriginRequired: true,
      storage: {
        credentialsEncrypted: true,
        externalKey: Boolean(options.keyFilePath)
      }
    });
  }

  async function claim(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const before = stateStore.snapshot();
    if (before.claimed) {
      request.resume();
      fail(409, "ALREADY_CLAIMED", "First-time setup has already been completed.");
    }
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["setupToken", "deviceName", "origin", "allowedCidrs", "allowPublicHttps"]);
    let binding;
    try {
      binding = claimRequestBinding(request, body.origin);
    } catch (error) {
      throw translateStoreError(error);
    }
    if (!tokenMatches(before.setupTokenHash, body.setupToken)) {
      fail(401, "SETUP_TOKEN_INVALID", "The one-time setup token is invalid.");
    }
    const name = safeDeviceName(body.deviceName);
    const policy = normalizePolicy({
      allowedCidrs: body.allowedCidrs,
      allowPublicHttps: body.allowPublicHttps
    });
    const connections = await connectionsForPolicy(before, policy);
    const infrastructureTargets = await infrastructureTargetsForPolicy(before, policy);
    const infrastructureServices = await infrastructureServicesForPolicy(before, policy);

    let issued;
    try {
      issued = await sessionStore.issue({ name, origin: body.origin, host: binding.host });
      await stateStore.mutate((next) => {
        if (next.claimed || !tokenMatches(next.setupTokenHash, body.setupToken)) {
          fail(409, "SETUP_TOKEN_USED", "The one-time setup token has already been used.");
        }
        next.claimed = true;
        next.claimedAt = new Date().toISOString();
        next.setupTokenHash = null;
        next.policy = { ...policy, revision: next.policy.revision + 1 };
        next.connections = connections;
        next.infrastructureTargets = infrastructureTargets;
        next.infrastructureServices = infrastructureServices;
        next.devices = {};
      });
    } catch (error) {
      if (issued?.session?.id) await sessionStore.revoke(issued.session.id).catch(() => {});
      throw translateStoreError(error);
    }
    response.setHeader("Set-Cookie", issued.cookie);
    log("First-time setup completed and a browser session was issued.");
    sendJson(response, 201, {
      session: issued.session,
      csrfToken: issued.csrfToken,
      config: publicConfiguration(stateStore.snapshot(), credentialStore)
    });
  }

  async function session(request, response) {
    if (request.method === "GET") {
      const authenticated = await authenticate(request, false);
      sendJson(response, 200, authenticated);
      return;
    }
    if (request.method === "DELETE") {
      const authenticated = await authenticate(request, true);
      await sessionStore.revoke(authenticated.session.id);
      response.setHeader("Set-Cookie", sessionStore.expiredCookie(authenticated.session.origin));
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function createPairingInvite(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const authenticated = await authenticate(request, true);
    const body = await readBoundedJson(request);
    requireExactKeys(body, []);
    const now = Date.now();
    prunePairingInvites(now);
    if (pairingInvites.size >= MAX_PAIRING_INVITES) {
      fail(409, "PAIRING_LIMIT_REACHED", "Wait for an unused browser invite to expire before creating another.");
    }
    const pairingToken = generateSecretToken();
    const expiresAt = now + PAIRING_TTL_MS;
    pairingInvites.set(hashToken(pairingToken), {
      origin: authenticated.session.origin,
      expiresAt
    });
    sendJson(response, 201, {
      pairingToken,
      expiresAt: new Date(expiresAt).toISOString()
    });
  }

  async function pairSession(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["pairingToken", "deviceName", "origin"]);
    let binding;
    try {
      binding = claimRequestBinding(request, body.origin);
    } catch (error) {
      throw translateStoreError(error);
    }
    const now = Date.now();
    prunePairingInvites(now);
    const verifier = hashToken(body.pairingToken);
    const invite = pairingInvites.get(verifier);
    if (!invite || !tokenMatches(verifier, body.pairingToken) || invite.origin !== body.origin) {
      fail(401, "PAIRING_TOKEN_INVALID", "The one-time browser invite is invalid or expired.");
    }
    pairingInvites.delete(verifier);
    let issued;
    try {
      issued = await sessionStore.issue({
        name: safeDeviceName(body.deviceName),
        origin: body.origin,
        host: binding.host
      });
    } catch (error) {
      throw translateStoreError(error);
    }
    response.setHeader("Set-Cookie", issued.cookie);
    sendJson(response, 201, { session: issued.session, csrfToken: issued.csrfToken });
  }

  async function sessions(request, response, sessionId) {
    const authenticated = await authenticate(request, request.method !== "GET");
    if (request.method === "GET" && !sessionId) {
      sendJson(response, 200, { currentSessionId: authenticated.session.id, sessions: sessionStore.list() });
      return;
    }
    if (request.method === "DELETE" && sessionId) {
      const removed = await sessionStore.revoke(sessionId);
      if (!removed) fail(404, "SESSION_NOT_FOUND", "That browser session does not exist.");
      if (sessionId === authenticated.session.id) {
        response.setHeader("Set-Cookie", sessionStore.expiredCookie(authenticated.session.origin));
      }
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function configuration(request, response) {
    await authenticate(request, request.method !== "GET");
    if (request.method === "GET") {
      const state = stateStore.snapshot();
      sendJson(response, 200, publicConfiguration(state, credentialStore));
      return;
    }
    if (request.method !== "PUT") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["allowedCidrs", "allowPublicHttps"]);
    const policy = normalizePolicy(body);
    let configured;
    await serializeServiceMutation(async () => {
      const state = stateStore.snapshot();
      const connections = await connectionsForPolicy(state, policy);
      const infrastructureTargets = await infrastructureTargetsForPolicy(state, policy);
      const infrastructureServices = await infrastructureServicesForPolicy(state, policy);
      const credentialMetadata = credentialStore.publicSnapshot();
      const staged = [];
      try {
        for (const service of SERVICE_IDS) {
          const previous = state.connections[service];
          const nextConnection = connections[service];
          if (!previous || !nextConnection) continue;
          const definition = SERVICE_DEFINITIONS[service];
          const field = credentialField(definition, previous);
          if (!credentialRecord(credentialMetadata, service, previous, state.policy)?.configured) continue;
          const previousNamespace = credentialNamespace(service, previous, state.policy);
          const nextNamespace = credentialNamespace(service, nextConnection, policy);
          if (previousNamespace === nextNamespace) continue;
          await credentialStore.useCredential(previousNamespace, field, (credential) => (
            credentialStore.replaceServiceCredentials(nextNamespace, { [field]: credential })
          ));
          staged.push({ previousNamespace, nextNamespace });
        }

        for (const [id, previous] of Object.entries(state.infrastructureTargets || {})) {
          const nextTarget = infrastructureTargets[id];
          if (!nextTarget) continue;
          for (const previousEndpoint of infrastructureEndpoints(previous)) {
            const nextEndpoint = infrastructureEndpoints(nextTarget)
              .find((endpoint) => endpoint.id === previousEndpoint.id);
            if (!nextEndpoint) continue;
            const credential = infrastructureCredentialMetadata(
              credentialMetadata,
              previous,
              state.policy,
              previousEndpoint
            );
            if (!credential.configured) continue;
            const previousNamespace = infrastructureCredentialNamespace(previous, state.policy, previousEndpoint);
            const nextNamespace = infrastructureCredentialNamespace(nextTarget, policy, nextEndpoint);
            if (previousNamespace === nextNamespace) continue;
            await credentialStore.useCredential(previousNamespace, "tokenId", (tokenId) => (
              credentialStore.useCredential(previousNamespace, "tokenSecret", (tokenSecret) => (
                credentialStore.replaceServiceCredentials(nextNamespace, { tokenId, tokenSecret })
              ))
            ));
            staged.push({ previousNamespace, nextNamespace });
          }
        }

        for (const [id, previous] of Object.entries(state.infrastructureServices || {})) {
          const nextService = infrastructureServices[id];
          if (!nextService) continue;
          const credential = infrastructureServiceCredentialMetadata(
            credentialMetadata,
            previous,
            state.policy
          );
          if (!credential.configured) continue;
          const previousNamespace = infrastructureServiceCredentialNamespace(previous, state.policy);
          const nextNamespace = infrastructureServiceCredentialNamespace(nextService, policy);
          if (previousNamespace === nextNamespace) continue;
          await credentialStore.useCredential(previousNamespace, "accessToken", (accessToken) => (
            credentialStore.replaceServiceCredentials(nextNamespace, { accessToken })
          ));
          staged.push({ previousNamespace, nextNamespace });
        }

        const revision = state.revision;
        await stateStore.mutate((next) => {
          if (next.revision !== revision) fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
          next.policy = { ...policy, revision: next.policy.revision + 1 };
          next.connections = connections;
          next.infrastructureTargets = infrastructureTargets;
          next.infrastructureServices = infrastructureServices;
        });
      } catch (error) {
        for (const { nextNamespace } of staged) {
          await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
        }
        throw error;
      }
      for (const { previousNamespace } of staged) {
        await credentialStore.removeServiceCredentials(previousNamespace).catch(() => {
          log("An obsolete encrypted credential record could not be cleaned up.");
        });
      }
      configured = publicConfiguration(stateStore.snapshot(), credentialStore);
    });
    monitor?.requestRefresh?.();
    sendJson(response, 200, configured);
  }

  async function services(request, response, serviceValue) {
    await authenticate(request, request.method !== "GET");
    const service = serviceValue ? canonicalServiceId(serviceValue) : null;
    if (serviceValue && !service) fail(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    if (!serviceValue && request.method === "GET") {
      sendJson(response, 200, publicConfiguration(stateStore.snapshot(), credentialStore));
      return;
    }
    if (!service) fail(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    if (request.method === "GET") {
      sendJson(response, 200, connectionMetadata(stateStore.snapshot(), credentialStore.publicSnapshot(), service));
      return;
    }
    if (request.method === "DELETE") {
      await serializeServiceMutation(async () => {
        const before = stateStore.snapshot();
        const credentialMetadata = credentialStore.publicSnapshot();
        const namespaces = credentialNamespacesForService(credentialMetadata, service);
        await stateStore.mutate((next) => { delete next.connections[service]; });
        for (const namespace of namespaces) await credentialStore.removeServiceCredentials(namespace);
      });
      monitor?.requestRefresh?.();
      noContent(response);
      return;
    }
    if (request.method !== "PUT") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["url", "authMode", "credential", "login", "clearCredential", "monitoringEnabled"]);
    if (typeof body.url !== "string") fail(400, "INVALID_TARGET", "Enter one service URL.");
    const target = parseServiceUrl(body.url);
    const definition = SERVICE_DEFINITIONS[service];
    const authMode = normalizeAuthMode(definition, body.authMode);
    const selectedAuth = authOption(definition, authMode);
    if (body.clearCredential !== undefined && typeof body.clearCredential !== "boolean") {
      fail(400, "INVALID_REQUEST", "clearCredential must be a boolean.");
    }
    if (body.monitoringEnabled !== undefined && typeof body.monitoringEnabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "monitoringEnabled must be a boolean.");
    }
    if ((body.credential !== undefined || body.login !== undefined) && body.clearCredential === true) {
      fail(400, "INVALID_REQUEST", "A credential cannot be saved and cleared together.");
    }
    if (selectedAuth.input === "login" && body.credential !== undefined) {
      fail(400, "INVALID_REQUEST", "Use the username and password fields for this authentication mode.");
    }
    if (selectedAuth.input === "secret" && body.login !== undefined) {
      fail(400, "INVALID_REQUEST", "Use the API credential field for this authentication mode.");
    }
    if (["jellyfin", "seerr"].includes(service) && body.clearCredential === true) {
      fail(400, "CREDENTIAL_REQUIRED", "Jellyfin and Seerr connections require authentication. Remove the service to delete its credential.");
    }

    const directCredential = body.credential === undefined
      ? null
      : Buffer.from(normalizeSecret(service, body.credential), "utf8");
    const login = body.login === undefined ? null : normalizeLogin(service, body.login);
    if (Object.hasOwn(body, "credential")) body.credential = undefined;
    if (Object.hasOwn(body, "login")) body.login = undefined;
    try {
      if (login) {
        if (!exchangeServiceLogin) fail(503, "LOGIN_EXCHANGE_UNAVAILABLE", "Service sign-in is temporarily unavailable.");
        consumeLoginAttempt(service);
      }
      await serializeServiceMutation(async () => {
        const state = stateStore.snapshot();
        const previous = state.connections[service];
        const targetChanged = previous?.url !== target.url;
        const authChanged = Boolean(previous) && (previous.authMode || definition.authMode) !== authMode;
        const previousNamespace = credentialNamespace(service, previous, state.policy);
        const metadata = credentialStore.publicSnapshot();
        const hadCredential = Boolean(credentialRecord(metadata, service, previous, state.policy)?.configured);
        const submittedCredential = Boolean(directCredential || login);
        const retainingCredential = Boolean(
          previous
          && !targetChanged
          && !authChanged
          && hadCredential
          && !submittedCredential
          && body.clearCredential !== true
        );
        // A saved credential may only be reused against the private addresses
        // approved with its existing connection. Fresh credentials can enroll
        // a deliberately reviewed address, but a DNS change alone cannot make
        // Helmsman replay an old secret to a new host.
        const resolution = retainingCredential
          ? await resolveAndAuthorizeTarget(target, state.policy, {
            lookup,
            approvedHostCidrs: previous.approvedHostCidrs || []
          })
          : await resolveAndAuthorizeExplicitTarget(target, state.policy, { lookup });
        // Exact host approvals are the default policy when no manual CIDRs
        // are configured. Under a manual CIDR policy the CIDR itself is the
        // authorization boundary, so retaining redundant per-host approvals
        // would both widen a later check and make credential bindings change
        // unnecessarily when access is reset and claimed again.
        const approvedHostCidrs = state.policy.allowedCidrs.length === 0
          ? retainingCredential
            ? [...(previous.approvedHostCidrs || [])]
            : resolution.approvedHostCidrs
          : [];
        const approvalChanged = Boolean(previous)
          && !sameStrings(previous.approvedHostCidrs || [], approvedHostCidrs);
        const targetRevision = !previous || targetChanged || authChanged || approvalChanged
          ? randomUUID()
          : previous.targetRevision;
        const nextConnection = {
          url: target.url,
          targetRevision,
          updatedAt: new Date().toISOString(),
          authMode,
          monitoringEnabled: body.monitoringEnabled === undefined
            ? previous?.monitoringEnabled !== false
            : body.monitoringEnabled,
          approvedHostCidrs
        };
        const nextNamespace = credentialNamespace(service, nextConnection, state.policy);

        if ((targetChanged || authChanged) && hadCredential && !submittedCredential && body.clearCredential !== true) {
          fail(
            409,
            "CREDENTIAL_REQUIRED_FOR_NEW_TARGET",
            "Enter a credential for the new target or authentication mode."
          );
        }
        if (["jellyfin", "seerr"].includes(service)
          && (!previous || targetChanged || authChanged || !hadCredential)
          && !submittedCredential) {
          fail(400, "CREDENTIAL_REQUIRED", "Choose an API credential or sign in with an account.");
        }

        let derivedCredential = null;
        let credential = directCredential;
        if (login) {
          derivedCredential = await exchangeServiceLogin({
            service,
            target,
            targetResolution: resolution,
            targetRevision,
            authMode,
            login
          });
          if (!Buffer.isBuffer(derivedCredential) || derivedCredential.length < 1) {
            derivedCredential?.fill?.(0);
            fail(502, "LOGIN_EXCHANGE_FAILED", "The service did not return a usable sign-in credential.");
          }
          credential = derivedCredential;
        }

        let stagedCredential = false;
        try {
          if (credential) {
            await credentialStore.replaceServiceCredentials(nextNamespace, {
              [selectedAuth.credentialField]: credential
            });
            stagedCredential = true;
          }

          try {
            const revision = state.revision;
            await stateStore.mutate((next) => {
              if (next.revision !== revision) fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
              next.connections[service] = nextConnection;
            });
          } catch (error) {
            if (stagedCredential && nextNamespace !== previousNamespace) {
              await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
            }
            throw error;
          }

          if (body.clearCredential === true) {
            const namespaces = credentialNamespacesForService(credentialStore.publicSnapshot(), service);
            for (const namespace of namespaces) await credentialStore.removeServiceCredentials(namespace);
          } else if (previousNamespace && previousNamespace !== nextNamespace) {
            await credentialStore.removeServiceCredentials(previousNamespace);
          }
        } finally {
          derivedCredential?.fill(0);
        }
      });
    } finally {
      directCredential?.fill(0);
      clearLogin(login);
    }
    monitor?.requestRefresh?.();
    sendJson(response, 200, connectionMetadata(stateStore.snapshot(), credentialStore.publicSnapshot(), service));
  }

  async function testConnection(request, response, serviceValue) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    // Connection tests can transmit a write-only credential, so they require
    // the same session, exact Origin/Host binding, and CSRF proof as a save.
    await authenticate(request, true);
    const service = canonicalServiceId(serviceValue);
    if (!service) fail(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    if (!testServiceConnection) fail(503, "CONNECTION_TEST_UNAVAILABLE", "Connection testing is temporarily unavailable.");

    const body = await readBoundedJson(request);
    requireExactKeys(body, ["url", "authMode", "credential", "login"]);
    if (typeof body.url !== "string") fail(400, "INVALID_TARGET", "Enter one service URL.");
    const target = parseServiceUrl(body.url);
    const definition = SERVICE_DEFINITIONS[service];
    const authMode = normalizeAuthMode(definition, body.authMode);
    const selectedAuth = authOption(definition, authMode);

    if (selectedAuth.input === "login" && body.credential !== undefined) {
      fail(400, "INVALID_REQUEST", "Use the username and password fields for this authentication mode.");
    }
    if (selectedAuth.input === "secret" && body.login !== undefined) {
      fail(400, "INVALID_REQUEST", "Use the API credential field for this authentication mode.");
    }

    const hasDraftCredential = body.credential !== undefined && body.credential !== "";
    if (body.credential !== undefined && typeof body.credential !== "string") {
      fail(400, "INVALID_CREDENTIAL", "Enter a valid service credential.");
    }
    const draftCredential = hasDraftCredential
      ? Buffer.from(normalizeSecret(service, body.credential), "utf8")
      : null;
    const login = body.login === undefined ? null : normalizeLogin(service, body.login);
    // Drop the reachable object reference as soon as the bounded transient
    // buffer exists. JavaScript strings cannot be zeroized, but the buffer can.
    if (Object.hasOwn(body, "credential")) body.credential = undefined;
    if (Object.hasOwn(body, "login")) body.login = undefined;

    try {
      if (login) {
        if (!exchangeServiceLogin) fail(503, "LOGIN_EXCHANGE_UNAVAILABLE", "Service sign-in is temporarily unavailable.");
        consumeLoginAttempt(service);
        const result = await testServiceConnection({ service, target, authMode, login });
        sendJson(response, 200, result);
        return;
      }
      if (draftCredential) {
        const result = await testServiceConnection({ service, target, authMode, credential: draftCredential });
        sendJson(response, 200, result);
        return;
      }

      const savedConnection = stateStore.snapshot().connections[service];
      if (!savedConnection
        || savedConnection.url !== target.url
        || (savedConnection.authMode || definition.authMode) !== authMode) {
        fail(
          400,
          "CREDENTIAL_REQUIRED_FOR_TEST",
          "Enter a credential to test a new or different service target."
        );
      }
      const result = await useServiceCredential(service, savedConnection, (credential) => (
        testServiceConnection({
          service,
          target,
          authMode,
          credential,
          approvedHostCidrs: savedConnection.approvedHostCidrs || []
        })
      ));
      sendJson(response, 200, result);
    } finally {
      draftCredential?.fill(0);
      clearLogin(login);
    }
  }

  function parseInfrastructureTargetUrl(value) {
    if (typeof value !== "string") fail(400, "INVALID_TARGET", "Enter one Proxmox HTTPS URL.");
    const target = parseServiceUrl(value);
    if (target.protocol !== "https:") {
      fail(400, "HTTPS_REQUIRED", "Proxmox infrastructure targets must use HTTPS.");
    }
    return target;
  }

  function targetById(id) {
    if (typeof id !== "string" || !UUID.test(id)) {
      fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That infrastructure target does not exist.");
    }
    const state = stateStore.snapshot();
    const target = state.infrastructureTargets?.[id];
    if (!target) fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That infrastructure target does not exist.");
    return { state, target };
  }

  async function saveInfrastructureTarget(request, response, id = null) {
    const body = await readBoundedJson(request);
    requireExactKeys(body, [
      "type",
      "displayName",
      "url",
      "enabled",
      "monitoringEnabled",
      "monitoringIntervalSeconds",
      "tlsMode",
      "certificateFingerprint",
      "credentials"
    ]);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "enabled must be a boolean.");
    }
    if (body.monitoringEnabled !== undefined && typeof body.monitoringEnabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "monitoringEnabled must be a boolean.");
    }

    let submittedCredentials = null;
    let savedTarget;
    try {
      await serializeServiceMutation(async () => {
        const state = stateStore.snapshot();
        const previous = id ? state.infrastructureTargets?.[id] : null;
        if (id && !previous) {
          fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That infrastructure target does not exist.");
        }
        if (!id && Object.keys(state.infrastructureTargets || {}).length >= MAX_INFRASTRUCTURE_TARGETS) {
          fail(409, "INFRASTRUCTURE_TARGET_LIMIT_REACHED", `No more than ${MAX_INFRASTRUCTURE_TARGETS} infrastructure targets may be configured.`);
        }

        const type = normalizeInfrastructureType(body.type === undefined ? previous?.type : body.type);
        const displayName = safeInfrastructureDisplayName(
          body.displayName === undefined ? previous?.displayName : body.displayName
        );
        const parsedTarget = parseInfrastructureTargetUrl(body.url === undefined ? previous?.url : body.url);
        const tls = normalizeInfrastructureTls(body, previous);
        const enabled = body.enabled === undefined ? previous?.enabled ?? true : body.enabled;
        const monitoringEnabled = body.monitoringEnabled === undefined
          ? previous?.monitoringEnabled ?? true
          : body.monitoringEnabled;
        const monitoringIntervalSeconds = normalizeMonitoringInterval(
          body.monitoringIntervalSeconds,
          previous?.monitoringIntervalSeconds ?? DEFAULT_INFRASTRUCTURE_MONITOR_INTERVAL_SECONDS
        );
        if (body.credentials !== undefined) {
          submittedCredentials = normalizeInfrastructureCredentials(type, body.credentials);
          body.credentials = undefined;
        }

        const previousEndpoint = primaryInfrastructureEndpoint(previous);
        const metadata = credentialStore.publicSnapshot();
        const hadCredential = Boolean(previous
          && infrastructureCredentialMetadata(metadata, previous, state.policy, previousEndpoint).configured);
        const securityChanged = Boolean(previous && (
          previous.type !== type
          || previousEndpoint?.url !== parsedTarget.url
          || previousEndpoint?.tlsMode !== tls.tlsMode
          || previousEndpoint?.certificateFingerprint !== tls.certificateFingerprint
        ));
        if ((!previous || securityChanged || !hadCredential) && !submittedCredentials) {
          fail(400, "CREDENTIAL_REQUIRED", "Enter the Proxmox API token ID and secret.");
        }

        const retainingCredential = Boolean(previous && hadCredential && !securityChanged && !submittedCredentials);
        const resolution = retainingCredential
          ? await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
            lookup,
            approvedHostCidrs: previousEndpoint?.approvedHostCidrs || []
          })
          : await resolveAndAuthorizeExplicitTarget(parsedTarget, state.policy, { lookup });
        let environmentIdentity = previous?.environmentIdentity || null;
        if (!previous || securityChanged || submittedCredentials) {
          environmentIdentity = await verifyInfrastructureIdentity({
            type,
            target: parsedTarget,
            targetResolution: resolution,
            targetRevision: randomUUID(),
            tlsMode: tls.tlsMode,
            certificateFingerprint: tls.certificateFingerprint,
            credentials: submittedCredentials,
            expectedIdentity: previous?.environmentIdentity || null
          });
        }
        const approvedHostCidrs = state.policy.allowedCidrs.length === 0
          ? retainingCredential
            ? [...(previousEndpoint?.approvedHostCidrs || [])]
            : resolution.approvedHostCidrs
          : [];
        const endpointChanged = !previousEndpoint
          || previousEndpoint.url !== parsedTarget.url
          || previousEndpoint.tlsMode !== tls.tlsMode
          || previousEndpoint.certificateFingerprint !== tls.certificateFingerprint
          || !sameStrings(previousEndpoint.approvedHostCidrs || [], approvedHostCidrs)
          || Boolean(submittedCredentials);
        const changed = !previous
          || previous.type !== type
          || previous.displayName !== displayName
          || previousEndpoint?.url !== parsedTarget.url
          || previous.enabled !== enabled
          || previous.monitoringEnabled !== monitoringEnabled
          || previous.monitoringIntervalSeconds !== monitoringIntervalSeconds
          || previousEndpoint?.tlsMode !== tls.tlsMode
          || previousEndpoint?.certificateFingerprint !== tls.certificateFingerprint
          || !sameStrings(previousEndpoint?.approvedHostCidrs || [], approvedHostCidrs)
          || Boolean(submittedCredentials);
        if (!changed) {
          savedTarget = previous;
          return;
        }

        const now = new Date().toISOString();
        const targetId = previous?.id || randomUUID();
        const endpointId = previousEndpoint?.id || targetId;
        const nextEndpoint = {
          id: endpointId,
          label: previousEndpoint?.label || "Primary endpoint",
          url: parsedTarget.url,
          targetRevision: endpointChanged ? randomUUID() : previousEndpoint.targetRevision,
          enabled: previousEndpoint?.enabled !== false,
          tlsMode: tls.tlsMode,
          certificateFingerprint: tls.certificateFingerprint,
          approvedHostCidrs,
          createdAt: previousEndpoint?.createdAt || now,
          updatedAt: endpointChanged ? now : previousEndpoint.updatedAt
        };
        const endpoints = previous
          ? infrastructureEndpoints(previous).map((endpoint) => endpoint.id === endpointId ? nextEndpoint : endpoint)
          : [nextEndpoint];
        const nextTarget = {
          id: targetId,
          type,
          displayName,
          url: parsedTarget.url,
          targetRevision: randomUUID(),
          enabled,
          monitoringEnabled,
          monitoringIntervalSeconds,
          environmentIdentity,
          tlsMode: tls.tlsMode,
          certificateFingerprint: tls.certificateFingerprint,
          approvedHostCidrs,
          primaryEndpointId: endpointId,
          endpoints,
          createdAt: previous?.createdAt || now,
          updatedAt: now
        };
        const previousNamespace = infrastructureCredentialNamespace(previous, state.policy, previousEndpoint);
        const nextNamespace = infrastructureCredentialNamespace(nextTarget, state.policy, nextEndpoint);
        let stagedCredential = false;
        try {
          if (submittedCredentials) {
            await credentialStore.replaceServiceCredentials(nextNamespace, submittedCredentials);
            stagedCredential = true;
          } else if (retainingCredential && previousNamespace !== nextNamespace) {
            await credentialStore.useCredential(previousNamespace, "tokenId", (tokenId) => (
              credentialStore.useCredential(previousNamespace, "tokenSecret", (tokenSecret) => (
                credentialStore.replaceServiceCredentials(nextNamespace, { tokenId, tokenSecret })
              ))
            ));
            stagedCredential = true;
          }
          const revision = state.revision;
          try {
            await stateStore.mutate((next) => {
              if (next.revision !== revision) fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
              next.infrastructureTargets[targetId] = nextTarget;
            });
          } catch (error) {
            if (stagedCredential) {
              await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
            }
            throw error;
          }
          if (previousNamespace && previousNamespace !== nextNamespace) {
            await credentialStore.removeServiceCredentials(previousNamespace).catch(() => {
              // The stale record is bound to the previous target revision and
              // cannot be selected again. Cleanup must not turn a committed
              // update into an apparent API failure.
              log("An obsolete infrastructure credential record could not be cleaned up.");
            });
          }
          savedTarget = nextTarget;
        } finally {
          clearInfrastructureCredentials(submittedCredentials);
          submittedCredentials = null;
        }
      });
    } finally {
      clearInfrastructureCredentials(submittedCredentials);
    }
    monitor?.requestRefresh?.();
    const state = stateStore.snapshot();
    sendJson(
      response,
      id ? 200 : 201,
      infrastructureTargetMetadata(state, credentialStore.publicSnapshot(), state.infrastructureTargets[savedTarget.id])
    );
  }

  function endpointById(target, endpointId) {
    if (typeof endpointId !== "string" || !UUID.test(endpointId)) {
      fail(404, "INFRASTRUCTURE_ENDPOINT_NOT_FOUND", "That Proxmox endpoint does not exist.");
    }
    const endpoint = infrastructureEndpoints(target).find((entry) => entry.id === endpointId);
    if (!endpoint) fail(404, "INFRASTRUCTURE_ENDPOINT_NOT_FOUND", "That Proxmox endpoint does not exist.");
    return endpoint;
  }

  async function saveInfrastructureEndpoint(request, response, targetId, endpointId = null) {
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["label", "url", "enabled", "tlsMode", "certificateFingerprint", "credentials"]);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "enabled must be a boolean.");
    }
    let submittedCredentials = null;
    let savedEndpoint;
    let savedTarget;
    try {
      await serializeServiceMutation(async () => {
        const state = stateStore.snapshot();
        const target = state.infrastructureTargets?.[targetId];
        if (!target) fail(404, "INFRASTRUCTURE_TARGET_NOT_FOUND", "That Proxmox environment does not exist.");
        const previous = endpointId ? endpointById(target, endpointId) : null;
        if (previous?.id === (target.primaryEndpointId || target.id)) {
          fail(409, "PRIMARY_ENDPOINT_MANAGED_BY_ENVIRONMENT", "Edit the primary endpoint from the environment connection dialog.");
        }
        const endpoints = infrastructureEndpoints(target);
        if (!previous && endpoints.length >= MAX_ENDPOINTS_PER_ENVIRONMENT) {
          fail(409, "INFRASTRUCTURE_ENDPOINT_LIMIT_REACHED", `No more than ${MAX_ENDPOINTS_PER_ENVIRONMENT} endpoints may be registered for one environment.`);
        }
        if (!previous && infrastructureEndpointCount(state) >= MAX_INFRASTRUCTURE_ENDPOINTS) {
          fail(409, "INFRASTRUCTURE_ENDPOINT_LIMIT_REACHED", `No more than ${MAX_INFRASTRUCTURE_ENDPOINTS} Proxmox endpoints may be registered.`);
        }
        const label = safeInfrastructureEndpointLabel(body.label, previous?.label || `Endpoint ${endpoints.length + 1}`);
        const parsedTarget = parseInfrastructureTargetUrl(body.url === undefined ? previous?.url : body.url);
        if (endpoints.some((endpoint) => endpoint.id !== previous?.id && endpoint.url === parsedTarget.url)) {
          fail(409, "ENDPOINT_ALREADY_REGISTERED", "That Proxmox endpoint is already registered for this environment.");
        }
        const tls = normalizeInfrastructureTls(body, previous);
        const enabled = body.enabled === undefined ? previous?.enabled ?? true : body.enabled;
        if (body.credentials !== undefined) {
          submittedCredentials = normalizeInfrastructureCredentials(target.type, body.credentials);
          body.credentials = undefined;
        }
        const metadata = credentialStore.publicSnapshot();
        const hadCredential = Boolean(previous
          && infrastructureCredentialMetadata(metadata, target, state.policy, previous).configured);
        const securityChanged = Boolean(previous && (
          previous.url !== parsedTarget.url
          || previous.tlsMode !== tls.tlsMode
          || previous.certificateFingerprint !== tls.certificateFingerprint
        ));
        if ((!previous || securityChanged || !hadCredential) && !submittedCredentials) {
          fail(400, "CREDENTIAL_REQUIRED", "Enter the Proxmox API token ID and secret for this endpoint.");
        }
        const retainingCredential = Boolean(previous && hadCredential && !securityChanged && !submittedCredentials);
        const resolution = retainingCredential
          ? await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
            lookup,
            approvedHostCidrs: previous.approvedHostCidrs || []
          })
          : await resolveAndAuthorizeExplicitTarget(parsedTarget, state.policy, { lookup });
        let environmentIdentity = target.environmentIdentity || null;
        if (!previous || securityChanged || submittedCredentials) {
          if (!environmentIdentity) {
            const primary = primaryInfrastructureEndpoint(target);
            const primaryTarget = parseInfrastructureTargetUrl(primary.url);
            const primaryResolution = await resolveAndAuthorizeTarget(primaryTarget, state.policy, {
              lookup,
              approvedHostCidrs: primary.approvedHostCidrs || []
            });
            environmentIdentity = await useInfrastructureCredentials(target.id, target, (credentials) => (
              verifyInfrastructureIdentity({
                type: target.type,
                target: primaryTarget,
                targetResolution: primaryResolution,
                targetRevision: primary.targetRevision,
                tlsMode: primary.tlsMode,
                certificateFingerprint: primary.certificateFingerprint,
                credentials
              })
            ), primary.id);
          }
          await verifyInfrastructureIdentity({
            type: target.type,
            target: parsedTarget,
            targetResolution: resolution,
            targetRevision: randomUUID(),
            tlsMode: tls.tlsMode,
            certificateFingerprint: tls.certificateFingerprint,
            credentials: submittedCredentials,
            expectedIdentity: environmentIdentity
          });
        }
        const approvedHostCidrs = state.policy.allowedCidrs.length === 0
          ? retainingCredential ? [...(previous.approvedHostCidrs || [])] : resolution.approvedHostCidrs
          : [];
        const changed = !previous
          || previous.label !== label
          || previous.url !== parsedTarget.url
          || previous.enabled !== enabled
          || previous.tlsMode !== tls.tlsMode
          || previous.certificateFingerprint !== tls.certificateFingerprint
          || !sameStrings(previous.approvedHostCidrs || [], approvedHostCidrs)
          || Boolean(submittedCredentials);
        if (!changed) {
          savedEndpoint = previous;
          savedTarget = target;
          return;
        }
        const now = new Date().toISOString();
        const nextEndpoint = {
          id: previous?.id || randomUUID(),
          label,
          url: parsedTarget.url,
          targetRevision: randomUUID(),
          enabled,
          tlsMode: tls.tlsMode,
          certificateFingerprint: tls.certificateFingerprint,
          approvedHostCidrs,
          createdAt: previous?.createdAt || now,
          updatedAt: now
        };
        const nextTarget = {
          ...target,
          environmentIdentity,
          targetRevision: randomUUID(),
          updatedAt: now,
          endpoints: previous
            ? endpoints.map((endpoint) => endpoint.id === previous.id ? nextEndpoint : endpoint)
            : [...endpoints, nextEndpoint]
        };
        const previousNamespace = previous
          ? infrastructureCredentialNamespace(target, state.policy, previous)
          : null;
        const nextNamespace = infrastructureCredentialNamespace(nextTarget, state.policy, nextEndpoint);
        let stagedCredential = false;
        try {
          if (submittedCredentials) {
            await credentialStore.replaceServiceCredentials(nextNamespace, submittedCredentials);
            stagedCredential = true;
          } else if (retainingCredential && previousNamespace !== nextNamespace) {
            await credentialStore.useCredential(previousNamespace, "tokenId", (tokenId) => (
              credentialStore.useCredential(previousNamespace, "tokenSecret", (tokenSecret) => (
                credentialStore.replaceServiceCredentials(nextNamespace, { tokenId, tokenSecret })
              ))
            ));
            stagedCredential = true;
          }
          const revision = state.revision;
          try {
            await stateStore.mutate((next) => {
              if (next.revision !== revision) fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
              next.infrastructureTargets[target.id] = nextTarget;
            });
          } catch (error) {
            if (stagedCredential) await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
            throw error;
          }
          if (previousNamespace && previousNamespace !== nextNamespace) {
            await credentialStore.removeServiceCredentials(previousNamespace).catch(() => {
              log("An obsolete infrastructure endpoint credential record could not be cleaned up.");
            });
          }
          savedEndpoint = nextEndpoint;
          savedTarget = nextTarget;
        } finally {
          clearInfrastructureCredentials(submittedCredentials);
          submittedCredentials = null;
        }
      });
    } finally {
      clearInfrastructureCredentials(submittedCredentials);
    }
    monitor?.requestRefresh?.();
    const state = stateStore.snapshot();
    const target = state.infrastructureTargets[savedTarget.id];
    const endpoint = infrastructureEndpoints(target).find(({ id }) => id === savedEndpoint.id);
    sendJson(
      response,
      endpointId ? 200 : 201,
      infrastructureEndpointMetadata(
        state,
        credentialStore.publicSnapshot(),
        target,
        endpoint,
        target.primaryEndpointId || target.id
      )
    );
  }

  async function infrastructureTargets(request, response, id = null) {
    await authenticate(request, request.method !== "GET");
    if (!id && request.method === "GET") {
      const state = stateStore.snapshot();
      const targets = Object.values(state.infrastructureTargets || {})
        .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
        .map((target) => infrastructureTargetMetadata(state, credentialStore.publicSnapshot(), target));
      sendJson(response, 200, {
        definitions: publicInfrastructureDefinitions(),
        environments: targets,
        targets
      });
      return;
    }
    if (!id && request.method === "POST") {
      await saveInfrastructureTarget(request, response);
      return;
    }
    const { state, target } = targetById(id);
    if (request.method === "GET") {
      sendJson(response, 200, infrastructureTargetMetadata(state, credentialStore.publicSnapshot(), target));
      return;
    }
    if (request.method === "PUT") {
      await saveInfrastructureTarget(request, response, id);
      return;
    }
    if (request.method === "DELETE") {
      await serializeServiceMutation(async () => {
        targetById(id);
        const namespaces = infrastructureCredentialNamespaces(credentialStore.publicSnapshot(), id);
        await stateStore.mutate((next) => { delete next.infrastructureTargets[id]; });
        for (const namespace of namespaces) {
          await credentialStore.removeServiceCredentials(namespace).catch(() => {
            // Destination- and target-revision binding makes this orphan
            // unusable after the state record is removed.
            log("A removed infrastructure credential record could not be cleaned up.");
          });
        }
      });
      monitor?.requestRefresh?.();
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function infrastructureEndpointsApi(request, response, targetId, endpointId = null) {
    await authenticate(request, request.method !== "GET");
    const { state, target } = targetById(targetId);
    if (!endpointId && request.method === "GET") {
      const primaryEndpointId = target.primaryEndpointId || target.id;
      sendJson(response, 200, {
        endpoints: infrastructureEndpoints(target).map((endpoint) => infrastructureEndpointMetadata(
          state,
          credentialStore.publicSnapshot(),
          target,
          endpoint,
          primaryEndpointId
        ))
      });
      return;
    }
    if (!endpointId && request.method === "POST") {
      await saveInfrastructureEndpoint(request, response, targetId);
      return;
    }
    const endpoint = endpointById(target, endpointId);
    if (request.method === "GET") {
      sendJson(response, 200, infrastructureEndpointMetadata(
        state,
        credentialStore.publicSnapshot(),
        target,
        endpoint,
        target.primaryEndpointId || target.id
      ));
      return;
    }
    if (request.method === "PUT") {
      await saveInfrastructureEndpoint(request, response, targetId, endpointId);
      return;
    }
    if (request.method === "DELETE") {
      if (endpoint.id === (target.primaryEndpointId || target.id)) {
        fail(409, "PRIMARY_ENDPOINT_REQUIRED", "The primary endpoint cannot be removed without removing the environment.");
      }
      await serializeServiceMutation(async () => {
        const current = targetById(targetId);
        const currentEndpoint = endpointById(current.target, endpointId);
        const namespace = infrastructureCredentialNamespace(current.target, current.state.policy, currentEndpoint);
        const revision = current.state.revision;
        await stateStore.mutate((next) => {
          if (next.revision !== revision) fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
          const environment = next.infrastructureTargets[targetId];
          environment.endpoints = infrastructureEndpoints(environment).filter(({ id }) => id !== endpointId);
          environment.targetRevision = randomUUID();
          environment.updatedAt = new Date().toISOString();
        });
        await credentialStore.removeServiceCredentials(namespace).catch(() => {
          log("A removed infrastructure endpoint credential record could not be cleaned up.");
        });
      });
      monitor?.requestRefresh?.();
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function testInfrastructureEndpoint(request, response, targetId, endpointId = null) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!testInfrastructureConnection) {
      fail(503, "CONNECTION_TEST_UNAVAILABLE", "Infrastructure connection testing is temporarily unavailable.");
    }
    const { state, target } = targetById(targetId);
    const body = await readBoundedJson(request);
    if (endpointId) {
      requireExactKeys(body, []);
      const endpoint = endpointById(target, endpointId);
      const parsedTarget = parseInfrastructureTargetUrl(endpoint.url);
      const targetResolution = await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
        lookup,
        approvedHostCidrs: endpoint.approvedHostCidrs || []
      });
      const result = await useInfrastructureCredentials(targetId, target, (credentials) => (
        testInfrastructureConnection({
          type: target.type,
          target: parsedTarget,
          targetResolution,
          targetRevision: endpoint.targetRevision,
          tlsMode: endpoint.tlsMode,
          certificateFingerprint: endpoint.certificateFingerprint,
          credentials
        })
      ), endpoint.id);
      sendJson(response, 200, result);
      return;
    }
    requireExactKeys(body, ["label", "url", "enabled", "tlsMode", "certificateFingerprint", "credentials"]);
    const parsedTarget = parseInfrastructureTargetUrl(body.url);
    const tls = normalizeInfrastructureTls(body);
    const credentials = normalizeInfrastructureCredentials(target.type, body.credentials);
    body.credentials = undefined;
    try {
      const targetResolution = await resolveAndAuthorizeExplicitTarget(parsedTarget, state.policy, { lookup });
      const result = await testInfrastructureConnection({
        type: target.type,
        target: parsedTarget,
        targetResolution,
        targetRevision: randomUUID(),
        tlsMode: tls.tlsMode,
        certificateFingerprint: tls.certificateFingerprint,
        credentials
      });
      sendJson(response, 200, result);
    } finally {
      clearInfrastructureCredentials(credentials);
    }
  }

  async function testInfrastructureTarget(request, response, id = null) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!testInfrastructureConnection) {
      fail(503, "CONNECTION_TEST_UNAVAILABLE", "Infrastructure connection testing is temporarily unavailable.");
    }
    const body = await readBoundedJson(request);
    if (id) {
      requireExactKeys(body, []);
      const { state, target } = targetById(id);
      const primaryEndpoint = primaryInfrastructureEndpoint(target);
      const parsedTarget = parseInfrastructureTargetUrl(primaryEndpoint.url);
      const targetResolution = await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
        lookup,
        approvedHostCidrs: primaryEndpoint.approvedHostCidrs || []
      });
      const result = await useInfrastructureCredentials(id, target, (credentials) => (
        testInfrastructureConnection({
          type: target.type,
          target: parsedTarget,
          targetResolution,
          targetRevision: primaryEndpoint.targetRevision,
          tlsMode: primaryEndpoint.tlsMode,
          certificateFingerprint: primaryEndpoint.certificateFingerprint,
          credentials
        })
      ));
      sendJson(response, 200, result);
      return;
    }

    // The draft test accepts the same bounded form shape as create so clients
    // do not need a second secret-bearing payload builder. Non-connection
    // presentation/monitoring fields are deliberately ignored by the probe.
    requireExactKeys(body, [
      "type",
      "displayName",
      "url",
      "enabled",
      "monitoringEnabled",
      "monitoringIntervalSeconds",
      "tlsMode",
      "certificateFingerprint",
      "credentials"
    ]);
    const type = normalizeInfrastructureType(body.type);
    const target = parseInfrastructureTargetUrl(body.url);
    const tls = normalizeInfrastructureTls(body);
    const credentials = normalizeInfrastructureCredentials(type, body.credentials);
    body.credentials = undefined;
    try {
      const state = stateStore.snapshot();
      const targetResolution = await resolveAndAuthorizeExplicitTarget(target, state.policy, { lookup });
      const result = await testInfrastructureConnection({
        type,
        target,
        targetResolution,
        targetRevision: randomUUID(),
        tlsMode: tls.tlsMode,
        certificateFingerprint: tls.certificateFingerprint,
        credentials
      });
      sendJson(response, 200, result);
    } finally {
      clearInfrastructureCredentials(credentials);
    }
  }

  function parseInfrastructureServiceUrl(value) {
    if (typeof value !== "string") fail(400, "INVALID_TARGET", "Enter one Portainer HTTPS URL.");
    const target = parseServiceUrl(value);
    if (target.protocol !== "https:") {
      fail(400, "HTTPS_REQUIRED", "Portainer infrastructure services must use HTTPS.");
    }
    return target;
  }

  function infrastructureServiceById(id) {
    if (typeof id !== "string" || !UUID.test(id)) {
      fail(404, "INFRASTRUCTURE_SERVICE_NOT_FOUND", "That infrastructure service does not exist.");
    }
    const state = stateStore.snapshot();
    const service = state.infrastructureServices?.[id];
    if (!service) {
      fail(404, "INFRASTRUCTURE_SERVICE_NOT_FOUND", "That infrastructure service does not exist.");
    }
    return { state, service };
  }

  async function saveInfrastructureService(request, response, id = null) {
    const body = await readBoundedJson(request);
    requireExactKeys(body, [
      "type",
      "displayName",
      "url",
      "enabled",
      "monitoringEnabled",
      "tlsMode",
      "certificateFingerprint",
      "credentials"
    ]);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "enabled must be a boolean.");
    }
    if (body.monitoringEnabled !== undefined && typeof body.monitoringEnabled !== "boolean") {
      fail(400, "INVALID_REQUEST", "monitoringEnabled must be a boolean.");
    }

    let submittedCredentials = null;
    let savedService;
    try {
      await serializeServiceMutation(async () => {
        const state = stateStore.snapshot();
        const previous = id ? state.infrastructureServices?.[id] : null;
        if (id && !previous) {
          fail(404, "INFRASTRUCTURE_SERVICE_NOT_FOUND", "That infrastructure service does not exist.");
        }
        if (!id && Object.keys(state.infrastructureServices || {}).length >= MAX_INFRASTRUCTURE_SERVICES) {
          fail(
            409,
            "INFRASTRUCTURE_SERVICE_LIMIT_REACHED",
            `No more than ${MAX_INFRASTRUCTURE_SERVICES} infrastructure services may be configured.`
          );
        }

        const type = normalizeInfrastructureServiceType(body.type === undefined ? previous?.type : body.type);
        const displayName = safeInfrastructureDisplayName(
          body.displayName === undefined ? previous?.displayName : body.displayName
        );
        const parsedTarget = parseInfrastructureServiceUrl(body.url === undefined ? previous?.url : body.url);
        const tls = normalizeInfrastructureTls(body, previous);
        const enabled = body.enabled === undefined ? previous?.enabled ?? true : body.enabled;
        const monitoringEnabled = body.monitoringEnabled === undefined
          ? previous?.monitoringEnabled ?? true
          : body.monitoringEnabled;
        if (body.credentials !== undefined) {
          submittedCredentials = normalizeInfrastructureServiceCredentials(type, body.credentials);
          body.credentials = undefined;
        }

        const metadata = credentialStore.publicSnapshot();
        const hadCredential = Boolean(previous
          && infrastructureServiceCredentialMetadata(metadata, previous, state.policy).configured);
        const securityChanged = Boolean(previous && (
          previous.type !== type
          || previous.url !== parsedTarget.url
          || previous.tlsMode !== tls.tlsMode
          || previous.certificateFingerprint !== tls.certificateFingerprint
        ));
        if ((!previous || securityChanged || !hadCredential) && !submittedCredentials) {
          fail(400, "CREDENTIAL_REQUIRED", "Enter the Portainer access token.");
        }

        const retainingCredential = Boolean(previous && hadCredential && !securityChanged && !submittedCredentials);
        const resolution = retainingCredential
          ? await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
            lookup,
            approvedHostCidrs: previous.approvedHostCidrs || []
          })
          : await resolveAndAuthorizeExplicitTarget(parsedTarget, state.policy, { lookup });
        const approvedHostCidrs = state.policy.allowedCidrs.length === 0
          ? retainingCredential ? [...(previous.approvedHostCidrs || [])] : resolution.approvedHostCidrs
          : [];
        const destinationChanged = !previous
          || securityChanged
          || !sameStrings(previous.approvedHostCidrs || [], approvedHostCidrs)
          || Boolean(submittedCredentials);
        const changed = destinationChanged
          || previous.displayName !== displayName
          || previous.enabled !== enabled
          || previous.monitoringEnabled !== monitoringEnabled;
        if (!changed) {
          savedService = previous;
          return;
        }

        const now = new Date().toISOString();
        const serviceId = previous?.id || randomUUID();
        const nextService = {
          id: serviceId,
          type,
          displayName,
          url: parsedTarget.url,
          targetRevision: destinationChanged ? randomUUID() : previous.targetRevision,
          enabled,
          monitoringEnabled,
          tlsMode: tls.tlsMode,
          certificateFingerprint: tls.certificateFingerprint,
          approvedHostCidrs,
          createdAt: previous?.createdAt || now,
          updatedAt: now
        };
        const previousNamespace = infrastructureServiceCredentialNamespace(previous, state.policy);
        const nextNamespace = infrastructureServiceCredentialNamespace(nextService, state.policy);
        let stagedCredential = false;
        try {
          if (submittedCredentials) {
            await credentialStore.replaceServiceCredentials(nextNamespace, submittedCredentials);
            stagedCredential = true;
          } else if (retainingCredential && previousNamespace !== nextNamespace) {
            await credentialStore.useCredential(previousNamespace, "accessToken", (accessToken) => (
              credentialStore.replaceServiceCredentials(nextNamespace, { accessToken })
            ));
            stagedCredential = true;
          }
          const revision = state.revision;
          try {
            await stateStore.mutate((next) => {
              if (next.revision !== revision) {
                fail(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
              }
              next.infrastructureServices[serviceId] = nextService;
            });
          } catch (error) {
            if (stagedCredential && nextNamespace !== previousNamespace) {
              await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
            }
            throw error;
          }
          if (previousNamespace && previousNamespace !== nextNamespace) {
            await credentialStore.removeServiceCredentials(previousNamespace).catch(() => {
              log("An obsolete infrastructure service credential record could not be cleaned up.");
            });
          }
          savedService = nextService;
        } finally {
          clearInfrastructureCredentials(submittedCredentials);
          submittedCredentials = null;
        }
      });
    } finally {
      clearInfrastructureCredentials(submittedCredentials);
    }
    monitor?.requestRefresh?.();
    const state = stateStore.snapshot();
    sendJson(
      response,
      id ? 200 : 201,
      infrastructureServiceMetadata(
        state,
        credentialStore.publicSnapshot(),
        state.infrastructureServices[savedService.id]
      )
    );
  }

  async function infrastructureServicesApi(request, response, id = null) {
    await authenticate(request, request.method !== "GET");
    if (!id && request.method === "GET") {
      const state = stateStore.snapshot();
      const services = Object.values(state.infrastructureServices || {})
        .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
        .map((service) => infrastructureServiceMetadata(
          state,
          credentialStore.publicSnapshot(),
          service
        ));
      sendJson(response, 200, {
        definitions: publicInfrastructureServiceDefinitions(),
        services
      });
      return;
    }
    if (!id && request.method === "POST") {
      await saveInfrastructureService(request, response);
      return;
    }
    const { state, service } = infrastructureServiceById(id);
    if (request.method === "GET") {
      sendJson(response, 200, infrastructureServiceMetadata(
        state,
        credentialStore.publicSnapshot(),
        service
      ));
      return;
    }
    if (request.method === "PUT") {
      await saveInfrastructureService(request, response, id);
      return;
    }
    if (request.method === "DELETE") {
      await serializeServiceMutation(async () => {
        infrastructureServiceById(id);
        const namespaces = infrastructureServiceCredentialNamespaces(credentialStore.publicSnapshot(), id);
        await stateStore.mutate((next) => { delete next.infrastructureServices[id]; });
        for (const namespace of namespaces) {
          await credentialStore.removeServiceCredentials(namespace).catch(() => {
            // Destination and revision binding makes an orphan unusable after
            // its state record is removed, so cleanup remains best effort.
            log("A removed infrastructure service credential record could not be cleaned up.");
          });
        }
      });
      monitor?.requestRefresh?.();
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function testInfrastructureService(request, response, id = null) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!testInfrastructureServiceConnection) {
      fail(503, "CONNECTION_TEST_UNAVAILABLE", "Infrastructure service testing is temporarily unavailable.");
    }
    const body = await readBoundedJson(request);
    if (id) {
      requireExactKeys(body, []);
      const { state, service } = infrastructureServiceById(id);
      const target = parseInfrastructureServiceUrl(service.url);
      const targetResolution = await resolveAndAuthorizeTarget(target, state.policy, {
        lookup,
        approvedHostCidrs: service.approvedHostCidrs || []
      });
      const result = await useInfrastructureServiceCredentials(id, service, (credentials) => (
        testInfrastructureServiceConnection({
          type: service.type,
          target,
          targetResolution,
          targetRevision: service.targetRevision,
          tlsMode: service.tlsMode,
          certificateFingerprint: service.certificateFingerprint,
          credentials
        })
      ));
      sendJson(response, 200, result);
      return;
    }

    requireExactKeys(body, [
      "type",
      "displayName",
      "url",
      "enabled",
      "monitoringEnabled",
      "tlsMode",
      "certificateFingerprint",
      "credentials"
    ]);
    const type = normalizeInfrastructureServiceType(body.type);
    const target = parseInfrastructureServiceUrl(body.url);
    const tls = normalizeInfrastructureTls(body);
    const credentials = normalizeInfrastructureServiceCredentials(type, body.credentials);
    body.credentials = undefined;
    try {
      const state = stateStore.snapshot();
      const targetResolution = await resolveAndAuthorizeExplicitTarget(target, state.policy, { lookup });
      const result = await testInfrastructureServiceConnection({
        type,
        target,
        targetResolution,
        targetRevision: randomUUID(),
        tlsMode: tls.tlsMode,
        certificateFingerprint: tls.certificateFingerprint,
        credentials
      });
      sendJson(response, 200, result);
    } finally {
      clearInfrastructureCredentials(credentials);
    }
  }

  async function operations(request, response, action) {
    await authenticate(request, request.method !== "GET");
    if (!monitor) fail(503, "MONITOR_STARTING", "The operations monitor is still starting.");
    if (request.method === "GET" && action === "snapshot") {
      sendJson(response, 200, publicOperationsSnapshot(monitor.getSnapshot()));
      return;
    }
    if (request.method === "POST" && action === "refresh") {
      const snapshot = await monitor.refresh();
      sendJson(response, 200, publicOperationsSnapshot(snapshot));
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function mediaArtwork(request, response, token) {
    if (!["GET", "HEAD"].includes(request.method)) {
      fail(405, "METHOD_NOT_ALLOWED", "Media artwork permits read-only requests only.");
    }
    await authenticate(request, false);
    if (!monitor || !fetchMediaArtwork) {
      fail(503, "MEDIA_ARTWORK_UNAVAILABLE", "Media artwork is temporarily unavailable.");
    }
    const snapshot = monitor.getSnapshot();
    const artwork = snapshot?.media?.artwork;
    const descriptor = artwork && typeof artwork === "object" && !Array.isArray(artwork)
      && Object.prototype.hasOwnProperty.call(artwork, token)
      ? artwork[token]
      : null;
    if (!descriptor) fail(404, "MEDIA_ARTWORK_NOT_FOUND", "That media artwork is not available.");
    const requestLifetime = new AbortController();
    const abortWait = () => requestLifetime.abort();
    const abortClosedResponse = () => {
      if (!response.writableEnded) abortWait();
    };
    request.once("aborted", abortWait);
    response.once("close", abortClosedResponse);
    if (request.aborted || (response.destroyed && !response.writableEnded)) abortWait();
    try {
      const result = await fetchMediaArtwork(descriptor, { request, signal: requestLifetime.signal });
      if (requestLifetime.signal.aborted) return;
      const body = Buffer.isBuffer(result?.body) ? result.body : null;
      const contentType = String(result?.contentType || "").split(";", 1)[0].trim().toLowerCase();
      const suppliedEtag = typeof result?.etag === "string" ? result.etag : "";
      const etag = /^"[A-Za-z0-9_-]{20,100}"$/u.test(suppliedEtag)
        ? suppliedEtag
        : body ? `"${createHash("sha256").update(body).digest("base64url")}"` : "";
      if (!body || !body.length || body.length > 4 * 1024 * 1024 || !MEDIA_ARTWORK_TYPE.test(contentType)) {
        fail(404, "MEDIA_ARTWORK_NOT_FOUND", "That media artwork is not available.");
      }
      setApiHeaders(response);
      response.removeHeader("Pragma");
      response.removeHeader("Expires");
      response.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader("Content-Type", contentType);
      response.setHeader("ETag", etag);
      if (request.headers["if-none-match"] === etag) {
        response.statusCode = 304;
        response.end();
        return;
      }
      response.setHeader("Content-Length", String(body.length));
      response.statusCode = 200;
      response.end(request.method === "HEAD" ? undefined : body);
    } finally {
      request.removeListener("aborted", abortWait);
      response.removeListener("close", abortClosedResponse);
    }
  }

  async function handle(request, response, url) {
    try {
      if (url.pathname === "/api/v2/status") {
        await status(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/setup/claim") {
        await claim(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/session") {
        await session(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/session/invite") {
        await createPairingInvite(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/session/pair") {
        await pairSession(request, response);
        return true;
      }
      const sessionMatch = url.pathname.match(/^\/api\/v2\/sessions\/([a-f0-9-]+)$/u);
      if (url.pathname === "/api/v2/sessions" || sessionMatch) {
        await sessions(request, response, sessionMatch?.[1] || null);
        return true;
      }
      if (url.pathname === "/api/v2/config") {
        await configuration(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/infrastructure/services/test") {
        await testInfrastructureService(request, response);
        return true;
      }
      const infrastructureServiceTestMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/services\/([a-f0-9-]+)\/test$/u
      );
      if (infrastructureServiceTestMatch) {
        await testInfrastructureService(request, response, infrastructureServiceTestMatch[1]);
        return true;
      }
      const infrastructureServiceMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/services\/([a-f0-9-]+)$/u
      );
      if (url.pathname === "/api/v2/infrastructure/services" || infrastructureServiceMatch) {
        await infrastructureServicesApi(request, response, infrastructureServiceMatch?.[1] || null);
        return true;
      }
      if (["/api/v2/infrastructure/targets/test", "/api/v2/infrastructure/environments/test"].includes(url.pathname)) {
        await testInfrastructureTarget(request, response);
        return true;
      }
      const infrastructureTargetTestMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/(?:targets|environments)\/([a-f0-9-]+)\/test$/u
      );
      if (infrastructureTargetTestMatch) {
        await testInfrastructureTarget(request, response, infrastructureTargetTestMatch[1]);
        return true;
      }
      const infrastructureEndpointDraftTestMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/environments\/([a-f0-9-]+)\/endpoints\/test$/u
      );
      if (infrastructureEndpointDraftTestMatch) {
        await testInfrastructureEndpoint(request, response, infrastructureEndpointDraftTestMatch[1]);
        return true;
      }
      const infrastructureEndpointTestMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/environments\/([a-f0-9-]+)\/endpoints\/([a-f0-9-]+)\/test$/u
      );
      if (infrastructureEndpointTestMatch) {
        await testInfrastructureEndpoint(
          request,
          response,
          infrastructureEndpointTestMatch[1],
          infrastructureEndpointTestMatch[2]
        );
        return true;
      }
      const infrastructureEndpointMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/environments\/([a-f0-9-]+)\/endpoints(?:\/([a-f0-9-]+))?$/u
      );
      if (infrastructureEndpointMatch) {
        await infrastructureEndpointsApi(
          request,
          response,
          infrastructureEndpointMatch[1],
          infrastructureEndpointMatch[2] || null
        );
        return true;
      }
      const infrastructureTargetMatch = url.pathname.match(
        /^\/api\/v2\/infrastructure\/(?:targets|environments)\/([a-f0-9-]+)$/u
      );
      if (["/api/v2/infrastructure/targets", "/api/v2/infrastructure/environments"].includes(url.pathname)
        || infrastructureTargetMatch) {
        await infrastructureTargets(request, response, infrastructureTargetMatch?.[1] || null);
        return true;
      }
      const serviceMatch = url.pathname.match(/^\/api\/v2\/services\/([a-z0-9-]+)$/u);
      const serviceTestMatch = url.pathname.match(/^\/api\/v2\/services\/([a-z0-9-]+)\/test$/u);
      if (serviceTestMatch) {
        await testConnection(request, response, serviceTestMatch[1]);
        return true;
      }
      if (url.pathname === "/api/v2/services" || serviceMatch) {
        await services(request, response, serviceMatch?.[1] || null);
        return true;
      }
      const operationMatch = url.pathname.match(/^\/api\/v2\/operations\/(snapshot|refresh)$/u);
      if (operationMatch) {
        await operations(request, response, operationMatch[1]);
        return true;
      }
      const artworkMatch = url.pathname.match(/^\/api\/v2\/media\/artwork\/([a-f0-9]+)$/u);
      if (artworkMatch) {
        if (url.search || !MEDIA_ARTWORK_TOKEN.test(artworkMatch[1])) {
          fail(404, "MEDIA_ARTWORK_NOT_FOUND", "That media artwork is not available.");
        }
        await mediaArtwork(request, response, artworkMatch[1]);
        return true;
      }
      return false;
    } catch (error) {
      throw translateStoreError(error);
    }
  }

  return {
    handle,
    credentialStore,
    sessionStore,
    publicConfiguration: () => publicConfiguration(stateStore.snapshot(), credentialStore),
    listMonitorServices: () => SERVICE_IDS
      .map((service) => connectionMetadata(stateStore.snapshot(), credentialStore.publicSnapshot(), service))
      .filter((service) => service.configured && service.monitoringEnabled),
    listMonitorInfrastructureTargets: () => Object.values(stateStore.snapshot().infrastructureTargets || {})
      .filter((target) => target.enabled && target.monitoringEnabled)
      .map((target) => structuredClone(target)),
    listMonitorInfrastructureServices: () => Object.values(stateStore.snapshot().infrastructureServices || {})
      .filter((service) => service.enabled && service.monitoringEnabled)
      .map((service) => structuredClone(service)),
    useServiceCredential,
    useInfrastructureCredentials,
    useInfrastructureServiceCredentials,
    setMonitor(value) { monitor = value; },
    close: async () => credentialStore.close(),
    csrfHeaderName: CSRF_HEADER_NAME
  };
}
