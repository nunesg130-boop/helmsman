import {
  buildMediaSnapshot,
  normalizeServiceMediaInventory
} from "./media-model.mjs";
import { normalizePortainerInventory } from "./portainer-model.mjs";

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 120;
const MAX_SERVICES = 64;
const MAX_INFRASTRUCTURE_TARGETS = 32;
const MAX_INFRASTRUCTURE_SERVICES = 8;
const MAX_CHECKS_PER_SERVICE = 32;
const MAX_REPORTS_PER_CHECK = 12;
const MAX_REPORT_SOURCE_CODE_POINTS = 96;
const MAX_REPORT_MESSAGE_CODE_POINTS = 600;
const REPORT_REDACTION = "[REDACTED]";
const MAX_INCIDENTS = 100;
const MAX_PARALLEL_SERVICE_PROBES = 4;
const MIN_INFRASTRUCTURE_STALE_AFTER_MS = 5 * 60_000;

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SAFE_CODE = /^[A-Z0-9_.:-]{1,64}$/u;
const HEALTH_STATES = Object.freeze([
  "healthy",
  "limited",
  "degraded",
  "down",
  "auth_required",
  "stale"
]);
const CONNECTION_STATES = new Set(["connected", "auth_required", "unverified", "down"]);
const REPORT_SEVERITIES = new Set(["notice", "warning", "error"]);
const STATE_PRIORITY = Object.freeze({
  healthy: 0,
  limited: 1,
  stale: 2,
  degraded: 3,
  auth_required: 4,
  down: 5
});
const IMPACTS = new Set(["optional", "important", "critical"]);
const AUTH_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTHENTICATION_REQUIRED",
  "CREDENTIALS_REJECTED",
  "FORBIDDEN",
  "TOKEN_EXPIRED",
  "UNAUTHORIZED"
]);
const ALLOWED_CODES = new Set([
  ...AUTH_CODES,
  "ABORT_ERR",
  "BAD_GATEWAY",
  "BACKUP_HISTORY_PARTIAL",
  "BACKUP_HISTORY_UNAVAILABLE",
  "BROKER_BUSY",
  "BROKER_STOPPING",
  "CHECK_CANCELLED",
  "CHECK_FAILED",
  "CLUSTER_NOT_QUORATE",
  "CONTAINERS_UNHEALTHY",
  "CONNECTION_REFUSED",
  "CONNECTION_NOT_CONFIGURED",
  "CREDENTIAL_NOT_CONFIGURED",
  "DETAILS_UNAVAILABLE",
  "DNS_FAILED",
  "DNS_MIXED_POLICY",
  "ENDPOINT_UNAVAILABLE",
  "ENVIRONMENT_IDENTITY_MISMATCH",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "FETCH_FAILED",
  "HTTP_ERROR",
  "HEALTH_ERROR",
  "HEALTH_WARNING",
  "HTTPS_REQUIRED",
  "INDEXERS_BLOCKED",
  "INFRASTRUCTURE_LIST_INVALID",
  "INFRASTRUCTURE_LOAD_FAILED",
  "INVENTORY_LIMIT_REACHED",
  "INVALID_RESPONSE",
  "INVALID_TARGET_RESOLUTION",
  "METHOD_NOT_ALLOWED",
  "NETWORK_ERROR",
  "NO_NODES_VISIBLE",
  "NODES_OFFLINE",
  "NOT_CHECKED",
  "PROBE_FAILED",
  "PROBE_CANCELLED",
  "PROBE_TIMEOUT",
  "PORTAINER_ENVIRONMENT_DOWN",
  "PORTAINER_ENVIRONMENT_ERROR",
  "PORTAINER_ENVIRONMENT_PROVISIONING",
  "PORTAINER_ENVIRONMENT_UNKNOWN",
  "PORTAINER_INVENTORY_PARTIAL",
  "PORTAINER_SERVICE_LIST_INVALID",
  "PORTAINER_SERVICE_LOAD_FAILED",
  "QUERY_NOT_ALLOWED",
  "RATE_LIMITED",
  "RECENT_TASK_FAILURES",
  "REQUEST_FAILED",
  "RESOURCE_PRESSURE",
  "RESPONSE_TOO_LARGE",
  "ROUTE_NOT_ALLOWED",
  "SERVICE_LIST_INVALID",
  "SERVICE_LOAD_FAILED",
  "SERVICE_NOT_SUPPORTED",
  "STALE",
  "STORAGE_PRESSURE",
  "STORAGE_UNAVAILABLE",
  "TARGET_NOT_ALLOWED",
  "TARGET_ADDRESS_CHANGED",
  "TASK_HISTORY_PARTIAL",
  "TASK_HISTORY_UNAVAILABLE",
  "TIMEOUT",
  "TLS_ERROR",
  "TLS_CERTIFICATE_INVALID",
  "TLS_CERTIFICATE_UNTRUSTED",
  "TLS_PIN_MISMATCH",
  "UNREACHABLE",
  "UPSTREAM_ERROR",
  "UPSTREAM_CONTENT_REJECTED",
  "UPSTREAM_REDIRECT_REJECTED",
  "UPSTREAM_RESPONSE_FAILED",
  "UPSTREAM_RESPONSE_TOO_LARGE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNREACHABLE",
  "LATEST_BACKUP_FAILED"
]);
const SAFE_METRICS = new Set([
  "active",
  "approvedRequests",
  "availableRequests",
  "blocked",
  "backupFailures24h",
  "backupTasksObserved",
  "completed",
  "containerTotal",
  "containerRunning",
  "containerRestarting",
  "containerStopped",
  "containerUnhealthy",
  "downloading",
  "diskFreeBytes",
  "diskTotalBytes",
  "downloadSpeedBytes",
  "downloadSpeedBps",
  "errored",
  "environmentOffline",
  "environmentOnline",
  "environmentTotal",
  "failed",
  "failedTasks24h",
  "healthErrors",
  "healthNotices",
  "healthWarnings",
  "importsBlocked",
  "indexersBlocked",
  "missing",
  "missingEpisodeSubtitles",
  "missingMovieSubtitles",
  "guestRunning",
  "guestStopped",
  "guestTotal",
  "lastBackupFailureAgeSeconds",
  "lastBackupSuccessAgeSeconds",
  "nodeCpuUsagePercent",
  "nodeDiskTotalBytes",
  "nodeDiskUsedBytes",
  "nodeMemoryTotalBytes",
  "nodeMemoryUsedBytes",
  "nodeOffline",
  "nodeOnline",
  "nodeTotal",
  "paused",
  "pendingRequests",
  "processingRequests",
  "queued",
  "queueFailed",
  "queueStalled",
  "queueTotal",
  "stalled",
  "storageAvailable",
  "storageTotal",
  "storageTotalBytes",
  "storageUnavailable",
  "storageUsagePercent",
  "storageUsedBytes",
  "stackTotal",
  "subtitleBacklog",
  "total",
  "totalRequests",
  "torrentsTotal",
  "taskRecordsObserved",
  "uploadSpeedBytes",
  "uploadSpeedBps",
  "virtualMachineTotal",
  "waiting"
]);

const DEFAULT_PIPELINE_STAGES = Object.freeze([
  Object.freeze({ id: "requests", label: "Requests", services: Object.freeze(["seerr"]) }),
  Object.freeze({ id: "search", label: "Search", services: Object.freeze(["prowlarr", "radarr", "sonarr"]) }),
  Object.freeze({ id: "downloads", label: "Downloads", services: Object.freeze(["qbittorrent"]) }),
  Object.freeze({ id: "imports", label: "Imports", services: Object.freeze(["radarr", "sonarr"]) }),
  Object.freeze({ id: "library", label: "Library", services: Object.freeze(["jellyfin"]) }),
  Object.freeze({ id: "subtitles", label: "Subtitles", services: Object.freeze(["bazarr"]) })
]);

