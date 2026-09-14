import {
  inventoryFromProbeBody,
  normalizeServiceMediaInventory
} from "./media-model.mjs";

export const SERVICE_PROBE_SCHEMA = 1;

const MAX_LATENCY_MS = 120_000;
const MAX_COUNTER = 1_000_000_000;
const MAX_COLLECTION_ITEMS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REPORTS_PER_CHECK = 12;
const MAX_REPORT_SOURCE_CODEPOINTS = 96;
const MAX_REPORT_MESSAGE_CODEPOINTS = 600;
const REPORT_REDACTION = "[REDACTED]";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const secretField = (id) => ({ id, secret: true, writeOnly: true });

export const SERVICE_AUTH_SCHEMA = deepFreeze({
  schema: 1,
  services: {
    jellyfin: {
      defaultMode: "token",
      modes: {
        token: { strategy: "jellyfin-token", storedFields: [secretField("token")] },
        login: {
          strategy: "exchange-for-token",
          transientFields: [secretField("username"), secretField("password")],
          storedFields: [secretField("token")]
        }
      }
    },
    seerr: {
      defaultMode: "apiKey",
      modes: {
        apiKey: { strategy: "x-api-key", storedFields: [secretField("apiKey")] },
        login: {
          strategy: "exchange-for-session",
          transientFields: [secretField("username"), secretField("password")],
          storedFields: [secretField("session")]
        }
      }
    },
    radarr: {
      defaultMode: "apiKey",
      modes: { apiKey: { strategy: "x-api-key", storedFields: [secretField("apiKey")] } }
    },
    sonarr: {
      defaultMode: "apiKey",
      modes: { apiKey: { strategy: "x-api-key", storedFields: [secretField("apiKey")] } }
    },
    prowlarr: {
      defaultMode: "apiKey",
      modes: { apiKey: { strategy: "x-api-key", storedFields: [secretField("apiKey")] } }
    },
    bazarr: {
      defaultMode: "apiKey",
      modes: { apiKey: { strategy: "x-api-key", storedFields: [secretField("apiKey")] } }
    },
    qbittorrent: {
      defaultMode: "apiKey",
      modes: {
        apiKey: {
          strategy: "bearer-api-key",
          minimumVersion: "5.2.0",
          storedFields: [secretField("apiKey")]
        },
        password: {
          strategy: "webui-session",
          storedFields: [secretField("username"), secretField("password")]
        }
      }
    }
  }
});

export const SERVICE_REPORT_LIMITS = deepFreeze({
  reportsPerCheck: MAX_REPORTS_PER_CHECK,
  sourceCodePoints: MAX_REPORT_SOURCE_CODEPOINTS,
  messageCodePoints: MAX_REPORT_MESSAGE_CODEPOINTS
});

const probe = (
  id,
  label,
  path,
  responseType,
  importance,
  maxBytes,
  stages,
  credentialRequired = true,
  credentialProof = false,
  affectsHealth = true
) => ({
  id,
  label,
  path,
  method: "GET",
  responseType,
  importance,
  maxBytes,
  stages,
  credentialRequired,
  credentialProof,
  affectsHealth,
  timeoutMs: DEFAULT_TIMEOUT_MS
});

