import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalServiceId,
  authorizeBridgeRoute,
  authorizeMediaAction,
  authorizePortainerContainerAction,
  authorizePortainerRoute,
  authorizeProxmoxWorkloadAction,
  authorizeProxmoxRoute
} from "./routes.mjs";
import { createControlPlane, ControlPlaneError } from "./control-plane.mjs";
import { createEventJournal } from "./event-journal.mjs";
import { createHealthIncidentEngine } from "./health-engine.mjs";
import { normalizeLokiQueryResult, authorizeLokiRoute } from "./loki.mjs";
import { probeLoki } from "./loki-probes.mjs";
import { performLokiUpstreamRequest } from "./loki-transport.mjs";
import { createMediaArtworkCache, MEDIA_ARTWORK_LIMITS } from "./media-artwork.mjs";
import { createSeerrRequestMetadataEnricher } from "./seerr-request-metadata.mjs";
import { normalizeSeerrSeriesSeasons } from "./seerr-series-seasons.mjs";
import { createOperationsMonitor } from "./monitor.mjs";
import { createPersistentCache } from "./persistent-cache.mjs";
import { probeProxmox, probeProxmoxEndpoint } from "./proxmox-probes.mjs";
import { probePortainer } from "./portainer-probes.mjs";
import { probeService } from "./service-probes.mjs";
import {
  connectionAuthorizationBoundaryHash,
  isSecureBrowserOrigin,
  NetworkPolicyError,
  normalizePolicy,
  parseServiceUrl,
  resolveAndAuthorizeExplicitTarget,
  resolveAndAuthorizeTarget
} from "./network.mjs";
import { generateSecretToken, hashToken, StateStore, tokenMatches } from "./state.mjs";

const DEFAULT_VERSION = "1.3.3";
const requestedVersion = String(process.env.HELMSMAN_VERSION || DEFAULT_VERSION);
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(requestedVersion)
  ? requestedVersion
  : DEFAULT_VERSION;
const DEVICE_TOKEN_HEADER = "x-jellofin-device-token";
const TARGET_REVISION_HEADER = "x-jellofin-target-revision";
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_RELAY_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_PER_SERVICE = 4;
const MAX_STATIC_BYTES = 8 * 1024 * 1024;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_TOP_LEVEL = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "sw.js"
]);
const STATIC_PREFIXES = ["assets/", "src/"];

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
});

const SHELL_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; trusted-types jellofin-render; require-trusted-types-for 'script'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

class BrokerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
    this.code = code;
  }
}

function asBrokerError(error) {
  if (error instanceof BrokerError) return error;
  if (error instanceof ControlPlaneError) {
    return new BrokerError(error.status || 500, error.code || "CONTROL_PLANE_ERROR", error.message);
  }
  if (error instanceof NetworkPolicyError) {
    return new BrokerError(error.status || 400, error.code || "NETWORK_POLICY_ERROR", error.message);
  }
  return new BrokerError(500, "INTERNAL_ERROR", "The broker could not complete the request.");
}

export function validProxmoxActionAcknowledgement(value) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? ""));
  } catch {
    return false;
  }
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.data === "string"
    ? parsed.data
    : null;
  return Boolean(data && /^UPID:[A-Za-z0-9.-]{1,63}:[A-Fa-f0-9]{8}:[A-Fa-f0-9]{8}:[A-Fa-f0-9]{8}:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{0,128}:[^:\u0000-\u001f\u007f-\u009f]{1,256}:$/u.test(data));
}

export function validSeerrRequestAcknowledgement(value, expectedSeasonNumbers = null) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? ""));
  } catch {
    return false;
  }
  const validId = Boolean(parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && Number.isSafeInteger(parsed.id)
    && parsed.id > 0
    && parsed.id <= 9_999_999_999);
  if (!validId) return false;
  // Seerr guarantees creation with HTTP 201, but response relations vary by
  // release. Treat echoed request fields as optional evidence, not required
  // acknowledgement fields, while rejecting them if they contradict our post.
  if (Object.hasOwn(parsed, "is4k") && parsed.is4k !== false) return false;
  if (!Object.hasOwn(parsed, "seasons")) return expectedSeasonNumbers === null || Array.isArray(expectedSeasonNumbers);
  if (expectedSeasonNumbers === null) return true;
  if (!Array.isArray(expectedSeasonNumbers) || !Array.isArray(parsed.seasons)) return false;
  const accepted = [];
  const seen = new Set();
  for (const value of parsed.seasons) {
    const seasonNumber = value && typeof value === "object" && !Array.isArray(value)
      ? value.seasonNumber
      : null;
    if (!Number.isSafeInteger(seasonNumber)
      || seasonNumber < 1
      || seasonNumber > 10_000
      || seen.has(seasonNumber)) return false;
    seen.add(seasonNumber);
    accepted.push(seasonNumber);
  }
  accepted.sort((left, right) => left - right);
  // Seerr may filter a season that became requested or available between our
  // preflight and its write. A non-empty subset is still a valid creation;
  // anything outside the posted set is not.
  return accepted.length > 0
    && accepted.every((seasonNumber) => expectedSeasonNumbers.includes(seasonNumber));
}

export function acceptedSeerrSeasonRequestStatus(upstream, expectedSeasonNumbers = null) {
  const status = Number(upstream?.status);
  if (status === 201) {
    if (!validSeerrRequestAcknowledgement(upstream?.body, expectedSeasonNumbers)) {
      throw new BrokerError(502, "UPSTREAM_RESPONSE_INVALID", "Seerr did not return a valid request acknowledgement.");
    }
    return { status, noOp: false };
  }
  if (status === 202) {
    throw new BrokerError(
      409,
      "ACTION_NOT_AVAILABLE",
      "Seerr reports that none of those seasons can currently be requested. Refresh the series before trying again."
    );
  }
  if (status === 409) {
    throw new BrokerError(409, "ACTION_TARGET_CHANGED", "The Seerr request changed; refresh it before trying again.");
  }
  if (status === 401) {
    throw new BrokerError(502, "ACTION_AUTHENTICATION_FAILED", "Seerr rejected the saved credential for this action.");
  }
  if (status === 403) {
    throw new BrokerError(
      403,
      "ACTION_PERMISSION_DENIED",
      "Seerr denied this request because of account permission, request quota, blocklist, or credential policy."
    );
  }
  throw new BrokerError(
    502,
    "ACTION_OUTCOME_UNKNOWN",
    "Seerr returned an unexpected response after the season request began. Refresh its state before deciding whether to try again."
  );
}

export function actionDispatchError(error, provider) {
  if (String(provider || "").toLowerCase() === "seerr" && error?.code === "UPSTREAM_RESPONSE_INVALID") {
    return new BrokerError(
      502,
      "ACTION_OUTCOME_UNKNOWN",
      "Seerr began the request but did not confirm a persistent request record. Check the title's TVDB mapping and Seerr/Sonarr state before trying again."
    );
  }
  if ([
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_RESPONSE_FAILED",
    "UPSTREAM_UNREACHABLE",
    "UPSTREAM_RESPONSE_INVALID",
    "UPSTREAM_RESPONSE_TOO_LARGE",
    "UPSTREAM_CONTENT_REJECTED",
    "UPSTREAM_REDIRECT_REJECTED"
  ].includes(error?.code)) {
    return new BrokerError(
      502,
      "ACTION_OUTCOME_UNKNOWN",
      `${provider} did not return a trustworthy completion response after the action began. Refresh its state before deciding whether to try again.`
    );
  }
  return error;
}

function setCommonSecurityHeaders(response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  setCommonSecurityHeaders(response);
  response.setHeader("Content-Security-Policy", API_CSP);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.length));
  response.statusCode = status;
  response.end(body);
}

function sendError(response, error) {
  const safe = asBrokerError(error);
  response.setHeader("X-Jellofin-Broker-Error", safe.code);
  sendJson(response, safe.status, {
    code: safe.code,
    message: safe.message,
    error: { code: safe.code, message: safe.message }
  });
}

function normalizedHostHeader(request) {
  const raw = request.headers.host;
  if (typeof raw !== "string"
    || raw.length < 1
    || raw.length > 255
    || /[\u0000-\u0020\u007f-\u009f/@?#\\]/u.test(raw)) {
    throw new BrokerError(421, "HOST_REJECTED", "The request Host is not accepted.");
  }
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.host.toLowerCase() !== raw.toLowerCase()) {
      throw new Error("non-canonical host");
    }
    return parsed.host.toLowerCase();
  } catch {
    throw new BrokerError(421, "HOST_REJECTED", "The request Host is not accepted.");
  }
}

function normalizedOriginHeader(request, required) {
  const raw = request.headers.origin;
  if (raw === undefined && !required) return null;
  if (typeof raw !== "string" || raw.length > 512 || raw === "null") {
    throw new BrokerError(403, "ORIGIN_REJECTED", "The request Origin is not accepted.");
  }
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin !== raw
      || parsed.pathname !== "/"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash) {
      throw new Error("non-canonical origin");
    }
    return parsed.origin;
  } catch {
    throw new BrokerError(403, "ORIGIN_REJECTED", "The request Origin is not accepted.");
  }
}

function enforceRequestOrigin(request, device = null, required = false) {
  const host = normalizedHostHeader(request);
  const origin = normalizedOriginHeader(request, required);
  if (origin && new URL(origin).host.toLowerCase() !== host) {
    throw new BrokerError(403, "ORIGIN_REJECTED", "The request Origin does not match its Host.");
  }
  if (device) {
    let deviceOrigin;
    try {
      deviceOrigin = new URL(device.origin);
    } catch {
      throw new BrokerError(401, "DEVICE_NOT_AUTHORIZED", "The device authorization is invalid.");
    }
    if (deviceOrigin.host.toLowerCase() !== host || (origin && origin !== deviceOrigin.origin)) {
      throw new BrokerError(403, "ORIGIN_REJECTED", "This device token is not valid for this application origin.");
    }
  }
  return { host, origin };
}

function requirePlainObject(value, message = "The request body must be a JSON object.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError(400, "INVALID_REQUEST", message);
  }
  return value;
}

function requireExactKeys(value, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new BrokerError(400, "INVALID_REQUEST", `Unsupported request field: ${key}.`);
  }
}

async function readBoundedBody(request, maximumBytes) {
  const encoding = request.headers["content-encoding"];
  if (encoding && String(encoding).toLowerCase() !== "identity") {
    throw new BrokerError(415, "CONTENT_ENCODING_NOT_ALLOWED", "Compressed request bodies are not accepted.");
  }
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    if (!/^\d+$/u.test(String(declared)) || Number(declared) > maximumBytes) {
      throw new BrokerError(413, "REQUEST_TOO_LARGE", "The request body exceeded its safety limit.");
    }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      request.resume();
      throw new BrokerError(413, "REQUEST_TOO_LARGE", "The request body exceeded its safety limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(request, maximumBytes = MAX_JSON_BODY_BYTES) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) {
    throw new BrokerError(415, "JSON_REQUIRED", "Use an application/json request body.");
  }
  const body = await readBoundedBody(request, maximumBytes);
  try {
    return requirePlainObject(JSON.parse(body.toString("utf8")));
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

function publicConfig(state) {
  return {
    policy: {
      allowedCidrs: [...state.policy.allowedCidrs],
      allowPublicHttps: state.policy.allowPublicHttps,
      revision: state.policy.revision
    },
    connections: Object.fromEntries(
      Object.entries(state.connections).map(([service, connection]) => [service, {
        url: connection.url,
        targetRevision: connection.targetRevision
      }])
    )
  };
}

function authenticateDevice(request, state) {
  if (!state.claimed) throw new BrokerError(409, "SETUP_REQUIRED", "Complete first-time setup before using the broker.");
  const presented = request.headers[DEVICE_TOKEN_HEADER];
  if (typeof presented !== "string") {
    throw new BrokerError(401, "DEVICE_TOKEN_REQUIRED", "A valid device token is required.");
  }
  for (const [id, device] of Object.entries(state.devices)) {
    if (tokenMatches(device.tokenHash, presented)) return { id, ...device };
  }
  throw new BrokerError(401, "DEVICE_NOT_AUTHORIZED", "The device token is invalid or revoked.");
}

function safeDeviceName(value) {
  if (typeof value !== "string") throw new BrokerError(400, "INVALID_DEVICE_NAME", "Enter a device name.");
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    throw new BrokerError(400, "INVALID_DEVICE_NAME", "Enter a device name between 1 and 80 characters.");
  }
  return normalized;
}

const JELLYFIN_DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function normalizedJellyfinDeviceId(value) {
  const candidate = value === undefined ? randomUUID() : value;
  if (typeof candidate !== "string" || !JELLYFIN_DEVICE_ID.test(candidate)) {
    throw new BrokerError(400, "INVALID_JELLYFIN_DEVICE", "The Jellyfin browser device is invalid.");
  }
  return candidate;
}

function validJellyfinSecretBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > 4096) return false;
  return !/[\u0000-\u001f\u007f-\u009f]/u.test(value.toString("utf8"));
}

function validJellyfinIdentityText(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

function parseJellyfinIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wrapped = value.User && typeof value.User === "object" && !Array.isArray(value.User);
  const user = wrapped ? value.User : value;
  const outerServerId = wrapped && typeof value.ServerId === "string" ? value.ServerId : null;
  const userServerId = typeof user.ServerId === "string" ? user.ServerId : null;
  if (outerServerId && userServerId && outerServerId !== userServerId) return null;
  const serverId = outerServerId || userServerId;
  const userId = user.Id;
  const username = user.Name;
  const policy = user.Policy;
  if (!validJellyfinIdentityText(serverId)
    || !validJellyfinIdentityText(userId)
    || typeof username !== "string"
    || !username.trim()
    || username.length > 256
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(username)
    || !policy
    || typeof policy !== "object"
    || Array.isArray(policy)
    || typeof policy.IsAdministrator !== "boolean"
    || typeof policy.IsDisabled !== "boolean"
    || (user.IsDisabled !== undefined && typeof user.IsDisabled !== "boolean")) {
    return null;
  }
  return Object.freeze({
    serverId,
    userId,
    username,
    isAdministrator: policy.IsAdministrator,
    isDisabled: policy.IsDisabled || user.IsDisabled === true
  });
}

function takeJellyfinAccessToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value.AccessToken;
  value.AccessToken = undefined;
  if (typeof token !== "string"
    || token.length < 1
    || token.length > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(token)) return null;
  return Buffer.from(token, "utf8");
}

function validateConnectionBody(body) {
  requireExactKeys(body, ["url"]);
  if (typeof body.url !== "string") throw new BrokerError(400, "INVALID_TARGET", "Enter one service URL.");
  return parseServiceUrl(body.url);
}

function cookiePairs(rawHeader) {
  if (typeof rawHeader !== "string" || rawHeader.length > 8192) return [];
  const pairs = [];
  for (const component of rawHeader.split(";")) {
    const separator = component.indexOf("=");
    if (separator < 1) continue;
    const name = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_.-]{1,80}$/u.test(name)
      && value.length <= 4096
      && !/[\u0000-\u0020\u007f;,]/u.test(value)) {
      pairs.push({ name, value });
    }
  }
  return pairs;
}