const SERVICE_LABELS = Object.freeze({
  bazarr: "Bazarr",
  jellyfin: "Jellyfin",
  prowlarr: "Prowlarr",
  qbittorrent: "qBittorrent",
  radarr: "Radarr",
  seerr: "Seerr",
  sonarr: "Sonarr"
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function nowMs(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("The monitoring clock returned an invalid time.");
  return Math.round(milliseconds);
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function validIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && iso(milliseconds) === value ? value : null;
}

function identifier(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return IDENTIFIER.test(normalized) ? normalized : fallback;
}

function code(value, fallback = "CHECK_FAILED") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toUpperCase();
  return SAFE_CODE.test(normalized) && ALLOWED_CODES.has(normalized) ? normalized : fallback;
}

function httpStatus(value) {
  const numeric = typeof value === "string" && /^\d{3}$/u.test(value) ? Number(value) : value;
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
}

function latency(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 86_400_000) : null;
}

function boundedNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
}

function normalizeState(value, fallback = "stale") {
  const aliases = {
    connected: "healthy",
    ok: "healthy",
    offline: "down",
    unavailable: "down",
    "auth-required": "auth_required"
  };
  const selected = aliases[value] || value;
  return HEALTH_STATES.includes(selected) ? selected : fallback;
}

function normalizeConnectionState(value, fallback = "unverified") {
  return CONNECTION_STATES.has(value) ? value : fallback;
}

function worstState(states, fallback = "stale") {
  if (!states.length) return fallback;
  let selected = normalizeState(states[0], fallback);
  for (const state of states.slice(1)) {
    if (STATE_PRIORITY[state] > STATE_PRIORITY[selected]) selected = state;
  }
  return selected;
}

function normalizeImpact(value) {
  if (value === "core") return "critical";
  return IMPACTS.has(value) ? value : "important";
}

function failureState(input, impact, normalizedCode, normalizedStatus) {
  const explicit = normalizeState(input.state, null);
  if (explicit && explicit !== "healthy") return explicit;
  if (input.authRequired === true
    || normalizedStatus === 401
    || normalizedStatus === 403
    || AUTH_CODES.has(normalizedCode)) return "auth_required";
  if (impact === "optional") return "limited";
  if (impact === "critical") return "down";
  return "degraded";
}

function normalizeMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const key of SAFE_METRICS) {
    const normalized = boundedNumber(value[key]);
    if (normalized !== null && normalized >= 0) output[key] = normalized;
  }
  if (["connected", "firewalled", "disconnected", "unknown"].includes(value.connectionStatus)) {
    output.connectionStatus = value.connectionStatus;
  }
  return output;
}

function safeVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^(?=.*\d)[vV]?[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(text) ? text : null;
}

function normalizeStages(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => identifier(entry, null)).filter(Boolean))].slice(0, 8);
}

function truncateReportText(value, maximumCodePoints) {
  const points = Array.from(value);
  if (points.length <= maximumCodePoints) return value;
  return `${points.slice(0, maximumCodePoints - 1).join("")}\u2026`;
}

function redactOpaqueReportTokens(value) {
  return value.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, (candidate) => {
    const core = candidate.replace(/={1,2}$/u, "");
    const unique = new Set(core.toLowerCase()).size;
    const hasSeparator = /[_+/-]/u.test(core);
    const mixedClasses = /[a-z]/u.test(core) && /[A-Z]/u.test(core)
      || /[A-Za-z]/u.test(core) && /\d/u.test(core);
    return unique >= 10 && (hasSeparator || mixedClasses) ? REPORT_REDACTION : candidate;
  });
}

function reportText(value, maximumCodePoints) {
  if (typeof value !== "string") return null;
  let normalized;
  try {
    // Bound regex work for hostile probe implementations. Genuine probe
    // reports are already constrained to these final limits.
    normalized = value.slice(0, maximumCodePoints * 8).normalize("NFKC");
  } catch {
    return null;
  }
  normalized = normalized
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu, `$1${REPORT_REDACTION}@`)
    .replace(/\b((?:authorization|proxy-authorization)\s*(?::|=)\s*)(?:bearer|basic)\s+[^\s,;]+/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/giu, `$1${REPORT_REDACTION}`)
    .replace(/((?:["']?(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|secret|credential|auth|cookie|set-cookie|session(?:id)?)["']?)\s*(?::|=)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|secret|credential|session(?:id)?)["']?)\s+(?:is|was)\s+)(?:["'][^"']*["']|(?!(?:missing|invalid|expired|rejected|required|unset|empty|incorrect|unavailable|changed|updated|removed|accepted|denied|wrong|disabled|enabled|configured|not)\b)[^\s,;&}]+)/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b(?:qbt_|sk-|eyJ)[A-Za-z0-9._~+/-]{10,}={0,2}/gu, REPORT_REDACTION)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      REPORT_REDACTION);
  normalized = redactOpaqueReportTokens(normalized).replace(/\s+/gu, " ").trim();
  return normalized ? truncateReportText(normalized, maximumCodePoints) : null;
}

function normalizeReports(value) {
  let candidates;
  try {
    if (!Array.isArray(value)) return [];
    candidates = value.slice(0, MAX_REPORTS_PER_CHECK);
  } catch {
    return [];
  }
  const reports = [];
  for (const candidate of candidates) {
    try {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    } catch {
      continue;
    }
    const rawSeverity = own(candidate, "severity");
    const severity = typeof rawSeverity === "string" ? rawSeverity.trim().toLowerCase() : "";
    if (!REPORT_SEVERITIES.has(severity)) continue;
    const source = reportText(own(candidate, "source"), MAX_REPORT_SOURCE_CODE_POINTS);
    const message = reportText(own(candidate, "message"), MAX_REPORT_MESSAGE_CODE_POINTS);
    if (!source || !message) continue;
    reports.push({ severity, source, message });
  }
  return reports;
}

function checkFromResult(input, index, serviceId, checkedAt, measuredLatency) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const capability = identifier(source.id ?? source.capability, `check-${index + 1}`);
  const impact = normalizeImpact(source.impact ?? source.importance);
  const normalizedStatus = httpStatus(source.status ?? source.httpStatus);
  const normalizedCode = source.ok === true ? null : code(source.code);
  const ok = source.ok === true
    || (source.ok === undefined && normalizeState(source.state, "stale") === "healthy");
  const state = ok
    ? "healthy"
    : failureState(source, impact, normalizedCode, normalizedStatus);
  const failedHttpStatus = normalizedStatus !== null
    && (normalizedStatus < 200 || normalizedStatus >= 300)
    ? normalizedStatus
    : null;
  const reports = normalizeReports(own(source, "reports"));
  return {
    id: capability,
    state,
    ok,
    impact,
    code: ok ? null : normalizedCode,
    httpStatus: ok ? null : failedHttpStatus,
    latencyMs: latency(source.latencyMs) ?? measuredLatency,
    checkedAt,
    stages: normalizeStages(source.stages ?? (source.stage ? [source.stage] : [])),
    metrics: normalizeMetrics(source.metrics),
    service: serviceId,
    ...(source.affectsHealth === false ? { affectsHealth: false } : {}),
    ...(reports.length ? { reports } : {})
  };
}

function normalizeProbeResult(serviceId, result, checkedAt, measuredLatency, targetRevision = null) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const resultCheckedAt = validIso(source.checkedAt) || checkedAt;
  const rawChecks = Array.isArray(source.checks) && source.checks.length
    ? source.checks.slice(0, MAX_CHECKS_PER_SERVICE)
    : [{
        id: source.capability || "api",
        ok: source.ok,
        state: source.state,
        impact: source.impact,
        code: source.code,
        status: source.status ?? source.httpStatus,
        authRequired: source.authRequired,
        latencyMs: source.latencyMs,
        stages: source.stages,
        metrics: source.metrics,
        reports: own(source, "reports"),
        affectsHealth: source.affectsHealth
      }];
  const seen = new Set();
  const checks = [];
  for (let index = 0; index < rawChecks.length; index += 1) {
    const normalized = checkFromResult(rawChecks[index], index, serviceId, resultCheckedAt, measuredLatency);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    checks.push(normalized);
  }
  const state = normalizeState(source.state, null) || worstState(checks.map((check) => check.state));
  return {
    id: serviceId,
    targetRevision: typeof targetRevision === "string" && UUID.test(targetRevision) ? targetRevision : null,
    label: SERVICE_LABELS[serviceId] || serviceId,
    state,
    connectionState: normalizeConnectionState(source.connectionState),
    latencyMs: latency(source.latencyMs) ?? measuredLatency,
    checkedAt: resultCheckedAt,
    version: safeVersion(source.version),
    checks,
    metrics: normalizeMetrics(source.metrics),
    inventory: normalizeServiceMediaInventory(serviceId, own(source, "inventory"))
  };
}