const PROBE_PLANS = deepFreeze({
  jellyfin: [
    // ImageTags is standard BaseItemDto metadata, not an ItemFields enum value.
    // Enable images explicitly so Primary tags are returned without sending an
    // unsupported Fields=ImageTags value to Jellyfin's typed query binder.
    probe("status", "Server status", "/System/Info/Public", "json", "core", 64 * 1024, ["library"], false, false),
    probe("identity", "Token authorization", "/System/Info", "json", "important", 64 * 1024, ["library"], true, true),
    probe("library", "Library catalog", "/Items?Recursive=true&IncludeItemTypes=Movie%2CSeries&Fields=ProviderIds%2CDateCreated%2CPremiereDate%2CProductionYear%2CUserData&Limit=500&EnableImages=true", "json", "optional", 4 * 1024 * 1024, ["library"], true, false, false),
    probe("latest", "Recently added", "/Items/Latest?IncludeItemTypes=Movie%2CSeries&Fields=ProviderIds%2CDateCreated%2CPremiereDate%2CProductionYear%2CUserData&Limit=100&GroupItems=false&EnableImages=true", "json", "optional", 2 * 1024 * 1024, ["library"], true, false, false),
    probe("resume", "Continue watching", "/UserItems/Resume?Limit=40&Fields=ProviderIds%2CPremiereDate%2CProductionYear%2CUserData&EnableImages=true&EnableImageTypes=Primary", "json", "optional", 2 * 1024 * 1024, ["library"], true, false, false),
    probe("nextUp", "Next episodes", "/Shows/NextUp?Limit=40&Fields=ProviderIds%2CPremiereDate%2CProductionYear%2CUserData&EnableImages=true&EnableImageTypes=Primary", "json", "optional", 2 * 1024 * 1024, ["library"], true, false, false),
    probe("sessions", "Now playing", "/Sessions?ActiveWithinSeconds=900", "json", "optional", 512 * 1024, ["library"], true, false, false)
  ],
  seerr: [
    probe("status", "Server status", "/api/v1/status", "json", "core", 64 * 1024, ["requests"], false, false),
    probe("identity", "Authentication", "/api/v1/auth/me", "json", "important", 64 * 1024, ["requests"], true, true),
    probe("requestCounts", "Request workflow", "/api/v1/request/count", "json", "optional", 64 * 1024, ["requests"], true, false),
    probe("requests", "Recent requests", "/api/v1/request?take=200&skip=0&sort=added", "json", "optional", 2 * 1024 * 1024, ["requests"], true, false, false),
    probe("trending", "Trending discovery", "/api/v1/discover/trending?page=1", "json", "optional", 2 * 1024 * 1024, ["requests"], true, false, false)
  ],
  radarr: [
    probe("status", "Server status", "/api/v3/system/status", "json", "core", 64 * 1024, ["search", "imports"], true, true),
    probe("health", "Application health", "/api/v3/health", "json", "important", 256 * 1024, ["search", "imports"]),
    probe("queue", "Movie queue", "/api/v3/queue?page=1&pageSize=500&includeUnknownMovieItems=true&includeMovie=true", "json", "important", 2 * 1024 * 1024, ["imports"]),
    probe("catalog", "Movie catalog", "/api/v3/movie?excludeLocalCovers=true", "json", "optional", 4 * 1024 * 1024, ["imports"], true, false, false),
    probe("calendar", "Movie calendar", "/api/v3/calendar", "json", "optional", 2 * 1024 * 1024, ["imports"], true, false, false)
  ],
  sonarr: [
    probe("status", "Server status", "/api/v3/system/status", "json", "core", 64 * 1024, ["search", "imports"], true, true),
    probe("health", "Application health", "/api/v3/health", "json", "important", 256 * 1024, ["search", "imports"]),
    probe("queue", "Series queue", "/api/v3/queue?page=1&pageSize=500&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true", "json", "important", 2 * 1024 * 1024, ["imports"]),
    probe("catalog", "Series catalog", "/api/v3/series?includeSeasonImages=false", "json", "optional", 4 * 1024 * 1024, ["imports"], true, false, false),
    probe("calendar", "Episode calendar", "/api/v3/calendar?includeSeries=true", "json", "optional", 2 * 1024 * 1024, ["imports"], true, false, false)
  ],
  prowlarr: [
    probe("status", "Server status", "/api/v1/system/status", "json", "core", 64 * 1024, ["search"], true, true),
    probe("health", "Application health", "/api/v1/health", "json", "important", 256 * 1024, ["search"]),
    probe("indexers", "Blocked indexers", "/api/v1/indexerstatus", "json", "important", 512 * 1024, ["search"])
  ],
  bazarr: [
    probe("status", "Server status", "/api/system/status", "json", "core", 64 * 1024, ["subtitles"], true, true),
    probe("health", "Application health", "/api/system/health", "json", "important", 256 * 1024, ["subtitles"]),
    probe("wantedMovies", "Movie subtitle backlog", "/api/movies/wanted?start=0&length=200", "json", "optional", 2 * 1024 * 1024, ["subtitles"]),
    probe("wantedEpisodes", "Episode subtitle backlog", "/api/episodes/wanted?start=0&length=200", "json", "optional", 2 * 1024 * 1024, ["subtitles"])
  ],
  qbittorrent: [
    probe("version", "Server status", "/api/v2/app/version", "text", "core", 4 * 1024, ["downloads"], true, true),
    probe("transfer", "Transfer connection", "/api/v2/transfer/info", "json", "important", 64 * 1024, ["downloads"]),
    probe("torrents", "Download workload", "/api/v2/torrents/info?filter=all", "json", "important", 4 * 1024 * 1024, ["downloads"])
  ]
});

export const SERVICE_IDS = Object.freeze(Object.keys(PROBE_PLANS));

function serviceId(value) {
  const normalized = String(value || "").toLowerCase();
  const id = normalized === "qbit" ? "qbittorrent" : normalized;
  if (!Object.hasOwn(PROBE_PLANS, id)) throw new RangeError("Unsupported service probe.");
  return id;
}

export function serviceAuthMetadata(service) {
  return SERVICE_AUTH_SCHEMA.services[serviceId(service)];
}

export function buildProbePlan(service, options = {}) {
  const id = serviceId(service);
  const includeOptional = options.includeOptional !== false;
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return PROBE_PLANS[id]
    .filter((entry) => includeOptional || entry.importance !== "optional")
    .map((entry) => Object.freeze({ ...entry, timeoutMs }));
}

function own(value, key) {
  try {
    return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function boundedInteger(value, fallback = 0, minimum = 0, maximum = MAX_COUNTER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function isNumericValue(value) {
  return (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
}

function safeVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (text.length < 1
    || text.length > 64
    || !/^[vV]?\d+(?:\.\d+){1,4}(?:[-+][0-9A-Za-z.-]+)?$/u.test(text)) return null;
  return text.slice(0, 64);
}

function lowercaseToken(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]/gu, "").slice(0, 64);
}

function collection(value, keys = []) {
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ITEMS);
  const source = record(value);
  if (!source) return null;
  for (const key of keys) {
    const candidate = own(source, key);
    if (Array.isArray(candidate)) return candidate.slice(0, MAX_COLLECTION_ITEMS);
  }
  return null;
}