function targetRevisionTag(targetRevision) {
  if (typeof targetRevision !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(targetRevision)) {
    throw new BrokerError(500, "INVALID_CONNECTION_STATE", "The registered connection state is invalid.");
  }
  return targetRevision.replaceAll("-", "");
}

function brokerSessionCookieName(service, targetRevision) {
  const prefix = service === "seerr" ? "JFC_SEERR" : "JFC_QBIT";
  return `${prefix}_${targetRevisionTag(targetRevision)}`;
}

function validUpstreamSessionName(service, name) {
  if (service === "seerr") return name === "connect.sid";
  if (service !== "qbittorrent") return false;
  if (name === "SID") return true;
  const match = name.match(/^QBT_SID_([1-9][0-9]{0,4})$/u);
  return Boolean(match && Number(match[1]) <= 65535);
}

function wrapUpstreamSession(name, value) {
  return Buffer.from(`${name}\0${value}`, "utf8").toString("base64url");
}

function unwrapUpstreamSession(service, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) {
    throw new BrokerError(400, "INVALID_SERVICE_SESSION", "The service session cookie is invalid.");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new BrokerError(400, "INVALID_SERVICE_SESSION", "The service session cookie is invalid.");
  }
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new BrokerError(400, "INVALID_SERVICE_SESSION", "The service session cookie is invalid.");
  }
  const separator = decoded.indexOf("\0");
  if (separator < 1 || decoded.indexOf("\0", separator + 1) !== -1) {
    throw new BrokerError(400, "INVALID_SERVICE_SESSION", "The service session cookie is invalid.");
  }
  const name = decoded.slice(0, separator);
  const sessionValue = decoded.slice(separator + 1);
  if (!validUpstreamSessionName(service, name)
    || !sessionValue
    || sessionValue.length > 3000
    || !/^[\x21-\x3a\x3c-\x7e]+$/u.test(sessionValue)) {
    throw new BrokerError(400, "INVALID_SERVICE_SESSION", "The service session cookie is invalid.");
  }
  return { name, value: sessionValue };
}

function allowedSessionCookie(service, rawHeader, route, targetRevision) {
  if (route.isLogin) return null;
  if (!["seerr", "qbittorrent"].includes(service)) return null;
  const brokerName = brokerSessionCookieName(service, targetRevision);
  const candidates = cookiePairs(rawHeader).filter(({ name }) => name === brokerName);
  if (candidates.length > 1) {
    throw new BrokerError(400, "AMBIGUOUS_SERVICE_SESSION", "Multiple service session cookies were rejected.");
  }
  return candidates.length ? unwrapUpstreamSession(service, candidates[0].value) : null;
}

function copyCredentialHeaders(request, service, route, targetRevision, headers) {
  // Seerr's fixed imageproxy route is deliberately unauthenticated and clears
  // cookies in Seerr itself. Do not expose a broad API key or browser session
  // to a route that does not need either credential.
  if (service === "seerr" && route.isArtwork) return false;
  let explicitCredential = false;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.length <= 4096) {
    const accepted = service === "jellyfin"
      ? authorization.startsWith("MediaBrowser ")
      : service === "qbittorrent"
        ? /^Bearer qbt_[A-Za-z0-9]{28}$/u.test(authorization)
        : false;
    if (accepted) {
      headers.Authorization = authorization;
      explicitCredential = true;
    }
  }
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string"
    && apiKey.length >= 1
    && apiKey.length <= 2048
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(apiKey)
    && !["jellyfin", "qbittorrent"].includes(service)) {
    headers["X-Api-Key"] = apiKey;
    explicitCredential = true;
  }
  // An explicit API credential and an ambient browser session must never be
  // combined. Besides identity ambiguity, doing so could expose an old
  // HttpOnly session after the registered service target changes.
  if (!explicitCredential) {
    const session = allowedSessionCookie(service, request.headers.cookie, route, targetRevision);
    if (session) headers.Cookie = `${session.name}=${session.value}`;
  }
  return explicitCredential;
}

function relayContentType(request, body) {
  if (!body.length) return null;
  const raw = String(request.headers["content-type"] || "").toLowerCase();
  if (/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(raw)) return "application/json";
  if (/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/u.test(raw)) {
    return "application/x-www-form-urlencoded";
  }
  throw new BrokerError(415, "CONTENT_TYPE_NOT_ALLOWED", "That request content type is not accepted by the bridge.");
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function appendTargetPath(target, upstreamPathAndQuery) {
  return `${target.basePath}${upstreamPathAndQuery}` || "/";
}

function safeSetCookies(rawCookies, service, deviceOrigin, targetRevision) {
  if (!Array.isArray(rawCookies) || !["seerr", "qbittorrent"].includes(service)) return [];
  const accepted = [];
  for (const raw of rawCookies.slice(0, 8)) {
    if (typeof raw !== "string" || raw.length > 8192 || /[\r\n]/u.test(raw)) continue;
    const match = raw.match(/^\s*([A-Za-z0-9_.-]{1,80})=([^;\r\n,]*)/u);
    if (!match) continue;
    const [, name, value] = match;
    if (!validUpstreamSessionName(service, name)
      || value.length > 3000
      || !/^[\x21-\x3a\x3c-\x7e]*$/u.test(value)) continue;
    const expired = value === "" || /(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(raw);
    const secure = new URL(deviceOrigin).protocol === "https:" ? "; Secure" : "";
    const cookiePath = service === "seerr" ? "/bridge/seerr/" : "/bridge/qbit/";
    const brokerName = brokerSessionCookieName(service, targetRevision);
    const brokerValue = expired ? "" : wrapUpstreamSession(name, value);
    accepted.push(`${brokerName}=${brokerValue}; Path=${cookiePath}${expired ? "; Max-Age=0" : ""}; HttpOnly; SameSite=Strict${secure}`);
    break;
  }
  return accepted;
}

function strictLoginSession(rawCookies, service) {
  if (service !== "seerr" || !Array.isArray(rawCookies) || rawCookies.length > 8) return null;
  const matches = [];
  for (const raw of rawCookies) {
    if (typeof raw !== "string" || raw.length > 8192 || /[\r\n]/u.test(raw)) continue;
    const match = raw.match(/^\s*([A-Za-z0-9_.-]{1,80})=([^;\r\n,]*)(.*)$/u);
    if (!match || match[1] !== "connect.sid") continue;
    const value = match[2];
    const attributes = match[3];
    if (!value
      || value.length > 3000
      || !/^[\x21-\x3a\x3c-\x7e]+$/u.test(value)
      || /(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(attributes)) {
      throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Seerr returned an invalid sign-in session.");
    }
    matches.push({ name: match[1], value });
  }
  if (matches.length > 1) {
    throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Seerr returned an ambiguous sign-in session.");
  }
  return matches[0] || null;
}

function expiredServiceCookies(service, deviceOrigin, targetRevision) {
  if (!["seerr", "qbittorrent"].includes(service)) return [];
  const secure = new URL(deviceOrigin).protocol === "https:" ? "; Secure" : "";
  const cookiePath = service === "seerr" ? "/bridge/seerr/" : "/bridge/qbit/";
  const name = brokerSessionCookieName(service, targetRevision);
  return [`${name}=; Path=${cookiePath}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`];
}

function clearChunks(chunks) {
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  }
  chunks.length = 0;
}

function discardAndClearResponse(response) {
  response.on("data", (chunk) => {
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  });
  response.resume();
}

export async function performUpstreamRequest({
  request,
  body,
  targetResolution,
  route,
  deviceOrigin,
  targetRevision,
  limits,
  shutdownSignal
}) {
  const { target, pinned } = targetResolution;
  const contentType = relayContentType(request, body);
  const headers = {
    Host: target.authority,
    Accept: route.isArtwork
      ? "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8"
      : "application/json, text/plain;q=0.9",
    "User-Agent": `Helmsman/${VERSION}`,
    Connection: "close"
  };
  const explicitCredential = copyCredentialHeaders(request, route.service, route, targetRevision, headers);
  if (contentType) headers["Content-Type"] = contentType;
  if (body.length) headers["Content-Length"] = String(body.length);

  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: route.method,
    path: appendTargetPath(target, route.upstreamPathAndQuery),
    headers,
    lookup: pinnedLookup(pinned.address, pinned.family),
    family: pinned.family,
    agent: false,
    signal: shutdownSignal
      ? AbortSignal.any([AbortSignal.timeout(limits.upstreamTimeoutMs), shutdownSignal])
      : AbortSignal.timeout(limits.upstreamTimeoutMs)
  };
  if (target.protocol === "https:") {
    requestOptions.rejectUnauthorized = true;
    if (!/^\d/u.test(target.hostname) && !target.hostname.includes(":")) requestOptions.servername = target.hostname;
  }

  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let clearResponseState = () => {};
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearResponseState();
      reject(error);
    };
    const upstream = transport.request(requestOptions, (upstreamResponse) => {
      const status = Number(upstreamResponse.statusCode || 502);
      if (status >= 300 && status < 400) {
        discardAndClearResponse(upstreamResponse);
        finishReject(new BrokerError(502, "UPSTREAM_REDIRECT_REJECTED", "The configured service redirected the API request."));
        return;
      }
      // Image endpoints commonly return JSON or plain text for 401/403/404.
      // Preserve only the status so the browser can classify the failure and
      // try an approved fallback; never mistake that expected error body for a
      // malformed successful image or relay it to the client.
      if (route.isArtwork && (status < 200 || status >= 300)) {
        discardAndClearResponse(upstreamResponse);
        settled = true;
        resolve({
          status,
          body: Buffer.alloc(0),
          contentType: "application/octet-stream",
          cookies: []
        });
        return;
      }
      const maximum = route.isArtwork ? limits.maxImageResponseBytes : limits.maxApiResponseBytes;
      const declared = Number(upstreamResponse.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maximum) {
        discardAndClearResponse(upstreamResponse);
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The service response exceeded the bridge safety limit."));
        upstreamResponse.destroy();
        return;
      }
      const chunks = [];
      let total = 0;
      let responseBody = null;
      clearResponseState = () => {
        clearChunks(chunks);
        responseBody?.fill(0);
        responseBody = null;
      };
      upstreamResponse.on("data", (chunk) => {
        if (settled) {
          if (Buffer.isBuffer(chunk)) chunk.fill(0);
          return;
        }
        total += chunk.length;
        if (total > maximum) {
          if (Buffer.isBuffer(chunk)) chunk.fill(0);
          finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The service response exceeded the bridge safety limit."));
          upstreamResponse.destroy();
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("error", () => {
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "The service response ended unexpectedly."));
      });
      upstreamResponse.on("aborted", () => {
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "The service response ended unexpectedly."));
      });
      upstreamResponse.on("close", () => {
        if (!upstreamResponse.complete) {
          finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "The service response ended unexpectedly."));
        }
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        try {
          responseBody = Buffer.concat(chunks, total);
          clearChunks(chunks);
          const responseContentType = String(upstreamResponse.headers["content-type"] || "application/octet-stream")
            .split(";", 1)[0]
            .trim()
            .toLowerCase();
          if (route.isArtwork && !/^image\/(?:avif|gif|jpeg|png|webp)$/u.test(responseContentType)) {
            throw new BrokerError(502, "UPSTREAM_CONTENT_REJECTED", "The artwork endpoint did not return a supported image.");
          }
          if (!route.isArtwork && responseContentType === "text/html") {
            throw new BrokerError(502, "UPSTREAM_CONTENT_REJECTED", "The service returned HTML instead of an API response.");
          }
          let loginSession = null;
          if (route.isLogin && status >= 200 && status < 300) {
            loginSession = strictLoginSession(upstreamResponse.headers["set-cookie"], route.service);
          }
          const responseCookies = route.isLogin || explicitCredential
            ? []
            : safeSetCookies(upstreamResponse.headers["set-cookie"], route.service, deviceOrigin, targetRevision);
          const result = {
            status,
            body: responseBody,
            contentType: responseContentType,
            loginSession,
            cookies: responseCookies
          };
          responseBody = null;
          clearResponseState = () => {};
          settled = true;
          resolve(result);
        } catch (error) {
          finishReject(error);
        }
      });
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", (error) => {
      const timeout = error?.name === "AbortError" || error?.code === "ABORT_ERR";
      finishReject(new BrokerError(502, timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE", timeout
        ? "The service request timed out."
        : "The configured service could not be reached."));
    });
    if (body.length) upstream.end(body);
    else upstream.end();
  });
}

export async function performMediaActionUpstreamRequest({
  targetResolution,
  route,
  credentialHeaders,
  targetRevision,
  limits,
  shutdownSignal
}) {
  const authorizedRoute = authorizeMediaAction(route?.operation, {
    service: route?.service,
    resourceId: route?.resourceId,
    queueId: route?.queueId,
    seasonNumbers: route?.seasonNumbers
  });
  const sameSeasonNumbers = authorizedRoute.allowed
    && (authorizedRoute.seasonNumbers === undefined
      ? route?.seasonNumbers === undefined
      : Array.isArray(route?.seasonNumbers)
        && route.seasonNumbers.length === authorizedRoute.seasonNumbers.length
        && route.seasonNumbers.every((value, index) => value === authorizedRoute.seasonNumbers[index]));
  if (!authorizedRoute.allowed
    || !route?.allowed
    || route.actionId !== "media"
    || route.service !== authorizedRoute.service
    || route.operation !== authorizedRoute.operation
    || route.resourceId !== authorizedRoute.resourceId
    || route.queueId !== authorizedRoute.queueId
    || !sameSeasonNumbers
    || route.method !== authorizedRoute.method
    || route.upstreamPathAndQuery !== authorizedRoute.upstreamPathAndQuery
    || route.body !== authorizedRoute.body
    || route.internalOnly !== true) {
    throw new BrokerError(404, "ROUTE_NOT_ALLOWED", "That media recovery action is not allowed.");
  }
  const body = Buffer.from(authorizedRoute.body, "utf8");
  return performUpstreamRequest({
    request: {
      method: authorizedRoute.method,
      headers: {
        ...(credentialHeaders || {}),
        ...(body.length ? { "content-type": "application/json" } : {})
      }
    },
    body,
    targetResolution,
    route: authorizedRoute,
    deviceOrigin: "http://127.0.0.1",
    targetRevision,
    limits: {
      ...limits,
      maxApiResponseBytes: Number.isSafeInteger(limits?.maxApiResponseBytes)
        ? Math.min(limits.maxApiResponseBytes, 64 * 1024)
        : 64 * 1024
    },
    shutdownSignal
  });
}

const PROXMOX_TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROXMOX_TOKEN_SECRET = /^[^\u0000-\u0020\u007f-\u009f]{1,4096}$/u;
const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/u;
const TLS_TRUST_ERRORS = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

