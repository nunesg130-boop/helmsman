import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

// One JSON request to a destination that has already been resolved and
// authorized by network.mjs. Used by the agent for the local AI model server
// and Home Assistant notifications.
//
// The caller chooses the path from a fixed set; this module never accepts a
// path from a browser. Requests are pinned to the authorized address, never
// follow redirects, refuse compressed or HTML responses, and are bounded in
// time and size. HTTPS uses system trust.

const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const HARD_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const HARD_MAX_TIMEOUT_MS = 300_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]{0,255}$/u;
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

export class OutboundJsonError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "OutboundJsonError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new OutboundJsonError(status, code, message);
}

function pinnedLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function transportError(error, label) {
  if (error instanceof OutboundJsonError) return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.name === "TimeoutError") {
    return new OutboundJsonError(504, "UPSTREAM_TIMEOUT", `${label} did not answer in time.`);
  }
  if (TLS_TRUST_ERRORS.has(error?.code)) {
    return new OutboundJsonError(502, "TLS_CERTIFICATE_UNTRUSTED", `${label} uses a certificate that is not trusted.`);
  }
  return new OutboundJsonError(502, "UPSTREAM_UNREACHABLE", `${label} could not be reached.`);
}

function htmlResponse(contentType, body) {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") return true;
  const prefix = body.subarray(0, Math.min(body.length, 256)).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}

function validateResolution(targetResolution) {
  const { target, pinned } = targetResolution || {};
  if (!target || !pinned || !["http:", "https:"].includes(target.protocol)
    || typeof target.basePath !== "string" || typeof target.authority !== "string"
    || !isIP(pinned.address) || isIP(pinned.address) !== Number(pinned.family)) {
    fail(500, "INVALID_TARGET_RESOLUTION", "The resolved destination is invalid.");
  }
  return { target, pinned };
}

/**
 * Sends one request and returns { status, json, bytes } for a 2xx JSON answer,
 * or { status, json: null, bytes: 0 } for any other status. Throws
 * OutboundJsonError for transport failures, redirects and oversized or
 * non-JSON answers.
 */
export async function performOutboundJsonRequest({
  targetResolution,
  method = "GET",
  path,
  body = undefined,
  bearerToken = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  shutdownSignal = null,
  label = "The service",
  version = "dev"
}) {
  const { target, pinned } = validateResolution(targetResolution);
  if (!["GET", "POST"].includes(method)) fail(500, "INVALID_METHOD", "Unsupported outbound method.");
  if (typeof path !== "string" || !SAFE_PATH.test(path) || path.includes("..") || path.includes("//")) {
    fail(500, "INVALID_PATH", "Unsupported outbound path.");
  }
  let payload = null;
  if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body), "utf8");
    if (payload.length > MAX_REQUEST_BYTES) fail(413, "REQUEST_TOO_LARGE", "The outbound request was too large.");
  }
  const limitBytes = Math.min(HARD_MAX_RESPONSE_BYTES, Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES));
  const limitMs = Math.min(HARD_MAX_TIMEOUT_MS, Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const signal = shutdownSignal
    ? AbortSignal.any([AbortSignal.timeout(limitMs), shutdownSignal])
    : AbortSignal.timeout(limitMs);

  const headers = {
    Host: target.authority,
    Accept: "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": `Helmsman/${/^[0-9A-Za-z.+-]{1,64}$/u.test(version) ? version : "dev"}`,
    Connection: "close",
    ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {})
  };
  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method,
    path: `${target.basePath}${path}`,
    headers,
    agent: false,
    signal,
    lookup: pinnedLookup(pinned.address, pinned.family),
    family: pinned.family
  };
  if (target.protocol === "https:") {
    options.rejectUnauthorized = true;
    if (!isIP(target.hostname)) options.servername = target.hostname;
  }
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      for (const chunk of chunks) chunk.fill(0);
      reject(transportError(error, label));
    };
    const outgoing = transport.request(options, (incoming) => {
      const status = Number(incoming.statusCode || 502);
      if (status >= 300 && status < 400) {
        incoming.resume();
        finishReject(new OutboundJsonError(502, "UPSTREAM_REDIRECT_REJECTED", `${label} answered with a redirect.`));
        return;
      }
      if (status < 200 || status >= 300) {
        incoming.resume();
        settled = true;
        resolve({ status, json: null, bytes: 0 });
        return;
      }
      const encoding = String(incoming.headers["content-encoding"] || "").trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        incoming.resume();
        finishReject(new OutboundJsonError(502, "UPSTREAM_CONTENT_REJECTED", `${label} sent a compressed answer.`));
        return;
      }
      const declared = incoming.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > limitBytes)) {
        incoming.resume();
        finishReject(new OutboundJsonError(502, "UPSTREAM_RESPONSE_TOO_LARGE", `${label} sent an answer that was too large.`));
        return;
      }
      let total = 0;
      incoming.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > limitBytes) {
          incoming.destroy();
          finishReject(new OutboundJsonError(502, "UPSTREAM_RESPONSE_TOO_LARGE", `${label} sent an answer that was too large.`));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("error", (error) => finishReject(error));
      incoming.on("end", () => {
        if (settled) return;
        const bytes = Buffer.concat(chunks, total);
        for (const chunk of chunks) chunk.fill(0);
        const contentType = String(incoming.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        if (htmlResponse(contentType, bytes)) {
          finishReject(new OutboundJsonError(502, "UPSTREAM_CONTENT_REJECTED", `${label} answered with a web page instead of JSON.`));
          return;
        }
        if (bytes.length === 0) {
          settled = true;
          resolve({ status, json: null, bytes: 0 });
          return;
        }
        let json;
        try {
          json = JSON.parse(bytes.toString("utf8"));
        } catch {
          finishReject(new OutboundJsonError(502, "UPSTREAM_CONTENT_REJECTED", `${label} did not answer with JSON.`));
          return;
        } finally {
          bytes.fill(0);
        }
        settled = true;
        resolve({ status, json, bytes: total });
      });
    });
    outgoing.on("error", finishReject);
    outgoing.end(payload || undefined);
  });
}