function truncateCodePoints(value, maximum) {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, maximum - 1).join("")}\u2026`;
}

function redactOpaqueTokens(value) {
  return value.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, (candidate) => {
    const core = candidate.replace(/={1,2}$/u, "");
    const unique = new Set(core.toLowerCase()).size;
    const hasSeparator = /[_+/-]/u.test(core);
    const mixedClasses = /[a-z]/u.test(core) && /[A-Z]/u.test(core)
      || /[A-Za-z]/u.test(core) && /\d/u.test(core);
    return unique >= 10 && (hasSeparator || mixedClasses) ? REPORT_REDACTION : candidate;
  });
}

/**
 * Converts a small, explicitly selected upstream diagnostic string into
 * single-line display text. This is defense in depth for API clients: callers
 * must still render it as text, never HTML.
 */
function sanitizeReportText(value, maximum) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text;
  try {
    text = String(value).normalize("NFKC");
  } catch {
    return "";
  }
  text = text
    // Strip terminal controls, newlines, bidi controls, and other invisible
    // formatting characters before collapsing remaining Unicode whitespace.
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    // Neutralize markup delimiters so the API never returns executable-looking
    // HTML even if a downstream client accidentally uses an HTML sink.
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    // URI userinfo can be a username/password pair or a single access token.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu, `$1${REPORT_REDACTION}@`)
    // Authorization schemes and cookie headers may not use key=value syntax.
    .replace(/\b((?:authorization|proxy-authorization)\s*(?::|=)\s*)(?:bearer|basic)\s+[^\s,;]+/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/giu, `$1${REPORT_REDACTION}`)
    // Redact named credentials in prose, header-like text, query strings, and
    // JSON-ish snippets while retaining surrounding actionable diagnostics.
    .replace(/((?:["']?(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|secret|credential|auth|cookie|set-cookie|session(?:id)?)["']?)\s*(?::|=)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      `$1${REPORT_REDACTION}`)
    // Prose diagnostics sometimes spell a secret assignment as "password is
    // value". Keep common non-secret state words useful to the operator.
    .replace(/((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|secret|credential|session(?:id)?)["']?)\s+(?:is|was)\s+)(?:["'][^"']*["']|(?!(?:missing|invalid|expired|rejected|required|unset|empty|incorrect|unavailable|changed|updated|removed|accepted|denied|wrong|disabled|enabled|configured|not)\b)[^\s,;&}]+)/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b(?:qbt_|sk-|eyJ)[A-Za-z0-9._~+/-]{10,}={0,2}/gu, REPORT_REDACTION)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      REPORT_REDACTION);
  text = redactOpaqueTokens(text).replace(/\s+/gu, " ").trim();
  return truncateCodePoints(text, maximum);
}

function healthReport(entry, severity, service) {
  const message = sanitizeReportText(own(entry, "message"), MAX_REPORT_MESSAGE_CODEPOINTS);
  if (!message) return null;
  const serviceName = `${service.slice(0, 1).toUpperCase()}${service.slice(1)}`;
  const source = sanitizeReportText(own(entry, "source"), MAX_REPORT_SOURCE_CODEPOINTS)
    || `${serviceName} health`;
  return { severity, source, message };
}

function nestedRecord(value, key) {
  return record(own(record(value), key));
}

function healthMetrics(body, service) {
  let entries = collection(body, ["records", "items", "health"]);
  if (entries === null) {
    const data = own(record(body), "data");
    entries = collection(data, ["records", "items", "health"]);
  }
  if (entries === null) {
    if (service !== "bazarr") throw new TypeError("invalid health response");
    const source = record(own(record(body), "data")) || record(body);
    if (!source) throw new TypeError("invalid health response");
    const status = lowercaseToken(own(source, "status") ?? own(source, "state"));
    if (!status || ["ok", "healthy", "good", "running"].includes(status)) {
      return {
        metrics: { healthNotices: 0, healthWarnings: 0, healthErrors: 0 },
        state: "healthy",
        code: null
      };
    }
    if (status === "notice") {
      return {
        metrics: { healthNotices: 1, healthWarnings: 0, healthErrors: 0 },
        state: "healthy",
        code: null
      };
    }
    const errors = ["error", "failed", "failure", "critical", "fatal"].includes(status) ? 1 : 0;
    return {
      metrics: { healthNotices: 0, healthWarnings: errors ? 0 : 1, healthErrors: errors },
      state: errors ? "degraded" : "limited",
      code: errors ? "HEALTH_ERROR" : "HEALTH_WARNING"
    };
  }
  let notices = 0;
  let warnings = 0;
  let errors = 0;
  const reports = [];
  const reportsSupported = ["radarr", "sonarr", "prowlarr"].includes(service);
  for (const entry of entries) {
    const source = record(entry) || {};
    const type = lowercaseToken(own(source, "type") ?? own(source, "level") ?? own(source, "severity"));
    if (type === "ok") continue;
    let reportSeverity = null;
    if (type === "notice") {
      notices += 1;
      reportSeverity = "notice";
    } else if (type === "warning") {
      warnings += 1;
      reportSeverity = "warning";
    } else if (type === "error") {
      errors += 1;
      reportSeverity = "error";
    }
    else if (service === "bazarr") {
      if (["failed", "failure", "critical", "fatal"].includes(type)) errors += 1;
      else warnings += 1;
    } else {
      throw new TypeError("invalid health result type");
    }
    if (reportsSupported && reportSeverity && reports.length < MAX_REPORTS_PER_CHECK) {
      const report = healthReport(source, reportSeverity, service);
      if (report) reports.push(report);
    }
  }
  return {
    metrics: { healthNotices: notices, healthWarnings: warnings, healthErrors: errors },
    state: errors ? "degraded" : warnings ? "limited" : "healthy",
    code: errors ? "HEALTH_ERROR" : warnings ? "HEALTH_WARNING" : null,
    reports
  };
}

function queueMetrics(body) {
  const records = collection(body, ["records", "Records", "items", "Items"]);
  if (records === null) throw new TypeError("invalid queue response");
  const source = record(body);
  const candidateTotal = own(source, "totalRecords") ?? own(source, "total");
  const reportedTotal = isNumericValue(candidateTotal) ? candidateTotal : records.length;
  let failed = 0;
  let stalled = 0;
  let importsBlocked = 0;
  for (const item of records) {
    const entry = record(item) || {};
    const status = lowercaseToken(own(entry, "status"));
    const trackedStatus = lowercaseToken(own(entry, "trackedDownloadStatus"));
    const trackedState = lowercaseToken(own(entry, "trackedDownloadState"));
    if (["failed", "error", "downloadfailed", "downloadclientunavailable"].includes(status)
      || ["error", "failed"].includes(trackedStatus)
      || ["downloadfailed", "downloadclientunavailable", "failed", "failedpending"].includes(trackedState)) failed += 1;
    if (status.includes("stalled") || trackedState.includes("stalled")) stalled += 1;
    if (trackedState.includes("importblocked")
      || trackedState.includes("importfailed")
      || status === "warning"
      || trackedStatus === "warning") importsBlocked += 1;
  }
  return {
    metrics: {
      queueTotal: boundedInteger(reportedTotal, records.length),
      queueFailed: failed,
      queueStalled: stalled,
      importsBlocked
    },
    state: failed || stalled || importsBlocked ? "degraded" : "healthy"
  };
}

function requestCountMetrics(body) {
  const source = record(body);
  if (!source) throw new TypeError("invalid request-count response");
  const data = record(own(source, "data")) || source;
  const aliases = {
    totalRequests: ["total", "totalRequests"],
    pendingRequests: ["pending", "pendingRequests"],
    approvedRequests: ["approved", "approvedRequests"],
    processingRequests: ["processing", "processingRequests"],
    availableRequests: ["available", "availableRequests"]
  };
  const metrics = {};
  let recognized = false;
  for (const [output, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      const value = own(data, key);
      if (isNumericValue(value)) {
        metrics[output] = boundedInteger(value);
        recognized = true;
        break;
      }
    }
  }
  if (!recognized) throw new TypeError("invalid request-count response");
  return { metrics, state: "healthy" };
}

function wantedCount(body) {
  const source = record(body);
  if (!source) throw new TypeError("invalid wanted response");
  const data = own(source, "data");
  const nested = record(data);
  const candidates = [
    own(source, "total"),
    own(source, "totalRecords"),
    own(nested, "total"),
    own(nested, "totalRecords"),
    Array.isArray(data) ? data.length : undefined,
    Array.isArray(own(nested, "data")) ? own(nested, "data").length : undefined
  ];
  const found = candidates.find(isNumericValue);
  if (found === undefined) throw new TypeError("invalid wanted response");
  return boundedInteger(found);
}

function indexerMetrics(body) {
  const entries = collection(body, ["records", "items", "indexers"]);
  if (entries === null) throw new TypeError("invalid indexer response");
  const blocked = entries.length;
  return {
    metrics: { indexersBlocked: blocked },
    state: blocked ? "limited" : "healthy",
    code: blocked ? "INDEXERS_BLOCKED" : null
  };
}

function qbitTransferMetrics(body) {
  const source = record(body);
  if (!source) throw new TypeError("invalid transfer response");
  const rawStatus = lowercaseToken(own(source, "connection_status") ?? own(source, "connectionStatus"));
  const connectionStatus = ["connected", "firewalled", "disconnected"].includes(rawStatus)
    ? rawStatus
    : "unknown";
  return {
    metrics: {
      downloadSpeedBps: boundedInteger(own(source, "dl_info_speed") ?? own(source, "downloadSpeed")),
      uploadSpeedBps: boundedInteger(own(source, "up_info_speed") ?? own(source, "uploadSpeed")),
      connectionStatus
    },
    state: connectionStatus === "connected" ? "healthy" : "limited"
  };
}

function qbitTorrentMetrics(body) {
  if (!Array.isArray(body)) throw new TypeError("invalid torrent response");
  const entries = body.slice(0, MAX_COLLECTION_ITEMS);
  let downloading = 0;
  let stalled = 0;
  let errored = 0;
  let paused = 0;
  let completed = 0;
  for (const item of entries) {
    const entry = record(item) || {};
    const state = lowercaseToken(own(entry, "state"));
    const progress = Number(own(entry, "progress"));
    if (["error", "missingfiles", "unknown"].includes(state)) errored += 1;
    if (state === "stalleddl") stalled += 1;
    if (["downloading", "forceddl", "metadl", "queueddl", "checkingdl", "moving", "allocating"].includes(state)) downloading += 1;
    if (["pauseddl", "pausedup"].includes(state)) paused += 1;
    if (Number.isFinite(progress) && progress >= 1
      || ["uploading", "forcedup", "stalledup", "queuedup", "checkingup", "pausedup"].includes(state)) completed += 1;
  }
  return {
    metrics: {
      torrentsTotal: boundedInteger(body.length),
      downloading,
      stalled,
      errored,
      paused,
      completed
    },
    state: errored || stalled ? "degraded" : "healthy"
  };
}

function statusVersion(service, body) {
  const source = record(body);
  if (!source) throw new TypeError("invalid status response");
  let version = own(source, "Version") ?? own(source, "version") ?? own(source, "appVersion");
  if (service === "bazarr") {
    const data = nestedRecord(source, "data");
    version = version ?? own(source, "bazarr_version") ?? own(data, "bazarr_version") ?? own(data, "version");
  }
  const safe = safeVersion(version);
  if (!safe) throw new TypeError("invalid service version");
  if (["radarr", "sonarr", "prowlarr"].includes(service)) {
    const appName = lowercaseToken(own(source, "appName"));
    if (appName && appName !== service) throw new TypeError("cross-wired service response");
  }
  return { metrics: {}, version: safe, state: "healthy" };
}

function identityResult(service, body) {
  const source = record(body);
  const valid = service === "jellyfin"
    ? typeof own(source, "Id") === "string" && own(source, "Id").trim().length > 0
    : Number.isSafeInteger(Number(own(source, "id"))) && Number(own(source, "id")) > 0;
  if (!source || !valid) {
    throw new TypeError("invalid identity response");
  }
  return { metrics: {}, state: "healthy" };
}

function mediaInventoryResult(service, checkId, body, result = { metrics: {}, state: "healthy" }) {
  if (service === "jellyfin" && checkId === "sessions" && !Array.isArray(body)) {
    throw new TypeError("invalid session response");
  }
  const keys = service === "jellyfin"
    ? ["Items", "items"]
    : service === "seerr"
      ? ["results", "requests"]
      : ["records", "items", "data"];
  if (collection(body, keys) === null) throw new TypeError("invalid media inventory response");
  return { ...result, inventory: inventoryFromProbeBody(service, checkId, body) };
}

function parseSuccessfulCheck(service, checkId, body, checkedAt) {
  if (checkId === "status") return statusVersion(service, body);
  if (["jellyfin", "seerr"].includes(service) && checkId === "identity") return identityResult(service, body);
  if (service === "seerr" && checkId === "requestCounts") return requestCountMetrics(body);
  if (service === "seerr" && ["requests", "trending"].includes(checkId)) {
    return mediaInventoryResult(service, checkId, body);
  }
  if (service === "jellyfin" && ["library", "latest", "resume", "nextUp", "sessions"].includes(checkId)) {
    return mediaInventoryResult(service, checkId, body);
  }
  if (["radarr", "sonarr", "prowlarr", "bazarr"].includes(service) && checkId === "health") {
    return healthMetrics(body, service);
  }
  if (["radarr", "sonarr"].includes(service) && checkId === "queue") {
    return mediaInventoryResult(service, checkId, body, queueMetrics(body));
  }
  if (["radarr", "sonarr"].includes(service) && ["catalog", "calendar"].includes(checkId)) {
    return mediaInventoryResult(service, checkId, body);
  }
  if (service === "prowlarr" && checkId === "indexers") return indexerMetrics(body);
  if (service === "bazarr" && checkId === "wantedMovies") {
    return mediaInventoryResult(service, checkId, body, {
      metrics: { missingMovieSubtitles: wantedCount(body) }, state: "healthy"
    });
  }
  if (service === "bazarr" && checkId === "wantedEpisodes") {
    return mediaInventoryResult(service, checkId, body, {
      metrics: { missingEpisodeSubtitles: wantedCount(body) }, state: "healthy"
    });
  }
  if (service === "qbittorrent" && checkId === "version") {
    const version = safeVersion(body);
    if (!version) throw new TypeError("invalid version response");
    return { metrics: {}, version, state: "healthy" };
  }
  if (service === "qbittorrent" && checkId === "transfer") return qbitTransferMetrics(body);
  if (service === "qbittorrent" && checkId === "torrents") {
    return mediaInventoryResult(service, checkId, body, qbitTorrentMetrics(body));
  }
  throw new TypeError("unsupported probe response");
}

function safeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "NETWORK_ERROR",
  "FETCH_FAILED",
  "UPSTREAM_UNREACHABLE"
]);

function failureFromObservation(observation, entry, suppliedStatus = null) {
  const status = suppliedStatus
    ?? safeHttpStatus(observation.status ?? own(observation.error, "status") ?? own(observation.error, "statusCode"));
  const rawCode = typeof own(observation.error, "code") === "string"
    ? own(observation.error, "code").toUpperCase()
    : "";
  if (status === 401 || status === 403 || rawCode === "CREDENTIAL_NOT_CONFIGURED") {
    return {
      state: "auth_required",
      code: rawCode === "CREDENTIAL_NOT_CONFIGURED" ? rawCode : "AUTH_REQUIRED",
      status
    };
  }
  if (observation.cancelled
    || rawCode === "PROBE_CANCELLED"
    || rawCode === "ABORT_ERR"
    || rawCode === "TARGET_CHANGED") {
    return { state: "stale", code: "CHECK_CANCELLED", status };
  }
  if (observation.timedOut
    || rawCode === "PROBE_TIMEOUT"
    || rawCode === "ETIMEDOUT"
    || rawCode === "UPSTREAM_TIMEOUT") {
    return { state: "down", code: "TIMEOUT", status };
  }
  if (NETWORK_CODES.has(rawCode) || (!status && observation.error)) {
    return { state: "down", code: "UNREACHABLE", status };
  }
  if (rawCode === "RESPONSE_TOO_LARGE" || rawCode === "UPSTREAM_RESPONSE_TOO_LARGE" || status === 413) {
    return { state: entry.importance === "optional" ? "limited" : "degraded", code: "RESPONSE_TOO_LARGE", status };
  }
  if (rawCode === "UPSTREAM_REDIRECT_REJECTED" || rawCode === "UPSTREAM_CONTENT_REJECTED") {
    return { state: entry.importance === "optional" ? "limited" : "degraded", code: "INVALID_RESPONSE", status };
  }
  if (entry.importance === "core" && status !== null && status >= 500) {
    return { state: "down", code: "HTTP_ERROR", status };
  }
  return {
    state: entry.importance === "optional" ? "limited" : "degraded",
    code: status ? "HTTP_ERROR" : "CHECK_FAILED",
    status
  };
}

function serviceLabel(service) {
  if (service === "qbittorrent") return "qBittorrent";
  return `${service.slice(0, 1).toUpperCase()}${service.slice(1)}`;
}

function fixedFailureReport(service, entry, failure) {
  const name = serviceLabel(service);
  const request = `GET ${entry.path}`;
  let message;
  if (failure.code === "INVALID_RESPONSE") {
    message = `${request} returned a response Helmsman could not safely accept. Verify the ${name} version, base URL, and reverse-proxy configuration.`;
  } else if (failure.code === "RESPONSE_TOO_LARGE") {
    message = `${request} exceeded Helmsman's bounded response limit. Review ${name} for an unusually large queue or catalog response.`;
  } else if (failure.code === "TIMEOUT") {
    message = `${request} did not respond within the monitoring timeout. Check ${name} load and its network path, then retry.`;
  } else if (failure.code === "UNREACHABLE") {
    message = `${request} could not reach ${name}. Check its address, TLS trust, and network path.`;
  } else if (failure.code === "CHECK_CANCELLED") {
    message = `${request} was cancelled before the monitoring cycle completed. Retry the check or wait for the next cycle.`;
  } else if (failure.status === 401) {
    message = `${request} returned HTTP 401 (Unauthorized). ${name} rejected the stored credential; replace it and retest.`;
  } else if (failure.status === 403) {
    message = `${request} returned HTTP 403 (Forbidden). Grant the credential read permission for this capability, then retest.`;
  } else if (failure.status === 404) {
    message = `${request} returned HTTP 404 (Not Found). Verify the ${name} base URL and version support this read-only capability.`;
  } else if (failure.status === 429) {
    message = `${request} returned HTTP 429 (Too Many Requests). Wait for the next cycle or reduce competing API traffic.`;
  } else if (failure.status !== null && failure.status >= 500) {
    message = `${request} returned HTTP ${failure.status}. ${name} reported a server-side failure; review its logs and retry.`;
  } else if (failure.status !== null) {
    message = `${request} returned HTTP ${failure.status}. ${name} rejected the fixed read-only request; verify its base URL, version, and permissions.`;
  } else {
    message = `${request} failed before Helmsman received a valid response. Verify ${name} reachability and retry.`;
  }
  return {
    severity: entry.importance === "optional" ? "warning" : "error",
    source: sanitizeReportText(`${name} · ${entry.label}`, MAX_REPORT_SOURCE_CODEPOINTS),
    message: sanitizeReportText(message, MAX_REPORT_MESSAGE_CODEPOINTS)
  };
}