function proxmoxAuthorization(credentials) {
  if (!credentials
    || !Buffer.isBuffer(credentials.tokenId)
    || !Buffer.isBuffer(credentials.tokenSecret)
    || credentials.tokenId.length < 1
    || credentials.tokenId.length > 320
    || credentials.tokenSecret.length < 1
    || credentials.tokenSecret.length > 4096) {
    throw new BrokerError(400, "INVALID_CREDENTIAL", "Enter a valid Proxmox API token ID and secret.");
  }
  const tokenId = credentials.tokenId.toString("utf8");
  const tokenSecret = credentials.tokenSecret.toString("utf8");
  if (!PROXMOX_TOKEN_ID.test(tokenId) || !PROXMOX_TOKEN_SECRET.test(tokenSecret)) {
    throw new BrokerError(400, "INVALID_CREDENTIAL", "Enter a valid Proxmox API token ID and secret.");
  }
  return `PVEAPIToken=${tokenId}=${tokenSecret}`;
}

function normalizedPinnedFingerprint(value) {
  return typeof value === "string" && SHA256_FINGERPRINT.test(value)
    ? value
    : null;
}

function tlsBrokerError(error) {
  if (error instanceof BrokerError) return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new BrokerError(502, "UPSTREAM_TIMEOUT", "The Proxmox request timed out.");
  }
  if (TLS_TRUST_ERRORS.has(error?.code)) {
    return new BrokerError(
      502,
      "TLS_CERTIFICATE_UNTRUSTED",
      "The Proxmox certificate is not trusted. Use system trust or configure its exact SHA-256 fingerprint."
    );
  }
  return new BrokerError(502, "UPSTREAM_UNREACHABLE", "The configured Proxmox target could not be reached.");
}

async function openPinnedProxmoxSocket({ target, pinned, fingerprint, signal }) {
  const expected = Buffer.from(fingerprint, "hex");
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({
      host: pinned.address,
      port: target.port,
      family: pinned.family,
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"]
    });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => finishReject(new BrokerError(502, "UPSTREAM_TIMEOUT", "The Proxmox request timed out."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => finishReject(tlsBrokerError(error)));
    socket.once("secureConnect", () => {
      if (settled) return;
      const certificate = socket.getPeerCertificate(true);
      if (!certificate || !Buffer.isBuffer(certificate.raw) || certificate.raw.length < 1) {
        finishReject(new BrokerError(502, "TLS_CERTIFICATE_INVALID", "Proxmox did not present a usable TLS certificate."));
        return;
      }
      const actual = createHash("sha256").update(certificate.raw).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        finishReject(new BrokerError(502, "TLS_PIN_MISMATCH", "The Proxmox certificate fingerprint did not match the configured pin."));
        return;
      }
      const validFrom = Date.parse(certificate.valid_from);
      const validTo = Date.parse(certificate.valid_to);
      const now = Date.now();
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
        finishReject(new BrokerError(502, "TLS_CERTIFICATE_INVALID", "The pinned Proxmox certificate is outside its validity period."));
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    });
  });
}

export async function performProxmoxUpstreamRequest({
  targetResolution,
  route,
  credentials,
  tlsMode,
  certificateFingerprint,
  limits,
  shutdownSignal
}) {
  const actionRoute = route?.actionId === "workload";
  const authorizedRoute = actionRoute
    ? authorizeProxmoxWorkloadAction(route?.operation, {
        node: route?.node,
        type: route?.type,
        vmid: route?.vmid
      })
    : authorizeProxmoxRoute(route?.routeId, route?.method, { node: route?.node });
  if (!authorizedRoute.allowed
    || !route?.allowed
    || route.service !== authorizedRoute.service
    || route.actionId !== authorizedRoute.actionId
    || route.operation !== authorizedRoute.operation
    || route.node !== authorizedRoute.node
    || route.type !== authorizedRoute.type
    || route.vmid !== authorizedRoute.vmid
    || route.method !== authorizedRoute.method
    || route.upstreamPathAndQuery !== authorizedRoute.upstreamPathAndQuery
    || route.internalOnly !== true) {
    throw new BrokerError(404, "ROUTE_NOT_ALLOWED", "That Proxmox capability is not allowed.");
  }
  const { target, pinned } = targetResolution || {};
  if (!target || !pinned || target.protocol !== "https:") {
    throw new BrokerError(400, "HTTPS_REQUIRED", "Proxmox infrastructure targets must use HTTPS.");
  }
  const pinnedFamily = isIP(pinned.address);
  if (!pinnedFamily || pinnedFamily !== Number(pinned.family)) {
    throw new BrokerError(500, "INVALID_TARGET_RESOLUTION", "The resolved Proxmox target is invalid.");
  }
  if (tlsMode !== "system" && tlsMode !== "pinned") {
    throw new BrokerError(400, "INVALID_TLS_MODE", "Choose system certificate trust or a pinned certificate fingerprint.");
  }
  const fingerprint = normalizedPinnedFingerprint(certificateFingerprint);
  if (tlsMode === "pinned" && !fingerprint) {
    throw new BrokerError(400, "CERTIFICATE_FINGERPRINT_REQUIRED", "Pinned certificate trust requires a SHA-256 fingerprint.");
  }
  if (tlsMode === "system" && certificateFingerprint !== null && certificateFingerprint !== undefined) {
    throw new BrokerError(400, "CERTIFICATE_FINGERPRINT_NOT_ALLOWED", "A fingerprint is only used with pinned certificate trust.");
  }
  const maximum = Number.isSafeInteger(limits?.maxApiResponseBytes) && limits.maxApiResponseBytes > 0
    ? Math.min(DEFAULT_MAX_API_RESPONSE_BYTES, limits.maxApiResponseBytes)
    : DEFAULT_MAX_API_RESPONSE_BYTES;
  const timeoutMs = Number.isSafeInteger(limits?.upstreamTimeoutMs) && limits.upstreamTimeoutMs > 0
    ? Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, limits.upstreamTimeoutMs)
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const signal = shutdownSignal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdownSignal])
    : AbortSignal.timeout(timeoutMs);
  let verifiedSocket = null;
  if (tlsMode === "pinned") {
    verifiedSocket = await openPinnedProxmoxSocket({ target, pinned, fingerprint, signal });
  }
  // In pinned mode, do not even serialize the API credential until the peer
  // certificate has matched. This keeps a failed pin outside the credential
  // handling boundary as well as guaranteeing that no authenticated bytes are
  // sent to an unverified peer.
  const authorization = proxmoxAuthorization(credentials);
  const headers = {
    Host: target.authority,
    Accept: "application/json",
    Authorization: authorization,
    "User-Agent": `Helmsman/${VERSION}`,
    Connection: "close"
  };
  const requestOptions = {
    protocol: "https:",
    hostname: target.hostname,
    port: target.port,
    method: authorizedRoute.method,
    path: appendTargetPath(target, authorizedRoute.upstreamPathAndQuery),
    headers,
    agent: false,
    signal
  };
  if (verifiedSocket) {
    // No HTTP bytes (and no serialized API token) are created until the leaf
    // certificate has matched the configured SHA-256 pin above.
    requestOptions.createConnection = () => verifiedSocket;
    requestOptions.rejectUnauthorized = false;
  } else {
    requestOptions.lookup = pinnedLookup(pinned.address, pinned.family);
    requestOptions.family = pinned.family;
    requestOptions.rejectUnauthorized = true;
    if (!isIP(target.hostname)) requestOptions.servername = target.hostname;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(tlsBrokerError(error));
    };
    const upstream = https.request(requestOptions, (upstreamResponse) => {
      const status = Number(upstreamResponse.statusCode || 502);
      if (status >= 300 && status < 400) {
        upstreamResponse.resume();
        finishReject(new BrokerError(502, "UPSTREAM_REDIRECT_REJECTED", "The configured Proxmox target redirected the API request."));
        return;
      }
      if (status < 200 || status >= 300) {
        upstreamResponse.resume();
        settled = true;
        resolve({ status, body: Buffer.alloc(0), contentType: "application/octet-stream" });
        return;
      }
      const declared = Number(upstreamResponse.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maximum) {
        upstreamResponse.destroy();
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Proxmox response exceeded its safety limit."));
        return;
      }
      const chunks = [];
      let total = 0;
      upstreamResponse.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximum) {
          upstreamResponse.destroy();
          finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Proxmox response exceeded its safety limit."));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("error", () => {
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "The Proxmox response ended unexpectedly."));
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        settled = true;
        const contentType = String(upstreamResponse.headers["content-type"] || "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType === "text/html") {
          reject(new BrokerError(502, "UPSTREAM_CONTENT_REJECTED", "Proxmox returned HTML instead of an API response."));
          return;
        }
        resolve({ status, body: Buffer.concat(chunks, total), contentType });
      });
    });
    upstream.on("error", finishReject);
    upstream.end();
  });
}

function portainerAccessToken(credentials) {
  const token = credentials?.accessToken;
  if (!Buffer.isBuffer(token) || token.length < 1 || token.length > 4096) {
    throw new BrokerError(400, "INVALID_CREDENTIAL", "Enter a valid Portainer access token.");
  }
  const value = token.toString("utf8");
  if (!value || Buffer.byteLength(value, "utf8") !== token.length || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) {
    throw new BrokerError(400, "INVALID_CREDENTIAL", "Enter a valid Portainer access token.");
  }
  return value;
}

function portainerTlsBrokerError(error) {
  if (error instanceof BrokerError) return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new BrokerError(502, "UPSTREAM_TIMEOUT", "The Portainer request timed out.");
  }
  if (TLS_TRUST_ERRORS.has(error?.code)) {
    return new BrokerError(
      502,
      "TLS_CERTIFICATE_UNTRUSTED",
      "The Portainer certificate is not trusted. Use system trust or configure its exact SHA-256 fingerprint."
    );
  }
  return new BrokerError(502, "UPSTREAM_UNREACHABLE", "The configured Portainer service could not be reached.");
}

async function openPinnedPortainerSocket({ target, pinned, fingerprint, signal }) {
  const expected = Buffer.from(fingerprint, "hex");
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({
      host: pinned.address,
      port: target.port,
      family: pinned.family,
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"]
    });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => finishReject(new BrokerError(502, "UPSTREAM_TIMEOUT", "The Portainer request timed out."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => finishReject(portainerTlsBrokerError(error)));
    socket.once("secureConnect", () => {
      if (settled) return;
      const certificate = socket.getPeerCertificate(true);
      if (!certificate || !Buffer.isBuffer(certificate.raw) || certificate.raw.length < 1) {
        finishReject(new BrokerError(502, "TLS_CERTIFICATE_INVALID", "Portainer did not present a usable TLS certificate."));
        return;
      }
      const actual = createHash("sha256").update(certificate.raw).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        finishReject(new BrokerError(502, "TLS_PIN_MISMATCH", "The Portainer certificate fingerprint did not match the configured pin."));
        return;
      }
      const validFrom = Date.parse(certificate.valid_from);
      const validTo = Date.parse(certificate.valid_to);
      const now = Date.now();
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
        finishReject(new BrokerError(502, "TLS_CERTIFICATE_INVALID", "The pinned Portainer certificate is outside its validity period."));
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    });
  });
}

export async function performPortainerUpstreamRequest({
  targetResolution,
  route,
  credentials,
  targetRevision,
  tlsMode,
  certificateFingerprint,
  limits,
  shutdownSignal
}) {
  const actionRoute = route?.actionId === "container";
  const authorizedRoute = actionRoute
    ? authorizePortainerContainerAction(route?.operation, {
        endpointId: route?.endpointId,
        containerId: route?.containerId
      })
    : authorizePortainerRoute(route?.routeId, route?.method, {
        endpointId: route?.endpointId,
        start: route?.start
      });
  if (!authorizedRoute.allowed
    || !route?.allowed
    || route.service !== authorizedRoute.service
    || route.actionId !== authorizedRoute.actionId
    || route.operation !== authorizedRoute.operation
    || route.endpointId !== authorizedRoute.endpointId
    || route.containerId !== authorizedRoute.containerId
    || route.start !== authorizedRoute.start
    || route.method !== authorizedRoute.method
    || route.upstreamPathAndQuery !== authorizedRoute.upstreamPathAndQuery
    || route.internalOnly !== true) {
    throw new BrokerError(404, "ROUTE_NOT_ALLOWED", "That Portainer capability is not allowed.");
  }
  const { target, pinned } = targetResolution || {};
  if (!target || !pinned || target.protocol !== "https:") {
    throw new BrokerError(400, "HTTPS_REQUIRED", "Portainer infrastructure services must use HTTPS.");
  }
  const pinnedFamily = isIP(pinned.address);
  if (!pinnedFamily || pinnedFamily !== Number(pinned.family)) {
    throw new BrokerError(500, "INVALID_TARGET_RESOLUTION", "The resolved Portainer service is invalid.");
  }
  if (tlsMode !== "system" && tlsMode !== "pinned") {
    throw new BrokerError(400, "INVALID_TLS_MODE", "Choose system certificate trust or a pinned certificate fingerprint.");
  }
  const fingerprint = normalizedPinnedFingerprint(certificateFingerprint);
  if (tlsMode === "pinned" && !fingerprint) {
    throw new BrokerError(400, "CERTIFICATE_FINGERPRINT_REQUIRED", "Pinned certificate trust requires a SHA-256 fingerprint.");
  }
  if (tlsMode === "system" && certificateFingerprint !== null && certificateFingerprint !== undefined) {
    throw new BrokerError(400, "CERTIFICATE_FINGERPRINT_NOT_ALLOWED", "A fingerprint is only used with pinned certificate trust.");
  }

  const maximum = Number.isSafeInteger(limits?.maxApiResponseBytes) && limits.maxApiResponseBytes > 0
    ? Math.min(DEFAULT_MAX_API_RESPONSE_BYTES, limits.maxApiResponseBytes)
    : DEFAULT_MAX_API_RESPONSE_BYTES;
  const requestTimeoutMs = Number.isSafeInteger(limits?.upstreamTimeoutMs) && limits.upstreamTimeoutMs > 0
    ? Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, limits.upstreamTimeoutMs)
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const signal = shutdownSignal
    ? AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), shutdownSignal])
    : AbortSignal.timeout(requestTimeoutMs);
  let verifiedSocket = null;
  if (tlsMode === "pinned") {
    verifiedSocket = await openPinnedPortainerSocket({ target, pinned, fingerprint, signal });
  }
  // In pinned mode the access token is decoded only after the certificate
  // matches. With system trust, Node completes certificate verification before
  // it can send the serialized HTTP headers below.
  const accessToken = authorizedRoute.credentialRequired ? portainerAccessToken(credentials) : null;
  const headers = {
    Host: target.authority,
    Accept: "application/json",
    ...(accessToken ? { "X-API-Key": accessToken } : {}),
    "User-Agent": `Helmsman/${VERSION}`,
    Connection: "close"
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(portainerTlsBrokerError(error));
    };
    const requestOptions = {
      protocol: "https:",
      hostname: target.hostname,
      port: target.port,
      method: authorizedRoute.method,
      path: appendTargetPath(target, authorizedRoute.upstreamPathAndQuery),
      headers,
      agent: false,
      signal
    };
    if (verifiedSocket) {
      requestOptions.createConnection = () => verifiedSocket;
      requestOptions.rejectUnauthorized = false;
    } else {
      requestOptions.lookup = pinnedLookup(pinned.address, pinned.family);
      requestOptions.family = pinned.family;
      requestOptions.rejectUnauthorized = true;
      if (!isIP(target.hostname)) requestOptions.servername = target.hostname;
    }
    const upstream = https.request(requestOptions, (upstreamResponse) => {
      const status = Number(upstreamResponse.statusCode || 502);
      if (status >= 300 && status < 400 && !(actionRoute && status === 304)) {
        upstreamResponse.resume();
        finishReject(new BrokerError(502, "UPSTREAM_REDIRECT_REJECTED", "The configured Portainer service redirected the API request."));
        return;
      }
      if (status < 200 || status >= 300) {
        upstreamResponse.resume();
        settled = true;
        resolve({ status, body: Buffer.alloc(0), contentType: "application/octet-stream" });
        return;
      }
      const declared = Number(upstreamResponse.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maximum) {
        upstreamResponse.destroy();
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Portainer response exceeded its safety limit."));
        return;
      }
      const chunks = [];
      let total = 0;
      upstreamResponse.on("data", (chunk) => {
        total += chunk.length;
        if (total > maximum) {
          upstreamResponse.destroy();
          finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Portainer response exceeded its safety limit."));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("error", () => {
        finishReject(new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "The Portainer response ended unexpectedly."));
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        settled = true;
        const contentType = String(upstreamResponse.headers["content-type"] || "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType === "text/html") {
          reject(new BrokerError(502, "UPSTREAM_CONTENT_REJECTED", "Portainer returned HTML instead of an API response."));
          return;
        }
        resolve({ status, body: Buffer.concat(chunks, total), contentType });
      });
    });
    upstream.on("error", finishReject);
    upstream.end();
  });
}

function safeStaticRelativePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded === "/") return "index.html";
  const relative = decoded.replace(/^\/+/, "");
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => part === ".." || part.startsWith("."))) {
    return null;
  }
  if (STATIC_TOP_LEVEL.has(relative) || STATIC_PREFIXES.some((prefix) => relative.startsWith(prefix))) return relative;
  // Extensionless routes are handled by the browser shell.
  if (!path.extname(relative)) return "index.html";
  return null;
}

async function serveStatic(request, response, rootDir, pathname) {
  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    throw new BrokerError(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }
  const relative = safeStaticRelativePath(pathname);
  if (!relative) throw new BrokerError(404, "NOT_FOUND", "Not found.");
  const candidate = path.resolve(rootDir, relative);
  const realRoot = await realpath(rootDir);
  let realCandidate;
  try {
    realCandidate = await realpath(candidate);
  } catch {
    throw new BrokerError(404, "NOT_FOUND", "Not found.");
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new BrokerError(404, "NOT_FOUND", "Not found.");
  }
  const bytes = await readFile(realCandidate);
  if (bytes.length > MAX_STATIC_BYTES) throw new BrokerError(404, "NOT_FOUND", "Not found.");
  setCommonSecurityHeaders(response);
  response.setHeader("Content-Security-Policy", SHELL_CSP);
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Content-Type", MIME_TYPES[path.extname(realCandidate).toLowerCase()] || "application/octet-stream");
  if (relative.startsWith("assets/services/") || relative.startsWith("assets/workloads/")) {
    const etag = `"${createHash("sha256").update(bytes).digest("base64url")}"`;
    response.removeHeader("Pragma");
    response.removeHeader("Expires");
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.setHeader("ETag", etag);
    if (request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
  }
  response.setHeader("Content-Length", String(bytes.length));
  response.statusCode = 200;
  response.end(request.method === "HEAD" ? undefined : bytes);
}

export async function createBroker(options = {}) {
  const dataDir = options.dataDir || process.env.HELMSMAN_DATA_DIR || process.env.JELLOFIN_COMMAND_DATA_DIR || "/data";
  const rootDir = path.resolve(options.rootDir || PROJECT_ROOT);
  const log = typeof options.log === "function" ? options.log : (message) => console.log(message);
  const lookup = options.lookup;
  const dispatchUpstream = options.dispatchUpstream || performUpstreamRequest;
  const dispatchMediaAction = options.dispatchMediaAction || performMediaActionUpstreamRequest;
  const dispatchProxmox = options.dispatchProxmox || performProxmoxUpstreamRequest;
  const dispatchPortainer = options.dispatchPortainer || performPortainerUpstreamRequest;
  const dispatchLoki = options.dispatchLoki || performLokiUpstreamRequest;
  const limits = {
    maxApiResponseBytes: options.maxApiResponseBytes || DEFAULT_MAX_API_RESPONSE_BYTES,
    maxImageResponseBytes: options.maxImageResponseBytes || DEFAULT_MAX_IMAGE_RESPONSE_BYTES,
    upstreamTimeoutMs: options.upstreamTimeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS,
    maxConcurrent: options.maxConcurrent || DEFAULT_MAX_CONCURRENT,
    maxPerService: options.maxPerService || DEFAULT_MAX_PER_SERVICE
  };
  const store = new StateStore(dataDir, { guard: options.stateGuard });
  await store.initialize();
  const eventJournal = options.eventJournal || await createEventJournal({
    dataDir,
    guard: options.stateGuard
  });
  let persistentCache = options.persistentCache || null;
  if (!persistentCache) {
    try {
      persistentCache = await createPersistentCache({ dataDir });
    } catch {
      log("Helmsman persistent cache is unavailable; live monitoring will continue without it.");
    }
  }
  let initialOperationsSnapshot = null;
  try {
    initialOperationsSnapshot = await persistentCache?.readSnapshot?.() || null;
  } catch {
    log("Helmsman ignored an unreadable cached operations snapshot.");
  }
  const recordEvent = (event) => {
    try {
      const pending = eventJournal.record(event);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      return pending;
    } catch {
      return null;
    }
  };
  const setupToken = await store.rotateUnclaimedSetupToken();
  if (setupToken) log(`Helmsman setup token: ${setupToken}`);
  let activeRequests = 0;
  const activeByService = new Map();
  const shutdownController = new AbortController();
  let shuttingDown = false;
  let activeHandlers = 0;
  const drainWaiters = new Set();
  let controlPlane;

  function reserveServiceCapacity(service) {
    if (activeRequests >= limits.maxConcurrent
      || (activeByService.get(service) || 0) >= limits.maxPerService) {
      throw new BrokerError(503, "BROKER_BUSY", "The broker concurrency limit has been reached.");
    }
    activeRequests += 1;
    activeByService.set(service, (activeByService.get(service) || 0) + 1);
    return () => {
      activeRequests -= 1;
      const remaining = Math.max(0, (activeByService.get(service) || 1) - 1);
      if (remaining) activeByService.set(service, remaining);
      else activeByService.delete(service);
    };
  }

  function jellyfinAuthorization(token = null, deviceId = store.snapshot().instanceId) {
    const normalizedDeviceId = normalizedJellyfinDeviceId(deviceId);
    const fields = [
      'Client="Helmsman"',
      'Device="Container"',
      `DeviceId="${normalizedDeviceId}"`,
      `Version="${VERSION}"`
    ];
    if (token !== null) fields.push(`Token="${encodeURIComponent(token)}"`);
    return `MediaBrowser ${fields.join(", ")}`;
  }

  function monitorCredentialHeaders(service, credential, connection) {
    const value = credential.toString("utf8");
    if (service === "jellyfin") {
      return { authorization: jellyfinAuthorization(value) };
    }
    if (service === "seerr" && connection?.authMode === "login") {
      // Stored Seerr sessions use the same opaque wrapper as browser relay
      // cookies. Validate it before constructing the broker-scoped cookie that
      // performUpstreamRequest will unwrap for the registered destination.
      unwrapUpstreamSession("seerr", value);
      const name = brokerSessionCookieName("seerr", connection.targetRevision);
      return { cookie: `${name}=${value}` };
    }
    if (service === "qbittorrent") return { authorization: `Bearer ${value}` };
    return { "x-api-key": value };
  }

  function isPublicProbe(service, upstreamPath) {
    return (service === "jellyfin" && upstreamPath === "/System/Info/Public")
      || (service === "seerr" && upstreamPath === "/api/v1/status");
  }

  async function monitorRequest(serviceValue, upstreamPath, requestOptions = {}) {
    const service = canonicalServiceId(serviceValue);
    if (!service) throw new BrokerError(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    const state = store.snapshot();
    const connection = state.connections[service];
    if (!connection) throw new BrokerError(409, "CONNECTION_NOT_CONFIGURED", "That service has not been configured.");
    if (requestOptions.targetRevision !== undefined
      && requestOptions.targetRevision !== connection.targetRevision) {
      throw new BrokerError(409, "TARGET_CHANGED", "The service target changed while this artwork request was waiting.");
    }
    const bridgeName = service === "qbittorrent" ? "qbit" : service;
    const route = authorizeBridgeRoute(service, requestOptions.method || "GET", `/bridge/${bridgeName}${upstreamPath}`);
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    const release = reserveServiceCapacity(service);
    try {
      const resolution = await resolveAndAuthorizeTarget(connection.url, state.policy, {
        lookup,
        approvedHostCidrs: connection.approvedHostCidrs || []
      });
      const send = async (headers = {}) => {
        const signal = requestOptions.signal
          ? AbortSignal.any([shutdownController.signal, requestOptions.signal])
          : shutdownController.signal;
        const maximum = Number.isSafeInteger(requestOptions.maxBytes) && requestOptions.maxBytes > 0
          ? Math.min(limits.maxImageResponseBytes, limits.maxApiResponseBytes, requestOptions.maxBytes)
          : route.isArtwork ? limits.maxImageResponseBytes : limits.maxApiResponseBytes;
        const upstream = await dispatchUpstream({
          request: { method: route.method, headers },
          body: Buffer.alloc(0),
          targetResolution: resolution,
          route,
          deviceOrigin: "http://127.0.0.1",
          targetRevision: connection.targetRevision,
          shutdownSignal: signal,
          limits: {
            ...limits,
            maxApiResponseBytes: maximum,
            maxImageResponseBytes: maximum,
            upstreamTimeoutMs: Number.isSafeInteger(requestOptions.timeoutMs)
              ? Math.min(limits.upstreamTimeoutMs, requestOptions.timeoutMs)
              : limits.upstreamTimeoutMs
          }
        });
        if (requestOptions.responseType === "buffer") {
          return {
            status: upstream.status,
            body: Buffer.isBuffer(upstream.body) ? Buffer.from(upstream.body) : Buffer.alloc(0),
            contentType: upstream.contentType
          };
        }
        const raw = Buffer.isBuffer(upstream.body) ? upstream.body.toString("utf8") : String(upstream.body ?? "");
        let body = raw;
        if (requestOptions.responseType === "json" && raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            // The probe boundary classifies malformed JSON without retaining it.
          }
        }
        return { status: upstream.status, body };
      };
      const publicProbe = isPublicProbe(service, route.upstreamPath)
        || (service === "seerr" && route.isArtwork);
      // These endpoints are intentionally public upstream probes. Never attach
      // a credential when the upstream does not require one.
      if (publicProbe) return send();
      return controlPlane.useServiceCredential(
        service,
        connection,
        (credential) => send(monitorCredentialHeaders(service, credential, connection))
      );
    } finally {
      release();
    }
  }

  const seerrSeriesSeasonCache = new Map();
  const seerrSeriesSeasonInFlight = new Map();
  const seerrSeriesSeasonEpochs = new Map();
  const SEERR_SERIES_SEASON_CACHE_TTL_MS = 30_000;
  const MAX_SEERR_SERIES_SEASON_CACHE_ENTRIES = 128;

  function seerrSeriesSeasonCacheKey(tmdbId, targetRevision) {
    return `${targetRevision}:${tmdbId}`;
  }

  function invalidateSeerrSeriesSeasonCache(tmdbId, targetRevision) {
    const key = seerrSeriesSeasonCacheKey(tmdbId, targetRevision);
    seerrSeriesSeasonCache.delete(key);
    const nextEpoch = (seerrSeriesSeasonEpochs.get(key) || 0) + 1;
    seerrSeriesSeasonEpochs.delete(key);
    seerrSeriesSeasonEpochs.set(key, nextEpoch);
    while (seerrSeriesSeasonEpochs.size > 2_048) {
      const oldest = [...seerrSeriesSeasonEpochs.keys()]
        .find((candidate) => !seerrSeriesSeasonInFlight.has(candidate));
      if (!oldest) break;
      seerrSeriesSeasonEpochs.delete(oldest);
    }
  }

  function pruneSeerrSeriesSeasonEpochs() {
    while (seerrSeriesSeasonEpochs.size > 2_048) {
      const oldest = [...seerrSeriesSeasonEpochs.keys()]
        .find((candidate) => !seerrSeriesSeasonInFlight.has(candidate));
      if (!oldest) break;
      seerrSeriesSeasonEpochs.delete(oldest);
    }
  }

  async function fetchSeerrSeriesSeasons(input = {}) {
    const tmdbId = input.tmdbId;
    const targetRevision = input.targetRevision;
    const useCache = input.cacheMode !== "bypass";
    const key = seerrSeriesSeasonCacheKey(tmdbId, targetRevision);
    if (!seerrSeriesSeasonEpochs.has(key)) {
      seerrSeriesSeasonEpochs.set(key, 0);
      pruneSeerrSeriesSeasonEpochs();
    }
    if (!useCache) invalidateSeerrSeriesSeasonCache(tmdbId, targetRevision);
    const fetchEpoch = seerrSeriesSeasonEpochs.get(key);
    if (useCache) {
      const cached = seerrSeriesSeasonCache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        seerrSeriesSeasonCache.delete(key);
        seerrSeriesSeasonCache.set(key, cached);
        return cached.value;
      }
      if (cached) seerrSeriesSeasonCache.delete(key);
      const waiting = seerrSeriesSeasonInFlight.get(key);
      if (waiting) return waiting;
      if (seerrSeriesSeasonInFlight.size >= MAX_SEERR_SERIES_SEASON_CACHE_ENTRIES) {
        throw new BrokerError(503, "BROKER_BUSY", "Too many series season lookups are already in progress.");
      }
    }

    const operation = (async () => {
      const response = await monitorRequest("seerr", `/api/v1/tv/${tmdbId}`, {
        method: "GET",
        responseType: "json",
        maxBytes: 512 * 1024,
        timeoutMs: Math.min(8_000, limits.upstreamTimeoutMs),
        targetRevision,
        signal: input.signal,
        credentialRequired: true,
        purpose: "series-seasons"
      });
      const status = Number(response?.status);
      if (status === 404) {
        throw new BrokerError(404, "MEDIA_SERIES_NOT_FOUND", "Seerr could not find that current series.");
      }
      if ([401, 403].includes(status)) {
        throw new BrokerError(502, "SERVICE_CREDENTIAL_REJECTED", "Seerr rejected the saved credential.");
      }
      if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
        throw new BrokerError(502, "UPSTREAM_RESPONSE_FAILED", "Seerr could not load seasons for that series.");
      }
      const normalized = normalizeSeerrSeriesSeasons(response.body, { tmdbId, targetRevision });
      if (!normalized) {
        throw new BrokerError(502, "UPSTREAM_RESPONSE_INVALID", "Seerr returned an invalid series season response.");
      }
      if (useCache && seerrSeriesSeasonEpochs.get(key) === fetchEpoch) {
        seerrSeriesSeasonCache.delete(key);
        seerrSeriesSeasonCache.set(key, {
          value: normalized,
          expiresAt: Date.now() + SEERR_SERIES_SEASON_CACHE_TTL_MS
        });
        while (seerrSeriesSeasonCache.size > MAX_SEERR_SERIES_SEASON_CACHE_ENTRIES) {
          const evictedKey = seerrSeriesSeasonCache.keys().next().value;
          seerrSeriesSeasonCache.delete(evictedKey);
          if (!seerrSeriesSeasonInFlight.has(evictedKey)) seerrSeriesSeasonEpochs.delete(evictedKey);
        }
      }
      return normalized;
    })();
    if (!useCache) return operation;
    seerrSeriesSeasonInFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (seerrSeriesSeasonInFlight.get(key) === operation) seerrSeriesSeasonInFlight.delete(key);
    }
  }

  async function dispatchJellyfinLogout({
    token,
    deviceId,
    targetResolution,
    targetRevision,
    reserveCapacity = true
  }) {
    const route = authorizeBridgeRoute("jellyfin", "POST", "/bridge/jellyfin/Sessions/Logout");
    if (!route.allowed || !route.internalOnly || route.isLogin) {
      throw new BrokerError(500, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin session logout is unavailable.");
    }
    let upstream = null;
    let release = null;
    const headers = { authorization: jellyfinAuthorization(token.toString("utf8"), deviceId) };
    try {
      if (reserveCapacity) release = reserveServiceCapacity("jellyfin");
      upstream = await dispatchUpstream({
        request: { method: route.method, headers },
        body: Buffer.alloc(0),
        targetResolution,
        route,
        deviceOrigin: "http://127.0.0.1",
        targetRevision,
        shutdownSignal: shutdownController.signal,
        limits: {
          ...limits,
          maxApiResponseBytes: Math.min(limits.maxApiResponseBytes, 64 * 1024),
          upstreamTimeoutMs: Math.min(limits.upstreamTimeoutMs, 5_000)
        }
      });
      return Number(upstream.status);
    } finally {
      headers.authorization = undefined;
      if (Buffer.isBuffer(upstream?.body)) upstream.body.fill(0);
      release?.();
    }
  }

  async function exchangeJellyfinLogin({
    targetResolution,
    targetRevision,
    login,
    deviceId,
    requireAdministrator = false
  }) {
    let body = null;
    let upstream = null;
    let release = null;
    let token = null;
    try {
      if (!Buffer.isBuffer(login?.username)
        || login.username.length < 1
        || login.username.length > 1024
        || !validJellyfinSecretBuffer(login.username)
        || !validJellyfinSecretBuffer(login.password)) {
        throw new BrokerError(
          requireAdministrator ? 401 : 400,
          requireAdministrator ? "JELLYFIN_AUTH_REJECTED" : "INVALID_LOGIN",
          requireAdministrator
            ? "Jellyfin did not accept that administrator sign-in."
            : "Enter a supported service account and password."
        );
      }
      const normalizedDeviceId = normalizedJellyfinDeviceId(deviceId);
      const route = authorizeBridgeRoute(
        "jellyfin",
        "POST",
        "/bridge/jellyfin/Users/AuthenticateByName"
      );
      if (!route.allowed || !route.isLogin || !route.internalOnly) {
        throw new BrokerError(500, "LOGIN_EXCHANGE_UNAVAILABLE", "The service sign-in route is unavailable.");
      }

      const payload = {
        Username: login.username.toString("utf8"),
        Pw: login.password.toString("utf8")
      };
      body = Buffer.from(JSON.stringify(payload), "utf8");
      payload.Username = undefined;
      payload.Pw = undefined;
      const headers = {
        "content-type": "application/json",
        authorization: jellyfinAuthorization(null, normalizedDeviceId)
      };

      release = reserveServiceCapacity("jellyfin");
      upstream = await dispatchUpstream({
        request: { method: route.method, headers },
        body,
        targetResolution,
        route,
        deviceOrigin: "http://127.0.0.1",
        targetRevision,
        shutdownSignal: shutdownController.signal,
        limits: { ...limits, maxApiResponseBytes: Math.min(limits.maxApiResponseBytes, 64 * 1024) }
      });
      const status = Number(upstream.status);
      if (status < 200 || status >= 300) {
        if ([400, 401, 403].includes(status)) {
          throw new BrokerError(
            401,
            requireAdministrator ? "JELLYFIN_AUTH_REJECTED" : "SERVICE_LOGIN_REJECTED",
            requireAdministrator
              ? "Jellyfin did not accept that administrator sign-in."
              : "Jellyfin did not accept that username and password."
          );
        }
        throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Jellyfin could not complete sign-in.");
      }

      let responseBody;
      try {
        const raw = Buffer.isBuffer(upstream.body)
          ? upstream.body.toString("utf8")
          : String(upstream.body ?? "");
        responseBody = JSON.parse(raw);
      } catch {
        throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Jellyfin returned an invalid sign-in response.");
      }
      token = takeJellyfinAccessToken(responseBody);
      if (!token) {
        throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Jellyfin did not return a usable access token.");
      }
      const identity = requireAdministrator ? parseJellyfinIdentity(responseBody) : null;
      if (requireAdministrator
        && (!identity || !identity.isAdministrator || identity.isDisabled)) {
        await dispatchJellyfinLogout({
          token,
          deviceId: normalizedDeviceId,
          targetResolution,
          targetRevision,
          reserveCapacity: false
        }).catch(() => {});
        throw new BrokerError(
          401,
          "JELLYFIN_AUTH_REJECTED",
          "Jellyfin did not accept that administrator sign-in."
        );
      }
      const result = { token, identity, deviceId: normalizedDeviceId };
      token = null;
      return result;
    } finally {
      token?.fill(0);
      body?.fill(0);
      if (Buffer.isBuffer(upstream?.body)) upstream.body.fill(0);
      login?.username?.fill?.(0);
      login?.password?.fill?.(0);
      release?.();
    }
  }

  async function configuredJellyfinTarget() {
    const state = store.snapshot();
    const connection = state.connections.jellyfin;
    if (!connection) {
      throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin sign-in is not configured.");
    }
    let targetResolution;
    try {
      targetResolution = await resolveAndAuthorizeTarget(connection.url, state.policy, {
        lookup,
        approvedHostCidrs: connection.approvedHostCidrs || []
      });
    } catch (error) {
      if (error instanceof NetworkPolicyError) {
        throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "The configured Jellyfin server is unavailable.");
      }
      throw error;
    }
    const boundary = connectionAuthorizationBoundaryHash(connection, state.policy);
    if (!jellyfinBoundaryIsCurrent(boundary)) {
      throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "The Jellyfin connection changed; try again.");
    }
    return { boundary, connection, targetResolution };
  }

  function jellyfinBoundaryIsCurrent(boundary) {
    const current = store.snapshot();
    const connection = current.connections.jellyfin;
    if (!connection) return false;
    try {
      return connectionAuthorizationBoundaryHash(connection, current.policy) === boundary;
    } catch {
      return false;
    }
  }

  async function authenticateJellyfinBrowser({ username, password, deviceId } = {}) {
    const login = { username, password };
    try {
      const { boundary, connection, targetResolution } = await configuredJellyfinTarget();
      const result = await exchangeJellyfinLogin({
        targetResolution,
        targetRevision: connection.targetRevision,
        login,
        deviceId,
        requireAdministrator: true
      });
      if (!jellyfinBoundaryIsCurrent(boundary)) {
        await dispatchJellyfinLogout({
          token: result.token,
          deviceId: result.deviceId,
          targetResolution,
          targetRevision: connection.targetRevision
        }).catch(() => {});
        result.token.fill(0);
        throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "The Jellyfin connection changed; try again.");
      }
      return {
        token: result.token,
        deviceId: result.deviceId,
        jellyfinUrl: connection.url,
        targetRevision: connection.targetRevision,
        boundaryHash: boundary,
        revokeAtBoundary: async (token) => {
          if (!validJellyfinSecretBuffer(token)) return { revoked: true };
          const status = await dispatchJellyfinLogout({
            token,
            deviceId: result.deviceId,
            targetResolution,
            targetRevision: connection.targetRevision
          });
          if ((status >= 200 && status < 300) || [401, 403].includes(status)) return { revoked: true };
          throw new BrokerError(502, "JELLYFIN_LOGOUT_FAILED", "Jellyfin could not complete session logout.");
        },
        identity: result.identity
      };
    } finally {
      username?.fill?.(0);
      password?.fill?.(0);
    }
  }

  async function validateJellyfinBrowserToken({ token, deviceId, boundaryHash } = {}) {
    if (!validJellyfinSecretBuffer(token)) {
      throw new BrokerError(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin sign-in is no longer valid.");
    }
    if (typeof boundaryHash !== "string" || !SHA256_FINGERPRINT.test(boundaryHash)) {
      throw new BrokerError(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin sign-in boundary is invalid.");
    }
    const normalizedDeviceId = normalizedJellyfinDeviceId(deviceId);
    const { boundary, connection, targetResolution } = await configuredJellyfinTarget();
    if (boundary !== boundaryHash) {
      throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "The Jellyfin connection changed; sign in again.");
    }
    const route = authorizeBridgeRoute("jellyfin", "GET", "/bridge/jellyfin/Users/Me");
    if (!route.allowed || !route.internalOnly || route.isLogin) {
      throw new BrokerError(500, "JELLYFIN_AUTH_UNAVAILABLE", "Jellyfin session validation is unavailable.");
    }
    let upstream = null;
    let release = null;
    const headers = { authorization: jellyfinAuthorization(token.toString("utf8"), normalizedDeviceId) };
    try {
      release = reserveServiceCapacity("jellyfin");
      upstream = await dispatchUpstream({
        request: { method: route.method, headers },
        body: Buffer.alloc(0),
        targetResolution,
        route,
        deviceOrigin: "http://127.0.0.1",
        targetRevision: connection.targetRevision,
        shutdownSignal: shutdownController.signal,
        limits: { ...limits, maxApiResponseBytes: Math.min(limits.maxApiResponseBytes, 64 * 1024) }
      });
      if (!jellyfinBoundaryIsCurrent(boundary)) {
        throw new BrokerError(503, "JELLYFIN_AUTH_UNAVAILABLE", "The Jellyfin connection changed; try again.");
      }
      const status = Number(upstream.status);
      if ([400, 401, 403].includes(status)) {
        throw new BrokerError(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin sign-in is no longer valid.");
      }
      if (status < 200 || status >= 300) {
        throw new BrokerError(502, "JELLYFIN_AUTH_VALIDATION_FAILED", "Jellyfin could not validate this sign-in.");
      }
      let responseBody;
      try {
        const raw = Buffer.isBuffer(upstream.body)
          ? upstream.body.toString("utf8")
          : String(upstream.body ?? "");
        responseBody = JSON.parse(raw);
      } catch {
        throw new BrokerError(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin sign-in is no longer valid.");
      }
      const identity = parseJellyfinIdentity(responseBody);
      if (!identity || !identity.isAdministrator || identity.isDisabled) {
        throw new BrokerError(401, "JELLYFIN_AUTH_REJECTED", "The Jellyfin sign-in is no longer valid.");
      }
      return {
        jellyfinUrl: connection.url,
        targetRevision: connection.targetRevision,
        boundaryHash: boundary,
        identity
      };
    } finally {
      headers.authorization = undefined;
      if (Buffer.isBuffer(upstream?.body)) upstream.body.fill(0);
      release?.();
    }
  }

  async function revokeJellyfinBrowserToken({ token, deviceId, boundaryHash } = {}) {
    if (!validJellyfinSecretBuffer(token)) {
      return { revoked: true };
    }
    if (typeof boundaryHash !== "string" || !SHA256_FINGERPRINT.test(boundaryHash)) {
      throw new BrokerError(503, "JELLYFIN_LOGOUT_FAILED", "The Jellyfin sign-in boundary is unavailable.");
    }
    const normalizedDeviceId = normalizedJellyfinDeviceId(deviceId);
    const { boundary, connection, targetResolution } = await configuredJellyfinTarget();
    if (boundary !== boundaryHash) {
      throw new BrokerError(503, "JELLYFIN_LOGOUT_FAILED", "The Jellyfin connection changed before logout.");
    }
    const status = await dispatchJellyfinLogout({
      token,
      deviceId: normalizedDeviceId,
      targetResolution,
      targetRevision: connection.targetRevision
    });
    if ((status >= 200 && status < 300) || [401, 403].includes(status)) {
      return { revoked: true };
    }
    throw new BrokerError(502, "JELLYFIN_LOGOUT_FAILED", "Jellyfin could not complete session logout.");
  }

  async function exchangeServiceLogin({ service: serviceValue, targetResolution, targetRevision, login }) {
    const service = canonicalServiceId(serviceValue);
    if (!["jellyfin", "seerr"].includes(service)
      || !Buffer.isBuffer(login?.username)
      || !Buffer.isBuffer(login?.password)) {
      throw new BrokerError(400, "INVALID_LOGIN", "Enter a supported service account and password.");
    }
    if (service === "jellyfin") {
      const result = await exchangeJellyfinLogin({
        targetResolution,
        targetRevision,
        login,
        deviceId: store.snapshot().instanceId
      });
      return result.token;
    }

    const route = authorizeBridgeRoute("seerr", "POST", "/bridge/seerr/api/v1/auth/local");
    if (!route.allowed || !route.isLogin) {
      throw new BrokerError(500, "LOGIN_EXCHANGE_UNAVAILABLE", "The service sign-in route is unavailable.");
    }
    const payload = {
      email: login.username.toString("utf8"),
      password: login.password.toString("utf8")
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    payload.email = undefined;
    payload.password = undefined;
    const headers = { "content-type": "application/json" };
    const release = reserveServiceCapacity("seerr");
    let upstream = null;
    try {
      upstream = await dispatchUpstream({
        request: { method: route.method, headers },
        body,
        targetResolution,
        route,
        deviceOrigin: "http://127.0.0.1",
        targetRevision,
        shutdownSignal: shutdownController.signal,
        limits: { ...limits, maxApiResponseBytes: Math.min(limits.maxApiResponseBytes, 64 * 1024) }
      });
      const status = Number(upstream.status);
      if (status < 200 || status >= 300) {
        if ([400, 401, 403].includes(status)) {
          throw new BrokerError(401, "SERVICE_LOGIN_REJECTED", "Seerr did not accept that local account email and password.");
        }
        throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "The service could not complete sign-in.");
      }
      if (!upstream.loginSession) {
        throw new BrokerError(502, "LOGIN_EXCHANGE_FAILED", "Seerr did not return a usable sign-in session.");
      }
      const wrapped = wrapUpstreamSession(upstream.loginSession.name, upstream.loginSession.value);
      // Validate the exact representation that will be encrypted at rest.
      unwrapUpstreamSession("seerr", wrapped);
      return Buffer.from(wrapped, "utf8");
    } finally {
      body.fill(0);
      if (Buffer.isBuffer(upstream?.body)) upstream.body.fill(0);
      login.username.fill(0);
      login.password.fill(0);
      release();
    }
  }

  async function testDraftServiceConnection({
    service: serviceValue,
    target,
    credential,
    login,
    authMode,
    approvedHostCidrs
  }) {
    const service = canonicalServiceId(serviceValue);
    if (!service) throw new BrokerError(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    if ((!Buffer.isBuffer(credential) || credential.length < 1) && !login) {
      throw new BrokerError(400, "INVALID_CREDENTIAL", "Enter a valid service credential.");
    }

    // Resolve and authorize the draft target once, then pin every capability
    // request to that approved address. The draft URL and credential never
    // enter state, the credential store, monitor events, or application logs.
    const state = store.snapshot();
    const resolution = approvedHostCidrs === undefined
      ? await resolveAndAuthorizeExplicitTarget(target, state.policy, { lookup })
      : await resolveAndAuthorizeTarget(target, state.policy, { lookup, approvedHostCidrs });
    const testRevision = randomUUID();
    let derivedCredential = null;
    const testConnection = { authMode, targetRevision: testRevision };
    if (login) {
      derivedCredential = await exchangeServiceLogin({
        service,
        targetResolution: resolution,
        targetRevision: testRevision,
        login
      });
    }
    const effectiveCredential = derivedCredential || credential;
    const requestDraft = async (_service, upstreamPath, requestOptions = {}) => {
      const bridgeName = service === "qbittorrent" ? "qbit" : service;
      const route = authorizeBridgeRoute(service, requestOptions.method || "GET", `/bridge/${bridgeName}${upstreamPath}`);
      if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
      if (route.method !== "GET") {
        throw new BrokerError(405, "METHOD_NOT_ALLOWED", "Connection tests are read-only.");
      }
      const release = reserveServiceCapacity(service);
      try {
        const publicProbe = isPublicProbe(service, route.upstreamPath);
        const headers = publicProbe ? {} : monitorCredentialHeaders(service, effectiveCredential, testConnection);
        const signal = requestOptions.signal
          ? AbortSignal.any([shutdownController.signal, requestOptions.signal])
          : shutdownController.signal;
        const maximum = Number.isSafeInteger(requestOptions.maxBytes) && requestOptions.maxBytes > 0
          ? Math.min(limits.maxApiResponseBytes, requestOptions.maxBytes)
          : limits.maxApiResponseBytes;
        const upstream = await dispatchUpstream({
          request: { method: route.method, headers },
          body: Buffer.alloc(0),
          targetResolution: resolution,
          route,
          deviceOrigin: "http://127.0.0.1",
          targetRevision: testRevision,
          shutdownSignal: signal,
          limits: { ...limits, maxApiResponseBytes: maximum }
        });
        const raw = Buffer.isBuffer(upstream.body) ? upstream.body.toString("utf8") : String(upstream.body ?? "");
        let parsed = raw;
        if (requestOptions.responseType === "json" && raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            // The probe sanitizer reports INVALID_RESPONSE without retaining
            // or reflecting the rejected upstream body.
          }
        }
        return { status: upstream.status, body: parsed };
      } finally {
        release();
      }
    };

    try {
      return await probeService(service, requestDraft, {
        timeoutMs: Math.min(10_000, limits.upstreamTimeoutMs)
      });
    } finally {
      derivedCredential?.fill(0);
    }
  }

  async function runProxmoxProbe({
    target,
    targetResolution,
    targetRevision,
    tlsMode,
    certificateFingerprint,
    credentials,
    approvedHostCidrs,
    signal,
    checkedAt,
    scope = "environment"
  }) {
    const state = store.snapshot();
    const parsedTarget = typeof target === "string" ? parseServiceUrl(target) : target;
    if (!parsedTarget || parsedTarget.protocol !== "https:") {
      throw new BrokerError(400, "HTTPS_REQUIRED", "Proxmox infrastructure targets must use HTTPS.");
    }
    const resolution = targetResolution || await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
      lookup,
      approvedHostCidrs: approvedHostCidrs || []
    });
    const capacityKey = `proxmox:${String(target?.id || targetRevision || "draft").slice(0, 80)}`;
    const requestProxmox = async (routeId, requestOptions = {}) => {
      const route = authorizeProxmoxRoute(routeId, requestOptions.method || "GET", {
        node: requestOptions.node
      });
      if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
      const release = reserveServiceCapacity(capacityKey);
      try {
        const combinedSignal = requestOptions.signal
          ? AbortSignal.any([shutdownController.signal, requestOptions.signal])
          : shutdownController.signal;
        const maximum = Number.isSafeInteger(requestOptions.maxBytes) && requestOptions.maxBytes > 0
          ? Math.min(limits.maxApiResponseBytes, requestOptions.maxBytes)
          : limits.maxApiResponseBytes;
        const upstream = await dispatchProxmox({
          targetResolution: resolution,
          route,
          credentials,
          tlsMode,
          certificateFingerprint,
          shutdownSignal: combinedSignal,
          limits: {
            ...limits,
            maxApiResponseBytes: maximum,
            upstreamTimeoutMs: Number.isSafeInteger(requestOptions.timeoutMs)
              ? Math.min(limits.upstreamTimeoutMs, requestOptions.timeoutMs)
              : limits.upstreamTimeoutMs
          }
        });
        const raw = Buffer.isBuffer(upstream?.body)
          ? upstream.body.toString("utf8")
          : String(upstream?.body ?? "");
        let body = raw;
        if (requestOptions.responseType === "json" && raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            // The Proxmox probe boundary classifies malformed JSON without
            // retaining or reflecting the rejected upstream body.
          }
        }
        return { status: upstream?.status, body };
      } finally {
        release();
      }
    };
    const runProbe = scope === "endpoint" ? probeProxmoxEndpoint : probeProxmox;
    return runProbe(requestProxmox, {
      signal,
      checkedAt,
      timeoutMs: Math.min(10_000, limits.upstreamTimeoutMs),
      historyConcurrency: Math.max(1, Math.min(4, limits.maxPerService, limits.maxConcurrent))
    });
  }

  async function runPortainerProbe({
    target,
    targetResolution,
    targetRevision,
    tlsMode,
    certificateFingerprint,
    credentials,
    approvedHostCidrs,
    signal,
    checkedAt
  }) {
    const state = store.snapshot();
    const parsedTarget = typeof target === "string" ? parseServiceUrl(target) : target;
    if (!parsedTarget || parsedTarget.protocol !== "https:") {
      throw new BrokerError(400, "HTTPS_REQUIRED", "Portainer infrastructure services must use HTTPS.");
    }
    const resolution = targetResolution || await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
      lookup,
      approvedHostCidrs: approvedHostCidrs || []
    });
    const capacityKey = `portainer:${String(targetRevision || "draft").slice(0, 80)}`;
    const requestPortainer = async (routeId, requestOptions = {}) => {
      const route = authorizePortainerRoute(routeId, requestOptions.method || "GET", {
        endpointId: requestOptions.endpointId,
        start: requestOptions.start
      });
      if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
      const release = reserveServiceCapacity(capacityKey);
      try {
        const combinedSignal = requestOptions.signal
          ? AbortSignal.any([shutdownController.signal, requestOptions.signal])
          : shutdownController.signal;
        const maximum = Number.isSafeInteger(requestOptions.maxBytes) && requestOptions.maxBytes > 0
          ? Math.min(limits.maxApiResponseBytes, requestOptions.maxBytes)
          : limits.maxApiResponseBytes;
        const upstream = await dispatchPortainer({
          targetResolution: resolution,
          route,
          credentials,
          targetRevision,
          tlsMode,
          certificateFingerprint,
          shutdownSignal: combinedSignal,
          limits: {
            ...limits,
            maxApiResponseBytes: maximum,
            upstreamTimeoutMs: Number.isSafeInteger(requestOptions.timeoutMs)
              ? Math.min(limits.upstreamTimeoutMs, requestOptions.timeoutMs)
              : limits.upstreamTimeoutMs
          }
        });
        const raw = Buffer.isBuffer(upstream?.body)
          ? upstream.body.toString("utf8")
          : String(upstream?.body ?? "");
        let body = raw;
        if (requestOptions.responseType === "json" && raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            // The probe sanitizer reports INVALID_RESPONSE without retaining
            // or reflecting an untrusted upstream body.
          }
        }
        return { status: upstream?.status, body };
      } finally {
        release();
      }
    };
    return probePortainer(requestPortainer, {
      signal,
      checkedAt,
      timeoutMs: Math.min(10_000, limits.upstreamTimeoutMs),
      // The operations monitor probes at most four Portainer servers in
      // parallel. One environment call per server reserves half of the default
      // global request budget for interactive and unrelated broker work.
      containerConcurrency: 1
    });
  }

  async function requestLoki({
    target,
    targetResolution,
    targetRevision,
    authMode,
    tenantId,
    tlsMode,
    certificateFingerprint,
    credentials,
    approvedHostCidrs,
    signal
  }, routeId, parameters = {}, requestOptions = {}) {
    const state = store.snapshot();
    const parsedTarget = typeof target === "string" ? parseServiceUrl(target) : target;
    if (!parsedTarget || !["http:", "https:"].includes(parsedTarget.protocol)) {
      throw new BrokerError(400, "INVALID_TARGET", "Enter one Loki HTTP or HTTPS URL.");
    }
    const resolution = targetResolution || await resolveAndAuthorizeTarget(parsedTarget, state.policy, {
      lookup,
      approvedHostCidrs: approvedHostCidrs || []
    });
    const route = authorizeLokiRoute(routeId, "GET", parameters);
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    const release = reserveServiceCapacity(`loki:${String(targetRevision || "draft").slice(0, 80)}`);
    try {
      const combinedSignal = signal
        ? AbortSignal.any([shutdownController.signal, signal])
        : shutdownController.signal;
      return await dispatchLoki({
        targetResolution: resolution,
        route,
        credentials,
        authMode,
        tenantId,
        tlsMode,
        certificateFingerprint,
        limits: {
          maxApiResponseBytes: Math.min(
            2 * 1024 * 1024,
            Number.isSafeInteger(requestOptions.maxBytes) && requestOptions.maxBytes > 0
              ? requestOptions.maxBytes
              : limits.maxApiResponseBytes
          ),
          upstreamTimeoutMs: Math.min(
            15_000,
            Number.isSafeInteger(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0
              ? requestOptions.timeoutMs
              : limits.upstreamTimeoutMs
          )
        },
        shutdownSignal: combinedSignal,
        version: VERSION
      });
    } finally {
      release();
    }
  }

  async function runLokiProbe({
    target,
    targetResolution,
    targetRevision,
    authMode,
    tenantId,
    tlsMode,
    certificateFingerprint,
    credentials,
    approvedHostCidrs,
    signal
  }) {
    const context = {
      target,
      targetResolution,
      targetRevision,
      authMode,
      tenantId,
      tlsMode,
      certificateFingerprint,
      credentials,
      approvedHostCidrs,
      signal
    };
    return probeLoki(
      async (routeId, parameters = {}) => {
        const upstream = await requestLoki(context, routeId, parameters, {
          maxBytes: routeId === "ready" ? 4 * 1024 : 128 * 1024,
          timeoutMs: 10_000
        });
        const body = Buffer.isBuffer(upstream?.body)
          ? upstream.body.toString("utf8")
          : upstream?.body;
        return { status: upstream?.status, body };
      },
      { checkedAt: new Date().toISOString() }
    );
  }

  async function executeLokiRead(input) {
    if (!input || input.service?.type !== "loki" || input.routeId !== "queryRange") {
      throw new BrokerError(400, "INFRASTRUCTURE_SERVICE_TYPE_NOT_SUPPORTED", "That Loki read operation is not supported.");
    }
    const routeParameters = { queryInput: input.parameters };
    const upstream = await requestLoki({
      target: input.target,
      targetResolution: input.targetResolution,
      targetRevision: input.service.targetRevision,
      authMode: input.service.authMode,
      tenantId: input.service.tenantId,
      tlsMode: input.service.tlsMode,
      certificateFingerprint: input.service.certificateFingerprint,
      credentials: input.credentials,
      approvedHostCidrs: input.service.approvedHostCidrs || []
    }, "queryRange", routeParameters, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 });
    const status = Number(upstream?.status);
    if ([401, 403].includes(status)) {
      throw new BrokerError(502, "LOKI_AUTHENTICATION_FAILED", "Loki rejected the saved read credential or tenant.");
    }
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new BrokerError(502, "LOKI_QUERY_FAILED", "Loki did not complete the read-only log query.");
    }
    let payload;
    try {
      const raw = Buffer.isBuffer(upstream.body) ? upstream.body.toString("utf8") : String(upstream.body ?? "");
      payload = JSON.parse(raw);
    } catch {
      throw new BrokerError(502, "LOKI_RESPONSE_INVALID", "Loki returned malformed query data.");
    }
    let normalized;
    try {
      normalized = normalizeLokiQueryResult(payload, {
        direction: input.parameters.direction,
        limit: input.parameters.limit
      });
    } catch {
      throw new BrokerError(502, "LOKI_RESPONSE_INVALID", "Loki returned an unsupported log-query response.");
    }
    return {
      entries: normalized.entries,
      truncated: normalized.truncated,
      stats: {
        totalLinesProcessed: normalized.entries.length,
        totalBytesProcessed: null,
        execTimeMs: null
      }
    };
  }

  async function testDraftInfrastructureConnection(input) {
    if (!input || input.type !== "proxmox") {
      throw new BrokerError(400, "INFRASTRUCTURE_TYPE_NOT_SUPPORTED", "That infrastructure target type is not supported.");
    }
    return runProxmoxProbe(input);
  }

  async function testDraftInfrastructureServiceConnection(input) {
    if (!input || !["portainer", "loki"].includes(input.type)) {
      throw new BrokerError(400, "INFRASTRUCTURE_SERVICE_TYPE_NOT_SUPPORTED", "That infrastructure service type is not supported.");
    }
    return input.type === "loki" ? runLokiProbe(input) : runPortainerProbe(input);
  }

  function acceptedActionStatus(upstream, provider, options = {}) {
    const status = Number(upstream?.status);
    if (Number.isSafeInteger(status) && status >= 200 && status < 300) {
      return { status, noOp: false };
    }
    if (provider === "portainer" && options.allowNotModified === true && status === 304) {
      return { status, noOp: true };
    }
    if ([404, 409].includes(status)) {
      throw new BrokerError(409, "ACTION_TARGET_CHANGED", `The ${provider} resource changed; refresh it before trying again.`);
    }
    if ([401, 403].includes(status)) {
      throw new BrokerError(502, "ACTION_PERMISSION_DENIED", `${provider} rejected the saved credential for this action.`);
    }
    throw new BrokerError(502, "UPSTREAM_ACTION_FAILED", `${provider} did not accept the requested action.`);
  }

  async function executePortainerContainerAction(input) {
    const route = authorizePortainerContainerAction(input?.operation, {
      endpointId: input?.environmentId,
      containerId: input?.containerId
    });
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    const release = reserveServiceCapacity(`portainer:${input.service.id}`);
    try {
      const upstream = await dispatchPortainer({
        targetResolution: input.targetResolution,
        route,
        credentials: input.credentials,
        targetRevision: input.service.targetRevision,
        tlsMode: input.service.tlsMode,
        certificateFingerprint: input.service.certificateFingerprint,
        limits,
        shutdownSignal: shutdownController.signal
      });
      const accepted = acceptedActionStatus(upstream, "portainer", {
        allowNotModified: route.operation === "start" || route.operation === "stop"
      });
      return {
        ok: true,
        provider: "portainer",
        operation: route.operation,
        serviceId: input.service.id,
        environmentId: route.endpointId,
        containerId: route.containerId,
        providerStatus: accepted.status,
        noOp: accepted.noOp
      };
    } catch (error) {
      throw actionDispatchError(error, "Portainer");
    } finally {
      release();
    }
  }

  async function executeProxmoxWorkloadAction(input) {
    const route = authorizeProxmoxWorkloadAction(input?.operation, {
      node: input?.node,
      type: input?.type,
      vmid: input?.vmid
    });
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    const release = reserveServiceCapacity(`proxmox:${input.environment.id}`);
    try {
      const upstream = await dispatchProxmox({
        targetResolution: input.targetResolution,
        route,
        credentials: input.credentials,
        tlsMode: input.endpoint.tlsMode,
        certificateFingerprint: input.endpoint.certificateFingerprint,
        limits,
        shutdownSignal: shutdownController.signal
      });
      const accepted = acceptedActionStatus(upstream, "proxmox");
      if (!validProxmoxActionAcknowledgement(upstream?.body)) {
        throw new BrokerError(502, "UPSTREAM_RESPONSE_INVALID", "Proxmox did not return a valid task acknowledgement.");
      }
      // The upstream task ID is deliberately verified but not exposed. It can
      // contain node/user details and is not needed by the browser to refresh.
      return {
        ok: true,
        provider: "proxmox",
        operation: route.operation,
        environmentId: input.environment.id,
        node: route.node,
        type: route.type,
        vmid: route.vmid,
        providerStatus: accepted.status
      };
    } catch (error) {
      throw actionDispatchError(error, "Proxmox");
    } finally {
      release();
    }
  }

  async function executeMediaRecoveryAction(input) {
    const route = authorizeMediaAction(input?.operation, {
      service: input?.serviceId,
      resourceId: input?.resourceId,
      queueId: input?.queueId,
      seasonNumbers: input?.seasonNumbers
    });
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    const release = reserveServiceCapacity(route.service);
    try {
      const upstream = await dispatchMediaAction({
        targetResolution: input.targetResolution,
        route,
        credentialHeaders: monitorCredentialHeaders(route.service, input.credential, input.connection),
        targetRevision: input.connection.targetRevision,
        limits,
        shutdownSignal: shutdownController.signal
      });
      const accepted = route.operation === "requestSeasons"
        ? acceptedSeerrSeasonRequestStatus(upstream, route.seasonNumbers)
        : acceptedActionStatus(upstream, route.service);
      return {
        ok: true,
        provider: route.service,
        operation: route.operation,
        ...(route.queueId ? { queueId: route.queueId } : { resourceId: route.resourceId }),
        ...(route.seasonNumbers ? { seasonNumbers: route.seasonNumbers } : {}),
        providerStatus: accepted.status
      };
    } catch (error) {
      throw actionDispatchError(error, route.service);
    } finally {
      if (route.operation === "requestSeasons") {
        invalidateSeerrSeriesSeasonCache(route.resourceId, input.connection.targetRevision);
      }
      release();
    }
  }

  const seerrRequestMetadata = createSeerrRequestMetadataEnricher({
    fetchDetail: async (candidate, context) => {
      const type = candidate.mediaType === "movie" ? "movie" : "tv";
      const response = await monitorRequest("seerr", `/api/v1/${type}/${candidate.tmdbId}`, {
        method: "GET",
        responseType: "json",
        maxBytes: 512 * 1024,
        timeoutMs: Math.min(context.timeoutMs, limits.upstreamTimeoutMs),
        targetRevision: context.targetRevision,
        signal: context.signal,
        checkId: "requestMetadata",
        credentialRequired: true,
        credentialProof: false,
        purpose: "request-metadata"
      });
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        throw new BrokerError(response.status, "REQUEST_METADATA_RETRY", "Seerr request metadata is temporarily unavailable.");
      }
      return response.status >= 200 && response.status < 300 ? response.body : null;
    },
    signal: shutdownController.signal
  });

  const mediaArtwork = createMediaArtworkCache({
    revisionFor: (source) => {
      const connection = store.snapshot().connections[source.service];
      return connection?.monitoringEnabled === false ? "" : connection?.targetRevision || "";
    },
    fetchSource: (source, context) => monitorRequest(source.service, context.path, {
      method: "GET",
      responseType: "buffer",
      maxBytes: context.phase === "metadata"
        ? MEDIA_ARTWORK_LIMITS.maximumMetadataBytes
        : MEDIA_ARTWORK_LIMITS.maximumArtworkBytes,
      timeoutMs: Math.min(8_000, limits.upstreamTimeoutMs),
      targetRevision: context.targetRevision,
      signal: context.signal
    }),
    fetchSignal: shutdownController.signal,
    persistentStore: persistentCache?.artwork
  });

  controlPlane = await createControlPlane({
    stateStore: store,
    dataDir,
    version: VERSION,
    lookup,
    log,
    testServiceConnection: testDraftServiceConnection,
    testInfrastructureConnection: testDraftInfrastructureConnection,
    testInfrastructureServiceConnection: testDraftInfrastructureServiceConnection,
    executeLokiRead,
    eventJournal,
    executePortainerContainerAction,
    executeProxmoxWorkloadAction,
    executeMediaRecoveryAction,
    fetchSeerrSeriesSeasons,
    fetchMediaArtwork: (descriptor, context = {}) => mediaArtwork.get(descriptor, { signal: context.signal }),
    exchangeServiceLogin,
    authenticateJellyfinBrowser,
    validateJellyfinBrowserToken,
    revokeJellyfinBrowserToken,
    stateGuard: options.stateGuard,
    keyFilePath: options.keyFilePath
      ?? process.env.HELMSMAN_MASTER_KEY_FILE
      ?? process.env.JELLOFIN_COMMAND_MASTER_KEY_FILE
  });
  const incidentEngine = createHealthIncidentEngine({
    failureThreshold: 2,
    staleAfterMs: 5 * 60_000,
    onTransition: (transition) => recordEvent({
      at: transition.at,
      level: transition.type === "recovered"
        ? "info"
        : ["down", "degraded", "auth_required"].includes(transition.state) ? "error" : "warn",
      category: "health",
      event: "health_incident",
      outcome: transition.type === "recovered" ? "recovered" : "changed",
      service: transition.service,
      capability: transition.capability,
      code: transition.code || undefined,
      httpStatus: transition.status ?? undefined,
      targetType: "incident",
      targetId: transition.incidentId
    })
  });

  function configuredProxmoxEndpoints(target) {
    if (Array.isArray(target?.endpoints) && target.endpoints.length) return target.endpoints;
    return [{
      id: target.id,
      label: "Primary endpoint",
      url: target.url,
      targetRevision: target.targetRevision,
      enabled: true,
      tlsMode: target.tlsMode,
      certificateFingerprint: target.certificateFingerprint,
      approvedHostCidrs: target.approvedHostCidrs || []
    }];
  }

  function endpointFailure(error, endpoint, checkedAt) {
    const safe = asBrokerError(error);
    const authRequired = safe.code === "CREDENTIAL_NOT_CONFIGURED"
      || safe.code === "AUTH_REQUIRED"
      || safe.status === 401
      || safe.status === 403;
    return {
      id: endpoint.id,
      label: endpoint.label || "Proxmox endpoint",
      state: authRequired ? "auth_required" : "down",
      connectionState: authRequired ? "auth_required" : "down",
      latencyMs: null,
      checkedAt,
      version: null,
      code: safe.code || "ENDPOINT_UNAVAILABLE",
      discovery: null
    };
  }

  function discoveryIdentity(discovery) {
    if (!discovery || !["cluster", "standalone"].includes(discovery.kind)) return null;
    const name = discovery.kind === "cluster"
      ? discovery.clusterName
      : discovery.name || discovery.nodeNames?.[0];
    if (typeof name !== "string" || !name.trim()) return null;
    return `${discovery.kind}:${name.trim().toLowerCase()}`;
  }

  function configuredEnvironmentIdentity(identity) {
    if (!identity || !["cluster", "standalone"].includes(identity.kind)) return null;
    if (typeof identity.name !== "string" || !identity.name.trim()) return null;
    return `${identity.kind}:${identity.name.trim().toLowerCase()}`;
  }

  function persistedDiscoveryIdentity(discovery) {
    if (!discovery || !["cluster", "standalone"].includes(discovery.kind)) return null;
    const rawName = discovery.kind === "cluster"
      ? discovery.clusterName
      : discovery.name || discovery.nodeNames?.[0];
    if (typeof rawName !== "string") return null;
    const name = rawName.trim();
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) return null;
    return { kind: discovery.kind, name };
  }

  async function probeProxmoxEnvironment(environment, context) {
    const checkedAt = context.checkedAt;
    const endpoints = configuredProxmoxEndpoints(environment);
    const endpointResults = await Promise.all(endpoints.map(async (endpoint) => {
      if (endpoint.enabled === false) {
        return {
          id: endpoint.id,
          label: endpoint.label || "Proxmox endpoint",
          state: "stale",
          connectionState: "unverified",
          latencyMs: null,
          checkedAt,
          version: null,
          code: null,
          discovery: null,
          disabled: true
        };
      }
      try {
        const result = await controlPlane.useInfrastructureCredentials(
          environment.id,
          environment,
          (credentials) => runProxmoxProbe({
            target: parseServiceUrl(endpoint.url),
            targetRevision: endpoint.targetRevision,
            tlsMode: endpoint.tlsMode,
            certificateFingerprint: endpoint.certificateFingerprint,
            credentials,
            approvedHostCidrs: endpoint.approvedHostCidrs || [],
            signal: context.signal,
            checkedAt,
            scope: "endpoint"
          }),
          endpoint.id
        );
        const failedCheck = result.checks?.find(({ ok }) => !ok);
        return {
          id: endpoint.id,
          label: endpoint.label || "Proxmox endpoint",
          state: result.connectionState === "connected" ? "healthy" : result.state,
          connectionState: result.connectionState,
          latencyMs: result.latencyMs,
          checkedAt: result.checkedAt,
          version: result.version,
          code: failedCheck?.code || null,
          discovery: result.discovery || null
        };
      } catch (error) {
        return endpointFailure(error, endpoint, checkedAt);
      }
    }));

    const primaryId = environment.primaryEndpointId || environment.id;
    endpointResults.sort((left, right) => (
      Number(right.id === primaryId) - Number(left.id === primaryId)
      || endpoints.findIndex(({ id }) => id === left.id) - endpoints.findIndex(({ id }) => id === right.id)
    ));
    const usable = endpointResults.filter(({ connectionState, disabled }) => connectionState === "connected" && !disabled);
    const canonicalIdentity = configuredEnvironmentIdentity(environment.environmentIdentity)
      || usable.map(({ discovery }) => discoveryIdentity(discovery)).find(Boolean)
      || null;
    for (const endpoint of usable) {
      const identity = discoveryIdentity(endpoint.discovery);
      if (canonicalIdentity && identity !== canonicalIdentity) {
        endpoint.state = "degraded";
        endpoint.code = "ENVIRONMENT_IDENTITY_MISMATCH";
      }
    }
    const eligible = usable.filter(({ code }) => code !== "ENVIRONMENT_IDENTITY_MISMATCH");
    if (!eligible.length) {
      const allAuth = endpointResults.some(({ disabled }) => !disabled)
        && endpointResults.filter(({ disabled }) => !disabled).every(({ connectionState }) => connectionState === "auth_required");
      const state = allAuth ? "auth_required" : "down";
      return {
        schema: 2,
        type: "proxmox",
        state,
        connectionState: allAuth ? "auth_required" : "down",
        checkedAt,
        latencyMs: 0,
        version: null,
        checks: endpointResults.filter(({ disabled }) => !disabled).map((endpoint) => ({
          id: `endpoint-${endpoint.id}`,
          label: endpoint.label,
          ok: false,
          state,
          importance: "critical",
          code: endpoint.code || "ENDPOINT_UNAVAILABLE",
          latencyMs: endpoint.latencyMs,
          metrics: {},
          reports: []
        })),
        metrics: {},
        endpoints: endpointResults,
        discovery: usable[0]?.discovery || { kind: "unknown", name: environment.displayName, nodeNames: [] }
      };
    }

    const selectedEndpoint = eligible[0];
    let inventoryResult = null;
    const inventoryEndpoint = endpoints.find(({ id }) => id === selectedEndpoint.id);
    try {
      const result = await controlPlane.useInfrastructureCredentials(
        environment.id,
        environment,
        (credentials) => runProxmoxProbe({
          target: parseServiceUrl(inventoryEndpoint.url),
          targetRevision: inventoryEndpoint.targetRevision,
          tlsMode: inventoryEndpoint.tlsMode,
          certificateFingerprint: inventoryEndpoint.certificateFingerprint,
          credentials,
          approvedHostCidrs: inventoryEndpoint.approvedHostCidrs || [],
          signal: context.signal,
          checkedAt
        }),
        inventoryEndpoint.id
      );
      const inventoryIdentity = discoveryIdentity(result.discovery);
      if (canonicalIdentity && inventoryIdentity !== canonicalIdentity) {
        selectedEndpoint.state = "degraded";
        selectedEndpoint.code = "ENVIRONMENT_IDENTITY_MISMATCH";
      } else {
        inventoryResult = result;
      }
    } catch (error) {
      Object.assign(selectedEndpoint, endpointFailure(error, inventoryEndpoint, checkedAt));
    }
    if (!inventoryResult) {
      return {
        schema: 2,
        type: "proxmox",
        state: "down",
        connectionState: "down",
        checkedAt,
        latencyMs: 0,
        version: null,
        checks: [{
          id: "inventory",
          label: "Environment inventory",
          ok: false,
          state: "down",
          importance: "critical",
          code: "ENDPOINT_UNAVAILABLE",
          latencyMs: null,
          metrics: {},
          reports: []
        }],
        metrics: {},
        endpoints: endpointResults,
        discovery: eligible[0]?.discovery || { kind: "unknown", name: environment.displayName, nodeNames: [] }
      };
    }

    const hasEndpointIssue = endpointResults.some(({ disabled, state: endpointState }) => (
      !disabled && !["healthy"].includes(endpointState)
    ));
    const endpointChecks = endpointResults.filter(({ disabled }) => !disabled).map((endpoint) => {
      const ok = endpoint.state === "healthy";
      return {
        id: `endpoint-${endpoint.id}`,
        label: endpoint.label,
        ok,
        state: ok ? "healthy" : "limited",
        importance: "optional",
        code: ok ? null : endpoint.code || "ENDPOINT_UNAVAILABLE",
        latencyMs: endpoint.latencyMs,
        metrics: {},
        reports: []
      };
    });
    const finalState = hasEndpointIssue && inventoryResult.state === "healthy"
      ? "limited"
      : inventoryResult.state;
    if (!environment.environmentIdentity && inventoryResult.connectionState === "connected") {
      const identity = persistedDiscoveryIdentity(inventoryResult.discovery);
      if (identity) {
        try {
          await store.mutate((next) => {
            const current = next.infrastructureTargets?.[environment.id];
            if (current?.targetRevision === environment.targetRevision && !current.environmentIdentity) {
              current.environmentIdentity = identity;
            }
          });
        } catch {
          log("A discovered Proxmox environment identity could not be persisted; the next monitor cycle will retry.");
        }
      }
    }
    return {
      ...inventoryResult,
      state: finalState,
      checks: [...endpointChecks, ...(inventoryResult.checks || [])],
      endpoints: endpointResults.map((endpoint) => ({
        ...endpoint,
        selected: endpoint.id === selectedEndpoint.id,
        discovery: undefined
      })),
      selectedEndpointId: selectedEndpoint.id
    };
  }

  const monitor = createOperationsMonitor({
    intervalMs: options.monitorIntervalMs || 30_000,
    initialSnapshot: initialOperationsSnapshot,
    incidentEngine,
    loadServices: async () => controlPlane.listMonitorServices(),
    probe: async (service, context) => probeService(service.id, monitorRequest, {
      signal: context.signal,
      checkedAt: context.checkedAt,
      timeoutMs: Math.min(10_000, limits.upstreamTimeoutMs),
      targetRevision: service.targetRevision,
      ...(service.id === "seerr"
        ? {
            enrichSeerrRequests: (body, enrichmentContext) => seerrRequestMetadata.enrich(body, {
              ...enrichmentContext,
              targetRevision: service.targetRevision
            })
          }
        : {})
    }),
    loadInfrastructureTargets: async () => controlPlane.listMonitorInfrastructureTargets(),
    probeInfrastructure: probeProxmoxEnvironment,
    loadInfrastructureServices: async () => controlPlane.listMonitorInfrastructureServices(),
    probeInfrastructureService: async (service, context) => controlPlane.useInfrastructureServiceCredentials(
      service.id,
      service,
      (credentials) => service.type === "loki"
        ? runLokiProbe({
            target: parseServiceUrl(service.url),
            targetRevision: service.targetRevision,
            authMode: service.authMode,
            tenantId: service.tenantId,
            tlsMode: service.tlsMode,
            certificateFingerprint: service.certificateFingerprint,
            credentials,
            approvedHostCidrs: service.approvedHostCidrs || [],
            signal: context.signal,
            checkedAt: context.checkedAt
          })
        : runPortainerProbe({
            target: parseServiceUrl(service.url),
            targetRevision: service.targetRevision,
            tlsMode: service.tlsMode,
            certificateFingerprint: service.certificateFingerprint,
            credentials,
            approvedHostCidrs: service.approvedHostCidrs || [],
            signal: context.signal,
            checkedAt: context.checkedAt
          })
    )
  });
  controlPlane.setMonitor(monitor);
  monitor.subscribe((snapshot) => persistentCache?.writeSnapshot?.(snapshot));
  void monitor.start().catch(() => {
    recordEvent({
      level: "error",
      category: "application",
      event: "monitor_cycle",
      outcome: "failed",
      service: "helmsman",
      code: "MONITOR_START_FAILED"
    });
    log("Helmsman monitor cycle failed safely.");
  });

  async function claimSetup(request, response) {
    if (store.snapshot().claimed) {
      request.resume();
      throw new BrokerError(409, "ALREADY_CLAIMED", "First-time setup has already been completed.");
    }
    const body = await readJson(request);
    requireExactKeys(body, ["setupToken", "deviceName", "origin", "allowedCidrs", "allowPublicHttps"]);
    const state = store.snapshot();
    if (state.claimed) throw new BrokerError(409, "ALREADY_CLAIMED", "First-time setup has already been completed.");
    const requestContext = enforceRequestOrigin(request, null, true);
    if (typeof body.origin !== "string"
      || body.origin !== requestContext.origin
      || !isSecureBrowserOrigin(body.origin)) {
      throw new BrokerError(400, "SECURE_ORIGIN_REQUIRED", "First-time setup requires HTTPS or a localhost origin.");
    }
    if (!tokenMatches(state.setupTokenHash, body.setupToken)) {
      throw new BrokerError(401, "SETUP_TOKEN_INVALID", "The one-time setup token is invalid.");
    }
    const name = safeDeviceName(body.deviceName);
    const policy = normalizePolicy({ allowedCidrs: body.allowedCidrs, allowPublicHttps: body.allowPublicHttps });
    const deviceToken = generateSecretToken();
    const deviceId = randomUUID();
    await store.mutate((next) => {
      if (next.claimed || !tokenMatches(next.setupTokenHash, body.setupToken)) {
        throw new BrokerError(409, "SETUP_TOKEN_USED", "The one-time setup token has already been used.");
      }
      next.claimed = true;
      next.claimedAt = new Date().toISOString();
      next.setupTokenHash = null;
      next.policy = { ...policy, revision: 1 };
      next.devices = {
        [deviceId]: {
          name,
          origin: body.origin,
          tokenHash: hashToken(deviceToken),
          createdAt: new Date().toISOString()
        }
      };
      next.connections = {};
    });
    const configured = store.snapshot();
    sendJson(response, 201, {
      deviceToken,
      instanceId: configured.instanceId,
      config: publicConfig(configured)
    });
  }

  async function authenticatedConfig(request, response) {
    const state = store.snapshot();
    const device = authenticateDevice(request, state);
    enforceRequestOrigin(request, device, request.method !== "GET");
    if (request.method === "GET") {
      sendJson(response, 200, { instanceId: state.instanceId, ...publicConfig(state) });
      return;
    }
    if (request.method !== "PUT") throw new BrokerError(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
    const body = await readJson(request);
    requireExactKeys(body, ["allowedCidrs", "allowPublicHttps"]);
    const policy = normalizePolicy(body);
    const revision = state.revision;
    await Promise.all(Object.entries(state.connections).map(async ([service, connection]) => {
      try {
        await resolveAndAuthorizeTarget(connection.url, policy, { lookup });
      } catch {
        throw new BrokerError(409, "POLICY_BLOCKS_CONNECTION", `The proposed policy would block the configured ${service} target.`);
      }
    }));
    await store.mutate((next) => {
      if (next.revision !== revision) throw new BrokerError(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
      next.policy = { ...policy, revision: next.policy.revision + 1 };
    });
    const configured = store.snapshot();
    sendJson(response, 200, { instanceId: configured.instanceId, ...publicConfig(configured) });
  }

  async function connectionConfig(request, response, serviceValue) {
    const service = canonicalServiceId(serviceValue);
    if (!service) throw new BrokerError(404, "SERVICE_NOT_SUPPORTED", "That service is not supported.");
    const state = store.snapshot();
    const device = authenticateDevice(request, state);
    enforceRequestOrigin(request, device, true);
    if (request.method === "PUT") {
      const target = validateConnectionBody(await readJson(request));
      await resolveAndAuthorizeTarget(target, state.policy, { lookup });
      const revision = state.revision;
      const previous = state.connections[service];
      if (previous?.url === target.url) {
        if (store.snapshot().revision !== revision) {
          throw new BrokerError(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
        }
        sendJson(response, 200, { service, url: target.url, targetRevision: previous.targetRevision });
        return;
      }
      const targetRevision = randomUUID();
      await store.mutate((next) => {
        if (next.revision !== revision) throw new BrokerError(409, "CONFIG_CHANGED", "Configuration changed; reload and try again.");
        next.connections[service] = {
          url: target.url,
          targetRevision,
          updatedAt: new Date().toISOString()
        };
      });
      if (previous) {
        const expired = expiredServiceCookies(service, device.origin, previous.targetRevision);
        if (expired.length) response.setHeader("Set-Cookie", expired);
      }
      sendJson(response, 200, { service, url: target.url, targetRevision });
      return;
    }
    if (request.method === "DELETE") {
      const previous = state.connections[service];
      await store.mutate((next) => {
        delete next.connections[service];
      });
      if (previous) {
        const expired = expiredServiceCookies(service, device.origin, previous.targetRevision);
        if (expired.length) response.setHeader("Set-Cookie", expired);
      }
      response.statusCode = 204;
      setCommonSecurityHeaders(response);
      response.end();
      return;
    }
    throw new BrokerError(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
  }

  async function relay(request, response, serviceValue) {
    const route = authorizeBridgeRoute(serviceValue, request.method, request.url);
    if (!route.allowed) throw new BrokerError(route.status || 404, route.code, route.message);
    if (route.internalOnly) throw new BrokerError(404, "NOT_FOUND", "Not found.");
    const state = store.snapshot();
    const device = authenticateDevice(request, state);
    enforceRequestOrigin(request, device, request.method === "POST");
    const connection = state.connections[route.service];
    if (!connection) throw new BrokerError(404, "CONNECTION_NOT_CONFIGURED", "That service has not been configured.");
    const targetRevision = request.headers[TARGET_REVISION_HEADER];
    if (typeof targetRevision !== "string" || targetRevision !== connection.targetRevision) {
      throw new BrokerError(409, "TARGET_REVISION_MISMATCH", "The service target changed; reload its connection before sending credentials.");
    }
    if (activeRequests >= limits.maxConcurrent
      || (activeByService.get(route.service) || 0) >= limits.maxPerService) {
      throw new BrokerError(503, "BROKER_BUSY", "The broker concurrency limit has been reached.");
    }
    // Reserve capacity before reading a potentially slow body or resolving DNS.
    // Otherwise many requests can pass the check together and bypass the cap.
    activeRequests += 1;
    activeByService.set(route.service, (activeByService.get(route.service) || 0) + 1);
    try {
      let body = Buffer.alloc(0);
      if (route.method === "POST") body = await readBoundedBody(request, MAX_RELAY_BODY_BYTES);
      else if (request.headers["content-length"] || request.headers["transfer-encoding"]) {
        throw new BrokerError(400, "REQUEST_BODY_NOT_ALLOWED", "Read-only bridge requests cannot contain a body.");
      }
      const resolution = await resolveAndAuthorizeTarget(connection.url, state.policy, { lookup });
      const upstream = await dispatchUpstream({
        request,
        body,
        targetResolution: resolution,
        route,
        deviceOrigin: device.origin,
        targetRevision: connection.targetRevision,
        shutdownSignal: shutdownController.signal,
        limits
      });
      setCommonSecurityHeaders(response);
      response.setHeader("Content-Security-Policy", API_CSP);
      response.setHeader("Content-Type", route.isArtwork ? upstream.contentType : `${upstream.contentType || "application/octet-stream"}`);
      if (upstream.cookies.length) response.setHeader("Set-Cookie", upstream.cookies);
      response.setHeader("Content-Length", String(upstream.body.length));
      response.statusCode = upstream.status;
      response.end(route.method === "HEAD" ? undefined : upstream.body);
    } finally {
      activeRequests -= 1;
      const remaining = Math.max(0, (activeByService.get(route.service) || 1) - 1);
      if (remaining) activeByService.set(route.service, remaining);
      else activeByService.delete(route.service);
    }
  }

  const handleRequest = async (request, response) => {
    try {
      if (shuttingDown) throw new BrokerError(503, "BROKER_STOPPING", "The broker is stopping.");
      if (request.url.length > 8192) throw new BrokerError(414, "URI_TOO_LONG", "The request URI is too long.");
      let url;
      try {
        url = new URL(request.url, "http://broker.invalid");
      } catch {
        throw new BrokerError(400, "INVALID_URI", "The request URI is invalid.");
      }
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new BrokerError(405, "METHOD_NOT_ALLOWED", "That method is not allowed.");
        }
        const peer = request.socket?.remoteAddress || "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
          throw new BrokerError(404, "NOT_FOUND", "Not found.");
        }
        const body = Buffer.from("ok\n", "utf8");
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Length", String(body.length));
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      if (await controlPlane.handle(request, response, url)) return;
      if (url.pathname.startsWith("/api/") || url.pathname === "/bridge" || url.pathname.startsWith("/bridge/")) {
        throw new BrokerError(404, "NOT_FOUND", "Not found.");
      }
      normalizedHostHeader(request);
      await serveStatic(request, response, rootDir, url.pathname);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  };

  const handler = (request, response) => {
    activeHandlers += 1;
    return handleRequest(request, response).finally(() => {
      activeHandlers -= 1;
      if (activeHandlers === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    });
  };
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    monitor.stop();
    seerrRequestMetadata.close();
    mediaArtwork.close();
    seerrSeriesSeasonCache.clear();
    seerrSeriesSeasonInFlight.clear();
    seerrSeriesSeasonEpochs.clear();
    shutdownController.abort();
  };
  let closePromise = null;
  const drain = async (options = {}) => {
    if (activeHandlers !== 0) await new Promise((resolve) => drainWaiters.add(resolve));
    let controlPlaneError = null;
    try {
      closePromise ||= controlPlane.close();
      await closePromise;
    } catch (error) {
      controlPlaneError = error;
    }
    if (options.finalEvent) {
      const finalEvent = controlPlaneError
        ? {
            ...options.finalEvent,
            level: "error",
            outcome: "failed",
            code: "APPLICATION_STOP_FAILED"
          }
        : options.finalEvent;
      await recordEvent(finalEvent);
    }
    await eventJournal.close();
    await persistentCache?.close?.();
    if (controlPlaneError) throw controlPlaneError;
  };

  return {
    handler,
    store,
    controlPlane,
    eventJournal,
    recordEvent,
    setupToken,
    version: VERSION,
    beginShutdown,
    drain
  };
}

export function createHttpServer(handler) {
  const server = http.createServer({
    requestTimeout: 35_000,
    headersTimeout: 10_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: 16 * 1024,
    requireHostHeader: true
  }, handler);
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  return server;
}
