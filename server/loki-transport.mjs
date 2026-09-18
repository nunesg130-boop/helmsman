import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { authorizeLokiRoute } from "./loki.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15_000;
const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/u;
const TENANT_ID = /^[A-Za-z0-9!._*'()-]{1,150}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
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
const ROUTE_PARAMETER_NAMES = Object.freeze([
  "labelName",
  "label",
  "query",
  "selector",
  "start",
  "end",
  "since",
  "limit",
  "direction"
]);

export class LokiTransportError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "LokiTransportError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new LokiTransportError(status, code, message);
}

function routeParameters(route) {
  if (route?.parameters && typeof route.parameters === "object" && !Array.isArray(route.parameters)) {
    return route.parameters;
  }
  const parameters = {};
  for (const name of ROUTE_PARAMETER_NAMES) {
    if (route && Object.hasOwn(route, name) && route[name] !== undefined) parameters[name] = route[name];
  }
  return parameters;
}

function reauthorizeRoute(route) {
  let authorized;
  try {
    authorized = authorizeLokiRoute(route?.routeId, route?.method, routeParameters(route));
  } catch {
    authorized = null;
  }
  if (!authorized?.allowed
    || !route?.allowed
    || route.service !== authorized.service
    || authorized.routeId !== route.routeId
    || authorized.method !== "GET"
    || route.method !== authorized.method
    || route.upstreamPath !== authorized.upstreamPath
    || authorized.upstreamPathAndQuery !== route.upstreamPathAndQuery
    || route.labelName !== authorized.labelName
    || route.query !== authorized.query
    || route.start !== authorized.start
    || route.end !== authorized.end
    || route.direction !== authorized.direction
    || route.limit !== authorized.limit
    || route.isArtwork !== authorized.isArtwork
    || route.isLogin !== authorized.isLogin
    || authorized.internalOnly !== true
    || route.internalOnly !== true) {
    fail(404, "ROUTE_NOT_ALLOWED", "That Loki capability is not allowed.");
  }
  return authorized;
}

function normalizedHostname(value) {
  if (typeof value !== "string") return null;
  const unwrapped = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unwrapped.toLowerCase();
}

function validateTargetResolution(targetResolution) {
  const { target, pinned } = targetResolution || {};
  if (!target || !pinned || !["http:", "https:"].includes(target.protocol)) {
    fail(500, "INVALID_TARGET_RESOLUTION", "The resolved Loki service is invalid.");
  }
  const pinnedFamily = isIP(pinned.address);
  if (!pinnedFamily || pinnedFamily !== Number(pinned.family)) {
    fail(500, "INVALID_TARGET_RESOLUTION", "The resolved Loki service is invalid.");
  }

  let parsed;
  try {
    parsed = new URL(target.url);
  } catch {
    fail(500, "INVALID_TARGET_RESOLUTION", "The resolved Loki service is invalid.");
  }
  const parsedPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const parsedBasePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  if (parsed.protocol !== target.protocol
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || normalizedHostname(parsed.hostname) !== normalizedHostname(target.hostname)
    || parsedPort !== Number(target.port)
    || parsedBasePath !== target.basePath
    || parsed.host !== target.authority
    || typeof target.basePath !== "string"
    || target.basePath.length > 512
    || (target.basePath && !target.basePath.startsWith("/"))
    || /[\u0000-\u0020\u007f-\u009f\\]/u.test(target.basePath)
    || typeof target.authority !== "string"
    || /[\u0000-\u0020\u007f-\u009f/@?#\\]/u.test(target.authority)) {
    fail(500, "INVALID_TARGET_RESOLUTION", "The resolved Loki service is invalid.");
  }
  return { target, pinned };
}

function validateConnectionSecurity(target, authMode, tlsMode, certificateFingerprint) {
  if (!["none", "basic", "bearer"].includes(authMode)) {
    fail(400, "INVALID_AUTH_MODE", "Choose no authentication, basic authentication, or a bearer token.");
  }
  if (target.protocol === "http:") {
    if (authMode !== "none") {
      fail(400, "HTTPS_REQUIRED", "Loki credentials can only be sent over HTTPS.");
    }
    if (tlsMode !== "none") {
      fail(400, "INVALID_TLS_MODE", "Plain HTTP Loki connections cannot configure TLS trust.");
    }
    if (certificateFingerprint !== null && certificateFingerprint !== undefined) {
      fail(400, "CERTIFICATE_FINGERPRINT_NOT_ALLOWED", "A certificate fingerprint is only used with pinned HTTPS trust.");
    }
    return null;
  }

  if (tlsMode !== "system" && tlsMode !== "pinned") {
    fail(400, "INVALID_TLS_MODE", "Choose system certificate trust or a pinned certificate fingerprint.");
  }
  const fingerprint = typeof certificateFingerprint === "string" && SHA256_FINGERPRINT.test(certificateFingerprint)
    ? certificateFingerprint
    : null;
  if (tlsMode === "pinned" && !fingerprint) {
    fail(400, "CERTIFICATE_FINGERPRINT_REQUIRED", "Pinned certificate trust requires a SHA-256 fingerprint.");
  }
  if (tlsMode === "system" && certificateFingerprint !== null && certificateFingerprint !== undefined) {
    fail(400, "CERTIFICATE_FINGERPRINT_NOT_ALLOWED", "A certificate fingerprint is only used with pinned HTTPS trust.");
  }
  return fingerprint;
}

function normalizedTenantId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 150
    || value.includes("|")
    || value === "."
    || value === ".."
    || !TENANT_ID.test(value)) {
    fail(400, "INVALID_TENANT_ID", "Enter one valid Loki tenant ID.");
  }
  return value;
}