function bodyFromObservation(observation, entry) {
  let body = observation.body;
  if (typeof body !== "string") return body;
  if (Buffer.byteLength(body, "utf8") > entry.maxBytes) throw new RangeError("response too large");
  if (entry.responseType !== "json") return body;
  return JSON.parse(body);
}

function serviceState(checks, plan = []) {
  const informational = new Set(plan.filter((entry) => entry.affectsHealth === false).map((entry) => entry.id));
  const healthChecks = checks.filter((check) => !informational.has(check.id));
  if (!healthChecks.length) return checks.length ? "healthy" : "stale";
  if (healthChecks.some((check) => check.state === "auth_required")) return "auth_required";
  if (healthChecks.every((check) => check.state === "stale")) return "stale";
  const healthy = healthChecks.filter((check) => check.state === "healthy").length;
  if (healthy === 0 && healthChecks.some((check) => check.state === "down")) return "down";
  if (healthChecks.some((check) => check.state === "degraded" || (check.state === "down" && check.importance !== "optional"))) {
    return "degraded";
  }
  if (healthChecks.some((check) => check.state === "limited" || check.state === "down" || check.state === "stale")) {
    return "limited";
  }
  return "healthy";
}

function credentialConnectionState(checks, plan) {
  const credentialProofCheckIds = new Set(
    plan.filter((entry) => entry.credentialProof).map((entry) => entry.id)
  );
  const credentialProofChecks = checks.filter((check) => credentialProofCheckIds.has(check.id));
  if (!credentialProofChecks.length) return "unverified";

  // Only endpoints with an authenticated identity or service signature are
  // credential proof. Other protected telemetry may succeed independently.
  if (credentialProofChecks.some((check) => check.code !== "INVALID_RESPONSE"
    && check.status !== null
    && check.status >= 200
    && check.status < 300)) return "connected";

  // Prefer an explicit rejection from a proof endpoint over its coincident
  // transport failures.
  if (credentialProofChecks.some((check) => check.state === "auth_required")) return "auth_required";
  const availabilityFailure = (check) => ["UNREACHABLE", "TIMEOUT"].includes(check.code)
    || (check.code === "HTTP_ERROR" && check.status !== null && check.status >= 500);
  if (credentialProofChecks.every(availabilityFailure)) return "down";
  return "unverified";
}

