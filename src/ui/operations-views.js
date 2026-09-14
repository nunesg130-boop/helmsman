const HEALTH_STATE_ALIASES = Object.freeze({
  online: "healthy",
  ready: "healthy",
  ok: "healthy",
  warning: "limited",
  partial: "degraded",
  offline: "down",
  unavailable: "down",
  error: "down",
  auth: "authentication-required",
  auth_required: "authentication-required",
  "auth-required": "authentication-required",
  authentication: "authentication-required",
  authentication_required: "authentication-required",
  unauthorized: "authentication-required",
  expired: "authentication-required",
  unknown: "stale",
  idle: "stale"
});

const HEALTH_STATES = new Set([
  "healthy",
  "limited",
  "degraded",
  "down",
  "authentication-required",
  "stale",
  "checking",
  "disabled"
]);
const CONNECTION_STATES = new Set(["connected", "auth_required", "unverified", "down"]);

const HEALTH_COPY = Object.freeze({
  healthy: { label: "Healthy", tone: "success", icon: "check" },
  limited: { label: "Limited", tone: "warning", icon: "more" },
  degraded: { label: "Degraded", tone: "warning", icon: "more" },
  down: { label: "Down", tone: "danger", icon: "x" },
  "authentication-required": { label: "Authentication required", tone: "danger", icon: "lock" },
  stale: { label: "Stale", tone: "neutral", icon: "refresh" },
  checking: { label: "Checking", tone: "info", icon: "refresh" },
  disabled: { label: "Disabled", tone: "neutral", icon: "pause" }
});

const SERVICE_COPY = Object.freeze({
  jellyfin: { name: "Jellyfin", role: "Library and playback" },
  seerr: { name: "Seerr", role: "Discovery and requests" },
  radarr: { name: "Radarr", role: "Movie acquisition" },
  sonarr: { name: "Sonarr", role: "Series acquisition" },
  prowlarr: { name: "Prowlarr", role: "Indexer search" },
  qbittorrent: { name: "qBittorrent", role: "Download client" },
  bazarr: { name: "Bazarr", role: "Subtitle coverage" },
  portainer: { name: "Portainer", role: "Container infrastructure" }
});

// Keep icon selection independent from upstream service data. In particular,
// never turn an arbitrary service id into an asset path: this registry is the
// complete set of local marks the renderer may request.
const SERVICE_ICON_PATHS = Object.freeze({
  jellyfin: "./assets/services/jellyfin.svg?v=2",
  seerr: "./assets/services/seerr.png",
  radarr: "./assets/services/radarr.png",
  sonarr: "./assets/services/sonarr.png",
  prowlarr: "./assets/services/prowlarr.png",
  qbittorrent: "./assets/services/qbittorrent.svg?v=2",
  bazarr: "./assets/services/bazarr.svg",
  proxmox: "./assets/services/proxmox.png",
  portainer: "./assets/services/portainer.svg"
});

const WORKLOAD_ICON_PATHS = Object.freeze({
  qemu: "./assets/workloads/vm.png",
  lxc: "./assets/workloads/lxc.svg"
});

const PIPELINE_COPY = Object.freeze({
  request: { label: "Request", hint: "Seerr" },
  requests: { label: "Requests", hint: "Seerr" },
  approval: { label: "Approval", hint: "Seerr" },
  search: { label: "Search", hint: "Prowlarr" },
  acquire: { label: "Acquire", hint: "Radarr + Sonarr" },
  download: { label: "Download", hint: "qBittorrent" },
  downloads: { label: "Downloads", hint: "qBittorrent" },
  import: { label: "Import", hint: "Radarr + Sonarr" },
  imports: { label: "Imports", hint: "Radarr + Sonarr" },
  library: { label: "Library", hint: "Jellyfin" },
  subtitles: { label: "Subtitles", hint: "Bazarr" }
});

const WORKLOAD_COPY = Object.freeze({
  pendingRequests: { label: "Pending requests", href: "#/pipeline", state: "neutral" },
  requests: { label: "Pending requests", href: "#/pipeline", state: "neutral" },
  queued: { label: "Queued", href: "#/pipeline", state: "neutral" },
  downloading: { label: "Downloading", href: "#/pipeline", state: "info" },
  importing: { label: "Importing", href: "#/pipeline", state: "info" },
  stalled: { label: "Stalled", href: "#/pipeline", state: "warning" },
  failed: { label: "Failed", href: "#/pipeline", state: "danger" },
  subtitleBacklog: { label: "Missing subtitles", href: "#/pipeline", state: "warning" },
  activeStreams: { label: "Active streams", href: "#/services", state: "success" },
  transcodes: { label: "Transcodes", href: "#/services", state: "info" }
});

const WORKLOAD_ORDER = Object.freeze([
  "pendingRequests",
  "requests",
  "queued",
  "downloading",
  "importing",
  "stalled",
  "failed",
  "subtitleBacklog",
  "activeStreams",
  "transcodes"
]);

const INCIDENT_PRIORITY = Object.freeze({
  down: 0,
  "authentication-required": 1,
  degraded: 2,
  limited: 3,
  stale: 4,
  checking: 5,
  healthy: 6,
  disabled: 7
});

// Generic incident evidence remains numeric. Upstream text is accepted only
// through the separately bounded and escaped reports contract below.
const INCIDENT_METRICS = Object.freeze([
  "healthWarnings",
  "healthErrors",
  "healthNotices",
  "indexersBlocked"
]);
const REPORT_SEVERITIES = new Set(["notice", "warning", "error"]);

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

function array(value, maximum = 100) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function boundedText(value, fallback = "", maximum = 180) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, maximum);
}

/**
 * Treat upstream service reports as untrusted display data even though the
 * broker already sanitizes them. Keeping this boundary in the renderer makes
 * ad-hoc connection-test responses and future probe implementations safe by
 * default. The limits mirror the control-plane report contract.
 */
export function normalizeOperationsReports(value, fallbackSource = "Service") {
  const safeFallback = boundedText(fallbackSource, "Service", 96);
  return array(value, 12).flatMap((entry) => {
    const source = record(entry);
    if (!source) return [];
    const severity = boundedText(own(source, "severity"), "", 16).toLowerCase();
    const message = boundedText(own(source, "message"), "", 600);
    if (!REPORT_SEVERITIES.has(severity) || !message) return [];
    return [{
      severity,
      source: boundedText(own(source, "source"), safeFallback, 96),
      message
    }];
  });
}

export function escapeOperationsHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Returns a decorative, local-only service mark for a known integration.
 * Unknown ids receive a single escaped glyph and can never affect an image URL.
 */
export function serviceIconMarkup(serviceId, fallback = "?") {
  const candidate = boundedText(serviceId, "", 120).toLowerCase();
  const key = candidate === "proxmox" || candidate.startsWith("proxmox-")
    ? "proxmox"
    : candidate === "portainer" || candidate.startsWith("portainer-")
      ? "portainer"
    : Object.prototype.hasOwnProperty.call(SERVICE_ICON_PATHS, candidate)
      ? candidate
      : "";
  if (key) {
    const plateClass = key === "proxmox" || key === "radarr" || key === "portainer" ? " service-brand-icon--light-plate" : "";
    return `<img class="service-brand-icon${plateClass}" src="${SERVICE_ICON_PATHS[key]}" width="32" height="32" alt="" aria-hidden="true" decoding="async">`;
  }
  const fallbackText = boundedText(fallback, "?", 24);
  const glyph = (Array.from(fallbackText)[0] || "?").toUpperCase();
  return `<span class="service-brand-icon__fallback" aria-hidden="true">${escapeOperationsHtml(glyph)}</span>`;
}

export function workloadIconMarkup(type) {
  const key = type === "lxc" ? "lxc" : "qemu";
  return `<img class="workload-brand-icon" src="${WORKLOAD_ICON_PATHS[key]}" width="28" height="28" alt="" aria-hidden="true" decoding="async">`;
}