function decodedUtf8(buffer, { maximum, allowColon = true, label }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > maximum) {
    fail(400, "INVALID_CREDENTIAL", `Enter a valid Loki ${label}.`);
  }
  const value = buffer.toString("utf8");
  if (!value
    || Buffer.byteLength(value, "utf8") !== buffer.length
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || (!allowColon && value.includes(":"))) {
    fail(400, "INVALID_CREDENTIAL", `Enter a valid Loki ${label}.`);
  }
  return value;
}

function authorizationHeader(authMode, credentials) {
  if (authMode === "none") return null;
  if (authMode === "basic") {
    const username = decodedUtf8(credentials?.username, {
      maximum: 320,
      allowColon: false,
      label: "username"
    });
    const password = decodedUtf8(credentials?.password, {
      maximum: 4096,
      allowColon: true,
      label: "password"
    });
    const combined = Buffer.from(`${username}:${password}`, "utf8");
    try {
      return `Basic ${combined.toString("base64")}`;
    } finally {
      combined.fill(0);
    }
  }
  const token = decodedUtf8(credentials?.token, {
    maximum: 4096,
    allowColon: true,
    label: "bearer token"
  });
  if (!/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) {
    fail(400, "INVALID_CREDENTIAL", "Enter a valid Loki bearer token.");
  }
  return `Bearer ${token}`;
}

function transportError(error) {
  if (error instanceof LokiTransportError) return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new LokiTransportError(502, "UPSTREAM_TIMEOUT", "The Loki request timed out.");
  }
  if (TLS_TRUST_ERRORS.has(error?.code)) {
    return new LokiTransportError(
      502,
      "TLS_CERTIFICATE_UNTRUSTED",
      "The Loki certificate is not trusted. Use system trust or configure its exact SHA-256 fingerprint."
    );
  }
  return new LokiTransportError(502, "UPSTREAM_UNREACHABLE", "The configured Loki service could not be reached.");
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

function clearChunks(chunks) {
  for (const chunk of chunks) {
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  }
  chunks.length = 0;
}

function discardResponse(response) {
  response.on("data", (chunk) => {
    if (Buffer.isBuffer(chunk)) chunk.fill(0);
  });
  response.resume();
}

function htmlResponse(contentType, body) {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return true;
  const prefix = body.subarray(0, Math.min(body.length, 512)).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html")
    || prefix.startsWith("<html")
    || prefix.startsWith("<head")
    || prefix.startsWith("<body");
}

async function openPinnedSocket({ target, pinned, fingerprint, signal }) {
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
      reject(transportError(error));
    };
    const onAbort = () => finishReject(new LokiTransportError(502, "UPSTREAM_TIMEOUT", "The Loki request timed out."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", finishReject);
    socket.once("secureConnect", () => {
      if (settled) return;
      const certificate = socket.getPeerCertificate(true);
      if (!certificate || !Buffer.isBuffer(certificate.raw) || certificate.raw.length < 1) {
        finishReject(new LokiTransportError(502, "TLS_CERTIFICATE_INVALID", "Loki did not present a usable TLS certificate."));
        return;
      }
      const actual = createHash("sha256").update(certificate.raw).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        finishReject(new LokiTransportError(502, "TLS_PIN_MISMATCH", "The Loki certificate fingerprint did not match the configured pin."));
        return;
      }
      const validFrom = Date.parse(certificate.valid_from);
      const validTo = Date.parse(certificate.valid_to);
      const now = Date.now();
      if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || now < validFrom || now > validTo) {
        finishReject(new LokiTransportError(502, "TLS_CERTIFICATE_INVALID", "The pinned Loki certificate is outside its validity period."));
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    });
  });
}

/**
 * Dispatches one already-authorized, read-only Loki API request. The transport
 * reconstructs the route, pins the authorized DNS answer, and never follows a
 * redirect or accepts a compressed response.
 */