function checkedTimestamp(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

/**
 * Converts bounded transport observations into a response safe for persistence,
 * logs, and API clients. Raw bodies and transport error messages are discarded.
 */
export function deriveSanitizedServiceProbe(service, observations, options = {}) {
  const id = serviceId(service);
  const checkedAt = checkedTimestamp(options.checkedAt ?? Date.now());
  const plan = buildProbePlan(id, options);
  const supplied = new Map();
  if (Array.isArray(observations)) {
    for (const observation of observations.slice(0, plan.length)) {
      if (record(observation) && typeof observation.id === "string" && !supplied.has(observation.id)) {
        supplied.set(observation.id, observation);
      }
    }
  }

  const metrics = {};
  const inventory = {};
  let version = null;
  const checks = plan.map((entry) => {
    const observation = supplied.get(entry.id);
    const latencyMs = observation && isNumericValue(observation.latencyMs)
      ? boundedInteger(observation.latencyMs, 0, 0, MAX_LATENCY_MS)
      : null;
    const common = {
      id: entry.id,
      label: entry.label,
      importance: entry.importance,
      stages: [...entry.stages],
      latencyMs,
      status: null,
      code: null,
      ...(entry.affectsHealth === false ? { affectsHealth: false } : {})
    };
    if (!observation) return { ...common, state: "stale", code: "NOT_CHECKED" };
    const status = safeHttpStatus(observation.status) ?? (observation.error ? null : 200);
    if (observation.error || status < 200 || status >= 300) {
      const failure = failureFromObservation(observation, entry, status);
      return {
        ...common,
        ...failure,
        reports: [fixedFailureReport(id, entry, failure)]
      };
    }
    try {
      const parsed = parseSuccessfulCheck(id, entry.id, bodyFromObservation(observation, entry), checkedAt);
      Object.assign(metrics, parsed.metrics);
      if (parsed.inventory && typeof parsed.inventory === "object") {
        for (const [key, values] of Object.entries(parsed.inventory)) {
          if (!Array.isArray(values)) continue;
          if (!Array.isArray(inventory[key])) inventory[key] = [];
          inventory[key].push(...values);
        }
      }
      if (parsed.version) version = parsed.version;
      return {
        ...common,
        status,
        state: parsed.state,
        code: parsed.code ?? null,
        metrics: { ...parsed.metrics },
        ...(Array.isArray(parsed.reports) && parsed.reports.length
          ? { reports: parsed.reports.map((report) => ({ ...report })) }
          : {})
      };
    } catch {
      const failure = {
        status,
        state: entry.importance === "optional" ? "limited" : "degraded",
        code: "INVALID_RESPONSE"
      };
      return {
        ...common,
        ...failure,
        reports: [fixedFailureReport(id, entry, failure)]
      };
    }
  });

  if (id === "bazarr"
    && (Object.hasOwn(metrics, "missingMovieSubtitles") || Object.hasOwn(metrics, "missingEpisodeSubtitles"))) {
    metrics.subtitleBacklog = boundedInteger(
      (metrics.missingMovieSubtitles || 0) + (metrics.missingEpisodeSubtitles || 0)
    );
  }
  if (id === "qbittorrent") {
    const transfer = checks.find((check) => check.id === "transfer");
    const torrents = checks.find((check) => check.id === "torrents");
    const active = boundedInteger((metrics.downloading || 0) + (metrics.stalled || 0));
    if (transfer?.state === "limited" && metrics.connectionStatus === "disconnected" && active > 0) {
      transfer.state = "degraded";
    }
    if (torrents?.state === "healthy" && ((metrics.errored || 0) > 0 || (metrics.stalled || 0) > 0)) {
      torrents.state = "degraded";
    }
  }

  const measured = checks.map((check) => check.latencyMs).filter((value) => value !== null);
  const normalizedInventory = normalizeServiceMediaInventory(id, inventory);
  return {
    schema: SERVICE_PROBE_SCHEMA,
    service: id,
    state: serviceState(checks, plan),
    connectionState: credentialConnectionState(checks, plan),
    checkedAt,
    version,
    latencyMs: measured.length ? Math.max(...measured) : null,
    checks,
    metrics,
    inventory: normalizedInventory
  };
}

class ProbeControlError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeControlError";
    this.code = code;
  }
}

