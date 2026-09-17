import { createHash, randomUUID } from "node:crypto";
import { canonicalServiceId, SERVICE_IDS } from "./routes.mjs";
import {
  connectionAuthorizationBoundaryHash,
  normalizePolicy,
  parseServiceUrl,
  resolveAndAuthorizeExplicitTarget,
  resolveAndAuthorizeTarget
} from "./network.mjs";
import { CredentialStore, CredentialStoreError } from "./secrets.mjs";
import {
  claimRequestBinding,
  CSRF_HEADER_NAME,
  jellyfinSessionCredentialBinding,
  requestBinding,
  SessionAuthError,
  SessionAuthStore
} from "./session-auth.mjs";
import { tokenMatches } from "./state.mjs";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const SAFE_SECRET = /^[^\u0000-\u001f\u007f-\u009f]{1,4096}$/u;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 10;
const ACCESS_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_ACCESS_LOGIN_ATTEMPTS_PER_WINDOW = 10;
const MAX_ACCESS_LOGIN_BUCKETS = 256;
const JELLYFIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_JELLYFIN_LOGIN_ATTEMPTS_PER_BUCKET = 10;
const MAX_JELLYFIN_LOGIN_ATTEMPTS_GLOBAL = 100;
const MAX_JELLYFIN_LOGIN_BUCKETS = 512;
const SETUP_SESSION_TTL_MS = 60 * 60 * 1_000;
const JELLYFIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const JELLYFIN_READ_VALIDATION_MS = 12 * 60 * 60 * 1_000;
const JELLYFIN_WRITE_VALIDATION_MS = 2 * 60 * 1_000;
const JELLYFIN_OFFLINE_GRACE_MS = 24 * 60 * 60 * 1_000;
const BROWSER_AUTH_NAMESPACE_PREFIX = "browser-auth-";
const BROWSER_AUTH_BOUNDARY_HASH = /^[a-f0-9]{64}$/u;
const BROWSER_AUTH_STATE_NAMESPACE = "browser-auth-state";
const BROWSER_AUTH_STATE_FIELD = "schema";
const BROWSER_AUTH_STATE_VERSION = "4";
const BACKGROUND_JELLYFIN_REVOCATION_TTL_MS = 6_000;
// Keep enough encrypted-store headroom to stage every destination-bound
// credential during an atomic network-policy migration (seven media
// connectors, 25 Proxmox endpoints, and eight infrastructure services).
const MAX_INFRASTRUCTURE_TARGETS = 25;
const MAX_INFRASTRUCTURE_ENDPOINTS = 25;
const MAX_ENDPOINTS_PER_ENVIRONMENT = 4;
const MAX_INFRASTRUCTURE_SERVICES = 8;
const DEFAULT_INFRASTRUCTURE_MONITOR_INTERVAL_SECONDS = 60;
const ACTION_INVENTORY_MAX_AGE_MS = 2 * 60 * 1000;
const ACTION_COOLDOWN_MS = 30 * 1000;
const MAX_RECENT_ACTIONS = 2_048;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROXMOX_TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MEDIA_ARTWORK_TOKEN = /^[a-f0-9]{16,64}$/u;
const MEDIA_ARTWORK_TYPE = /^image\/(?:avif|gif|jpeg|png|webp)$/u;
const MEDIA_DETAIL_REVISION = /^[a-f0-9]{64}$/u;
const MAX_REQUESTED_SEASONS = 100;

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
    role: "Virtualization inventory and controls",
    credentialFields: Object.freeze(["tokenId", "tokenSecret"]),
    credentials: Object.freeze([
      Object.freeze({
        id: "tokenId",
        label: "API token ID",
        hint: "Use a dedicated token with VM.Audit and VM.PowerMgmt only where Helmsman should control guests."
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
    role: "Container inventory and controls",
    credentialFields: Object.freeze(["accessToken"]),
    credentials: Object.freeze([
      Object.freeze({
        id: "accessToken",
        label: "Access token",
        hint: "Use a dedicated least-privilege user allowed to inspect and start, restart, or stop managed containers."
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
  let raw = null;
  try {
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        chunk.fill(0);
        request.resume();
        fail(413, "REQUEST_TOO_LARGE", "The request body exceeded its safety limit.");
      }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks, total);
    try {
      return requirePlainObject(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      fail(400, "INVALID_JSON", "The request body is not valid JSON.");
    }
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
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

function browserAuthNamespace(sessionId) {
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) {
    fail(500, "SESSION_INVALID", "The browser session identity is invalid.");
  }
  return `${BROWSER_AUTH_NAMESPACE_PREFIX}${sessionId}`;
}

function browserAuthField(credentialBinding) {
  if (typeof credentialBinding !== "string"
    || !BROWSER_AUTH_BOUNDARY_HASH.test(credentialBinding)) {
    fail(500, "SESSION_INVALID", "The browser session authorization boundary is invalid.");
  }
  return `token_${credentialBinding.slice(0, 56)}`;
}

function publicAuthentication(sessionStore, options = {}) {
  const owner = sessionStore.owner();
  return {
    provider: owner ? "jellyfin" : null,
    configured: Boolean(owner),
    ownerName: owner && options.includeOwnerName === true ? owner.username : null,
    legacyAccessKeyAvailable: !owner && sessionStore.accessKeyConfigured()
  };
}

function validJellyfinIdentity(identity) {
  const safeText = (value, maximum) => typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
  return Boolean(identity
    && typeof identity === "object"
    && !Array.isArray(identity)
    && safeText(identity.serverId, 256)
    && safeText(identity.userId, 256)
    && safeText(identity.username, 320)
    && identity.isAdministrator === true
    && identity.isDisabled === false);
}

function sameJellyfinIdentity(left, right) {
  return Boolean(left
    && right
    && left.provider === "jellyfin"
    && left.serverId === right.serverId
    && left.userId === right.userId);
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
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
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

function policyBoundCredentialNamespaceV2(service, connection, policy) {
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

function credentialNamespace(service, connection, policy) {
  if (!connection?.url || !policy || typeof connection.targetRevision !== "string") return null;
  const binding = JSON.stringify({
    url: connection.url,
    targetRevision: connection.targetRevision,
    authMode: connection.authMode || SERVICE_DEFINITIONS[service]?.authMode || "",
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(connection.approvedHostCidrs || [])].sort()
  });
  const targetDigest = createHash("sha256")
    .update(binding, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-b3-${targetDigest}`;
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
  const authenticateJellyfinBrowser = typeof options.authenticateJellyfinBrowser === "function"
    ? options.authenticateJellyfinBrowser
    : null;
  const validateJellyfinBrowserToken = typeof options.validateJellyfinBrowserToken === "function"
    ? options.validateJellyfinBrowserToken
    : null;
  const revokeJellyfinBrowserToken = typeof options.revokeJellyfinBrowserToken === "function"
    ? options.revokeJellyfinBrowserToken
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
  const executePortainerContainerAction = typeof options.executePortainerContainerAction === "function"
    ? options.executePortainerContainerAction
    : null;
  const executeProxmoxWorkloadAction = typeof options.executeProxmoxWorkloadAction === "function"
    ? options.executeProxmoxWorkloadAction
    : null;
  const executeMediaRecoveryAction = typeof options.executeMediaRecoveryAction === "function"
    ? options.executeMediaRecoveryAction
    : null;
  const fetchSeerrSeriesSeasons = typeof options.fetchSeerrSeriesSeasons === "function"
    ? options.fetchSeerrSeriesSeasons
    : null;
  const credentialStore = options.credentialStore || new CredentialStore(dataDir, {
    instanceId: stateStore.snapshot().instanceId,
    keyFilePath: options.keyFilePath,
    guard: options.stateGuard
  });
  await credentialStore.initialize();
  const sessionStateMarkerPresent = credentialStore.hasCredential(
    BROWSER_AUTH_STATE_NAMESPACE,
    BROWSER_AUTH_STATE_FIELD
  );
  if (sessionStateMarkerPresent) {
    const markerValid = await credentialStore.useCredential(
      BROWSER_AUTH_STATE_NAMESPACE,
      BROWSER_AUTH_STATE_FIELD,
      (value) => value.equals(Buffer.from(BROWSER_AUTH_STATE_VERSION, "utf8"))
    );
    if (!markerValid) {
      throw new Error("The browser authorization-state version is not supported.");
    }
  }
  const allowLegacySessionMigration = !sessionStateMarkerPresent
    && !credentialStore.createdDuringInitialization();
  // Commit the anti-downgrade marker before converting legacy session state.
  // A crash can therefore make an operator reset access, but can never reopen
  // the one-time beta migration on a later process.
  if (!sessionStateMarkerPresent) {
    await credentialStore.setCredential(
      BROWSER_AUTH_STATE_NAMESPACE,
      BROWSER_AUTH_STATE_FIELD,
      BROWSER_AUTH_STATE_VERSION
    );
  }
  const sessionStore = options.sessionStore || new SessionAuthStore(dataDir, {
    guard: options.stateGuard,
    stateIntegrityTag: (payload) => credentialStore.sessionStateIntegrityTag(payload),
    allowLegacyMigration: allowLegacySessionMigration
  });
  await sessionStore.initialize();
  const stagedBrowserNamespaces = new Set();
  const browserRevocationQueue = [];
  let activeBrowserRevocation = null;
  let browserRevocationClosing = false;

  // Older records bound ciphertext only to the canonical URL. Upgrade them once
  // so current records also bind authentication mode and the complete outbound
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
      const boundNamespace = credentialNamespace(service, connection, state.policy);
      // Prefer the newer policy-bound record when both migration sources
      // survive. A stale URL-only record must never replace a credential that
      // was subsequently updated under the v2 boundary.
      const sourceNamespaces = [
        policyBoundCredentialNamespaceV2(service, connection, state.policy),
        legacyCredentialNamespace(service, connection)
      ].filter((namespace, index, values) => namespace && namespace !== boundNamespace && values.indexOf(namespace) === index);
      let boundConfigured = Boolean(metadata.credentials?.[boundNamespace]?.[field]?.configured);
      for (const sourceNamespace of sourceNamespaces) {
        const sourceConfigured = Boolean(metadata.credentials?.[sourceNamespace]?.[field]?.configured);
        if (sourceConfigured && !boundConfigured) {
          await credentialStore.useCredential(sourceNamespace, field, (credential) => (
            credentialStore.replaceServiceCredentials(boundNamespace, { [field]: credential })
          ));
          boundConfigured = true;
          migrated = true;
        }
        if (!sourceConfigured) continue;
        await credentialStore.removeServiceCredentials(sourceNamespace);
        migrated = true;
      }
    }
    if (migrated) log("Credential destination bindings upgraded.");
  }

  async function cleanupOrphanServiceCredentials() {
    const state = stateStore.snapshot();
    const metadata = credentialStore.publicSnapshot();
    for (const service of SERVICE_IDS) {
      const activeNamespace = credentialNamespace(service, state.connections[service], state.policy);
      for (const namespace of credentialNamespacesForService(metadata, service)) {
        if (namespace === activeNamespace) continue;
        await credentialStore.removeServiceCredentials(namespace).catch(() => {
          log("An orphaned encrypted service credential could not be removed.");
        });
      }
    }
  }

  await migrateLegacyCredentialBindings();
  await cleanupOrphanServiceCredentials();
  await drainPrunedBrowserSessions();
  await cleanupTokenlessBrowserSessions();
  await cleanupInvalidBrowserSessions();
  await cleanupOrphanBrowserCredentials();

  let monitor = options.monitor || null;
  const loginAttempts = new Map();
  const accessLoginAttempts = new Map();
  const jellyfinLoginAttempts = new Map();
  let serviceMutationChain = Promise.resolve();
  let claimMutationChain = Promise.resolve();
  const activeActions = new Set();
  const recentActions = new Map();

  async function serializeServiceMutation(operation) {
    const pending = serviceMutationChain.catch(() => {}).then(operation);
    serviceMutationChain = pending.then(() => {}, () => {});
    return pending;
  }

  async function serializeClaimMutation(operation) {
    const pending = claimMutationChain.catch(() => {}).then(operation);
    claimMutationChain = pending.then(() => {}, () => {});
    return pending;
  }

  function consumeLoginAttempt(service, now = Date.now()) {
    // Deliberately scope this to the service, not the browser session. A new
    // browser login or renewed session must not reset the upstream password-guessing
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

  function accessLoginBucket(request) {
    const remoteAddress = typeof request?.socket?.remoteAddress === "string"
      ? request.socket.remoteAddress.slice(0, 128)
      : "unknown";
    return remoteAddress || "unknown";
  }

  function pruneAccessLoginAttempts(now = Date.now()) {
    for (const [bucket, attempt] of accessLoginAttempts) {
      if (attempt.startedAt + ACCESS_LOGIN_WINDOW_MS <= now) accessLoginAttempts.delete(bucket);
    }
  }

  function consumeAccessLoginAttempt(request, now = Date.now()) {
    pruneAccessLoginAttempts(now);
    const bucket = accessLoginBucket(request);
    const current = accessLoginAttempts.get(bucket);
    if (!current) {
      while (accessLoginAttempts.size >= MAX_ACCESS_LOGIN_BUCKETS) {
        accessLoginAttempts.delete(accessLoginAttempts.keys().next().value);
      }
      accessLoginAttempts.set(bucket, { startedAt: now, attempts: 1 });
      return bucket;
    }
    if (current.attempts >= MAX_ACCESS_LOGIN_ATTEMPTS_PER_WINDOW) {
      fail(429, "ACCESS_LOGIN_RATE_LIMITED", "Too many access-key attempts. Wait a few minutes and try again.");
    }
    current.attempts += 1;
    return bucket;
  }

  function jellyfinLoginBucketKeys(request, username) {
    const remoteAddress = typeof request?.socket?.remoteAddress === "string"
      ? request.socket.remoteAddress.slice(0, 128)
      : "unknown";
    const normalizedUsername = Buffer.isBuffer(username)
      ? username.toString("utf8").toLowerCase()
      : "invalid";
    const usernameDigest = createHash("sha256").update(normalizedUsername, "utf8").digest("hex");
    return [`ip:${remoteAddress || "unknown"}`, `user:${usernameDigest}`];
  }

  function pruneJellyfinLoginAttempts(now = Date.now()) {
    for (const [bucket, attempt] of jellyfinLoginAttempts) {
      if (attempt.startedAt + JELLYFIN_LOGIN_WINDOW_MS <= now) jellyfinLoginAttempts.delete(bucket);
    }
  }

  function consumeJellyfinLoginAttempt(request, username, now = Date.now()) {
    pruneJellyfinLoginAttempts(now);
    const bucketKeys = jellyfinLoginBucketKeys(request, username);
    const limits = new Map([
      ["global", MAX_JELLYFIN_LOGIN_ATTEMPTS_GLOBAL],
      ...bucketKeys.map((bucket) => [bucket, MAX_JELLYFIN_LOGIN_ATTEMPTS_PER_BUCKET])
    ]);
    for (const [bucket, limit] of limits) {
      const current = jellyfinLoginAttempts.get(bucket);
      if (current && current.attempts >= limit) {
        fail(429, "JELLYFIN_LOGIN_RATE_LIMITED", "Too many sign-in attempts. Wait a few minutes and try again.");
      }
    }
    for (const [bucket] of limits) {
      const current = jellyfinLoginAttempts.get(bucket);
      if (current) current.attempts += 1;
      else jellyfinLoginAttempts.set(bucket, { startedAt: now, attempts: 1 });
    }
    while (jellyfinLoginAttempts.size > MAX_JELLYFIN_LOGIN_BUCKETS + 1) {
      const evicted = [...jellyfinLoginAttempts.keys()].find((bucket) => bucket !== "global");
      if (!evicted) break;
      jellyfinLoginAttempts.delete(evicted);
    }
    return bucketKeys;
  }

  function clearJellyfinLoginBuckets(bucketKeys) {
    for (const bucket of bucketKeys || []) jellyfinLoginAttempts.delete(bucket);
  }

  async function connectionsForPolicy(state, policy) {
    const exactMode = policy.allowedCidrs.length === 0;
    const policyChanged = state.policy.allowPublicHttps !== policy.allowPublicHttps
      || !sameStrings(state.policy.allowedCidrs, policy.allowedCidrs);
    const entries = await Promise.all(Object.entries(state.connections).map(async ([service, connection]) => {
      try {
        let approvedHostCidrs;
        if (!exactMode) {
          await resolveAndAuthorizeTarget(connection.url, policy, { lookup, approvedHostCidrs: [] });
          approvedHostCidrs = [];
        } else {
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
          approvedHostCidrs = candidate.approvedHostCidrs;
        }
        const approvalChanged = !sameStrings(connection.approvedHostCidrs || [], approvedHostCidrs);
        const changed = policyChanged || approvalChanged;
        return [service, {
          ...connection,
          approvedHostCidrs,
          // A service revision identifies the complete outbound authorization
          // boundary, not just its URL. Rotating it prevents a request that
          // resolved under an older policy from acquiring a credential after
          // a policy transition and dispatching to its stale pinned address.
          targetRevision: changed ? randomUUID() : connection.targetRevision,
          updatedAt: changed ? new Date().toISOString() : connection.updatedAt
        }];
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

  function isBrowserAuthNamespace(value) {
    return typeof value === "string"
      && value.startsWith(BROWSER_AUTH_NAMESPACE_PREFIX)
      && UUID.test(value.slice(BROWSER_AUTH_NAMESPACE_PREFIX.length));
  }

  async function cleanupTokenlessBrowserSessions() {
    let revoked = 0;
    for (const record of sessionStore.internalSessions()) {
      if (record.principal?.provider !== "jellyfin") continue;
      if (credentialStore.hasCredential(
        browserAuthNamespace(record.id),
        browserAuthField(jellyfinSessionCredentialBinding(record))
      )) continue;
      if (await sessionStore.revoke(record.id)) revoked += 1;
    }
    if (revoked > 0) {
      log("Browser sessions without encrypted Jellyfin tokens were revoked during startup reconciliation.");
    }
  }

  async function cleanupInvalidBrowserSessions() {
    const state = stateStore.snapshot();
    const connection = state.connections.jellyfin;
    let currentBoundaryHash = null;
    try {
      currentBoundaryHash = connection
        ? connectionAuthorizationBoundaryHash(connection, state.policy)
        : null;
    } catch {
      currentBoundaryHash = null;
    }
    let revoked = 0;
    for (const record of sessionStore.internalSessions()) {
      if (record.principal?.provider !== "jellyfin") continue;
      const verifiedAt = Date.parse(record.principal.verifiedAt);
      const invalid = !connection
        || connection.url !== record.principal.jellyfinUrl
        || connection.targetRevision !== record.principal.targetRevision
        || currentBoundaryHash !== record.principal.boundaryHash
        || !Number.isFinite(verifiedAt)
        || verifiedAt > Date.now();
      if (!invalid) continue;
      if (await revokeBrowserSession(record.id, { notify: false })) revoked += 1;
    }
    if (revoked > 0) {
      log("Browser sessions outside the current Jellyfin authorization boundary were revoked during startup reconciliation.");
    }
  }

  async function cleanupOrphanBrowserCredentials() {
    const namespaces = Object.keys(credentialStore.publicSnapshot().credentials || {})
      .filter((namespace) => isBrowserAuthNamespace(namespace));
    for (const namespace of namespaces) {
      const sessionId = namespace.slice(BROWSER_AUTH_NAMESPACE_PREFIX.length);
      const active = () => Boolean(sessionStore.getInternalSession(sessionId));
      if (stagedBrowserNamespaces.has(namespace) || active()) continue;
      if (stagedBrowserNamespaces.has(namespace) || active()) {
        continue;
      }
      try {
        await credentialStore.removeServiceCredentials(namespace);
      } catch {
        log("An orphaned encrypted browser credential could not be removed.");
      }
    }
  }

  function queueBrowserRevocation(token, deviceId, boundaryHash) {
    if (!Buffer.isBuffer(token)) return;
    if (browserRevocationClosing || !revokeJellyfinBrowserToken) {
      token.fill(0);
      return;
    }
    browserRevocationQueue.push({
      token,
      deviceId,
      boundaryHash,
      expiresAt: Date.now() + BACKGROUND_JELLYFIN_REVOCATION_TTL_MS
    });
    pumpBrowserRevocations();
  }

  function pumpBrowserRevocations() {
    if (browserRevocationClosing || activeBrowserRevocation) return;
    const now = Date.now();
    while (browserRevocationQueue.length && browserRevocationQueue[0].expiresAt <= now) {
      browserRevocationQueue.shift().token.fill(0);
    }
    const job = browserRevocationQueue.shift();
    if (!job) return;
    activeBrowserRevocation = Promise.resolve()
      .then(() => revokeJellyfinBrowserToken({
        token: job.token,
        deviceId: job.deviceId,
        boundaryHash: job.boundaryHash
      }))
      .catch(() => {
        log("Jellyfin did not confirm a background browser-token revocation; the local token was still removed.");
      })
      .finally(() => {
        job.token.fill(0);
        activeBrowserRevocation = null;
        pumpBrowserRevocations();
      });
  }

  async function closeBrowserRevocations() {
    browserRevocationClosing = true;
    for (const job of browserRevocationQueue.splice(0)) job.token.fill(0);
    await activeBrowserRevocation?.catch(() => {});
  }

  async function drainPrunedBrowserSessions() {
    for (const record of sessionStore.takePrunedSessions()) {
      await discardBrowserCredential(record, { background: true });
    }
  }

  async function cleanupExpiredBrowserSessions() {
    await sessionStore.pruneExpired();
    await drainPrunedBrowserSessions();
  }

  async function discardBrowserCredential(record, options = {}) {
    if (!record?.principal || record.principal.provider !== "jellyfin") return;
    const namespace = browserAuthNamespace(record.id);
    const field = browserAuthField(jellyfinSessionCredentialBinding(record));
    const configured = credentialStore.hasCredential(namespace, field);
    let token = null;
    if (configured) {
      try {
        await credentialStore.useCredential(namespace, field, (cleartext) => {
          token = Buffer.from(cleartext);
        });
      } catch {
        log("An encrypted browser token could not be opened and will be removed.");
      }
    }
    try {
      await credentialStore.removeServiceCredentials(namespace);
    } catch {
      log("An obsolete encrypted browser credential could not be cleaned up.");
    }
    if (!token) return;
    const currentState = stateStore.snapshot();
    const currentConnection = currentState.connections.jellyfin;
    let boundaryCurrent = false;
    try {
      boundaryCurrent = Boolean(currentConnection
        && connectionAuthorizationBoundaryHash(currentConnection, currentState.policy)
          === record.principal.boundaryHash);
    } catch {
      boundaryCurrent = false;
    }
    if (options.notify === false || !revokeJellyfinBrowserToken || !boundaryCurrent) {
      token.fill(0);
      return;
    }
    if (options.background === true) {
      queueBrowserRevocation(token, record.principal.deviceId, record.principal.boundaryHash);
      return;
    }
    try {
      await revokeJellyfinBrowserToken({
        token,
        deviceId: record.principal.deviceId,
        boundaryHash: record.principal.boundaryHash
      });
    } catch {
      log("Jellyfin did not confirm browser-token revocation; the local session was still removed.");
    } finally {
      token.fill(0);
    }
  }

  async function revokeBrowserSession(sessionId, options = {}) {
    const record = sessionStore.getInternalSession(sessionId);
    const removed = await sessionStore.revoke(sessionId);
    if (removed && record) await discardBrowserCredential(record, options);
    return removed;
  }

  async function revokeAllBrowserSessionsLocally(boundaryChange = null) {
    const records = sessionStore.internalSessions()
      .filter((record) => record.principal?.provider === "jellyfin");
    const removed = boundaryChange
      ? await sessionStore.rebindOwnerAndRevokeAll(
        boundaryChange.expected,
        boundaryChange.replacement
      )
      : await sessionStore.revokeAll();
    for (const record of records) {
      await discardBrowserCredential(record, { notify: false });
    }
    return removed;
  }

  async function recheckMutationSession(request, expected) {
    let current;
    try {
      current = await sessionStore.authenticateRequest(request, { requireCsrf: true });
    } catch (error) {
      throw translateStoreError(error);
    }
    if (!expected?.session?.id || current.session.id !== expected.session.id) {
      fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
    }
    return current;
  }

  async function revokeRejectedJellyfinSession(record) {
    await revokeBrowserSession(record.id).catch(() => {});
    fail(401, "JELLYFIN_AUTH_REJECTED", "Sign in again with the Helmsman owner account.");
  }

  async function revokeBoundaryChangedJellyfinSession(record) {
    await revokeBrowserSession(record.id, { notify: false }).catch(() => {});
    fail(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin connection changed. Sign in again.");
  }

  async function validateJellyfinSession(authenticated, requireFresh) {
    const record = sessionStore.getInternalSession(authenticated.session.id);
    if (!record) fail(401, "SESSION_INVALID", "The browser session is invalid or revoked.");
    if (!record.principal) return authenticated;

    const owner = sessionStore.owner();
    const state = stateStore.snapshot();
    const connection = state.connections.jellyfin;
    if (!sameJellyfinIdentity(owner, record.principal)) {
      await revokeRejectedJellyfinSession(record);
    }
    let currentBoundaryHash = null;
    try {
      currentBoundaryHash = connection
        ? connectionAuthorizationBoundaryHash(connection, state.policy)
        : null;
    } catch {
      currentBoundaryHash = null;
    }
    if (!connection
      || connection.url !== record.principal.jellyfinUrl
      || connection.targetRevision !== record.principal.targetRevision
      || currentBoundaryHash !== record.principal.boundaryHash) {
      await revokeBoundaryChangedJellyfinSession(record);
    }

    const verifiedAt = Date.parse(record.principal.verifiedAt);
    const validationTime = Date.now();
    if (!Number.isFinite(verifiedAt) || verifiedAt > validationTime) {
      await revokeBrowserSession(record.id, { notify: false }).catch(() => {});
      fail(401, "JELLYFIN_AUTH_REJECTED", "Sign in again with the Helmsman owner account.");
    }
    const verificationAge = validationTime - verifiedAt;
    const validationInterval = requireFresh
      ? JELLYFIN_WRITE_VALIDATION_MS
      : JELLYFIN_READ_VALIDATION_MS;
    if (verificationAge <= validationInterval) return authenticated;
    if (!validateJellyfinBrowserToken) {
      fail(503, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin sign-in validation is temporarily unavailable.");
    }

    let validated;
    try {
      validated = await credentialStore.useCredential(
        browserAuthNamespace(record.id),
        browserAuthField(jellyfinSessionCredentialBinding(record)),
        (token) => validateJellyfinBrowserToken({
          token,
          deviceId: record.principal.deviceId,
          boundaryHash: record.principal.boundaryHash
        })
      );
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === "CREDENTIAL_NOT_CONFIGURED") {
        await revokeRejectedJellyfinSession(record);
      }
      if (error?.status === 401 && error?.code === "JELLYFIN_AUTH_REJECTED") {
        await revokeRejectedJellyfinSession(record);
      }
      const failedState = stateStore.snapshot();
      const failedConnection = failedState.connections.jellyfin;
      let failedBoundaryHash = null;
      try {
        failedBoundaryHash = failedConnection
          ? connectionAuthorizationBoundaryHash(failedConnection, failedState.policy)
          : null;
      } catch {
        failedBoundaryHash = null;
      }
      if (failedBoundaryHash !== record.principal.boundaryHash) {
        await revokeBoundaryChangedJellyfinSession(record);
      }
      if (!requireFresh && verificationAge <= JELLYFIN_OFFLINE_GRACE_MS) return authenticated;
      fail(503, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin could not validate this session. Try again when Jellyfin is available.");
    }

    const latestState = stateStore.snapshot();
    const latestConnection = latestState.connections.jellyfin;
    let latestBoundaryHash = null;
    try {
      latestBoundaryHash = latestConnection
        ? connectionAuthorizationBoundaryHash(latestConnection, latestState.policy)
        : null;
    } catch {
      latestBoundaryHash = null;
    }
    if (!latestConnection
      || latestBoundaryHash !== record.principal.boundaryHash
      || validated?.jellyfinUrl !== record.principal.jellyfinUrl
      || validated?.targetRevision !== record.principal.targetRevision
      || validated?.boundaryHash !== record.principal.boundaryHash
      || !validJellyfinIdentity(validated?.identity)
      || !sameJellyfinIdentity(owner, { provider: "jellyfin", ...validated.identity })) {
      if (latestBoundaryHash !== record.principal.boundaryHash) {
        await revokeBoundaryChangedJellyfinSession(record);
      }
      await revokeRejectedJellyfinSession(record);
    }
    let refreshed;
    try {
      refreshed = await sessionStore.markVerified(record.id, {
        provider: "jellyfin",
        serverId: validated.identity.serverId,
        userId: validated.identity.userId,
        username: validated.identity.username
      });
    } catch (error) {
      throw translateStoreError(error);
    }
    return { session: refreshed.session, csrfToken: authenticated.csrfToken };
  }

  async function authenticate(request, requireCsrf = false) {
    await cleanupExpiredBrowserSessions();
    let authenticated;
    try {
      authenticated = await sessionStore.authenticateRequest(request, { requireCsrf });
    } catch (error) {
      if (error instanceof SessionAuthError && error.code === "SESSION_EXPIRED") {
        await drainPrunedBrowserSessions();
        await serializeServiceMutation(() => cleanupOrphanBrowserCredentials()).catch(() => {});
      }
      throw translateStoreError(error);
    }
    return validateJellyfinSession(authenticated, requireCsrf);
  }

  async function useServiceCredential(serviceValue, expectedConnection, consumer) {
    const service = canonicalServiceId(serviceValue);
    if (!service) fail(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    const definition = SERVICE_DEFINITIONS[service];
    // Read the connection and policy as one immutable state snapshot. Taking
    // them from separate snapshots can splice an old target revision together
    // with a newly committed policy during an authorization-boundary change.
    const state = stateStore.snapshot();
    const connection = state.connections[service];
    if (!connection) fail(409, "SERVICE_NOT_CONFIGURED", "That service is not configured.");
    let expectedBoundary;
    let currentBoundary;
    try {
      expectedBoundary = expectedConnection
        ? connectionAuthorizationBoundaryHash(expectedConnection, state.policy)
        : null;
      currentBoundary = connectionAuthorizationBoundaryHash(connection, state.policy);
    } catch {
      fail(409, "TARGET_CHANGED", "The service target changed while this check was starting.");
    }
    if (!expectedConnection
      || expectedConnection.url !== connection.url
      || expectedConnection.targetRevision !== connection.targetRevision
      || expectedBoundary !== currentBoundary) {
      fail(409, "TARGET_CHANGED", "The service target changed while this check was starting.");
    }
    if (typeof consumer !== "function") fail(500, "INVALID_CREDENTIAL_CONSUMER", "The credential consumer is unavailable.");
    const namespace = credentialNamespace(service, connection, state.policy);
    try {
      return await credentialStore.useCredential(namespace, credentialField(definition, connection), (credential) => {
        // Credential decryption is deliberately followed by one last
        // synchronous boundary check before the consumer can initiate I/O.
        // This also closes a transition that commits while the credential
        // store is selecting or decrypting the bound record.
        const latestState = stateStore.snapshot();
        const latestConnection = latestState.connections[service];
        let latestBoundary = null;
        try {
          latestBoundary = latestConnection
            ? connectionAuthorizationBoundaryHash(latestConnection, latestState.policy)
            : null;
        } catch {
          latestBoundary = null;
        }
        if (!latestConnection
          || latestConnection.url !== connection.url
          || latestConnection.targetRevision !== connection.targetRevision
          || latestBoundary !== currentBoundary) {
          fail(409, "TARGET_CHANGED", "The service target changed before this request could be sent.");
        }
        return consumer(credential);
      });
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
      authenticated = await authenticate(request, false);
    } catch (error) {
      if (error?.status !== 401) throw error;
    }
    sendJson(response, 200, {
      version,
      instanceId: state.instanceId,
      setupRequired: !state.claimed,
      authentication: publicAuthentication(sessionStore, { includeOwnerName: Boolean(authenticated) }),
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
      issued = await serializeClaimMutation(async () => {
        const current = stateStore.snapshot();
        if (current.claimed || !tokenMatches(current.setupTokenHash, body.setupToken)) {
          fail(409, "SETUP_TOKEN_USED", "The one-time setup token has already been used.");
        }
        // An abrupt stop after sessions.json was committed but before
        // state.json was claimed can leave orphaned access state. The broker
        // claim state is authoritative, so a valid setup-token holder may
        // safely reconcile that interrupted attempt before retrying.
        if (sessionStore.accessKeyConfigured() || sessionStore.ownerConfigured() || sessionStore.list().length) {
          await sessionStore.clearAuthentication();
          await cleanupOrphanBrowserCredentials();
        }
        const provisional = await sessionStore.issue({
          name,
          origin: body.origin,
          host: binding.host,
          ttlMs: SETUP_SESSION_TTL_MS
        });
        try {
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
          return provisional;
        } catch (error) {
          await sessionStore.clearAuthentication().catch(() => {});
          throw error;
        }
      });
    } catch (error) {
      throw translateStoreError(error);
    }
    response.setHeader("Set-Cookie", issued.cookie);
    log("First-time setup completed; enroll the Jellyfin owner account to finish browser authentication.");
    sendJson(response, 201, {
      session: issued.session,
      csrfToken: issued.csrfToken,
      authentication: publicAuthentication(sessionStore),
      config: publicConfiguration(stateStore.snapshot(), credentialStore)
    });
  }

  async function issueJellyfinBrowserSession(request, body, options = {}) {
    await cleanupExpiredBrowserSessions();
    const name = safeDeviceName(options.deviceName);
    const login = normalizeLogin("jellyfin", body);
    const initialState = stateStore.snapshot();
    const connection = initialState.connections.jellyfin;
    const boundaryHash = connection
      ? connectionAuthorizationBoundaryHash(connection, initialState.policy)
      : null;
    if (!connection) {
      clearLogin(login);
      fail(409, "JELLYFIN_CONNECTION_REQUIRED", "Configure the Jellyfin media connection before enrolling browser sign-in.");
    }
    if (options.enroll !== true && !sessionStore.ownerBoundaryMatches({
      jellyfinUrl: connection.url,
      targetRevision: connection.targetRevision,
      boundaryHash
    })) {
      clearLogin(login);
      fail(401, "JELLYFIN_AUTH_REJECTED", "Jellyfin did not accept the Helmsman owner credentials.");
    }
    if (!authenticateJellyfinBrowser) {
      clearLogin(login);
      fail(503, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin sign-in is temporarily unavailable.");
    }

    let bucketKeys = null;
    // Reusing the opaque session UUID as Jellyfin's device ID lets startup
    // recover the device identity from an orphaned credential namespace after
    // a crash between durable session deletion and token cleanup.
    const sessionId = randomUUID();
    const deviceId = sessionId;
    let authenticated = null;
    let stagedNamespace = null;
    let committed = false;
    try {
      bucketKeys = consumeJellyfinLoginAttempt(request, login.username);
      authenticated = await authenticateJellyfinBrowser({
        username: login.username,
        password: login.password,
        deviceId
      });
      const identity = authenticated?.identity;
      if (!Buffer.isBuffer(authenticated?.token)
        || authenticated.token.length < 1
        || authenticated.token.length > 16 * 1024
        || authenticated.deviceId !== deviceId
        || authenticated.jellyfinUrl !== connection.url
        || authenticated.targetRevision !== connection.targetRevision
        || authenticated.boundaryHash !== boundaryHash
        || typeof authenticated.revokeAtBoundary !== "function"
        || !validJellyfinIdentity(identity)) {
        fail(502, "JELLYFIN_AUTH_FAILED", "Jellyfin did not return a usable owner session.");
      }
      const boundIdentity = {
        provider: "jellyfin",
        serverId: identity.serverId,
        userId: identity.userId,
        username: identity.username,
        jellyfinUrl: authenticated.jellyfinUrl,
        targetRevision: authenticated.targetRevision,
        boundaryHash
      };
      if (options.enroll !== true && !sessionStore.ownerMatches(boundIdentity)) {
        fail(401, "JELLYFIN_AUTH_REJECTED", "Jellyfin did not accept the Helmsman owner credentials.");
      }

      let issued;
      await serializeServiceMutation(async () => {
        if (options.enroll === true) {
          await recheckMutationSession(request, options.expectedAuthentication);
        }
        const current = stateStore.snapshot();
        const currentConnection = current.connections.jellyfin;
        if (!currentConnection
          || currentConnection.url !== connection.url
          || currentConnection.targetRevision !== connection.targetRevision
          || connectionAuthorizationBoundaryHash(currentConnection, current.policy) !== boundaryHash) {
          fail(503, "JELLYFIN_AUTH_UNAVAILABLE", "The Jellyfin connection changed; try again.");
        }
        const sessionOptions = {
          sessionId,
          name,
          origin: options.origin,
          host: options.host,
          ttlMs: JELLYFIN_SESSION_TTL_MS,
          principal: {
            ...boundIdentity,
            deviceId,
            jellyfinUrl: authenticated.jellyfinUrl,
            targetRevision: authenticated.targetRevision,
            boundaryHash
          }
        };
        const preparedSession = sessionStore.prepareOwnerSession(sessionOptions);
        stagedNamespace = browserAuthNamespace(sessionId);
        stagedBrowserNamespaces.add(stagedNamespace);
        await credentialStore.replaceServiceCredentials(stagedNamespace, {
          [browserAuthField(preparedSession.credentialBinding)]: authenticated.token
        });
        try {
          issued = options.enroll === true
            ? await sessionStore.enrollOwnerAndIssue({ preparedSession, owner: boundIdentity })
            : await sessionStore.loginOwner({ preparedSession });
        } catch (error) {
          throw translateStoreError(error);
        }
        committed = true;
      });
      await drainPrunedBrowserSessions().catch(() => {
        log("An obsolete browser credential could not be cleaned up after session issuance.");
      });
      clearJellyfinLoginBuckets(bucketKeys);
      return issued;
    } finally {
      clearLogin(login);
      if (!committed && authenticated?.token) {
        if (typeof authenticated.revokeAtBoundary === "function") {
          await authenticated.revokeAtBoundary(authenticated.token).catch(() => {});
        }
        if (stagedNamespace) await credentialStore.removeServiceCredentials(stagedNamespace).catch(() => {});
      }
      if (stagedNamespace) stagedBrowserNamespaces.delete(stagedNamespace);
      authenticated?.token?.fill?.(0);
    }
  }

  async function enrollJellyfinOwner(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    if (!stateStore.snapshot().claimed) {
      request.resume();
      fail(409, "SETUP_REQUIRED", "Complete first-time setup before enrolling the Jellyfin owner.");
    }
    if (sessionStore.ownerConfigured()) {
      request.resume();
      fail(409, "OWNER_ALREADY_CONFIGURED", "The Jellyfin owner account is already configured.");
    }
    const authenticated = await authenticate(request, true);
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["username", "password", "deviceName", "origin"]);
    let binding;
    try {
      binding = claimRequestBinding(request, body.origin);
    } catch (error) {
      throw translateStoreError(error);
    }
    const loginBody = { username: body.username, password: body.password };
    body.username = undefined;
    body.password = undefined;
    const issued = await issueJellyfinBrowserSession(request, loginBody, {
      enroll: true,
      deviceName: body.deviceName,
      origin: body.origin,
      host: binding.host,
      expectedAuthentication: authenticated
    });
    response.setHeader("Set-Cookie", issued.cookie);
    log("Jellyfin owner authentication was enrolled; legacy browser access was removed.");
    sendJson(response, 201, {
      session: issued.session,
      csrfToken: issued.csrfToken,
      authentication: publicAuthentication(sessionStore, { includeOwnerName: true })
    });
  }

  async function jellyfinLogin(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    if (!stateStore.snapshot().claimed) {
      request.resume();
      fail(409, "SETUP_REQUIRED", "Complete first-time setup before signing in.");
    }
    if (!sessionStore.ownerConfigured()) {
      request.resume();
      fail(409, "OWNER_NOT_CONFIGURED", "Enroll the Jellyfin owner account before signing in.");
    }
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["username", "password", "deviceName", "origin"]);
    let binding;
    try {
      binding = claimRequestBinding(request, body.origin);
    } catch (error) {
      throw translateStoreError(error);
    }
    const loginBody = { username: body.username, password: body.password };
    body.username = undefined;
    body.password = undefined;
    const issued = await issueJellyfinBrowserSession(request, loginBody, {
      deviceName: body.deviceName,
      origin: body.origin,
      host: binding.host
    });
    response.setHeader("Set-Cookie", issued.cookie);
    sendJson(response, 201, {
      session: issued.session,
      csrfToken: issued.csrfToken,
      authentication: publicAuthentication(sessionStore, { includeOwnerName: true })
    });
  }

  async function session(request, response) {
    if (request.method === "GET") {
      const authenticated = await authenticate(request, false);
      sendJson(response, 200, authenticated);
      return;
    }
    if (request.method === "DELETE") {
      let authenticated;
      try {
        authenticated = await sessionStore.authenticateRequest(request, { requireCsrf: true });
      } catch (error) {
        throw translateStoreError(error);
      }
      await revokeBrowserSession(authenticated.session.id);
      response.setHeader("Set-Cookie", sessionStore.expiredCookie(authenticated.session.origin));
      noContent(response);
      return;
    }
    fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function accessLogin(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    if (!stateStore.snapshot().claimed) {
      request.resume();
      fail(409, "SETUP_REQUIRED", "Complete first-time setup before signing in with an access key.");
    }
    if (sessionStore.ownerConfigured() || !sessionStore.accessKeyConfigured()) {
      request.resume();
      fail(404, "ACCESS_KEY_UNAVAILABLE", "Legacy access-key sign-in is not available.");
    }
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["accessKey", "deviceName", "origin"]);
    let binding;
    try {
      binding = claimRequestBinding(request, body.origin);
    } catch (error) {
      throw translateStoreError(error);
    }
    const bucket = accessLoginBucket(request);
    let issued;
    try {
      issued = await sessionStore.login({
        accessKey: body.accessKey,
        name: safeDeviceName(body.deviceName),
        origin: body.origin,
        host: binding.host
      });
      await drainPrunedBrowserSessions();
    } catch (error) {
      if (error instanceof SessionAuthError && error.code === "ACCESS_KEY_INVALID") {
        consumeAccessLoginAttempt(request);
      }
      throw translateStoreError(error);
    }
    accessLoginAttempts.delete(bucket);
    response.setHeader("Set-Cookie", issued.cookie);
    sendJson(response, 201, {
      session: issued.session,
      csrfToken: issued.csrfToken,
      authentication: publicAuthentication(sessionStore, { includeOwnerName: true })
    });
  }

  async function sessions(request, response, sessionId) {
    const authenticated = await authenticate(request, request.method !== "GET");
    if (request.method === "GET" && !sessionId) {
      sendJson(response, 200, { currentSessionId: authenticated.session.id, sessions: sessionStore.list() });
      return;
    }
    if (request.method === "DELETE" && sessionId) {
      const removed = await revokeBrowserSession(sessionId);
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
    const authenticated = await authenticate(request, request.method !== "GET");
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
    let browserAuthenticationReset = false;
    await serializeServiceMutation(async () => {
      await recheckMutationSession(request, authenticated);
      const state = stateStore.snapshot();
      const connections = await connectionsForPolicy(state, policy);
      const infrastructureTargets = await infrastructureTargetsForPolicy(state, policy);
      const infrastructureServices = await infrastructureServicesForPolicy(state, policy);
      const credentialMetadata = credentialStore.publicSnapshot();
      const previousJellyfin = state.connections.jellyfin;
      const nextJellyfin = connections.jellyfin;
      const jellyfinBoundaryChanged = Boolean(
        sessionStore.ownerConfigured()
        && previousJellyfin
        && nextJellyfin
        && connectionAuthorizationBoundaryHash(previousJellyfin, state.policy)
          !== connectionAuthorizationBoundaryHash(nextJellyfin, policy)
      );
      const staged = [];
      let stateCommitted = false;
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
        stateCommitted = true;
        if (jellyfinBoundaryChanged) {
          await revokeAllBrowserSessionsLocally({
            expected: {
              jellyfinUrl: previousJellyfin.url,
              targetRevision: previousJellyfin.targetRevision,
              boundaryHash: connectionAuthorizationBoundaryHash(previousJellyfin, state.policy)
            },
            replacement: {
              jellyfinUrl: nextJellyfin.url,
              targetRevision: nextJellyfin.targetRevision,
              boundaryHash: connectionAuthorizationBoundaryHash(nextJellyfin, policy)
            }
          });
          browserAuthenticationReset = true;
        }
      } catch (error) {
        if (!stateCommitted) {
          for (const { nextNamespace } of staged) {
            await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
          }
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
    if (browserAuthenticationReset) {
      response.setHeader("Set-Cookie", sessionStore.expiredCookie(authenticated.session.origin));
      configured.browserAuthenticationReset = true;
    }
    sendJson(response, 200, configured);
  }

  async function services(request, response, serviceValue) {
    const authenticated = await authenticate(request, request.method !== "GET");
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
      if (service === "jellyfin" && sessionStore.ownerConfigured()) {
        fail(
          409,
          "JELLYFIN_AUTH_IN_USE",
          "Reset Helmsman access before removing the Jellyfin connection used for browser sign-in."
        );
      }
      await serializeServiceMutation(async () => {
        await recheckMutationSession(request, authenticated);
        if (service === "jellyfin" && sessionStore.ownerConfigured()) {
          fail(
            409,
            "JELLYFIN_AUTH_IN_USE",
            "Reset Helmsman access before removing the Jellyfin connection used for browser sign-in."
          );
        }
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
    const currentConnection = stateStore.snapshot().connections[service];
    if (service === "jellyfin"
      && sessionStore.ownerConfigured()
      && currentConnection
      && currentConnection.url !== target.url) {
      fail(
        409,
        "JELLYFIN_AUTH_IN_USE",
        "Reset Helmsman access before changing the Jellyfin server used for browser sign-in."
      );
    }
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
    let browserAuthenticationReset = false;
    try {
      if (login) {
        if (!exchangeServiceLogin) fail(503, "LOGIN_EXCHANGE_UNAVAILABLE", "Service sign-in is temporarily unavailable.");
        consumeLoginAttempt(service);
      }
      await serializeServiceMutation(async () => {
        await recheckMutationSession(request, authenticated);
        const state = stateStore.snapshot();
        const previous = state.connections[service];
        if (service === "jellyfin"
          && sessionStore.ownerConfigured()
          && previous
          && previous.url !== target.url) {
          fail(
            409,
            "JELLYFIN_AUTH_IN_USE",
            "Reset Helmsman access before changing the Jellyfin server used for browser sign-in."
          );
        }
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
        // Clearing an optional credential is an authorization-boundary change.
        // Rotate before committing state so an interrupted/failed ciphertext
        // deletion leaves only an orphaned record that the active connection
        // can never select after this process or a restart.
        const targetRevision = !previous
          || targetChanged
          || authChanged
          || approvalChanged
          || body.clearCredential === true
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
        const jellyfinBoundaryChanged = Boolean(
          service === "jellyfin"
          && sessionStore.ownerConfigured()
          && previous
          && connectionAuthorizationBoundaryHash(previous, state.policy)
            !== connectionAuthorizationBoundaryHash(nextConnection, state.policy)
        );
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
        let stateCommitted = false;
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
            stateCommitted = true;
            if (jellyfinBoundaryChanged) {
              await revokeAllBrowserSessionsLocally({
                expected: {
                  jellyfinUrl: previous.url,
                  targetRevision: previous.targetRevision,
                  boundaryHash: connectionAuthorizationBoundaryHash(previous, state.policy)
                },
                replacement: {
                  jellyfinUrl: nextConnection.url,
                  targetRevision: nextConnection.targetRevision,
                  boundaryHash: connectionAuthorizationBoundaryHash(nextConnection, state.policy)
                }
              });
              browserAuthenticationReset = true;
            }
          } catch (error) {
            if (!stateCommitted && stagedCredential && nextNamespace !== previousNamespace) {
              await credentialStore.removeServiceCredentials(nextNamespace).catch(() => {});
            }
            throw error;
          }

          if (body.clearCredential === true) {
            const namespaces = credentialNamespacesForService(credentialStore.publicSnapshot(), service);
            for (const namespace of namespaces) await credentialStore.removeServiceCredentials(namespace);
          } else if (previousNamespace && previousNamespace !== nextNamespace) {
            await credentialStore.removeServiceCredentials(previousNamespace).catch(() => {
              log("An obsolete encrypted credential record could not be cleaned up.");
            });
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
    const metadata = connectionMetadata(stateStore.snapshot(), credentialStore.publicSnapshot(), service);
    if (browserAuthenticationReset) {
      response.setHeader("Set-Cookie", sessionStore.expiredCookie(authenticated.session.origin));
      metadata.browserAuthenticationReset = true;
    }
    sendJson(response, 200, metadata);
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

  function requiredActionRevision(value) {
    if (typeof value !== "string" || !UUID.test(value)) {
      fail(400, "INVALID_TARGET_REVISION", "Refresh the connection before sending an action.");
    }
    return value;
  }

  function requiredActionInteger(value, label, maximum = 2_147_483_647) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      fail(400, "INVALID_ACTION_TARGET", `Choose a valid ${label}.`);
    }
    return value;
  }

  function requiredSeasonNumbers(value) {
    if (!Array.isArray(value)
      || value.length < 1
      || value.length > MAX_REQUESTED_SEASONS
      || value.some((season, index) => (
        !Number.isSafeInteger(season)
        || season < 1
        || season > 10_000
        || (index > 0 && season <= value[index - 1])
      ))) {
      fail(400, "INVALID_ACTION_TARGET", "Choose one or more current seasons in ascending order.");
    }
    return Object.freeze([...value]);
  }

  function requiredMediaDetailRevision(value) {
    if (typeof value !== "string" || !MEDIA_DETAIL_REVISION.test(value)) {
      fail(400, "INVALID_MEDIA_DETAIL_REVISION", "Refresh the series before requesting seasons.");
    }
    return value;
  }

  function requireCurrentSeriesTarget(snapshot, tmdbId) {
    const matches = (snapshot?.media?.records || []).filter((candidate) => (
      candidate?.mediaType === "series"
      && ((candidate?.seasonRequestTarget?.service === "seerr"
        && candidate.seasonRequestTarget.resourceId === tmdbId)
        || candidate?.providerIds?.tmdb === tmdbId)
    ));
    if (matches.length !== 1) {
      fail(
        409,
        "ACTION_TARGET_NOT_CURRENT",
        "That series is not one current Seerr request target. Refresh and try again."
      );
    }
    return matches[0];
  }

  function requireCurrentSeerrProvider(snapshot, targetRevision) {
    const provider = requireCurrentActionEvidence(
      snapshot?.services?.find((candidate) => candidate?.id === "seerr"),
      targetRevision,
      "seerr inventory"
    );
    if (provider?.connectionState !== "connected") {
      fail(409, "ACTION_TARGET_NOT_CURRENT", "Current seerr inventory is not connected.");
    }
    return provider;
  }

  function publicSeriesSeasonDetail(value, tmdbId, targetRevision) {
    const allowedStatuses = new Set([
      "unknown",
      "pending",
      "processing",
      "partially_available",
      "available",
      "blocklisted",
      "deleted"
    ]);
    const allowedRequestStates = new Set(["pending", "approved", "declined", "failed", "completed"]);
    const blockedStatuses = new Set(["pending", "processing", "partially_available", "available", "blocklisted"]);
    const blockedRequestStates = new Set(["pending", "approved", "failed"]);
    if (!value
      || value.tmdbId !== tmdbId
      || value.targetRevision !== targetRevision
      || !MEDIA_DETAIL_REVISION.test(value.detailRevision)
      || !Array.isArray(value.seasons)
      || value.seasons.length > 256) {
      fail(502, "UPSTREAM_RESPONSE_INVALID", "Seerr returned an invalid series season response.");
    }
    const seasons = [];
    for (const season of value.seasons) {
      const seasonNumber = season?.seasonNumber;
      const episodeCount = season?.episodeCount;
      const requestState = season?.requestState ?? null;
      if (!Number.isSafeInteger(seasonNumber)
        || seasonNumber < 0
        || seasonNumber > 10_000
        || (seasons.length && seasonNumber <= seasons.at(-1).seasonNumber)
        || !Number.isSafeInteger(episodeCount)
        || episodeCount < 0
        || episodeCount > 100_000
        || typeof season.name !== "string"
        || Array.from(season.name).length < 1
        || Array.from(season.name).length > 120
        || /[\u0000-\u001f\u007f-\u009f]/u.test(season.name)
        || (season.airDate !== null && (typeof season.airDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(season.airDate)))
        || !allowedStatuses.has(season.status)
        || (requestState !== null && !allowedRequestStates.has(requestState))
        || typeof season.requestable !== "boolean"
        || (season.requestable && (seasonNumber === 0
          || episodeCount === 0
          || blockedStatuses.has(season.status)
          || blockedRequestStates.has(requestState)))) {
        fail(502, "UPSTREAM_RESPONSE_INVALID", "Seerr returned an invalid series season response.");
      }
      seasons.push({
        seasonNumber,
        name: season.name,
        episodeCount,
        airDate: season.airDate,
        status: season.status,
        requestState,
        requestable: season.requestable
      });
    }
    return {
      tmdbId,
      targetRevision,
      detailRevision: value.detailRevision,
      seasons
    };
  }

  function currentOperationsSnapshot() {
    if (!monitor) fail(503, "MONITOR_STARTING", "The operations monitor is still starting.");
    const snapshot = monitor.getSnapshot();
    if (!snapshot || typeof snapshot !== "object") {
      fail(503, "MONITOR_STARTING", "Current inventory is not available yet.");
    }
    return snapshot;
  }

  function requireCurrentActionEvidence(evidence, targetRevision, label) {
    const checkedAt = Date.parse(evidence?.checkedAt);
    const age = Date.now() - checkedAt;
    if (!evidence
      || evidence.targetRevision !== targetRevision
      || !Number.isFinite(checkedAt)
      || age < -30_000
      || age > ACTION_INVENTORY_MAX_AGE_MS) {
      fail(409, "ACTION_INVENTORY_STALE", `Refresh ${label} before sending a control action.`);
    }
    return evidence;
  }

  function rememberRecentAction(key, now = Date.now()) {
    recentActions.delete(key);
    recentActions.set(key, now + ACTION_COOLDOWN_MS);
    while (recentActions.size > MAX_RECENT_ACTIONS) {
      recentActions.delete(recentActions.keys().next().value);
    }
  }

  function pruneRecentActions(now = Date.now()) {
    for (const [key, expiresAt] of recentActions) {
      if (expiresAt <= now) recentActions.delete(key);
    }
  }

  async function runSingleFlightAction(key, operation) {
    const now = Date.now();
    pruneRecentActions(now);
    if (activeActions.has(key)) {
      fail(409, "ACTION_IN_PROGRESS", "An action is already in progress for this resource.");
    }
    if ((recentActions.get(key) || 0) > now) {
      fail(409, "ACTION_RECENTLY_ACCEPTED", "A recent action may still be taking effect. Refresh before trying again.");
    }
    activeActions.add(key);
    try {
      const result = await operation();
      rememberRecentAction(key);
      return result;
    } catch (error) {
      if (error?.code === "ACTION_OUTCOME_UNKNOWN") rememberRecentAction(key);
      throw error;
    } finally {
      activeActions.delete(key);
    }
  }

  async function portainerContainerAction(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!executePortainerContainerAction) fail(503, "ACTIONS_UNAVAILABLE", "Portainer controls are temporarily unavailable.");
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["serviceId", "environmentId", "containerId", "operation", "targetRevision"]);
    const serviceId = typeof body.serviceId === "string" && UUID.test(body.serviceId) ? body.serviceId : null;
    const environmentId = requiredActionInteger(body.environmentId, "Portainer environment");
    const containerId = typeof body.containerId === "string" && /^[a-f0-9]{64}$/u.test(body.containerId)
      ? body.containerId
      : null;
    const operation = ["start", "restart", "stop"].includes(body.operation) ? body.operation : null;
    const targetRevision = requiredActionRevision(body.targetRevision);
    if (!serviceId || !containerId || !operation) {
      fail(400, "INVALID_ACTION_TARGET", "Choose a current Portainer container and supported action.");
    }

    const { state, service } = infrastructureServiceById(serviceId);
    if (service.type !== "portainer"
      || service.enabled === false
      || service.monitoringEnabled === false
      || service.targetRevision !== targetRevision) {
      fail(409, "TARGET_CHANGED", "The Portainer connection changed; refresh it before trying again.");
    }
    const snapshotService = requireCurrentActionEvidence(
      (currentOperationsSnapshot().infrastructure?.portainer || [])
        .find((candidate) => candidate?.id === serviceId),
      targetRevision,
      "Portainer inventory"
    );
    const environment = snapshotService?.inventory?.environments
      ?.find((candidate) => candidate?.id === environmentId && candidate?.containerCapable === true);
    const container = snapshotService?.inventory?.containers?.find((candidate) => (
      candidate?.environmentId === environmentId && candidate?.id === containerId
    ));
    if (snapshotService?.connectionState !== "connected"
      || environment?.state !== "up"
      || !environment
      || !container) {
      fail(409, "ACTION_TARGET_NOT_CURRENT", "That container is not in the current Portainer inventory. Refresh and try again.");
    }
    const allowedState = operation === "start"
      ? ["created", "exited"].includes(container.state)
      : container.state === "running";
    if (!allowedState) {
      fail(409, "ACTION_NOT_AVAILABLE", `The ${operation} action is not available while this container is ${container.state}.`);
    }

    const target = parseInfrastructureServiceUrl(service.url);
    const targetResolution = await resolveAndAuthorizeTarget(target, state.policy, {
      lookup,
      approvedHostCidrs: service.approvedHostCidrs || []
    });
    const result = await runSingleFlightAction(
      `portainer:${serviceId}:${environmentId}:${containerId}`,
      async () => {
        try {
          return await useInfrastructureServiceCredentials(serviceId, service, (credentials) => (
            executePortainerContainerAction({
              service,
              environmentId,
              containerId,
              operation,
              targetResolution,
              credentials
            })
          ));
        } finally {
          monitor?.requestRefresh?.();
        }
      }
    );
    sendJson(response, 200, result);
  }

  async function proxmoxWorkloadAction(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!executeProxmoxWorkloadAction) fail(503, "ACTIONS_UNAVAILABLE", "Proxmox controls are temporarily unavailable.");
    const body = await readBoundedJson(request);
    requireExactKeys(body, ["environmentId", "node", "type", "vmid", "operation", "targetRevision"]);
    const environmentId = typeof body.environmentId === "string" && UUID.test(body.environmentId)
      ? body.environmentId
      : null;
    const node = typeof body.node === "string" && /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(body.node)
      && !body.node.includes("..") ? body.node : null;
    const type = ["qemu", "lxc"].includes(body.type) ? body.type : null;
    const vmid = requiredActionInteger(body.vmid, "Proxmox workload", 999_999_999);
    const operation = ["start", "reboot", "shutdown"].includes(body.operation) ? body.operation : null;
    const targetRevision = requiredActionRevision(body.targetRevision);
    if (!environmentId || !node || !type || !operation) {
      fail(400, "INVALID_ACTION_TARGET", "Choose a current Proxmox workload and supported action.");
    }

    const { state, target: environment } = targetById(environmentId);
    if (environment.type !== "proxmox"
      || environment.enabled === false
      || environment.monitoringEnabled === false
      || environment.targetRevision !== targetRevision) {
      fail(409, "TARGET_CHANGED", "The Proxmox environment changed; refresh it before trying again.");
    }
    const snapshotEnvironment = requireCurrentActionEvidence(
      (currentOperationsSnapshot().infrastructure?.environments || [])
        .find((candidate) => candidate?.id === environmentId),
      targetRevision,
      "Proxmox inventory"
    );
    const workload = snapshotEnvironment?.workloads?.find((candidate) => (
      candidate?.node === node && candidate?.type === type && candidate?.vmid === vmid
    ));
    if (snapshotEnvironment?.connectionState !== "connected" || !workload || workload.template === true) {
      fail(409, "ACTION_TARGET_NOT_CURRENT", "That workload is not in the current Proxmox inventory. Refresh and try again.");
    }
    if (workload.lock) {
      fail(409, "ACTION_NOT_AVAILABLE", "Proxmox has locked this workload; wait for the current task to finish.");
    }
    const allowedState = operation === "start" ? workload.status === "stopped" : workload.status === "running";
    if (!allowedState) {
      fail(409, "ACTION_NOT_AVAILABLE", `The ${operation} action is not available while this workload is ${workload.status}.`);
    }

    const endpoints = infrastructureEndpoints(environment);
    const endpoint = endpoints.find((candidate) => (
      candidate.id === snapshotEnvironment?.selectedEndpointId && candidate.enabled !== false
    )) || primaryInfrastructureEndpoint(environment);
    if (!endpoint || endpoint.enabled === false) {
      fail(409, "ACTION_ENDPOINT_UNAVAILABLE", "No enabled Proxmox endpoint is available for this environment.");
    }
    const target = parseInfrastructureTargetUrl(endpoint.url);
    const targetResolution = await resolveAndAuthorizeTarget(target, state.policy, {
      lookup,
      approvedHostCidrs: endpoint.approvedHostCidrs || []
    });
    const result = await runSingleFlightAction(
      `proxmox:${environmentId}:${node}:${type}:${vmid}`,
      async () => {
        try {
          return await useInfrastructureCredentials(environmentId, environment, (credentials) => (
            executeProxmoxWorkloadAction({
              environment,
              endpoint,
              node,
              type,
              vmid,
              operation,
              targetResolution,
              credentials
            })
          ), endpoint.id);
        } finally {
          monitor?.requestRefresh?.();
        }
      }
    );
    sendJson(response, 200, result);
  }

  async function mediaRecoveryAction(request, response) {
    if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, true);
    if (!executeMediaRecoveryAction) fail(503, "ACTIONS_UNAVAILABLE", "Media recovery controls are temporarily unavailable.");
    const body = await readBoundedJson(request);
    const seasonRequest = body.operation === "requestSeasons";
    const queueAction = body.operation === "blocklistAndSearch";
    requireExactKeys(body, seasonRequest
      ? ["serviceId", "operation", "resourceId", "seasonNumbers", "targetRevision", "detailRevision"]
      : queueAction
        ? ["serviceId", "operation", "queueId", "targetRevision"]
        : ["serviceId", "operation", "resourceId", "targetRevision"]);
    const serviceId = ["seerr", "radarr", "sonarr"].includes(body.serviceId) ? body.serviceId : null;
    const operation = ["retryRequest", "requestSeasons", "searchMovie", "searchSeries", "blocklistAndSearch"].includes(body.operation)
      ? body.operation
      : null;
    const resourceId = queueAction ? null : requiredActionInteger(body.resourceId, "media resource", 9_999_999_999);
    const queueId = queueAction ? requiredActionInteger(body.queueId, "queue item") : null;
    const targetRevision = requiredActionRevision(body.targetRevision);
    const seasonNumbers = seasonRequest ? requiredSeasonNumbers(body.seasonNumbers) : null;
    const detailRevision = seasonRequest ? requiredMediaDetailRevision(body.detailRevision) : null;
    const operationAllowed = serviceId === "seerr"
      ? ["retryRequest", "requestSeasons"].includes(operation)
      : (serviceId === "radarr" && ["searchMovie", "blocklistAndSearch"].includes(operation))
        || (serviceId === "sonarr" && ["searchSeries", "blocklistAndSearch"].includes(operation));
    if (!serviceId || !operationAllowed) {
      fail(400, "INVALID_ACTION_TARGET", "Choose a supported media recovery action.");
    }
    if (seasonRequest && !fetchSeerrSeriesSeasons) {
      fail(503, "MEDIA_SEASONS_UNAVAILABLE", "Series seasons are temporarily unavailable.");
    }
    const state = stateStore.snapshot();
    const connection = state.connections[serviceId];
    if (!connection || connection.monitoringEnabled === false || connection.targetRevision !== targetRevision) {
      fail(409, "TARGET_CHANGED", "The media service connection changed; refresh it before trying again.");
    }
    const snapshot = currentOperationsSnapshot();
    const provider = serviceId === "seerr"
      ? requireCurrentSeerrProvider(snapshot, targetRevision)
      : requireCurrentActionEvidence(
        snapshot.services?.find((candidate) => candidate?.id === serviceId),
        targetRevision,
        `${serviceId} inventory`
      );
    if (serviceId !== "seerr" && provider?.connectionState !== "connected") {
      fail(409, "ACTION_TARGET_NOT_CURRENT", `Current ${serviceId} inventory is not connected.`);
    }
    if (seasonRequest) {
      requireCurrentSeriesTarget(snapshot, resourceId);
    } else if (serviceId === "seerr") {
      const requestRecord = snapshot.media?.requests?.find((candidate) => candidate?.requestId === resourceId);
      if (!requestRecord || requestRecord.requestStatus !== "failed") {
        fail(409, "ACTION_NOT_AVAILABLE", "That request is not currently marked failed by Seerr.");
      }
    } else if (queueAction) {
      const queueMatches = (provider?.inventory?.activity || []).filter((candidate) => (
        candidate?.service === serviceId && candidate?.queueId === queueId
      ));
      const activityMatches = (snapshot.media?.activity || []).filter((candidate) => (
        candidate?.service === serviceId
        && candidate?.queueActionTarget?.service === serviceId
        && candidate.queueActionTarget.queueId === queueId
      ));
      const queueState = String(queueMatches[0]?.state || "").toLowerCase();
      const blocked = typeof queueMatches[0]?.error === "string" && queueMatches[0].error.length > 0
        || /(?:blocked|failed|error)/u.test(queueState);
      if (queueMatches.length !== 1
        || activityMatches.length !== 1
        || !blocked) {
        fail(409, "ACTION_NOT_AVAILABLE", `That ${serviceId} queue item is not one current blocked import.`);
      }
    } else {
      const expectedType = serviceId === "radarr" ? "movie" : "series";
      const matches = (provider?.inventory?.library || []).filter((candidate) => (
        candidate?.mediaType === expectedType && Number(candidate?.sourceId) === resourceId
      ));
      const records = (snapshot.media?.records || []).filter((candidate) => (
        candidate?.mediaType === expectedType
        && Array.isArray(candidate.actionTargets)
        && candidate.actionTargets.some((target) => (
          target?.service === serviceId && target?.resourceId === resourceId
        ))
      ));
      if (matches.length !== 1
        || matches[0].monitored !== true
        || records.length !== 1
        || records[0].monitored !== true
        || records[0].available === true
        || records[0].downloading === true) {
        fail(409, "ACTION_TARGET_NOT_CURRENT", `That ${expectedType} is not one current monitored ${serviceId} target.`);
      }
    }

    if (seasonRequest) {
      const result = await runSingleFlightAction(
        `media:seerr:request-seasons:${resourceId}`,
        async () => {
          try {
            const currentState = stateStore.snapshot();
            const currentConnection = currentState.connections.seerr;
            if (!currentConnection
              || currentConnection.monitoringEnabled === false
              || currentConnection.targetRevision !== targetRevision) {
              fail(409, "TARGET_CHANGED", "The Seerr connection changed; refresh it before trying again.");
            }
            const currentSnapshot = currentOperationsSnapshot();
            requireCurrentSeerrProvider(currentSnapshot, targetRevision);
            requireCurrentSeriesTarget(currentSnapshot, resourceId);
            const currentDetail = publicSeriesSeasonDetail(
              await fetchSeerrSeriesSeasons({
                tmdbId: resourceId,
                targetRevision,
                cacheMode: "bypass"
              }),
              resourceId,
              targetRevision
            );
            if (currentDetail.detailRevision !== detailRevision) {
              fail(409, "ACTION_TARGET_CHANGED", "The series season state changed; refresh it before trying again.");
            }
            const seasonsByNumber = new Map(currentDetail.seasons.map((season) => [season.seasonNumber, season]));
            if (seasonNumbers.some((seasonNumber) => seasonsByNumber.get(seasonNumber)?.requestable !== true)) {
              fail(409, "ACTION_NOT_AVAILABLE", "One or more selected seasons can no longer be requested.");
            }
            const currentTarget = parseServiceUrl(currentConnection.url);
            const targetResolution = await resolveAndAuthorizeTarget(currentTarget, currentState.policy, {
              lookup,
              approvedHostCidrs: currentConnection.approvedHostCidrs || []
            });
            return await useServiceCredential("seerr", currentConnection, (credential) => (
              executeMediaRecoveryAction({
                serviceId: "seerr",
                operation,
                resourceId,
                seasonNumbers,
                connection: currentConnection,
                targetResolution,
                credential
              })
            ));
          } finally {
            monitor?.requestRefresh?.();
          }
        }
      );
      sendJson(response, 200, result);
      return;
    }

    const target = parseServiceUrl(connection.url);
    const targetResolution = await resolveAndAuthorizeTarget(target, state.policy, {
      lookup,
      approvedHostCidrs: connection.approvedHostCidrs || []
    });
    const result = await runSingleFlightAction(
      `media:${serviceId}:${operation}:${queueAction ? queueId : resourceId}`,
      async () => {
        try {
          return await useServiceCredential(serviceId, connection, (credential) => (
            executeMediaRecoveryAction({
              serviceId,
              operation,
              ...(queueAction ? { queueId } : { resourceId }),
              connection,
              targetResolution,
              credential
            })
          ));
        } finally {
          monitor?.requestRefresh?.();
        }
      }
    );
    sendJson(response, 200, result);
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

  async function mediaSeriesSeasons(request, response, tmdbIdValue, url) {
    if (request.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    await authenticate(request, false);
    if (!fetchSeerrSeriesSeasons) {
      fail(503, "MEDIA_SEASONS_UNAVAILABLE", "Series seasons are temporarily unavailable.");
    }
    const queryEntries = [...url.searchParams];
    if (queryEntries.length !== 1 || queryEntries[0][0] !== "targetRevision") {
      fail(400, "INVALID_REQUEST", "Provide the current Seerr target revision only.");
    }
    const tmdbId = requiredActionInteger(Number(tmdbIdValue), "TMDb series", 9_999_999_999);
    const targetRevision = requiredActionRevision(queryEntries[0][1]);
    const state = stateStore.snapshot();
    const connection = state.connections.seerr;
    if (!connection || connection.monitoringEnabled === false || connection.targetRevision !== targetRevision) {
      fail(409, "TARGET_CHANGED", "The Seerr connection changed; refresh it before loading seasons.");
    }
    const snapshot = currentOperationsSnapshot();
    requireCurrentSeerrProvider(snapshot, targetRevision);
    requireCurrentSeriesTarget(snapshot, tmdbId);
    const detail = await fetchSeerrSeriesSeasons({
      tmdbId,
      targetRevision,
      cacheMode: "read"
    });
    sendJson(response, 200, publicSeriesSeasonDetail(detail, tmdbId, targetRevision));
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
      if (url.pathname === "/api/v2/auth/jellyfin/enroll") {
        await enrollJellyfinOwner(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/auth/jellyfin/login") {
        await jellyfinLogin(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/access/login") {
        await accessLogin(request, response);
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
      if (url.pathname === "/api/v2/actions/portainer/container") {
        if (url.search) fail(404, "NOT_FOUND", "Not found.");
        await portainerContainerAction(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/actions/proxmox/workload") {
        if (url.search) fail(404, "NOT_FOUND", "Not found.");
        await proxmoxWorkloadAction(request, response);
        return true;
      }
      if (url.pathname === "/api/v2/actions/media") {
        if (url.search) fail(404, "NOT_FOUND", "Not found.");
        await mediaRecoveryAction(request, response);
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
      const seriesSeasonsMatch = url.pathname.match(/^\/api\/v2\/media\/series\/([1-9][0-9]*)\/seasons$/u);
      if (seriesSeasonsMatch) {
        await mediaSeriesSeasons(request, response, seriesSeasonsMatch[1], url);
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
    close: async () => {
      await closeBrowserRevocations();
      await credentialStore.close();
    },
    csrfHeaderName: CSRF_HEADER_NAME
  };
}