function safeInteger(value, fallback = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function safeHttpStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "string" && /^\d{3}$/u.test(value)
    ? Number(value)
    : value;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function incidentMetrics(value) {
  const source = record(value);
  if (!source) return {};
  const output = {};
  for (const key of INCIDENT_METRICS) {
    const number = Number(own(source, key));
    if (Number.isFinite(number) && number >= 0) {
      output[key] = safeInteger(number, 0, 0, 1_000_000);
    }
  }
  return output;
}

function safeIdentifier(value, fallback = "") {
  const candidate = boundedText(value, "", 100).toLowerCase();
  return /^[a-z0-9][a-z0-9_.:-]{0,99}$/u.test(candidate) ? candidate : fallback;
}

function humanizeIdentifier(value, fallback = "Service check") {
  const text = boundedText(value, "", 90).replace(/[._-]+/gu, " ").trim();
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : fallback;
}

function normalizeHealthState(value, fallback = "stale") {
  const candidate = boundedText(value, "", 48).toLowerCase().replaceAll(" ", "-");
  const normalized = HEALTH_STATE_ALIASES[candidate] || candidate;
  return HEALTH_STATES.has(normalized) ? normalized : fallback;
}

function normalizeConnectionState(value) {
  const candidate = boundedText(value, "", 48).toLowerCase().replaceAll("-", "_");
  return CONNECTION_STATES.has(candidate) ? candidate : "unverified";
}

function healthMeta(value) {
  return HEALTH_COPY[normalizeHealthState(value)] || HEALTH_COPY.stale;
}

function svgIcon(name) {
  const safeName = new Set(["check", "chevron", "download", "inbox", "lock", "logs", "more", "pause", "plus", "refresh", "server", "shield", "x"]).has(name)
    ? name
    : "more";
  return `<svg aria-hidden="true"><use href="#icon-${safeName}"></use></svg>`;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestampMarkup(value, fallback = "Not checked yet") {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return escapeOperationsHtml(fallback);
  const date = new Date(timestamp);
  const label = date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  return `<time datetime="${timestamp}">${escapeOperationsHtml(label)}</time>`;
}

function durationLabel(firstSeen, finishedAt) {
  const start = normalizeTimestamp(firstSeen);
  const finish = normalizeTimestamp(finishedAt);
  if (!start || !finish) return "";
  const seconds = Math.max(0, Math.round((new Date(finish).getTime() - new Date(start).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

function serviceIdentity(value) {
  const id = safeIdentifier(value, "service");
  const known = SERVICE_COPY[id];
  const name = known?.name || boundedText(id, "Service", 50).replace(/(^|[-_.])([a-z])/gu, (_match, prefix, letter) => `${prefix === "-" ? " " : prefix}${letter.toUpperCase()}`);
  return { id, name, role: known?.role || "Connected service" };
}

function normalizeCapability(value, index, serviceName = "Service") {
  const source = record(value) || {};
  const id = safeIdentifier(own(source, "id") ?? own(source, "name"), `check-${index + 1}`);
  return {
    id,
    name: boundedText(own(source, "label") ?? own(source, "name"), humanizeIdentifier(id, `API check ${index + 1}`), 80),
    state: normalizeHealthState(own(source, "state")),
    impact: boundedText(own(source, "impact"), "", 40),
    lastCheckedAt: normalizeTimestamp(own(source, "lastCheckedAt") ?? own(source, "checkedAt")),
    latencyMs: Number.isFinite(Number(own(source, "latencyMs")))
      ? safeInteger(own(source, "latencyMs"), 0, 0, 120_000)
      : null,
    consecutiveFailures: safeInteger(own(source, "consecutiveFailures"), 0, 0, 1_000_000),
    code: boundedText(own(source, "code"), "", 80),
    status: safeHttpStatus(own(source, "status") ?? own(source, "httpStatus")),
    metrics: incidentMetrics(own(source, "metrics")),
    reports: normalizeOperationsReports(own(source, "reports"), `${serviceName} health`)
  };
}

function normalizeService(value, index) {
  const source = record(value) || {};
  const identity = serviceIdentity(own(source, "id") || `service-${index + 1}`);
  const capabilities = array(own(source, "capabilities") ?? own(source, "checks"), 24)
    .map((entry, capabilityIndex) => normalizeCapability(entry, capabilityIndex, identity.name));
  const failures = capabilities.filter((capability) => !["healthy", "disabled"].includes(capability.state));
  const healthy = capabilities.filter((capability) => capability.state === "healthy").length;
  const capabilityLatencies = capabilities
    .map((capability) => capability.latencyMs)
    .filter((latency) => latency !== null);
  const suppliedLatency = own(source, "latencyMs") ?? own(source, "latency");
  return {
    ...identity,
    name: boundedText(own(source, "name") ?? own(source, "label"), identity.name, 60),
    role: boundedText(own(source, "role"), identity.role, 100),
    state: normalizeHealthState(own(source, "state")),
    connectionState: normalizeConnectionState(own(source, "connectionState")),
    lastCheckedAt: normalizeTimestamp(own(source, "lastCheckedAt") ?? own(source, "checkedAt")),
    activeIncidentCount: safeInteger(own(source, "activeIncidentCount"), failures.length, 0, 999),
    capabilities,
    healthyCapabilityCount: healthy,
    failedCapabilities: failures,
    latencyMs: Number.isFinite(Number(suppliedLatency))
      ? safeInteger(suppliedLatency, 0, 0, 120_000)
      : capabilityLatencies.length
        ? Math.max(...capabilityLatencies)
        : null,
    version: boundedText(own(source, "version"), "", 80),
    message: boundedText(own(source, "message"), "", 140)
  };
}

function normalizeIncident(value, index, services = []) {
  const source = record(value) || {};
  const service = serviceIdentity(own(source, "service"));
  const currentService = services.find((entry) => entry.id === service.id);
  const state = normalizeHealthState(own(source, "state"), "degraded");
  const code = boundedText(own(source, "code"), "", 80).toUpperCase();
  const status = safeHttpStatus(own(source, "status") ?? own(source, "httpStatus"));
  const capabilityId = safeIdentifier(own(source, "capability"), "service-check");
  const capability = humanizeIdentifier(capabilityId, "Service check");
  const currentCapability = currentService?.capabilities.find((entry) => entry.id === capabilityId);
  const currentMetrics = currentCapability?.metrics || {};
  const currentCount = code === "HEALTH_WARNING"
    ? currentMetrics.healthWarnings ?? null
    : code === "HEALTH_ERROR"
      ? currentMetrics.healthErrors ?? null
      : code === "INDEXERS_BLOCKED"
        ? currentMetrics.indexersBlocked ?? null
        : null;
  const curatedSummary = ["HEALTH_WARNING", "HEALTH_ERROR", "INDEXERS_BLOCKED"].includes(code);
  const generatedSummary = incidentSummary(currentService?.name || service.name, capability, state, code, status, currentCount);
  return {
    id: safeIdentifier(own(source, "id"), `incident-${index + 1}`),
    service: service.id,
    serviceName: currentService?.name || service.name,
    scope: currentService?.role === "Proxmox infrastructure"
      || currentService?.role === "Container infrastructure"
      || service.id.startsWith("proxmox-")
      || service.id.startsWith("portainer-")
      ? "infrastructure"
      : "media",
    capability,
    state,
    impact: boundedText(own(source, "impact"), "", 48),
    code,
    status,
    currentCount,
    summary: curatedSummary ? generatedSummary : boundedText(own(source, "summary"), generatedSummary, 240),
    firstSeen: normalizeTimestamp(own(source, "firstSeen")),
    lastSeen: normalizeTimestamp(own(source, "lastSeen")),
    occurrenceCount: safeInteger(own(source, "occurrenceCount"), 1, 1, 1_000_000),
    nextStep: boundedText(own(source, "nextStep"), "", 220),
    reports: currentCapability?.reports || []
  };
}

function incidentSummary(serviceName, capability, state, code, status, currentCount = null) {
  if (code === "HEALTH_WARNING") {
    return currentCount === null
      ? `${serviceName} reports application health warnings.`
      : `${serviceName} reports ${currentCount} current application health warning${currentCount === 1 ? "" : "s"}.`;
  }
  if (code === "HEALTH_ERROR") {
    return currentCount === null
      ? `${serviceName} reports application health errors.`
      : `${serviceName} reports ${currentCount} current application health error${currentCount === 1 ? "" : "s"}.`;
  }
  if (code === "INDEXERS_BLOCKED") {
    return currentCount === null
      ? `${serviceName} has blocked or unavailable indexers.`
      : `${serviceName} has ${currentCount} blocked or unavailable indexer${currentCount === 1 ? "" : "s"}.`;
  }
  if (status) return `${serviceName} ${capability.toLowerCase()} returned HTTP ${status}.`;
  if (code) return `${serviceName} ${capability.toLowerCase()} reported ${code.replaceAll("_", " ").toLowerCase()}.`;
  if (state === "authentication-required") return `${serviceName} ${capability.toLowerCase()} requires authentication.`;
  if (state === "limited") return `${serviceName} ${capability.toLowerCase()} is limited.`;
  if (state === "degraded") return `${serviceName} ${capability.toLowerCase()} is degraded.`;
  if (state === "stale") return `${serviceName} ${capability.toLowerCase()} has not reported recently.`;
  return `${serviceName} ${capability.toLowerCase()} is unavailable.`;
}

function normalizeRecovery(value, index, services = []) {
  const source = record(value) || {};
  const service = serviceIdentity(own(source, "service"));
  const currentService = services.find((entry) => entry.id === service.id);
  return {
    id: safeIdentifier(own(source, "id"), `recovery-${index + 1}`),
    service: service.id,
    serviceName: currentService?.name || service.name,
    scope: currentService?.role === "Proxmox infrastructure"
      || currentService?.role === "Container infrastructure"
      || service.id.startsWith("proxmox-")
      || service.id.startsWith("portainer-")
      ? "infrastructure"
      : "media",
    capability: humanizeIdentifier(own(source, "capability"), "Service check"),
    previousState: normalizeHealthState(own(source, "previousState"), "degraded"),
    firstSeen: normalizeTimestamp(own(source, "firstSeen")),
    recoveredAt: normalizeTimestamp(own(source, "recoveredAt") ?? own(source, "lastSeen")),
    occurrenceCount: safeInteger(own(source, "occurrenceCount"), 1, 1, 1_000_000)
  };
}

function normalizePipelineStage(value, index) {
  const source = record(value) || {};
  const suppliedId = safeIdentifier(own(source, "id") ?? own(source, "stage"));
  const id = suppliedId || `stage-${index + 1}`;
  const known = PIPELINE_COPY[id];
  return {
    id,
    label: boundedText(own(source, "label"), known?.label || `Stage ${index + 1}`, 60),
    hint: boundedText(own(source, "hint") ?? own(source, "service"), known?.hint || "", 90),
    state: normalizeHealthState(own(source, "state")),
    detail: boundedText(own(source, "detail") ?? own(source, "summary"), "", 150),
    serviceCount: safeInteger(own(source, "serviceCount"), 0, 0, 99),
    failingCheckCount: safeInteger(own(source, "failingCheckCount"), 0, 0, 999),
    count: Number.isFinite(Number(own(source, "count")))
      ? safeInteger(own(source, "count"), 0, 0, 99_999)
      : null
  };
}

function pipelineValues(value) {
  if (Array.isArray(value)) return value;
  const source = record(value);
  if (!source) return [];
  if (Array.isArray(own(source, "stages"))) return own(source, "stages");
  return Object.keys(PIPELINE_COPY)
    .filter((id) => record(own(source, id)))
    .map((id) => ({ id, ...own(source, id) }));
}

function safeInternalHref(value, fallback) {
  const candidate = boundedText(value, "", 100);
  return /^#\/(?:home|operations|incidents|pipeline|services|logs|settings|requests|downloads|library)(?:\?[a-z0-9=&._-]+)?$/iu.test(candidate)
    ? candidate
    : fallback;
}

function normalizeWorkloadItem(value, index) {
  const source = record(value) || {};
  const candidateId = safeIdentifier(own(source, "id"), `metric-${index + 1}`);
  const id = Object.keys(WORKLOAD_COPY).find((key) => key.toLowerCase() === candidateId) || candidateId;
  const known = WORKLOAD_COPY[id];
  return {
    id,
    label: boundedText(own(source, "label"), known?.label || `Metric ${index + 1}`, 70),
    value: safeInteger(own(source, "value") ?? own(source, "count"), 0, 0, 99_999),
    detail: boundedText(own(source, "detail"), "", 100),
    state: normalizeMetricTone(own(source, "state") ?? own(source, "tone") ?? known?.state),
    href: safeInternalHref(own(source, "href"), known?.href || "#/pipeline")
  };
}

function normalizeMetricTone(value) {
  const candidate = boundedText(value, "", 30).toLowerCase();
  if (["success", "info", "warning", "danger", "neutral"].includes(candidate)) return candidate;
  if (["healthy", "online"].includes(candidate)) return "success";
  if (["limited", "degraded"].includes(candidate)) return "warning";
  if (["down", "failed", "error", "authentication-required"].includes(candidate)) return "danger";
  return "neutral";
}

function workloadValues(value) {
  if (Array.isArray(value)) return value;
  const source = record(value);
  if (!source) return [];
  if (Array.isArray(own(source, "items"))) return own(source, "items");
  if (Array.isArray(own(source, "metrics"))) return own(source, "metrics");
  const output = [];
  const seenLabels = new Set();
  for (const id of WORKLOAD_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(source, id)) continue;
    const copy = WORKLOAD_COPY[id];
    if (seenLabels.has(copy.label)) continue;
    const raw = own(source, id);
    output.push(record(raw) ? { id, ...raw } : { id, value: raw });
    seenLabels.add(copy.label);
  }
  return output;
}

function snapshotSource(value) {
  const state = record(value) || {};
  return record(own(state, "operationsSnapshot"))
    || record(own(state, "operations"))
    || record(own(record(own(state, "model")), "operations"))
    || state;
}

/**
 * Converts the health engine output plus optional pipeline/workload data into
 * a bounded, renderer-safe operations view model.
 */
export function normalizeOperationsSnapshot(value, configuredInfrastructureTargets = []) {
  const source = snapshotSource(value);
  const rawOverall = record(own(source, "overall")) || {};
  const rawIncidents = own(source, "incidents");
  const incidentCollection = Array.isArray(rawIncidents)
    ? rawIncidents
    : array(own(record(rawIncidents), "open"), 100);
  const recentCollection = own(source, "recentRecoveries")
    ?? own(source, "recoveries")
    ?? own(record(rawIncidents), "recent");
  const services = array(own(source, "services") ?? own(source, "serviceHealth"), 50).map(normalizeService);
  const infrastructureIncidentServices = normalizeInfrastructureSnapshot(value, configuredInfrastructureTargets).targets.flatMap((target) => {
    const shared = {
      name: target.displayName,
      role: "Proxmox infrastructure",
      capabilities: target.capabilities
    };
    return [
      { id: `proxmox-${target.id}`, ...shared },
      { id: target.id, ...shared }
    ];
  });
  const portainerIncidentServices = array(own(infrastructureSource(value), "services"), 64).flatMap((entry, index) => {
    const source = record(entry);
    const id = safeIdentifier(own(source, "id"));
    if (!source || !id || own(source, "type") !== "portainer") return [];
    const normalized = normalizeService({
      ...source,
      id: `portainer-${id}`,
      name: own(source, "displayName") ?? own(source, "name") ?? "Portainer",
      role: "Container infrastructure"
    }, index);
    return [normalized, { ...normalized, id }];
  });
  const incidentContext = [...services, ...infrastructureIncidentServices, ...portainerIncidentServices];
  const incidents = array(incidentCollection, 100)
    .map((entry, index) => normalizeIncident(entry, index, incidentContext))
    .filter((incident) => !["healthy", "disabled"].includes(incident.state))
    .sort((left, right) => (
      (INCIDENT_PRIORITY[left.state] ?? 99) - (INCIDENT_PRIORITY[right.state] ?? 99)
      || String(right.lastSeen || "").localeCompare(String(left.lastSeen || ""))
    ));
  const recentRecoveries = array(recentCollection, 30)
    .map((entry, index) => normalizeRecovery(entry, index, incidentContext))
    .sort((left, right) => String(right.recoveredAt || "").localeCompare(String(left.recoveredAt || "")));
  const pipeline = pipelineValues(own(source, "pipeline")).slice(0, 12).map(normalizePipelineStage);
  const workload = workloadValues(own(source, "workload")).slice(0, 12).map(normalizeWorkloadItem);
  const affectedFromServices = services.filter((service) => !["healthy", "disabled"].includes(service.state)).length;
  const overallState = normalizeHealthState(
    own(rawOverall, "state"),
    incidents[0]?.state || (services.length && affectedFromServices === 0 ? "healthy" : "stale")
  );

  return {
    version: safeInteger(own(source, "version"), 1, 1, 99),
    generatedAt: normalizeTimestamp(own(source, "generatedAt") ?? own(source, "lastUpdated")),
    overall: {
      state: overallState,
      headline: boundedText(own(rawOverall, "headline"), "", 100),
      summary: boundedText(own(rawOverall, "summary"), "", 260),
      code: boundedText(own(rawOverall, "code"), "", 80),
      serviceCount: safeInteger(own(rawOverall, "serviceCount"), services.length, 0, 99),
      activeIncidentCount: safeInteger(
        own(rawOverall, "activeIncidentCount") ?? own(rawOverall, "openIncidentCount"),
        incidents.length,
        0,
        999
      ),
      affectedServiceCount: safeInteger(own(rawOverall, "affectedServiceCount"), affectedFromServices, 0, 99)
    },
    services,
    incidents,
    recentRecoveries,
    pipeline,
    workload
  };
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function optionalInteger(values, maximum = 1_000_000) {
  const value = firstFinite(...values);
  return value === null ? null : safeInteger(value, 0, 0, maximum);
}

function optionalPercent(values) {
  const value = firstFinite(...values);
  return value === null ? null : Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function infrastructureSource(value) {
  const root = record(value) || {};
  const snapshot = record(own(root, "operationsSnapshot"))
    || record(own(root, "operations"))
    || record(own(record(own(root, "model")), "operations"))
    || root;
  return record(own(snapshot, "infrastructure"))
    || (own(root, "targets") !== undefined || own(root, "environments") !== undefined ? root : {});
}

function normalizeInfrastructureConfiguration(value, index) {
  const source = record(value) || {};
  const id = safeIdentifier(own(source, "id"), `proxmox-${index + 1}`);
  const configuredEndpoints = array(own(source, "endpoints"), 25).map((entry, endpointIndex) => {
    const endpoint = record(entry) || {};
    return {
      id: safeIdentifier(own(endpoint, "id"), `${id}-endpoint-${endpointIndex + 1}`),
      label: boundedText(own(endpoint, "label"), endpointIndex ? `Endpoint ${endpointIndex + 1}` : "Primary endpoint", 80),
      url: boundedText(own(endpoint, "url"), "", 500),
      enabled: own(endpoint, "enabled") !== false,
      primary: own(endpoint, "primary") === true || own(source, "primaryEndpointId") === own(endpoint, "id"),
      tlsMode: own(endpoint, "tlsMode") === "pinned" ? "pinned" : "system",
      credentialConfigured: own(endpoint, "credentialConfigured") === true
    };
  });
  return {
    id,
    type: safeIdentifier(own(source, "type"), "proxmox"),
    displayName: boundedText(own(source, "displayName") ?? own(source, "name"), `Proxmox ${index + 1}`, 80),
    url: boundedText(own(source, "url"), "", 500),
    enabled: own(source, "enabled") !== false,
    monitoringEnabled: own(source, "monitoringEnabled") !== false,
    tlsMode: own(source, "tlsMode") === "pinned" ? "pinned" : "system",
    certificateFingerprint: boundedText(own(source, "certificateFingerprint"), "", 96),
    credentialConfigured: own(source, "credentialConfigured") === true,
    targetRevision: boundedText(own(source, "targetRevision"), "", 100),
    primaryEndpointId: safeIdentifier(own(source, "primaryEndpointId"), id),
    endpoints: configuredEndpoints.length ? configuredEndpoints : [{
      id,
      label: "Primary endpoint",
      url: boundedText(own(source, "url"), "", 500),
      enabled: true,
      primary: true,
      tlsMode: own(source, "tlsMode") === "pinned" ? "pinned" : "system",
      credentialConfigured: own(source, "credentialConfigured") === true
    }]
  };
}

function normalizeInfrastructureEndpoint(value, index, configured = null) {
  const source = record(value) || {};
  const id = safeIdentifier(own(source, "id"), configured?.id || `endpoint-${index + 1}`);
  return {
    id,
    label: boundedText(own(source, "label"), configured?.label || `Endpoint ${index + 1}`, 80),
    url: configured?.url || boundedText(own(source, "url"), "", 500),
    enabled: configured?.enabled ?? (own(source, "enabled") !== false),
    primary: configured?.primary ?? (own(source, "primary") === true),
    tlsMode: configured?.tlsMode || (own(source, "tlsMode") === "pinned" ? "pinned" : "system"),
    credentialConfigured: configured?.credentialConfigured ?? (own(source, "credentialConfigured") === true),
    state: configured?.enabled === false ? "disabled" : normalizeHealthState(own(source, "state"), "stale"),
    connectionState: normalizeConnectionState(own(source, "connectionState")),
    latencyMs: optionalInteger([own(source, "latencyMs")], 120_000),
    lastCheckedAt: normalizeTimestamp(own(source, "checkedAt") ?? own(source, "lastCheckedAt")),
    version: boundedText(own(source, "version"), "", 80),
    selected: own(source, "selected") === true,
    code: boundedText(own(source, "code"), "", 80)
  };
}

function mergeInfrastructureEndpoints(source, configured) {
  const healthById = new Map(array(own(source, "endpoints"), 25).map((entry, index) => {
    const endpoint = record(entry) || {};
    return [safeIdentifier(own(endpoint, "id"), `endpoint-${index + 1}`), endpoint];
  }));
  const endpoints = (configured?.endpoints || []).map((endpoint, index) => {
    const health = healthById.get(endpoint.id);
    healthById.delete(endpoint.id);
    return normalizeInfrastructureEndpoint(health || { id: endpoint.id }, index, endpoint);
  });
  for (const health of healthById.values()) {
    endpoints.push(normalizeInfrastructureEndpoint(health, endpoints.length));
  }
  endpoints.sort((left, right) => Number(right.primary) - Number(left.primary) || left.label.localeCompare(right.label));
  return endpoints;
}

function inventoryInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return optionalInteger([value], maximum);
}

function normalizeInfrastructureNode(value, index, environmentId, environmentName) {
  const source = record(value) || {};
  const name = boundedText(own(source, "name") ?? own(source, "id"), `Node ${index + 1}`, 64);
  const status = ["online", "offline", "unknown"].includes(own(source, "status")) ? own(source, "status") : "unknown";
  return {
    id: `${environmentId}:${name}`,
    name,
    environmentId,
    environmentName,
    status,
    state: status === "online" ? "healthy" : status === "offline" ? "down" : "stale",
    local: own(source, "local") === true,
    cpuPercent: optionalPercent([own(source, "cpuPercent")]),
    cpuCores: inventoryInteger(own(source, "cpuCores"), 65_536),
    memoryUsedBytes: inventoryInteger(own(source, "memoryUsedBytes")),
    memoryTotalBytes: inventoryInteger(own(source, "memoryTotalBytes")),
    rootDiskUsedBytes: inventoryInteger(own(source, "rootDiskUsedBytes")),
    rootDiskTotalBytes: inventoryInteger(own(source, "rootDiskTotalBytes")),
    uptimeSeconds: inventoryInteger(own(source, "uptimeSeconds")),
    version: boundedText(own(source, "version"), "", 80),
    workloadCount: inventoryInteger(own(source, "workloadCount"), 100_000) || 0,
    runningWorkloadCount: inventoryInteger(own(source, "runningWorkloadCount"), 100_000) || 0,
    virtualMachineCount: inventoryInteger(own(source, "virtualMachineCount"), 100_000) || 0,
    containerCount: inventoryInteger(own(source, "containerCount"), 100_000) || 0
  };
}

function normalizeInfrastructureWorkload(value, index, environmentId, environmentName) {
  const source = record(value) || {};
  const type = own(source, "type") === "qemu" ? "qemu" : own(source, "type") === "lxc" ? "lxc" : "unknown";
  const vmid = inventoryInteger(own(source, "vmid"), 999_999_999);
  const node = boundedText(own(source, "node"), "Unassigned", 64);
  const status = ["running", "stopped", "paused", "suspended", "unknown"].includes(own(source, "status"))
    ? own(source, "status")
    : "unknown";
  const backup = record(own(source, "backup"));
  return {
    id: `${environmentId}:${node}:${type}:${vmid ?? index}`,
    vmid,
    type,
    kind: type === "qemu" ? "VM" : type === "lxc" ? "LXC" : "Guest",
    name: boundedText(own(source, "name"), `${type === "lxc" ? "LXC" : "VM"} ${vmid ?? index + 1}`, 96),
    node,
    environmentId,
    environmentName,
    status,
    template: own(source, "template") === true,
    cpuPercent: optionalPercent([own(source, "cpuPercent")]),
    cpuCores: inventoryInteger(own(source, "cpuCores"), 65_536),
    memoryUsedBytes: inventoryInteger(own(source, "memoryUsedBytes")),
    memoryTotalBytes: inventoryInteger(own(source, "memoryTotalBytes")),
    diskUsedBytes: inventoryInteger(own(source, "diskUsedBytes")),
    diskTotalBytes: inventoryInteger(own(source, "diskTotalBytes")),
    uptimeSeconds: inventoryInteger(own(source, "uptimeSeconds")),
    lock: boundedText(own(source, "lock"), "", 32),
    tags: array(own(source, "tags"), 16).map((entry) => boundedText(entry, "", 32)).filter(Boolean),
    backup: backup && ["success", "failed"].includes(own(backup, "status")) ? {
      status: own(backup, "status"),
      endedAt: normalizeTimestamp(own(backup, "endedAt")),
      ageSeconds: inventoryInteger(own(backup, "ageSeconds"))
    } : null
  };
}

function normalizeInfrastructureStorage(value, index, environmentId, environmentName) {
  const source = record(value) || {};
  const name = boundedText(own(source, "name"), `Storage ${index + 1}`, 80);
  const node = boundedText(own(source, "node"), "Cluster", 64);
  return {
    id: `${environmentId}:${node}:${name}`,
    name,
    node,
    environmentId,
    environmentName,
    status: boundedText(own(source, "status"), "unknown", 32),
    type: boundedText(own(source, "type"), "", 40),
    shared: own(source, "shared") === true,
    usedBytes: inventoryInteger(own(source, "usedBytes")),
    totalBytes: inventoryInteger(own(source, "totalBytes")),
    usagePercent: optionalPercent([own(source, "usagePercent")])
  };
}

function normalizeInfrastructureActivity(value, index, environmentId, environmentName) {
  const source = record(value) || {};
  return {
    id: `${environmentId}:${boundedText(own(source, "id"), String(index), 180)}`,
    environmentId,
    environmentName,
    type: boundedText(own(source, "type"), "Task", 64),
    node: boundedText(own(source, "node"), "", 64),
    vmid: inventoryInteger(own(source, "vmid"), 999_999_999),
    status: own(source, "status") === "success" ? "success" : "failed",
    endedAt: normalizeTimestamp(own(source, "endedAt")),
    ageSeconds: inventoryInteger(own(source, "ageSeconds"))
  };
}

function normalizeInfrastructureTarget(value, index, configured = null) {
  const source = record(value) || {};
  const metrics = record(own(source, "metrics")) || {};
  const nodeMetrics = record(own(metrics, "nodes")) || record(own(source, "nodes")) || {};
  const guestMetrics = record(own(metrics, "guests")) || record(own(source, "guests")) || {};
  const storageMetrics = record(own(metrics, "storage")) || record(own(source, "storage")) || {};
  const taskMetrics = record(own(metrics, "tasks")) || record(own(source, "tasks")) || {};
  const backupMetrics = record(own(metrics, "backups")) || record(own(source, "backups")) || {};
  const id = safeIdentifier(own(source, "id") ?? own(source, "targetId"), configured?.id || `proxmox-${index + 1}`);
  const capabilities = array(own(source, "capabilities") ?? own(source, "checks"), 24)
    .map((entry, capabilityIndex) => normalizeCapability(entry, capabilityIndex, configured?.displayName || "Proxmox"));
  const suppliedLatency = own(source, "latencyMs") ?? own(source, "latency");
  const capabilityLatencies = capabilities.map((entry) => entry.latencyMs).filter((entry) => entry !== null);
  const displayName = boundedText(
    own(source, "displayName") ?? own(source, "name") ?? own(source, "label"),
    configured?.displayName || `Proxmox ${index + 1}`,
    80
  );
  const discovery = record(own(source, "discovery")) || {};
  const configuredKind = ["cluster", "standalone", "unknown"].includes(configured?.environmentKind)
    ? configured.environmentKind
    : "unknown";
  const environmentKind = ["cluster", "standalone", "unknown"].includes(own(discovery, "kind"))
    ? own(discovery, "kind")
    : configuredKind;
  const endpoints = mergeInfrastructureEndpoints(source, configured);
  const nodes = array(own(source, "nodes"), 128)
    .map((entry, nodeIndex) => normalizeInfrastructureNode(entry, nodeIndex, id, displayName));
  const workloads = array(own(source, "workloads"), 5_000)
    .map((entry, workloadIndex) => normalizeInfrastructureWorkload(entry, workloadIndex, id, displayName));
  const storage = array(own(source, "storage"), 1_000)
    .map((entry, storageIndex) => normalizeInfrastructureStorage(entry, storageIndex, id, displayName));
  const activity = array(own(source, "activity"), 100)
    .map((entry, activityIndex) => normalizeInfrastructureActivity(entry, activityIndex, id, displayName));
  return {
    id,
    type: configured?.type || safeIdentifier(own(source, "type"), "proxmox"),
    displayName,
    url: configured?.url || boundedText(own(source, "url"), "", 500),
    state: configured?.enabled === false
      || configured?.monitoringEnabled === false
      || own(source, "enabled") === false
      || own(source, "monitoringEnabled") === false
      ? "disabled"
      : normalizeHealthState(own(source, "state"), capabilities.length ? "stale" : "stale"),
    message: boundedText(own(source, "message") ?? own(source, "summary"), "", 220),
    version: boundedText(own(source, "version") ?? own(metrics, "version"), "", 80),
    connectionState: normalizeConnectionState(own(source, "connectionState")),
    lastCheckedAt: normalizeTimestamp(own(source, "lastCheckedAt") ?? own(source, "checkedAt")),
    latencyMs: Number.isFinite(Number(suppliedLatency))
      ? safeInteger(suppliedLatency, 0, 0, 120_000)
      : capabilityLatencies.length ? Math.max(...capabilityLatencies) : null,
    capabilities,
    reports: normalizeOperationsReports(
      own(source, "reports"),
      `${configured?.displayName || boundedText(own(source, "displayName"), "Proxmox", 80)} health`
    ),
    enabled: configured?.enabled ?? (own(source, "enabled") !== false),
    monitoringEnabled: configured?.monitoringEnabled ?? (own(source, "monitoringEnabled") !== false),
    tlsMode: configured?.tlsMode || (own(source, "tlsMode") === "pinned" ? "pinned" : "system"),
    credentialConfigured: configured?.credentialConfigured ?? own(source, "credentialConfigured") === true,
    environmentKind,
    environmentName: boundedText(own(discovery, "name"), configured?.environmentName || displayName, 80),
    clusterName: environmentKind === "cluster" ? boundedText(own(discovery, "clusterName"), configured?.clusterName || "Proxmox cluster", 80) : "",
    quorate: environmentKind === "cluster" && typeof own(discovery, "quorate") === "boolean"
      ? own(discovery, "quorate")
      : null,
    selectedEndpointId: safeIdentifier(own(source, "selectedEndpointId"), ""),
    endpoints,
    nodes,
    workloads,
    storage,
    activity,
    metrics: {
      nodeTotal: optionalInteger([
        own(metrics, "nodeTotal"), own(metrics, "nodesTotal"), own(nodeMetrics, "total"), own(source, "nodeCount")
      ], 10_000),
      nodesOnline: optionalInteger([
        own(metrics, "nodeOnline"), own(metrics, "nodesOnline"), own(metrics, "onlineNodes"), own(nodeMetrics, "online"), own(source, "nodeOnline"), own(source, "nodesOnline")
      ], 10_000),
      nodesOffline: optionalInteger([
        own(metrics, "nodeOffline"), own(metrics, "nodesOffline"), own(nodeMetrics, "offline"), own(source, "nodeOffline")
      ], 10_000),
      nodeCpuPercent: optionalPercent([
        own(metrics, "nodeCpuUsagePercent"), own(metrics, "cpuPercent"), own(nodeMetrics, "cpuPercent")
      ]),
      nodeMemoryUsedBytes: optionalInteger([
        own(metrics, "nodeMemoryUsedBytes"), own(nodeMetrics, "memoryUsedBytes")
      ], Number.MAX_SAFE_INTEGER),
      nodeMemoryTotalBytes: optionalInteger([
        own(metrics, "nodeMemoryTotalBytes"), own(nodeMetrics, "memoryTotalBytes")
      ], Number.MAX_SAFE_INTEGER),
      nodeDiskUsedBytes: optionalInteger([
        own(metrics, "nodeDiskUsedBytes"), own(nodeMetrics, "diskUsedBytes")
      ], Number.MAX_SAFE_INTEGER),
      nodeDiskTotalBytes: optionalInteger([
        own(metrics, "nodeDiskTotalBytes"), own(nodeMetrics, "diskTotalBytes")
      ], Number.MAX_SAFE_INTEGER),
      guestTotal: optionalInteger([
        own(metrics, "guestTotal"), own(guestMetrics, "total"), own(source, "guestTotal")
      ], 100_000),
      guestsRunning: optionalInteger([
        own(metrics, "guestRunning"), own(metrics, "guestsRunning"), own(metrics, "runningGuests"), own(guestMetrics, "running"), own(source, "guestRunning"), own(source, "guestsRunning")
      ], 100_000),
      virtualMachineTotal: optionalInteger([
        own(metrics, "virtualMachineTotal"), own(guestMetrics, "virtualMachines")
      ], 100_000),
      containerTotal: optionalInteger([
        own(metrics, "containerTotal"), own(guestMetrics, "containers")
      ], 100_000),
      guestsStopped: optionalInteger([
        own(metrics, "guestStopped"), own(metrics, "guestsStopped"), own(metrics, "stoppedGuests"), own(guestMetrics, "stopped"), own(source, "guestStopped"), own(source, "guestsStopped")
      ], 100_000),
      storagePercent: optionalPercent([
        own(metrics, "storageUsagePercent"), own(metrics, "storagePercent"), own(metrics, "storageUsedPercent"), own(storageMetrics, "percentUsed"), own(storageMetrics, "usedPercent")
      ]),
      storageWarnings: optionalInteger([
        own(metrics, "storageUnavailable"), own(metrics, "storageWarnings"), own(storageMetrics, "warnings"), own(storageMetrics, "warningCount"), own(storageMetrics, "offline")
      ], 10_000),
      storageUsedBytes: optionalInteger([
        own(metrics, "storageUsedBytes"), own(storageMetrics, "usedBytes")
      ], Number.MAX_SAFE_INTEGER),
      storageTotalBytes: optionalInteger([
        own(metrics, "storageTotalBytes"), own(storageMetrics, "totalBytes")
      ], Number.MAX_SAFE_INTEGER),
      failedTasks: optionalInteger([
        own(metrics, "failedTasks24h"), own(metrics, "failedTasks"), own(taskMetrics, "failed"), own(taskMetrics, "failureCount"), own(source, "failedTasks24h"), own(source, "failedTasks")
      ], 100_000),
      backupFailures: optionalInteger([
        own(metrics, "backupFailures24h"), own(metrics, "backupFailures"), own(backupMetrics, "failed"), own(backupMetrics, "failureCount"), own(source, "backupFailures24h"), own(source, "backupFailures")
      ], 100_000),
      staleBackups: optionalInteger([
        own(metrics, "staleBackups"), own(backupMetrics, "stale"), own(backupMetrics, "staleCount"), own(source, "staleBackups")
      ], 100_000),
      lastBackupSuccessAgeSeconds: optionalInteger([
        own(metrics, "lastBackupSuccessAgeSeconds"), own(backupMetrics, "lastSuccessAgeSeconds")
      ], Number.MAX_SAFE_INTEGER),
      lastBackupFailureAgeSeconds: optionalInteger([
        own(metrics, "lastBackupFailureAgeSeconds"), own(backupMetrics, "lastFailureAgeSeconds")
      ], Number.MAX_SAFE_INTEGER)
    }
  };
}

function sumInfrastructureMetric(targets, key) {
  const values = targets.map((target) => target.metrics[key]).filter((value) => value !== null);
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function maxInfrastructureMetric(targets, key) {
  const values = targets.map((target) => target.metrics[key]).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function averageInfrastructurePercent(targets, key, weightKey = "") {
  const values = targets
    .map((target) => ({ value: target.metrics[key], weight: weightKey ? target.metrics[weightKey] : null }))
    .filter((entry) => entry.value !== null);
  if (!values.length) return null;
  const weighted = weightKey ? values.filter((entry) => entry.weight !== null && entry.weight > 0) : [];
  const result = weighted.length === values.length
    ? weighted.reduce((total, entry) => total + (entry.value * entry.weight), 0)
      / weighted.reduce((total, entry) => total + entry.weight, 0)
    : values.reduce((total, entry) => total + entry.value, 0) / values.length;
  return Math.round(result * 10) / 10;
}

const INFRASTRUCTURE_PRIORITY = Object.freeze({
  down: 0,
  "authentication-required": 1,
  degraded: 2,
  limited: 3,
  stale: 4,
  checking: 5,
  healthy: 6,
  disabled: 7
});

/**
 * Converts the additive operations.infrastructure payload and separately
 * returned target metadata into one bounded, renderer-safe view model.
 */
export function normalizeInfrastructureSnapshot(value = {}, configuredTargets = []) {
  const source = infrastructureSource(value);
  const configuration = array(configuredTargets, 64).map(normalizeInfrastructureConfiguration);
  const healthById = new Map(array(own(source, "environments") ?? own(source, "targets") ?? own(source, "items"), 64).map((entry, index) => {
    const rawTarget = record(entry) || {};
    const id = safeIdentifier(own(rawTarget, "id") ?? own(rawTarget, "targetId"), `proxmox-${index + 1}`);
    return [id, rawTarget];
  }));
  const targets = configuration.map((configured, index) => {
    const health = healthById.get(configured.id);
    healthById.delete(configured.id);
    return normalizeInfrastructureTarget(health || { id: configured.id }, index, configured);
  });
  for (const health of healthById.values()) {
    targets.push(normalizeInfrastructureTarget(health, targets.length));
  }
  targets.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));

  const rawOverall = record(own(source, "overall")) || source;
  const activeTargets = targets.filter((target) => target.enabled !== false && target.monitoringEnabled !== false);
  const suppliedState = own(rawOverall, "state");
  const state = targets.length === 0 || activeTargets.length === 0
    ? "disabled"
    : suppliedState
      ? normalizeHealthState(suppliedState)
      : [...activeTargets].sort((left, right) => (
          (INFRASTRUCTURE_PRIORITY[left.state] ?? 99) - (INFRASTRUCTURE_PRIORITY[right.state] ?? 99)
        ))[0]?.state || "stale";
  const affectedTargets = targets.filter((target) => !["healthy", "disabled"].includes(target.state)).length;
  const backupFailures = sumInfrastructureMetric(targets, "backupFailures");
  const staleBackups = sumInfrastructureMetric(targets, "staleBackups");
  const storageUsedBytes = sumInfrastructureMetric(targets, "storageUsedBytes");
  const storageTotalBytes = sumInfrastructureMetric(targets, "storageTotalBytes");
  const nodes = targets.flatMap((target) => target.nodes);
  const workloads = targets.flatMap((target) => target.workloads);
  const storage = targets.flatMap((target) => target.storage);
  const activity = targets.flatMap((target) => target.activity)
    .sort((left, right) => String(right.endedAt || "").localeCompare(String(left.endedAt || "")))
    .slice(0, 100);

  return {
    generatedAt: normalizeTimestamp(own(source, "generatedAt") ?? own(source, "lastUpdated") ?? own(value, "generatedAt")),
    overall: {
      state,
      headline: boundedText(own(rawOverall, "headline"), "", 120),
      summary: boundedText(own(rawOverall, "summary"), "", 280),
      environmentCount: targets.length,
      targetCount: targets.length,
      affectedTargetCount: affectedTargets
    },
    environments: targets,
    targets,
    nodes,
    workloads,
    storage,
    activity,
    metrics: {
      nodesOnline: sumInfrastructureMetric(targets, "nodesOnline"),
      nodesOffline: sumInfrastructureMetric(targets, "nodesOffline"),
      nodeTotal: sumInfrastructureMetric(targets, "nodeTotal"),
      nodeCpuPercent: averageInfrastructurePercent(targets, "nodeCpuPercent", "nodeTotal"),
      nodeMemoryUsedBytes: sumInfrastructureMetric(targets, "nodeMemoryUsedBytes"),
      nodeMemoryTotalBytes: sumInfrastructureMetric(targets, "nodeMemoryTotalBytes"),
      nodeDiskUsedBytes: sumInfrastructureMetric(targets, "nodeDiskUsedBytes"),
      nodeDiskTotalBytes: sumInfrastructureMetric(targets, "nodeDiskTotalBytes"),
      guestTotal: sumInfrastructureMetric(targets, "guestTotal"),
      guestsRunning: sumInfrastructureMetric(targets, "guestsRunning"),
      guestsStopped: sumInfrastructureMetric(targets, "guestsStopped"),
      virtualMachineTotal: sumInfrastructureMetric(targets, "virtualMachineTotal"),
      containerTotal: sumInfrastructureMetric(targets, "containerTotal"),
      storagePercent: storageUsedBytes !== null && storageTotalBytes
        ? Math.round(Math.min(100, (storageUsedBytes / storageTotalBytes) * 100) * 10) / 10
        : averageInfrastructurePercent(targets, "storagePercent"),
      storageWarnings: sumInfrastructureMetric(targets, "storageWarnings"),
      storageUsedBytes,
      storageTotalBytes,
      failedTasks: sumInfrastructureMetric(targets, "failedTasks"),
      lastBackupSuccessAgeSeconds: maxInfrastructureMetric(targets, "lastBackupSuccessAgeSeconds"),
      lastBackupFailureAgeSeconds: maxInfrastructureMetric(targets, "lastBackupFailureAgeSeconds"),
      backupIssues: backupFailures === null && staleBackups === null
        ? null
        : (backupFailures || 0) + (staleBackups || 0)
    }
  };
}

function overallCopy(snapshot) {
  const { state, activeIncidentCount, affectedServiceCount, serviceCount } = snapshot.overall;
  const incidentWord = activeIncidentCount === 1 ? "incident" : "incidents";
  const serviceWord = affectedServiceCount === 1 ? "service" : "services";
  const defaults = {
    healthy: ["Everything is working", "Every monitored capability is responding normally."],
    limited: [
      "A non-critical feature is limited",
      activeIncidentCount
        ? `${activeIncidentCount} active ${incidentWord} across ${affectedServiceCount} ${serviceWord}; core workflows remain available.`
        : "An optional capability just failed; core workflows remain available."
    ],
    degraded: [
      "Part of your media pipeline needs attention",
      activeIncidentCount
        ? `${activeIncidentCount} active ${incidentWord} ${activeIncidentCount === 1 ? "is" : "are"} affecting ${affectedServiceCount} ${serviceWord}.`
        : `A current capability failure is affecting ${affectedServiceCount} ${serviceWord}; Helmsman will open an incident if it persists.`
    ],
    down: [
      "Action required",
      serviceCount
        ? `${affectedServiceCount} ${serviceWord} cannot complete a core API check.`
        : "Helmsman cannot load or assess the configured services."
    ],
    "authentication-required": ["Credentials need attention", "At least one service rejected its configured credential."],
    stale: ["Health data is stale", "Helmsman cannot confirm the current state of the stack yet."],
    checking: ["Checking your stack", "Helmsman is collecting fresh capability checks."],
    disabled: ["Monitoring is disabled", "Enable at least one service to begin health monitoring."]
  }[state] || ["Health is unknown", "Helmsman has not received a trustworthy health snapshot yet."];
  return {
    headline: snapshot.overall.headline || defaults[0],
    summary: snapshot.overall.summary || defaults[1]
  };
}

function statusBadge(state, className = "") {
  const normalized = normalizeHealthState(state);
  const meta = healthMeta(normalized);
  return `<span class="operations-status-badge is-${normalized}${className ? ` ${className}` : ""}"><i></i>${escapeOperationsHtml(meta.label)}</span>`;
}

function incidentEvidence(incident) {
  const pieces = [];
  if (incident.status) pieces.push(`HTTP ${incident.status}`);
  if (incident.code) pieces.push(incident.code);
  if (incident.occurrenceCount > 1) pieces.push(`Observed ${incident.occurrenceCount} times`);
  return pieces;
}

export function incidentNextStep(incident) {
  if (incident.nextStep) return incident.nextStep;
  const isPortainer = incident.scope === "infrastructure" && String(incident.service || "").startsWith("portainer-");
  if (isPortainer
    && incident.code === "CONTAINERS_UNHEALTHY") {
    return "Open the Portainer inventory and inspect the named unhealthy, dead, or restarting container and its recent logs.";
  }
  if (isPortainer
    && /^PORTAINER_ENVIRONMENT_(?:DOWN|ERROR|PROVISIONING|UNKNOWN)$/u.test(incident.code)) {
    return "Open Portainer Environments, verify the affected endpoint or agent state, then run a fresh Helmsman check.";
  }
  if (isPortainer
    && (incident.state === "authentication-required" || /AUTH|UNAUTHORIZED|FORBIDDEN/u.test(incident.code))) {
    return "Replace the Portainer access token or grant its user access to the intended environments, then retest the connection.";
  }
  const proxmoxTaskOrBackup = incident.scope === "infrastructure" && /task|backup/iu.test(incident.capability);
  if (proxmoxTaskOrBackup && incident.status === 400) {
    return "Verify the configured Proxmox base URL and PVE API compatibility for the node-scoped task or backup request, then retest.";
  }
  if (proxmoxTaskOrBackup && incident.status === 403) {
    return "Grant the Proxmox token propagated Sys.Audit access on the affected /nodes/{node} path, then retest.";
  }
  if (proxmoxTaskOrBackup && /^(?:TASK|BACKUP)_HISTORY_(?:PARTIAL|UNAVAILABLE)$/u.test(incident.code)) {
    return "Review the affected nodes named in the sanitized report, verify node reachability and propagated Sys.Audit access, then retest.";
  }
  if (/^HEALTH_(?:WARNING|ERROR)$/u.test(incident.code)
    && ["radarr", "sonarr", "prowlarr"].includes(incident.service)) {
    return `Review ${incident.serviceName} System → Status for its reported health messages.`;
  }
  if (/^HEALTH_(?:WARNING|ERROR)$/u.test(incident.code)) {
    return `Review ${incident.serviceName}'s health page and recent logs.`;
  }
  if (incident.code === "INDEXERS_BLOCKED") {
    return "Test or disable the affected indexers in Prowlarr.";
  }
  if (incident.state === "authentication-required" || /AUTH|UNAUTHORIZED|FORBIDDEN/u.test(incident.code)) {
    return "Verify or replace this service credential.";
  }
  if (/TIMEOUT|NETWORK|CONNECT/u.test(incident.code)) {
    return "Check service reachability and recent service logs.";
  }
  if (incident.status >= 500) return "Inspect the service logs around the latest failure.";
  if (incident.state === "limited") return "Review the failed optional capability in Logs.";
  return "Open Logs for the latest sanitized evidence.";
}

export function renderOperationsReports(value, serviceName = "Service") {
  const reporter = boundedText(serviceName, "Service", 60);
  const reports = normalizeOperationsReports(value, `${reporter} health`);
  if (!reports.length) return "";
  return `<div class="operations-reports" aria-label="Messages reported by ${escapeOperationsHtml(reporter)}">
    <span class="operations-reports__heading">Reported by ${escapeOperationsHtml(reporter)}</span>
    <ul>${reports.map((report) => `<li class="operations-report is-${report.severity}">
      <i aria-hidden="true"></i>
      <div><p>${escapeOperationsHtml(report.message)}</p><small>${escapeOperationsHtml(report.source)} · ${escapeOperationsHtml(report.severity)}</small></div>
    </li>`).join("")}</ul>
  </div>`;
}

function renderIncident(incident) {
  const meta = healthMeta(incident.state);
  const evidence = incidentEvidence(incident);
  return `
    <article class="operations-incident is-${incident.state}">
      <span class="operations-incident__icon is-${meta.tone}">${svgIcon(meta.icon)}</span>
      <div class="operations-incident__body">
        <div class="operations-incident__heading">
          <div>
            <span class="operations-kicker">${escapeOperationsHtml(incident.serviceName)} · ${escapeOperationsHtml(incident.capability)}</span>
            <h3>${escapeOperationsHtml(incident.summary)}</h3>
          </div>
          ${statusBadge(incident.state)}
        </div>
        ${evidence.length ? `<ul class="operations-evidence" aria-label="Incident evidence">${evidence.map((entry) => `<li>${escapeOperationsHtml(entry)}</li>`).join("")}</ul>` : ""}
        ${renderOperationsReports(incident.reports, incident.serviceName)}
        <p class="operations-next-step"><strong>Next step</strong><span>${escapeOperationsHtml(incidentNextStep(incident))}</span></p>
        <footer>
          <span>First seen ${timestampMarkup(incident.firstSeen, "recently")}</span>
          <span>Latest failure ${timestampMarkup(incident.lastSeen, "not recorded")}</span>
          <a class="operations-text-link" href="#/logs">View logs ${svgIcon("chevron")}</a>
        </footer>
      </div>
    </article>`;
}

function renderPipeline(snapshot) {
  const stages = snapshot.pipeline;
  return `
    <section class="operations-panel operations-pipeline" aria-labelledby="operations-pipeline-title">
      <header class="operations-section-heading">
        <div><span class="operations-kicker">End-to-end signal</span><h2 id="operations-pipeline-title">Media pipeline</h2><p>See where requests stop moving toward playback.</p></div>
        <a class="operations-text-link" href="#/pipeline">Open pipeline ${svgIcon("chevron")}</a>
      </header>
      ${stages.length ? `<ol class="operations-pipeline__list">${stages.map((stage) => {
        const meta = healthMeta(stage.state);
        const detail = stage.detail
          || (stage.failingCheckCount > 0
            ? `${stage.failingCheckCount} API check${stage.failingCheckCount === 1 ? "" : "s"} need attention`
            : stage.state === "healthy" && stage.serviceCount > 0
              ? `${stage.serviceCount} service${stage.serviceCount === 1 ? "" : "s"} reporting normally`
              : stage.state === "stale" && stage.serviceCount === 0
                ? "Waiting for a configured service"
                : meta.label);
        return `<li class="operations-pipeline__stage is-${stage.state}"><span class="operations-pipeline__marker">${svgIcon(meta.icon)}</span><div><span>${escapeOperationsHtml(stage.hint)}</span><strong>${escapeOperationsHtml(stage.label)}</strong><small>${escapeOperationsHtml(detail)}</small></div>${stage.count !== null ? `<em aria-label="${stage.count} items">${stage.count}</em>` : ""}</li>`;
      }).join("")}</ol>` : `<div class="operations-empty"><span>${svgIcon("refresh")}</span><strong>Pipeline signals are not available yet</strong><p>They will appear after the first complete monitoring cycle.</p></div>`}
    </section>`;
}

function serviceSummary(service) {
  if (service.message) return service.message;
  if (!service.capabilities.length) return service.state === "disabled" ? "Monitoring disabled" : "No capability results yet";
  if (!service.failedCapabilities.length) return `${service.healthyCapabilityCount} of ${service.capabilities.length} capabilities healthy`;
  const first = service.failedCapabilities[0];
  return `${first.name}${service.failedCapabilities.length > 1 ? ` and ${service.failedCapabilities.length - 1} more` : ""} ${first.state === "stale" ? "is stale" : "needs attention"}`;
}

function renderService(service) {
  const isKnown = Object.prototype.hasOwnProperty.call(SERVICE_COPY, service.id);
  const meta = healthMeta(service.state);
  const facts = [];
  if (service.latencyMs !== null) facts.push(`${service.latencyMs} ms`);
  if (service.version) facts.push(`v${service.version}`);
  if (!facts.length && service.lastCheckedAt) facts.push("Checked");
  const content = `<span class="operations-service__mark">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span><span class="operations-service__copy"><span class="operations-kicker">${escapeOperationsHtml(service.role)}</span><strong>${escapeOperationsHtml(service.name)}</strong><small>${escapeOperationsHtml(serviceSummary(service))}</small>${facts.length ? `<em>${escapeOperationsHtml(facts.join(" · "))}</em>` : ""}</span><span class="operations-service__state"><i class="is-${meta.tone}"></i>${escapeOperationsHtml(meta.label)}</span>${isKnown ? svgIcon("chevron") : ""}`;
  return isKnown
    ? `<li><button class="operations-service" type="button" data-action="open-service" data-service-id="${escapeOperationsHtml(service.id)}" aria-label="Open ${escapeOperationsHtml(service.name)} connection details">${content}</button></li>`
    : `<li><article class="operations-service">${content}</article></li>`;
}

function renderServices(snapshot) {
  return `
    <section class="operations-panel operations-services" aria-labelledby="operations-services-title">
      <header class="operations-section-heading">
        <div><span class="operations-kicker">Capability-aware</span><h2 id="operations-services-title">Service health</h2><p>A reachable service can still have a failing feature.</p></div>
        <a class="operations-text-link" href="#/services">All services ${svgIcon("chevron")}</a>
      </header>
      ${snapshot.services.length ? `<ul class="operations-services__list">${snapshot.services.map(renderService).join("")}</ul>` : `<div class="operations-empty"><span>${svgIcon("shield")}</span><strong>No monitored services</strong><p>Add a service connection to begin collecting health signals.</p></div>`}
    </section>`;
}

function renderWorkload(snapshot) {
  return `
    <section class="operations-panel operations-workload" aria-labelledby="operations-workload-title">
      <header class="operations-section-heading"><div><span class="operations-kicker">Right now</span><h2 id="operations-workload-title">Current workload</h2></div></header>
      ${snapshot.workload.length ? `<ul class="operations-workload__grid">${snapshot.workload.map((item) => `<li><a class="operations-workload__metric is-${item.state}" href="${escapeOperationsHtml(item.href)}"><strong>${item.value.toLocaleString()}</strong><span>${escapeOperationsHtml(item.label)}</span>${item.detail ? `<small>${escapeOperationsHtml(item.detail)}</small>` : ""}</a></li>`).join("")}</ul>` : `<div class="operations-empty is-compact"><span>${svgIcon("download")}</span><strong>No workload data yet</strong><p>Queue and transfer counts appear after monitoring starts.</p></div>`}
    </section>`;
}

function renderRecoveries(snapshot) {
  return `
    <section class="operations-panel operations-recoveries" aria-labelledby="operations-recoveries-title">
      <header class="operations-section-heading"><div><span class="operations-kicker">Back to normal</span><h2 id="operations-recoveries-title">Recent recoveries</h2></div></header>
      ${snapshot.recentRecoveries.length ? `<ul class="operations-recoveries__list">${snapshot.recentRecoveries.slice(0, 6).map((recovery) => {
        const duration = durationLabel(recovery.firstSeen, recovery.recoveredAt);
        return `<li><span class="operations-recovery__icon">${svgIcon("check")}</span><div><strong>${escapeOperationsHtml(recovery.serviceName)} recovered</strong><span>${escapeOperationsHtml(recovery.capability)} is healthy again</span><small>${timestampMarkup(recovery.recoveredAt, "Recently")}${duration ? ` · after ${escapeOperationsHtml(duration)}` : ""}</small></div></li>`;
      }).join("")}</ul>` : `<div class="operations-empty is-compact"><span>${svgIcon("check")}</span><strong>No recent recoveries</strong><p>Resolved incidents will be recorded here.</p></div>`}
    </section>`;
}

/**
 * Renders the operations-first Overview. The function is intentionally pure;
 * event handling remains with app.js through existing data-action, route, and
 * data-service-id hooks.
 */
export function renderOperationsOverview(value = {}, configuredInfrastructureTargets = []) {
  const normalized = normalizeOperationsSnapshot(value, configuredInfrastructureTargets);
  const snapshot = {
    ...normalized,
    incidents: normalized.incidents.filter((incident) => incident.scope !== "infrastructure"),
    recentRecoveries: normalized.recentRecoveries.filter((recovery) => recovery.scope !== "infrastructure")
  };
  const state = snapshot.overall.state;
  const meta = healthMeta(state);
  const copy = overallCopy(snapshot);

  return `
    <div class="page operations-page">
      <section class="operations-overall is-${state}" aria-labelledby="operations-overall-title">
        <div class="operations-overall__status"><span class="operations-overall__icon is-${meta.tone}">${svgIcon(meta.icon)}</span><div><span class="operations-kicker">Stack assessment</span><span class="operations-overall__label">${escapeOperationsHtml(meta.label)}</span></div></div>
        <div class="operations-overall__copy">
          <h2 id="operations-overall-title">${escapeOperationsHtml(copy.headline)}</h2>
          <p>${escapeOperationsHtml(copy.summary)}</p>
        </div>
        <dl class="operations-overall__facts">
          <div><dt>Active incidents</dt><dd>${snapshot.overall.activeIncidentCount}</dd></div>
          <div><dt>Affected services</dt><dd>${snapshot.overall.affectedServiceCount}</dd></div>
          <div><dt>Last assessment</dt><dd>${timestampMarkup(snapshot.generatedAt, "Waiting for data")}</dd></div>
        </dl>
        <button class="operations-refresh" type="button" data-action="refresh-live">${svgIcon("refresh")}<span>Refresh now</span></button>
      </section>

      <section class="operations-panel operations-incidents" aria-labelledby="operations-incidents-title">
        <header class="operations-section-heading">
          <div><span class="operations-kicker">Prioritized by impact</span><h2 id="operations-incidents-title">Needs attention</h2><p>Repeated failures are grouped into one incident with useful evidence.</p></div>
          <span class="operations-count" aria-label="${snapshot.incidents.length} active incidents">${snapshot.incidents.length}</span>
        </header>
        ${snapshot.incidents.length ? `<div class="operations-incidents__list">${snapshot.incidents.map(renderIncident).join("")}</div>` : `<div class="operations-empty is-success"><span>${svgIcon("check")}</span><strong>No active incidents</strong><p>All currently monitored capabilities are operating normally.</p></div>`}
      </section>

      ${renderPipeline(snapshot)}

      <div class="operations-detail-grid">
        ${renderServices(snapshot)}
        <aside class="operations-side-stack" aria-label="Operations supporting information">
          ${renderWorkload(snapshot)}
          ${renderRecoveries(snapshot)}
        </aside>
      </div>
    </div>`;
}

function infrastructureOverallCopy(snapshot) {
  if (!snapshot.targets.length) {
    return {
      headline: "Connect your first Proxmox environment",
      summary: "Start with one explicitly trusted endpoint. Helmsman will discover whether it represents a standalone server or a cluster."
    };
  }
  const defaults = {
    healthy: ["Infrastructure is operating normally", "Every monitored Proxmox environment is responding through at least one trusted API endpoint."],
    limited: ["Infrastructure visibility is limited", "An API endpoint or non-critical signal needs attention while cluster inventory remains available."],
    degraded: ["Part of your infrastructure needs attention", "At least one Proxmox environment or core capability is not operating normally."],
    down: ["A Proxmox environment is unavailable", "Helmsman cannot collect inventory through any trusted endpoint for at least one environment."],
    "authentication-required": ["Proxmox credentials need attention", "Every usable endpoint for at least one environment rejected its configured API token."],
    stale: ["Waiting for infrastructure health", "Configured environments will appear here after the next monitoring cycle."],
    checking: ["Checking Proxmox", "Helmsman is collecting a fresh read-only infrastructure snapshot."],
    disabled: ["Infrastructure monitoring is paused", "Enable monitoring on a Proxmox environment to collect health signals."]
  }[snapshot.overall.state] || ["Infrastructure state is unknown", "Helmsman has not received a trustworthy Proxmox snapshot yet."];
  return {
    headline: snapshot.overall.headline || defaults[0],
    summary: snapshot.overall.summary || defaults[1]
  };
}

function infrastructureMetric(value, fallback = "Waiting") {
  return value === null ? fallback : Number(value).toLocaleString();
}

function storageMetric(value) {
  return value === null ? "Waiting" : `${value.toLocaleString()}%`;
}

function bytesMetric(value) {
  if (value === null) return "Waiting";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const precision = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(precision)} ${units[unit]}`;
}

function ratioMetric(used, total) {
  if (used === null || total === null || total === 0) return "Waiting";
  return `${Math.min(100, Math.round((used / total) * 1_000) / 10).toLocaleString()}%`;
}

function durationMetric(seconds) {
  if (seconds === null) return "Waiting";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function infrastructureTargetSummary(target) {
  if (target.message) return target.message;
  if (!target.monitoringEnabled) return "Continuous monitoring is disabled";
  if (!target.capabilities.length) return "Waiting for the first capability check";
  const failures = target.capabilities.filter((capability) => !["healthy", "disabled"].includes(capability.state));
  if (!failures.length) return `${target.capabilities.length} read-only checks passed`;
  return `${failures[0].name}${failures.length > 1 ? ` and ${failures.length - 1} more` : ""} needs attention`;
}

function renderInfrastructureTarget(target) {
  const meta = healthMeta(target.state);
  const nodeCopy = target.metrics.nodesOnline === null
    ? "Nodes pending"
    : `${target.metrics.nodesOnline}${target.metrics.nodeTotal === null ? "" : `/${target.metrics.nodeTotal}`} nodes online`;
  const guestCopy = target.metrics.guestsRunning === null
    ? "Guests pending"
    : `${target.metrics.guestsRunning} guests running`;
  const facts = [nodeCopy, guestCopy];
  if (target.version) facts.push(`PVE ${target.version}`);
  if (target.latencyMs !== null) facts.push(`${target.latencyMs} ms`);
  const kind = target.environmentKind === "cluster" ? "Multi-node cluster" : target.environmentKind === "standalone" ? "Standalone server" : "Discovery pending";
  const endpointCount = target.endpoints.length || 1;
  facts.push(`${endpointCount} API endpoint${endpointCount === 1 ? "" : "s"}`);
  return `<li><button class="infrastructure-target" type="button" data-action="open-infrastructure-environment-detail" data-infrastructure-target-id="${escapeOperationsHtml(target.id)}" aria-label="Open ${escapeOperationsHtml(target.displayName)} environment details">
    <span class="infrastructure-target__mark">${serviceIconMarkup("proxmox", "P")}</span>
    <span class="infrastructure-target__copy">
      <span class="operations-kicker">${escapeOperationsHtml(kind)}</span>
      <strong>${escapeOperationsHtml(target.displayName)}</strong>
      <small>${escapeOperationsHtml(infrastructureTargetSummary(target))}</small>
      <code>${escapeOperationsHtml(target.clusterName || target.environmentName || target.url || "Environment details unavailable")}</code>
      <em data-infrastructure-target-facts>${escapeOperationsHtml(facts.join(" · "))}</em>
    </span>
    <span class="infrastructure-target__state is-${target.state}" data-infrastructure-target-state><i class="is-${meta.tone}"></i>${escapeOperationsHtml(meta.label)}</span>
    ${svgIcon("chevron")}
  </button></li>`;
}

/** Renders the Infrastructure workspace without exposing credential material. */
export function renderInfrastructureOverview(value = {}, configuredTargets = []) {
  const snapshot = normalizeInfrastructureSnapshot(value, configuredTargets);
  const state = snapshot.overall.state;
  const meta = healthMeta(state);
  const copy = infrastructureOverallCopy(snapshot);
  const nodes = snapshot.metrics.nodesOnline === null
    ? "Waiting"
    : `${snapshot.metrics.nodesOnline}${snapshot.metrics.nodeTotal === null ? "" : ` / ${snapshot.metrics.nodeTotal}`}`;
  const storageTone = snapshot.metrics.storagePercent !== null && snapshot.metrics.storagePercent >= 90 ? "danger"
    : snapshot.metrics.storagePercent !== null && snapshot.metrics.storagePercent >= 80 ? "warning"
      : "neutral";
  const guestDetail = snapshot.metrics.guestTotal === null
    ? "VM and container inventory"
    : `${snapshot.metrics.virtualMachineTotal ?? 0} VM · ${snapshot.metrics.containerTotal ?? 0} LXC · ${snapshot.metrics.guestsStopped ?? 0} stopped`;
  const storageDetail = snapshot.metrics.storageWarnings
    ? `${snapshot.metrics.storageWarnings} unavailable storage entr${snapshot.metrics.storageWarnings === 1 ? "y" : "ies"}`
    : snapshot.metrics.storageUsedBytes !== null && snapshot.metrics.storageTotalBytes !== null
      ? `${bytesMetric(snapshot.metrics.storageUsedBytes)} of ${bytesMetric(snapshot.metrics.storageTotalBytes)}`
      : "Across active storage";
  const backupDetail = snapshot.metrics.lastBackupSuccessAgeSeconds === null
    ? "No successful-backup age reported"
    : `Last success ${durationMetric(snapshot.metrics.lastBackupSuccessAgeSeconds)} ago`;
  return `
    <div class="page operations-page infrastructure-page" id="infrastructure-overview">
      <section class="operations-overall infrastructure-overall is-${state}" aria-labelledby="infrastructure-overall-title">
        <div class="operations-overall__status"><span class="operations-overall__icon is-${meta.tone}">${svgIcon("server")}</span><div><span class="operations-kicker">Infrastructure assessment</span><span class="operations-overall__label" data-infrastructure-overall-label>${escapeOperationsHtml(meta.label)}</span></div></div>
        <div class="operations-overall__copy"><h2 id="infrastructure-overall-title">${escapeOperationsHtml(copy.headline)}</h2><p>${escapeOperationsHtml(copy.summary)}</p></div>
        <dl class="operations-overall__facts">
          <div><dt>Environments</dt><dd data-infrastructure-metric="targets">${snapshot.overall.environmentCount}</dd></div>
          <div><dt>Guests running</dt><dd data-infrastructure-metric="guests-running">${infrastructureMetric(snapshot.metrics.guestsRunning)}</dd></div>
          <div><dt>Last assessment</dt><dd><span data-infrastructure-checked>${timestampMarkup(snapshot.generatedAt, "Waiting for data")}</span></dd></div>
        </dl>
        <button class="operations-refresh" type="button" data-action="refresh-live">${svgIcon("refresh")}<span>Refresh now</span></button>
      </section>

      <section class="operations-panel infrastructure-targets" aria-labelledby="infrastructure-targets-title">
        <header class="operations-section-heading">
          <div><span class="operations-kicker">Virtualization topology</span><h2 id="infrastructure-targets-title">Proxmox environments</h2><p>Each standalone server or cluster has independent nodes, workloads, and explicitly trusted API endpoints.</p></div>
          <button class="button button--primary" type="button" data-action="open-infrastructure-target">${svgIcon("plus")} Connect and discover</button>
        </header>
        ${snapshot.targets.length
          ? `<ul class="infrastructure-targets__list">${snapshot.targets.map(renderInfrastructureTarget).join("")}</ul>`
          : `<div class="operations-empty infrastructure-empty"><span>${svgIcon("server")}</span><strong>No Proxmox environments connected</strong><p>Connect one endpoint with a read-only API token. Helmsman verifies its certificate and discovers the environment before confirmation.</p><button class="button" type="button" data-action="open-infrastructure-target">Connect and discover</button></div>`}
      </section>

      <section class="operations-panel infrastructure-signals" aria-labelledby="infrastructure-signals-title">
        <header class="operations-section-heading"><div><span class="operations-kicker">Read-only telemetry</span><h2 id="infrastructure-signals-title">Infrastructure signals</h2><p>Current node, guest, storage, task, and backup evidence from Proxmox.</p></div></header>
        <dl class="infrastructure-signals__grid">
          <div class="is-neutral"><dt>Nodes online</dt><dd data-infrastructure-metric="nodes">${escapeOperationsHtml(nodes)}</dd><small>Across discovered environments</small></div>
          <div class="is-neutral"><dt>Guests running</dt><dd data-infrastructure-metric="guests-running-signal">${infrastructureMetric(snapshot.metrics.guestsRunning)}</dd><small data-infrastructure-detail="guests">${escapeOperationsHtml(guestDetail)}</small></div>
          <div class="is-neutral"><dt>Average node CPU</dt><dd data-infrastructure-metric="node-cpu">${storageMetric(snapshot.metrics.nodeCpuPercent)}</dd><small>Weighted across reporting nodes</small></div>
          <div class="is-neutral"><dt>Node memory</dt><dd data-infrastructure-metric="node-memory">${ratioMetric(snapshot.metrics.nodeMemoryUsedBytes, snapshot.metrics.nodeMemoryTotalBytes)}</dd><small data-infrastructure-detail="node-memory">${snapshot.metrics.nodeMemoryUsedBytes === null ? "Aggregate use" : `${bytesMetric(snapshot.metrics.nodeMemoryUsedBytes)} used`}</small></div>
          <div class="is-${storageTone}"><dt>Aggregate storage use</dt><dd data-infrastructure-metric="storage">${storageMetric(snapshot.metrics.storagePercent)}</dd><small data-infrastructure-detail="storage">${escapeOperationsHtml(storageDetail)}</small></div>
          <div class="${snapshot.metrics.failedTasks ? "is-danger" : "is-neutral"}"><dt>Failed tasks</dt><dd data-infrastructure-metric="failed-tasks">${infrastructureMetric(snapshot.metrics.failedTasks)}</dd><small>Current bounded window</small></div>
          <div class="${snapshot.metrics.backupIssues ? "is-warning" : "is-neutral"}"><dt>Backup issues</dt><dd data-infrastructure-metric="backup-issues">${infrastructureMetric(snapshot.metrics.backupIssues)}</dd><small data-infrastructure-detail="backups">${escapeOperationsHtml(backupDetail)}</small></div>
        </dl>
      </section>
    </div>`;
}