function invokeWithDeadline(request, service, entry, outerSignal, targetRevision) {
  const controller = new AbortController();
  let finished = false;
  let timer;
  let removeAbort = () => {};
  const operation = new Promise((resolve, reject) => {
    const settle = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      removeAbort();
      callback(value);
    };
    const cancel = () => {
      controller.abort();
      settle(reject, new ProbeControlError("PROBE_CANCELLED"));
    };
    if (outerSignal?.aborted) {
      cancel();
      return;
    }
    if (outerSignal?.addEventListener) {
      outerSignal.addEventListener("abort", cancel, { once: true });
      removeAbort = () => outerSignal.removeEventListener("abort", cancel);
    }
    timer = setTimeout(() => {
      controller.abort();
      settle(reject, new ProbeControlError("PROBE_TIMEOUT"));
    }, entry.timeoutMs);
    Promise.resolve()
      .then(() => request(service, entry.path, {
        method: entry.method,
        responseType: entry.responseType,
        maxBytes: entry.maxBytes,
        timeoutMs: entry.timeoutMs,
        signal: controller.signal,
        checkId: entry.id,
        credentialRequired: entry.credentialRequired,
        credentialProof: entry.credentialProof,
        purpose: "health-probe",
        ...(targetRevision !== undefined ? { targetRevision } : {})
      }))
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
  return operation;
}

function validSeerrRequestEnrichment(original, enriched) {
  const originalRows = collection(original, ["results", "requests"]);
  const enrichedRows = collection(enriched, ["results", "requests"]);
  return originalRows !== null && enrichedRows !== null && originalRows.length === enrichedRows.length;
}

function transportEnvelope(value) {
  const source = record(value);
  if (source && safeHttpStatus(own(source, "status")) && Object.hasOwn(source, "body")) {
    return {
      status: safeHttpStatus(own(source, "status")),
      body: own(source, "body"),
      latencyMs: isNumericValue(own(source, "latencyMs")) ? own(source, "latencyMs") : undefined
    };
  }
  return { status: 200, body: value };
}

/** Runs every read-only check independently; one rejection never aborts peers.
 * Checks for one service are intentionally sequential so a monitoring cycle
 * cannot overwhelm small NAS services or exhaust the broker request budget.
 */
export async function probeService(service, request, options = {}) {
  const id = serviceId(service);
  if (typeof request !== "function") throw new TypeError("A service probe request transport is required.");
  const plan = buildProbePlan(id, options);
  const clock = typeof options.clock === "function" ? options.clock : () => performance.now();
  const observations = [];
  for (const entry of plan) {
    const started = Number(clock());
    try {
      const response = transportEnvelope(await invokeWithDeadline(
        request,
        id,
        entry,
        options.signal,
        options.targetRevision
      ));
      const finished = Number(clock());
      observations.push({
        id: entry.id,
        status: response.status,
        body: response.body,
        latencyMs: response.latencyMs ?? (Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null)
      });
    } catch (error) {
      const finished = Number(clock());
      observations.push({
        id: entry.id,
        error,
        status: safeHttpStatus(own(error, "status") ?? own(error, "statusCode")),
        timedOut: own(error, "code") === "PROBE_TIMEOUT",
        cancelled: own(error, "code") === "PROBE_CANCELLED",
        latencyMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null
      });
    }
  }
  if (id === "seerr" && typeof options.enrichSeerrRequests === "function" && !options.signal?.aborted) {
    const requestObservation = observations.find((observation) => observation.id === "requests");
    const requestStatus = safeHttpStatus(own(requestObservation, "status"))
      ?? (requestObservation && !requestObservation.error ? 200 : null);
    if (requestObservation && requestStatus >= 200 && requestStatus < 300) {
      try {
        const enriched = await options.enrichSeerrRequests(requestObservation.body, {
          signal: options.signal,
          targetRevision: options.targetRevision
        });
        if (validSeerrRequestEnrichment(requestObservation.body, enriched)) requestObservation.body = enriched;
      } catch {
        // Request metadata is presentation-only. A failed enrichment must not
        // change service health, credential state, or the original inventory.
      }
    }
  }
  return deriveSanitizedServiceProbe(id, observations, {
    ...options,
    checkedAt: options.checkedAt ?? (typeof options.now === "function" ? options.now() : Date.now())
  });
}