function safeDisplayText(value, fallback, maximum = 80) {
  if (typeof value !== "string") return fallback;
  const normalized = reportText(value, maximum);
  return normalized || fallback;
}

function safeInventoryNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = boundedNumber(value);
  return normalized === null || normalized < 0 ? null : Math.min(normalized, maximum);
}

function safeInventoryPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function normalizeProxmoxDiscovery(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = ["standalone", "cluster", "unknown"].includes(source.kind) ? source.kind : "unknown";
  const rawNames = Array.isArray(source.nodeNames) ? source.nodeNames.slice(0, 128) : [];
  const nodeNames = [...new Set(rawNames.map((entry) => safeDisplayText(entry, "", 64)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  return {
    kind,
    name: safeDisplayText(source.name, kind === "cluster" ? "Proxmox cluster" : "Proxmox environment", 80),
    clusterName: kind === "cluster" ? safeDisplayText(source.clusterName, "Proxmox cluster", 80) : null,
    quorate: kind === "cluster" && typeof source.quorate === "boolean" ? source.quorate : null,
    nodeNames,
    localNode: safeDisplayText(source.localNode, "", 64) || null
  };
}

function normalizeProxmoxEndpoints(value, selectedEndpointId) {
  const candidates = Array.isArray(value) ? value.slice(0, 25) : [];
  const endpoints = [];
  const seen = new Set();
  for (const source of candidates) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const id = typeof source.id === "string" ? source.id.toLowerCase() : "";
    if (!UUID.test(id) || seen.has(id)) continue;
    seen.add(id);
    endpoints.push({
      id,
      label: safeDisplayText(source.label, endpoints.length ? `Endpoint ${endpoints.length + 1}` : "Primary endpoint", 80),
      state: normalizeState(source.state, "stale"),
      connectionState: normalizeConnectionState(source.connectionState),
      latencyMs: latency(source.latencyMs),
      checkedAt: validIso(source.checkedAt),
      version: safeVersion(source.version),
      selected: id === selectedEndpointId || source.selected === true,
      code: source.code ? code(source.code) : null
    });
  }
  return endpoints;
}

function normalizeProxmoxNodes(value, environmentVersion, discovery) {
  const candidates = Array.isArray(value) ? value.slice(0, 128) : [];
  const nodes = [];
  const seen = new Set();
  for (const source of candidates) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const name = safeDisplayText(source.name, "", 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const status = ["online", "offline", "unknown"].includes(source.status) ? source.status : "unknown";
    const local = source.local === true || discovery.localNode === name;
    nodes.push({
      id: name,
      name,
      status,
      local,
      cpuPercent: safeInventoryPercent(source.cpuPercent),
      cpuCores: safeInventoryNumber(source.cpuCores, 65_536),
      memoryUsedBytes: safeInventoryNumber(source.memoryUsedBytes),
      memoryTotalBytes: safeInventoryNumber(source.memoryTotalBytes),
      rootDiskUsedBytes: safeInventoryNumber(source.rootDiskUsedBytes),
      rootDiskTotalBytes: safeInventoryNumber(source.rootDiskTotalBytes),
      uptimeSeconds: safeInventoryNumber(source.uptimeSeconds),
      version: safeVersion(source.version) || (local ? environmentVersion : null),
      workloadCount: safeInventoryNumber(source.workloadCount, 100_000) || 0,
      runningWorkloadCount: safeInventoryNumber(source.runningWorkloadCount, 100_000) || 0,
      virtualMachineCount: safeInventoryNumber(source.virtualMachineCount, 100_000) || 0,
      containerCount: safeInventoryNumber(source.containerCount, 100_000) || 0
    });
  }
  nodes.sort((left, right) => left.name.localeCompare(right.name));
  return nodes;
}

function normalizeProxmoxWorkloads(value) {
  const candidates = Array.isArray(value) ? value.slice(0, 5_000) : [];
  const workloads = [];
  const seen = new Set();
  for (const source of candidates) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const vmid = safeInventoryNumber(source.vmid, 999_999_999);
    const type = source.type === "qemu" ? "qemu" : source.type === "lxc" ? "lxc" : null;
    const node = safeDisplayText(source.node, "", 64) || null;
    if (!vmid || !type) continue;
    const id = `${node || "unassigned"}:${type}:${vmid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = Array.isArray(source.tags)
      ? [...new Set(source.tags.slice(0, 16).map((entry) => safeDisplayText(entry, "", 32)).filter(Boolean))]
      : [];
    const backupSource = source.backup && typeof source.backup === "object" && !Array.isArray(source.backup)
      ? source.backup
      : null;
    const backupStatus = backupSource && ["success", "failed"].includes(backupSource.status)
      ? backupSource.status
      : null;
    workloads.push({
      id,
      vmid,
      type,
      kind: type === "qemu" ? "VM" : "LXC",
      name: safeDisplayText(source.name, `${type === "qemu" ? "VM" : "LXC"} ${vmid}`, 96),
      node,
      status: ["running", "stopped", "paused", "suspended"].includes(source.status) ? source.status : "unknown",
      template: source.template === true,
      cpuPercent: safeInventoryPercent(source.cpuPercent),
      cpuCores: safeInventoryNumber(source.cpuCores, 65_536),
      memoryUsedBytes: safeInventoryNumber(source.memoryUsedBytes),
      memoryTotalBytes: safeInventoryNumber(source.memoryTotalBytes),
      diskUsedBytes: safeInventoryNumber(source.diskUsedBytes),
      diskTotalBytes: safeInventoryNumber(source.diskTotalBytes),
      uptimeSeconds: safeInventoryNumber(source.uptimeSeconds),
      lock: safeDisplayText(source.lock, "", 32) || null,
      tags,
      backup: backupStatus ? {
        status: backupStatus,
        endedAt: validIso(backupSource.endedAt),
        ageSeconds: safeInventoryNumber(backupSource.ageSeconds)
      } : null
    });
  }
  workloads.sort((left, right) => left.vmid - right.vmid || left.type.localeCompare(right.type));
  return workloads;
}

function normalizeProxmoxStorage(value) {
  const candidates = Array.isArray(value) ? value.slice(0, 1_000) : [];
  return candidates.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const name = safeDisplayText(source.name, "", 80);
    const node = safeDisplayText(source.node, "cluster", 64);
    if (!name) return [];
    return [{
      id: `${node}:${name}`,
      name,
      node,
      status: safeDisplayText(source.status, "unknown", 32),
      type: safeDisplayText(source.type, "", 40) || null,
      shared: source.shared === true,
      usedBytes: safeInventoryNumber(source.usedBytes),
      totalBytes: safeInventoryNumber(source.totalBytes),
      usagePercent: safeInventoryPercent(source.usagePercent)
    }];
  }).sort((left, right) => left.node.localeCompare(right.node) || left.name.localeCompare(right.name));
}

function normalizeProxmoxActivity(value) {
  const candidates = Array.isArray(value) ? value.slice(0, 100) : [];
  return candidates.flatMap((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const type = safeDisplayText(source.type, "Task", 64);
    const node = safeDisplayText(source.node, "", 64) || null;
    const vmid = safeInventoryNumber(source.vmid, 999_999_999);
    const endedAt = validIso(source.endedAt);
    return [{
      id: `${type}:${node || "cluster"}:${vmid || 0}:${endedAt || index}`,
      type,
      node,
      vmid,
      status: source.status === "success" ? "success" : "failed",
      endedAt,
      ageSeconds: safeInventoryNumber(source.ageSeconds)
    }];
  });
}

function normalizeInfrastructureTargetResult(target, result, checkedAt, measuredLatency) {
  const targetId = String(target.id || "").toLowerCase();
  const monitorId = `proxmox-${targetId}`;
  const normalized = normalizeProbeResult(monitorId, result, checkedAt, measuredLatency);
  const sourceChecks = Array.isArray(result?.checks) ? result.checks.slice(0, MAX_CHECKS_PER_SERVICE) : [];
  const sourceLabels = new Map();
  for (const source of sourceChecks) {
    const id = identifier(own(source, "id") ?? own(source, "capability"), null);
    if (!id || sourceLabels.has(id)) continue;
    sourceLabels.set(id, safeDisplayText(own(source, "label"), id, 80));
  }
  const capabilities = normalized.checks.map(({ service: _service, stages: _stages, ...capability }) => ({
    ...capability,
    label: sourceLabels.get(capability.id) || capability.id
  }));
  const reports = capabilities.flatMap((capability) => (
    (capability.reports || []).map((entry) => ({ capability: capability.id, ...entry }))
  )).slice(0, MAX_REPORTS_PER_CHECK);
  const discovery = normalizeProxmoxDiscovery(result?.discovery);
  const selectedEndpointId = typeof result?.selectedEndpointId === "string" && UUID.test(result.selectedEndpointId)
    ? result.selectedEndpointId.toLowerCase()
    : null;
  const inventory = result?.inventory && typeof result.inventory === "object" && !Array.isArray(result.inventory)
    ? result.inventory
    : {};
  return {
    ...normalized,
    targetId,
    targetRevision: typeof target?.targetRevision === "string" && UUID.test(target.targetRevision)
      ? target.targetRevision
      : null,
    type: "proxmox",
    displayName: safeDisplayText(target.displayName, "Proxmox", 80),
    capabilities,
    reports,
    discovery,
    selectedEndpointId,
    endpoints: normalizeProxmoxEndpoints(result?.endpoints, selectedEndpointId),
    nodes: normalizeProxmoxNodes(inventory.nodes, normalized.version, discovery),
    workloads: normalizeProxmoxWorkloads(inventory.workloads),
    storage: normalizeProxmoxStorage(inventory.storage),
    activity: normalizeProxmoxActivity(inventory.activity)
  };
}

function publicInfrastructureTarget(result) {
  return {
    id: result.targetId,
    targetRevision: result.targetRevision,
    type: result.type,
    displayName: result.displayName,
    state: result.state,
    connectionState: result.connectionState,
    latencyMs: result.latencyMs,
    checkedAt: result.checkedAt,
    version: result.version,
    capabilities: result.capabilities,
    metrics: result.metrics,
    discovery: result.discovery,
    selectedEndpointId: result.selectedEndpointId,
    endpoints: result.endpoints,
    nodes: result.nodes,
    workloads: result.workloads,
    storage: result.storage,
    activity: result.activity,
    ...(result.reports.length ? { reports: result.reports } : {})
  };
}

function normalizeInfrastructureServiceResult(service, result, checkedAt, measuredLatency) {
  const serviceId = String(service.id || "").toLowerCase();
  const type = service?.type === "loki" ? "loki" : "portainer";
  const monitorId = `${type}-${serviceId}`;
  const normalized = normalizeProbeResult(monitorId, result, checkedAt, measuredLatency);
  const sourceChecks = Array.isArray(result?.checks) ? result.checks.slice(0, MAX_CHECKS_PER_SERVICE) : [];
  const sourceLabels = new Map();
  for (const source of sourceChecks) {
    const id = identifier(own(source, "id") ?? own(source, "capability"), null);
    if (!id || sourceLabels.has(id)) continue;
    sourceLabels.set(id, safeDisplayText(own(source, "label"), id, 120));
  }
  const capabilities = normalized.checks.map(({ service: _service, stages: _stages, ...capability }) => ({
    ...capability,
    label: sourceLabels.get(capability.id) || capability.id
  }));
  const reports = capabilities.flatMap((capability) => (
    (capability.reports || []).map((entry) => ({ capability: capability.id, ...entry }))
  )).slice(0, MAX_REPORTS_PER_CHECK);
  return {
    ...normalized,
    serviceId,
    targetRevision: typeof service?.targetRevision === "string" && UUID.test(service.targetRevision)
      ? service.targetRevision
      : null,
    type,
    displayName: safeDisplayText(service.displayName, type === "loki" ? "Loki" : "Portainer", 80),
    capabilities,
    reports,
    inventory: type === "portainer" ? normalizePortainerInventory(result?.inventory) : {}
  };
}

function publicInfrastructureService(result) {
  return {
    id: result.serviceId,
    targetRevision: result.targetRevision,
    type: result.type,
    displayName: result.displayName,
    state: result.state,
    connectionState: result.connectionState,
    latencyMs: result.latencyMs,
    checkedAt: result.checkedAt,
    version: result.version,
    capabilities: result.capabilities,
    metrics: result.metrics,
    inventory: result.inventory,
    ...(result.reports.length ? { reports: result.reports } : {})
  };
}

function failedProbeResult(serviceId, error, checkedAt, measuredLatency) {
  return normalizeProbeResult(serviceId, {
    ok: false,
    state: "down",
    connectionState: "down",
    impact: "critical",
    code: code(error?.code, "PROBE_FAILED"),
    latencyMs: measuredLatency
  }, checkedAt, measuredLatency);
}

function pipelineDefinitions(value) {
  const source = value === undefined ? DEFAULT_PIPELINE_STAGES : value;
  if (!Array.isArray(source) || !source.length || source.length > 16) {
    throw new TypeError("Pipeline stages must be a non-empty array with at most 16 entries.");
  }
  const seen = new Set();
  return source.map((stage, index) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      throw new TypeError("Each pipeline stage must be an object.");
    }
    const id = identifier(stage.id, null);
    if (!id || seen.has(id)) throw new TypeError("Pipeline stage identifiers must be unique safe identifiers.");
    seen.add(id);
    const services = Array.isArray(stage.services)
      ? [...new Set(stage.services.map((service) => identifier(service, null)).filter(Boolean))]
      : [];
    if (!services.length) throw new TypeError(`Pipeline stage ${index + 1} must name at least one service.`);
    const label = typeof stage.label === "string" && /^[A-Za-z0-9 -]{1,40}$/u.test(stage.label)
      ? stage.label
      : id;
    return { id, label, services };
  });
}

function allowedServiceIds(value) {
  const source = value === undefined ? Object.keys(SERVICE_LABELS) : value;
  if (!Array.isArray(source) || !source.length || source.length > MAX_SERVICES) {
    throw new TypeError("serviceIds must be a non-empty array with at most 64 entries.");
  }
  const normalized = source.map((entry) => identifier(entry, null));
  if (normalized.some((entry) => !entry)) throw new TypeError("serviceIds contains an invalid service identifier.");
  return new Set(normalized);
}

function pipelineSnapshot(definitions, services) {
  const stages = definitions.map((definition) => {
    const matchingServices = services.filter((service) => definition.services.includes(service.id));
    const candidates = matchingServices.flatMap((service) => {
      const explicit = service.checks.filter((check) => check.stages.length);
      if (!explicit.length) return service.checks.filter((check) => check.affectsHealth !== false);
      return explicit.filter((check) => check.stages.includes(definition.id) && check.affectsHealth !== false);
    });
    const state = candidates.length ? worstState(candidates.map((check) => check.state)) : "stale";
    const metrics = {};
    for (const service of matchingServices) {
      if (!service.checks.some((check) => check.stages.length)) {
        for (const [key, value] of Object.entries(service.metrics)) {
          if (typeof value === "number") metrics[key] = (metrics[key] || 0) + value;
          else if (metrics[key] === undefined) metrics[key] = value;
        }
      }
    }
    for (const check of candidates) {
      for (const [key, value] of Object.entries(check.metrics)) {
        if (typeof value === "number") {
          metrics[key] = (typeof metrics[key] === "number" ? metrics[key] : 0) + value;
        } else if (metrics[key] === undefined) metrics[key] = value;
      }
    }
    return {
      id: definition.id,
      label: definition.label,
      state,
      serviceCount: matchingServices.length,
      failingCheckCount: candidates.filter((check) => check.state !== "healthy").length,
      metrics
    };
  });
  const activeStages = stages.filter((stage) => stage.serviceCount > 0);
  return { state: worstState(activeStages.map((stage) => stage.state)), stages };
}

function safeIncident(raw, fallbackTime, recent = false) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const service = identifier(raw.service, null);
  const capability = identifier(raw.capability, null);
  if (!service || !capability) return null;
  const state = normalizeState(raw.state, recent ? "healthy" : "degraded");
  const normalizedCode = raw.code === null ? null : code(raw.code);
  const normalizedStatus = httpStatus(raw.status ?? raw.httpStatus);
  const firstSeen = validIso(raw.firstSeen) || fallbackTime;
  const lastSeen = validIso(raw.lastSeen) || firstSeen;
  const occurrenceCount = Number.isSafeInteger(raw.occurrenceCount) && raw.occurrenceCount > 0
    ? Math.min(raw.occurrenceCount, Number.MAX_SAFE_INTEGER)
    : 1;
  const output = {
    id: `${service}:${capability}:${normalizedCode || "RECOVERED"}:${firstSeen}`,
    service,
    capability,
    state,
    impact: normalizeImpact(raw.impact),
    code: normalizedCode,
    httpStatus: normalizedStatus,
    firstSeen,
    lastSeen,
    occurrenceCount
  };
  if (recent) output.recoveredAt = validIso(raw.recoveredAt ?? raw.at) || fallbackTime;
  return output;
}

function incidentsFromEngine(engine, at) {
  if (!engine || typeof engine.snapshot !== "function") return { open: [], recent: [] };
  let raw;
  try {
    raw = engine.snapshot({ at, applyStaleness: true });
  } catch {
    return { open: [], recent: [] };
  }
  const openSource = Array.isArray(raw?.incidents) ? raw.incidents : Array.isArray(raw?.open) ? raw.open : [];
  const recentSource = Array.isArray(raw?.recentRecoveries)
    ? raw.recentRecoveries
    : Array.isArray(raw?.recent)
      ? raw.recent
      : [];
  return {
    open: openSource.slice(0, MAX_INCIDENTS).map((entry) => safeIncident(entry, at)).filter(Boolean),
    recent: recentSource.slice(0, MAX_INCIDENTS).map((entry) => safeIncident(entry, at, true)).filter(Boolean)
  };
}

function mediaIncidentCount(incidents) {
  if (!Array.isArray(incidents?.open)) return 0;
  return incidents.open.filter((incident) => (
    Object.hasOwn(SERVICE_LABELS, incident.service)
      || (incident.service === "helmsman" && incident.capability === "service_loader")
  )).length;
}

function eventsFromEngine(engine) {
  if (!engine || typeof engine.snapshot !== "function") return [];
  let source;
  try {
    source = engine.snapshot({ applyStaleness: false })?.recentTransitions;
  } catch {
    return [];
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_INCIDENTS).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const service = identifier(entry.service, null);
    const capability = identifier(entry.capability, null);
    const at = validIso(entry.at);
    const type = ["opened", "escalated", "deescalated", "superseded", "recovered", "retired"].includes(entry.type)
      ? entry.type
      : null;
    if (!service || !capability || !at || !type) return [];
    return [{
      type,
      at,
      service,
      capability,
      state: normalizeState(entry.state),
      code: entry.code === null ? null : code(entry.code),
      httpStatus: httpStatus(entry.status),
      occurrenceCount: Number.isSafeInteger(entry.occurrenceCount) && entry.occurrenceCount > 0
        ? Math.min(entry.occurrenceCount, Number.MAX_SAFE_INTEGER)
        : 1
    }];
  });
}

function workloadSnapshot(services) {
  const metrics = Object.fromEntries(services.map((service) => [service.id, service.metrics]));
  const arr = [metrics.radarr || {}, metrics.sonarr || {}];
  const sum = (key) => arr.reduce((total, value) => total + (Number(value[key]) || 0), 0);
  return {
    pendingRequests: Number(metrics.seerr?.pendingRequests) || 0,
    queued: sum("queueTotal"),
    downloading: Number(metrics.qbittorrent?.downloading) || 0,
    stalled: (Number(metrics.qbittorrent?.stalled) || 0) + sum("queueStalled"),
    failed: (Number(metrics.qbittorrent?.errored) || 0) + sum("queueFailed") + sum("importsBlocked"),
    subtitleBacklog: Number(metrics.bazarr?.subtitleBacklog) || 0
  };
}

class BasicIncidentAdapter {
  #open = new Map();
  #pending = new Map();
  #recent = [];
  #threshold;

  constructor(threshold = 2) {
    this.#threshold = threshold;
  }

  recordResult(result) {
    const key = `${result.service}/${result.capability}`;
    const existing = this.#open.get(key);
    if (result.ok) {
      this.#pending.delete(key);
      if (existing) {
        this.#open.delete(key);
        this.#recent.unshift({ ...existing, state: "healthy", recoveredAt: result.checkedAt });
        if (this.#recent.length > MAX_INCIDENTS) this.#recent.length = MAX_INCIDENTS;
      }
      return;
    }
    if (existing) {
      existing.lastSeen = result.checkedAt;
      existing.occurrenceCount += 1;
      existing.state = result.state;
      existing.code = result.code;
      existing.status = result.status;
      return;
    }
    const pending = this.#pending.get(key);
    const count = pending?.code === result.code && pending?.status === result.status ? pending.count + 1 : 1;
    const firstSeen = count > 1 ? pending.firstSeen : result.checkedAt;
    if (count < this.#threshold) {
      this.#pending.set(key, { count, firstSeen, code: result.code, status: result.status });
      return;
    }
    this.#pending.delete(key);
    this.#open.set(key, {
      id: key.replaceAll("/", ":"),
      service: result.service,
      capability: result.capability,
      state: result.state,
      impact: result.impact,
      code: result.code,
      status: result.status,
      firstSeen,
      lastSeen: result.checkedAt,
      occurrenceCount: count
    });
  }

  retireService(serviceValue) {
    const service = identifier(serviceValue, null);
    if (!service) throw new TypeError("A retired service must use a safe identifier.");
    const prefix = `${service}/`;
    let retired = 0;
    for (const key of [...this.#open.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.#open.delete(key);
      retired += 1;
    }
    for (const key of [...this.#pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.#pending.delete(key);
    }
    return retired;
  }

  snapshot() {
    return { incidents: [...this.#open.values()], recentRecoveries: [...this.#recent] };
  }
}

function incidentObserver(engine) {
  if (typeof engine?.recordResult === "function") return (result) => engine.recordResult(result);
  if (typeof engine?.observe === "function") return (result) => engine.observe(result);
  throw new TypeError("The incident engine must expose recordResult(result) or observe(result).");
}

function incidentRetirer(engine) {
  return typeof engine?.retireService === "function"
    ? (service, at) => engine.retireService(service, at)
    : () => 0;
}

function historyEntry(snapshot) {
  const serviceStates = Object.fromEntries(HEALTH_STATES.map((state) => [
    state,
    snapshot.services.filter((service) => service.state === state).length
  ]));
  return {
    generatedAt: snapshot.generatedAt,
    overallState: snapshot.overall.state,
    // History backs the Media workspace trend. Infrastructure incidents stay
    // available in the global incident collection, but must not distort this
    // established media-only summary.
    openIncidentCount: snapshot.overall.openIncidentCount,
    serviceStates,
    pipelineStates: Object.fromEntries(snapshot.pipeline.stages.map((stage) => [stage.id, stage.state]))
  };
}

function emptySnapshot(definitions) {
  const generatedAt = null;
  const media = buildMediaSnapshot([], new Date(0).toISOString());
  media.generatedAt = null;
  return {
    version: 1,
    generatedAt,
    overall: {
      state: "stale",
      serviceCount: 0,
      affectedServiceCount: 0,
      openIncidentCount: 0,
      code: "NOT_YET_CHECKED"
    },
    services: [],
    pipeline: {
      state: "stale",
      stages: definitions.map(({ id, label }) => ({
        id,
        label,
        state: "stale",
        serviceCount: 0,
        failingCheckCount: 0,
        metrics: {}
      }))
    },
    infrastructure: {
      state: "stale",
      environmentCount: 0,
      targetCount: 0,
      affectedTargetCount: 0,
      serviceCount: 0,
      affectedServiceCount: 0,
      code: null,
      environments: [],
      targets: [],
      services: [],
      portainer: [],
      loki: []
    },
    incidents: { open: [], recent: [] },
    media,
    workload: {},
    events: [],
    history: []
  };
}

export class OperationsMonitor {
  #loadServices;
  #probe;
  #loadInfrastructureTargets;
  #probeInfrastructure;
  #loadInfrastructureServices;
  #probeInfrastructureService;
  #hasInfrastructureServiceMonitoring;
  #incidentEngine;
  #observeIncident;
  #retireIncident;
  #clock;
  #intervalMs;
  #historyLimit;
  #serviceIds;
  #pipelineDefinitions;
  #setTimer;
  #clearTimer;
  #timer = null;
  #running = false;
  #inFlight = null;
  #refreshRequested = false;
  #controller = null;
  #listeners = new Set();
  #history = [];
  #monitoredServiceIds = new Set();
  #monitoredInfrastructureIds = new Set();
  #monitoredInfrastructureServiceIds = new Set();
  #infrastructureCache = new Map();
  #snapshot;

  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Monitoring options must be an object.");
    }
    if (typeof options.loadServices !== "function") throw new TypeError("loadServices must be a function.");
    if (typeof options.probe !== "function") throw new TypeError("probe must be a function.");
    const hasInfrastructureLoader = typeof options.loadInfrastructureTargets === "function";
    const hasInfrastructureProbe = typeof options.probeInfrastructure === "function";
    if (hasInfrastructureLoader !== hasInfrastructureProbe) {
      throw new TypeError("Infrastructure monitoring requires both loadInfrastructureTargets and probeInfrastructure.");
    }
    const hasInfrastructureServiceLoader = typeof options.loadInfrastructureServices === "function";
    const hasInfrastructureServiceProbe = typeof options.probeInfrastructureService === "function";
    if (hasInfrastructureServiceLoader !== hasInfrastructureServiceProbe) {
      throw new TypeError("Infrastructure service monitoring requires both loadInfrastructureServices and probeInfrastructureService.");
    }
    const intervalMs = options.intervalMs === undefined ? DEFAULT_INTERVAL_MS : options.intervalMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      throw new TypeError("Polling interval must be between 30000 and 60000 milliseconds.");
    }
    const historyLimit = options.historyLimit === undefined ? DEFAULT_HISTORY_LIMIT : options.historyLimit;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > 1_440) {
      throw new TypeError("History limit must be an integer from 1 through 1440.");
    }
    this.#loadServices = options.loadServices;
    this.#probe = options.probe;
    this.#loadInfrastructureTargets = hasInfrastructureLoader ? options.loadInfrastructureTargets : async () => [];
    this.#probeInfrastructure = hasInfrastructureProbe ? options.probeInfrastructure : async () => null;
    this.#loadInfrastructureServices = hasInfrastructureServiceLoader ? options.loadInfrastructureServices : async () => [];
    this.#probeInfrastructureService = hasInfrastructureServiceProbe ? options.probeInfrastructureService : async () => null;
    this.#hasInfrastructureServiceMonitoring = hasInfrastructureServiceLoader;
    this.#incidentEngine = options.incidentEngine || new BasicIncidentAdapter();
    this.#observeIncident = incidentObserver(this.#incidentEngine);
    this.#retireIncident = incidentRetirer(this.#incidentEngine);
    this.#clock = typeof options.now === "function" ? options.now : Date.now;
    this.#intervalMs = intervalMs;
    this.#historyLimit = historyLimit;
    this.#serviceIds = allowedServiceIds(options.serviceIds);
    this.#pipelineDefinitions = pipelineDefinitions(options.pipelineStages);
    this.#setTimer = typeof options.setTimer === "function" ? options.setTimer : setTimeout;
    this.#clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : clearTimeout;
    this.#snapshot = emptySnapshot(this.#pipelineDefinitions);
  }

  start() {
    if (this.#running) return this.#inFlight || Promise.resolve(this.getSnapshot());
    this.#running = true;
    return this.refresh();
  }

  stop() {
    this.#running = false;
    this.#refreshRequested = false;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
  }

  refresh(options = {}) {
    if (this.#inFlight) return this.#inFlight;
    const bypassInfrastructureCache = options?.bypassInfrastructureCache !== false;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#controller = new AbortController();
    const signal = this.#controller.signal;
    this.#inFlight = this.#runCycle(signal, bypassInfrastructureCache)
      .finally(() => {
        const refreshRequested = this.#refreshRequested;
        this.#refreshRequested = false;
        this.#inFlight = null;
        this.#controller = null;
        if (this.#running && refreshRequested) {
          queueMicrotask(() => {
            if (this.#running && !this.#inFlight) void this.refresh().catch(() => {});
          });
        } else if (this.#running) {
          this.#schedule();
        }
      });
    return this.#inFlight;
  }

  requestRefresh() {
    if (this.#inFlight) this.#refreshRequested = true;
    const requested = this.refresh();
    requested.catch(() => {});
    return requested;
  }

  getSnapshot() {
    return clone(this.#snapshot);
  }

  subscribe(callback) {
    if (typeof callback !== "function") throw new TypeError("Monitor subscriber must be a function.");
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  #schedule() {
    if (!this.#running || this.#timer !== null) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.refresh({ bypassInfrastructureCache: false }).catch(() => {});
    }, this.#intervalMs);
    this.#timer?.unref?.();
  }

  async #runCycle(signal, bypassInfrastructureCache) {
    let loaded = [];
    let serviceLoadCode = null;
    try {
      loaded = await this.#loadServices({ signal });
      if (!Array.isArray(loaded)) throw Object.assign(new Error("invalid service list"), { code: "SERVICE_LIST_INVALID" });
    } catch (error) {
      if (signal.aborted) return this.getSnapshot();
      serviceLoadCode = code(error?.code, "SERVICE_LOAD_FAILED");
    }

    const loadedAt = iso(nowMs(this.#clock));
    if (serviceLoadCode) {
      try {
        this.#observeIncident({
          service: "helmsman",
          capability: "service_loader",
          ok: false,
          impact: "critical",
          code: serviceLoadCode,
          state: "down",
          checkedAt: loadedAt,
          latencyMs: null
        });
      } catch {
        // A monitoring adapter cannot make the monitor unavailable.
      }
    } else {
      try {
        this.#observeIncident({
          service: "helmsman",
          capability: "service_loader",
          ok: true,
          impact: "critical",
          checkedAt: loadedAt,
          latencyMs: null
        });
      } catch {
        // A monitoring adapter cannot make the monitor unavailable.
      }
    }

    const selected = [];
    const seen = new Set();
    for (const candidate of loaded.slice(0, MAX_SERVICES)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate.enabled === false) continue;
      const id = identifier(candidate.id, null);
      if (!id || !this.#serviceIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      selected.push({ id, source: candidate });
    }
    const nextServiceIds = new Set(selected.map(({ id }) => id));
    for (const service of this.#monitoredServiceIds) {
      if (nextServiceIds.has(service)) continue;
      try {
        this.#retireIncident(service, loadedAt);
      } catch {
        // Incident adapters cannot make a monitoring cycle unavailable.
      }
    }
    this.#monitoredServiceIds = nextServiceIds;
    const services = new Array(selected.length);
    let nextServiceIndex = 0;
    const workerCount = Math.min(MAX_PARALLEL_SERVICE_PROBES, selected.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextServiceIndex < selected.length) {
        const index = nextServiceIndex;
        nextServiceIndex += 1;
        const { id, source } = selected[index];
        const startedAt = nowMs(this.#clock);
        try {
          const result = await this.#probe(source, { signal, serviceId: id, checkedAt: iso(startedAt) });
          const completedAt = nowMs(this.#clock);
          services[index] = normalizeProbeResult(
            id,
            result,
            iso(completedAt),
            latency(completedAt - startedAt),
            source.targetRevision
          );
        } catch (error) {
          const completedAt = nowMs(this.#clock);
          services[index] = {
            ...failedProbeResult(id, error, iso(completedAt), latency(completedAt - startedAt)),
            targetRevision: typeof source.targetRevision === "string" && UUID.test(source.targetRevision)
              ? source.targetRevision
              : null
          };
        }
      }
    }));
    if (signal.aborted) return this.getSnapshot();
    services.sort((left, right) => left.id.localeCompare(right.id));
    for (const service of services) {
      for (const check of service.checks) {
        if (check.affectsHealth === false) continue;
        try {
          this.#observeIncident({
            service: service.id,
            capability: check.id,
            ok: check.ok,
            impact: check.impact,
            code: check.code,
            status: check.httpStatus,
            state: check.ok || check.state === "stale" ? undefined : check.state,
            latencyMs: check.latencyMs,
            checkedAt: check.checkedAt
          });
        } catch {
          // Incident adapters receive a strict normalized payload, but remain isolated.
        }
      }
    }

    let infrastructureLoadCode = null;
    let loadedInfrastructure = [];
    try {
      loadedInfrastructure = await this.#loadInfrastructureTargets({ signal });
      if (!Array.isArray(loadedInfrastructure)) {
        throw Object.assign(new Error("invalid infrastructure target list"), {
          code: "INFRASTRUCTURE_LIST_INVALID"
        });
      }
      try {
        this.#observeIncident({
          service: "helmsman",
          capability: "infrastructure_loader",
          ok: true,
          impact: "critical",
          checkedAt: loadedAt,
          latencyMs: null
        });
      } catch {
        // A monitoring adapter cannot make the monitor unavailable.
      }
    } catch (error) {
      if (signal.aborted) return this.getSnapshot();
      infrastructureLoadCode = code(error?.code, "INFRASTRUCTURE_LOAD_FAILED");
      try {
        this.#observeIncident({
          service: "helmsman",
          capability: "infrastructure_loader",
          ok: false,
          impact: "critical",
          code: infrastructureLoadCode,
          state: "down",
          checkedAt: loadedAt,
          latencyMs: null
        });
      } catch {
        // A monitoring adapter cannot make the monitor unavailable.
      }
    }

    const infrastructureResults = [];
    if (!infrastructureLoadCode) {
      const selectedTargets = [];
      const seenTargets = new Set();
      for (const candidate of loadedInfrastructure.slice(0, MAX_INFRASTRUCTURE_TARGETS)) {
        if (!candidate
          || typeof candidate !== "object"
          || Array.isArray(candidate)
          || candidate.enabled === false
          || candidate.monitoringEnabled === false) continue;
        const id = typeof candidate.id === "string" ? candidate.id.toLowerCase() : "";
        if (!UUID.test(id)
          || candidate.type !== "proxmox"
          || seenTargets.has(id)
          || typeof candidate.displayName !== "string") continue;
        const monitoringIntervalSeconds = Number.isSafeInteger(candidate.monitoringIntervalSeconds)
          ? Math.min(3_600, Math.max(30, candidate.monitoringIntervalSeconds))
          : 30;
        seenTargets.add(id);
        selectedTargets.push({ id, source: candidate, monitoringIntervalSeconds });
      }

      for (const id of this.#monitoredInfrastructureIds) {
        if (seenTargets.has(id)) continue;
        const monitorId = `proxmox-${id}`;
        this.#infrastructureCache.delete(id);
        try {
          this.#retireIncident(monitorId, loadedAt);
        } catch {
          // Incident adapters cannot make a monitoring cycle unavailable.
        }
      }
      this.#monitoredInfrastructureIds = seenTargets;

      const cycleMilliseconds = Date.parse(loadedAt);
      const pending = [];
      for (const selectedTarget of selectedTargets) {
        const cached = this.#infrastructureCache.get(selectedTarget.id);
        const nextDue = cached
          ? Date.parse(cached.result.checkedAt) + selectedTarget.monitoringIntervalSeconds * 1_000
          : 0;
        if (!bypassInfrastructureCache
          && cached
          && cached.targetRevision === selectedTarget.source.targetRevision
          && Number.isFinite(nextDue)
          && nextDue > cycleMilliseconds) {
          infrastructureResults.push(cached.result);
        } else {
          pending.push(selectedTarget);
        }
      }

      let nextTargetIndex = 0;
      const targetWorkerCount = Math.min(MAX_PARALLEL_SERVICE_PROBES, pending.length);
      await Promise.all(Array.from({ length: targetWorkerCount }, async () => {
        while (nextTargetIndex < pending.length) {
          const index = nextTargetIndex;
          nextTargetIndex += 1;
          const { id, source, monitoringIntervalSeconds } = pending[index];
          const startedAt = nowMs(this.#clock);
          let result;
          try {
            const probed = await this.#probeInfrastructure(source, {
              signal,
              targetId: id,
              checkedAt: iso(startedAt)
            });
            const completedAt = nowMs(this.#clock);
            result = normalizeInfrastructureTargetResult(
              source,
              probed,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
          } catch (error) {
            if (["TARGET_CHANGED", "INFRASTRUCTURE_TARGET_NOT_FOUND"].includes(error?.code)) {
              this.#infrastructureCache.delete(id);
              try {
                this.#retireIncident(`proxmox-${id}`, iso(nowMs(this.#clock)));
              } catch {
                // Configuration races retire old evidence best-effort. The
                // queued refresh will probe the current destination.
              }
              continue;
            }
            const completedAt = nowMs(this.#clock);
            const monitorId = `proxmox-${id}`;
            const failed = failedProbeResult(
              monitorId,
              error,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
            result = normalizeInfrastructureTargetResult(
              source,
              failed,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
          }
          this.#infrastructureCache.set(id, { targetRevision: source.targetRevision, result });
          infrastructureResults.push(result);
          for (const check of result.checks) {
            try {
              this.#observeIncident({
                service: result.id,
                capability: check.id,
                ok: check.ok,
                impact: check.impact,
                code: check.code,
                status: check.httpStatus,
                state: check.ok || check.state === "stale" ? undefined : check.state,
                latencyMs: check.latencyMs,
                checkedAt: check.checkedAt,
                // A deliberately slow target interval must not be declared
                // stale by the incident engine before its next check is due.
                staleAfterMs: Math.max(
                  MIN_INFRASTRUCTURE_STALE_AFTER_MS,
                  monitoringIntervalSeconds * 1_000 + this.#intervalMs * 2
                )
              });
            } catch {
              // Incident adapters receive a strict normalized payload, but remain isolated.
            }
          }
        }
      }));
      if (signal.aborted) return this.getSnapshot();
    }

    let infrastructureServiceLoadCode = null;
    let loadedInfrastructureServices = [];
    if (this.#hasInfrastructureServiceMonitoring) {
      try {
        loadedInfrastructureServices = await this.#loadInfrastructureServices({ signal });
        if (!Array.isArray(loadedInfrastructureServices)) {
          throw Object.assign(new Error("invalid infrastructure service list"), {
            code: "PORTAINER_SERVICE_LIST_INVALID"
          });
        }
        try {
          this.#observeIncident({
            service: "helmsman",
            capability: "portainer_loader",
            ok: true,
            impact: "critical",
            checkedAt: loadedAt,
            latencyMs: null
          });
        } catch {
          // A monitoring adapter cannot make the monitor unavailable.
        }
      } catch (error) {
        if (signal.aborted) return this.getSnapshot();
        infrastructureServiceLoadCode = code(error?.code, "PORTAINER_SERVICE_LOAD_FAILED");
        try {
          this.#observeIncident({
            service: "helmsman",
            capability: "portainer_loader",
            ok: false,
            impact: "critical",
            code: infrastructureServiceLoadCode,
            state: "down",
            checkedAt: loadedAt,
            latencyMs: null
          });
        } catch {
          // A monitoring adapter cannot make the monitor unavailable.
        }
      }
    }

    const infrastructureServiceResults = [];
    if (!infrastructureServiceLoadCode) {
      const selectedServices = [];
      const seenServices = new Set();
      const seenServiceIds = new Set();
      for (const candidate of loadedInfrastructureServices.slice(0, MAX_INFRASTRUCTURE_SERVICES)) {
        if (!candidate
          || typeof candidate !== "object"
          || Array.isArray(candidate)
          || candidate.enabled === false
          || candidate.monitoringEnabled === false) continue;
        const id = typeof candidate.id === "string" ? candidate.id.toLowerCase() : "";
        if (!UUID.test(id)
          || !["portainer", "loki"].includes(candidate.type)
          || seenServiceIds.has(id)
          || typeof candidate.displayName !== "string") continue;
        seenServiceIds.add(id);
        seenServices.add(`${candidate.type}:${id}`);
        selectedServices.push({ id, source: candidate });
      }
      for (const key of this.#monitoredInfrastructureServiceIds) {
        if (seenServices.has(key)) continue;
        const separator = key.indexOf(":");
        const type = separator > 0 ? key.slice(0, separator) : "portainer";
        const id = separator > 0 ? key.slice(separator + 1) : key;
        try {
          this.#retireIncident(`${type}-${id}`, loadedAt);
        } catch {
          // Incident adapters cannot make a monitoring cycle unavailable.
        }
      }
      this.#monitoredInfrastructureServiceIds = seenServices;

      let nextInfrastructureServiceIndex = 0;
      const infrastructureServiceWorkerCount = Math.min(MAX_PARALLEL_SERVICE_PROBES, selectedServices.length);
      await Promise.all(Array.from({ length: infrastructureServiceWorkerCount }, async () => {
        while (nextInfrastructureServiceIndex < selectedServices.length) {
          const index = nextInfrastructureServiceIndex;
          nextInfrastructureServiceIndex += 1;
          const { id, source } = selectedServices[index];
          const startedAt = nowMs(this.#clock);
          let result;
          try {
            const probed = await this.#probeInfrastructureService(source, {
              signal,
              serviceId: id,
              checkedAt: iso(startedAt)
            });
            const completedAt = nowMs(this.#clock);
            result = normalizeInfrastructureServiceResult(
              source,
              probed,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
          } catch (error) {
            if (["TARGET_CHANGED", "INFRASTRUCTURE_SERVICE_NOT_FOUND"].includes(error?.code)) {
              try {
                this.#retireIncident(`${source.type}-${id}`, iso(nowMs(this.#clock)));
              } catch {
                // Configuration races retire old evidence best-effort. The
                // queued refresh will probe the current destination.
              }
              continue;
            }
            const completedAt = nowMs(this.#clock);
            const failed = failedProbeResult(
              `${source.type}-${id}`,
              error,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
            result = normalizeInfrastructureServiceResult(
              source,
              failed,
              iso(completedAt),
              latency(completedAt - startedAt)
            );
          }
          infrastructureServiceResults.push(result);
          for (const capability of result.checks) {
            if (capability.affectsHealth === false) continue;
            try {
              this.#observeIncident({
                service: result.id,
                capability: capability.id,
                ok: capability.ok,
                impact: capability.impact,
                code: capability.code,
                status: capability.httpStatus,
                state: capability.ok || capability.state === "stale" ? undefined : capability.state,
                latencyMs: capability.latencyMs,
                checkedAt: capability.checkedAt
              });
            } catch {
              // Incident adapters receive a strict normalized payload, but remain isolated.
            }
          }
        }
      }));
      if (signal.aborted) return this.getSnapshot();
    }

    infrastructureResults.sort((left, right) => (
      left.displayName.localeCompare(right.displayName) || left.targetId.localeCompare(right.targetId)
    ));
    infrastructureServiceResults.sort((left, right) => (
      left.displayName.localeCompare(right.displayName) || left.serviceId.localeCompare(right.serviceId)
    ));
    const mediaConnectionRevisions = Object.fromEntries(selected.flatMap(({ id, source }) => {
      const targetRevision = own(source, "targetRevision");
      return typeof targetRevision === "string" && UUID.test(targetRevision) ? [[id, targetRevision]] : [];
    }));
    const infrastructureState = infrastructureLoadCode || infrastructureServiceLoadCode
      ? "down"
      : infrastructureResults.length || infrastructureServiceResults.length
        ? worstState([
            ...infrastructureResults.map((target) => target.state),
            ...infrastructureServiceResults.map((service) => service.state)
          ])
        : "stale";
    const infrastructure = {
      state: infrastructureState,
      environmentCount: infrastructureResults.length,
      targetCount: infrastructureResults.length,
      affectedTargetCount: infrastructureResults.filter((target) => target.state !== "healthy").length,
      serviceCount: infrastructureServiceResults.length,
      affectedServiceCount: infrastructureServiceResults.filter((service) => service.state !== "healthy").length,
      code: infrastructureLoadCode || infrastructureServiceLoadCode,
      environments: infrastructureResults.map(publicInfrastructureTarget),
      // Retained for v0.7 clients during the v0.8 environment-model migration.
      targets: infrastructureResults.map(publicInfrastructureTarget),
      services: infrastructureServiceResults.map(publicInfrastructureService),
      portainer: infrastructureServiceResults
        .filter(({ type }) => type === "portainer")
        .map(publicInfrastructureService),
      loki: infrastructureServiceResults
        .filter(({ type }) => type === "loki")
        .map(publicInfrastructureService)
    };
    const generatedAt = iso(nowMs(this.#clock));
    const pipeline = pipelineSnapshot(this.#pipelineDefinitions, services);
    const incidents = incidentsFromEngine(this.#incidentEngine, generatedAt);
    const serviceState = services.length ? worstState(services.map((service) => service.state)) : "stale";
    const snapshot = {
      version: 1,
      generatedAt,
      overall: {
        // Preserve the established media-workspace summary. Infrastructure
        // has its own independently derived state below, so a Proxmox outage
        // cannot make Media appear degraded with zero affected media services.
        state: serviceLoadCode ? "down" : worstState([serviceState, pipeline.state]),
        serviceCount: services.length,
        affectedServiceCount: services.filter((service) => service.state !== "healthy").length,
        openIncidentCount: mediaIncidentCount(incidents),
        code: serviceLoadCode
      },
      services,
      pipeline,
      infrastructure,
      incidents,
      media: buildMediaSnapshot(services, generatedAt, mediaConnectionRevisions),
      workload: workloadSnapshot(services),
      events: eventsFromEngine(this.#incidentEngine),
      history: []
    };
    this.#publish(snapshot);
    return this.getSnapshot();
  }

  #publish(snapshot) {
    this.#history.push(historyEntry(snapshot));
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    snapshot.history = clone(this.#history);
    this.#snapshot = clone(snapshot);
    for (const listener of this.#listeners) {
      try {
        const returned = listener(this.getSnapshot());
        if (returned && typeof returned.catch === "function") returned.catch(() => {});
      } catch {
        // Subscriber failures must never stop polling.
      }
    }
  }
}

export function createOperationsMonitor(options) {
  return new OperationsMonitor(options);
}

export const MONITOR_INTERVAL_LIMITS = Object.freeze({
  minimumMs: MIN_INTERVAL_MS,
  maximumMs: MAX_INTERVAL_MS,
  defaultMs: DEFAULT_INTERVAL_MS
});

export const PIPELINE_STAGES = DEFAULT_PIPELINE_STAGES;