export async function performLokiUpstreamRequest({
  targetResolution,
  route,
  credentials,
  authMode,
  tenantId,
  tlsMode,
  certificateFingerprint,
  limits,
  shutdownSignal,
  version
}) {
  const authorizedRoute = reauthorizeRoute(route);
  const { target, pinned } = validateTargetResolution(targetResolution);
  const fingerprint = validateConnectionSecurity(target, authMode, tlsMode, certificateFingerprint);
  const tenant = normalizedTenantId(tenantId);
  const maximum = Number.isSafeInteger(limits?.maxApiResponseBytes) && limits.maxApiResponseBytes > 0
    ? Math.min(MAX_RESPONSE_BYTES, limits.maxApiResponseBytes)
    : MAX_RESPONSE_BYTES;
  const timeoutMs = Number.isSafeInteger(limits?.upstreamTimeoutMs) && limits.upstreamTimeoutMs > 0
    ? Math.min(MAX_TIMEOUT_MS, limits.upstreamTimeoutMs)
    : MAX_TIMEOUT_MS;
  const signal = shutdownSignal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdownSignal])
    : AbortSignal.timeout(timeoutMs);

  let verifiedSocket = null;
  if (tlsMode === "pinned") {
    verifiedSocket = await openPinnedSocket({ target, pinned, fingerprint, signal });
  }

  let authorization;
  try {
    // Pinned HTTPS reaches this credential boundary only after the leaf hash
    // and validity window have been verified above.
    authorization = authorizationHeader(authMode, credentials);
  } catch (error) {
    verifiedSocket?.destroy();
    throw error;
  }
  const safeVersion = typeof version === "string" && VERSION.test(version) ? version : "1.1.2";
  const headers = {
    Host: target.authority,
    Accept: "application/json,text/plain",
    "Accept-Encoding": "identity",
    ...(authorization ? { Authorization: authorization } : {}),
    ...(tenant ? { "X-Scope-OrgID": tenant } : {}),
    "User-Agent": `Helmsman/${safeVersion}`,
    Connection: "close"
  };
  const requestOptions = {
    protocol: target.protocol,
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
    if (target.protocol === "https:") {
      requestOptions.rejectUnauthorized = true;
      if (!isIP(target.hostname)) requestOptions.servername = target.hostname;
    }
  }

  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearChunks(chunks);
      reject(transportError(error));
    };
    const upstream = transport.request(requestOptions, (upstreamResponse) => {
      const status = Number(upstreamResponse.statusCode || 502);
      if (status >= 300 && status < 400) {
        discardResponse(upstreamResponse);
        finishReject(new LokiTransportError(502, "UPSTREAM_REDIRECT_REJECTED", "The configured Loki service redirected the API request."));
        return;
      }
      if (status < 200 || status >= 300) {
        discardResponse(upstreamResponse);
        settled = true;
        resolve({ status, body: Buffer.alloc(0), contentType: "application/octet-stream" });
        return;
      }
      const contentEncoding = String(upstreamResponse.headers["content-encoding"] || "").trim().toLowerCase();
      if (contentEncoding && contentEncoding !== "identity") {
        discardResponse(upstreamResponse);
        finishReject(new LokiTransportError(502, "UPSTREAM_CONTENT_REJECTED", "Loki returned a compressed response."));
        return;
      }
      const rawLength = upstreamResponse.headers["content-length"];
      if (rawLength !== undefined
        && (!/^\d+$/u.test(String(rawLength)) || Number(rawLength) > maximum)) {
        discardResponse(upstreamResponse);
        finishReject(new LokiTransportError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Loki response exceeded its safety limit."));
        return;
      }
      let total = 0;
      upstreamResponse.on("data", (chunk) => {
        if (settled) {
          if (Buffer.isBuffer(chunk)) chunk.fill(0);
          return;
        }
        total += chunk.length;
        if (total > maximum) {
          upstreamResponse.destroy();
          finishReject(new LokiTransportError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "The Loki response exceeded its safety limit."));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on("error", () => {
        finishReject(new LokiTransportError(502, "UPSTREAM_RESPONSE_FAILED", "The Loki response ended unexpectedly."));
      });
      upstreamResponse.on("end", () => {
        if (settled) return;
        const contentType = String(upstreamResponse.headers["content-type"] || "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        const body = Buffer.concat(chunks, total);
        chunks.length = 0;
        if (htmlResponse(contentType, body)) {
          body.fill(0);
          finishReject(new LokiTransportError(502, "UPSTREAM_CONTENT_REJECTED", "Loki returned HTML instead of an API response."));
          return;
        }
        settled = true;
        resolve({ status, body, contentType });
      });
    });
    upstream.on("error", finishReject);
    upstream.end();
  });
}
