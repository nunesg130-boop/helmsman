import {
  escapeOperationsHtml as escapeHtml,
  incidentNextStep,
  infrastructureSnapshotForTargets,
  normalizeInfrastructureSnapshot,
  normalizeOperationsReports,
  normalizeOperationsSnapshot,
  renderInfrastructureOverview,
  renderOperationsOverview,
  renderOperationsReports,
  serviceIconMarkup,
  workloadIconMarkup
} from "./ui/operations-views.js";

const main = document.querySelector("#main-content");
const appShell = document.querySelector("#app");
const drawerLayer = document.querySelector("#drawer-layer");
const modalLayer = document.querySelector("#modal-layer");
const controlConfirmLayer = document.querySelector("#control-confirm-layer");
const toastRegion = document.querySelector("#toast-region");
const filterAnnouncer = document.querySelector("#filter-announcer");
const pageTitle = document.querySelector("#page-title");
const pageEyebrow = document.querySelector("#page-eyebrow");
const modeBadge = document.querySelector("#mode-badge");
const incidentCount = document.querySelector("#incident-count");
const monitorSummary = document.querySelector("#monitor-summary");
const sessionButton = document.querySelector("#session-button");
let infrastructureFilterTimer = null;
let mediaFilterTimer = null;
let filterAnnouncementRevision = 0;

function emptyInfrastructureState() {
  return {
    loaded: false,
    loading: false,
    error: "",
    targets: [],
    filters: {
      environment: "all",
      node: "all",
      type: "all",
      status: "all",
      search: ""
    },
    portainerFilters: {
      server: "all",
      environment: "all",
      state: "all",
      search: ""
    }
  };
}

const renderPolicy = globalThis.trustedTypes?.createPolicy("jellofin-render", {
  createHTML: (markup) => markup
}) ?? null;

function setMarkup(element, markup) {
  element.innerHTML = renderPolicy ? renderPolicy.createHTML(markup) : markup;
}

const SERVICE_ORDER = ["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "qbittorrent", "bazarr"];
const MEDIA_CONNECTION_CATEGORIES = Object.freeze([
  Object.freeze({ id: "media-server", kicker: "Playback", title: "Media server", description: "Library discovery, playback state, and recently added media.", services: Object.freeze(["jellyfin"]) }),
  Object.freeze({ id: "requests", kicker: "Discovery", title: "Requests", description: "Audience discovery and request workflow visibility.", services: Object.freeze(["seerr"]) }),
  Object.freeze({ id: "media-management", kicker: "Automation", title: "Media management", description: "Movie and series monitoring, queues, imports, and health.", services: Object.freeze(["radarr", "sonarr"]) }),
  Object.freeze({ id: "indexers", kicker: "Search", title: "Indexers", description: "Indexer availability and blocked-source visibility.", services: Object.freeze(["prowlarr"]) }),
  Object.freeze({ id: "download-clients", kicker: "Acquisition", title: "Download clients", description: "Transfer state and active download workload.", services: Object.freeze(["qbittorrent"]) }),
  Object.freeze({ id: "subtitles", kicker: "Accessibility", title: "Subtitles", description: "Subtitle health and wanted-item backlog.", services: Object.freeze(["bazarr"]) })
]);
const SHARED_ROUTES = new Set(["logs", "settings"]);
const MEDIA_ROUTES = new Set(["home", "discover", "library", "requests", "activity", "calendar", "health", "connections", ...SHARED_ROUTES]);
const INFRASTRUCTURE_ROUTES = new Set(["overview", "connectors", "proxmox", "workloads", "portainer", "incidents", ...SHARED_ROUTES]);
const ROUTES = new Set([...MEDIA_ROUTES, ...INFRASTRUCTURE_ROUTES, "pipeline", "services", "environments", "nodes"]);
const MEDIA_ROUTE_ALIASES = Object.freeze({ overview: "home", pipeline: "health", incidents: "health", services: "connections" });
const INFRASTRUCTURE_ROUTE_ALIASES = Object.freeze({
  environments: "proxmox",
  nodes: "proxmox",
  pipeline: "overview",
  services: "connectors",
  connections: "connectors"
});
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const INFRASTRUCTURE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ACTION_INVENTORY_MAX_AGE_MS = 2 * 60 * 1_000;
const CONNECTION_CAPABILITY_LABELS = Object.freeze({
  jellyfin: Object.freeze({ status: "Server status", identity: "Token authorization" }),
  seerr: Object.freeze({ status: "Server status", identity: "API authorization", requestcounts: "Request workflow" }),
  radarr: Object.freeze({ status: "Server status", health: "Application health", queue: "Movie queue" }),
  sonarr: Object.freeze({ status: "Server status", health: "Application health", queue: "Series queue" }),
  prowlarr: Object.freeze({ status: "Server status", health: "Application health", indexers: "Blocked indexers" }),
  qbittorrent: Object.freeze({ version: "Server status", transfer: "Transfer connection", torrents: "Download workload" }),
  bazarr: Object.freeze({
    status: "Server status",
    health: "Application health",
    wantedmovies: "Movie subtitle backlog",
    wantedepisodes: "Episode subtitle backlog"
  }),
  proxmox: Object.freeze({
    reachability: "Network reachability",
    tls: "Certificate trust",
    version: "Proxmox version",
    environment: "Environment discovery",
    identity: "API authorization",
    authentication: "API authorization",
    authorization: "Read-only permissions",
    nodes: "Node inventory",
    "node-resources": "Node resources",
    guests: "Virtual guests",
    resources: "Guest inventory",
    storage: "Storage visibility",
    tasks: "Task history",
    backups: "Backup visibility"
  }),
  portainer: Object.freeze({
    status: "Server status",
    identity: "Token authorization",
    environments: "Environment inventory",
    stacks: "Stack inventory"
  })
});
const CONNECTION_PROOF_CAPABILITIES = Object.freeze({
  jellyfin: "identity",
  seerr: "identity",
  radarr: "status",
  sonarr: "status",
  prowlarr: "status",
  qbittorrent: "version",
  bazarr: "status",
  proxmox: "identity",
  portainer: "identity"
});
const CONNECTION_CODE_COPY = Object.freeze({
  AUTH_REQUIRED: "Credential rejected",
  FORBIDDEN: "Authenticated user lacks permission for this capability or environment",
  INVENTORY_LIMIT_REACHED: "Inventory reached a safe display limit",
  CREDENTIAL_NOT_CONFIGURED: "Credential not saved",
  TIMEOUT: "Timed out",
  UNREACHABLE: "Service unreachable",
  INVALID_RESPONSE: "Unexpected response format",
  RESPONSE_TOO_LARGE: "Response too large",
  HTTP_ERROR: "API request failed",
  UPSTREAM_TIMEOUT: "Upstream request timed out",
  UPSTREAM_UNREACHABLE: "Upstream endpoint unreachable",
  UPSTREAM_RESPONSE_FAILED: "Upstream response ended unexpectedly",
  UPSTREAM_RESPONSE_TOO_LARGE: "Upstream response too large",
  UPSTREAM_REDIRECT_REJECTED: "API request redirected; configure the final HTTPS URL",
  UPSTREAM_CONTENT_REJECTED: "Service returned HTML or unsupported API content",
  BROKER_BUSY: "Helmsman request capacity reached",
  TARGET_ADDRESS_CHANGED: "Saved hostname now resolves to an unapproved address",
  HEALTH_WARNING: "Upstream health warning",
  HEALTH_ERROR: "Upstream health error",
  INDEXERS_BLOCKED: "Indexers temporarily blocked",
  TLS_ERROR: "TLS handshake failed",
  TLS_CERTIFICATE_INVALID: "Certificate is invalid or expired",
  TLS_CERTIFICATE_UNTRUSTED: "Certificate is not trusted by the container",
  TLS_PIN_MISMATCH: "Certificate fingerprint does not match",
  NO_NODES_VISIBLE: "The token cannot see any Proxmox nodes",
  NODES_OFFLINE: "One or more Proxmox nodes are offline",
  RESOURCE_PRESSURE: "Node CPU, memory, or disk pressure detected",
  STORAGE_PRESSURE: "One or more storage pools are nearly full",
  STORAGE_UNAVAILABLE: "One or more storage pools are unavailable",
  RECENT_TASK_FAILURES: "Proxmox reports failed tasks in the last 24 hours",
  TASK_HISTORY_PARTIAL: "Task history partially available",
  TASK_HISTORY_UNAVAILABLE: "Task history unavailable",
  BACKUP_HISTORY_PARTIAL: "Backup history partially available",
  BACKUP_HISTORY_UNAVAILABLE: "No backup task history is available",
  LATEST_BACKUP_FAILED: "The latest observed backup task failed",
  CLUSTER_NOT_QUORATE: "The Proxmox cluster is not quorate",
  ENDPOINT_UNAVAILABLE: "API endpoint unavailable",
  ENVIRONMENT_IDENTITY_MISMATCH: "Endpoint reports a different environment",
  PORTAINER_ENVIRONMENT_DOWN: "A permitted Portainer environment is down",
  PORTAINER_ENVIRONMENT_ERROR: "A permitted Portainer environment reports an error",
  PORTAINER_ENVIRONMENT_PROVISIONING: "A permitted Portainer environment is still provisioning",
  PORTAINER_ENVIRONMENT_UNKNOWN: "A permitted Portainer environment has an unknown state",
  PORTAINER_INVENTORY_PARTIAL: "Portainer inventory coverage is partial",
  CONTAINERS_UNHEALTHY: "One or more containers are unhealthy, dead, or restarting",
  PROBE_FAILED: "The Proxmox check could not be completed",
  PROBE_TIMEOUT: "The Proxmox check timed out",
  CHECK_FAILED: "Check could not be completed",
  CHECK_CANCELLED: "Check cancelled",
  NOT_CHECKED: "Not checked"
});
const ROUTE_TITLES = Object.freeze({
  home: "Home",
  discover: "Discover",
  library: "Library",
  requests: "Requests",
  activity: "Activity",
  calendar: "Calendar",
  health: "Health",
  connections: "Connections",
  overview: "Overview",
  connectors: "Connectors",
  incidents: "Incidents",
  pipeline: "Pipeline",
  services: "Services",
  proxmox: "Proxmox",
  workloads: "Workloads",
  portainer: "Portainer",
  logs: "Logs",
  settings: "Settings"
});
const WORKSPACES = new Set(["media", "infrastructure"]);

function savedWorkspace() {
  try {
    const candidate = globalThis.localStorage?.getItem("helmsman.workspace");
    return WORKSPACES.has(candidate) ? candidate : "media";
  } catch {
    return "media";
  }
}

function savedSidebarCollapsed() {
  try {
    return globalThis.localStorage?.getItem("helmsman.sidebarCollapsed") === "true";
  } catch {
    return false;
  }
}

const state = {
  route: "home",
  workspace: savedWorkspace(),
  sidebarCollapsed: savedSidebarCollapsed(),
  status: null,
  config: null,
  snapshot: null,
  csrfToken: "",
  starting: true,
  refreshing: false,
  operationsRequestGeneration: 0,
  operationsRefreshPromise: null,
  actionMutation: "",
  actionAwaitingRefresh: "",
  fatalError: "",
  pollTimer: null,
  lastMarkup: "",
  accessKeyReveal: "",
  accessKeyMutation: false,
  sessions: {
    loaded: false,
    currentSessionId: "",
    items: [],
    error: ""
  },
  sessionMutation: "",
  infrastructure: emptyInfrastructureState(),
  media: {
    filters: {
      homeSearch: "",
      discover: "",
      library: "",
      libraryType: "all",
      requests: "all",
      activity: "all"
    },
    selectedId: "",
    drawerReturnFocus: null
  },
  modalReturnFocus: null,
  confirmationResolver: null,
  confirmationReturnFocus: null
};

// Compare the bounded view model rather than the raw monitor payload. Raw
// service metrics include fast-moving values such as qBittorrent transfer
// speed which are not rendered on these pages and must not repaint the UI.
// Visible volatile values are patched in place by updateVolatileOperationsUi.
function operationalFingerprint(snapshot) {
  if (!snapshot) return "";
  const normalized = normalizeOperationsSnapshot(snapshot, state.infrastructure.targets);
  const route = currentRoute();
  const includeOperationsStructure = state.workspace === "media"
    ? ["health", "connections"].includes(route) || route === "home" && !snapshot.media
    : ["incidents", "logs"].includes(route);
  const structure = JSON.stringify(includeOperationsStructure ? normalized : { version: normalized.version }, (key, value) => {
    if ([
      "generatedAt",
      "lastCheckedAt",
      "lastSeen",
      "latencyMs",
      "occurrenceCount",
      "consecutiveFailures",
      "count",
      "value"
    ].includes(key)) return undefined;
    return value;
  });
  // Preserve the few DOM-presence decisions that are based on volatile data.
  // Crossing one of these boundaries needs a small, intentional repaint so
  // the newly required element exists for subsequent in-place updates.
  const liveShape = includeOperationsStructure ? {
    generatedAt: Boolean(normalized.generatedAt),
    incidentOccurrenceEvidence: normalized.incidents.map((entry) => entry.occurrenceCount > 1),
    pipelineCounts: normalized.pipeline.map((entry) => entry.count !== null),
    serviceFacts: normalized.services.map((entry) => (
      entry.latencyMs !== null || Boolean(entry.version) || Boolean(entry.lastCheckedAt)
    ))
  } : {};
  const infrastructure = state.workspace === "infrastructure"
    && ["overview", "connectors", "proxmox", "workloads", "portainer"].includes(route)
    ? normalizeInfrastructureSnapshot(snapshot, state.infrastructure.targets)
    : null;
  const configuredInfrastructureIds = new Set(state.infrastructure.targets.map(({ id }) => id));
  const infrastructureTargets = infrastructure
    ? infrastructure.targets.filter(({ id }) => !["overview", "connectors"].includes(route) || configuredInfrastructureIds.has(id))
    : [];
  const infrastructureStructure = infrastructure
    ? route === "connectors"
      ? { targets: infrastructureTargets.map((target) => ({
          id: target.id,
          displayName: target.displayName,
          url: target.url,
          state: target.state,
          connectionState: target.connectionState,
          enabled: target.enabled,
          monitoringEnabled: target.monitoringEnabled,
          credentialConfigured: target.credentialConfigured,
          environmentKind: target.environmentKind,
          environmentName: target.environmentName,
          clusterName: target.clusterName
        })) }
      : {
        generatedAt: Boolean(infrastructure.generatedAt),
        overall: infrastructure.overall,
        targets: infrastructureTargets.map((target) => ({
          id: target.id,
          type: target.type,
          displayName: target.displayName,
          url: target.url,
          state: target.state,
          connectionState: target.connectionState,
          message: target.message,
          enabled: target.enabled,
          monitoringEnabled: target.monitoringEnabled,
          tlsMode: target.tlsMode,
          credentialConfigured: target.credentialConfigured,
          environmentKind: target.environmentKind,
          environmentName: target.environmentName,
          clusterName: target.clusterName,
          quorate: target.quorate,
          selectedEndpointId: target.selectedEndpointId,
          endpoints: target.endpoints,
          nodes: target.nodes,
          workloads: target.workloads,
          storage: target.storage,
          activity: target.activity,
          capabilities: target.capabilities.map((check) => ({
            id: check.id,
            name: check.name,
            state: check.state,
            code: check.code,
            status: check.status
          }))
        }))
      }
    : null;
  const includePortainerStructure = state.workspace === "infrastructure"
    && ["overview", "connectors", "portainer"].includes(route);
  const configuredPortainerIds = new Set(normalizedPortainerConfigurations().map(({ id }) => id));
  const fingerprintPortainers = includePortainerStructure
    ? portainerServicesForSnapshot(snapshot)
      .filter(({ id }) => route === "portainer" || configuredPortainerIds.has(id))
    : [];
  const portainerStructure = includePortainerStructure
    ? fingerprintPortainers.map((service) => route === "connectors" ? {
        id: service.id,
        displayName: service.displayName,
        url: service.url,
        enabled: service.enabled,
        monitoringEnabled: service.monitoringEnabled,
        credentialConfigured: service.credentialConfigured,
        state: service.state,
        connectionState: service.connectionState,
        typeName: service.typeName,
        role: service.role
      } : {
        id: service.id,
        displayName: service.displayName,
        url: service.url,
        enabled: service.enabled,
        monitoringEnabled: service.monitoringEnabled,
        credentialConfigured: service.credentialConfigured,
        tlsMode: service.tlsMode,
        state: service.state,
        connectionState: service.connectionState,
        version: service.version,
        capabilities: service.capabilities.map((check) => ({
          id: check.id,
          label: check.label,
          state: check.state,
          code: check.code,
          status: check.status,
          reports: check.reports
        })),
        inventory: service.inventory
      })
    : null;
  const logs = route === "logs"
    ? safeLogEntriesForSnapshot(snapshot).map((entry) => ({
        type: entry?.type,
        level: entry?.level,
        summary: entry?.summary,
        code: entry?.code,
        status: entry?.status,
        httpStatus: entry?.httpStatus,
        service: entry?.service,
        capability: entry?.capability,
        at: entry?.at,
        createdAt: entry?.createdAt
      }))
    : [];
  const mediaStructure = state.workspace === "media" && !["health", "connections", "logs", "settings"].includes(route)
    ? mediaStructuralFingerprint(snapshot?.media)
    : "";
  return `${structure}\n${JSON.stringify(liveShape)}\n${JSON.stringify(infrastructureStructure)}\n${JSON.stringify(portainerStructure)}\n${JSON.stringify(logs)}\n${mediaStructure}`;
}

function rawRoute() {
  return String(location.hash || (state.workspace === "infrastructure" ? "#/overview" : "#/home"))
    .replace(/^#\//u, "")
    .split("?", 1)[0];
}

function currentRoute() {
  const candidate = rawRoute();
  if (state.workspace === "media") {
    const aliased = MEDIA_ROUTE_ALIASES[candidate] || candidate;
    return MEDIA_ROUTES.has(aliased) ? aliased : "home";
  }
  const aliased = INFRASTRUCTURE_ROUTE_ALIASES[candidate] || candidate;
  return INFRASTRUCTURE_ROUTES.has(aliased) ? aliased : "overview";
}

function workspaceLandingRoute(workspace) {
  return workspace === "infrastructure" ? "overview" : "home";
}

function applySidebarState({ persist = false } = {}) {
  appShell?.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
  const toggle = document.querySelector("[data-action='toggle-sidebar']");
  if (toggle) {
    const label = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    toggle.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }
  if (persist) {
    try {
      globalThis.localStorage?.setItem("helmsman.sidebarCollapsed", String(state.sidebarCollapsed));
    } catch {
      // A private browser can deny storage; collapse still works for this page load.
    }
  }
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  applySidebarState({ persist: true });
}

async function switchWorkspace(value) {
  const workspace = String(value || "").toLowerCase();
  if (!WORKSPACES.has(workspace) || workspace === state.workspace) return;
  closeModal();
  closeMediaDrawer();
  state.workspace = workspace;
  try {
    globalThis.localStorage?.setItem("helmsman.workspace", workspace);
  } catch {
    // A private browser can deny storage; the in-memory workspace still works.
  }
  const candidate = rawRoute();
  const destination = SHARED_ROUTES.has(candidate) ? candidate : workspaceLandingRoute(workspace);
  location.hash = `#/${destination}`;
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  if (workspace === "infrastructure" && state.status?.authenticated) {
    await loadInfrastructureTargets({ render: true });
  }
}

function showToast(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${tone}`;
  toast.textContent = String(message || "Done.").slice(0, 240);
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4_000);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method) && state.csrfToken && options.csrf !== false) {
    headers.set("X-Jellofin-CSRF", state.csrfToken);
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: options.signal
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK_ERROR", error?.name === "AbortError"
      ? "The request was cancelled."
      : "The local container could not be reached.");
  }
  let payload = null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE", "The container returned malformed data.");
    }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.code || "HTTP_ERROR",
      payload?.message || `The container returned HTTP ${response.status}.`
    );
  }
  return payload;
}

function statusClass(value) {
  const candidate = String(value || "stale").replaceAll("_", "-");
  if (["healthy", "limited", "degraded", "down", "auth-required", "authentication-required", "stale", "checking", "disabled"].includes(candidate)) {
    return candidate;
  }
  return "stale";
}

function statusLabel(value) {
  return {
    healthy: "Healthy",
    limited: "Limited",
    degraded: "Degraded",
    down: "Down",
    auth_required: "Authentication required",
    "auth-required": "Authentication required",
    "authentication-required": "Authentication required",
    stale: "Waiting for data",
    checking: "Checking",
    disabled: "Disabled"
  }[String(value || "stale")] || "Unknown";
}

function formatTime(value, fallback = "Not yet") {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return fallback;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function safeCapabilityId(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(candidate) ? candidate : "";
}

function capabilityLabel(service, capability) {
  const id = safeCapabilityId(capability);
  return CONNECTION_CAPABILITY_LABELS[String(service || "").toLowerCase()]?.[id]
    || "Capability check";
}

function safeCheckStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function safeCheckLatency(value) {
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0
    ? Math.min(120_000, Math.round(latency))
    : null;
}

function safeMetric(check, name) {
  const value = Number(check?.metrics?.[name]);
  return Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000_000, Math.round(value))
    : null;
}

function countLabel(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function reportServiceName(serviceId) {
  const service = state.config?.services?.find((entry) => entry.id === serviceId);
  if (service?.name) return String(service.name).slice(0, 60);
  if (serviceId === "portainer" || String(serviceId || "").startsWith("portainer-")) return "Portainer";
  const candidate = String(serviceId || "Service").replace(/(^|[-_.])([a-z])/gu, (_match, prefix, letter) => (
    `${prefix === "-" ? " " : prefix}${letter.toUpperCase()}`
  ));
  return candidate.slice(0, 60) || "Service";
}

function normalizedTestChecks(result) {
  const service = String(result?.service || "").toLowerCase();
  const serviceName = reportServiceName(service);
  const rawChecks = Array.isArray(result?.checks)
    ? result.checks
    : Array.isArray(result?.capabilities) ? result.capabilities : [];
  return rawChecks.slice(0, 12).map((check) => {
    const id = safeCapabilityId(check?.id);
    const knownLabel = CONNECTION_CAPABILITY_LABELS[service]?.[id];
    const stateValue = statusClass(check?.state);
    const rawCode = typeof check?.code === "string" ? check.code.trim().toUpperCase() : "";
    const code = Object.hasOwn(CONNECTION_CODE_COPY, rawCode) ? rawCode : "";
    const connectionStatus = ["connected", "firewalled", "disconnected", "unknown"].includes(check?.metrics?.connectionStatus)
      ? check.metrics.connectionStatus
      : "";
    return {
      id,
      label: knownLabel || safeSessionText(check?.label ?? check?.name, capabilityLabel(service, id), 80),
      state: stateValue,
      code,
      status: safeCheckStatus(check?.status ?? check?.httpStatus),
      latencyMs: safeCheckLatency(check?.latencyMs),
      detail: safeSessionText(check?.detail ?? check?.message ?? check?.summary, "", 240),
      connectionStatus,
      reports: normalizeOperationsReports(check?.reports, `${serviceName} health`),
      metrics: {
        healthNotices: safeMetric(check, "healthNotices"),
        healthWarnings: safeMetric(check, "healthWarnings"),
        healthErrors: safeMetric(check, "healthErrors"),
        queueFailed: safeMetric(check, "queueFailed"),
        queueStalled: safeMetric(check, "queueStalled"),
        importsBlocked: safeMetric(check, "importsBlocked"),
        indexersBlocked: safeMetric(check, "indexersBlocked"),
        errored: safeMetric(check, "errored"),
        stalled: safeMetric(check, "stalled")
      }
    };
  });
}

function capabilityEvidence(check) {
  const evidence = [];
  const metric = check.metrics;
  if (check.detail) evidence.push(check.detail);
  if (metric.healthNotices) evidence.push(countLabel(metric.healthNotices, "health notice"));
  if (metric.healthErrors) evidence.push(countLabel(metric.healthErrors, "health error"));
  if (metric.healthWarnings) evidence.push(countLabel(metric.healthWarnings, "health warning"));
  if (metric.queueFailed) evidence.push(countLabel(metric.queueFailed, "failed item"));
  if (metric.queueStalled) evidence.push(countLabel(metric.queueStalled, "stalled item"));
  if (metric.importsBlocked) evidence.push(countLabel(metric.importsBlocked, "blocked import"));
  if (metric.indexersBlocked) evidence.push(countLabel(metric.indexersBlocked, "blocked indexer"));
  if (metric.errored) evidence.push(countLabel(metric.errored, "errored download"));
  if (metric.stalled) evidence.push(countLabel(metric.stalled, "stalled download"));
  if (check.connectionStatus && check.connectionStatus !== "connected") {
    evidence.push(`Transfer ${check.connectionStatus}`);
  }
  if (check.code
    && !(check.code === "HEALTH_WARNING" && metric.healthWarnings)
    && !(check.code === "HEALTH_ERROR" && metric.healthErrors)
    && !(check.code === "INDEXERS_BLOCKED" && metric.indexersBlocked)) {
    evidence.push(CONNECTION_CODE_COPY[check.code]);
    evidence.push(check.code);
  }
  if (check.status !== null && (check.status < 200 || check.status >= 300)) evidence.push(`HTTP ${check.status}`);
  if (check.latencyMs !== null) evidence.push(`${check.latencyMs} ms`);
  if (!evidence.length) evidence.push(check.state === "healthy" ? "Passed" : statusLabel(check.state));
  return evidence.join(" · ");
}

function renderConnectionCapabilities(result) {
  const checks = normalizedTestChecks(result);
  if (!checks.length) return "";
  const serviceName = reportServiceName(String(result?.service || "").toLowerCase());
  return `<ul class="connection-capabilities" aria-label="Capability results">${checks.map((check) => `
    <li class="connection-capability is-${statusClass(check.state)}">
      <span class="health-dot is-${statusClass(check.state)}" aria-hidden="true"></span>
      <div class="connection-capability__copy"><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(capabilityEvidence(check))}</small>${renderOperationsReports(check.reports, serviceName)}</div>
      <span class="connection-capability__state">${escapeHtml(statusLabel(check.state))}</span>
    </li>`).join("")}</ul>`;
}

function normalizedConnectionState(result, checks, operationalState) {
  const supplied = String(result?.connectionState || "").trim().toLowerCase().replaceAll("-", "_");
  if (["connected", "auth_required", "unverified", "down"].includes(supplied)) return supplied;
  if (operationalState === "auth-required" || checks.some((check) => check.state === "auth-required")) return "auth_required";
  if (operationalState === "down") return "down";
  const service = String(result?.service || "").toLowerCase();
  const proof = CONNECTION_PROOF_CAPABILITIES[service];
  if (proof && checks.some((check) => check.id === proof && check.state === "healthy")) return "connected";
  return "unverified";
}

function savedConnectionState(health) {
  const checks = Array.isArray(health?.checks)
    ? health.checks
    : Array.isArray(health?.capabilities) ? health.capabilities : [];
  if (checks.some((check) => String(check?.code || "").toUpperCase() === "CREDENTIAL_NOT_CONFIGURED")) {
    return "unverified";
  }
  const operationalState = statusClass(health?.state);
  const supplied = String(health?.connectionState || "").trim().toLowerCase().replaceAll("-", "_");
  if (["connected", "auth_required", "unverified", "down"].includes(supplied)) return supplied;
  if (operationalState === "auth-required" || checks.some((check) => statusClass(check?.state) === "auth-required")) {
    return "auth_required";
  }
  if (operationalState === "down") return "down";
  const service = String(health?.id || health?.service || "").toLowerCase();
  const proof = CONNECTION_PROOF_CAPABILITIES[service];
  return proof && checks.some((check) => safeCapabilityId(check?.id) === proof && statusClass(check?.state) === "healthy")
    ? "connected"
    : "unverified";
}

function savedMonitorLabel(health) {
  const checks = Array.isArray(health?.checks)
    ? health.checks
    : Array.isArray(health?.capabilities) ? health.capabilities : [];
  if (checks.some((check) => String(check?.code || "").toUpperCase() === "CREDENTIAL_NOT_CONFIGURED")) {
    return "Credential not saved";
  }
  const operationalState = statusClass(health?.state);
  const connectionState = savedConnectionState(health);
  if (connectionState === "connected") {
    return operationalState === "healthy" ? "Connected · Healthy" : `Connected · ${statusLabel(operationalState)} health`;
  }
  if (connectionState === "auth_required") return "Authentication required";
  if (connectionState === "down") return "Connection unavailable";
  return "Credential not verified";
}

function savedMonitorTone(health) {
  const connectionState = savedConnectionState(health);
  if (connectionState === "auth_required") return "auth-required";
  if (connectionState === "down") return "down";
  if (connectionState === "unverified") return "stale";
  return statusClass(health?.state);
}

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function renderGateHeader(kicker, title, copy, titleId) {
  return `
    <header class="setup-v5__header">
      <span class="setup-v5__mark">${icon("shield")}</span>
      <div>
        <span class="section-kicker">${escapeHtml(kicker)}</span>
        <h2${titleId ? ` id="${escapeHtml(titleId)}"` : ""}>${escapeHtml(title)}</h2>
        <p>${escapeHtml(copy)}</p>
      </div>
    </header>`;
}

function renderNetworkPolicyFields(policy = {}, idPrefix = "network") {
  const allowedCidrs = Array.isArray(policy.allowedCidrs) ? policy.allowedCidrs : [];
  const manual = allowedCidrs.length > 0;
  const exactId = `${idPrefix}-network-mode-exact`;
  const manualId = `${idPrefix}-network-mode-manual`;
  const cidrsId = `${idPrefix}-allowed-cidrs`;
  const cidrsRegionId = `${idPrefix}-allowed-cidrs-region`;
  const cidrsHelpId = `${idPrefix}-allowed-cidrs-help`;
  const modeHelpId = `${idPrefix}-network-mode-help`;
  return `
    <fieldset class="network-policy-fieldset" aria-describedby="${modeHelpId}">
      <legend>Private service access</legend>
      <p class="network-policy-help" id="${modeHelpId}">Choose how private service addresses are approved. Public HTTPS access is a separate opt-in below.</p>
      <div class="network-mode-grid">
        <label class="option-card-v5" for="${exactId}">
          <input id="${exactId}" name="networkMode" type="radio" value="exact" ${manual ? "" : "checked"}/>
          <span><strong>Exact service addresses</strong><small>Safest default. Each service is pinned to only the private IP addresses it resolves to (/32 or /128); no broad LAN allowlist is created.</small></span>
        </label>
        <label class="option-card-v5" for="${manualId}">
          <input id="${manualId}" name="networkMode" type="radio" value="manual" aria-controls="${cidrsRegionId}" aria-expanded="${manual ? "true" : "false"}" ${manual ? "checked" : ""}/>
          <span><strong>Manual CIDR allowlist</strong><small>Use explicitly managed network ranges when a service may move between addresses inside a subnet.</small></span>
        </label>
      </div>
      <div class="network-cidr-fields" id="${cidrsRegionId}" data-network-cidr-fields ${manual ? "" : "hidden"}>
        <label for="${cidrsId}"><span>Allowed private CIDRs · one per line</span><textarea id="${cidrsId}" name="allowedCidrs" rows="5" aria-describedby="${cidrsHelpId}" ${manual ? "required" : "disabled"} placeholder="192.168.0.7/32&#10;192.168.0.104/32">${escapeHtml(allowedCidrs.join("\n"))}</textarea><small id="${cidrsHelpId}">CIDR mode permits every safe private address inside these ranges. Prefer exact service addresses unless that broader access is intentional.</small></label>
      </div>
    </fieldset>
    <label class="check-row"><input type="checkbox" name="allowPublicHttps" ${policy.allowPublicHttps ? "checked" : ""}/><span><strong>Allow registered public HTTPS targets</strong><small>Independent of the private-address mode. Only exact HTTPS URLs you save may be reached; public HTTP, redirects, and protected system ranges remain blocked.</small></span></label>`;
}

function renderSetup() {
  return `
    <section class="setup-v5" aria-labelledby="setup-title">
      ${renderGateHeader("First-time setup", "Claim this container", "Define what the broker may reach, then create the reusable access key that unlocks Helmsman on your browsers.", "setup-title")}
      <div class="setup-v5__steps" aria-hidden="true">
        <span class="is-active"><b>01</b> Claim</span><span><b>02</b> Network</span><span><b>03</b> Connect</span>
      </div>
      <form class="glass-form" id="setup-form" autocomplete="off" data-form-type="other" data-network-mode="exact">
        <div class="form-section">
          <div class="form-section__number">01</div>
          <div class="form-section__body">
            <h3>Container claim</h3>
            <p>Run <code>docker compose logs helmsman</code> and paste the newest one-time setup token.</p>
            <div class="form-grid form-grid--two">
              <label><span>One-time setup token</span><input name="setupToken" type="password" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" required placeholder="Paste token from container logs" /></label>
              <label><span>This browser name</span><input name="deviceName" value="${escapeHtml(navigator.platform || "Browser")}" maxlength="80" required /></label>
            </div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section__number">02</div>
          <div class="form-section__body">
            <h3>Allowed service networks</h3>
            <p>Docker host addresses must be reachable from inside the container. You can start with exact per-service pins and avoid opening a whole LAN range.</p>
            ${renderNetworkPolicyFields({ allowedCidrs: [], allowPublicHttps: false }, "setup")}
          </div>
        </div>
        <div class="security-note security-note--good">${icon("lock")}<div><strong>Credentials stay out of the browser</strong><span>Service credentials are encrypted in the container data volume. After setup, save the generated Helmsman access key in your password manager.</span></div></div>
        <p class="form-error" id="setup-error" role="alert"></p>
        <div class="form-actions"><button class="button button--primary" type="submit">Claim and continue</button></div>
      </form>
    </section>`;
}

function renderAccessLogin() {
  return `
    <section class="setup-v5" aria-labelledby="access-title">
      ${renderGateHeader("Browser access", "Unlock Helmsman", "Enter the reusable access key for this container. This browser receives its own revocable, one-year session on this secure origin.", "access-title")}
      <form class="glass-form glass-form--compact" id="access-login-form" autocomplete="off" data-form-type="other">
        <div class="form-section">
          <div class="form-section__number">01</div>
          <div class="form-section__body">
            <h3>Sign in to this browser</h3>
            <div class="form-grid form-grid--two">
              <label><span>Helmsman access key</span><input name="accessKey" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" required /></label>
              <label><span>This browser name</span><input name="deviceName" value="${escapeHtml(navigator.platform || "Browser")}" maxlength="80" required /></label>
            </div>
          </div>
        </div>
        <div class="security-note security-note--good">${icon("lock")}<div><strong>The access key is never saved by Helmsman in this browser</strong><span>It is sent once over this HTTPS or localhost origin and exchanged for an HttpOnly session cookie.</span></div></div>
        <p class="form-error" id="access-login-error" role="alert"></p>
        <div class="form-actions"><button class="button button--primary" type="submit">Unlock Helmsman</button></div>
      </form>
      <div class="recovery-command"><strong>Lost the access key?</strong><code>docker compose stop helmsman<br>docker compose run --rm --no-deps helmsman rotate-access-key --confirm<br>docker compose up -d</code><span>An existing signed-in browser can rotate it from Settings. If none remain, run this recovery command and save the newly printed key.</span></div>
    </section>`;
}

function renderAccessRecovery() {
  return `
    <section class="setup-v5" aria-labelledby="access-recovery-title">
      ${renderGateHeader("Browser access", "Create an access key", "This claimed container does not have a universal access key yet. Create one from an existing signed-in browser or from the Docker console.", "access-recovery-title")}
      <div class="recovery-command"><strong>If another browser is signed in</strong><span>Open Settings → Security and access, then select Create access key. The new key is shown only once.</span></div>
      <div class="recovery-command"><strong>If no browser is signed in</strong><code>docker compose stop helmsman<br>docker compose run --rm --no-deps helmsman rotate-access-key --confirm<br>docker compose up -d</code><span>The command prints the new reusable key without changing service connections or encrypted credentials.</span></div>
    </section>`;
}

function renderStarting() {
  return `<section class="state-page"><span class="state-page__spinner">${icon("refresh")}</span><h2>Starting Helmsman</h2><p>Opening the local control plane…</p></section>`;
}

function renderFatal() {
  return `<section class="state-page state-page--error">${icon("x")}<h2>Container unavailable</h2><p>${escapeHtml(state.fatalError)}</p><button class="button" type="button" data-action="retry-startup">Try again</button></section>`;
}

function snapshotForUi() {
  return state.snapshot || {
    generatedAt: null,
    overall: { state: "stale", headline: "Waiting for the first health check", summary: "The container monitor is starting." },
    services: [],
    incidents: { open: [], recent: [] },
    pipeline: [],
    workload: {}
  };
}

const MEDIA_LIFECYCLE_STEPS = Object.freeze([
  { id: "requested", label: "Requested" },
  { id: "monitored", label: "Monitored" },
  { id: "downloading", label: "Downloading" },
  { id: "imported", label: "Imported" },
  { id: "available", label: "Available" }
]);

function mediaNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : null;
}

function mediaText(value, fallback = "", maximum = 180) {
  return safeSessionText(value, fallback, maximum);
}

function normalizedMediaToken(value) {
  return mediaText(value, "", 64).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function isSyntheticMediaTitle(value) {
  const title = mediaText(value, "", 180);
  return !title
    || /^(?:untitled|unknown(?:\s+media)?|(?:movie|series|show)\s+\d{1,16})$/iu.test(title);
}

function preferredMediaTitle(primary, fallback) {
  const candidate = mediaText(primary, "", 180);
  const alternative = mediaText(fallback, "", 180);
  if (isSyntheticMediaTitle(candidate) && !isSyntheticMediaTitle(alternative)) return alternative;
  return candidate || alternative || "Untitled";
}

function normalizedRequestedSeasons(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? value.seasons || value.requestedSeasons || []
      : [];
  return [...new Set((Array.isArray(source) ? source : []).slice(0, 100).flatMap((entry) => {
    const season = mediaNumber(entry && typeof entry === "object" ? entry.seasonNumber ?? entry.season : entry, 0, 10_000);
    return season === null || !Number.isInteger(season) ? [] : [season];
  }))].sort((left, right) => left - right);
}

function mediaDomKey(value) {
  const input = String(value || "media");
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `m-${(hash >>> 0).toString(36)}`;
}

function safeMediaFocusKey(value) {
  const candidate = String(value || "");
  return /^m-[a-z0-9]{1,16}$/u.test(candidate) ? candidate : "";
}

function safeMediaFocusAction(value) {
  return value === "open-media-detail" ? value : "";
}

function safeControlFocusKey(value) {
  const candidate = String(value || "");
  return /^[A-Za-z0-9:._-]{1,320}$/u.test(candidate) ? candidate : "";
}

function focusReference(element) {
  if (!element) return null;
  return {
    element,
    id: typeof element.id === "string" ? element.id : "",
    mediaKey: safeMediaFocusKey(element.dataset?.mediaKey),
    mediaAction: safeMediaFocusAction(element.dataset?.action),
    controlKey: safeControlFocusKey(element.dataset?.controlKey),
    portainerContainerKey: safeControlFocusKey(element.dataset?.portainerContainerKey),
    infrastructureWorkloadId: safeControlFocusKey(element.dataset?.infrastructureWorkloadId)
  };
}

function elementByDataset(root, attribute, value) {
  if (!root || !value) return null;
  return [...(root.querySelectorAll?.(`[data-${attribute}]`) || [])]
    .find((element) => String(element.dataset?.[attribute.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] || "") === value)
    || null;
}

function resolveFocusReference(reference, root = document) {
  if (!reference) return null;
  if (reference.element?.isConnected && typeof reference.element.focus === "function") return reference.element;
  if (reference.id) {
    const byId = document.getElementById(reference.id);
    if (byId) return byId;
  }
  if (reference.controlKey) {
    const control = elementByDataset(root, "control-key", reference.controlKey);
    if (control) return control;
  }
  if (reference.mediaKey && reference.mediaAction) {
    const mediaControl = [...(root?.querySelectorAll?.("[data-media-key]") || [])].find((element) => (
      element.dataset?.mediaKey === reference.mediaKey && element.dataset?.action === reference.mediaAction
    ));
    if (mediaControl) return mediaControl;
  }
  if (reference.portainerContainerKey) {
    const container = elementByDataset(root, "portainer-container-key", reference.portainerContainerKey);
    if (container) return container;
  }
  if (reference.infrastructureWorkloadId) {
    const workload = elementByDataset(root, "infrastructure-workload-id", reference.infrastructureWorkloadId);
    if (workload) return workload;
  }
  return null;
}

function restoreFocusReference(reference, root = document) {
  const target = resolveFocusReference(reference, root) || main;
  if (typeof target?.focus === "function") target.focus({ preventScroll: true });
}

function actionEvidenceIsCurrent(evidence, targetRevision, checkedAt = evidence?.checkedAt ?? evidence?.lastCheckedAt) {
  const observedAt = Date.parse(checkedAt);
  const age = Date.now() - observedAt;
  return Boolean(evidence
    && targetRevision
    && evidence.targetRevision === targetRevision
    && evidence.connectionState === "connected"
    && Number.isFinite(observedAt)
    && age >= -30_000
    && age <= ACTION_INVENTORY_MAX_AGE_MS);
}

function mediaArtworkUrl(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^\/api\/v2\/media\/artwork\/[A-Za-z0-9._~-]{1,180}$/u.test(candidate) ? candidate : "";
}

function normalizedMediaSources(value) {
  return (Array.isArray(value) ? value : []).slice(0, 16).flatMap((entry) => {
    if (typeof entry === "string") {
      const service = safeCapabilityId(entry);
      return service ? [{ service, label: reportServiceName(service), state: "", detail: "" }] : [];
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const service = safeCapabilityId(entry.service || entry.id || entry.source);
    if (!service) return [];
    return [{
      service,
      label: mediaText(entry.label || entry.name, reportServiceName(service), 80),
      state: mediaText(entry.state || entry.status, "", 40).toLowerCase(),
      detail: mediaText(entry.detail || entry.resource || entry.kind, "", 180)
    }];
  });
}

function normalizedMediaActionTargets(value) {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).map(([service, resourceId]) => ({ service, resourceId }))
      : [];
  const seen = new Set();
  return candidates.slice(0, 6).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const service = safeCapabilityId(entry.service);
    const resourceId = mediaText(entry.resourceId ?? entry.sourceId ?? entry.id, "", 24);
    const key = `${service}:${resourceId}`;
    if (!["radarr", "sonarr"].includes(service) || !/^[1-9][0-9]{0,9}$/u.test(resourceId) || seen.has(key)) return [];
    seen.add(key);
    return [{ service, resourceId }];
  });
}

function normalizeMediaItem(value, fallbackSeed = "media") {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const requestCollection = /(?:^|-)requests?:/u.test(fallbackSeed);
  const providerIds = raw.providerIds && typeof raw.providerIds === "object" && !Array.isArray(raw.providerIds)
    ? Object.fromEntries(Object.entries(raw.providerIds).slice(0, 12).flatMap(([name, id]) => {
        const safeName = safeCapabilityId(name);
        const safeId = mediaText(id, "", 120);
        return safeName && safeId ? [[safeName, safeId]] : [];
      }))
    : {};
  const requestId = requestCollection ? mediaText(raw.requestId, "", 120) : "";
  const requestedSeasons = normalizedRequestedSeasons(raw.requestedSeasons || raw.seasons || raw.requestScope);
  const requestIdentity = requestId
    ? `request:${requestId}`
    : "";
  const identity = requestIdentity
    || mediaText(raw.id, "", 180)
    || Object.entries(providerIds).map(([name, id]) => `${name}:${id}`).join("|")
    || `${mediaText(raw.mediaType || raw.type, "media", 30)}:${mediaText(raw.title || raw.name, "Untitled", 180)}:${mediaText(raw.year, "", 8)}:${fallbackSeed}`;
  const mediaType = mediaText(raw.mediaType || raw.type || raw.kind, "media", 30).toLowerCase();
  const progressValue = mediaNumber(raw.progress ?? raw.progressPercent, 0, 100);
  const progress = progressValue !== null && progressValue <= 1 && Number(raw.progress) > 0
    ? Math.round(progressValue * 10_000) / 100
    : progressValue === null ? null : Math.round(progressValue * 10) / 10;
  const lifecycle = raw.lifecycle && typeof raw.lifecycle === "object" && !Array.isArray(raw.lifecycle) ? raw.lifecycle : {};
  const stage = mediaText(lifecycle.stage || raw.stage || raw.state || raw.status, "", 40).toLowerCase();
  const requestBucket = normalizedMediaToken(raw.requestBucket);
  return {
    id: identity,
    key: mediaDomKey(identity),
    title: preferredMediaTitle(raw.displayTitle || raw.title || raw.name, raw.originalTitle || raw.originalName),
    mediaType,
    year: mediaText(raw.year, "", 8),
    summary: mediaText(raw.summary || raw.overview || raw.description, "", 700),
    subtitle: mediaText(raw.subtitle || raw.episodeTitle || raw.detail, "", 180),
    requestedBy: mediaText(raw.requestedBy || raw.requester || raw.owner, "", 100),
    service: safeCapabilityId(raw.service),
    state: normalizedMediaToken(raw.state || raw.status || stage),
    requestId,
    requestStatus: normalizedMediaToken(raw.requestStatus || (requestCollection ? raw.status : "")),
    requestBucket: ["pending", "in_progress", "available", "attention", "closed"].includes(requestBucket)
      ? requestBucket
      : "",
    mediaStatus: normalizedMediaToken(raw.mediaStatus || raw.availabilityStatus),
    is4k: raw.is4k === true,
    requestedSeasons,
    seasonStatuses: (Array.isArray(raw.seasonStatuses) ? raw.seasonStatuses : []).slice(0, 100).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const seasonNumber = mediaNumber(entry.seasonNumber ?? entry.season, 0, 10_000);
      const status = normalizedMediaToken(entry.status);
      return seasonNumber === null || !Number.isInteger(seasonNumber) || !status ? [] : [{ seasonNumber, status }];
    }),
    requestFulfilled: raw.requestFulfilled === true,
    requestCompleted: raw.requestCompleted === true,
    requestScope: ["movie", "series", "seasons"].includes(normalizedMediaToken(raw.requestScope))
      ? normalizedMediaToken(raw.requestScope)
      : "",
    partiallyAvailable: raw.partiallyAvailable === true,
    error: mediaText(raw.error || raw.issue || raw.message, "", 320),
    providerIds,
    sources: normalizedMediaSources(raw.sources),
    actionTargets: normalizedMediaActionTargets(raw.actionTargets),
    lifecycle: { stage },
    requested: raw.requested === true || requestCollection,
    monitored: Boolean(raw.monitored),
    downloading: Boolean(raw.downloading),
    imported: Boolean(raw.imported),
    // Beta 5 published requestFulfilled separately while leaving available
    // false. Normalize that request-scoped evidence once so filters, journey
    // steps, status tone, and labels all agree without inheriting title-wide
    // Jellyfin availability into a different season request.
    available: raw.available === true || requestCollection && raw.requestFulfilled === true,
    progress,
    downloadSpeedBps: mediaNumber(raw.downloadSpeedBps ?? raw.speedBps, 0, 1_000_000_000_000),
    etaSeconds: mediaNumber(raw.etaSeconds, 0, 31_536_000),
    addedAt: mediaText(raw.addedAt, "", 40),
    releaseAt: mediaText(raw.releaseAt || raw.airDate || raw.date, "", 40),
    requestedAt: mediaText(raw.requestedAt || raw.createdAt, "", 40),
    seasonNumber: mediaNumber(raw.seasonNumber, 0, 10_000),
    episodeNumber: mediaNumber(raw.episodeNumber, 0, 100_000),
    artworkUrl: mediaArtworkUrl(raw.artworkUrl),
    downloadId: mediaText(raw.downloadId, "", 180)
  };
}

function normalizedMediaCollection(value, registry, collectionName, maximum = 500) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).slice(0, maximum).flatMap((entry, index) => {
    let candidate = entry;
    if (typeof entry === "string") candidate = registry.get(entry);
    else if (entry && typeof entry === "object" && (entry.mediaId || entry.id) && registry.has(String(entry.mediaId || entry.id))) {
      const base = registry.get(String(entry.mediaId || entry.id));
      const title = preferredMediaTitle(entry.displayTitle || entry.title || entry.name, base.displayTitle || base.title || base.name);
      if (/(?:^|-)requests?$/u.test(collectionName) || collectionName === "calendar") {
        // A request or calendar row is narrower than the canonical movie/series record.
        // Inheriting record-wide lifecycle flags can falsely mark a new season request
        // or future episode as available merely because older content is in Jellyfin.
        candidate = {
          ...entry,
          mediaType: entry.mediaType || entry.type || base.mediaType || base.type,
          year: entry.year || base.year,
          summary: entry.summary || entry.overview || base.summary || base.overview,
          artworkUrl: entry.artworkUrl || base.artworkUrl,
          providerIds: { ...(base.providerIds || {}), ...(entry.providerIds || {}) },
          sources: entry.sources || base.sources,
          actionTargets: entry.actionTargets || base.actionTargets,
          title,
          lifecycle: { ...(entry.lifecycle || {}) }
        };
      } else {
        candidate = { ...base, ...entry, title, lifecycle: { ...base.lifecycle, ...entry.lifecycle } };
      }
    }
    if (!candidate || typeof candidate !== "object") return [];
    const item = normalizeMediaItem(candidate, `${collectionName}:${index}`);
    if (seen.has(item.key)) return [];
    seen.add(item.key);
    return [{ ...item, collection: collectionName }];
  });
}

function normalizeMediaSnapshot(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const present = Boolean(raw);
  const rawRecords = Array.isArray(raw?.records) ? raw.records.slice(0, 1_000) : [];
  const registry = new Map();
  rawRecords.forEach((entry, index) => {
    const item = normalizeMediaItem(entry, `record:${index}`);
    registry.set(item.id, entry);
  });
  const collection = (entries, name, maximum) => normalizedMediaCollection(entries, registry, name, maximum);
  const homeSource = raw?.home && typeof raw.home === "object" && !Array.isArray(raw.home) ? raw.home : {};
  const home = {
    nowPlaying: collection(homeSource.nowPlaying, "home-now-playing", 40),
    continueWatching: collection(homeSource.continueWatching, "home-continue", 40),
    recentlyAdded: collection(homeSource.recentlyAdded, "home-recent", 60),
    pendingRequests: collection(homeSource.pendingRequests, "home-requests", 80),
    activeDownloads: collection(homeSource.activeDownloads, "home-downloads", 100),
    blockedImports: collection(homeSource.blockedImports, "home-blocked", 100),
    upcoming: collection(homeSource.upcoming, "home-upcoming", 100),
    missing: collection(homeSource.missing, "home-missing", 100),
    subtitleBacklog: collection(homeSource.subtitleBacklog, "home-subtitles", 100)
  };
  const records = collection(rawRecords, "records", 1_000);
  const library = collection(raw?.library, "library", 1_000);
  const discover = collection(raw?.discover, "discover", 500);
  const requests = collection(raw?.requests, "requests", 500);
  const activity = collection(raw?.activity, "activity", 500);
  const calendar = collection(raw?.calendar, "calendar", 500);
  const subtitleBacklog = collection(raw?.subtitleBacklog, "subtitle-backlog", 500);
  const metricsRaw = raw?.metrics && typeof raw.metrics === "object" && !Array.isArray(raw.metrics) ? raw.metrics : {};
  const all = [];
  const allSeen = new Set();
  [records, library, discover, requests, activity, calendar, subtitleBacklog, ...Object.values(home)].forEach((entries) => {
    entries.forEach((item) => {
      if (allSeen.has(item.key)) return;
      allSeen.add(item.key);
      all.push(item);
    });
  });
  return {
    present,
    schema: mediaNumber(raw?.schema, 1, 10),
    generatedAt: mediaText(raw?.generatedAt, "", 40),
    records,
    all,
    home,
    library,
    discover,
    requests,
    activity,
    calendar,
    subtitleBacklog,
    metrics: {
      libraryTotal: mediaNumber(metricsRaw.libraryTotal ?? metricsRaw.libraryItems, 0, 10_000_000) ?? library.length,
      libraryCompleteness: mediaNumber(metricsRaw.libraryCompleteness ?? metricsRaw.completenessPercent, 0, 100),
      monitoredTotal: mediaNumber(metricsRaw.monitoredTotal, 0, 10_000_000),
      missingTotal: mediaNumber(metricsRaw.missingTotal, 0, 10_000_000) ?? home.missing.length,
      missingMovies: mediaNumber(metricsRaw.missingMovies, 0, 10_000_000),
      missingEpisodes: mediaNumber(metricsRaw.missingEpisodes, 0, 10_000_000),
      pendingRequestTotal: mediaNumber(metricsRaw.pendingRequestTotal, 0, 10_000_000) ?? home.pendingRequests.length,
      activeDownloadTotal: mediaNumber(metricsRaw.activeDownloadTotal, 0, 10_000_000) ?? home.activeDownloads.length,
      blockedImportTotal: mediaNumber(metricsRaw.blockedImportTotal, 0, 10_000_000) ?? home.blockedImports.length,
      subtitleBacklog: mediaNumber(metricsRaw.subtitleBacklog ?? metricsRaw.subtitleBacklogTotal, 0, 10_000_000) ?? subtitleBacklog.length
    }
  };
}

function mediaSnapshotForUi() {
  return normalizeMediaSnapshot(state.snapshot?.media);
}

function mediaStructuralFingerprint(value) {
  const media = normalizeMediaSnapshot(value);
  if (!media.present) return "legacy";
  const itemShape = (item) => ({
    key: item.key,
    title: item.title,
    mediaType: item.mediaType,
    year: item.year,
    summary: item.summary,
    subtitle: item.subtitle,
    requestedBy: item.requestedBy,
    service: item.service,
    state: item.state,
    requestId: item.requestId,
    requestStatus: item.requestStatus,
    requestBucket: item.requestBucket,
    mediaStatus: item.mediaStatus,
    is4k: item.is4k,
    requestedSeasons: item.requestedSeasons,
    seasonStatuses: item.seasonStatuses,
    requestFulfilled: item.requestFulfilled,
    requestCompleted: item.requestCompleted,
    requestScope: item.requestScope,
    partiallyAvailable: item.partiallyAvailable,
    error: item.error,
    providerIds: item.providerIds,
    sources: item.sources,
    actionTargets: item.actionTargets,
    lifecycle: item.lifecycle,
    requested: item.requested,
    monitored: item.monitored,
    downloading: item.downloading,
    imported: item.imported,
    available: item.available,
    addedAt: item.addedAt,
    releaseAt: item.releaseAt,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    artworkUrl: item.artworkUrl
  });
  return JSON.stringify({
    schema: media.schema,
    records: media.records.map(itemShape),
    home: Object.fromEntries(Object.entries(media.home).map(([name, entries]) => [name, entries.map(itemShape)])),
    library: media.library.map(itemShape),
    discover: media.discover.map(itemShape),
    requests: media.requests.map(itemShape),
    activity: media.activity.map(itemShape),
    calendar: media.calendar.map(itemShape),
    subtitleBacklog: media.subtitleBacklog.map(itemShape),
    metrics: media.metrics
  });
}

function mediaTypeLabel(value) {
  return { movie: "Movie", series: "Series", show: "Series", episode: "Episode" }[String(value || "").toLowerCase()] || "Media";
}

function isMediaCollection(item, name) {
  return String(item?.collection || "") === name || String(item?.collection || "").endsWith(`-${name}`);
}

function mediaRequestState(item) {
  const token = normalizedMediaToken(item?.requestStatus || (isMediaCollection(item, "requests") ? item?.state : ""));
  return {
    "1": "pending",
    "2": "approved",
    "3": "declined",
    "4": "failed",
    "5": "completed",
    available: "completed",
    processing: "approved"
  }[token] || token;
}

function mediaRequestStateLabel(item) {
  return {
    pending: "Pending approval",
    approved: "Request approved",
    declined: "Request declined",
    failed: "Request failed",
    completed: "Request completed"
  }[mediaRequestState(item)] || (item.requested ? "Requested" : "Not requested");
}

function mediaRequestScopeLabel(item) {
  const details = [mediaTypeLabel(item.mediaType)];
  if (item.is4k) details.push("4K");
  if (item.requestedSeasons.length === 1) details.push(`Season ${item.requestedSeasons[0]}`);
  else if (item.requestedSeasons.length > 1) details.push(`Seasons ${item.requestedSeasons.join(", ")}`);
  if (item.year) details.push(item.year);
  return details.join(" · ");
}

// Seerr's parent media status describes the whole series. For a request that
// names specific seasons, only those seasons' availability rows may advance
// acquisition state; otherwise an older season can make a new request look as
// though it is already processing or partially acquired.
function mediaRequestAcquisitionStatus(item) {
  const mediaStatus = normalizedMediaToken(item.mediaStatus);
  const seasonScoped = item.requestScope === "seasons"
    || item.mediaType === "series" && item.requestedSeasons.length > 0;
  if (!seasonScoped) return mediaStatus;

  const statuses = item.seasonStatuses.map(({ status }) => normalizedMediaToken(status)).filter(Boolean);
  if (!statuses.length) return "unknown";
  if (statuses.every((status) => status === "available")) return "available";
  if (statuses.some((status) => ["available", "partially_available"].includes(status))) return "partially_available";
  if (statuses.some((status) => status === "processing")) return "processing";
  if (statuses.some((status) => status === "pending")) return "pending";
  return "unknown";
}

function mediaRequestFulfillmentLabel(item) {
  const requestState = mediaRequestState(item);
  const acquisitionStatus = mediaRequestAcquisitionStatus(item);
  if (item.error) return "Needs attention";
  if (item.available || isMediaCollection(item, "discover") && item.mediaStatus === "available") return "Available";
  if (requestState === "failed") return "Needs attention";
  if (requestState === "declined") return "Declined";
  if (item.mediaStatus === "blocklisted") return "Blocklisted in Seerr";
  if (item.mediaStatus === "deleted") return "Removed";
  if (requestState === "pending") return "Awaiting approval";
  if (item.imported) return "Awaiting Jellyfin";
  if (item.downloading) return "Downloading";
  if (acquisitionStatus === "partially_available") return "Partially acquired";
  if (acquisitionStatus === "processing") return "Processing";
  if (acquisitionStatus === "pending") return "Awaiting acquisition";
  if (item.requestCompleted || requestState === "completed") return "Awaiting availability";
  if (item.monitored || item.requested || ["approved", "completed"].includes(requestState)) return "Awaiting acquisition";
  return "Request status pending";
}

// Request filters describe Seerr workflow, not the color used to draw a card.
// Keeping this separate prevents every unfulfilled `requested` lifecycle from
// being mistaken for a request that is still waiting for approval.
function mediaRequestBucket(item) {
  if (["pending", "in_progress", "available", "attention", "closed"].includes(item.requestBucket)) {
    return item.requestBucket;
  }
  const requestState = mediaRequestState(item);
  if (item.error) return "attention";
  if (item.available || item.requestFulfilled || item.mediaStatus === "available") return "available";
  if (requestState === "failed") return "attention";
  if (requestState === "declined" || ["blocklisted", "deleted"].includes(item.mediaStatus)) return "closed";
  if (requestState === "pending") return "pending";
  return "in_progress";
}

function mediaRequestJourneyStage(item) {
  const acquisitionStatus = mediaRequestAcquisitionStatus(item);
  if (item.available || item.requestFulfilled || acquisitionStatus === "available") return "available";
  if (item.imported || acquisitionStatus === "partially_available") return "imported";
  if (item.downloading) return "downloading";
  if (item.monitored || acquisitionStatus === "processing") return "monitored";
  return "requested";
}

function mediaStage(item) {
  if (/activity|downloads|blocked/u.test(item.collection || "") && item.state) {
    if (["completed", "uploading", "pausedup"].includes(item.state)) return "available";
    if (/(?:failed|blocked|error|stalled)/u.test(item.state)) return "failed";
    if (/(?:download|queued|active|checking|paused)/u.test(item.state)) return "downloading";
  }
  if (item.available) return "available";
  if (item.imported) return "imported";
  if (item.downloading) return "downloading";
  if (isMediaCollection(item, "calendar") || isMediaCollection(item, "upcoming")) return "upcoming";
  if (item.monitored) return "monitored";
  if (item.requested) return "requested";
  const lifecycleStage = normalizedMediaToken(item.lifecycle?.stage);
  if (lifecycleStage && lifecycleStage !== "unknown") return lifecycleStage;
  if (isMediaCollection(item, "discover") && ["not_requested", "unknown", ""].includes(item.state)) return "not_requested";
  const state = normalizedMediaToken(item.state);
  return state && state !== "unknown" ? state : "waiting";
}

function mediaStatusLabel(item) {
  const stage = mediaStage(item);
  if (isMediaCollection(item, "requests") || isMediaCollection(item, "discover") && stage !== "not_requested") {
    return mediaRequestFulfillmentLabel(item);
  }
  return {
    requested: "Requested",
    pending: "Pending",
    monitored: "Monitored",
    downloading: "Downloading",
    importing: "Importing",
    imported: "Imported",
    available: "Available",
    complete: "Complete",
    failed: "Failed",
    blocked: "Blocked",
    upcoming: "Upcoming",
    not_requested: "Not requested",
    waiting: "Status pending"
  }[stage] || mediaText(stage, "Status pending", 40).replace(/(^|[-_])([a-z])/gu, (_match, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function mediaStatusTone(item) {
  if (isMediaCollection(item, "requests")) {
    const bucket = mediaRequestBucket(item);
    if (bucket === "available") return "available";
    if (bucket === "attention") return "failed";
    if (bucket === "closed") return "upcoming";
    if (bucket === "pending") return "pending";
    return item.downloading ? "importing" : "partial";
  }
  if (item.error || ["failed", "blocked", "stalled"].includes(item.state) || ["declined", "failed"].includes(mediaRequestState(item))) return "failed";
  if (isMediaCollection(item, "discover") && !item.available) {
    if (["blocklisted", "deleted"].includes(item.mediaStatus)) return "failed";
    if (item.downloading || item.mediaStatus === "processing") return "importing";
    return item.state === "not_requested" ? "upcoming" : "partial";
  }
  const stage = mediaStage(item);
  if (stage === "available" || stage === "complete" || stage === "imported") return "available";
  if (stage === "requested" || stage === "pending") return "pending";
  if (stage === "upcoming" || stage === "not_requested") return "upcoming";
  return stage === "downloading" ? "importing" : "partial";
}

function formatMediaSpeed(value) {
  const speed = mediaNumber(value, 0, 1_000_000_000_000);
  if (speed === null) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let amount = speed;
  let unit = 0;
  while (amount >= 1_000 && unit < units.length - 1) {
    amount /= 1_000;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMediaEta(value) {
  const seconds = mediaNumber(value, 0, 31_536_000);
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

const MEDIA_EAGER_CARD_COUNT = 4;
const MEDIA_ARTWORK_WIDTH = 342;
const MEDIA_ARTWORK_HEIGHT = 513;
const MEDIA_ARTWORK_RETRY_DELAY_MS = 2_000;
const MEDIA_ARTWORK_MAX_RETRIES = 2;

function renderArtworkImage(item, {
  className = "media-art-image",
  eager = false,
  priority = eager ? "high" : "low"
} = {}) {
  const artworkUrl = mediaArtworkUrl(item?.artworkUrl);
  if (!artworkUrl) return "";
  const safePriority = ["high", "low", "auto"].includes(priority) ? priority : "low";
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(artworkUrl)}" data-artwork-src="${escapeHtml(artworkUrl)}" alt="" width="${MEDIA_ARTWORK_WIDTH}" height="${MEDIA_ARTWORK_HEIGHT}" loading="${eager ? "eager" : "lazy"}" fetchpriority="${safePriority}" decoding="async" draggable="false" />`;
}

function retryMediaArtwork(element) {
  const artworkUrl = mediaArtworkUrl(element?.dataset?.artworkSrc);
  const retryCount = Number.parseInt(element?.dataset?.artworkRetryCount || "0", 10);
  if (!artworkUrl || !Number.isSafeInteger(retryCount) || retryCount >= MEDIA_ARTWORK_MAX_RETRIES) return false;
  element.dataset.artworkRetryCount = String(retryCount + 1);
  element.hidden = true;
  element.removeAttribute("src");
  setTimeout(() => {
    if (!element.isConnected) return;
    element.setAttribute("src", artworkUrl);
    element.hidden = false;
  }, MEDIA_ARTWORK_RETRY_DELAY_MS);
  return true;
}

function renderMediaArt(item, className = "poster-art", { eager = false, priority = eager ? "high" : "low" } = {}) {
  const artwork = renderArtworkImage(item, { eager, priority });
  return `<span class="${escapeHtml(className)}">${artwork}<span class="art-fallback-letter" aria-hidden="true">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span></span>`;
}

function renderMediaEmpty(title, detail, iconName = "library") {
  return `<div class="empty-state"><span>${icon(iconName)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`;
}

function renderPosterCard(item, { eager = false, priority = eager ? "high" : "low" } = {}) {
  const progress = item.progress === null ? "" : `<progress class="poster-progress" data-media-progress value="${item.progress}" max="100">${item.progress}%</progress>`;
  return `<button class="poster-card media-filter-item" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}" data-media-filter-item data-media-title="${escapeHtml(item.title.toLowerCase())}" data-media-type="${escapeHtml(item.mediaType)}" data-media-state="${escapeHtml(mediaStatusTone(item))}" aria-label="Open ${escapeHtml(item.title)} details">
    <span class="poster-art">${renderArtworkImage(item, { eager, priority })}<span class="poster-monogram" aria-hidden="true">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span><span class="poster-type">${escapeHtml(mediaTypeLabel(item.mediaType).toUpperCase())}</span><i class="poster-state-dot state-${mediaStatusTone(item)}" aria-hidden="true"></i>${progress}</span>
    <span class="poster-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml([item.year, mediaStatusLabel(item)].filter(Boolean).join(" · "))}</span></span>
  </button>`;
}

function renderPosterSection(title, detail, items, emptyCopy, { eagerCount = 0 } = {}) {
  return `<section class="media-section"><header class="section-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div></header>${items.length ? `<div class="poster-rail">${items.map((item, index) => renderPosterCard(item, { eager: index < eagerCount })).join("")}</div>` : renderMediaEmpty(title, emptyCopy, "library")}</section>`;
}

function renderHomeActivityRow(item) {
  return `<button class="pipeline-row" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">
    ${renderMediaArt(item, "pipeline-art")}<span class="pipeline-main"><span class="pipeline-title"><strong>${escapeHtml(item.title)}</strong><em class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</em></span><span class="pipeline-subtitle">${escapeHtml(item.error || item.subtitle || mediaTypeLabel(item.mediaType))}</span>${item.progress === null ? "" : `<progress data-media-progress value="${item.progress}" max="100">${item.progress}%</progress>`}</span><span class="pipeline-aside"><strong data-media-speed>${escapeHtml(formatMediaSpeed(item.downloadSpeedBps))}</strong><small data-media-eta>${escapeHtml(formatMediaEta(item.etaSeconds))}</small></span>${icon("chevron")}
  </button>`;
}

function renderMediaHome() {
  const media = mediaSnapshotForUi();
  if (!media.present) return renderOperationsOverview(snapshotForUi(), state.infrastructure.targets);
  const feature = media.home.nowPlaying[0] || media.home.continueWatching[0] || media.home.recentlyAdded[0] || media.discover[0] || null;
  const missingMovies = media.metrics.missingMovies ?? media.home.missing.filter((item) => item.mediaType === "movie").length;
  const missingEpisodes = media.metrics.missingEpisodes ?? media.home.missing.filter((item) => item.mediaType !== "movie").length;
  const configuredCount = (state.config?.services || []).filter((service) => service.configured).length;
  const hero = feature ? `<section class="cinema-hero" data-media-key="${feature.key}">
    ${renderArtworkImage(feature, { className: "hero-art-image", eager: true })}<div class="hero-shade"></div>
    <div class="hero-content"><span class="eyebrow"><i></i>${feature === media.home.nowPlaying[0] ? "Now playing" : "Continue watching"}</span><h2>${escapeHtml(feature.title)}</h2><div class="hero-meta"><span>${escapeHtml(mediaTypeLabel(feature.mediaType))}</span>${feature.year ? `<span>${escapeHtml(feature.year)}</span>` : ""}<span>${escapeHtml(mediaStatusLabel(feature))}</span></div><p>${escapeHtml(feature.summary || feature.subtitle || "Playback and availability are correlated across your connected services.")}</p><div class="hero-actions"><button class="primary-button" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(feature.id)}" data-media-key="${feature.key}">${icon("eye")} View details</button><a class="secondary-button" href="#/library">Browse library</a></div>${feature.progress === null ? "" : `<div class="hero-progress"><progress data-media-progress value="${feature.progress}" max="100">${feature.progress}%</progress><span data-media-progress-label data-media-progress-suffix=" watched">${feature.progress}% watched</span></div>`}</div>
    <div class="hero-live"><span class="live-label"><i></i>Read-only view</span><strong>${configuredCount} connected service${configuredCount === 1 ? "" : "s"}</strong><small>Updated ${escapeHtml(formatTime(media.generatedAt, "when data arrives"))}</small></div>
  </section>` : `<section class="media-welcome-panel"><div><span class="eyebrow"><i></i>Desktop media center</span><h2>Your media workflow, in one place</h2><p>${configuredCount ? "Connected services have not returned any media records yet. Helmsman will keep this page stable while the next read-only refresh completes." : "Add Jellyfin, Seerr, Sonarr, Radarr, qBittorrent, and Bazarr connections to build the unified view."}</p></div><a class="primary-button" href="#/connections">Review connections</a></section>`;
  const downloads = [...media.home.blockedImports, ...media.home.activeDownloads].slice(0, 8);
  const attention = [...media.home.pendingRequests, ...media.home.blockedImports].slice(0, 8);
  return `<div class="page media-desktop-page media-home-page operations-page">${hero}
    <form class="media-home-search" id="media-search-form" role="search"><label for="media-home-search">${icon("search")}<span><strong>Search your media</strong><small>Search the normalized titles already fetched by Helmsman.</small></span><input id="media-home-search" name="query" type="search" value="${escapeHtml(state.media.filters.homeSearch)}" placeholder="Movie, series, or episode" data-media-filter="homeSearch" autocomplete="off" /></label><button class="secondary-button" type="submit">Search library ${icon("chevron")}</button></form>
    <section class="media-home-metrics" aria-label="Media workload summary">
      <a href="#/library"><strong>${media.metrics.libraryTotal.toLocaleString()}</strong><span>Library items</span><small>${media.metrics.libraryCompleteness === null ? "Availability indexed" : `${media.metrics.libraryCompleteness}% complete`}</small></a>
      <a href="#/requests" data-action="open-request-filter" data-media-filter-value="pending"><strong>${media.metrics.pendingRequestTotal.toLocaleString()}</strong><span>Awaiting approval</span><small>Seerr requests needing a decision</small></a>
      <a href="#/activity"><strong>${media.metrics.activeDownloadTotal.toLocaleString()}</strong><span>Active downloads</span><small>${media.metrics.blockedImportTotal} blocked import${media.metrics.blockedImportTotal === 1 ? "" : "s"}</small></a>
      <a href="#/library"><strong>${media.metrics.missingTotal.toLocaleString()}</strong><span>Missing media</span><small>${missingMovies} movies · ${missingEpisodes} episodes shown</small></a>
      <a href="#/health"><strong>${media.metrics.subtitleBacklog.toLocaleString()}</strong><span>Subtitle backlog</span><small>Bazarr-reported items</small></a>
    </section>
    ${renderPosterSection("Continue watching", "Resume items reported by Jellyfin", media.home.continueWatching, "Nothing is waiting to be resumed.", { eagerCount: MEDIA_EAGER_CARD_COUNT })}
    <div class="focus-layout"><section class="pipeline-panel"><header class="panel-heading"><div><span class="eyebrow">Activity</span><h2>Downloads and imports</h2><p>qBittorrent progress correlated with Sonarr and Radarr imports.</p></div><a class="text-link" href="#/activity">All activity ${icon("chevron")}</a></header><div class="pipeline-list">${downloads.length ? downloads.map(renderHomeActivityRow).join("") : renderMediaEmpty("No active transfers", "Downloads and blocked imports will appear here.", "download")}</div></section>
      <section class="activity-panel"><header class="panel-heading"><div><span class="eyebrow">Attention</span><h2>Requests and warnings</h2><p>Only current, service-reported conditions are shown.</p></div></header><div class="activity-list">${attention.length ? attention.map((item) => `<button class="activity-event" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}"><i class="event-marker ${item.error ? "tone-danger" : "tone-active"}"></i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.error || mediaStatusLabel(item))}</small></span><time>${escapeHtml(formatTime(item.requestedAt || item.releaseAt, "Current"))}</time></button>`).join("") : renderMediaEmpty("Nothing needs attention", "Pending requests and service warnings will appear here.", "check")}</div></section></div>
    ${renderPosterSection("Recently added", "Latest titles available in Jellyfin", media.home.recentlyAdded, "No recently added titles were reported.")}
    ${renderPosterSection("Upcoming releases", "Monitored releases from Sonarr and Radarr", media.home.upcoming.slice(0, 14), "No upcoming releases were reported.")}
  </div>`;
}

function renderMediaToolbar(route, query, types = [], { search = true } = {}) {
  return `<div class="library-toolbar">${search ? `<label class="inline-search" for="media-${route}-search">${icon("search")}<input id="media-${route}-search" type="search" value="${escapeHtml(query)}" placeholder="Search titles" data-media-filter="${route}" autocomplete="off" /></label>` : ""}${types.length ? `<div class="filter-chips" role="group" aria-label="Filter ${escapeHtml(route)}">${types.map(({ value, label, active }) => `<button class="filter-chip ${active ? "is-active" : ""}" type="button" data-action="media-filter" data-media-filter-name="${escapeHtml(route === "library" ? "libraryType" : route)}" data-media-filter-value="${escapeHtml(value)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(label)}</button>`).join("")}</div>` : ""}</div>`;
}

function renderDiscoverPage() {
  const media = mediaSnapshotForUi();
  const items = media.discover;
  const feature = items[0] || null;
  return `<div class="page media-desktop-page"><section class="page-intro"><div><span class="eyebrow">Across connected catalogs</span><h2>Discover</h2><p>Browse Seerr discovery results. “Available” is only shown when Jellyfin confirms the title; other results retain their request or acquisition state.</p></div><div class="library-totals"><strong>${items.length.toLocaleString()}</strong><span>discoverable titles</span></div></section>
    ${feature ? `<section class="discover-feature">${renderArtworkImage(feature, { className: "hero-art-image", eager: true })}<div class="hero-shade"></div><div class="discover-copy"><span class="eyebrow"><i></i>Featured</span><h2>${escapeHtml(feature.title)}</h2><div class="hero-meta"><span>${escapeHtml(mediaTypeLabel(feature.mediaType))}</span>${feature.year ? `<span>${escapeHtml(feature.year)}</span>` : ""}<span>${escapeHtml(mediaStatusLabel(feature))}</span></div><p>${escapeHtml(feature.summary || "Matched against your connected library and automation services.")}</p><div class="hero-actions"><button class="primary-button" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(feature.id)}" data-media-key="${feature.key}">${icon("eye")} View details</button></div></div><div class="featured-stage"><span class="status-pill status-${mediaStatusTone(feature)}"><i></i>${escapeHtml(mediaStatusLabel(feature))}</span></div></section>` : ""}
    ${renderMediaToolbar("discover", state.media.filters.discover)}<div class="results-line"><span data-media-result-count>${items.length} results</span><span>Jellyfin availability matched by provider ID</span></div><div class="poster-grid">${items.length ? items.map((item, index) => renderPosterCard(item, { eager: index < MEDIA_EAGER_CARD_COUNT })).join("") : renderMediaEmpty("Discovery is empty", "Connect Seerr and wait for its first catalog refresh.", "compass")}</div>
  </div>`;
}

function renderLibraryPage() {
  const media = mediaSnapshotForUi();
  const items = media.library;
  const selectedType = state.media.filters.libraryType;
  return `<div class="page media-desktop-page"><section class="page-intro"><div><span class="eyebrow">Unified availability</span><h2>Library</h2><p>Jellyfin availability combined with Sonarr and Radarr monitoring, imports, and subtitle state.</p></div><div class="library-totals"><strong>${media.metrics.libraryTotal.toLocaleString()}</strong><span>indexed titles</span></div></section>
    ${renderMediaToolbar("library", state.media.filters.library, [
      { value: "all", label: "All", active: selectedType === "all" },
      { value: "movie", label: "Movies", active: selectedType === "movie" },
      { value: "series", label: "Series", active: ["series", "show"].includes(selectedType) }
    ])}<div class="results-line"><span data-media-result-count>${items.length} results</span><span>${media.metrics.libraryCompleteness === null ? "Read-only inventory" : `${media.metrics.libraryCompleteness}% complete`}</span></div><div class="poster-grid">${items.length ? items.map((item, index) => renderPosterCard(item, { eager: index < MEDIA_EAGER_CARD_COUNT })).join("") : renderMediaEmpty("No library records yet", "Jellyfin and the automation services have not returned any matched titles.", "library")}</div>
  </div>`;
}

function lifecycleStepClass(item, stepId) {
  const stage = isMediaCollection(item, "requests") ? mediaRequestJourneyStage(item) : mediaStage(item);
  const current = MEDIA_LIFECYCLE_STEPS.findIndex(({ id }) => id === stage);
  const index = MEDIA_LIFECYCLE_STEPS.findIndex(({ id }) => id === stepId);
  const hasIssue = item.error || isMediaCollection(item, "requests") && mediaRequestBucket(item) === "attention";
  if (hasIssue && index === Math.max(0, current)) return "has-issue";
  if (index < current || stepId === "available" && item.available) return "is-done";
  if (index === current) return "is-current";
  return "";
}

function renderRequestRow(item) {
  const requestEvidence = [
    item.requestedBy ? `By ${item.requestedBy}` : "",
    formatTime(item.requestedAt, "Time not reported")
  ].filter(Boolean).join(" · ");
  return `<article class="request-row media-filter-item" data-media-filter-item data-media-key="${item.key}" data-media-title="${escapeHtml(item.title.toLowerCase())}" data-media-type="${escapeHtml(item.mediaType)}" data-media-state="${escapeHtml(mediaRequestBucket(item))}">
    <button class="request-title" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">${renderMediaArt(item, "request-art")}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(mediaRequestScopeLabel(item))}</small></span></button>
    <span class="request-owner"><span>Request state</span><strong>${escapeHtml(mediaRequestStateLabel(item))}</strong><small>${escapeHtml(requestEvidence)}</small></span>
    <span class="request-journey">${MEDIA_LIFECYCLE_STEPS.map((step, index) => `<span class="journey-step ${lifecycleStepClass(item, step.id)}"><i>${lifecycleStepClass(item, step.id) === "is-done" ? icon("check") : index + 1}</i><small>${escapeHtml(step.label)}</small></span>`).join("")}</span>
    <span class="request-actions"><span class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</span><button class="icon-button" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}" aria-label="Open ${escapeHtml(item.title)} details">${icon("chevron")}</button></span>
  </article>`;
}

function renderRequestsPage() {
  const media = mediaSnapshotForUi();
  const selected = state.media.filters.requests;
  return `<div class="page media-desktop-page"><section class="page-intro"><div><span class="eyebrow">Seerr workflow</span><h2>Requests</h2><p>Request approval and acquisition are shown separately, including the exact requested seasons. Only request-scoped fulfillment can reach Jellyfin availability.</p></div><div class="library-totals"><strong>${media.requests.length.toLocaleString()}</strong><span>requests</span></div></section>
    ${renderMediaToolbar("requests", "", [
      { value: "all", label: "All", active: selected === "all" },
      { value: "pending", label: "Awaiting approval", active: selected === "pending" },
      { value: "in_progress", label: "In progress", active: selected === "in_progress" },
      { value: "available", label: "Available", active: selected === "available" },
      { value: "attention", label: "Needs attention", active: selected === "attention" },
      { value: "closed", label: "Closed", active: selected === "closed" }
    ], { search: false })}<div class="results-line"><span data-media-result-count>${media.requests.length} requests</span><span>Failed requests can be retried from details</span></div><section class="request-list">${media.requests.length ? media.requests.map(renderRequestRow).join("") : renderMediaEmpty("No requests to show", "Seerr has not reported any requests yet.", "inbox")}</section>
  </div>`;
}

function activityFilterState(item) {
  if (item.error || ["failed", "blocked", "stalled"].includes(item.state)) return "failed";
  if (/(?:download|queued|active|checking|pauseddl)/u.test(item.state)) return "active";
  if (["complete", "completed", "uploading", "pausedup"].includes(item.state)) return "available";
  if (item.available || item.imported) return "available";
  return "active";
}

function renderActivityRow(item) {
  const filterState = activityFilterState(item);
  return `<article class="download-row ${filterState === "failed" ? "has-issue" : ""} media-filter-item" data-media-filter-item data-media-key="${item.key}" data-media-title="${escapeHtml(item.title.toLowerCase())}" data-media-type="${escapeHtml(item.mediaType)}" data-media-state="${filterState}">
    <button class="download-identity" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">${renderMediaArt(item, "download-art")}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.error || item.subtitle || item.service || mediaTypeLabel(item.mediaType))}</small></span></button>
    <span class="download-stage"><span class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</span><small>${escapeHtml(item.service ? reportServiceName(item.service) : "Correlated activity")}</small></span>
    <span class="download-progress"><span><strong data-media-progress-label>${item.progress === null ? "—" : `${item.progress}%`}</strong><span>Progress</span></span><progress data-media-progress value="${item.progress ?? 0}" max="100">${item.progress ?? 0}%</progress></span>
    <span class="download-stat"><span>Speed</span><strong data-media-speed>${escapeHtml(formatMediaSpeed(item.downloadSpeedBps))}</strong></span>
    <span class="download-stat"><span>ETA</span><strong data-media-eta>${escapeHtml(formatMediaEta(item.etaSeconds))}</strong></span>
    <span class="download-actions"><button class="icon-button" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}" aria-label="Open ${escapeHtml(item.title)} details">${icon("chevron")}</button></span>
  </article>`;
}

function renderActivityPage() {
  const media = mediaSnapshotForUi();
  const selected = state.media.filters.activity;
  const issueCount = media.activity.filter((item) => activityFilterState(item) === "failed").length;
  return `<div class="page media-desktop-page"><section class="page-intro"><div><span class="eyebrow">Downloads and imports</span><h2>Activity</h2><p>qBittorrent progress, speed, and ETA correlated with the actual Sonarr or Radarr import state.</p></div><div class="library-totals"><strong>${media.activity.length.toLocaleString()}</strong><span>activity items</span></div></section>
    ${issueCount ? `<div class="issue-callout"><span class="issue-icon">!</span><div><strong>${issueCount} item${issueCount === 1 ? "" : "s"} need attention</strong><p>Open a row to see the error reported by the source service.</p></div></div>` : ""}
    ${renderMediaToolbar("activity", "", [
      { value: "all", label: "All", active: selected === "all" },
      { value: "active", label: "Active", active: selected === "active" },
      { value: "failed", label: "Needs attention", active: selected === "failed" },
      { value: "available", label: "Completed", active: selected === "available" }
    ], { search: false })}<div class="results-line"><span data-media-result-count>${media.activity.length} items</span><span>Live values update in place</span></div><section class="download-list">${media.activity.length ? media.activity.map(renderActivityRow).join("") : renderMediaEmpty("No download activity", "Active and recent queue entries will appear here.", "download")}</section>
  </div>`;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderCalendarEntry(item) {
  const stateName = item.available ? "available" : item.downloading ? "searching" : "upcoming";
  const episodeCode = item.mediaType === "episode" && (item.seasonNumber !== null || item.episodeNumber !== null)
    ? `S${String(item.seasonNumber ?? 0).padStart(2, "0")}E${String(item.episodeNumber ?? 0).padStart(2, "0")}`
    : "";
  const distinctSubtitle = item.subtitle && item.subtitle.localeCompare(item.title, undefined, { sensitivity: "base" }) !== 0
    ? item.subtitle
    : "";
  const kind = item.mediaType === "episode"
    ? [episodeCode, distinctSubtitle].filter(Boolean).join(" · ") || "Episode"
    : mediaTypeLabel(item.mediaType);
  return `<button class="calendar-entry state-${stateName}" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">${renderMediaArt(item, "calendar-cover")}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(kind)}</small><em>${escapeHtml(mediaStatusLabel(item))}</em></span></button>`;
}

function renderCalendarPage() {
  const media = mediaSnapshotForUi();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_unused, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return date;
  });
  const grouped = new Map(days.map((date) => [localDateKey(date), []]));
  const later = [];
  media.calendar.forEach((item) => {
    const key = localDateKey(item.releaseAt);
    if (grouped.has(key)) grouped.get(key).push(item);
    else later.push(item);
  });
  return `<div class="page media-desktop-page"><section class="page-intro"><div><span class="eyebrow">Release schedule</span><h2>Calendar</h2><p>Upcoming monitored movies and episodes from Sonarr and Radarr.</p></div><div class="calendar-legend"><span><i class="available"></i>Available</span><span><i class="searching"></i>Downloading</span><span><i></i>Upcoming</span></div></section>
    <section class="week-grid" aria-label="Seven day media calendar">${days.map((date, index) => { const entries = grouped.get(localDateKey(date)); return `<article class="calendar-day ${index === 0 ? "is-today" : ""}"><header><span>${escapeHtml(date.toLocaleDateString([], { weekday: "short" }).toUpperCase())}</span><strong>${date.getDate()}</strong></header>${entries.length ? entries.map(renderCalendarEntry).join("") : `<p class="calendar-day-empty">No releases</p>`}</article>`; }).join("")}</section>
    <section class="calendar-upcoming"><header class="panel-heading"><div><span class="eyebrow">Later</span><h2>Beyond this week</h2><p>Additional releases returned by the connected calendars.</p></div></header>${later.length ? `<div class="upcoming-row">${later.slice(0, 12).map((item) => `<button class="mini-title" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">${renderMediaArt(item, "mini-art")}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(formatTime(item.releaseAt, "Date pending"))}</small></span>${icon("chevron")}</button>`).join("")}</div>` : renderMediaEmpty("No later releases", "The connected calendars have no additional entries.", "calendar")}</section>
  </div>`;
}

function mediaOnlyOperationsSnapshot() {
  const raw = snapshotForUi();
  const isMediaIncident = (entry) => String(entry?.scope || "media").toLowerCase() !== "infrastructure"
    && !/^(?:proxmox|portainer)(?:-|$)/u.test(String(entry?.service || entry?.serviceId || "").toLowerCase());
  const incidents = Array.isArray(raw.incidents)
    ? raw.incidents.filter(isMediaIncident)
    : {
        ...(raw.incidents || {}),
        open: (Array.isArray(raw.incidents?.open) ? raw.incidents.open : []).filter(isMediaIncident),
        recent: (Array.isArray(raw.incidents?.recent) ? raw.incidents.recent : []).filter(isMediaIncident)
      };
  const serviceList = (Array.isArray(raw.services) ? raw.services : []).filter((service) => (
    !/^(?:proxmox|portainer)(?:-|$)/u.test(String(service?.id || "").toLowerCase())
  ));
  const openCount = Array.isArray(incidents) ? incidents.length : incidents.open.length;
  const affectedServiceCount = serviceList.filter((service) => !["healthy", "disabled"].includes(statusClass(service?.state))).length;
  return {
    ...raw,
    overall: {
      ...(raw.overall || {}),
      serviceCount: serviceList.length,
      affectedServiceCount,
      openIncidentCount: openCount,
      activeIncidentCount: openCount
    },
    services: serviceList,
    incidents
  };
}

function renderMediaHealthPage() {
  return renderOperationsOverview(mediaOnlyOperationsSnapshot(), []);
}

function mediaRecordById(id) {
  const media = mediaSnapshotForUi();
  return media.all.find((item) => item.id === id) || null;
}

function configuredMediaConnection(serviceId) {
  const connection = state.config?.services?.find((service) => (
    service.id === serviceId
    && service.configured !== false
    && service.enabled !== false
    && service.monitoringEnabled !== false
  )) || null;
  return actionEvidenceIsCurrent(healthForService(serviceId), connection?.targetRevision)
    ? connection
    : null;
}

function mediaControlActions(item) {
  if (!item) return [];
  if (isMediaCollection(item, "requests")
    && mediaRequestState(item) === "failed"
    && /^[1-9][0-9]{0,9}$/u.test(String(item.requestId || ""))
    && configuredMediaConnection("seerr")?.targetRevision) {
    return [{
      serviceId: "seerr",
      operation: "retryRequest",
      resourceId: String(item.requestId),
      label: "Retry failed request",
      copy: "Ask Seerr to retry this failed request."
    }];
  }
  if (item.available || item.downloading || !item.monitored) return [];
  const serviceId = item.mediaType === "movie" ? "radarr" : ["series", "episode"].includes(item.mediaType) ? "sonarr" : "";
  const target = item.actionTargets.find((entry) => entry.service === serviceId);
  if (!target || !configuredMediaConnection(serviceId)?.targetRevision) return [];
  return [{
    serviceId,
    operation: serviceId === "radarr" ? "searchMovie" : "searchSeries",
    resourceId: target.resourceId,
    label: "Search again",
    copy: `Run a targeted ${serviceId === "radarr" ? "Radarr movie" : "Sonarr series"} search.`
  }];
}

function renderMediaControlSection(item) {
  const actions = mediaControlActions(item);
  if (!actions.length) return "";
  return `<section class="drawer-section control-section"><header class="section-heading"><div><h3>Available actions</h3><p>Helmsman sends only the confirmed command shown below.</p></div></header><div class="control-action-list">${actions.map((action) => {
    const key = `media:${action.serviceId}:${action.operation}:${action.resourceId}`;
    const busy = state.actionMutation === key;
    const awaitingRefresh = state.actionAwaitingRefresh === key;
    return `<div class="control-action-row"><span><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(action.copy)}</small></span><button class="button button--primary" type="button" data-action="run-media-control" data-media-id="${escapeHtml(item.id)}" data-control-service="${escapeHtml(action.serviceId)}" data-control-operation="${escapeHtml(action.operation)}" data-control-resource-id="${escapeHtml(action.resourceId)}" data-control-key="${escapeHtml(key)}" ${state.actionMutation ? "disabled" : ""} ${busy && !awaitingRefresh ? "aria-busy=\"true\"" : ""}>${awaitingRefresh ? `${icon("refresh")} Refresh required` : busy ? `${icon("refresh")} Working…` : action.label}</button></div>`;
  }).join("")}</div></section>`;
}

function renderMediaDetailDrawer(item) {
  const providerEntries = Object.entries(item.providerIds);
  const requestItem = isMediaCollection(item, "requests");
  const stage = requestItem ? mediaRequestJourneyStage(item) : mediaStage(item);
  const stageIndex = MEDIA_LIFECYCLE_STEPS.findIndex(({ id }) => id === stage);
  const hasIssue = item.error || requestItem && mediaRequestBucket(item) === "attention";
  const kicker = requestItem
    ? `${mediaRequestScopeLabel(item)} · ${mediaRequestStateLabel(item)}`
    : `${mediaTypeLabel(item.mediaType)}${item.year ? ` · ${item.year}` : ""}`;
  return `<aside class="title-drawer" role="dialog" aria-modal="true" aria-labelledby="media-drawer-title">
    <button class="icon-button drawer-close" type="button" data-action="close-media-drawer" aria-label="Close media details">${icon("x")}</button>
    <div class="drawer-visual">${renderArtworkImage(item, { className: "hero-art-image", eager: true })}<div class="hero-shade"></div><span class="drawer-poster poster-art">${renderArtworkImage(item, { eager: true, priority: "auto" })}<span class="poster-monogram" aria-hidden="true">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span></span></div>
    <div class="drawer-body"><div class="drawer-title-row"><div><span class="drawer-kicker">${escapeHtml(kicker)}</span><h2 id="media-drawer-title" tabindex="-1">${escapeHtml(item.title)}</h2><span class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</span></div></div><p class="drawer-summary">${escapeHtml(item.summary || item.error || "Helmsman matched this record across the connected media stack using provider identifiers.")}</p>${providerEntries.length ? `<div class="genre-row">${providerEntries.map(([provider, id]) => `<span>${escapeHtml(provider)} · ${escapeHtml(id)}</span>`).join("")}</div>` : ""}
      <section class="drawer-section"><header class="section-heading"><div><h3>Lifecycle</h3><p>Requested → monitored → downloading → imported → available</p></div></header><ol class="pipeline-steps">${MEDIA_LIFECYCLE_STEPS.map((step, index) => `<li class="${hasIssue && index === stageIndex ? "has-issue" : index < stageIndex ? "is-done" : index === stageIndex ? "is-current" : ""}"><span>${index < stageIndex ? icon("check") : index + 1}</span><div><strong>${escapeHtml(step.label)}</strong><small>${index === stageIndex ? escapeHtml(item.error || (requestItem ? mediaStatusLabel(item) : "Current")) : index < stageIndex ? "Complete" : "Waiting"}</small></div></li>`).join("")}</ol>${item.progress === null ? "" : `<div class="drawer-live-progress"><progress data-media-progress value="${item.progress}" max="100">${item.progress}%</progress><span data-media-progress-label>${item.progress}%</span><span data-media-speed>${escapeHtml(formatMediaSpeed(item.downloadSpeedBps))}</span><span data-media-eta>${escapeHtml(formatMediaEta(item.etaSeconds))}</span></div>`}</section>
      ${renderMediaControlSection(item)}
      <section class="drawer-section"><header class="section-heading"><div><h3>Connected sources</h3><p>Credentials remain server-side.</p></div></header><div class="source-list">${item.sources.length ? item.sources.map((source) => { const configured = state.config?.services?.some((service) => service.id === source.service); return configured ? `<button class="source-row" type="button" data-action="open-service" data-service-id="${escapeHtml(source.service)}">${serviceIconMarkup(source.service, source.label.slice(0, 1))}<span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.detail || source.state || "Matched source")}</small></span>${icon("chevron")}</button>` : `<article class="source-row">${serviceIconMarkup(source.service, source.label.slice(0, 1))}<span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.detail || source.state || "Matched source")}</small></span></article>`; }).join("") : `<div class="empty-state"><p>No source details were returned for this record.</p></div>`}</div></section>
    </div>
  </aside>`;
}

function openMediaDrawer(mediaId) {
  const item = mediaRecordById(mediaId);
  if (!item || !drawerLayer) return;
  state.media.drawerReturnFocus = focusReference(document.activeElement);
  state.media.selectedId = item.id;
  setMarkup(drawerLayer, `<div class="drawer-backdrop" data-action="close-media-drawer"></div>${renderMediaDetailDrawer(item)}`);
  drawerLayer.classList.add("is-open");
  drawerLayer.setAttribute("aria-hidden", "false");
  if (appShell) appShell.inert = true;
  document.body.classList.add("has-overlay");
  requestAnimationFrame(() => drawerLayer.querySelector(".drawer-close")?.focus());
}

function closeMediaDrawer({ restoreFocus = true } = {}) {
  if (!drawerLayer) return;
  closeControlConfirmation(false, { restoreFocus: false });
  drawerLayer.classList.remove("is-open");
  drawerLayer.setAttribute("aria-hidden", "true");
  if (appShell && !modalLayer?.classList.contains("is-open")) appShell.inert = false;
  if (!modalLayer?.classList.contains("is-open")) document.body.classList.remove("has-overlay");
  setMarkup(drawerLayer, "");
  const returnFocus = state.media.drawerReturnFocus;
  state.media.drawerReturnFocus = null;
  state.media.selectedId = "";
  if (restoreFocus) restoreFocusReference(returnFocus, main);
}

function renderIncidentsPage() {
  const snapshot = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  const open = snapshot.incidents.filter(({ scope }) => scope === "infrastructure");
  const recovered = snapshot.recentRecoveries.filter(({ scope }) => scope === "infrastructure");
  return `
    <section class="detail-page">
      <header class="detail-hero"><div><span class="section-kicker">Incident center</span><h2>${open.length ? `${open.length} active ${open.length === 1 ? "incident" : "incidents"}` : "No active incidents"}</h2><p>Repeated failures are grouped so one noisy endpoint does not flood the log.</p></div><button class="button" data-action="refresh-live">${icon("refresh")} Check now</button></header>
      <div class="detail-grid incident-grid">
        <section class="glass-panel"><header><div><span class="section-kicker">Open</span><h3>Needs attention</h3></div><span class="count-pill">${open.length}</span></header>
          <div class="incident-table">${open.length ? open.map((entry) => `
            <article class="incident-row">
              <span class="health-dot is-${statusClass(entry.state)}"></span>
              <div class="incident-row__copy"><strong>${escapeHtml(entry.serviceName)} · ${escapeHtml(entry.capability)}</strong><p>${escapeHtml(entry.summary)}</p><small>${escapeHtml(entry.code || statusLabel(entry.state))}${entry.status ? ` · HTTP ${entry.status}` : ""} · ${entry.occurrenceCount} occurrence${entry.occurrenceCount === 1 ? "" : "s"}</small>${renderOperationsReports(entry.reports, entry.serviceName)}<p class="operations-next-step"><strong>Next step</strong><span>${escapeHtml(incidentNextStep(entry))}</span></p></div>
              <time>${escapeHtml(formatTime(entry.lastSeen))}</time>
            </article>`).join("") : `<div class="empty-state">${icon("check")}<strong>Everything is clear</strong><span>The two-check debounce has not confirmed any active failures.</span></div>`}</div>
        </section>
        <section class="glass-panel"><header><div><span class="section-kicker">Recovered</span><h3>Recent recoveries</h3></div><span class="count-pill">${recovered.length}</span></header>
          <div class="incident-table">${recovered.length ? recovered.map((entry) => `
            <article class="incident-row"><span class="health-dot is-healthy"></span><div><strong>${escapeHtml(entry.serviceName)} · ${escapeHtml(entry.capability)}</strong><p>Recovered from ${escapeHtml(statusLabel(entry.previousState).toLowerCase())}.</p><small>${entry.occurrenceCount} recorded occurrence${entry.occurrenceCount === 1 ? "" : "s"}</small></div><time>${escapeHtml(formatTime(entry.recoveredAt))}</time></article>`).join("") : `<div class="empty-state">${icon("check")}<strong>No recent recoveries</strong><span>No recoveries have been recorded yet.</span></div>`}</div>
        </section>
      </div>
    </section>`;
}

function renderPipelinePage() {
  const snapshot = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  return `
    <section class="detail-page">
      <header class="detail-hero"><div><span class="section-kicker">End-to-end flow</span><h2>Media pipeline</h2><p>Health follows the path from request through search, download, import, library, and subtitles.</p></div></header>
      <section class="pipeline-board">${snapshot.pipeline.length ? snapshot.pipeline.map((stage, index) => `
        <article class="pipeline-card is-${statusClass(stage.state)}">
          <span class="pipeline-card__index">${String(index + 1).padStart(2, "0")}</span>
          <span class="health-dot is-${statusClass(stage.state)}"></span>
          <div><small>${escapeHtml(stage.hint)}</small><h3>${escapeHtml(stage.label)}</h3><p>${escapeHtml(stage.detail || statusLabel(stage.state))}</p></div>
          ${stage.count === null ? "" : `<strong>${stage.count}</strong>`}
        </article>`).join("") : `<div class="empty-state"><span>The pipeline appears after configured services finish their first check.</span></div>`}</section>
    </section>`;
}

function healthForService(id) {
  const services = Array.isArray(state.snapshot?.services) ? state.snapshot.services : [];
  return services.find((service) => service.id === id) || null;
}

function reportsForService(id) {
  const service = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets).services.find((entry) => entry.id === id);
  return service?.capabilities.flatMap((capability) => capability.reports).slice(0, 12) || [];
}

function reportFingerprint(reports) {
  return JSON.stringify(reports.map(({ severity, source, message }) => [severity, source, message]));
}

function renderConnectionCategory({ id, index, kicker, title, description, summary, action = "", content }) {
  const headingId = `${id}-connection-category-title`;
  return `<section class="glass-panel connection-category" data-connection-category="${escapeHtml(id)}" aria-labelledby="${escapeHtml(headingId)}">
    <header class="connection-category__header">
      <span class="connection-category__index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
      <div class="connection-category__copy"><span class="section-kicker">${escapeHtml(kicker)}</span><h3 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>
      <div class="connection-category__actions"><span class="connection-category__summary">${escapeHtml(summary)}</span>${action}</div>
    </header>
    <div class="connection-category__body">${content}</div>
  </section>`;
}

function renderMediaConnectionCard(service) {
  const health = healthForService(service.id);
  const healthState = service.monitoringEnabled === false
    ? "disabled"
    : health ? savedMonitorTone(health) : service.configured ? "stale" : "disabled";
  const healthLabel = service.monitoringEnabled === false
    ? "Disabled"
    : health ? savedMonitorLabel(health) : service.configured ? "Waiting for data" : "Set up";
  return `<button class="service-card-v5" type="button" data-action="open-service" data-service-id="${escapeHtml(service.id)}">
    <span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.role)}</small><code>${escapeHtml(service.configured ? service.url : "Not configured")}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-${statusClass(healthState)}"></i><b>${escapeHtml(healthLabel)}</b><small>${service.credentialConfigured ? "Credential saved" : "No credential"}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderServicesPage() {
  const services = [...(state.config?.services || [])]
    .filter((service) => !/^(?:proxmox|portainer)(?:-|$)/u.test(String(service?.id || "").toLowerCase()))
    .sort((a, b) => SERVICE_ORDER.indexOf(a.id) - SERVICE_ORDER.indexOf(b.id));
  const knownServiceIds = new Set(MEDIA_CONNECTION_CATEGORIES.flatMap(({ services: serviceIds }) => serviceIds));
  const categories = MEDIA_CONNECTION_CATEGORIES.map((category) => ({
    ...category,
    items: category.services.flatMap((serviceId) => services.filter((service) => service.id === serviceId))
  })).filter(({ items }) => items.length);
  const otherServices = services.filter((service) => !knownServiceIds.has(service.id));
  if (otherServices.length) {
    categories.push({
      id: "other-services",
      kicker: "Additional integrations",
      title: "Other services",
      description: "Additional service definitions supported by this Helmsman build.",
      items: otherServices
    });
  }
  return `
    <section class="detail-page connections-page media-connections-page">
      <header class="detail-hero"><div><span class="section-kicker">Media integrations</span><h2>Connections</h2><p>Browse integrations by role, then configure service endpoints and protected credentials. Routine monitoring remains read-only; only the explicit confirmed recovery actions shown in a title's details can make changes.</p></div></header>
      <div class="connection-category-list">${categories.map((category, index) => renderConnectionCategory({
        id: category.id,
        index,
        kicker: category.kicker,
        title: category.title,
        description: category.description,
        summary: `${category.items.filter(({ configured }) => configured).length} / ${category.items.length} configured`,
        content: `<div class="service-grid-v5">${category.items.map(renderMediaConnectionCard).join("")}</div>`
      })).join("")}</div>
    </section>`;
}

function safeLogEntriesForSnapshot(value) {
  const snapshot = value || {};
  const transitions = Array.isArray(snapshot.recentTransitions) ? snapshot.recentTransitions : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  return [...events, ...transitions].slice(0, 200);
}

function safeLogEntries() {
  return safeLogEntriesForSnapshot(state.snapshot);
}

function safeLogCode(value) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : "";
}

function safeLogHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function logServiceDisplayName(value) {
  const serviceId = String(value || "").toLowerCase();
  if (!serviceId) return "";
  const infrastructureId = serviceId.startsWith("proxmox-") ? serviceId.slice("proxmox-".length) : serviceId;
  const infrastructure = state.infrastructure.targets.find((target) => target.id === infrastructureId);
  if (infrastructure) return infrastructure.displayName;
  const portainerId = serviceId.startsWith("portainer-") ? serviceId.slice("portainer-".length) : serviceId;
  const portainer = normalizedPortainerConfigurations().find((service) => service.id === portainerId);
  if (portainer) return portainer.displayName;
  const media = state.config?.services?.find((service) => service.id === serviceId);
  return safeSessionText(media?.name || value, "Service", 100);
}

function renderLogsPage() {
  const entries = safeLogEntries();
  return `
    <section class="detail-page">
      <header class="detail-hero"><div><span class="section-kicker">Sanitized event stream</span><h2>Application logs</h2><p>Only bounded operational metadata is retained here—never credentials, authorization headers, or upstream response bodies.</p></div></header>
      <section class="glass-panel log-panel-v5"><header><div><span class="section-kicker">Newest first</span><h3>Container events</h3></div><span class="count-pill">${entries.length}</span></header>
        <div class="log-list-v5">${entries.length ? entries.map((entry) => {
          const candidateLevel = String(entry.level || (entry.type === "recovered" ? "info" : "warn")).toLowerCase();
          const level = ["debug", "info", "warn", "warning", "error"].includes(candidateLevel) ? candidateLevel : "warn";
          const status = safeLogHttpStatus(entry.httpStatus ?? entry.status);
          const evidence = [
            logServiceDisplayName(entry.service),
            mediaText(entry.capability, "", 80),
            safeLogCode(entry.code),
            status === null ? "" : `HTTP ${status}`
          ].filter(Boolean).join(" · ");
          return `<article><time>${escapeHtml(formatTime(entry.at || entry.createdAt || entry.lastSeen || state.snapshot?.generatedAt))}</time><span class="log-level is-${escapeHtml(level)}">${escapeHtml(level)}</span><div><strong>${escapeHtml(mediaText(entry.summary || entry.type || entry.code, "Monitor event", 240))}</strong><small>${escapeHtml(evidence)}</small></div></article>`;
        }).join("") : `<div class="empty-state"><span>No monitor events have been recorded yet.</span></div>`}</div>
      </section>
    </section>`;
}

function safeSessionText(value, fallback, maximum = 120) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return (text || fallback).slice(0, maximum);
}

function normalizedInfrastructureTargets(payload) {
  const rawTargets = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.environments)
      ? payload.environments
      : Array.isArray(payload?.infrastructureEnvironments)
        ? payload.infrastructureEnvironments
        : Array.isArray(payload?.targets)
          ? payload.targets
      : Array.isArray(payload?.infrastructureTargets)
        ? payload.infrastructureTargets
        : [];
  const seen = new Set();
  return rawTargets.slice(0, 64).flatMap((rawTarget) => {
    if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return [];
    const id = String(rawTarget.id || "").toLowerCase();
    if (!INFRASTRUCTURE_ID_PATTERN.test(id) || seen.has(id)) return [];
    seen.add(id);
    const tlsMode = rawTarget.tlsMode === "pinned" ? "pinned" : "system";
    const fingerprint = typeof rawTarget.certificateFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test(rawTarget.certificateFingerprint.toLowerCase())
      ? rawTarget.certificateFingerprint.toLowerCase()
      : "";
    const interval = Number(rawTarget.monitoringIntervalSeconds);
    const endpointIds = new Set();
    const endpoints = (Array.isArray(rawTarget.endpoints) ? rawTarget.endpoints : []).slice(0, 25).flatMap((rawEndpoint, endpointIndex) => {
      if (!rawEndpoint || typeof rawEndpoint !== "object" || Array.isArray(rawEndpoint)) return [];
      const endpointId = String(rawEndpoint.id || "").toLowerCase();
      if (!INFRASTRUCTURE_ID_PATTERN.test(endpointId) || endpointIds.has(endpointId)) return [];
      endpointIds.add(endpointId);
      const endpointTlsMode = rawEndpoint.tlsMode === "pinned" ? "pinned" : "system";
      const endpointFingerprint = typeof rawEndpoint.certificateFingerprint === "string"
        && /^[a-f0-9]{64}$/u.test(rawEndpoint.certificateFingerprint.toLowerCase())
        ? rawEndpoint.certificateFingerprint.toLowerCase()
        : "";
      return [{
        id: endpointId,
        label: safeSessionText(rawEndpoint.label, endpointIndex ? `Endpoint ${endpointIndex + 1}` : "Primary endpoint", 80),
        url: safeSessionText(rawEndpoint.url, "", 500),
        enabled: rawEndpoint.enabled !== false,
        primary: rawEndpoint.primary === true,
        tlsMode: endpointTlsMode,
        certificateFingerprint: endpointTlsMode === "pinned" ? endpointFingerprint : "",
        targetRevision: safeSessionText(rawEndpoint.targetRevision, "", 100),
        credentialConfigured: rawEndpoint.credentialConfigured === true,
        credentialUpdatedAt: safeSessionText(rawEndpoint.credentialUpdatedAt, "", 40)
      }];
    });
    const primaryEndpointId = INFRASTRUCTURE_ID_PATTERN.test(String(rawTarget.primaryEndpointId || "").toLowerCase())
      ? String(rawTarget.primaryEndpointId).toLowerCase()
      : id;
    const normalizedEndpoints = endpoints.length ? endpoints : [{
      id,
      label: "Primary endpoint",
      url: safeSessionText(rawTarget.url, "", 500),
      enabled: true,
      primary: true,
      tlsMode,
      certificateFingerprint: tlsMode === "pinned" ? fingerprint : "",
      targetRevision: safeSessionText(rawTarget.targetRevision, "", 100),
      credentialConfigured: rawTarget.credentialConfigured === true,
      credentialUpdatedAt: safeSessionText(rawTarget.credentialUpdatedAt, "", 40)
    }];
    for (const endpoint of normalizedEndpoints) endpoint.primary = endpoint.id === primaryEndpointId;
    return [{
      id,
      type: rawTarget.type === "proxmox" ? "proxmox" : "proxmox",
      typeName: safeSessionText(rawTarget.typeName, "Proxmox VE", 80),
      role: safeSessionText(rawTarget.role, "Virtualization", 80),
      displayName: safeSessionText(rawTarget.displayName, "Proxmox", 80),
      url: safeSessionText(rawTarget.url, "", 500),
      enabled: rawTarget.enabled !== false,
      monitoringEnabled: rawTarget.monitoringEnabled !== false,
      monitoringIntervalSeconds: Number.isSafeInteger(interval) && interval >= 30 && interval <= 3600 ? interval : 60,
      tlsMode,
      certificateFingerprint: tlsMode === "pinned" ? fingerprint : "",
      targetRevision: safeSessionText(rawTarget.targetRevision, "", 100),
      credentialConfigured: rawTarget.credentialConfigured === true,
      credentialUpdatedAt: safeSessionText(rawTarget.credentialUpdatedAt, "", 40),
      environmentKind: ["cluster", "standalone"].includes(rawTarget.environmentKind) ? rawTarget.environmentKind : "unknown",
      environmentName: safeSessionText(rawTarget.environmentName, rawTarget.displayName || "Proxmox", 80),
      clusterName: safeSessionText(rawTarget.clusterName, "", 80),
      primaryEndpointId,
      endpoints: normalizedEndpoints
    }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}

function infrastructureTargetById(targetId) {
  return state.infrastructure.targets.find((target) => target.id === targetId) || null;
}

function infrastructureHealth() {
  return normalizeInfrastructureSnapshot(snapshotForUi(), state.infrastructure.targets);
}

function infrastructureHealthForTarget(targetId) {
  return infrastructureHealth().targets.find((target) => target.id === targetId) || null;
}

const PORTAINER_CONTAINER_STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead", "unknown"]);
const PORTAINER_ENVIRONMENT_STATES = new Set(["up", "down", "provisioning", "error", "unknown"]);

function safePortainerInteger(value, fallback = null, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number"
    && !(typeof value === "string" && /^\d+$/u.test(value.trim()))) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : fallback;
}

function safePortainerTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizedPortainerConfigurations() {
  const source = Array.isArray(state.config?.infrastructureServices)
    ? state.config.infrastructureServices
    : [];
  const seen = new Set();
  return source.slice(0, 8).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = String(raw.id || "").toLowerCase();
    if (!INFRASTRUCTURE_ID_PATTERN.test(id) || seen.has(id) || raw.type !== "portainer") return [];
    seen.add(id);
    const tlsMode = raw.tlsMode === "pinned" ? "pinned" : "system";
    const fingerprint = typeof raw.certificateFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test(raw.certificateFingerprint.toLowerCase())
      ? raw.certificateFingerprint.toLowerCase()
      : "";
    return [{
      id,
      type: "portainer",
      typeName: safeSessionText(raw.typeName, "Portainer", 80),
      role: safeSessionText(raw.role, "Container management", 80),
      displayName: safeSessionText(raw.displayName, "Portainer", 80),
      url: safeSessionText(raw.url, "", 500),
      enabled: raw.enabled !== false,
      monitoringEnabled: raw.monitoringEnabled !== false,
      tlsMode,
      certificateFingerprint: tlsMode === "pinned" ? fingerprint : "",
      targetRevision: safeSessionText(raw.targetRevision, "", 100),
      credentialConfigured: raw.credentialConfigured === true,
      credentialUpdatedAt: safeSessionText(raw.credentialUpdatedAt, "", 40)
    }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}

function normalizedPortainerInventory(value, serverId, serverName) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const environmentIds = new Set();
  const environments = (Array.isArray(source.environments) ? source.environments : []).slice(0, 500).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = safePortainerInteger(raw.id, null, 2_147_483_647);
    if (id === null || id < 1 || environmentIds.has(id)) return [];
    environmentIds.add(id);
    const rawState = String(raw.state || "unknown").toLowerCase();
    const environmentState = PORTAINER_ENVIRONMENT_STATES.has(rawState) ? rawState : "unknown";
    const platform = ["Docker", "Podman", "Kubernetes", "Azure", "Unknown"].includes(raw.platform)
      ? raw.platform
      : "Unknown";
    return [{
      key: `${serverId}:${id}`,
      id,
      serverId,
      serverName,
      name: safeSessionText(raw.name, `Environment ${id}`, 96),
      state: environmentState,
      platform,
      containerCapable: raw.containerCapable === true,
      edge: raw.edge === true,
      agentVersion: safeSessionText(raw.agentVersion, "", 64)
    }];
  });
  const environmentById = new Map(environments.map((entry) => [entry.id, entry]));
  const containers = (Array.isArray(source.containers) ? source.containers : []).slice(0, 5_000).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = String(raw.id || "").toLowerCase();
    const environmentId = safePortainerInteger(raw.environmentId, null, 2_147_483_647);
    if (!/^[a-f0-9]{12,64}$/u.test(id) || environmentId === null || !environmentById.has(environmentId)) return [];
    const rawState = String(raw.state || "unknown").toLowerCase();
    const containerState = PORTAINER_CONTAINER_STATES.has(rawState) ? rawState : "unknown";
    const status = safeSessionText(raw.status, containerState, 180);
    const reportedHealth = ["healthy", "unhealthy", "informational"].includes(raw.health) ? raw.health : "";
    const health = reportedHealth || (["dead", "restarting"].includes(containerState) || /\bunhealthy\b/iu.test(status)
      ? "unhealthy"
      : containerState === "running" ? "healthy" : "informational");
    const environment = environmentById.get(environmentId);
    const ports = (Array.isArray(raw.ports) ? raw.ports : []).slice(0, 32).flatMap((port) => {
      if (!port || typeof port !== "object" || Array.isArray(port)) return [];
      const privatePort = safePortainerInteger(port.privatePort, null, 65_535);
      const publicPort = safePortainerInteger(port.publicPort, null, 65_535);
      const protocol = ["tcp", "udp", "sctp"].includes(port.protocol) ? port.protocol : "tcp";
      return privatePort && privatePort >= 1 ? [{ privatePort, publicPort: publicPort && publicPort >= 1 ? publicPort : null, protocol }] : [];
    });
    return [{
      key: `${serverId}:${environmentId}:${id}`,
      id,
      shortId: id.slice(0, 12),
      serverId,
      serverName,
      name: safeSessionText(raw.name, id.slice(0, 12), 128),
      image: safeSessionText(raw.image, "Unknown image", 220),
      environmentId,
      environmentName: environment.name,
      state: containerState,
      status,
      health,
      stack: safeSessionText(raw.stack, "", 96),
      createdAt: safePortainerTime(raw.createdAt),
      ports
    }];
  });
  const stackIds = new Set();
  const stacks = (Array.isArray(source.stacks) ? source.stacks : []).slice(0, 1_000).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = safePortainerInteger(raw.id, null, 2_147_483_647);
    if (id === null || id < 1 || stackIds.has(id)) return [];
    stackIds.add(id);
    const environmentId = safePortainerInteger(raw.environmentId, null, 2_147_483_647);
    const rawState = String(raw.state || "unknown").toLowerCase();
    const stackState = ["active", "inactive", "unknown"].includes(rawState) ? rawState : "unknown";
    return [{
      key: `${serverId}:${id}`,
      id,
      serverId,
      serverName,
      name: safeSessionText(raw.name, `Stack ${id}`, 128),
      state: stackState,
      type: safePortainerInteger(raw.type, null, 9),
      environmentId,
      environmentName: environmentId === null ? "Unassigned" : environmentById.get(environmentId)?.name || `Environment ${environmentId}`,
      createdAt: safePortainerTime(raw.createdAt),
      updatedAt: safePortainerTime(raw.updatedAt)
    }];
  });
  return { environments, containers, stacks };
}

function normalizePortainerService(raw, configured = null) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const id = String(source.id || configured?.id || "").toLowerCase();
  const displayName = configured?.displayName || safeSessionText(source.displayName, "Portainer", 80);
  const capabilities = normalizedTestChecks({ service: "portainer", capabilities: source.capabilities || source.checks });
  const reports = normalizeOperationsReports(source.reports, `${displayName} health`);
  const inventory = normalizedPortainerInventory(source.inventory, id, displayName);
  const configuredState = configured && (!configured.enabled || !configured.monitoringEnabled) ? "disabled" : "";
  const suppliedState = statusClass(source.state);
  const connection = String(source.connectionState || "").toLowerCase().replaceAll("-", "_");
  return {
    ...(configured || {}),
    id,
    type: "portainer",
    typeName: configured?.typeName || "Portainer",
    role: configured?.role || "Container management",
    displayName,
    url: configured?.url || "",
    enabled: configured?.enabled ?? true,
    monitoringEnabled: configured?.monitoringEnabled ?? true,
    tlsMode: configured?.tlsMode || "system",
    certificateFingerprint: configured?.certificateFingerprint || "",
    credentialConfigured: configured?.credentialConfigured ?? false,
    targetRevision: safeSessionText(source.targetRevision, configured?.targetRevision || "", 100),
    state: configuredState || (Object.keys(source).length ? suppliedState : "stale"),
    connectionState: ["connected", "auth_required", "unverified", "down"].includes(connection) ? connection : "unverified",
    version: safeSessionText(source.version, "", 80).replace(/^v/iu, ""),
    checkedAt: safePortainerTime(source.checkedAt || source.lastCheckedAt),
    latencyMs: safeCheckLatency(source.latencyMs),
    capabilities,
    reports,
    inventory,
    metrics: {
      environmentTotal: inventory.environments.length,
      environmentOnline: inventory.environments.filter(({ state: environmentState }) => environmentState === "up").length,
      environmentOffline: inventory.environments.filter(({ state: environmentState }) => ["down", "error"].includes(environmentState)).length,
      containerTotal: inventory.containers.length,
      containerRunning: inventory.containers.filter(({ state: containerState }) => containerState === "running").length,
      containerStopped: inventory.containers.filter(({ state: containerState }) => ["created", "exited"].includes(containerState)).length,
      containerUnhealthy: inventory.containers.filter(({ health: containerHealth }) => containerHealth === "unhealthy").length,
      containerRestarting: inventory.containers.filter(({ state: containerState }) => containerState === "restarting").length,
      stackTotal: inventory.stacks.length
    }
  };
}

function portainerServicesForSnapshot(value) {
  const configured = normalizedPortainerConfigurations();
  const rawServices = Array.isArray(value?.infrastructure?.services)
    ? value.infrastructure.services.slice(0, 8)
    : [];
  const healthById = new Map(rawServices.flatMap((entry) => {
    const id = String(entry?.id || "").toLowerCase();
    return INFRASTRUCTURE_ID_PATTERN.test(id) && entry?.type === "portainer" ? [[id, entry]] : [];
  }));
  const output = configured.map((service) => {
    const health = healthById.get(service.id);
    healthById.delete(service.id);
    return normalizePortainerService(health, service);
  });
  for (const [id, health] of healthById) {
    output.push(normalizePortainerService({ ...health, id }, null));
  }
  return output.sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}

function portainerServicesForUi() {
  return portainerServicesForSnapshot(state.snapshot);
}

function portainerServiceById(serviceId) {
  return normalizedPortainerConfigurations().find(({ id }) => id === serviceId) || null;
}

function portainerHealthById(serviceId) {
  return portainerServicesForUi().find(({ id }) => id === serviceId) || null;
}

function configuredInfrastructureTargetsForUi() {
  const configuredIds = new Set(state.infrastructure.targets.map(({ id }) => id));
  return infrastructureHealth().targets.filter(({ id }) => configuredIds.has(id));
}

function configuredInfrastructureSnapshotForUi() {
  const snapshot = infrastructureHealth();
  const configuredIds = new Set(state.infrastructure.targets.map(({ id }) => id));
  return infrastructureSnapshotForTargets(
    snapshot,
    snapshot.targets.filter(({ id }) => configuredIds.has(id))
  );
}

function configuredPortainerServicesForUi() {
  const configuredIds = new Set(normalizedPortainerConfigurations().map(({ id }) => id));
  return portainerServicesForUi().filter(({ id }) => configuredIds.has(id));
}

function proxmoxConnectorLabel(target) {
  if (!target.enabled || !target.monitoringEnabled) return "Disabled";
  if (target.connectionState === "connected") return `Connected · ${statusLabel(target.state)}`;
  if (target.connectionState === "auth_required") return "Authentication required";
  if (target.connectionState === "down") return "Connection unavailable";
  return target.credentialConfigured ? "Waiting for verification" : "API token required";
}

function renderProxmoxConnectorCard(target) {
  const environment = target.environmentKind === "cluster"
    ? target.clusterName || target.environmentName || "Cluster discovery pending"
    : target.environmentName || "Standalone discovery pending";
  return `<button class="service-card-v5 infrastructure-card" type="button" data-action="open-infrastructure-target" data-infrastructure-target-id="${escapeHtml(target.id)}" data-connector-provider="proxmox">
    <span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("proxmox", "P")}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(target.displayName)}</strong><small>Proxmox VE · ${escapeHtml(target.environmentKind === "cluster" ? "Cluster" : target.environmentKind === "standalone" ? "Standalone server" : "Discovery pending")}</small><code>${escapeHtml(target.url || environment)}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-${statusClass(target.state)}"></i><b>${escapeHtml(proxmoxConnectorLabel(target))}</b><small>${target.credentialConfigured ? "API token protected" : "No API token"}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderPortainerConnectorCard(service) {
  return `<button class="service-card-v5 infrastructure-card" type="button" data-action="open-portainer-service" data-portainer-service-id="${escapeHtml(service.id)}" data-connector-provider="portainer">
    <span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("portainer", "P")}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(service.displayName)}</strong><small>${escapeHtml(service.typeName)} · ${escapeHtml(service.role)}</small><code>${escapeHtml(service.url || "Connection address unavailable")}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-${statusClass(service.state)}"></i><b>${escapeHtml(portainerConnectionLabel(service))}</b><small>${service.credentialConfigured ? "Access token protected" : "No access token"}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderAvailableInfrastructureConnector({ provider, name, role, detail, action, actionLabel }) {
  return `<button class="service-card-v5 infrastructure-card connector-card--available" type="button" data-action="${escapeHtml(action)}" data-connector-provider="${escapeHtml(provider)}">
    <span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup(provider, name.slice(0, 1))}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role)}</small><code>${escapeHtml(detail)}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-disabled"></i><b>Available</b><small>${escapeHtml(actionLabel)}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderInfrastructureConnectorsPage() {
  const proxmoxTargets = configuredInfrastructureTargetsForUi();
  const portainerServices = configuredPortainerServicesForUi();
  const configuredCount = proxmoxTargets.length + portainerServices.length;
  const proxmoxAction = proxmoxTargets.length
    ? `<button class="button button--compact" type="button" data-action="open-infrastructure-target">${icon("plus")} Add environment</button>`
    : "";
  const portainerAction = portainerServices.length
    ? `<button class="button button--compact" type="button" data-action="open-portainer-service">${icon("plus")} Add server</button>`
    : "";
  const proxmoxContent = proxmoxTargets.length
    ? proxmoxTargets.map(renderProxmoxConnectorCard).join("")
    : renderAvailableInfrastructureConnector({
        provider: "proxmox",
        name: "Proxmox VE",
        role: "Virtualization and cluster inventory",
        detail: "No environments configured",
        action: "open-infrastructure-target",
        actionLabel: "Connect with a scoped API token"
      });
  const portainerContent = portainerServices.length
    ? portainerServices.map(renderPortainerConnectorCard).join("")
    : renderAvailableInfrastructureConnector({
        provider: "portainer",
        name: "Portainer",
        role: "Container platform inventory",
        detail: "No servers configured",
        action: "open-portainer-service",
        actionLabel: "Connect with a scoped access token"
      });
  const categories = [
    {
      id: "virtualization",
      kicker: "Virtualization",
      title: "Proxmox VE",
      description: "Discover standalone servers or clusters, inventory them, and use confirmed guest power controls.",
      summary: `${proxmoxTargets.length} configured`,
      action: proxmoxAction,
      content: `<div class="service-grid-v5 infrastructure-target-grid">${proxmoxContent}</div>`
    },
    {
      id: "container-management",
      kicker: "Container management",
      title: "Portainer",
      description: "Inventory permitted environments, containers, and stacks, with confirmed lifecycle controls.",
      summary: `${portainerServices.length} configured`,
      action: portainerAction,
      content: `<div class="service-grid-v5 infrastructure-target-grid">${portainerContent}</div>`
    }
  ];
  return `<section class="detail-page connections-page infrastructure-connections-page" id="infrastructure-connectors">
    <header class="detail-hero"><div><span class="section-kicker">Infrastructure catalog</span><h2>Connectors</h2><p>See every infrastructure integration this Helmsman build supports. Configured connections show their current state; available connectors open a guarded setup flow.</p></div><span class="connector-total"><strong>${configuredCount}</strong><small>configured connection${configuredCount === 1 ? "" : "s"}</small></span></header>
    <div class="connection-category-list">${categories.map((category, index) => renderConnectionCategory({ ...category, index })).join("")}</div>
  </section>`;
}

function normalizedSessionList(payload) {
  const currentSessionId = typeof payload?.currentSessionId === "string"
    && SESSION_ID_PATTERN.test(payload.currentSessionId)
    ? payload.currentSessionId
    : "";
  const seen = new Set();
  const items = (Array.isArray(payload?.sessions) ? payload.sessions : []).slice(0, 64).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = typeof entry.id === "string" && SESSION_ID_PATTERN.test(entry.id) ? entry.id : "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: safeSessionText(entry.name, "Unnamed browser", 80),
      origin: safeSessionText(entry.origin, "Unknown origin", 180),
      createdAt: safeSessionText(entry.createdAt, "", 40),
      expiresAt: safeSessionText(entry.expiresAt, "", 40)
    }];
  });
  items.sort((left, right) => {
    if (left.id === currentSessionId) return -1;
    if (right.id === currentSessionId) return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  return { currentSessionId, items };
}

function renderBrowserSessions() {
  if (!state.sessions.loaded) {
    return `<div class="empty-state session-list-v5"><span>Loading authorized browsers…</span></div>`;
  }
  if (state.sessions.error) {
    return `<div class="empty-state session-list-v5"><strong>Sessions unavailable</strong><span>${escapeHtml(state.sessions.error)}</span></div>`;
  }
  if (!state.sessions.items.length) {
    return `<div class="empty-state session-list-v5"><span>No authorized browser sessions were returned.</span></div>`;
  }
  return `<div class="incident-table session-list-v5" aria-label="Authorized browsers">${state.sessions.items.map((session) => {
    const current = session.id === state.sessions.currentSessionId;
    const busy = state.sessionMutation === session.id;
    const dateCopy = [
      session.createdAt ? `Added ${formatTime(session.createdAt)}` : "Added time unavailable",
      session.expiresAt ? `Expires ${formatTime(session.expiresAt)}` : "Expiration unavailable"
    ].join(" · ");
    return `<article class="incident-row session-row-v5" data-current-session="${current ? "true" : "false"}">
      <span class="health-dot ${current ? "is-healthy" : "is-stale"}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(session.name)}${current ? ` <span class="session-current-label">Current browser</span>` : ""}</strong><p>${escapeHtml(session.origin)}</p><small>${escapeHtml(dateCopy)}</small></div>
      <button class="button button--danger" type="button" data-action="revoke-session" data-session-id="${escapeHtml(session.id)}" aria-label="${current ? "Sign out" : "Revoke"} ${escapeHtml(session.name)}" ${busy ? "disabled" : ""}>${busy ? "Working…" : current ? "Sign out" : "Revoke"}</button>
    </article>`;
  }).join("")}</div>`;
}

function renderAccessKeyReveal() {
  if (!state.accessKeyReveal) return "";
  return `<div class="invite-token" role="status" aria-live="polite">
    <span>New Helmsman access key · shown once</span>
    <code data-access-key-output>${escapeHtml(state.accessKeyReveal)}</code>
    <small>Copy it now and save it in your password manager. Helmsman stores only its hash and cannot recover it. Rotating the key replaces the previous key and signs out other browsers.</small>
    <div class="button-row"><button class="button button--primary" type="button" data-action="copy-access-key">Copy access key</button><button class="button" type="button" data-action="dismiss-access-key">I saved it</button></div>
  </div>`;
}

function renderSettingsPage() {
  const policy = state.config?.policy || { allowedCidrs: [], allowPublicHttps: false };
  const networkMode = Array.isArray(policy.allowedCidrs) && policy.allowedCidrs.length ? "manual" : "exact";
  const accessKeyConfigured = Boolean(state.status?.accessKeyConfigured);
  return `
    <section class="detail-page settings-page-v5">
      <header class="detail-hero"><div><span class="section-kicker">Control plane</span><h2>Security and access</h2><p>Local mode stays simple; HTTPS and Authentik remain optional deployment layers for LAN or external access.</p></div></header>
      <div class="settings-grid-v5">
        <form class="glass-panel settings-card-v5" id="network-form" data-network-mode="${networkMode}"><header><div><span class="section-kicker">Outbound policy</span><h3>Allowed service networks</h3></div>${icon("shield")}</header><div class="settings-card-v5__body">
          ${renderNetworkPolicyFields(policy, "settings")}
          <div class="form-actions"><button class="button button--primary" type="submit">Save network policy</button></div>
        </div></form>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">Browser access</span><h3>Universal access key</h3></div>${icon("lock")}</header><div class="settings-card-v5__body">
          <p>Enter the same reusable key on any HTTPS or localhost browser. Each successful unlock creates a separate revocable session trusted for one year.</p>
          ${renderAccessKeyReveal()}
          <div class="security-note security-note--good">${icon("check")}<div><strong>${accessKeyConfigured ? "Access key configured" : "Access key not configured"}</strong><span>${accessKeyConfigured ? "The saved key itself cannot be viewed again. Rotate it to create a replacement and revoke other browser sessions." : "Create the first reusable key now; it will be displayed only once."}</span></div></div>
          <div class="button-row"><button class="button ${accessKeyConfigured ? "button--danger" : "button--primary"}" type="button" data-action="rotate-access-key" ${state.accessKeyMutation ? "disabled" : ""}>${state.accessKeyMutation ? "Creating…" : accessKeyConfigured ? "Rotate access key" : "Create access key"}</button><button class="button" type="button" data-action="refresh-sessions">Refresh browser list</button></div>
          <h4>Authorized browsers</h4>
          ${renderBrowserSessions()}
        </div></section>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">At rest</span><h3>Credential encryption</h3></div>${icon("shield")}</header><div class="settings-card-v5__body"><p>Secrets use AES-256-GCM and never return through the API. ${state.status?.storage?.externalKey ? "This deployment uses an external key file." : "This local deployment uses an automatically generated key in its protected data volume."}</p><div class="security-note security-note--good">${icon("check")}<div><strong>No extra unlock step</strong><span>The container keeps monitoring after every browser closes.</span></div></div></div></section>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">Deployment edge</span><h3>Authentik and HTTPS</h3></div>${icon("shield")}</header><div class="settings-card-v5__body"><p>Optional for localhost. For LAN or external access, terminate HTTPS at a trusted reverse proxy, put Authentik in front, and firewall the container port so that proxy cannot be bypassed.</p></div></section>
      </div>
    </section>`;
}

function environmentKindLabel(environment) {
  if (environment.environmentKind === "cluster") return "Multi-node cluster";
  if (environment.environmentKind === "standalone") return "Standalone server";
  return "Discovery pending";
}

function infrastructureNodeById(nodeId) {
  return infrastructureHealth().nodes.find((node) => node.id === nodeId) || null;
}

function infrastructureWorkloadById(workloadId) {
  return infrastructureHealth().workloads.find((workload) => workload.id === workloadId) || null;
}

function proxmoxDiscoveryIdentity(value) {
  const kind = value?.kind || value?.environmentKind;
  if (kind === "cluster") {
    const name = safeSessionText(value?.clusterName || value?.name || value?.environmentName, "", 80).toLowerCase();
    return name ? `cluster:${name}` : null;
  }
  if (kind === "standalone") {
    const firstNode = Array.isArray(value?.nodeNames) ? value.nodeNames[0] : "";
    const name = safeSessionText(value?.name || value?.environmentName || firstNode, "", 80).toLowerCase();
    return name ? `standalone:${name}` : null;
  }
  return null;
}

function normalizedProxmoxDiscovery(value) {
  const kind = value?.kind === "cluster" ? "cluster" : value?.kind === "standalone" ? "standalone" : "unknown";
  const nodeNames = (Array.isArray(value?.nodeNames) ? value.nodeNames : [])
    .slice(0, 64)
    .map((name) => safeSessionText(name, "", 64))
    .filter(Boolean);
  return {
    kind,
    name: safeSessionText(value?.name, kind === "cluster" ? "Proxmox cluster" : "Proxmox server", 80),
    clusterName: kind === "cluster" ? safeSessionText(value?.clusterName || value?.name, "Proxmox cluster", 80) : "",
    quorate: kind === "cluster" && typeof value?.quorate === "boolean" ? value.quorate : null,
    nodeNames
  };
}

function renderProxmoxDiscovery(value, expectedEnvironment = null) {
  const discovery = normalizedProxmoxDiscovery(value);
  const identity = proxmoxDiscoveryIdentity(discovery);
  const expectedIdentity = proxmoxDiscoveryIdentity(expectedEnvironment);
  const mismatch = Boolean(identity && expectedIdentity && identity !== expectedIdentity);
  const title = discovery.kind === "cluster"
    ? `Discovered cluster ${discovery.clusterName}`
    : discovery.kind === "standalone"
      ? `Discovered standalone server ${discovery.name}`
      : "Proxmox identity could not be confirmed";
  const details = discovery.kind === "cluster"
    ? `${discovery.nodeNames.length} node${discovery.nodeNames.length === 1 ? "" : "s"}${discovery.quorate === false ? " · quorum unavailable" : discovery.quorate === true ? " · quorate" : ""}`
    : discovery.nodeNames.length ? discovery.nodeNames.join(", ") : "No node names were reported";
  return {
    confirmed: discovery.kind !== "unknown" && !mismatch,
    markup: `<div class="proxmox-discovery-result ${mismatch ? "is-mismatch" : "is-confirmed"}">
      <span class="proxmox-discovery-result__icon">${icon(mismatch ? "x" : "check")}</span>
      <div><span class="section-kicker">${mismatch ? "Environment mismatch" : "Discovery result"}</span><strong>${escapeHtml(mismatch ? "This endpoint reports a different Proxmox environment" : title)}</strong><small>${escapeHtml(mismatch ? `${title}. It cannot be registered as failover for ${expectedEnvironment?.displayName || "this environment"}.` : details)}</small>${discovery.nodeNames.length ? `<div class="proxmox-node-chips">${discovery.nodeNames.map((name) => `<span>${escapeHtml(name)}</span>`).join("")}</div>` : ""}</div>
    </div>`
  };
}

function environmentEndpointSummary(environment, endpoint) {
  if (endpoint.selected) return "Used for the current inventory";
  if (endpoint.primary) return "Preferred inventory endpoint";
  if (endpoint.state === "healthy") return "Available for failover";
  if (endpoint.state === "disabled") return "Excluded from failover";
  if (endpoint.code === "ENVIRONMENT_IDENTITY_MISMATCH") return "Reports a different environment";
  return endpoint.lastCheckedAt ? "Endpoint needs attention" : "Waiting for endpoint check";
}

function renderInfrastructureEnvironmentDetail(environment) {
  const configured = infrastructureTargetById(environment.id);
  const endpoints = environment.endpoints.length ? environment.endpoints : configured?.endpoints || [];
  const workloads = environment.workloads.filter(({ template }) => !template);
  const endpointAvailable = endpoints.filter(({ state: endpointState }) => endpointState === "healthy").length;
  return `<section class="modal-card modal-card--inventory" role="dialog" aria-modal="true" aria-labelledby="environment-detail-title">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("proxmox", "P")}</span><div><span class="section-kicker">${escapeHtml(environmentKindLabel(environment))}</span><h2 id="environment-detail-title" tabindex="-1">${escapeHtml(environment.displayName)}</h2><p>${escapeHtml(environment.environmentKind === "cluster" ? environment.clusterName || environment.environmentName : environment.environmentName)}</p></div><span class="detail-status is-${statusClass(environment.state)}"><i class="health-dot is-${statusClass(environment.state)}"></i>${escapeHtml(statusLabel(environment.state))}</span><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <div class="modal-card__body inventory-detail-body">
      <dl class="inventory-summary-grid"><div><dt>Nodes</dt><dd>${environment.nodes.length}</dd><small>${environment.nodes.filter(({ status }) => status === "online").length} online</small></div><div><dt>Workloads</dt><dd>${workloads.length}</dd><small>${workloads.filter(({ status }) => status === "running").length} running</small></div><div><dt>API endpoints</dt><dd>${endpoints.length}</dd><small>${endpointAvailable} available</small></div><div><dt>Cluster quorum</dt><dd>${environment.environmentKind !== "cluster" ? "N/A" : environment.quorate === true ? "Yes" : environment.quorate === false ? "No" : "—"}</dd><small>${environment.version ? `PVE ${escapeHtml(environment.version)}` : "Version pending"}</small></div></dl>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Connection layer</span><h3>API endpoints</h3><p>Endpoint reachability is separate from the health of the Proxmox nodes it reports.</p></div>${endpoints.length < 4 ? `<button class="button button--compact" type="button" data-action="add-infrastructure-endpoint" data-infrastructure-target-id="${escapeHtml(environment.id)}">${icon("plus")} Add failover endpoint</button>` : ""}</header>
        <div class="endpoint-detail-list">${endpoints.map((endpoint) => `<article class="endpoint-detail-row is-${statusClass(endpoint.state)}"><span class="endpoint-detail-row__status"><i class="health-dot is-${statusClass(endpoint.state)}"></i></span><div><strong>${escapeHtml(endpoint.label)}</strong><code>${escapeHtml(endpoint.url || "Address unavailable")}</code><small>${escapeHtml(environmentEndpointSummary(environment, endpoint))}${endpoint.latencyMs !== null ? ` · ${endpoint.latencyMs} ms` : ""}</small></div><div class="endpoint-badges">${endpoint.primary ? "<span>Primary</span>" : ""}${endpoint.selected ? "<span class=\"is-selected\">In use</span>" : ""}<span>${escapeHtml(endpoint.tlsMode === "pinned" ? "Pinned TLS" : "System TLS")}</span></div><button class="button button--compact" type="button" data-action="${endpoint.primary ? "open-infrastructure-target" : "open-infrastructure-endpoint"}" data-infrastructure-target-id="${escapeHtml(environment.id)}" data-infrastructure-endpoint-id="${escapeHtml(endpoint.id)}">Configure</button></article>`).join("")}</div>
      </section>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Physical layer</span><h3>Nodes</h3></div></header>${environment.nodes.length ? `<div class="inventory-compact-list">${environment.nodes.map((node) => `<button type="button" data-action="open-infrastructure-node" data-infrastructure-node-id="${escapeHtml(node.id)}"><i class="health-dot is-${statusClass(node.state)}"></i><span><strong>${escapeHtml(node.name)}</strong><small>${node.status === "online" ? "Online" : node.status === "offline" ? "Offline" : "State unknown"} · ${node.workloadCount} workload${node.workloadCount === 1 ? "" : "s"}</small></span><span>${node.cpuPercent === null ? "CPU —" : `CPU ${node.cpuPercent}%`}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No node inventory is available yet.</span></div>`}</section>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Virtual layer</span><h3>Workloads</h3></div><a class="button button--compact" href="#/workloads" data-action="close-modal">View all</a></header>${workloads.length ? `<div class="inventory-compact-list">${workloads.slice(0, 12).map((workload) => `<button type="button" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong><small>${escapeHtml(workload.kind)} ${workload.vmid ?? "—"} · ${escapeHtml(workload.node)}</small></span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No workloads are currently visible.</span></div>`}</section>

      <div class="inventory-detail-columns"><section class="inventory-detail-section"><header><div><span class="section-kicker">Capacity</span><h3>Storage</h3></div></header>${environment.storage.length ? `<div class="storage-detail-list">${environment.storage.map((storage) => `<article><div><strong>${escapeHtml(storage.name)}</strong><small>${escapeHtml(storage.node)}${storage.shared ? " · Shared" : ""}${storage.type ? ` · ${escapeHtml(storage.type)}` : ""}</small></div><span>${storage.usagePercent === null ? "—" : `${storage.usagePercent}%`}</span><small>${storage.usedBytes === null ? escapeHtml(storage.status) : `${formatMetricBytes(storage.usedBytes)} of ${formatMetricBytes(storage.totalBytes)}`}</small></article>`).join("")}</div>` : `<div class="empty-state"><span>No storage inventory is available.</span></div>`}</section>
      <section class="inventory-detail-section"><header><div><span class="section-kicker">Bounded history</span><h3>Recent activity</h3></div></header>${environment.activity.length ? `<div class="activity-detail-list">${environment.activity.slice(0, 12).map((entry) => `<article><i class="health-dot is-${entry.status === "success" ? "healthy" : "down"}"></i><div><strong>${escapeHtml(entry.type)}</strong><small>${escapeHtml([entry.node, entry.vmid === null ? "" : `VMID ${entry.vmid}`].filter(Boolean).join(" · "))}</small></div><time>${escapeHtml(formatTime(entry.endedAt))}</time></article>`).join("")}</div>` : `<div class="empty-state"><span>No recent task activity is available.</span></div>`}</section></div>
      ${environment.reports.length ? `<section class="inventory-detail-section"><header><div><span class="section-kicker">Service reports</span><h3>Warnings</h3></div></header>${renderOperationsReports(environment.reports, environment.displayName)}</section>` : ""}
    </div>
    <footer class="modal-card__footer"><button class="button" type="button" data-action="open-infrastructure-target" data-infrastructure-target-id="${escapeHtml(environment.id)}">Connection settings</button><button class="button button--primary" type="button" data-action="close-modal">Done</button></footer>
  </section>`;
}

function openInfrastructureEnvironmentDetail(environmentId) {
  const environment = infrastructureHealthForTarget(environmentId);
  if (!environment) return showToast("That Proxmox environment is no longer available.", "danger");
  openModal(renderInfrastructureEnvironmentDetail(environment), "#environment-detail-title");
}

function environmentApiAvailability(environment) {
  const endpoints = Array.isArray(environment?.endpoints) ? environment.endpoints : [];
  const total = Math.max(1, endpoints.length);
  const healthy = endpoints.filter(({ state: endpointState }) => endpointState === "healthy").length;
  return {
    total,
    available: healthy || (environment?.connectionState === "connected" ? 1 : 0)
  };
}

function nodeWarnings(node) {
  const warnings = [];
  if (node.status === "offline") warnings.push("Proxmox reports this node as offline.");
  if (node.cpuPercent !== null && node.cpuPercent >= 90) warnings.push(`CPU use is ${node.cpuPercent}%.`);
  const memory = node.memoryUsedBytes !== null && node.memoryTotalBytes ? Math.round((node.memoryUsedBytes / node.memoryTotalBytes) * 100) : null;
  const disk = node.rootDiskUsedBytes !== null && node.rootDiskTotalBytes ? Math.round((node.rootDiskUsedBytes / node.rootDiskTotalBytes) * 100) : null;
  if (memory !== null && memory >= 90) warnings.push(`Memory use is ${memory}%.`);
  if (disk !== null && disk >= 90) warnings.push(`Root disk use is ${disk}%.`);
  return warnings;
}

function renderInfrastructureNodeDetail(node) {
  const warnings = nodeWarnings(node);
  const api = environmentApiAvailability(infrastructureHealthForTarget(node.environmentId));
  const workloads = infrastructureHealth().workloads.filter((workload) => workload.environmentId === node.environmentId && workload.node === node.name && !workload.template);
  return `<section class="modal-card modal-card--detail" role="dialog" aria-modal="true" aria-labelledby="node-detail-title"><header class="modal-card__header"><span class="detail-modal-mark">${serviceIconMarkup("proxmox", "P")}</span><div><span class="section-kicker">${escapeHtml(node.environmentName)}</span><h2 id="node-detail-title" tabindex="-1">${escapeHtml(node.name)}</h2><p>${node.status === "online" ? "Online Proxmox node" : node.status === "offline" ? "Offline Proxmox node" : "Node state unavailable"}</p></div><span class="detail-status is-${statusClass(node.state)}"><i class="health-dot is-${statusClass(node.state)}"></i>${escapeHtml(statusLabel(node.state))}</span><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header><div class="modal-card__body inventory-detail-body"><dl class="inventory-summary-grid"><div><dt>CPU</dt><dd>${node.cpuPercent === null ? "—" : `${node.cpuPercent}%`}</dd><small>${node.cpuCores === null ? "Cores unavailable" : `${node.cpuCores} cores`}</small></div><div><dt>Memory</dt><dd>${escapeHtml(formatMetricRatio(node.memoryUsedBytes, node.memoryTotalBytes))}</dd><small>${node.memoryUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.memoryUsedBytes)} of ${formatMetricBytes(node.memoryTotalBytes)}`}</small></div><div><dt>Root disk</dt><dd>${escapeHtml(formatMetricRatio(node.rootDiskUsedBytes, node.rootDiskTotalBytes))}</dd><small>${node.rootDiskUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.rootDiskUsedBytes)} of ${formatMetricBytes(node.rootDiskTotalBytes)}`}</small></div><div><dt>Uptime</dt><dd>${node.uptimeSeconds === null ? "—" : escapeHtml(formatMetricDuration(node.uptimeSeconds))}</dd><small>${escapeHtml(node.version || "Version unavailable")}</small></div></dl><div class="security-note ${api.available ? "security-note--good" : ""}">${icon(api.available ? "check" : "shield")}<div><strong>Environment API · ${api.available} of ${api.total} endpoints available</strong><span>This connection-layer signal does not override the node state reported by Proxmox.</span></div></div>${warnings.length ? `<div class="detail-warning-list">${warnings.map((warning) => `<div>${icon("shield")}<span>${escapeHtml(warning)}</span></div>`).join("")}</div>` : `<div class="security-note security-note--good">${icon("check")}<div><strong>No node-specific warnings</strong><span>Current bounded CPU, memory, disk, and availability signals are within their alert thresholds.</span></div></div>`}<section class="inventory-detail-section"><header><div><span class="section-kicker">Guests assigned here</span><h3>${workloads.length} workload${workloads.length === 1 ? "" : "s"}</h3></div></header>${workloads.length ? `<div class="inventory-compact-list">${workloads.map((workload) => `<button type="button" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong><small>${escapeHtml(workload.kind)} ${workload.vmid ?? "—"}</small></span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No VM or container is assigned to this node.</span></div>`}</section></div><footer class="modal-card__footer"><button class="button" type="button" data-action="open-infrastructure-environment-detail" data-infrastructure-target-id="${escapeHtml(node.environmentId)}">Open environment</button><button class="button button--primary" type="button" data-action="close-modal">Done</button></footer></section>`;
}

function openInfrastructureNode(nodeId) {
  const node = infrastructureNodeById(nodeId);
  if (!node) return showToast("That Proxmox node is no longer available.", "danger");
  openModal(renderInfrastructureNodeDetail(node), "#node-detail-title");
}

function proxmoxActionContext(workload) {
  const environment = infrastructureTargetById(workload.environmentId);
  const evidence = infrastructureHealthForTarget(workload.environmentId);
  if (!environment?.targetRevision
    || environment.enabled === false
    || environment.monitoringEnabled === false
    || !actionEvidenceIsCurrent(evidence, environment.targetRevision, evidence?.lastCheckedAt)) return null;
  return { environment, evidence };
}

function renderProxmoxWorkloadControls(workload) {
  if (!proxmoxActionContext(workload)
    || workload.node === "Unassigned"
    || !Number.isSafeInteger(workload.vmid)
    || workload.template
    || workload.lock
    || !["qemu", "lxc"].includes(workload.type)) return "";
  const actions = workload.status === "stopped"
    ? [{ operation: "start", label: "Start", className: "button--primary" }]
    : workload.status === "running"
      ? [
          { operation: "reboot", label: "Reboot", className: "" },
          { operation: "shutdown", label: "Shut down", className: "button--danger" }
        ]
      : [];
  return actions.map(({ operation, label, className }) => {
    const key = `proxmox:${workload.id}:${operation}`;
    const busy = state.actionMutation === key;
    const awaitingRefresh = state.actionAwaitingRefresh === key;
    return `<button class="button ${className}" type="button" data-action="run-proxmox-control" data-infrastructure-workload-id="${escapeHtml(workload.id)}" data-control-operation="${escapeHtml(operation)}" data-control-key="${escapeHtml(key)}" ${state.actionMutation ? "disabled" : ""} ${busy && !awaitingRefresh ? "aria-busy=\"true\"" : ""}>${awaitingRefresh ? `${icon("refresh")} Refresh required` : busy ? `${icon("refresh")} Working…` : escapeHtml(label)}</button>`;
  }).join("");
}

function renderInfrastructureWorkloadDetail(workload) {
  const backup = workload.backup
    ? `${workload.backup.status === "success" ? "Successful" : "Failed"}${workload.backup.endedAt ? ` · ${formatTime(workload.backup.endedAt)}` : ""}`
    : "No backup observed in the bounded task window";
  return `<section class="modal-card modal-card--detail" role="dialog" aria-modal="true" aria-labelledby="workload-detail-title"><header class="modal-card__header"><span class="workload-type detail-modal-workload is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</span><div><span class="section-kicker">${escapeHtml(workload.environmentName)} · ${escapeHtml(workload.node)}</span><h2 id="workload-detail-title" tabindex="-1">${escapeHtml(workload.name)}</h2><p>${escapeHtml(workload.kind)} ${workload.vmid ?? "—"}${workload.template ? " · Template" : ""}</p></div><span class="workload-state workload-state--large is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header><div class="modal-card__body inventory-detail-body"><div class="workload-information-note ${workload.status === "stopped" ? "is-neutral" : ""}">${icon(workload.status === "stopped" ? "pause" : "check")}<div><strong>${workload.status === "stopped" ? "Stopped by Proxmox" : `Current state: ${escapeHtml(workload.status)}`}</strong><span>${workload.lock ? `Power controls are unavailable while Proxmox reports the ${escapeHtml(workload.lock)} lock.` : workload.status === "stopped" ? "A deliberately stopped guest is informational and can be started from this detail view." : "Start, reboot, and graceful shutdown use Proxmox's existing guest power API after confirmation."}</span></div></div><dl class="inventory-summary-grid"><div><dt>CPU</dt><dd>${workload.cpuPercent === null ? "—" : `${workload.cpuPercent}%`}</dd><small>${workload.cpuCores === null ? "vCPU unavailable" : `${workload.cpuCores} vCPU`}</small></div><div><dt>Memory</dt><dd>${escapeHtml(formatMetricRatio(workload.memoryUsedBytes, workload.memoryTotalBytes))}</dd><small>${workload.memoryUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(workload.memoryUsedBytes)} of ${formatMetricBytes(workload.memoryTotalBytes)}`}</small></div><div><dt>Disk</dt><dd>${escapeHtml(formatMetricRatio(workload.diskUsedBytes, workload.diskTotalBytes))}</dd><small>${workload.diskUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(workload.diskUsedBytes)} of ${formatMetricBytes(workload.diskTotalBytes)}`}</small></div><div><dt>Uptime</dt><dd>${workload.uptimeSeconds === null ? "—" : escapeHtml(formatMetricDuration(workload.uptimeSeconds))}</dd><small>${workload.lock ? `Lock: ${escapeHtml(workload.lock)}` : "No lock reported"}</small></div></dl><section class="inventory-detail-section"><header><div><span class="section-kicker">Protection</span><h3>Latest observed backup</h3></div></header><div class="backup-detail ${workload.backup?.status === "failed" ? "is-failed" : ""}">${icon(workload.backup?.status === "failed" ? "x" : workload.backup ? "check" : "refresh")}<div><strong>${escapeHtml(backup)}</strong><small>Derived from Proxmox's bounded recent backup-task history.</small></div></div></section>${workload.tags.length ? `<div class="proxmox-node-chips">${workload.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}</div><footer class="modal-card__footer"><button class="button" type="button" data-action="open-infrastructure-node" data-infrastructure-node-id="${escapeHtml(`${workload.environmentId}:${workload.node}`)}">Open node</button><div class="modal-card__actions">${renderProxmoxWorkloadControls(workload)}<button class="button" type="button" data-action="close-modal">Done</button></div></footer></section>`;
}

function openInfrastructureWorkload(workloadId) {
  const workload = infrastructureWorkloadById(workloadId);
  if (!workload) return showToast("That workload is no longer available.", "danger");
  openModal(renderInfrastructureWorkloadDetail(workload), "#workload-detail-title");
}

function renderInfrastructureEnvironmentGrid(snapshot) {
  if (!snapshot.environments.length) {
    return `<section class="glass-panel infrastructure-onboarding"><div class="infrastructure-onboarding__icon">${icon("server")}</div><span class="section-kicker">Start with virtualization</span><h3>Connect your first Proxmox environment</h3><p>Helmsman will discover whether the endpoint belongs to a standalone server or a cluster before it is saved.</p><ol><li><span>1</span>Enter one HTTPS endpoint and scoped token.</li><li><span>2</span>Verify certificate trust and discover its nodes.</li><li><span>3</span>Confirm the environment, then optionally add failover endpoints.</li></ol><button class="button button--primary" type="button" data-action="open-infrastructure-target">${icon("plus")} Connect and discover</button></section>`;
  }
  return `<div class="infrastructure-environment-grid">${snapshot.environments.map((environment) => {
    const endpointOnline = environment.endpoints.filter(({ state: endpointState }) => endpointState === "healthy").length;
    const endpointCount = environment.endpoints.length || state.infrastructure.targets.find(({ id }) => id === environment.id)?.endpoints?.length || 1;
    return `<article class="glass-panel environment-card is-${statusClass(environment.state)}">
      <button class="environment-card__main" type="button" data-action="open-infrastructure-environment-detail" data-infrastructure-target-id="${escapeHtml(environment.id)}">
        <span class="environment-card__icon">${serviceIconMarkup("proxmox", "P")}</span>
        <span class="environment-card__copy"><span class="section-kicker">${escapeHtml(environmentKindLabel(environment))}</span><strong>${escapeHtml(environment.displayName)}</strong><small>${environment.environmentKind === "cluster" ? escapeHtml(environment.clusterName || environment.environmentName) : escapeHtml(environment.environmentName)}</small></span>
        <span class="environment-card__state"><i class="health-dot is-${statusClass(environment.state)}"></i>${escapeHtml(statusLabel(environment.state))}</span>
        ${icon("chevron")}
      </button>
      <dl class="environment-card__metrics"><div><dt>Nodes</dt><dd>${environment.nodes.length || environment.metrics.nodeTotal || 0}</dd><small>${environment.metrics.nodesOnline ?? 0} online</small></div><div><dt>Workloads</dt><dd>${environment.workloads.filter(({ template }) => !template).length || environment.metrics.guestTotal || 0}</dd><small>${environment.metrics.guestsRunning ?? 0} running</small></div><div><dt>API endpoints</dt><dd>${endpointCount}</dd><small>${endpointOnline || (environment.connectionState === "connected" ? 1 : 0)} available</small></div></dl>
      <footer><span>${environment.quorate === false ? "Cluster quorum lost" : environment.version ? `PVE ${escapeHtml(environment.version)}` : "Read-only inventory"}</span><button class="button button--compact" type="button" data-action="open-infrastructure-target" data-infrastructure-target-id="${escapeHtml(environment.id)}">Connection settings</button></footer>
    </article>`;
  }).join("")}</div>`;
}

function infrastructureFilterOptions(items, valueKey, labelKey, selected, allLabel) {
  return `<option value="all">${escapeHtml(allLabel)}</option>${items.map((item) => {
    const value = String(item[valueKey]);
    return `<option value="${escapeHtml(value)}" ${selected === value ? "selected" : ""}>${escapeHtml(item[labelKey])}</option>`;
  }).join("")}`;
}

function selectedInfrastructureEnvironment(snapshot) {
  const requested = state.infrastructure.filters.environment;
  if (requested === "all" || snapshot.environments.some(({ id }) => id === requested)) return requested;
  state.infrastructure.filters.environment = "all";
  state.infrastructure.filters.node = "all";
  return "all";
}

function renderInfrastructureNodeGrid(snapshot, nodes) {
  if (!nodes.length) return `<div class="glass-panel empty-state"><span>${icon("server")}</span><strong>No node inventory yet</strong><span>Nodes appear after an enabled environment completes discovery.</span></div>`;
  return `<div class="infrastructure-node-grid">${nodes.map((node) => {
    const api = environmentApiAvailability(snapshot.environments.find(({ id }) => id === node.environmentId));
    return `<button class="glass-panel infrastructure-node-card is-${statusClass(node.state)}" type="button" data-action="open-infrastructure-node" data-infrastructure-node-id="${escapeHtml(node.id)}">
      <header><span class="node-mark">${serviceIconMarkup("proxmox", "P")}</span><span><small>${escapeHtml(node.environmentName)}</small><strong>${escapeHtml(node.name)}</strong></span><i class="health-dot is-${statusClass(node.state)}"></i></header>
      <dl><div><dt>CPU</dt><dd>${node.cpuPercent === null ? "—" : `${node.cpuPercent}%`}</dd><small>${node.cpuCores === null ? "Cores unavailable" : `${node.cpuCores} cores`}</small></div><div><dt>Memory</dt><dd>${escapeHtml(formatMetricRatio(node.memoryUsedBytes, node.memoryTotalBytes))}</dd><small>${node.memoryUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.memoryUsedBytes)} used`}</small></div><div><dt>Root disk</dt><dd>${escapeHtml(formatMetricRatio(node.rootDiskUsedBytes, node.rootDiskTotalBytes))}</dd><small>${node.rootDiskUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.rootDiskUsedBytes)} used`}</small></div><div><dt>Workloads</dt><dd>${node.runningWorkloadCount}/${node.workloadCount}</dd><small>${node.virtualMachineCount} VM · ${node.containerCount} LXC</small></div></dl>
      <footer><span>${node.status === "online" ? "Online" : node.status === "offline" ? "Offline" : "State unknown"}</span><span>${node.uptimeSeconds === null ? "Uptime unavailable" : `Up ${formatMetricDuration(node.uptimeSeconds)}`}${node.version ? ` · ${escapeHtml(node.version)}` : ""} · API ${api.available}/${api.total}</span></footer>
    </button>`;
  }).join("")}</div>`;
}

function infrastructureStorageTone(storage) {
  const status = String(storage.status || "unknown").toLowerCase();
  if (["unknown", "unavailable", "offline", "inactive", "disabled"].includes(status)) return "down";
  if (storage.usagePercent !== null && storage.usagePercent >= 90) return "down";
  if (storage.usagePercent !== null && storage.usagePercent >= 80) return "limited";
  return status === "available" ? "healthy" : "stale";
}

function renderInfrastructureStorageList(storage) {
  if (!storage.length) return `<div class="empty-state"><span>${icon("server")}</span><strong>No storage inventory yet</strong><span>Storage appears after an enabled environment completes its first inventory check.</span></div>`;
  return `<div class="storage-detail-list proxmox-storage-list">${storage.map((entry) => {
    const tone = infrastructureStorageTone(entry);
    const freeBytes = entry.usedBytes !== null && entry.totalBytes !== null
      ? Math.max(0, entry.totalBytes - entry.usedBytes)
      : null;
    const usage = entry.usagePercent === null ? "—" : `${entry.usagePercent}%`;
    const capacity = entry.usedBytes === null || entry.totalBytes === null
      ? "Capacity unavailable"
      : `${formatMetricBytes(entry.usedBytes)} used · ${formatMetricBytes(freeBytes)} free · ${formatMetricBytes(entry.totalBytes)} total`;
    return `<article class="is-${tone}"><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.environmentName)} · ${escapeHtml(entry.node)}${entry.type ? ` · ${escapeHtml(entry.type)}` : ""}${entry.shared ? " · Shared" : " · Local"} · Status ${escapeHtml(entry.status)}</small></div><span class="storage-usage"><i class="health-dot is-${tone}" aria-hidden="true"></i>${usage}</span><small>${capacity}</small>${entry.usagePercent === null ? "" : `<progress max="100" value="${entry.usagePercent}" aria-label="${escapeHtml(entry.name)} storage use">${entry.usagePercent}%</progress>`}</article>`;
  }).join("")}</div>`;
}

function renderProxmoxPage() {
  const snapshot = infrastructureHealth();
  const selectedEnvironment = selectedInfrastructureEnvironment(snapshot);
  const nodes = snapshot.nodes.filter((node) => selectedEnvironment === "all" || node.environmentId === selectedEnvironment);
  const storage = snapshot.storage.filter((entry) => selectedEnvironment === "all" || entry.environmentId === selectedEnvironment);
  const loading = state.infrastructure.loading && !state.infrastructure.loaded;
  return `<section class="detail-page infrastructure-inventory-page infrastructure-proxmox-page" id="infrastructure-proxmox">
    <header class="detail-hero"><div><span class="section-kicker">Virtualization topology</span><h2>Proxmox</h2><p>Environments, physical nodes, storage inventory, and confirmed guest power controls in one view.</p></div><div class="button-row"><button class="button" type="button" data-action="refresh-live">${icon("refresh")} Check now</button><button class="button button--primary" type="button" data-action="open-infrastructure-target">${icon("plus")} Connect and discover</button></div></header>
    ${state.infrastructure.error ? `<div class="infrastructure-load-error" role="alert"><div><strong>Proxmox inventory could not be refreshed</strong><span>${escapeHtml(state.infrastructure.error)}</span></div><button class="button" type="button" data-action="retry-infrastructure-targets">Try again</button></div>` : ""}
    ${loading
      ? `<div class="glass-panel infrastructure-loading" role="status"><span class="state-page__spinner">${icon("refresh")}</span><strong>Loading Proxmox inventory…</strong></div>`
      : !snapshot.environments.length
        ? renderInfrastructureEnvironmentGrid(snapshot)
        : `<section class="proxmox-section" aria-labelledby="proxmox-environments-title"><header class="proxmox-section__heading"><div><span class="section-kicker">Connections</span><h3 id="proxmox-environments-title">Environments</h3><p>Standalone servers and clusters, with their explicitly trusted API endpoints.</p></div><span class="count-pill">${snapshot.environments.length}</span></header>${renderInfrastructureEnvironmentGrid(snapshot)}</section>
          <div class="infrastructure-filterbar proxmox-filterbar"><label><span>Environment</span><select id="proxmox-environment-filter" data-infrastructure-filter="environment">${infrastructureFilterOptions(snapshot.environments, "id", "displayName", selectedEnvironment, "All environments")}</select></label><span class="filter-result-count">${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${storage.length} storage entr${storage.length === 1 ? "y" : "ies"}</span></div>
          <section class="proxmox-section" aria-labelledby="proxmox-nodes-title"><header class="proxmox-section__heading"><div><span class="section-kicker">Physical layer</span><h3 id="proxmox-nodes-title">Nodes</h3><p>Node health is independent from the API endpoint used to collect it.</p></div><span class="count-pill">${nodes.length}</span></header>${renderInfrastructureNodeGrid(snapshot, nodes)}</section>
          <section class="glass-panel proxmox-storage-panel" aria-labelledby="proxmox-storage-title"><header><div><span class="section-kicker">Capacity</span><h3 id="proxmox-storage-title">Storage</h3><p>Entries stay scoped to their reporting node; shared pools may appear on more than one node.</p></div><span class="count-pill">${storage.length}</span></header>${renderInfrastructureStorageList(storage)}</section>`}
  </section>`;
}

function filteredInfrastructureWorkloads(snapshot) {
  const filters = state.infrastructure.filters;
  const search = filters.search.trim().toLowerCase();
  return snapshot.workloads.filter((workload) => (
    (filters.environment === "all" || workload.environmentId === filters.environment)
    && (filters.node === "all" || workload.node === filters.node)
    && (filters.type === "all" || workload.type === filters.type)
    && (filters.status === "all" || workload.status === filters.status)
    && (!search || workload.name.toLowerCase().includes(search) || String(workload.vmid || "").includes(search))
  ));
}

function renderInfrastructureWorkloadsPage() {
  const snapshot = infrastructureHealth();
  const filters = state.infrastructure.filters;
  selectedInfrastructureEnvironment(snapshot);
  const availableNodes = [...new Set(snapshot.workloads
    .filter((workload) => filters.environment === "all" || workload.environmentId === filters.environment)
    .map(({ node }) => node))].sort().map((name) => ({ id: name, name }));
  const workloads = filteredInfrastructureWorkloads(snapshot);
  return `<section class="detail-page infrastructure-inventory-page" id="infrastructure-workloads">
    <header class="detail-hero"><div><span class="section-kicker">Virtual layer</span><h2>VMs and containers</h2><p>Every workload has a stable environment, node, type, and VMID identity. A stopped guest is informational, not an incident.</p></div><button class="button" type="button" data-action="refresh-live">${icon("refresh")} Check now</button></header>
    <div class="infrastructure-filterbar workload-filterbar">
      <label><span>Environment</span><select id="infrastructure-workload-environment-filter" data-infrastructure-filter="environment">${infrastructureFilterOptions(snapshot.environments, "id", "displayName", filters.environment, "All environments")}</select></label>
      <label><span>Node</span><select id="infrastructure-workload-node-filter" data-infrastructure-filter="node">${infrastructureFilterOptions(availableNodes, "id", "name", filters.node, "All nodes")}</select></label>
      <label><span>Type</span><select id="infrastructure-workload-type-filter" data-infrastructure-filter="type"><option value="all">VM and LXC</option><option value="qemu" ${filters.type === "qemu" ? "selected" : ""}>Virtual machines</option><option value="lxc" ${filters.type === "lxc" ? "selected" : ""}>Containers</option></select></label>
      <label><span>State</span><select id="infrastructure-workload-state-filter" data-infrastructure-filter="status"><option value="all">All states</option><option value="running" ${filters.status === "running" ? "selected" : ""}>Running</option><option value="stopped" ${filters.status === "stopped" ? "selected" : ""}>Stopped</option><option value="paused" ${filters.status === "paused" ? "selected" : ""}>Paused</option></select></label>
      <label class="filter-search"><span>Name or VMID</span><input id="infrastructure-workload-search" type="search" value="${escapeHtml(filters.search)}" placeholder="Search workloads" data-infrastructure-filter="search" /></label>
      <span class="filter-result-count">${workloads.length} result${workloads.length === 1 ? "" : "s"}</span>
    </div>
    <section class="glass-panel infrastructure-workload-panel"><div class="infrastructure-workload-table" role="table" aria-label="Proxmox workloads">
      <div class="workload-row workload-row--header" role="row"><span>Name</span><span>Type / VMID</span><span>Environment</span><span>Node</span><span>State</span><span>Memory</span><span></span></div>
      ${workloads.length ? workloads.map((workload) => `<button class="workload-row" type="button" role="row" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><span class="workload-name"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong>${workload.template ? "<small>Template</small>" : ""}</span></span><span><b>${escapeHtml(workload.kind)}</b><small>${workload.vmid ?? "—"}</small></span><span>${escapeHtml(workload.environmentName)}</span><span>${escapeHtml(workload.node)}</span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span><span><b>${escapeHtml(formatMetricRatio(workload.memoryUsedBytes, workload.memoryTotalBytes))}</b><small>${workload.memoryUsedBytes === null ? "—" : formatMetricBytes(workload.memoryUsedBytes)}</small></span>${icon("chevron")}</button>`).join("") : `<div class="empty-state"><strong>No matching workloads</strong><span>Adjust the filters or wait for the first inventory cycle.</span></div>`}
    </div></section>
  </section>`;
}

function portainerEnvironmentTone(value) {
  return value === "up" ? "healthy"
    : value === "provisioning" ? "limited"
      : ["down", "error"].includes(value) ? "down" : "stale";
}

function portainerContainerTone(container) {
  if (container.health === "unhealthy" || ["dead", "restarting"].includes(container.state)) return "down";
  if (container.state === "running") return "healthy";
  if (container.state === "paused") return "limited";
  return "stale";
}

function portainerContainerStateLabel(container) {
  if (container.health === "unhealthy" && container.state === "running") return "Unhealthy";
  return {
    running: "Running",
    exited: "Stopped",
    created: "Created",
    paused: "Paused",
    restarting: "Restarting",
    removing: "Removing",
    dead: "Dead",
    unknown: "Unknown"
  }[container.state] || "Unknown";
}

function portainerContainerByKey(key) {
  return portainerServicesForUi()
    .flatMap((service) => service.inventory.containers)
    .find((container) => container.key === key) || null;
}

function portainerActionContext(container) {
  const configuration = normalizedPortainerConfigurations().find(({ id }) => id === container.serverId);
  const evidence = portainerHealthById(container.serverId);
  const environment = evidence?.inventory.environments.find(({ id }) => id === container.environmentId);
  if (!configuration?.targetRevision
    || configuration.enabled === false
    || configuration.monitoringEnabled === false
    || !actionEvidenceIsCurrent(evidence, configuration.targetRevision)
    || environment?.state !== "up"
    || environment.containerCapable !== true) return null;
  return { configuration, evidence, environment };
}

function renderPortainerContainerControls(container) {
  if (!portainerActionContext(container)
    || !/^[a-f0-9]{64}$/u.test(container.id)) return `<span class="portainer-container-empty-action">Controls unavailable</span>`;
  const actions = container.state === "running"
    ? [
        { operation: "restart", label: "Restart", className: "" },
        { operation: "stop", label: "Stop", className: "button--danger" }
      ]
    : ["created", "exited"].includes(container.state)
      ? [{ operation: "start", label: "Start", className: "button--primary" }]
      : [];
  if (!actions.length) return `<span class="portainer-container-empty-action">No action available</span>`;
  return `<div class="container-control-buttons">${actions.map(({ operation, label, className }) => {
    const key = `portainer:${container.key}:${operation}`;
    const busy = state.actionMutation === key;
    const awaitingRefresh = state.actionAwaitingRefresh === key;
    const currentLabel = awaitingRefresh ? "Refresh required" : busy ? "Working" : label;
    const accessibleLabel = `${currentLabel}: ${container.name} (${container.shortId})`;
    return `<button class="button button--compact ${className}" type="button" data-action="run-portainer-control" data-portainer-container-key="${escapeHtml(container.key)}" data-control-operation="${escapeHtml(operation)}" data-control-key="${escapeHtml(key)}" aria-label="${escapeHtml(accessibleLabel)}" ${state.actionMutation ? "disabled" : ""} ${busy && !awaitingRefresh ? "aria-busy=\"true\"" : ""}>${awaitingRefresh ? "Refresh required" : busy ? "Working…" : escapeHtml(label)}</button>`;
  }).join("")}</div>`;
}

function portainerConnectionLabel(service) {
  if (!service.enabled || !service.monitoringEnabled) return "Disabled";
  if (service.connectionState === "connected") return service.state === "healthy"
    ? "Connected · Healthy"
    : `Connected · ${statusLabel(service.state)}`;
  if (service.connectionState === "auth_required") return "Authentication required";
  if (service.connectionState === "down") return "Connection unavailable";
  return service.credentialConfigured ? "Waiting for verification" : "Access token required";
}

function portainerMetricTotals(services) {
  const environments = services.flatMap((service) => service.inventory.environments);
  const containers = services.flatMap((service) => service.inventory.containers);
  const stacks = services.flatMap((service) => service.inventory.stacks);
  return {
    environments,
    containers,
    stacks,
    environmentOnline: environments.filter(({ state: environmentState }) => environmentState === "up").length,
    running: containers.filter(({ state: containerState }) => containerState === "running").length,
    stopped: containers.filter(({ state: containerState }) => ["created", "exited"].includes(containerState)).length,
    unhealthy: containers.filter(({ health }) => health === "unhealthy").length
  };
}

function portainerCapabilityMarkup(service) {
  if (!service.capabilities.length && !service.reports.length) return "";
  const failures = service.capabilities.filter(({ state: checkState }) => !["healthy", "disabled"].includes(checkState));
  const reports = [
    ...service.reports,
    ...service.capabilities.flatMap((check) => check.reports)
  ].slice(0, 12);
  return `<details class="portainer-capabilities" ${failures.length ? "open" : ""}>
    <summary><span>${failures.length ? `${failures.length} check${failures.length === 1 ? "" : "s"} need attention` : `${service.capabilities.length} read-only checks passed`}</span>${icon("chevron")}</summary>
    <ul>${service.capabilities.map((check) => `<li><span class="health-dot is-${statusClass(check.state)}" aria-hidden="true"></span><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(capabilityEvidence(check))}</small></span><em>${escapeHtml(statusLabel(check.state))}</em></li>`).join("")}</ul>
    ${renderOperationsReports(reports, service.displayName)}
  </details>`;
}

function renderPortainerConnection(service) {
  const facts = [
    service.version ? `Portainer ${service.version}` : "Version pending",
    service.latencyMs === null ? "Latency pending" : `${service.latencyMs} ms`,
    `${service.metrics.environmentOnline}/${service.metrics.environmentTotal} environments online`,
    `${service.metrics.containerRunning}/${service.metrics.containerTotal} containers running`
  ];
  return `<article class="portainer-connection-card portainer-card" data-portainer-service-id="${escapeHtml(service.id)}">
    <header><span class="portainer-mark">${serviceIconMarkup("portainer", "P")}</span><span><small>${escapeHtml(service.typeName)}</small><strong>${escapeHtml(service.displayName)}</strong></span><span class="portainer-status is-${statusClass(service.state)}"><i class="health-dot is-${statusClass(service.state)}"></i>${escapeHtml(portainerConnectionLabel(service))}</span></header>
    <div class="portainer-connection-card__body"><code>${escapeHtml(service.url || "Connection address unavailable")}</code><p data-portainer-card-facts>${escapeHtml(facts.join(" · "))}</p><small>Last checked <time data-portainer-card-checked>${escapeHtml(formatTime(service.checkedAt, "after the next monitoring cycle"))}</time></small></div>
    ${portainerCapabilityMarkup(service)}
    <footer><span>${service.credentialConfigured ? `${icon("lock")} Access token protected` : `${icon("shield")} No access token saved`}</span><button class="button button--compact" type="button" data-action="open-portainer-service" data-portainer-service-id="${escapeHtml(service.id)}">Edit connection</button></footer>
  </article>`;
}

function filteredPortainerInventory(services) {
  const filters = state.infrastructure.portainerFilters;
  const selectedServices = filters.server === "all" ? services : services.filter(({ id }) => id === filters.server);
  const all = portainerMetricTotals(selectedServices);
  const search = filters.search.trim().toLowerCase();
  const containers = all.containers.filter((container) => {
    const matchesEnvironment = filters.environment === "all" || `${container.serverId}:${container.environmentId}` === filters.environment;
    const matchesState = filters.state === "all"
      || filters.state === "stopped" && ["created", "exited"].includes(container.state)
      || filters.state === "unhealthy" && container.health === "unhealthy"
      || filters.state === container.state;
    const haystack = `${container.name} ${container.image} ${container.stack} ${container.shortId} ${container.environmentName} ${container.serverName}`.toLowerCase();
    return matchesEnvironment && matchesState && (!search || haystack.includes(search));
  });
  const stacks = all.stacks.filter((stack) => filters.environment === "all" || `${stack.serverId}:${stack.environmentId}` === filters.environment);
  return { ...all, containers, stacks };
}

function groupedPortainerContainers(containers) {
  const groups = new Map();
  for (const container of containers) {
    const key = `${container.serverId}:${container.environmentId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        serverName: container.serverName,
        environmentName: container.environmentName,
        containers: []
      });
    }
    groups.get(key).containers.push(container);
  }
  return [...groups.values()];
}

function portainerPortLabels(container) {
  const labels = [];
  const seen = new Set();
  for (const port of container.ports) {
    const label = port.publicPort
      ? `${port.publicPort} → ${port.privatePort}/${port.protocol}`
      : `${port.privatePort}/${port.protocol} · internal`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function renderPortainerContainer(container) {
  const tone = portainerContainerTone(container);
  const ports = portainerPortLabels(container);
  return `<article class="portainer-container-row is-${tone}" data-portainer-container-key="${escapeHtml(container.key)}" tabindex="-1" aria-label="${escapeHtml(`${container.name}, ${portainerContainerStateLabel(container)}`)}">
    <div class="portainer-container-identity"><span class="portainer-container-mark">${icon("containers")}</span><span><strong>${escapeHtml(container.name)}</strong><small>Container ${escapeHtml(container.shortId)}</small><code title="${escapeHtml(container.image)}">${escapeHtml(container.image)}</code></span></div>
    <div class="portainer-container-placement"><span>Stack</span><strong>${escapeHtml(container.stack || "Standalone")}</strong><small>${container.stack ? "Compose-managed container" : "Not assigned to a visible stack"}</small></div>
    <div class="portainer-container-runtime"><span>Runtime</span><span class="portainer-status is-${tone}"><i class="health-dot is-${tone}"></i>${escapeHtml(portainerContainerStateLabel(container))}</span><small>${escapeHtml(container.status)}</small></div>
    <div class="portainer-container-ports"><span>Ports</span>${ports.length ? `<div>${ports.map((port) => `<code>${escapeHtml(port)}</code>`).join("")}</div>` : `<small>No ports reported</small>`}</div>
    <div class="portainer-container-actions"><span>Actions</span>${renderPortainerContainerControls(container)}</div>
  </article>`;
}

function renderPortainerContainerGroups(containers) {
  const groups = groupedPortainerContainers(containers);
  if (!groups.length) return `<div class="empty-state"><strong>No matching containers</strong><span>Adjust the filters or wait for the next Portainer inventory cycle.</span></div>`;
  return `<div class="portainer-container-groups">${groups.map((group, index) => {
    const titleId = `portainer-container-group-${index}`;
    return `<section class="portainer-container-group" aria-labelledby="${titleId}"><header class="portainer-container-group__header"><span class="portainer-environment-mark">${icon("server")}</span><div><span>Portainer environment</span><h4 id="${titleId}">${escapeHtml(group.serverName)} · ${escapeHtml(group.environmentName)}</h4></div><span class="count-pill">${group.containers.length} container${group.containers.length === 1 ? "" : "s"}</span></header><div class="portainer-container-list">${group.containers.map(renderPortainerContainer).join("")}</div></section>`;
  }).join("")}</div>`;
}

function renderPortainerPage() {
  const services = portainerServicesForUi();
  const totals = portainerMetricTotals(services);
  const filtered = filteredPortainerInventory(services);
  const filters = state.infrastructure.portainerFilters;
  const selectedServices = filters.server === "all" ? services : services.filter(({ id }) => id === filters.server);
  const environments = selectedServices.flatMap((service) => service.inventory.environments);
  const environmentContainerCounts = new Map();
  totals.containers.forEach((container) => {
    const key = `${container.serverId}:${container.environmentId}`;
    environmentContainerCounts.set(key, (environmentContainerCounts.get(key) || 0) + 1);
  });
  return `<section class="detail-page portainer-page" id="portainer-infrastructure">
    <header class="detail-hero portainer-hero"><div class="portainer-hero__identity"><span class="portainer-mark portainer-mark--hero">${serviceIconMarkup("portainer", "P")}</span><div><span class="section-kicker">Container infrastructure</span><h2>Portainer operations</h2><p>One secure Portainer connection inventories every permitted environment. Confirmed start, restart, and graceful stop controls use Portainer's existing API without exposing its token.</p></div></div><div class="portainer-hero__actions"><button class="button" type="button" data-action="refresh-live">${icon("refresh")} Check now</button><button class="button button--primary" type="button" data-action="open-portainer-service">${icon("plus")} Connect Portainer</button></div></header>

    ${services.length ? "" : `<section class="portainer-panel portainer-onboarding"><header><div><span class="section-kicker">Connect once</span><h3>Add your first Portainer server</h3><p>Use the Portainer HTTPS address and an access token from a dedicated user limited to the environments Helmsman should monitor.</p></div></header><div class="portainer-onboarding__steps"><span><b>01</b><strong>Enter HTTPS and certificate trust</strong></span><span><b>02</b><strong>Paste a scoped access token</strong></span><span><b>03</b><strong>Test every read-only capability</strong></span></div><footer><button class="button button--primary" type="button" data-action="open-portainer-service">${icon("plus")} Connect Portainer</button></footer></section>`}

    <dl class="portainer-metrics" aria-label="Portainer inventory summary">
      <div class="portainer-metric"><dt>Portainer servers</dt><dd>${services.length}</dd><small>${services.filter(({ connectionState }) => connectionState === "connected").length} connected</small></div>
      <div class="portainer-metric"><dt>Environments online</dt><dd>${totals.environmentOnline} / ${totals.environments.length}</dd><small>Only token-permitted environments</small></div>
      <div class="portainer-metric"><dt>Containers running</dt><dd>${totals.running} / ${totals.containers.length}</dd><small>${totals.stopped} stopped or created</small></div>
      <div class="portainer-metric"><dt>Needs attention</dt><dd>${totals.unhealthy}</dd><small>${totals.stacks.length} visible stack${totals.stacks.length === 1 ? "" : "s"}</small></div>
    </dl>

    ${services.length ? `<section class="portainer-panel"><header><div><span class="section-kicker">Secure connections</span><h3>Portainer servers</h3><p>Each server keeps an independently encrypted, destination-bound access token.</p></div><span class="count-pill">${services.length}</span></header><div class="portainer-grid">${services.map(renderPortainerConnection).join("")}</div></section>` : ""}

    <section class="portainer-panel"><header><div><span class="section-kicker">Permitted scope</span><h3>Environments</h3><p>Docker and Podman environments expose container inventory. Kubernetes and Azure environments remain visible without unsupported container calls.</p></div><span class="count-pill">${totals.environments.length}</span></header>
      ${totals.environments.length ? `<div class="portainer-environment-grid">${totals.environments.map((environment) => `<article class="portainer-environment-card"><header><span class="portainer-environment-mark">${icon("server")}</span><span><small>${escapeHtml(environment.serverName)}</small><strong>${escapeHtml(environment.name)}</strong></span><span class="portainer-status is-${portainerEnvironmentTone(environment.state)}"><i class="health-dot is-${portainerEnvironmentTone(environment.state)}"></i>${escapeHtml(environment.state)}</span></header><dl class="portainer-summary-grid"><div><dt>Platform</dt><dd>${escapeHtml(environment.platform)}</dd></div><div><dt>Containers</dt><dd>${environmentContainerCounts.get(environment.key) || 0}</dd></div><div><dt>Agent</dt><dd>${escapeHtml(environment.agentVersion || "—")}</dd></div><div><dt>Connection</dt><dd>${environment.edge ? "Edge" : "Direct"}</dd></div></dl></article>`).join("")}</div>` : `<div class="empty-state"><strong>No permitted environments yet</strong><span>Connect Portainer or verify that its user can access at least one environment.</span></div>`}
    </section>

    <section class="portainer-panel"><header><div><span class="section-kicker">Container inventory</span><h3>Containers</h3><p>Stopped and exited containers are informational. Unhealthy, dead, and restarting containers are clearly flagged.</p></div><span class="count-pill">${filtered.containers.length}</span></header>
      <div class="portainer-notice">${icon("shield")}<span><strong>Guarded container controls</strong><small>Every command opens a Helmsman confirmation. Remove, recreate, force-kill, and stack deployment actions remain unavailable.</small></span></div>
      <div class="portainer-filterbar">
        <label><span>Server</span><select id="portainer-server-filter" data-portainer-filter="server"><option value="all">All Portainer servers</option>${services.map((service) => `<option value="${escapeHtml(service.id)}" ${filters.server === service.id ? "selected" : ""}>${escapeHtml(service.displayName)}</option>`).join("")}</select></label>
        <label><span>Environment</span><select id="portainer-environment-filter" data-portainer-filter="environment"><option value="all">All environments</option>${environments.map((environment) => `<option value="${escapeHtml(environment.key)}" ${filters.environment === environment.key ? "selected" : ""}>${escapeHtml(environment.name)} · ${escapeHtml(environment.serverName)}</option>`).join("")}</select></label>
        <label><span>State</span><select id="portainer-state-filter" data-portainer-filter="state"><option value="all">All states</option><option value="running" ${filters.state === "running" ? "selected" : ""}>Running</option><option value="stopped" ${filters.state === "stopped" ? "selected" : ""}>Stopped / created</option><option value="unhealthy" ${filters.state === "unhealthy" ? "selected" : ""}>Unhealthy</option><option value="restarting" ${filters.state === "restarting" ? "selected" : ""}>Restarting</option><option value="dead" ${filters.state === "dead" ? "selected" : ""}>Dead</option><option value="paused" ${filters.state === "paused" ? "selected" : ""}>Paused</option></select></label>
        <label class="filter-search"><span>Name, image, stack, or ID</span><input id="portainer-container-search" type="search" data-portainer-filter="search" value="${escapeHtml(filters.search)}" placeholder="Search containers" /></label>
        <span class="filter-result-count">${filtered.containers.length} result${filtered.containers.length === 1 ? "" : "s"}</span>
      </div>
      ${renderPortainerContainerGroups(filtered.containers)}
    </section>

    <section class="portainer-panel"><header><div><span class="section-kicker">Application groups</span><h3>Stacks</h3><p>Stack records are correlated to their visible Portainer environment.</p></div><span class="count-pill">${filtered.stacks.length}</span></header>${filtered.stacks.length ? `<div class="portainer-stack-grid">${filtered.stacks.map((stack) => `<article class="portainer-stack-card"><header><span class="portainer-environment-mark">${icon("library")}</span><span><small>${escapeHtml(stack.serverName)} · ${escapeHtml(stack.environmentName)}</small><strong>${escapeHtml(stack.name)}</strong></span><span class="portainer-status is-${stack.state === "active" ? "healthy" : "stale"}"><i class="health-dot is-${stack.state === "active" ? "healthy" : "stale"}"></i>${escapeHtml(stack.state)}</span></header><footer><span>Stack ${stack.id}</span><time>${escapeHtml(formatTime(stack.updatedAt || stack.createdAt, "Timestamp unavailable"))}</time></footer></article>`).join("")}</div>` : `<div class="empty-state"><strong>No visible stacks</strong><span>The configured Portainer users have not returned any stack records for this filter.</span></div>`}</section>
  </section>`;
}

function announcePortainerFilterResults() {
  if (!filterAnnouncer) return;
  const count = filteredPortainerInventory(portainerServicesForUi()).containers.length;
  const revision = ++filterAnnouncementRevision;
  filterAnnouncer.textContent = "";
  requestAnimationFrame(() => {
    if (revision === filterAnnouncementRevision) {
      filterAnnouncer.textContent = `${count} container result${count === 1 ? "" : "s"}`;
    }
  });
}

function renderAuthenticatedRoute() {
  if (state.workspace === "media") {
    if (state.route === "home") return renderMediaHome();
    if (state.route === "discover") return renderDiscoverPage();
    if (state.route === "library") return renderLibraryPage();
    if (state.route === "requests") return renderRequestsPage();
    if (state.route === "activity") return renderActivityPage();
    if (state.route === "calendar") return renderCalendarPage();
    if (state.route === "health") return renderMediaHealthPage();
    if (state.route === "connections") return renderServicesPage();
    if (state.route === "logs") return renderLogsPage();
    return renderSettingsPage();
  }
  if (state.route === "overview") {
    const infrastructure = configuredInfrastructureSnapshotForUi();
    const portainers = configuredPortainerServicesForUi();
    return renderInfrastructureOverview(snapshotForUi(), state.infrastructure.targets, {
      configuredOnly: true,
      portainerServices: portainers,
      overallState: combinedInfrastructureState(infrastructure, portainers),
      lastCheckedAt: latestInfrastructureCheck(infrastructure.targets, portainers)
    });
  }
  if (state.route === "connectors") return renderInfrastructureConnectorsPage();
  if (state.route === "incidents") return renderIncidentsPage();
  if (state.route === "proxmox") return renderProxmoxPage();
  if (state.route === "workloads") return renderInfrastructureWorkloadsPage();
  if (state.route === "portainer") return renderPortainerPage();
  if (state.route === "logs") return renderLogsPage();
  return renderSettingsPage();
}

function renderPage({ force = false, preserveFocus = false } = {}) {
  state.route = currentRoute();
  const canonicalHash = `#/${state.route}`;
  if (location.hash !== canonicalHash) location.replace(canonicalHash);
  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  pageTitle.textContent = ROUTE_TITLES[state.route] || "Overview";

  let markup;
  if (state.starting) markup = renderStarting();
  else if (state.fatalError) markup = renderFatal();
  else if (state.status?.setupRequired) markup = renderSetup();
  else if (!state.status?.authenticated) markup = state.status?.accessKeyConfigured ? renderAccessLogin() : renderAccessRecovery();
  else markup = renderAuthenticatedRoute();

  if (!force && markup === state.lastMarkup) return;
  const focusedReference = preserveFocus ? focusReference(document.activeElement) : null;
  const documentScrollTop = preserveFocus
    ? Number(globalThis.scrollY ?? document.documentElement?.scrollTop ?? document.body?.scrollTop ?? 0)
    : 0;
  state.lastMarkup = markup;
  setMarkup(main, markup);
  if (preserveFocus) resolveFocusReference(focusedReference, main)?.focus({ preventScroll: true });
  if (preserveFocus && Number.isFinite(documentScrollTop)) {
    if (typeof globalThis.scrollTo === "function") globalThis.scrollTo({ top: documentScrollTop, left: 0, behavior: "instant" });
    else if (document.documentElement) document.documentElement.scrollTop = documentScrollTop;
  }
  applyMediaFiltersInPlace();
  updateChrome();
}

function resetRouteScroll() {
  if (typeof globalThis.scrollTo === "function") {
    globalThis.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return;
  }
  if (document.documentElement) document.documentElement.scrollTop = 0;
  if (document.body) document.body.scrollTop = 0;
}

const WORKSPACE_STATE_PRIORITY = Object.freeze({
  down: 0,
  "auth-required": 1,
  "authentication-required": 1,
  degraded: 2,
  limited: 3,
  stale: 4,
  checking: 5,
  healthy: 6,
  disabled: 7
});

function combinedInfrastructureState(infrastructure, portainers) {
  const states = [
    ...infrastructure.targets
      .filter((target) => target.enabled !== false && target.monitoringEnabled !== false)
      .map((target) => statusClass(target.state)),
    ...portainers
      .filter((service) => service.enabled !== false && service.monitoringEnabled !== false)
      .map((service) => statusClass(service.state))
  ];
  return states.sort((left, right) => (
    (WORKSPACE_STATE_PRIORITY[left] ?? 99) - (WORKSPACE_STATE_PRIORITY[right] ?? 99)
  ))[0] || "disabled";
}

function latestInfrastructureCheck(targets, portainers) {
  return [
    ...targets.map(({ lastCheckedAt }) => lastCheckedAt),
    ...portainers.map(({ checkedAt }) => checkedAt)
  ].filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function updateChrome() {
  const normalized = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  const infrastructure = configuredInfrastructureSnapshotForUi();
  const portainers = configuredPortainerServicesForUi();
  const infrastructureWorkspace = state.workspace === "infrastructure";
  const navigationAvailability = {
    proxmox: state.infrastructure.targets.length > 0,
    portainer: normalizedPortainerConfigurations().length > 0
  };
  const count = normalized.incidents.filter(({ scope, service }) => (
    scope !== "infrastructure" && !/^(?:proxmox|portainer)(?:-|$)/u.test(String(service || ""))
  )).length;
  const infrastructureCount = normalized.incidents.filter(({ scope }) => scope === "infrastructure").length;
  incidentCount.textContent = String(count);
  incidentCount.hidden = count === 0;
  const overall = infrastructureWorkspace ? combinedInfrastructureState(infrastructure, portainers) : normalized.overall.state;
  if (pageEyebrow) pageEyebrow.textContent = infrastructureWorkspace ? "Infrastructure" : "Media operations";
  document.documentElement?.setAttribute?.("data-workspace", state.workspace);
  document.querySelectorAll("[data-action='switch-workspace']").forEach((button) => {
    const active = button.dataset.workspace === state.workspace;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll(".workspace-media-only").forEach((element) => {
    element.hidden = infrastructureWorkspace;
  });
  document.querySelectorAll(".workspace-infrastructure-only").forEach((element) => {
    const requiredService = element.dataset.serviceNav;
    element.hidden = !infrastructureWorkspace
      || (Boolean(requiredService) && navigationAvailability[requiredService] !== true);
  });
  const workspaceHome = `#/${workspaceLandingRoute(state.workspace)}`;
  document.querySelectorAll(".brand, .mobile-brand").forEach((link) => {
    link.setAttribute("href", workspaceHome);
    link.setAttribute("aria-label", infrastructureWorkspace ? "Helmsman infrastructure overview" : "Helmsman media home");
  });
  document.querySelectorAll("[data-infrastructure-incident-count]").forEach((element) => {
    element.textContent = String(infrastructureCount);
    element.hidden = infrastructureCount === 0;
  });
  modeBadge.textContent = state.status?.authenticated ? statusLabel(overall) : "Local container";
  modeBadge.dataset.state = statusClass(overall);
  monitorSummary.setAttribute("href", infrastructureWorkspace ? "#/incidents" : "#/health");
  monitorSummary.setAttribute("aria-label", infrastructureWorkspace ? "Open infrastructure incidents" : "Open media health");
  const time = infrastructureWorkspace ? latestInfrastructureCheck(infrastructure.targets, portainers) : state.snapshot?.generatedAt;
  const summaryText = state.refreshing
    ? infrastructureWorkspace ? "Checking infrastructure…" : "Checking services…"
    : `Last ${infrastructureWorkspace ? "infrastructure" : "container"} check ${formatTime(time, "pending")}`;
  const monitorDot = monitorSummary.querySelector(".health-dot, .pulse-dot");
  const monitorText = monitorSummary.querySelector("span:last-child");
  if (monitorDot && monitorText) {
    monitorDot.className = `health-dot is-${statusClass(overall)}`;
    monitorText.textContent = summaryText;
  } else {
    setMarkup(monitorSummary, `<span class="health-dot is-${statusClass(overall)}" aria-hidden="true"></span><span>${escapeHtml(summaryText)}</span>`);
  }
  const initials = String(state.status?.session?.name || "HM").split(/\s+/u).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "HM";
  sessionButton.querySelector("span").textContent = initials;
  applySidebarState();
}

function formatAssessmentTime(value, fallback = "Waiting for data") {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return fallback;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function updateTimeElement(element, value, fallback, formatter = formatTime) {
  if (!element) return;
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    element.removeAttribute("datetime");
    element.textContent = fallback;
    return;
  }
  element.setAttribute("datetime", date.toISOString());
  element.textContent = formatter(value, fallback);
}

function updateOverviewVolatile(snapshot) {
  updateTimeElement(
    main.querySelector(".operations-overall__facts > div:nth-child(3) dd time"),
    snapshot.generatedAt,
    "Waiting for data",
    formatAssessmentTime
  );

  const incidentRows = [...main.querySelectorAll(".operations-incidents__list .operations-incident")];
  snapshot.incidents.forEach((incident, index) => {
    const row = incidentRows[index];
    if (!row) return;
    const occurrence = [...row.querySelectorAll(".operations-evidence li")]
      .find((entry) => /^Observed \d+ times$/u.test(entry.textContent));
    if (occurrence && incident.occurrenceCount > 1) {
      occurrence.textContent = `Observed ${incident.occurrenceCount} times`;
    }
    updateTimeElement(
      row.querySelector("footer span:nth-child(2) time"),
      incident.lastSeen,
      "not recorded",
      formatAssessmentTime
    );
  });

  const serviceRows = [...main.querySelectorAll(".operations-services__list .operations-service")];
  snapshot.services.forEach((service, index) => {
    const facts = serviceRows[index]?.querySelector(".operations-service__copy em");
    if (!facts) return;
    const values = [];
    if (service.latencyMs !== null) values.push(`${service.latencyMs} ms`);
    if (service.version) values.push(`v${service.version}`);
    if (!values.length && service.lastCheckedAt) values.push("Checked");
    facts.textContent = values.join(" · ");
  });

  const workloadValues = [...main.querySelectorAll(".operations-workload__metric strong")];
  snapshot.workload.forEach((metric, index) => {
    if (workloadValues[index]) workloadValues[index].textContent = metric.value.toLocaleString();
  });

  const pipelineCounts = [...main.querySelectorAll(".operations-pipeline__stage > em")];
  snapshot.pipeline.filter((stage) => stage.count !== null).forEach((stage, index) => {
    const element = pipelineCounts[index];
    if (!element) return;
    element.textContent = String(stage.count);
    element.setAttribute("aria-label", `${stage.count} items`);
  });
}

function updateIncidentsVolatile(snapshot) {
  const tables = [...main.querySelectorAll(".incident-table")];
  const openRows = tables[0] ? [...tables[0].querySelectorAll(".incident-row")] : [];
  snapshot.incidents.forEach((incident, index) => {
    const row = openRows[index];
    if (!row) return;
    const evidence = row.querySelector("small");
    if (evidence) {
      evidence.textContent = `${incident.code || statusLabel(incident.state)}${incident.status ? ` · HTTP ${incident.status}` : ""} · ${incident.occurrenceCount} occurrence${incident.occurrenceCount === 1 ? "" : "s"}`;
    }
    updateTimeElement(row.querySelector("time"), incident.lastSeen, "Not yet");
  });

  const recoveredRows = tables[1] ? [...tables[1].querySelectorAll(".incident-row")] : [];
  snapshot.recentRecoveries.forEach((recovery, index) => {
    const row = recoveredRows[index];
    if (!row) return;
    const evidence = row.querySelector("small");
    if (evidence) evidence.textContent = `${recovery.occurrenceCount} recorded occurrence${recovery.occurrenceCount === 1 ? "" : "s"}`;
    updateTimeElement(row.querySelector("time"), recovery.recoveredAt, "Not yet");
  });
}

function updatePipelineVolatile(snapshot) {
  const counts = [...main.querySelectorAll(".pipeline-card > strong")];
  snapshot.pipeline.filter((stage) => stage.count !== null).forEach((stage, index) => {
    if (counts[index]) counts[index].textContent = String(stage.count);
  });
}

function setMediaProgress(element, item) {
  for (const progress of element.querySelectorAll?.("[data-media-progress]") || []) {
    const value = item.progress ?? 0;
    progress.value = value;
    progress.setAttribute?.("value", String(value));
    progress.textContent = `${value}%`;
  }
  for (const label of element.querySelectorAll?.("[data-media-progress-label]") || []) {
    label.textContent = item.progress === null ? "—" : `${item.progress}%${label.dataset?.mediaProgressSuffix || ""}`;
  }
  for (const speed of element.querySelectorAll?.("[data-media-speed]") || []) {
    speed.textContent = formatMediaSpeed(item.downloadSpeedBps);
  }
  for (const eta of element.querySelectorAll?.("[data-media-eta]") || []) {
    eta.textContent = formatMediaEta(item.etaSeconds);
  }
}

function updateMediaVolatileUi() {
  const media = mediaSnapshotForUi();
  if (!media.present) return;
  const byKey = new Map(media.all.map((item) => [item.key, item]));
  for (const element of main.querySelectorAll?.("[data-media-key]") || []) {
    const item = byKey.get(element.dataset?.mediaKey);
    if (item) setMediaProgress(element, item);
  }
  if (drawerLayer?.classList.contains("is-open") && state.media.selectedId) {
    const item = media.all.find((entry) => entry.id === state.media.selectedId);
    if (item) setMediaProgress(drawerLayer, item);
  }
}

function mediaFilterMatches(element) {
  const route = state.route;
  const title = String(element.dataset?.mediaTitle || "");
  const type = String(element.dataset?.mediaType || "");
  const itemState = String(element.dataset?.mediaState || "");
  if (route === "discover") return !state.media.filters.discover || title.includes(state.media.filters.discover.toLowerCase());
  if (route === "library") {
    const wantedType = state.media.filters.libraryType;
    const typeMatch = wantedType === "all" || wantedType === type || wantedType === "series" && ["show", "episode"].includes(type);
    return typeMatch && (!state.media.filters.library || title.includes(state.media.filters.library.toLowerCase()));
  }
  if (route === "requests") {
    const wanted = state.media.filters.requests;
    return wanted === "all" || wanted === itemState;
  }
  if (route === "activity") return state.media.filters.activity === "all" || state.media.filters.activity === itemState;
  return true;
}

function applyMediaFiltersInPlace() {
  if (state.workspace !== "media" || !["discover", "library", "requests", "activity"].includes(state.route)) return;
  const items = [...(main.querySelectorAll?.("[data-media-filter-item]") || [])];
  let visible = 0;
  items.forEach((element) => {
    const matches = mediaFilterMatches(element);
    element.hidden = !matches;
    if (matches) visible += 1;
  });
  const count = main.querySelector?.("[data-media-result-count]");
  if (count) count.textContent = `${visible} ${state.route === "requests" ? visible === 1 ? "request" : "requests" : visible === 1 ? "result" : "results"}`;
}

function updateServiceModalVolatile(snapshot) {
  const form = modalLayer.querySelector("#service-form");
  const service = snapshot.services.find((entry) => entry.id === form?.dataset?.serviceId);
  const health = modalLayer.querySelector(".service-health-inline");
  if (!service) return;
  const reportRegion = modalLayer.querySelector("[data-monitor-reports]");
  if (reportRegion) {
    const reports = service.capabilities.flatMap((capability) => capability.reports).slice(0, 12);
    const fingerprint = reportFingerprint(reports);
    if (reportRegion.dataset.reportFingerprint !== fingerprint) {
      setMarkup(reportRegion, renderOperationsReports(reports, service.name));
      reportRegion.dataset.reportFingerprint = fingerprint;
    }
    reportRegion.hidden = reports.length === 0;
  }
  if (!health) return;
  const dot = health.querySelector("[data-monitor-dot]");
  const label = health.querySelector("[data-monitor-state]");
  const latency = health.querySelector("[data-monitor-latency]");
  const checkedAt = health.querySelector("[data-monitor-checked]");
  if (dot) dot.className = `health-dot is-${savedMonitorTone(service)}`;
  if (label) label.textContent = savedMonitorLabel(service);
  if (latency) latency.textContent = service.latencyMs === null ? "" : `${service.latencyMs} ms`;
  updateTimeElement(checkedAt, service.lastCheckedAt, "Not yet");
}

function infrastructureTargetFacts(target) {
  const facts = [];
  if (target.metrics.nodesOnline !== null) {
    facts.push(`${target.metrics.nodesOnline}${target.metrics.nodeTotal === null ? "" : `/${target.metrics.nodeTotal}`} nodes online`);
  }
  if (target.metrics.guestsRunning !== null) facts.push(`${target.metrics.guestsRunning} guests running`);
  if (target.version) facts.push(`PVE ${target.version}`);
  if (target.latencyMs !== null) facts.push(`${target.latencyMs} ms`);
  return facts;
}

function setInfrastructureMetric(name, value) {
  const element = main.querySelector(`[data-infrastructure-metric='${name}']`);
  if (element) element.textContent = value;
}

function setInfrastructureDetail(name, value) {
  const element = main.querySelector(`[data-infrastructure-detail='${name}']`);
  if (element) element.textContent = value;
}

function formatMetricBytes(value) {
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

function formatMetricRatio(used, total) {
  if (used === null || total === null || total === 0) return "Waiting";
  return `${Math.min(100, Math.round((used / total) * 1_000) / 10).toLocaleString()}%`;
}

function formatMetricDuration(seconds) {
  if (seconds === null) return "Waiting";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function updateInfrastructureModalVolatile(snapshot) {
  const form = modalLayer.querySelector("#proxmox-form");
  const targetId = form?.dataset?.infrastructureTargetId;
  if (!targetId) return;
  const target = snapshot.targets.find((entry) => entry.id === targetId);
  if (!target) return;
  const dot = modalLayer.querySelector("[data-infrastructure-monitor-dot]");
  const label = modalLayer.querySelector("[data-infrastructure-monitor-state]");
  const facts = modalLayer.querySelector("[data-infrastructure-monitor-facts]");
  const checked = modalLayer.querySelector("[data-infrastructure-monitor-checked]");
  if (dot) dot.className = `health-dot is-${statusClass(target.state)}`;
  if (label) label.textContent = statusLabel(target.state);
  if (facts) facts.textContent = infrastructureTargetFacts(target).filter((entry) => !entry.includes("nodes online") && !entry.includes("guests running")).join(" · ");
  updateTimeElement(checked, target.lastCheckedAt, "Not yet");
  const capabilityRegion = modalLayer.querySelector("[data-infrastructure-saved-capabilities]");
  if (capabilityRegion) {
    const fingerprint = infrastructureCapabilitiesFingerprint(target);
    if (capabilityRegion.dataset.capabilityFingerprint !== fingerprint) {
      setMarkup(capabilityRegion, renderInfrastructureSavedEvidence(target));
      capabilityRegion.dataset.capabilityFingerprint = fingerprint;
    }
    capabilityRegion.hidden = !target.capabilities.length && !target.reports.length;
  }
}

function updateInfrastructureVolatile() {
  const snapshot = configuredInfrastructureSnapshotForUi();
  if (state.workspace === "infrastructure" && state.route === "overview") {
    const configuredTargets = configuredInfrastructureTargetsForUi();
    const portainers = configuredPortainerServicesForUi();
    const affectedConnections = [...configuredTargets, ...portainers]
      .filter(({ state: connectionState }) => !["healthy", "disabled"].includes(statusClass(connectionState))).length;
    const nodes = snapshot.metrics.nodesOnline === null
      ? "Waiting"
      : `${snapshot.metrics.nodesOnline}${snapshot.metrics.nodeTotal === null ? "" : ` / ${snapshot.metrics.nodeTotal}`}`;
    setInfrastructureMetric("connections", String(configuredTargets.length + portainers.length));
    setInfrastructureMetric("attention", String(affectedConnections));
    setInfrastructureMetric("guests-running-signal", snapshot.metrics.guestsRunning === null ? "Waiting" : snapshot.metrics.guestsRunning.toLocaleString());
    setInfrastructureMetric("nodes", nodes);
    setInfrastructureMetric("node-cpu", snapshot.metrics.nodeCpuPercent === null ? "Waiting" : `${snapshot.metrics.nodeCpuPercent.toLocaleString()}%`);
    setInfrastructureMetric("node-memory", formatMetricRatio(snapshot.metrics.nodeMemoryUsedBytes, snapshot.metrics.nodeMemoryTotalBytes));
    setInfrastructureMetric("storage", snapshot.metrics.storagePercent === null ? "Waiting" : `${snapshot.metrics.storagePercent.toLocaleString()}%`);
    setInfrastructureMetric("failed-tasks", snapshot.metrics.failedTasks === null ? "Waiting" : snapshot.metrics.failedTasks.toLocaleString());
    setInfrastructureMetric("backup-issues", snapshot.metrics.backupIssues === null ? "Waiting" : snapshot.metrics.backupIssues.toLocaleString());
    setInfrastructureDetail("guests", snapshot.metrics.guestTotal === null
      ? "VM and container inventory"
      : `${snapshot.metrics.virtualMachineTotal ?? 0} VM · ${snapshot.metrics.containerTotal ?? 0} LXC · ${snapshot.metrics.guestsStopped ?? 0} stopped`);
    setInfrastructureDetail("node-memory", snapshot.metrics.nodeMemoryUsedBytes === null
      ? "Aggregate use"
      : `${formatMetricBytes(snapshot.metrics.nodeMemoryUsedBytes)} used`);
    setInfrastructureDetail("storage", snapshot.metrics.storageWarnings
      ? `${snapshot.metrics.storageWarnings} unavailable storage entr${snapshot.metrics.storageWarnings === 1 ? "y" : "ies"}`
      : snapshot.metrics.storageUsedBytes !== null && snapshot.metrics.storageTotalBytes !== null
        ? `${formatMetricBytes(snapshot.metrics.storageUsedBytes)} of ${formatMetricBytes(snapshot.metrics.storageTotalBytes)}`
        : "Across active storage");
    setInfrastructureDetail("backups", snapshot.metrics.lastBackupSuccessAgeSeconds === null
      ? "No successful-backup age reported"
      : `Last success ${formatMetricDuration(snapshot.metrics.lastBackupSuccessAgeSeconds)} ago`);
    const checked = main.querySelector("[data-infrastructure-checked] time");
    updateTimeElement(checked, latestInfrastructureCheck(snapshot.targets, portainers), "Waiting for data", formatAssessmentTime);
    for (const element of main.querySelectorAll("[data-infrastructure-target-id]")) {
      const target = snapshot.targets.find((entry) => entry.id === element.dataset.infrastructureTargetId);
      const facts = element.querySelector("[data-infrastructure-target-facts]");
      if (target && facts) facts.textContent = infrastructureTargetFacts(target).join(" · ");
    }
  }
  if (state.workspace === "infrastructure" && ["services", "environments"].includes(state.route)) {
    for (const element of main.querySelectorAll("[data-infrastructure-target-id]")) {
      const target = snapshot.targets.find((entry) => entry.id === element.dataset.infrastructureTargetId);
      const facts = element.querySelector("[data-infrastructure-card-facts]");
      if (!target || !facts) continue;
      facts.textContent = infrastructureTargetFacts(target).join(" · ")
        || (target.credentialConfigured ? "Credential protected" : "Credential missing");
    }
  }
  updateInfrastructureModalVolatile(snapshot);
}

function portainerEvidenceFingerprint(service) {
  return JSON.stringify({
    reports: service?.reports || [],
    capabilities: (service?.capabilities || []).map(({ id, label, state: checkState, code, status, reports }) => ({
      id,
      label,
      state: checkState,
      code,
      status,
      reports
    }))
  });
}

function updatePortainerVolatile() {
  const services = portainerServicesForUi();
  if (state.workspace === "infrastructure" && state.route === "portainer") {
    for (const card of main.querySelectorAll("article[data-portainer-service-id]")) {
      const service = services.find(({ id }) => id === card.dataset.portainerServiceId);
      if (!service) continue;
      const status = card.querySelector(".portainer-status");
      if (status) {
        status.className = `portainer-status is-${statusClass(service.state)}`;
        setMarkup(status, `<i class="health-dot is-${statusClass(service.state)}"></i>${escapeHtml(portainerConnectionLabel(service))}`);
      }
      const facts = card.querySelector("[data-portainer-card-facts]");
      if (facts) facts.textContent = [
        service.version ? `Portainer ${service.version}` : "Version pending",
        service.latencyMs === null ? "Latency pending" : `${service.latencyMs} ms`,
        `${service.metrics.environmentOnline}/${service.metrics.environmentTotal} environments online`,
        `${service.metrics.containerRunning}/${service.metrics.containerTotal} containers running`
      ].join(" · ");
      updateTimeElement(card.querySelector("[data-portainer-card-checked]"), service.checkedAt, "after the next monitoring cycle");
    }
  }
  const form = modalLayer.querySelector("#portainer-form");
  const service = services.find(({ id }) => id === form?.dataset?.portainerServiceId);
  if (!form || !service) return;
  const dot = form.querySelector("[data-portainer-monitor-dot]");
  const label = form.querySelector("[data-portainer-monitor-state]");
  const facts = form.querySelector("[data-portainer-monitor-facts]");
  if (dot) dot.className = `health-dot is-${statusClass(service.state)}`;
  if (label) label.textContent = portainerConnectionLabel(service);
  if (facts) facts.textContent = [
    service.version ? `Portainer ${service.version}` : "",
    service.latencyMs === null ? "" : `${service.latencyMs} ms`
  ].filter(Boolean).join(" · ");
  updateTimeElement(form.querySelector("[data-portainer-monitor-checked]"), service.checkedAt, "Not yet");
  const evidence = form.querySelector("[data-portainer-saved-capabilities]");
  if (evidence) {
    const fingerprint = portainerEvidenceFingerprint(service);
    if (evidence.dataset.capabilityFingerprint !== fingerprint) {
      const reports = [
        ...service.reports,
        ...service.capabilities.flatMap((check) => check.reports)
      ].slice(0, 12);
      setMarkup(evidence, `${renderOperationsReports(reports, service.displayName)}${renderConnectionCapabilities(portainerCapabilitiesResult(service))}`);
      evidence.dataset.capabilityFingerprint = fingerprint;
    }
    evidence.hidden = !service.capabilities.length && !service.reports.length;
  }
}

function updateVolatileOperationsUi() {
  const snapshot = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  if (state.workspace === "media" && (state.route === "health" || state.route === "home" && !state.snapshot?.media)) {
    updateOverviewVolatile(normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []));
  }
  if (state.workspace === "infrastructure" && state.route === "incidents") updateIncidentsVolatile(snapshot);
  updateMediaVolatileUi();
  updateServiceModalVolatile(snapshot);
  updateInfrastructureVolatile();
  updatePortainerVolatile();
  // Keep the render cache aligned with the DOM values patched above so a
  // later no-op render cannot resurrect an older timestamp or latency.
  state.lastMarkup = renderAuthenticatedRoute();
  updateChrome();
}

function controlConfirmationPresentation(operation) {
  return {
    start: { title: "Start this workload?", confirmLabel: "Start" },
    restart: { title: "Restart this container?", confirmLabel: "Restart" },
    stop: { title: "Stop this container?", confirmLabel: "Stop", tone: "danger" },
    reboot: { title: "Reboot this workload?", confirmLabel: "Reboot" },
    shutdown: { title: "Shut down this workload?", confirmLabel: "Shut down", tone: "danger" },
    retryRequest: { title: "Retry this request?", confirmLabel: "Retry request" },
    searchMovie: { title: "Search Radarr again?", confirmLabel: "Search Radarr" },
    searchSeries: { title: "Search Sonarr again?", confirmLabel: "Search Sonarr" }
  }[operation] || { title: "Confirm this action?", confirmLabel: "Continue" };
}

function closeControlConfirmation(confirmed = false, { restoreFocus = true } = {}) {
  const resolver = state.confirmationResolver;
  if (!resolver) return false;
  const returnFocus = state.confirmationReturnFocus;
  state.confirmationResolver = null;
  state.confirmationReturnFocus = null;
  controlConfirmLayer.classList.remove("is-open");
  controlConfirmLayer.setAttribute("aria-hidden", "true");
  setMarkup(controlConfirmLayer, "");
  const modalOpen = modalLayer?.classList.contains("is-open");
  const drawerOpen = drawerLayer?.classList.contains("is-open");
  if (modalLayer) {
    modalLayer.inert = false;
    modalLayer.setAttribute("aria-hidden", modalOpen ? "false" : "true");
  }
  if (drawerLayer) {
    drawerLayer.inert = false;
    drawerLayer.setAttribute("aria-hidden", drawerOpen ? "false" : "true");
  }
  if (appShell) appShell.inert = Boolean(modalOpen || drawerOpen);
  if (!modalOpen && !drawerOpen) document.body.classList.remove("has-overlay");
  if (restoreFocus) {
    const root = modalOpen ? modalLayer : drawerOpen ? drawerLayer : main;
    restoreFocusReference(returnFocus, root);
  }
  resolver(Boolean(confirmed));
  return true;
}

function confirmControl({ title, message, confirmLabel = "Continue", tone = "default" }) {
  if (!controlConfirmLayer || state.confirmationResolver) return Promise.resolve(false);
  const safeTone = tone === "danger" ? "danger" : "default";
  state.confirmationReturnFocus = focusReference(document.activeElement);
  setMarkup(controlConfirmLayer, `<div class="control-confirm-backdrop" data-action="cancel-control-confirm"></div><section class="standard-modal control-confirm-modal is-${safeTone}" role="alertdialog" aria-modal="true" aria-labelledby="control-confirm-title" aria-describedby="control-confirm-description"><div class="large-modal-icon ${safeTone === "danger" ? "is-danger" : ""}">${icon(safeTone === "danger" ? "shield" : "check")}</div><span class="section-kicker">Helmsman confirmation</span><h2 id="control-confirm-title">${escapeHtml(title)}</h2><p id="control-confirm-description">${escapeHtml(message)}</p><div class="modal-button-row"><button class="button" id="control-confirm-cancel" type="button" data-action="cancel-control-confirm">Cancel</button><button class="button ${safeTone === "danger" ? "button--danger" : "button--primary"}" type="button" data-action="approve-control-confirm">${escapeHtml(confirmLabel)}</button></div></section>`);
  controlConfirmLayer.classList.add("is-open");
  controlConfirmLayer.setAttribute("aria-hidden", "false");
  if (modalLayer?.classList.contains("is-open")) {
    modalLayer.inert = true;
    modalLayer.setAttribute("aria-hidden", "true");
  }
  if (drawerLayer?.classList.contains("is-open")) {
    drawerLayer.inert = true;
    drawerLayer.setAttribute("aria-hidden", "true");
  }
  if (appShell) appShell.inert = true;
  document.body.classList.add("has-overlay");
  return new Promise((resolve) => {
    state.confirmationResolver = resolve;
    requestAnimationFrame(() => controlConfirmLayer.querySelector("#control-confirm-cancel")?.focus());
  });
}

function openModal(markup, focusSelector) {
  const returnFocus = drawerLayer?.classList.contains("is-open")
    ? state.media.drawerReturnFocus
    : focusReference(document.activeElement);
  if (drawerLayer?.classList.contains("is-open")) closeMediaDrawer({ restoreFocus: false });
  state.modalReturnFocus = returnFocus;
  setMarkup(modalLayer, `<div class="modal-backdrop" data-action="close-modal"></div>${markup}`);
  modalLayer.classList.add("is-open");
  modalLayer.setAttribute("aria-hidden", "false");
  if (appShell) appShell.inert = true;
  document.body.classList.add("has-overlay");
  requestAnimationFrame(() => modalLayer.querySelector(focusSelector || "button, input")?.focus());
}

function closeModal({ restoreFocus = true } = {}) {
  closeControlConfirmation(false, { restoreFocus: false });
  modalLayer.classList.remove("is-open");
  modalLayer.setAttribute("aria-hidden", "true");
  if (appShell) appShell.inert = false;
  document.body.classList.remove("has-overlay");
  setMarkup(modalLayer, "");
  const returnFocus = state.modalReturnFocus;
  state.modalReturnFocus = null;
  if (restoreFocus) restoreFocusReference(returnFocus, main);
}

function safeAuthMode(value) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(candidate) ? candidate : "";
}

function serviceAuthOptions(service) {
  const options = [];
  const seen = new Set();
  for (const rawOption of Array.isArray(service.authOptions) ? service.authOptions.slice(0, 8) : []) {
    const id = safeAuthMode(rawOption?.id);
    const input = rawOption?.input === "login" ? "login" : rawOption?.input === "secret" ? "secret" : "";
    if (!id || !input || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      input,
      label: safeSessionText(rawOption.label, input === "login" ? "Username + password" : "API credential", 80),
      credentialLabel: safeSessionText(rawOption.credentialLabel, service.credentialLabel || "Credential", 80),
      identityLabel: safeSessionText(rawOption.identityLabel, service.id === "seerr" ? "Seerr account email" : "Username", 80),
      hint: safeSessionText(rawOption.hint, service.credentialHint || "Enter the credential issued by this service.", 240)
    });
  }
  if (options.length) return options;
  const fallbackMode = safeAuthMode(service.authMode) || (service.id === "jellyfin" ? "token" : "apiKey");
  return [{
    id: fallbackMode,
    input: "secret",
    label: safeSessionText(service.credentialLabel, "API credential", 80),
    credentialLabel: safeSessionText(service.credentialLabel, "Credential", 80),
    identityLabel: "Username",
    hint: safeSessionText(service.credentialHint, "Enter the credential issued by this service.", 240)
  }];
}

function selectedServiceAuthMode(service, options) {
  const configured = safeAuthMode(service.authMode);
  return options.some((option) => option.id === configured) ? configured : options[0].id;
}

function authPanelId(service, option) {
  const servicePart = safeCapabilityId(service.id) || "service";
  return `service-${servicePart}-auth-${option.id.toLowerCase()}`;
}

function oneTimeLoginCopy(service) {
  if (service.id === "seerr") {
    return "Use a local Seerr account for this one-time exchange. The password is discarded immediately; only the resulting encrypted session credential is retained.";
  }
  if (service.id === "jellyfin") {
    return "The username and password are used for one exchange only. The password is discarded immediately; only the resulting encrypted access token is retained.";
  }
  return "The account password is used for one exchange only and is discarded immediately after a service credential is obtained.";
}

function renderServiceAuthPanel(service, option, selected, canRetain) {
  const panelId = authPanelId(service, option);
  const initiallyRequired = selected && !canRetain;
  if (option.input === "login") {
    const identityId = `${panelId}-identity`;
    const passwordId = `${panelId}-password`;
    const identityPlaceholder = service.id === "seerr" ? "name@example.com" : "Enter Jellyfin username";
    return `<div class="service-auth-panel" id="${panelId}" data-auth-panel data-auth-mode="${escapeHtml(option.id)}" data-auth-input="login" ${selected ? "" : "hidden"}>
      <div class="auth-login-grid">
        <label for="${identityId}"><span>${escapeHtml(option.identityLabel)}</span><input id="${identityId}" name="username" type="${service.id === "seerr" ? "email" : "text"}" autocomplete="username" autocapitalize="off" spellcheck="false" data-new-placeholder="${escapeHtml(identityPlaceholder)}" data-saved-placeholder="Blank keeps the saved credential" placeholder="${canRetain ? "Blank keeps the saved credential" : escapeHtml(identityPlaceholder)}" ${selected ? "" : "disabled"} ${initiallyRequired ? "required" : ""}/></label>
        <label for="${passwordId}"><span>Password</span><input id="${passwordId}" name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" data-new-placeholder="Enter account password" data-saved-placeholder="Blank keeps the saved credential" placeholder="${canRetain ? "Blank keeps the saved credential" : "Enter account password"}" ${selected ? "" : "disabled"} ${initiallyRequired ? "required" : ""}/></label>
      </div>
      <small class="auth-option-hint">${escapeHtml(option.hint)}</small>
      <div class="auth-exchange-note">${icon("lock")}<span><strong>One-time sign-in exchange</strong><small>${escapeHtml(oneTimeLoginCopy(service))}</small></span></div>
    </div>`;
  }
  const credentialId = `${panelId}-credential`;
  return `<div class="service-auth-panel" id="${panelId}" data-auth-panel data-auth-mode="${escapeHtml(option.id)}" data-auth-input="secret" ${selected ? "" : "hidden"}>
    <label for="${credentialId}"><span>${escapeHtml(option.credentialLabel)}</span><input id="${credentialId}" name="credential" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" data-new-placeholder="Enter credential" data-saved-placeholder="Blank keeps the saved credential" placeholder="${canRetain ? "Blank keeps the saved credential" : "Enter credential"}" ${selected ? "" : "disabled"} ${initiallyRequired ? "required" : ""}/><small>${escapeHtml(option.hint)}</small></label>
  </div>`;
}

function renderServiceAuthentication(service) {
  const options = serviceAuthOptions(service);
  const selectedMode = selectedServiceAuthMode(service, options);
  const canRetain = Boolean(service.configured && service.credentialConfigured && selectedMode === service.authMode);
  return `<fieldset class="auth-method-fieldset">
    <legend>Authentication method</legend>
    <div class="auth-mode-grid">${options.map((option) => {
      const selected = option.id === selectedMode;
      return `<label class="option-card-v5" for="${authPanelId(service, option)}-choice"><input id="${authPanelId(service, option)}-choice" name="authMode" type="radio" value="${escapeHtml(option.id)}" aria-controls="${authPanelId(service, option)}" aria-expanded="${selected ? "true" : "false"}" ${selected ? "checked" : ""}/><span><strong>${escapeHtml(option.label)}</strong><small>${option.input === "login" ? "One-time account exchange" : "Enter a token or API credential directly"}</small></span></label>`;
    }).join("")}</div>
  </fieldset>
  <div class="service-auth-panels">${options.map((option) => renderServiceAuthPanel(service, option, option.id === selectedMode, canRetain)).join("")}</div>
  <p class="auth-retention-note" data-auth-retention>${canRetain
    ? "The encrypted credential is retained only while this service URL and authentication method stay unchanged. Leave the active fields blank to keep it."
    : "Enter authentication details for this service URL and method."}</p>`;
}

function comparableServiceUrl(value) {
  const candidate = String(value || "").trim();
  try {
    const parsed = new URL(candidate);
    const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
    const embeddedIdentity = parsed.username || parsed.password ? `${parsed.username}:${parsed.password}@` : "";
    return `${parsed.protocol}//${embeddedIdentity}${parsed.host}${basePath}${parsed.search}${parsed.hash}`;
  } catch {
    return candidate;
  }
}

function selectedAuthModeForForm(form, data) {
  return safeAuthMode(data?.get("authMode"))
    || safeAuthMode(form.querySelector("input[name='authMode']:checked")?.value)
    || safeAuthMode(form.dataset.authMode)
    || safeAuthMode(form.dataset.originalAuthMode)
    || (form.dataset.serviceId === "jellyfin" ? "token" : "apiKey");
}

function syncServiceAuthFields(form) {
  if (!form) return;
  const mode = selectedAuthModeForForm(form);
  const panels = [...form.querySelectorAll("[data-auth-panel]")];
  const activePanel = panels.find((panel) => panel.dataset.authMode === mode);
  const originalUrl = comparableServiceUrl(form.dataset.originalUrl);
  const draftUrl = comparableServiceUrl(form.querySelector("input[name='url']")?.value);
  const canRetain = form.dataset.credentialConfigured === "true"
    && mode === form.dataset.originalAuthMode
    && draftUrl === originalUrl;

  for (const radio of form.querySelectorAll("input[name='authMode']")) {
    radio.setAttribute("aria-expanded", radio.value === mode ? "true" : "false");
  }
  for (const panel of panels) {
    const active = panel === activePanel;
    panel.hidden = !active;
    const inputs = [...panel.querySelectorAll("input")];
    for (const input of inputs) {
      input.disabled = !active;
      input.required = false;
      if (active && input.dataset.newPlaceholder) {
        input.placeholder = canRetain ? input.dataset.savedPlaceholder : input.dataset.newPlaceholder;
      }
    }
    if (!active) continue;
    if (panel.dataset.authInput === "login") {
      const username = panel.querySelector("input[name='username']");
      const password = panel.querySelector("input[name='password']");
      const hasDraftLogin = Boolean(username?.value || password?.value);
      if (username) username.required = !canRetain || hasDraftLogin;
      if (password) password.required = !canRetain || hasDraftLogin;
    } else {
      const credential = panel.querySelector("input[name='credential']");
      if (credential) credential.required = !canRetain;
    }
  }

  form.dataset.authMode = mode;
  form.dataset.formType = activePanel?.dataset.authInput === "login" ? "login" : "other";
  const retention = form.querySelector("[data-auth-retention]");
  if (retention) {
    retention.textContent = canRetain
      ? "The encrypted credential is retained only while this service URL and authentication method stay unchanged. Leave the active fields blank to keep it."
      : form.dataset.credentialConfigured === "true"
        ? "The URL or authentication method changed. Enter fresh authentication details before testing or saving."
        : "Enter authentication details for this service URL and method.";
  }
}

function advanceServiceTestRevision(form) {
  const current = Number.parseInt(form?.dataset?.testRevision || "0", 10);
  const next = Number.isSafeInteger(current) ? current + 1 : 1;
  form.dataset.testRevision = String(next);
  return form.dataset.testRevision;
}

function invalidateServiceTest(form) {
  if (!form) return;
  advanceServiceTestRevision(form);
  const panel = form.querySelector("#service-test-result");
  if (!panel) return;
  panel.hidden = true;
  delete panel.dataset.state;
  const title = panel.querySelector("[data-test-title]");
  const detail = panel.querySelector("[data-test-detail]");
  const capabilities = panel.querySelector("[data-test-capabilities]");
  const note = panel.querySelector("[data-test-note]");
  if (title) title.textContent = "";
  if (detail) detail.textContent = "";
  if (capabilities) setMarkup(capabilities, "");
  if (note) note.textContent = "";
}

function invalidateProxmoxTest(form) {
  if (!form) return;
  advanceServiceTestRevision(form);
  form.dataset.discoveryConfirmed = "false";
  const panel = form.querySelector("#proxmox-test-result");
  if (!panel) return;
  panel.hidden = true;
  delete panel.dataset.state;
  const title = panel.querySelector("[data-test-title]");
  const detail = panel.querySelector("[data-test-detail]");
  const capabilities = panel.querySelector("[data-test-capabilities]");
  const note = panel.querySelector("[data-test-note]");
  if (title) title.textContent = "";
  if (detail) detail.textContent = "";
  if (capabilities) setMarkup(capabilities, "");
  if (note) note.textContent = "";
  const discovery = form.querySelector("[data-proxmox-discovery]");
  if (discovery) {
    discovery.hidden = true;
    setMarkup(discovery, "");
  }
}

function invalidateProxmoxEndpointTest(form) {
  if (!form) return;
  advanceServiceTestRevision(form);
  form.dataset.discoveryConfirmed = "false";
  const panel = form.querySelector("#proxmox-endpoint-test-result");
  if (panel) {
    panel.hidden = true;
    delete panel.dataset.state;
  }
  const discovery = form.querySelector("[data-proxmox-discovery]");
  if (discovery) {
    discovery.hidden = true;
    setMarkup(discovery, "");
  }
}

function serviceDraftBody(form, { includeMonitoring = false } = {}) {
  const data = new FormData(form);
  const authMode = selectedAuthModeForForm(form, data);
  const panels = [...form.querySelectorAll("[data-auth-panel]")];
  const activePanel = panels.find((panel) => panel.dataset.authMode === authMode);
  const inputType = activePanel?.dataset.authInput || (authMode === "login" ? "login" : "secret");
  const body = {
    url: String(data.get("url") || ""),
    authMode
  };
  if (inputType === "login") {
    const username = String(data.get("username") || "");
    const password = String(data.get("password") || "");
    if (username || password) body.login = { username, password };
  } else {
    const credential = String(data.get("credential") || "");
    if (credential) body.credential = credential;
  }
  if (includeMonitoring) body.monitoringEnabled = data.get("monitoringEnabled") === "on";
  return body;
}

function renderServiceModal(service) {
  const health = healthForService(service.id);
  const healthCheckedAt = health?.lastCheckedAt ?? health?.checkedAt;
  const healthLatency = Number.isFinite(Number(health?.latencyMs)) ? `${Math.max(0, Math.round(Number(health.latencyMs)))} ms` : "";
  const reports = reportsForService(service.id);
  const reportsFingerprint = reportFingerprint(reports);
  const options = serviceAuthOptions(service);
  const selectedMode = selectedServiceAuthMode(service, options);
  return `<section class="modal-card modal-card--service" role="dialog" aria-modal="true" aria-labelledby="service-modal-title">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span><div><span class="section-kicker">Service connection</span><h2 id="service-modal-title">${escapeHtml(service.name)}</h2><p>${escapeHtml(service.role)}</p></div><button class="icon-button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="service-form" data-service-id="${escapeHtml(service.id)}" data-original-url="${escapeHtml(service.url)}" data-original-auth-mode="${escapeHtml(selectedMode)}" data-auth-mode="${escapeHtml(selectedMode)}" data-credential-configured="${service.credentialConfigured ? "true" : "false"}" autocomplete="off" data-form-type="${options.find((option) => option.id === selectedMode)?.input === "login" ? "login" : "other"}">
      <div class="modal-card__body">
        <label><span>Full service URL</span><input name="url" type="url" autocomplete="url" value="${escapeHtml(service.url)}" required placeholder="http://192.168.0.7:8096" /><small>Use an address reachable from inside this container. The target must fit the allowed network policy.</small></label>
        ${renderServiceAuthentication(service)}
        <label class="check-row"><input name="monitoringEnabled" type="checkbox" ${service.monitoringEnabled !== false ? "checked" : ""}/><span><strong>Monitor this service</strong><small>Run safe read-only checks in the container even when no browser is open.</small></span></label>
        <div class="credential-state ${service.credentialConfigured ? "is-configured" : ""}">${icon(service.credentialConfigured ? "check" : "lock")}<div><strong>${service.credentialConfigured ? "Encrypted credential saved" : "No credential saved"}</strong><span>Saved values are write-only and cannot be displayed by this interface.</span></div></div>
        ${health ? `<div class="service-health-inline" aria-label="Saved monitor status"><span class="health-dot is-${savedMonitorTone(health)}" data-monitor-dot aria-hidden="true"></span><div class="service-health-inline__copy"><small>Saved monitor</small><strong data-monitor-state>${escapeHtml(savedMonitorLabel(health))}</strong></div><span data-monitor-latency>${escapeHtml(healthLatency)}</span><span data-monitor-checked>${escapeHtml(formatTime(healthCheckedAt))}</span></div>` : ""}
        <div class="service-monitor-reports" data-monitor-reports data-report-fingerprint="${escapeHtml(reportsFingerprint)}" aria-live="polite"${reports.length ? "" : " hidden"}>${renderOperationsReports(reports, service.name)}</div>
        <div class="connection-test-result" id="service-test-result" role="status" aria-live="polite" hidden><span class="health-dot is-checking" aria-hidden="true"></span><div><span class="connection-test-result__kicker">Current connection test</span><strong data-test-title></strong><small data-test-detail></small><div data-test-capabilities></div><small class="connection-test-result__note" data-test-note></small></div></div>
        <p class="form-error" id="service-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${service.configured ? `<button class="button button--danger" type="button" data-action="delete-service" data-service-id="${escapeHtml(service.id)}">Remove</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="test-service">Test connection</button><button class="button button--primary" type="submit">Save encrypted</button></div></footer>
    </form>
  </section>`;
}

function openService(serviceId) {
  const service = state.config?.services?.find((entry) => entry.id === serviceId);
  if (service) {
    openModal(renderServiceModal(service), "input[name='url']");
    syncServiceAuthFields(modalLayer.querySelector("#service-form"));
  }
}

function normalizedFingerprint(value) {
  return String(value || "").trim().toLowerCase().replace(/^sha256:/u, "").replaceAll(":", "");
}

function proxmoxConnectionUnchanged(form) {
  const tlsMode = form.querySelector("input[name='tlsMode']:checked")?.value || "system";
  const fingerprint = tlsMode === "pinned"
    ? normalizedFingerprint(form.querySelector("input[name='certificateFingerprint']")?.value)
    : "";
  return comparableServiceUrl(form.querySelector("input[name='url']")?.value) === comparableServiceUrl(form.dataset.originalUrl)
    && tlsMode === form.dataset.originalTlsMode
    && fingerprint === normalizedFingerprint(form.dataset.originalFingerprint);
}

function canRetainProxmoxCredentials(form) {
  return form.dataset.credentialConfigured === "true" && proxmoxConnectionUnchanged(form);
}

function setFieldValidity(field, message) {
  if (!field || typeof field.setCustomValidity !== "function") return;
  field.setCustomValidity(message);
  if (message) field.setAttribute("aria-invalid", "true");
  else field.removeAttribute("aria-invalid");
}

function syncProxmoxForm(form) {
  if (!form) return;
  const urlField = form.querySelector("input[name='url']");
  const tlsMode = form.querySelector("input[name='tlsMode']:checked")?.value === "pinned" ? "pinned" : "system";
  const pinned = tlsMode === "pinned";
  const fingerprintPanel = form.querySelector("[data-tls-panel='pinned']");
  const fingerprint = form.querySelector("input[name='certificateFingerprint']");
  const tokenId = form.querySelector("input[name='proxmoxTokenId']");
  const tokenSecret = form.querySelector("input[name='proxmoxTokenSecret']");
  const tokenDrafted = Boolean(tokenId?.value || tokenSecret?.value);
  const retaining = canRetainProxmoxCredentials(form) && !tokenDrafted;

  let urlMessage = "";
  if (urlField?.value) {
    try {
      if (new URL(urlField.value).protocol !== "https:") urlMessage = "Proxmox targets must use HTTPS.";
    } catch {
      urlMessage = "Enter a complete Proxmox HTTPS URL.";
    }
  }
  setFieldValidity(urlField, urlMessage);

  for (const radio of form.querySelectorAll("input[name='tlsMode']")) {
    radio.setAttribute("aria-expanded", radio.value === "pinned" && pinned ? "true" : "false");
  }
  if (fingerprintPanel) fingerprintPanel.hidden = !pinned;
  if (fingerprint) {
    fingerprint.disabled = !pinned;
    fingerprint.required = pinned;
    const compact = normalizedFingerprint(fingerprint.value);
    setFieldValidity(fingerprint, pinned && compact && !/^[a-f0-9]{64}$/u.test(compact)
      ? "Enter a valid SHA-256 certificate fingerprint."
      : "");
  }

  if (tokenId) tokenId.required = !retaining || tokenDrafted;
  if (tokenSecret) tokenSecret.required = !retaining || tokenDrafted;
  setFieldValidity(tokenId, tokenId?.value && !/^[^@!\s]+@[^@!\s]+![^@!\s]+$/u.test(tokenId.value.trim())
    ? "Use the complete Proxmox token ID in user@realm!token format."
    : "");
  setFieldValidity(tokenSecret, tokenDrafted && !tokenSecret?.value
    ? "Enter the API token secret with the token ID."
    : "");
  if (tokenId && tokenDrafted && !tokenId.value) {
    setFieldValidity(tokenId, "Enter the API token ID with the token secret.");
  }

  const note = form.querySelector("[data-proxmox-credential-note]");
  if (note) {
    note.textContent = retaining
      ? "Leave both token fields blank to keep the protected credential. It can only be reused while the URL and certificate trust stay unchanged."
      : form.dataset.credentialConfigured === "true"
        ? "The connection address or certificate trust changed. Enter both token values before testing or saving."
        : "Enter both values from a dedicated Proxmox API token. Helmsman never returns them through the interface.";
  }
}

function proxmoxDraftBody(form) {
  const data = new FormData(form);
  const tlsMode = String(data.get("tlsMode") || "system") === "pinned" ? "pinned" : "system";
  const body = {
    type: "proxmox",
    displayName: String(data.get("displayName") || "").trim(),
    url: String(data.get("url") || "").trim(),
    enabled: form.dataset.targetEnabled !== "false",
    monitoringEnabled: data.get("monitoringEnabled") === "on",
    monitoringIntervalSeconds: Number.parseInt(form.dataset.monitoringIntervalSeconds || "60", 10),
    tlsMode,
    certificateFingerprint: tlsMode === "pinned"
      ? normalizedFingerprint(data.get("certificateFingerprint"))
      : null
  };
  const tokenId = String(data.get("proxmoxTokenId") || "").trim();
  const tokenSecret = String(data.get("proxmoxTokenSecret") || "");
  if (tokenId || tokenSecret) body.credentials = { tokenId, tokenSecret };
  return body;
}

function proxmoxTestBody(form) {
  const draft = proxmoxDraftBody(form);
  return {
    type: draft.type,
    url: draft.url,
    tlsMode: draft.tlsMode,
    certificateFingerprint: draft.certificateFingerprint,
    ...(draft.credentials ? { credentials: draft.credentials } : {})
  };
}

function infrastructureCapabilitiesResult(health) {
  return {
    service: "proxmox",
    checks: (health?.capabilities || []).map((check) => ({
      id: check.id,
      label: check.name,
      state: check.state,
      code: check.code,
      status: check.status,
      latencyMs: check.latencyMs,
      metrics: check.metrics,
      reports: check.reports
    }))
  };
}

function infrastructureCapabilitiesFingerprint(health) {
  return JSON.stringify({
    reports: health?.reports || [],
    checks: infrastructureCapabilitiesResult(health).checks.map((check) => ({
      id: check.id,
      label: check.label,
      state: check.state,
      code: check.code,
      status: check.status,
      latencyMs: check.latencyMs,
      reports: check.reports
    }))
  });
}

function renderInfrastructureSavedEvidence(health) {
  return `${renderOperationsReports(health?.reports || [], health?.displayName || "Proxmox")}${renderConnectionCapabilities(infrastructureCapabilitiesResult(health))}`;
}

function renderProxmoxModal(target = null) {
  const existing = Boolean(target);
  const health = target ? infrastructureHealthForTarget(target.id) : null;
  const healthState = target?.monitoringEnabled === false ? "disabled" : health?.state || "stale";
  const healthFacts = [];
  if (health?.version) healthFacts.push(`PVE ${health.version}`);
  if (health?.latencyMs !== null && health?.latencyMs !== undefined) healthFacts.push(`${health.latencyMs} ms`);
  const savedCapabilities = health && (health.capabilities.length || health.reports.length)
    ? renderInfrastructureSavedEvidence(health)
    : "";
  const tlsMode = target?.tlsMode === "pinned" ? "pinned" : "system";
  const displayName = target?.displayName || "";
  const description = existing
    ? `Edit ${displayName}'s primary endpoint without exposing its saved token.`
    : "Connect one endpoint, verify trust, and discover whether it represents a standalone server or a cluster.";
  return `<section class="modal-card modal-card--service modal-card--proxmox" role="dialog" aria-modal="true" aria-labelledby="proxmox-modal-title" aria-describedby="proxmox-modal-description">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("proxmox", "P")}</span><div><span class="section-kicker">${existing ? "Primary API endpoint" : "Connect and discover"}</span><h2 id="proxmox-modal-title" tabindex="-1">${existing ? escapeHtml(displayName) : "New Proxmox environment"}</h2><p id="proxmox-modal-description">${escapeHtml(description)}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="proxmox-form" data-infrastructure-target-id="${escapeHtml(target?.id || "")}" data-original-url="${escapeHtml(target?.url || "")}" data-original-tls-mode="${escapeHtml(tlsMode)}" data-original-fingerprint="${escapeHtml(target?.certificateFingerprint || "")}" data-credential-configured="${target?.credentialConfigured ? "true" : "false"}" data-target-enabled="${target?.enabled === false ? "false" : "true"}" data-monitoring-interval-seconds="${target?.monitoringIntervalSeconds || 60}" data-discovery-confirmed="false" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <div class="form-grid form-grid--two">
          <label for="proxmox-display-name"><span>Display name</span><input id="proxmox-display-name" name="displayName" type="text" autocomplete="off" autocapitalize="words" maxlength="80" value="${escapeHtml(displayName)}" required placeholder="Main Proxmox" /></label>
          <label for="proxmox-url"><span>Full Proxmox URL</span><input id="proxmox-url" name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value="${escapeHtml(target?.url || "")}" required placeholder="https://proxmox.example.internal:8006" /><small>HTTPS only. Use an address reachable from inside this container.</small></label>
        </div>

        <fieldset class="auth-method-fieldset proxmox-tls-fieldset">
          <legend>Certificate trust</legend>
          <p class="network-policy-help">Verify the server certificate. Helmsman never offers an insecure “ignore TLS errors” mode.</p>
          <div class="auth-mode-grid">
            <label class="option-card-v5" for="proxmox-tls-system"><input id="proxmox-tls-system" name="tlsMode" type="radio" value="system" ${tlsMode === "system" ? "checked" : ""}/><span><strong>System trust</strong><small>Use a trusted CA and matching hostname.</small></span></label>
            <label class="option-card-v5" for="proxmox-tls-pinned"><input id="proxmox-tls-pinned" name="tlsMode" type="radio" value="pinned" aria-controls="proxmox-fingerprint-panel" aria-expanded="${tlsMode === "pinned" ? "true" : "false"}" ${tlsMode === "pinned" ? "checked" : ""}/><span><strong>Pinned fingerprint</strong><small>Best for a local self-signed Proxmox certificate.</small></span></label>
          </div>
        </fieldset>
        <div class="service-auth-panel" id="proxmox-fingerprint-panel" data-tls-panel="pinned" ${tlsMode === "pinned" ? "" : "hidden"}>
          <label for="proxmox-certificate-fingerprint"><span>SHA-256 certificate fingerprint</span><input id="proxmox-certificate-fingerprint" name="certificateFingerprint" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" value="${escapeHtml(target?.certificateFingerprint || "")}" ${tlsMode === "pinned" ? "required" : "disabled"} placeholder="64 hexadecimal characters" /><small>On the Proxmox host console, run <code>pvenode cert info</code> and copy the SHA-256 fingerprint for the certificate served by <code>pveproxy</code>. Verify it locally; do not trust a fingerprint learned only through the network being enrolled.</small></label>
        </div>

        <fieldset class="auth-method-fieldset proxmox-token-fieldset">
          <legend>Proxmox API token</legend>
          <div class="form-grid form-grid--two">
            <label for="proxmox-token-id"><span>API token ID</span><input id="proxmox-token-id" name="proxmoxTokenId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" placeholder="${target?.credentialConfigured ? "Blank keeps the saved token" : "helmsman@pve!monitoring"}" ${target?.credentialConfigured ? "" : "required"}/><small>Complete ID in <code>user@realm!token</code> format.</small></label>
            <label for="proxmox-token-secret"><span>API token secret</span><input id="proxmox-token-secret" name="proxmoxTokenSecret" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" placeholder="${target?.credentialConfigured ? "Blank keeps the saved token" : "Paste the token secret"}" ${target?.credentialConfigured ? "" : "required"}/><small>Shown once when the token is created.</small></label>
          </div>
          <p class="auth-retention-note" data-proxmox-credential-note>${target?.credentialConfigured ? "Leave both token fields blank to keep the protected credential." : "Use a dedicated least-privilege token with inventory access and VM.PowerMgmt only where guest controls are intended."}</p>
        </fieldset>

        <label class="check-row"><input name="monitoringEnabled" type="checkbox" ${target?.monitoringEnabled === false ? "" : "checked"}/><span><strong>Monitor this environment</strong><small>Collect one bounded cluster-wide inventory per cycle even when no browser is open.</small></span></label>
        <div class="credential-state ${target?.credentialConfigured ? "is-configured" : ""}">${icon(target?.credentialConfigured ? "check" : "lock")}<div><strong>${target?.credentialConfigured ? "Protected API token saved" : "No API token saved"}</strong><span>Token values are write-only and cannot be displayed by this interface.</span></div></div>
        ${target ? `<div class="service-health-inline" aria-label="Saved Proxmox monitor status"><span class="health-dot is-${statusClass(healthState)}" data-infrastructure-monitor-dot aria-hidden="true"></span><div class="service-health-inline__copy"><small>Saved monitor</small><strong data-infrastructure-monitor-state>${escapeHtml(statusLabel(healthState))}</strong></div><span data-infrastructure-monitor-facts>${escapeHtml(healthFacts.join(" · "))}</span><span data-infrastructure-monitor-checked>${escapeHtml(formatTime(health?.lastCheckedAt))}</span></div><div class="infrastructure-saved-capabilities" data-infrastructure-saved-capabilities data-capability-fingerprint="${escapeHtml(infrastructureCapabilitiesFingerprint(health))}" aria-label="Latest saved Proxmox capability results"${savedCapabilities ? "" : " hidden"}>${savedCapabilities}</div>` : ""}
        <div class="connection-test-result" id="proxmox-test-result" role="status" aria-live="polite" hidden><span class="health-dot is-checking" aria-hidden="true"></span><div><span class="connection-test-result__kicker">Current connection test</span><strong data-test-title></strong><small data-test-detail></small><div data-test-capabilities></div><small class="connection-test-result__note" data-test-note></small></div></div>
        <div data-proxmox-discovery aria-live="polite" hidden></div>
        <p class="form-error" id="proxmox-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${existing ? `<button class="button button--danger" type="button" data-action="delete-infrastructure-target" data-infrastructure-target-id="${escapeHtml(target.id)}">Remove environment</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="test-infrastructure-target">${existing ? "Test and rediscover" : "Connect and discover"}</button><button class="button button--primary" type="submit">${existing ? "Save environment" : "Confirm environment"}</button></div></footer>
    </form>
  </section>`;
}

function openInfrastructureTarget(targetId = "") {
  const target = targetId ? infrastructureTargetById(targetId) : null;
  if (targetId && !target) {
    showToast("That Proxmox environment is no longer available.", "danger");
    return;
  }
  openModal(renderProxmoxModal(target), "#proxmox-display-name");
  syncProxmoxForm(modalLayer.querySelector("#proxmox-form"));
}

function portainerConnectionUnchanged(form) {
  const tlsMode = form.querySelector("input[name='tlsMode']:checked")?.value === "pinned" ? "pinned" : "system";
  const fingerprint = tlsMode === "pinned"
    ? normalizedFingerprint(form.querySelector("input[name='certificateFingerprint']")?.value)
    : "";
  return comparableServiceUrl(form.querySelector("input[name='url']")?.value) === comparableServiceUrl(form.dataset.originalUrl)
    && tlsMode === form.dataset.originalTlsMode
    && fingerprint === normalizedFingerprint(form.dataset.originalFingerprint);
}

function syncPortainerForm(form) {
  if (!form) return;
  const url = form.querySelector("input[name='url']");
  const token = form.querySelector("input[name='accessToken']");
  const tlsMode = form.querySelector("input[name='tlsMode']:checked")?.value === "pinned" ? "pinned" : "system";
  const pinned = tlsMode === "pinned";
  const fingerprintPanel = form.querySelector("[data-tls-panel='pinned']");
  const fingerprint = form.querySelector("input[name='certificateFingerprint']");
  const retaining = form.dataset.credentialConfigured === "true" && portainerConnectionUnchanged(form) && !token?.value;
  let urlMessage = "";
  if (url?.value) {
    try {
      if (new URL(url.value).protocol !== "https:") urlMessage = "Portainer connections must use HTTPS.";
    } catch {
      urlMessage = "Enter a complete Portainer HTTPS URL.";
    }
  }
  setFieldValidity(url, urlMessage);
  for (const radio of form.querySelectorAll("input[name='tlsMode']")) {
    radio.setAttribute("aria-expanded", radio.value === "pinned" && pinned ? "true" : "false");
  }
  if (fingerprintPanel) fingerprintPanel.hidden = !pinned;
  if (fingerprint) {
    fingerprint.disabled = !pinned;
    fingerprint.required = pinned;
    const compact = normalizedFingerprint(fingerprint.value);
    setFieldValidity(fingerprint, pinned && compact && !/^[a-f0-9]{64}$/u.test(compact)
      ? "Enter a valid SHA-256 certificate fingerprint."
      : "");
  }
  if (token) token.required = !retaining;
  const note = form.querySelector("[data-portainer-credential-note]");
  if (note) {
    note.textContent = retaining
      ? "Leave the access token blank to keep the protected credential. It can only be reused while the URL and certificate trust stay unchanged."
      : form.dataset.credentialConfigured === "true"
        ? "The connection address or certificate trust changed. Enter the access token again before testing or saving."
        : "Use an access token from a dedicated Portainer user limited to the environments Helmsman should inventory.";
  }
}

function invalidatePortainerTest(form) {
  if (!form) return;
  advanceServiceTestRevision(form);
  const panel = form.querySelector("#portainer-test-result");
  if (!panel) return;
  panel.hidden = true;
  delete panel.dataset.state;
  const capabilities = panel.querySelector("[data-test-capabilities]");
  if (capabilities) setMarkup(capabilities, "");
}

function portainerDraftBody(form) {
  const data = new FormData(form);
  const tlsMode = String(data.get("tlsMode") || "system") === "pinned" ? "pinned" : "system";
  const body = {
    type: "portainer",
    displayName: String(data.get("displayName") || "").trim(),
    url: String(data.get("url") || "").trim(),
    enabled: data.get("enabled") === "on",
    monitoringEnabled: data.get("monitoringEnabled") === "on",
    tlsMode,
    certificateFingerprint: tlsMode === "pinned"
      ? normalizedFingerprint(data.get("certificateFingerprint"))
      : null
  };
  const accessToken = String(data.get("accessToken") || "");
  if (accessToken) body.credentials = { accessToken };
  return body;
}

function portainerCapabilitiesResult(health) {
  return {
    service: "portainer",
    checks: (health?.capabilities || []).map((check) => ({
      id: check.id,
      label: check.label,
      state: check.state,
      code: check.code,
      status: check.status,
      latencyMs: check.latencyMs,
      reports: check.reports
    }))
  };
}

function renderPortainerModal(service = null) {
  const existing = Boolean(service);
  const health = service ? portainerHealthById(service.id) : null;
  const tlsMode = service?.tlsMode === "pinned" ? "pinned" : "system";
  const reports = [
    ...(health?.reports || []),
    ...(health?.capabilities || []).flatMap((check) => check.reports)
  ].slice(0, 12);
  const savedEvidence = health && (health.capabilities.length || reports.length)
    ? `${renderOperationsReports(reports, health.displayName)}${renderConnectionCapabilities(portainerCapabilitiesResult(health))}`
    : "";
  return `<section class="modal-card modal-card--service modal-card--portainer" role="dialog" aria-modal="true" aria-labelledby="portainer-modal-title" aria-describedby="portainer-modal-description">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("portainer", "P")}</span><div><span class="section-kicker">Container infrastructure</span><h2 id="portainer-modal-title" tabindex="-1">${existing ? escapeHtml(service.displayName) : "Connect Portainer"}</h2><p id="portainer-modal-description">${existing ? "Edit this Portainer connection without exposing its saved access token." : "Connect one Portainer server to discover permitted environments and use confirmed container controls."}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="portainer-form" data-portainer-service-id="${escapeHtml(service?.id || "")}" data-original-url="${escapeHtml(service?.url || "")}" data-original-tls-mode="${escapeHtml(tlsMode)}" data-original-fingerprint="${escapeHtml(service?.certificateFingerprint || "")}" data-credential-configured="${service?.credentialConfigured ? "true" : "false"}" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <div class="form-grid form-grid--two"><label for="portainer-display-name"><span>Display name</span><input id="portainer-display-name" name="displayName" type="text" maxlength="80" autocomplete="off" value="${escapeHtml(service?.displayName || "")}" required placeholder="Main Portainer" /></label><label for="portainer-url"><span>Full Portainer URL</span><input id="portainer-url" name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value="${escapeHtml(service?.url || "")}" required placeholder="https://portainer.example.internal:9443" /><small>HTTPS only. Use an address reachable from inside this container.</small></label></div>
        <fieldset class="auth-method-fieldset portainer-tls-fieldset"><legend>Certificate trust</legend><p class="network-policy-help">Helmsman verifies the server certificate and never offers an insecure skip-verification mode.</p><div class="auth-mode-grid"><label class="option-card-v5"><input name="tlsMode" type="radio" value="system" ${tlsMode === "system" ? "checked" : ""}/><span><strong>System trust</strong><small>Use a trusted CA and matching hostname.</small></span></label><label class="option-card-v5"><input name="tlsMode" type="radio" value="pinned" ${tlsMode === "pinned" ? "checked" : ""}/><span><strong>Pinned fingerprint</strong><small>Use the exact SHA-256 leaf certificate.</small></span></label></div></fieldset>
        <div class="service-auth-panel" data-tls-panel="pinned" ${tlsMode === "pinned" ? "" : "hidden"}><label for="portainer-certificate-fingerprint"><span>SHA-256 certificate fingerprint</span><input id="portainer-certificate-fingerprint" name="certificateFingerprint" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" value="${escapeHtml(service?.certificateFingerprint || "")}" ${tlsMode === "pinned" ? "required" : "disabled"} placeholder="64 hexadecimal characters" /><small>Verify the fingerprint through a trusted local channel before saving it.</small></label></div>
        <fieldset class="auth-method-fieldset portainer-token-fieldset"><legend>Portainer access token</legend><label for="portainer-access-token"><span>Access token</span><input id="portainer-access-token" name="accessToken" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" placeholder="${service?.credentialConfigured ? "Blank keeps the saved token" : "Paste the Portainer access token"}" ${service?.credentialConfigured ? "" : "required"}/><small>Create it for a dedicated user limited to the intended environments. Start, restart, and stop require container-management access in that scope.</small></label><p class="auth-retention-note" data-portainer-credential-note>${service?.credentialConfigured ? "Leave this blank to keep the protected token." : "The token is write-only and never returned to this browser."}</p></fieldset>
        <div class="form-grid form-grid--two"><label class="check-row"><input name="enabled" type="checkbox" ${service?.enabled === false ? "" : "checked"}/><span><strong>Enable this connection</strong><small>Disabled connections are kept but cannot be used by the monitor.</small></span></label><label class="check-row"><input name="monitoringEnabled" type="checkbox" ${service?.monitoringEnabled === false ? "" : "checked"}/><span><strong>Monitor Portainer</strong><small>Run bounded GET-only checks even when no browser is open.</small></span></label></div>
        <div class="credential-state ${service?.credentialConfigured ? "is-configured" : ""}">${icon(service?.credentialConfigured ? "check" : "lock")}<div><strong>${service?.credentialConfigured ? "Protected access token saved" : "No access token saved"}</strong><span>Saved token values are encrypted, destination-bound, and cannot be displayed by this interface.</span></div></div>
        ${health ? `<div class="service-health-inline" aria-label="Saved Portainer monitor status"><span class="health-dot is-${statusClass(health.state)}" data-portainer-monitor-dot aria-hidden="true"></span><div class="service-health-inline__copy"><small>Saved monitor</small><strong data-portainer-monitor-state>${escapeHtml(portainerConnectionLabel(health))}</strong></div><span data-portainer-monitor-facts>${escapeHtml([health.version ? `Portainer ${health.version}` : "", health.latencyMs === null ? "" : `${health.latencyMs} ms`].filter(Boolean).join(" · "))}</span><span data-portainer-monitor-checked>${escapeHtml(formatTime(health.checkedAt))}</span></div><div class="infrastructure-saved-capabilities" data-portainer-saved-capabilities data-capability-fingerprint="${escapeHtml(portainerEvidenceFingerprint(health))}" aria-label="Latest saved Portainer capability results"${savedEvidence ? "" : " hidden"}>${savedEvidence}</div>` : ""}
        <div class="connection-test-result" id="portainer-test-result" role="status" aria-live="polite" hidden><span class="health-dot is-checking" aria-hidden="true"></span><div><span class="connection-test-result__kicker">Current connection test</span><strong data-test-title></strong><small data-test-detail></small><div data-test-capabilities></div><small class="connection-test-result__note" data-test-note></small></div></div>
        <p class="form-error" id="portainer-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${existing ? `<button class="button button--danger" type="button" data-action="delete-portainer-service" data-portainer-service-id="${escapeHtml(service.id)}">Remove connection</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="test-portainer-service">Test connection</button><button class="button button--primary" type="submit">${existing ? "Save connection" : "Connect Portainer"}</button></div></footer>
    </form>
  </section>`;
}

function openPortainerService(serviceId = "") {
  const service = serviceId ? portainerServiceById(serviceId) : null;
  if (serviceId && !service) return showToast("That Portainer connection is no longer available.", "danger");
  openModal(renderPortainerModal(service), "#portainer-display-name");
  syncPortainerForm(modalLayer.querySelector("#portainer-form"));
}

function proxmoxEndpointDraftBody(form) {
  const data = new FormData(form);
  const tlsMode = String(data.get("tlsMode") || "system") === "pinned" ? "pinned" : "system";
  const body = {
    label: String(data.get("label") || "").trim(),
    url: String(data.get("url") || "").trim(),
    enabled: data.get("enabled") === "on",
    tlsMode,
    certificateFingerprint: tlsMode === "pinned"
      ? normalizedFingerprint(data.get("certificateFingerprint"))
      : null
  };
  const tokenId = String(data.get("proxmoxTokenId") || "").trim();
  const tokenSecret = String(data.get("proxmoxTokenSecret") || "");
  if (tokenId || tokenSecret) body.credentials = { tokenId, tokenSecret };
  return body;
}

function renderProxmoxEndpointModal(environment, endpoint = null) {
  const existing = Boolean(endpoint);
  const tlsMode = endpoint?.tlsMode === "pinned" ? "pinned" : "system";
  return `<section class="modal-card modal-card--service modal-card--proxmox" role="dialog" aria-modal="true" aria-labelledby="proxmox-endpoint-modal-title">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("proxmox", "P")}</span><div><span class="section-kicker">Explicit failover trust</span><h2 id="proxmox-endpoint-modal-title" tabindex="-1">${existing ? escapeHtml(endpoint.label) : "Add API endpoint"}</h2><p>${escapeHtml(environment.displayName)} · Every address, certificate, and token is verified independently.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="proxmox-endpoint-form" data-infrastructure-target-id="${escapeHtml(environment.id)}" data-infrastructure-endpoint-id="${escapeHtml(endpoint?.id || "")}" data-original-url="${escapeHtml(endpoint?.url || "")}" data-original-tls-mode="${escapeHtml(tlsMode)}" data-original-fingerprint="${escapeHtml(endpoint?.certificateFingerprint || "")}" data-credential-configured="${endpoint?.credentialConfigured ? "true" : "false"}" data-discovery-confirmed="false" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <div class="form-grid form-grid--two"><label><span>Endpoint label</span><input name="label" type="text" maxlength="80" required value="${escapeHtml(endpoint?.label || "")}" placeholder="pve-2 failover" /></label><label><span>Full Proxmox URL</span><input name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" required value="${escapeHtml(endpoint?.url || "")}" placeholder="https://pve-2.example.internal:8006" /><small>Helmsman will not infer or trust an address discovered through the cluster API.</small></label></div>
        <fieldset class="auth-method-fieldset proxmox-tls-fieldset"><legend>Certificate trust</legend><p class="network-policy-help">Trust applies only to this exact endpoint.</p><div class="auth-mode-grid"><label class="option-card-v5"><input name="tlsMode" type="radio" value="system" ${tlsMode === "system" ? "checked" : ""}/><span><strong>System trust</strong><small>Trusted CA and matching hostname.</small></span></label><label class="option-card-v5"><input name="tlsMode" type="radio" value="pinned" ${tlsMode === "pinned" ? "checked" : ""}/><span><strong>Pinned fingerprint</strong><small>Exact SHA-256 leaf certificate.</small></span></label></div></fieldset>
        <div class="service-auth-panel" data-tls-panel="pinned" ${tlsMode === "pinned" ? "" : "hidden"}><label><span>SHA-256 certificate fingerprint</span><input name="certificateFingerprint" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(endpoint?.certificateFingerprint || "")}" ${tlsMode === "pinned" ? "required" : "disabled"} placeholder="64 hexadecimal characters" /><small>Verify this fingerprint locally on the named Proxmox node before saving it.</small></label></div>
        <fieldset class="auth-method-fieldset proxmox-token-fieldset"><legend>Endpoint API token</legend><div class="form-grid form-grid--two"><label><span>API token ID</span><input name="proxmoxTokenId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${endpoint?.credentialConfigured ? "Blank keeps the saved token" : "helmsman@pve!monitoring"}" ${endpoint?.credentialConfigured ? "" : "required"}/></label><label><span>API token secret</span><input name="proxmoxTokenSecret" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="${endpoint?.credentialConfigured ? "Blank keeps the saved token" : "Paste the token secret"}" ${endpoint?.credentialConfigured ? "" : "required"}/></label></div><p class="auth-retention-note" data-proxmox-credential-note>${endpoint?.credentialConfigured ? "Leave both token fields blank to keep the protected credential." : "Use the same least-privilege inventory and guest-control scope as the primary endpoint token."}</p></fieldset>
        <label class="check-row"><input name="enabled" type="checkbox" ${endpoint?.enabled === false ? "" : "checked"}/><span><strong>Use this endpoint for failover</strong><small>Disabled endpoints remain registered but are not queried by the monitor.</small></span></label>
        <div class="credential-state ${endpoint?.credentialConfigured ? "is-configured" : ""}">${icon(endpoint?.credentialConfigured ? "check" : "lock")}<div><strong>${endpoint?.credentialConfigured ? "Protected endpoint token saved" : "No endpoint token saved"}</strong><span>Credentials are independently bound to this endpoint and its approved network destination.</span></div></div>
        <div class="connection-test-result" id="proxmox-endpoint-test-result" role="status" aria-live="polite" hidden><span class="health-dot is-checking" aria-hidden="true"></span><div><span class="connection-test-result__kicker">Endpoint verification</span><strong data-test-title></strong><small data-test-detail></small><div data-test-capabilities></div><small class="connection-test-result__note" data-test-note></small></div></div>
        <div data-proxmox-discovery aria-live="polite" hidden></div><p class="form-error" id="proxmox-endpoint-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${existing ? `<button class="button button--danger" type="button" data-action="delete-infrastructure-endpoint" data-infrastructure-target-id="${escapeHtml(environment.id)}" data-infrastructure-endpoint-id="${escapeHtml(endpoint.id)}">Remove endpoint</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="test-infrastructure-endpoint">Verify endpoint</button><button class="button button--primary" type="submit">${existing ? "Save endpoint" : "Confirm endpoint"}</button></div></footer>
    </form>
  </section>`;
}

function openInfrastructureEndpoint(environmentId, endpointId = "") {
  const environment = infrastructureHealthForTarget(environmentId);
  const configured = infrastructureTargetById(environmentId);
  if (!environment || !configured) return showToast("That Proxmox environment is no longer available.", "danger");
  const endpoint = endpointId ? configured.endpoints.find(({ id }) => id === endpointId) : null;
  if (endpointId && !endpoint) return showToast("That Proxmox endpoint is no longer available.", "danger");
  if (endpoint?.primary) return openInfrastructureTarget(environmentId);
  openModal(renderProxmoxEndpointModal(environment, endpoint), "#proxmox-endpoint-modal-title");
  syncProxmoxForm(modalLayer.querySelector("#proxmox-endpoint-form"));
}

function proxmoxFormHasDraftCredentials(form) {
  return Boolean(
    form.querySelector("input[name='proxmoxTokenId']")?.value
    || form.querySelector("input[name='proxmoxTokenSecret']")?.value
  );
}

function proxmoxFormNeedsDiscovery(form) {
  const existingId = form.dataset.infrastructureEndpointId || form.dataset.infrastructureTargetId;
  return !existingId || !proxmoxConnectionUnchanged(form) || proxmoxFormHasDraftCredentials(form);
}

function cidrsFrom(value) {
  return String(value || "").split(/[\r\n,]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function selectedNetworkMode(form, data) {
  const candidate = String(
    data?.get("networkMode")
      || form.querySelector("input[name='networkMode']:checked")?.value
      || form.dataset.networkMode
      || "exact"
  );
  return candidate === "manual" ? "manual" : "exact";
}

function syncNetworkPolicyFields(form) {
  if (!form) return;
  const mode = selectedNetworkMode(form);
  const manual = mode === "manual";
  const fields = form.querySelector("[data-network-cidr-fields]");
  const textarea = form.querySelector("textarea[name='allowedCidrs']");
  if (fields) fields.hidden = !manual;
  const manualToggle = form.querySelector("input[name='networkMode'][value='manual']");
  if (manualToggle) manualToggle.setAttribute("aria-expanded", manual ? "true" : "false");
  if (textarea) {
    textarea.disabled = !manual;
    textarea.required = manual;
  }
  form.dataset.networkMode = mode;
}

function allowedCidrsForForm(form, data) {
  return selectedNetworkMode(form, data) === "manual"
    ? cidrsFrom(data.get("allowedCidrs"))
    : [];
}

async function submitSetup(form) {
  const error = form.querySelector("#setup-error");
  const data = new FormData(form);
  error.textContent = "";
  try {
    const result = await api("/api/v2/setup/claim", {
      method: "POST",
      csrf: false,
      body: {
        setupToken: String(data.get("setupToken") || ""),
        deviceName: String(data.get("deviceName") || "Browser"),
        origin: location.origin,
        allowedCidrs: allowedCidrsForForm(form, data),
        allowPublicHttps: data.get("allowPublicHttps") === "on"
      }
    });
    const accessKey = typeof result?.accessKey === "string" ? result.accessKey : "";
    if (!accessKey || accessKey.length > 1024) {
      throw new ApiError(502, "INVALID_RESPONSE", "The container did not return a valid access key.");
    }
    state.csrfToken = result.csrfToken;
    state.status = { ...state.status, setupRequired: false, authenticated: true, accessKeyConfigured: true, session: result.session };
    state.config = result.config;
    state.accessKeyReveal = accessKey;
    state.lastMarkup = "";
    await Promise.all([loadOperations(), loadSessions()]);
    location.hash = "#/settings";
    renderPage({ force: true });
    showToast("Container claimed. Save the new access key now.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  }
}

async function submitAccessLogin(form) {
  const error = form.querySelector("#access-login-error");
  const data = new FormData(form);
  const accessKeyInput = form.querySelector("input[name='accessKey']");
  error.textContent = "";
  try {
    const result = await api("/api/v2/access/login", {
      method: "POST",
      csrf: false,
      body: {
        accessKey: String(data.get("accessKey") || ""),
        deviceName: String(data.get("deviceName") || "Browser"),
        origin: location.origin
      }
    });
    state.csrfToken = result.csrfToken;
    state.status = { ...state.status, authenticated: true, accessKeyConfigured: true, session: result.session };
    state.accessKeyReveal = "";
    await loadAuthenticatedData();
    renderPage({ force: true });
  } catch (caught) {
    if (caught?.status === 401) error.textContent = "The access key was not accepted. Check the key and try again.";
    else if (caught?.status === 429) error.textContent = "Too many unlock attempts. Wait a moment, then try again.";
    else if (caught?.status === 0) error.textContent = "Helmsman could not be reached. Check the connection and try again.";
    else error.textContent = "This browser could not be unlocked. Use the same HTTPS or localhost origin and try again.";
  } finally {
    if (accessKeyInput) accessKeyInput.value = "";
  }
}

async function submitService(form) {
  const serviceId = form.dataset.serviceId;
  const error = form.querySelector("#service-error");
  syncServiceAuthFields(form);
  if (!form.reportValidity()) return;
  error.textContent = "";
  try {
    await api(`/api/v2/services/${encodeURIComponent(serviceId)}`, {
      method: "PUT",
      body: serviceDraftBody(form, { includeMonitoring: true })
    });
    closeModal();
    await loadAuthenticatedData({ refresh: true });
    renderPage({ force: true, preserveFocus: true });
    showToast("Connection saved. Its credential cannot be read back.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  }
}

function connectionTestSummary(result) {
  const checks = normalizedTestChecks(result);
  const failed = checks.filter((check) => check.state !== "healthy");
  const operationalState = statusClass(result?.state || "stale");
  const connectionState = normalizedConnectionState(result, checks, operationalState);
  const checkCount = checks.length || 1;
  const checkNoun = checkCount === 1 ? "capability check" : "capability checks";
  if (connectionState === "connected") {
    if (operationalState === "healthy") {
      return {
        tone: "healthy",
        title: "Connection and credential verified",
        detail: checkCount === 1 ? "The read-only capability check passed." : `All ${checkCount} read-only ${checkNoun} passed.`
      };
    }
    const names = failed.slice(0, 3).map((check) => check.label);
    return {
      tone: ["limited", "degraded"].includes(operationalState) ? operationalState : "limited",
      title: "Connection and credential verified",
      detail: names.length
        ? `The service accepted the credential; ${names.join(", ")} ${names.length === 1 ? "needs" : "need"} attention.`
        : "The service accepted the credential, but an operational check needs attention."
    };
  }
  if (connectionState === "auth_required") {
    return { tone: "auth-required", title: "Authentication failed", detail: "Check the service credential and try again." };
  }
  if (connectionState === "unverified") {
    return {
      tone: ["limited", "degraded"].includes(operationalState) ? operationalState : "down",
      title: "Service reached; credential not verified",
      detail: failed.length
        ? `${failed.slice(0, 3).map((check) => check.label).join(", ")} ${failed.length === 1 ? "needs" : "need"} attention.`
        : "The service responded, but its credential-required check did not pass."
    };
  }
  return { tone: "down", title: "Connection failed", detail: "The service did not complete its required read-only checks." };
}

function showConnectionTestResult(form, result, panelSelector = "#service-test-result") {
  const panel = form.querySelector(panelSelector);
  if (!panel) return;
  const summary = connectionTestSummary(result);
  panel.hidden = false;
  panel.dataset.state = summary.tone;
  panel.querySelector(".health-dot").className = `health-dot is-${statusClass(summary.tone)}`;
  panel.querySelector("[data-test-title]").textContent = summary.title;
  panel.querySelector("[data-test-detail]").textContent = summary.detail;
  setMarkup(panel.querySelector("[data-test-capabilities]"), renderConnectionCapabilities(result));
  panel.querySelector("[data-test-note]").textContent = `Tested ${formatTime(result?.checkedAt, "just now")}. Test only — nothing was saved.`;
}

async function testService(form, button) {
  if (!form) return;
  syncServiceAuthFields(form);
  if (!form.reportValidity()) return;
  const error = form.querySelector("#service-error");
  const panel = form.querySelector("#service-test-result");
  const serviceId = form.dataset.serviceId;
  const testRevision = advanceServiceTestRevision(form);
  error.textContent = "";
  panel.hidden = false;
  panel.dataset.state = "checking";
  panel.querySelector(".health-dot").className = "health-dot is-checking";
  panel.querySelector("[data-test-title]").textContent = "Testing connection";
  panel.querySelector("[data-test-detail]").textContent = "Running bounded, read-only capability checks…";
  setMarkup(panel.querySelector("[data-test-capabilities]"), "");
  panel.querySelector("[data-test-note]").textContent = "Tests the values above without saving them.";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await api(`/api/v2/services/${encodeURIComponent(serviceId)}/test`, {
      method: "POST",
      body: serviceDraftBody(form)
    });
    if (form.isConnected && form.dataset.testRevision === testRevision) showConnectionTestResult(form, result);
  } catch (caught) {
    if (form.isConnected && form.dataset.testRevision === testRevision) {
      panel.hidden = true;
      error.textContent = caught.message;
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function runConfirmedDeletion(button, {
  key,
  title,
  message,
  confirmLabel,
  path,
  validate,
  staleMessage,
  successMessage,
  applyLocalSuccess = null,
  onSuccess
}) {
  if (state.actionMutation) return false;
  if (!(await confirmControl({ title, message, confirmLabel, tone: "danger" })) || state.actionMutation) return false;
  let stillValid = false;
  try {
    stillValid = typeof validate === "function" && validate() === true;
  } catch {
    stillValid = false;
  }
  if (!stillValid) {
    showToast(staleMessage, "danger");
    return false;
  }
  state.actionMutation = key;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  let deletionAccepted = false;
  try {
    await api(path, { method: "DELETE" });
    deletionAccepted = true;
    if (typeof applyLocalSuccess === "function") applyLocalSuccess();
    await onSuccess();
    showToast(successMessage, "success");
    return true;
  } catch (error) {
    showToast(deletionAccepted
      ? "The connection was removed, but current state could not be reloaded. Refresh Helmsman before making another change."
      : error.message, "danger");
    return false;
  } finally {
    if (state.actionMutation === key) state.actionMutation = "";
    if (deletionAccepted) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
    if (button?.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function deleteService(serviceId, button) {
  const service = state.config?.services?.find((entry) => entry.id === serviceId && entry.configured !== false);
  if (!service) return;
  const targetRevision = String(service.targetRevision || "");
  await runConfirmedDeletion(button, {
    key: `delete:media:${serviceId}`,
    title: "Remove media connection?",
    message: `Remove ${service.name || serviceId} and its encrypted credential?`,
    confirmLabel: "Remove connection",
    path: `/api/v2/services/${encodeURIComponent(serviceId)}`,
    validate: () => {
      const current = state.config?.services?.find((entry) => entry.id === serviceId && entry.configured !== false);
      return Boolean(current) && String(current.targetRevision || "") === targetRevision;
    },
    staleMessage: "That media connection changed while confirmation was open. Review it before removing it.",
    successMessage: "Service target and its encrypted credential were removed.",
    applyLocalSuccess: () => {
      if (state.config && Array.isArray(state.config.services)) {
        state.config.services = state.config.services.filter(({ id }) => id !== serviceId);
      }
    },
    onSuccess: async () => {
      closeModal();
      await loadAuthenticatedData({ refresh: true });
    }
  });
}

async function testPortainerService(form, button) {
  if (!form) return;
  syncPortainerForm(form);
  if (!form.reportValidity()) return;
  const error = form.querySelector("#portainer-error");
  const panel = form.querySelector("#portainer-test-result");
  const serviceId = form.dataset.portainerServiceId;
  const useSaved = Boolean(serviceId) && portainerConnectionUnchanged(form) && !form.querySelector("input[name='accessToken']")?.value;
  const revision = advanceServiceTestRevision(form);
  error.textContent = "";
  panel.hidden = false;
  panel.dataset.state = "checking";
  panel.querySelector(".health-dot").className = "health-dot is-checking";
  panel.querySelector("[data-test-title]").textContent = "Testing Portainer connection";
  panel.querySelector("[data-test-detail]").textContent = "Verifying server status, access token permissions, environments, containers, and stacks…";
  setMarkup(panel.querySelector("[data-test-capabilities]"), "");
  panel.querySelector("[data-test-note]").textContent = "Read-only test — nothing is saved and no management command is sent.";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await api(useSaved
      ? `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}/test`
      : "/api/v2/infrastructure/services/test", {
      method: "POST",
      body: useSaved ? {} : portainerDraftBody(form)
    });
    if (form.isConnected && form.dataset.testRevision === revision) {
      showConnectionTestResult(form, { ...result, service: "portainer" }, "#portainer-test-result");
      panel.querySelector("[data-test-note]").textContent = `Tested ${formatTime(result?.checkedAt, "just now")}. Read-only test — nothing was saved.`;
    }
  } catch (caught) {
    if (form.isConnected && form.dataset.testRevision === revision) {
      panel.hidden = true;
      error.textContent = caught.message;
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function submitPortainerService(form) {
  syncPortainerForm(form);
  if (!form.reportValidity()) return;
  const serviceId = form.dataset.portainerServiceId;
  const error = form.querySelector("#portainer-error");
  const submit = form.querySelector("button[type='submit']");
  error.textContent = "";
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    await api(serviceId
      ? `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}`
      : "/api/v2/infrastructure/services", {
      method: serviceId ? "PUT" : "POST",
      body: portainerDraftBody(form)
    });
    closeModal();
    await loadAuthenticatedData({ refresh: true });
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast(serviceId ? "Portainer connection updated." : "Portainer connected.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  } finally {
    if (submit?.isConnected) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  }
}

async function deletePortainerService(serviceId, button) {
  if (!INFRASTRUCTURE_ID_PATTERN.test(String(serviceId || ""))) return;
  const service = portainerServiceById(serviceId);
  if (!service) return;
  const targetRevision = service.targetRevision;
  await runConfirmedDeletion(button, {
    key: `delete:portainer:${serviceId}`,
    title: "Remove Portainer connection?",
    message: `Remove ${service.displayName} and its protected access token?`,
    confirmLabel: "Remove connection",
    path: `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}`,
    validate: () => portainerServiceById(serviceId)?.targetRevision === targetRevision,
    staleMessage: "That Portainer connection changed while confirmation was open. Review it before removing it.",
    successMessage: "Portainer connection and its protected access token were removed.",
    applyLocalSuccess: () => {
      if (state.config && Array.isArray(state.config.infrastructureServices)) {
        state.config.infrastructureServices = state.config.infrastructureServices.filter(({ id }) => id !== serviceId);
      }
    },
    onSuccess: async () => {
      closeModal();
      await loadAuthenticatedData({ refresh: true });
    }
  });
}

async function testInfrastructureTarget(form, button) {
  if (!form) return;
  syncProxmoxForm(form);
  if (!form.reportValidity()) return;
  const error = form.querySelector("#proxmox-error");
  const panel = form.querySelector("#proxmox-test-result");
  const targetId = form.dataset.infrastructureTargetId;
  const tokenId = form.querySelector("input[name='proxmoxTokenId']")?.value || "";
  const tokenSecret = form.querySelector("input[name='proxmoxTokenSecret']")?.value || "";
  const useSavedTarget = Boolean(targetId)
    && proxmoxConnectionUnchanged(form)
    && !tokenId
    && !tokenSecret;
  const revision = advanceServiceTestRevision(form);
  error.textContent = "";
  panel.hidden = false;
  panel.dataset.state = "checking";
  panel.querySelector(".health-dot").className = "health-dot is-checking";
  panel.querySelector("[data-test-title]").textContent = "Testing Proxmox connection";
  panel.querySelector("[data-test-detail]").textContent = "Verifying reachability, certificate trust, token authentication, and read-only API access…";
  setMarkup(panel.querySelector("[data-test-capabilities]"), "");
  panel.querySelector("[data-test-note]").textContent = "Read-only test — nothing is saved.";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const endpoint = useSavedTarget
      ? `/api/v2/infrastructure/environments/${encodeURIComponent(targetId)}/test`
      : "/api/v2/infrastructure/environments/test";
    const result = await api(endpoint, {
      method: "POST",
      body: useSavedTarget ? {} : proxmoxTestBody(form)
    });
    if (form.isConnected && form.dataset.testRevision === revision) {
      showConnectionTestResult(form, { ...result, service: "proxmox" }, "#proxmox-test-result");
      panel.querySelector("[data-test-note]").textContent = `Tested ${formatTime(result?.checkedAt, "just now")}. Read-only test — nothing was saved.`;
      const discoveryRegion = form.querySelector("[data-proxmox-discovery]");
      const discovery = renderProxmoxDiscovery(result?.discovery);
      if (discoveryRegion) {
        discoveryRegion.hidden = false;
        setMarkup(discoveryRegion, discovery.markup);
      }
      form.dataset.discoveryConfirmed = result?.connectionState === "connected" && discovery.confirmed ? "true" : "false";
    }
  } catch (caught) {
    if (form.isConnected && form.dataset.testRevision === revision) {
      panel.hidden = true;
      error.textContent = caught.message;
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function submitInfrastructureTarget(form) {
  syncProxmoxForm(form);
  if (!form.reportValidity()) return;
  const targetId = form.dataset.infrastructureTargetId;
  const error = form.querySelector("#proxmox-error");
  const submit = form.querySelector("button[type='submit']");
  error.textContent = "";
  if (proxmoxFormNeedsDiscovery(form) && form.dataset.discoveryConfirmed !== "true") {
    error.textContent = "Connect and discover this exact endpoint, certificate trust, and token before confirming the environment.";
    return;
  }
  if (submit) {
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
  }
  try {
    await api(targetId
      ? `/api/v2/infrastructure/environments/${encodeURIComponent(targetId)}`
      : "/api/v2/infrastructure/environments", {
      method: targetId ? "PUT" : "POST",
      body: proxmoxDraftBody(form)
    });
    closeModal();
    await loadInfrastructureTargets({ render: false });
    await refreshOperations();
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast(targetId ? "Proxmox environment updated." : "Proxmox environment connected.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  } finally {
    if (submit?.isConnected) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  }
}

async function deleteInfrastructureTarget(targetId, button) {
  if (!INFRASTRUCTURE_ID_PATTERN.test(String(targetId || ""))) return;
  const environment = infrastructureTargetById(targetId);
  if (!environment) return;
  const targetRevision = environment.targetRevision;
  await runConfirmedDeletion(button, {
    key: `delete:proxmox:${targetId}`,
    title: "Remove Proxmox environment?",
    message: `Remove ${environment.displayName} and all of its protected endpoint credentials?`,
    confirmLabel: "Remove environment",
    path: `/api/v2/infrastructure/environments/${encodeURIComponent(targetId)}`,
    validate: () => infrastructureTargetById(targetId)?.targetRevision === targetRevision,
    staleMessage: "That Proxmox environment changed while confirmation was open. Review it before removing it.",
    successMessage: "Proxmox environment and its protected endpoint tokens were removed.",
    applyLocalSuccess: () => {
      state.infrastructure.targets = state.infrastructure.targets.filter(({ id }) => id !== targetId);
      if (state.config) {
        state.config.infrastructureEnvironments = state.infrastructure.targets;
        state.config.infrastructureTargets = state.infrastructure.targets;
      }
    },
    onSuccess: async () => {
      closeModal();
      await loadInfrastructureTargets({ render: false });
      await refreshOperations();
    }
  });
}

async function testInfrastructureEndpoint(form, button) {
  if (!form) return;
  syncProxmoxForm(form);
  if (!form.reportValidity()) return;
  const error = form.querySelector("#proxmox-endpoint-error");
  const panel = form.querySelector("#proxmox-endpoint-test-result");
  const environmentId = form.dataset.infrastructureTargetId;
  const endpointId = form.dataset.infrastructureEndpointId;
  const useSavedEndpoint = Boolean(endpointId) && proxmoxConnectionUnchanged(form) && !proxmoxFormHasDraftCredentials(form);
  const revision = advanceServiceTestRevision(form);
  error.textContent = "";
  panel.hidden = false;
  panel.dataset.state = "checking";
  panel.querySelector(".health-dot").className = "health-dot is-checking";
  panel.querySelector("[data-test-title]").textContent = "Verifying endpoint";
  panel.querySelector("[data-test-detail]").textContent = "Checking explicit network approval, certificate trust, API authorization, and environment identity…";
  setMarkup(panel.querySelector("[data-test-capabilities]"), "");
  panel.querySelector("[data-test-note]").textContent = "Read-only verification — nothing is saved.";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const base = `/api/v2/infrastructure/environments/${encodeURIComponent(environmentId)}/endpoints`;
    const result = await api(useSavedEndpoint ? `${base}/${encodeURIComponent(endpointId)}/test` : `${base}/test`, {
      method: "POST",
      body: useSavedEndpoint ? {} : proxmoxEndpointDraftBody(form)
    });
    if (form.isConnected && form.dataset.testRevision === revision) {
      showConnectionTestResult(form, { ...result, service: "proxmox" }, "#proxmox-endpoint-test-result");
      const environment = infrastructureHealthForTarget(environmentId);
      const discovery = renderProxmoxDiscovery(result?.discovery, environment);
      const region = form.querySelector("[data-proxmox-discovery]");
      if (region) {
        region.hidden = false;
        setMarkup(region, discovery.markup);
      }
      form.dataset.discoveryConfirmed = result?.connectionState === "connected" && discovery.confirmed ? "true" : "false";
      panel.querySelector("[data-test-note]").textContent = `Verified ${formatTime(result?.checkedAt, "just now")}. Read-only test — nothing was saved.`;
    }
  } catch (caught) {
    if (form.isConnected && form.dataset.testRevision === revision) {
      panel.hidden = true;
      error.textContent = caught.message;
      form.dataset.discoveryConfirmed = "false";
    }
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function submitInfrastructureEndpoint(form) {
  syncProxmoxForm(form);
  if (!form.reportValidity()) return;
  const environmentId = form.dataset.infrastructureTargetId;
  const endpointId = form.dataset.infrastructureEndpointId;
  const error = form.querySelector("#proxmox-endpoint-error");
  const submit = form.querySelector("button[type='submit']");
  error.textContent = "";
  if (proxmoxFormNeedsDiscovery(form) && form.dataset.discoveryConfirmed !== "true") {
    error.textContent = "Verify this exact endpoint, certificate trust, token, and Proxmox identity before confirming it.";
    return;
  }
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const base = `/api/v2/infrastructure/environments/${encodeURIComponent(environmentId)}/endpoints`;
    await api(endpointId ? `${base}/${encodeURIComponent(endpointId)}` : base, {
      method: endpointId ? "PUT" : "POST",
      body: proxmoxEndpointDraftBody(form)
    });
    closeModal();
    await loadInfrastructureTargets({ render: false });
    await refreshOperations();
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast(endpointId ? "Failover endpoint updated." : "Failover endpoint registered.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  } finally {
    if (submit?.isConnected) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  }
}

async function deleteInfrastructureEndpoint(environmentId, endpointId, button) {
  if (!INFRASTRUCTURE_ID_PATTERN.test(String(environmentId || "")) || !INFRASTRUCTURE_ID_PATTERN.test(String(endpointId || ""))) return;
  const configured = infrastructureTargetById(environmentId);
  const endpoint = configured?.endpoints.find(({ id }) => id === endpointId);
  if (!endpoint || endpoint.primary) return;
  const environmentRevision = configured.targetRevision;
  const endpointRevision = endpoint.targetRevision;
  await runConfirmedDeletion(button, {
    key: `delete:proxmox-endpoint:${environmentId}:${endpointId}`,
    title: "Remove failover endpoint?",
    message: `Remove the ${endpoint.label} failover endpoint and its protected token?`,
    confirmLabel: "Remove endpoint",
    path: `/api/v2/infrastructure/environments/${encodeURIComponent(environmentId)}/endpoints/${encodeURIComponent(endpointId)}`,
    validate: () => {
      const current = infrastructureTargetById(environmentId);
      const currentEndpoint = current?.endpoints.find(({ id }) => id === endpointId);
      return current?.targetRevision === environmentRevision
        && currentEndpoint?.targetRevision === endpointRevision
        && currentEndpoint?.primary === false;
    },
    staleMessage: "That failover endpoint changed while confirmation was open. Review it before removing it.",
    successMessage: "Failover endpoint removed.",
    applyLocalSuccess: () => {
      state.infrastructure.targets = state.infrastructure.targets.map((target) => target.id === environmentId
        ? { ...target, endpoints: target.endpoints.filter(({ id }) => id !== endpointId) }
        : target);
      if (state.config) {
        state.config.infrastructureEnvironments = state.infrastructure.targets;
        state.config.infrastructureTargets = state.infrastructure.targets;
      }
    },
    onSuccess: async () => {
      closeModal();
      await loadInfrastructureTargets({ render: false });
      await refreshOperations();
    }
  });
}

async function submitNetwork(form) {
  const data = new FormData(form);
  try {
    state.config = await api("/api/v2/config", {
      method: "PUT",
      body: {
        allowedCidrs: allowedCidrsForForm(form, data),
        allowPublicHttps: data.get("allowPublicHttps") === "on"
      }
    });
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast("Outbound network policy updated.", "success");
  } catch (error) {
    showToast(error.message, "danger");
  }
}

function setControlBusy(button, key) {
  state.actionMutation = key;
  state.actionAwaitingRefresh = "";
  for (const control of document.querySelectorAll("[data-control-key]")) control.disabled = true;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setMarkup(button, `${icon("refresh")} Working…`);
  }
}

function refreshControlSurface({ workloadId = "", mediaId = "", focusOperation = "", returnFocus = null } = {}) {
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  if (state.actionAwaitingRefresh) {
    if (modalLayer?.classList.contains("is-open")) closeModal({ restoreFocus: false });
    if (drawerLayer?.classList.contains("is-open")) closeMediaDrawer({ restoreFocus: false });
    requestAnimationFrame(() => restoreFocusReference(returnFocus, main));
    return;
  }
  if (workloadId && modalLayer?.classList.contains("is-open")) {
    const workload = infrastructureWorkloadById(workloadId);
    if (workload) {
      setMarkup(modalLayer, `<div class="modal-backdrop" data-action="close-modal"></div>${renderInfrastructureWorkloadDetail(workload)}`);
      requestAnimationFrame(() => {
        const preferred = modalLayer.querySelector(`[data-control-operation='${focusOperation}']`)
          || modalLayer.querySelector("#workload-detail-title");
        preferred?.focus();
      });
    } else {
      closeModal({ restoreFocus: false });
      requestAnimationFrame(() => restoreFocusReference(returnFocus, main));
    }
    return;
  }
  if (mediaId && drawerLayer?.classList.contains("is-open")) {
    const item = mediaRecordById(mediaId);
    if (item) {
      setMarkup(drawerLayer, `<div class="drawer-backdrop" data-action="close-media-drawer"></div>${renderMediaDetailDrawer(item)}`);
      requestAnimationFrame(() => {
        const preferred = drawerLayer.querySelector(`[data-control-operation='${focusOperation}']`)
          || drawerLayer.querySelector("#media-drawer-title");
        preferred?.focus();
      });
    } else {
      closeMediaDrawer({ restoreFocus: false });
      requestAnimationFrame(() => restoreFocusReference(returnFocus, main));
    }
    return;
  }
  requestAnimationFrame(() => restoreFocusReference(returnFocus, main));
}

function releaseActionRefreshLock() {
  if (!state.actionAwaitingRefresh) return false;
  state.actionAwaitingRefresh = "";
  state.actionMutation = "";
  return true;
}

async function performControl(button, {
  key,
  message,
  path,
  body,
  successMessage,
  workloadId = "",
  mediaId = "",
  operation = "",
  validate = null,
  staleMessage = "That action is no longer available. Refresh the current inventory and try again."
}) {
  if (state.actionMutation) return;
  const returnFocus = focusReference(button);
  const presentation = controlConfirmationPresentation(operation);
  const confirmed = await confirmControl({ ...presentation, message });
  if (!confirmed || state.actionMutation) return;
  let stillValid = true;
  if (typeof validate === "function") {
    try {
      stillValid = validate() === true;
    } catch {
      stillValid = false;
    }
  }
  if (!stillValid) {
    showToast(staleMessage, "danger");
    refreshControlSurface({ workloadId, mediaId, focusOperation: operation, returnFocus });
    return;
  }
  let accepted = false;
  let outcomeUnknown = false;
  setControlBusy(button, key);
  try {
    await api(path, { method: "POST", body });
    accepted = true;
    showToast(successMessage, "success");
  } catch (error) {
    outcomeUnknown = ["ACTION_OUTCOME_UNKNOWN", "NETWORK_ERROR", "INVALID_RESPONSE"].includes(error?.code)
      || error?.status === 0
      || !Number.isSafeInteger(error?.status);
    showToast(error.message, "danger");
  } finally {
    const refreshed = await refreshOperations({ afterCurrent: true });
    if (!refreshed && (accepted || outcomeUnknown)) {
      state.actionAwaitingRefresh = key;
      showToast("The action may have been accepted, but current state could not be refreshed. Wait before trying another action.", "danger");
    } else {
      state.actionAwaitingRefresh = "";
      state.actionMutation = "";
    }
    refreshControlSurface({ workloadId, mediaId, focusOperation: operation, returnFocus });
  }
}

async function runPortainerControl(button) {
  const operation = String(button?.dataset.controlOperation || "");
  const container = portainerContainerByKey(button?.dataset.portainerContainerKey);
  const context = container ? portainerActionContext(container) : null;
  const service = context?.configuration;
  const validForState = operation === "start"
    ? ["created", "exited"].includes(container?.state)
    : ["restart", "stop"].includes(operation) && container?.state === "running";
  if (!container
    || !service?.targetRevision
    || service.enabled === false
    || service.monitoringEnabled === false
    || !/^[a-f0-9]{64}$/u.test(container.id)
    || !validForState) {
    showToast("That container action is no longer available. Refresh the inventory and try again.", "danger");
    return;
  }
  const copy = {
    start: {
      confirm: `Start ${container.name} (${container.shortId}) in ${container.environmentName} on ${container.serverName}?`,
      success: `Start command accepted for ${container.name}.`
    },
    restart: {
      confirm: `Restart ${container.name} (${container.shortId}) in ${container.environmentName} on ${container.serverName}? It will be briefly unavailable.`,
      success: `Restart command accepted for ${container.name}.`
    },
    stop: {
      confirm: `Gracefully stop ${container.name} (${container.shortId}) in ${container.environmentName} on ${container.serverName}? It will remain offline until it is started again.`,
      success: `Stop command accepted for ${container.name}.`
    }
  }[operation];
  const validate = () => {
    const current = portainerContainerByKey(container.key);
    const currentContext = current ? portainerActionContext(current) : null;
    const currentStateAllowed = operation === "start"
      ? ["created", "exited"].includes(current?.state)
      : ["restart", "stop"].includes(operation) && current?.state === "running";
    return current?.id === container.id
      && currentContext?.configuration?.targetRevision === service.targetRevision
      && currentStateAllowed;
  };
  await performControl(button, {
    key: button.dataset.controlKey,
    message: copy.confirm,
    path: "/api/v2/actions/portainer/container",
    body: {
      serviceId: container.serverId,
      environmentId: container.environmentId,
      containerId: container.id,
      operation,
      targetRevision: service.targetRevision
    },
    successMessage: copy.success,
    operation,
    validate,
    staleMessage: "That container action is no longer available. Refresh the inventory and try again."
  });
}

async function runProxmoxControl(button) {
  const operation = String(button?.dataset.controlOperation || "");
  const workloadId = String(button?.dataset.infrastructureWorkloadId || "");
  const workload = infrastructureWorkloadById(workloadId);
  const context = workload ? proxmoxActionContext(workload) : null;
  const environment = context?.environment;
  const validForState = operation === "start"
    ? workload?.status === "stopped"
    : ["reboot", "shutdown"].includes(operation) && workload?.status === "running";
  if (!workload
    || !environment?.targetRevision
    || environment.enabled === false
    || environment.monitoringEnabled === false
    || workload.node === "Unassigned"
    || !Number.isSafeInteger(workload.vmid)
    || workload.template
    || workload.lock
    || !validForState) {
    showToast("That guest power action is no longer available. Refresh the inventory and try again.", "danger");
    return;
  }
  const copy = {
    start: {
      confirm: `Start ${workload.name} (${workload.kind} ${workload.vmid}) on ${workload.node} in ${workload.environmentName}?`,
      success: `Start command accepted for ${workload.name}.`
    },
    reboot: {
      confirm: `Gracefully reboot ${workload.name} (${workload.kind} ${workload.vmid}) on ${workload.node} in ${workload.environmentName}? Its services will be briefly unavailable.`,
      success: `Reboot command accepted for ${workload.name}.`
    },
    shutdown: {
      confirm: `Gracefully shut down ${workload.name} (${workload.kind} ${workload.vmid}) on ${workload.node} in ${workload.environmentName}? It will remain offline until it is started again.`,
      success: `Shutdown command accepted for ${workload.name}.`
    }
  }[operation];
  const validate = () => {
    const current = infrastructureWorkloadById(workloadId);
    const currentContext = current ? proxmoxActionContext(current) : null;
    const currentStateAllowed = operation === "start"
      ? current?.status === "stopped"
      : ["reboot", "shutdown"].includes(operation) && current?.status === "running";
    return current?.id === workload.id
      && currentContext?.environment?.targetRevision === environment.targetRevision
      && !current?.template
      && !current?.lock
      && currentStateAllowed;
  };
  await performControl(button, {
    key: button.dataset.controlKey,
    message: copy.confirm,
    path: "/api/v2/actions/proxmox/workload",
    body: {
      environmentId: workload.environmentId,
      node: workload.node,
      type: workload.type,
      vmid: workload.vmid,
      operation,
      targetRevision: environment.targetRevision
    },
    successMessage: copy.success,
    workloadId,
    operation,
    validate,
    staleMessage: "That guest power action is no longer available. Refresh the inventory and try again."
  });
}

async function runMediaControl(button) {
  const mediaId = String(button?.dataset.mediaId || "");
  const serviceId = String(button?.dataset.controlService || "");
  const operation = String(button?.dataset.controlOperation || "");
  const resourceId = String(button?.dataset.controlResourceId || "");
  const item = mediaRecordById(mediaId);
  const connection = configuredMediaConnection(serviceId);
  const allowed = mediaControlActions(item).some((action) => (
    action.serviceId === serviceId && action.operation === operation && action.resourceId === resourceId
  ));
  if (!item || !connection?.targetRevision || !allowed) {
    showToast("That media action is no longer available. Refresh the media view and try again.", "danger");
    return;
  }
  const retry = operation === "retryRequest";
  const validate = () => {
    const currentItem = mediaRecordById(mediaId);
    const currentConnection = configuredMediaConnection(serviceId);
    return currentConnection?.targetRevision === connection.targetRevision
      && mediaControlActions(currentItem).some((action) => (
        action.serviceId === serviceId
        && action.operation === operation
        && action.resourceId === resourceId
      ));
  };
  await performControl(button, {
    key: button.dataset.controlKey,
    message: retry
      ? `Retry the failed Seerr request for ${item.title} (request ${resourceId})?`
      : item.mediaType === "episode"
        ? `Search the Sonarr series containing ${item.title}? Sonarr may send a matching release to the download client.`
        : `Search again for ${item.title} in ${serviceId === "radarr" ? "Radarr" : "Sonarr"}? It may send a matching release to the download client.`,
    path: "/api/v2/actions/media",
    body: {
      serviceId,
      operation,
      resourceId: Number(resourceId),
      targetRevision: connection.targetRevision
    },
    successMessage: retry
      ? `Seerr retry started for ${item.title}.`
      : `${serviceId === "radarr" ? "Radarr" : "Sonarr"} search started for ${item.title}.`,
    mediaId,
    operation,
    validate,
    staleMessage: "That media action is no longer available. Refresh the media view and try again."
  });
}

async function refreshOperations({ announce = false, afterCurrent = false } = {}) {
  if (!state.status?.authenticated) return false;
  if (state.operationsRefreshPromise) {
    const currentPromise = state.operationsRefreshPromise;
    const currentResult = await currentPromise;
    if (state.operationsRefreshPromise === currentPromise) state.operationsRefreshPromise = null;
    if (!afterCurrent || !state.status?.authenticated) return currentResult;
  }

  state.refreshing = true;
  updateChrome();
  const refreshPromise = (async () => {
    const requestGeneration = ++state.operationsRequestGeneration;
    try {
      const snapshot = await api("/api/v2/operations/refresh", { method: "POST", body: {} });
      if (requestGeneration !== state.operationsRequestGeneration) return false;
      const changed = operationalFingerprint(snapshot) !== operationalFingerprint(state.snapshot);
      state.snapshot = snapshot;
      const releasedActionLock = releaseActionRefreshLock();
      if (changed || releasedActionLock) {
        if (releasedActionLock) state.lastMarkup = "";
        renderPage({ force: releasedActionLock, preserveFocus: true });
        updateVolatileOperationsUi();
      } else updateVolatileOperationsUi();
      if (announce) showToast("Health checks completed.", "success");
      return true;
    } catch (error) {
      if (error.status === 401) await initialize();
      else if (announce) showToast(error.message, "danger");
      return false;
    } finally {
      state.refreshing = false;
      updateChrome();
    }
  })();
  state.operationsRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (state.operationsRefreshPromise === refreshPromise) state.operationsRefreshPromise = null;
  }
}

async function loadOperations() {
  if (state.operationsRefreshPromise) return state.operationsRefreshPromise;
  const requestGeneration = ++state.operationsRequestGeneration;
  try {
    const snapshot = await api("/api/v2/operations/snapshot");
    if (requestGeneration !== state.operationsRequestGeneration) return false;
    const changed = operationalFingerprint(snapshot) !== operationalFingerprint(state.snapshot);
    state.snapshot = snapshot;
    const releasedActionLock = releaseActionRefreshLock();
    if (changed || releasedActionLock) {
      if (releasedActionLock) state.lastMarkup = "";
      renderPage({ force: releasedActionLock, preserveFocus: true });
      updateVolatileOperationsUi();
    } else updateVolatileOperationsUi();
    return true;
  } catch (error) {
    if (error.status === 401) {
      if (!state.starting) await initialize();
      else throw error;
      return false;
    }
    if (error.code !== "MONITOR_STARTING") throw error;
    return false;
  }
}

async function loadInfrastructureTargets({ render = false } = {}) {
  if (state.infrastructure.loading || !state.status?.authenticated) return false;
  state.infrastructure.loading = true;
  if (render && state.workspace === "infrastructure") {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  let succeeded = false;
  try {
    const payload = await api("/api/v2/infrastructure/environments");
    state.infrastructure.targets = normalizedInfrastructureTargets(payload);
    state.infrastructure.error = "";
    state.infrastructure.loaded = true;
    if (state.config) {
      state.config.infrastructureEnvironments = state.infrastructure.targets;
      state.config.infrastructureTargets = state.infrastructure.targets;
    }
    succeeded = true;
  } catch (error) {
    state.infrastructure.error = safeSessionText(error?.message, "The environment list could not be loaded.", 220);
    state.infrastructure.loaded = true;
  } finally {
    state.infrastructure.loading = false;
  }
  if (render && state.workspace === "infrastructure") {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  return succeeded;
}

function sessionFingerprint(sessions = state.sessions) {
  return JSON.stringify({
    loaded: Boolean(sessions?.loaded),
    currentSessionId: String(sessions?.currentSessionId || ""),
    items: Array.isArray(sessions?.items) ? sessions.items : [],
    error: String(sessions?.error || "")
  });
}

async function loadSessions({ render = false } = {}) {
  const previous = sessionFingerprint();
  let succeeded = false;
  try {
    const payload = await api("/api/v2/sessions");
    const normalized = normalizedSessionList(payload);
    state.sessions = { loaded: true, ...normalized, error: "" };
    succeeded = true;
  } catch (error) {
    state.sessions = {
      ...state.sessions,
      loaded: true,
      error: safeSessionText(error?.message, "The browser session list could not be loaded.", 180)
    };
  }
  const changed = previous !== sessionFingerprint();
  if (render && changed && state.status?.authenticated && currentRoute() === "settings") {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  return succeeded;
}

function clearAuthenticatedState() {
  closeControlConfirmation(false, { restoreFocus: false });
  if (modalLayer?.classList.contains("is-open")) closeModal({ restoreFocus: false });
  if (drawerLayer?.classList.contains("is-open")) closeMediaDrawer({ restoreFocus: false });
  state.status = { ...state.status, authenticated: false, session: null };
  state.csrfToken = "";
  state.config = null;
  state.snapshot = null;
  state.accessKeyReveal = "";
  state.accessKeyMutation = false;
  state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
  state.sessionMutation = "";
  state.actionMutation = "";
  state.actionAwaitingRefresh = "";
  state.operationsRequestGeneration += 1;
  state.operationsRefreshPromise = null;
  state.refreshing = false;
  state.infrastructure = emptyInfrastructureState();
  state.lastMarkup = "";
}

async function rotateAccessKey() {
  if (state.accessKeyMutation) return;
  if (state.status?.accessKeyConfigured
    && !(await confirmControl({
      title: "Rotate the universal access key?",
      message: "The current key will stop working and every other browser will be signed out.",
      confirmLabel: "Rotate access key",
      tone: "danger"
    }))) {
    return;
  }
  state.accessKeyMutation = true;
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  try {
    const result = await api("/api/v2/access/rotate", { method: "POST", body: {} });
    const accessKey = typeof result?.accessKey === "string" ? result.accessKey : "";
    if (!accessKey || accessKey.length > 1024) {
      throw new ApiError(502, "INVALID_RESPONSE", "The container did not return a valid access key.");
    }
    state.csrfToken = result.csrfToken;
    state.status = { ...state.status, authenticated: true, accessKeyConfigured: true, session: result.session };
    state.accessKeyReveal = accessKey;
    state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
    await loadSessions();
    showToast("New access key created. Save it now; the previous key no longer works.", "success");
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    state.accessKeyMutation = false;
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
}

async function revokeBrowserSession(sessionId) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || "")) || state.sessionMutation) return;
  const isCurrent = sessionId === state.sessions.currentSessionId || sessionId === state.status?.session?.id;
  state.sessionMutation = sessionId;
  try {
    await api(`/api/v2/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (isCurrent) {
      clearAuthenticatedState();
      showToast("This browser was signed out.", "success");
    } else {
      state.sessions = {
        ...state.sessions,
        items: state.sessions.items.filter((session) => session.id !== sessionId)
      };
      showToast("Browser access revoked.", "success");
    }
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    state.sessionMutation = "";
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: !isCurrent });
  }
}

async function loadAuthenticatedData(options = {}) {
  const [config] = await Promise.all([api("/api/v2/config"), loadOperations(), loadSessions()]);
  state.config = config;
  state.infrastructure.targets = normalizedInfrastructureTargets(config?.infrastructureEnvironments || config?.infrastructureTargets || []);
  state.infrastructure.loaded = true;
  state.infrastructure.error = "";
  if (options.refresh) await refreshOperations();
}

function schedulePolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.visibilityState === "visible" && state.status?.authenticated) {
      try {
        await loadOperations();
      } catch {
        // The next interval or a manual check retries without replacing the UI.
      }
    }
  }, 30_000);
}

async function initialize() {
  closeControlConfirmation(false, { restoreFocus: false });
  if (modalLayer?.classList.contains("is-open")) closeModal({ restoreFocus: false });
  if (drawerLayer?.classList.contains("is-open")) closeMediaDrawer({ restoreFocus: false });
  state.starting = true;
  state.fatalError = "";
  state.lastMarkup = "";
  renderPage({ force: true });
  try {
    state.status = await api("/api/v2/status");
    state.csrfToken = state.status.csrfToken || "";
    if (state.status.authenticated) await loadAuthenticatedData();
    else {
      state.config = null;
      state.snapshot = null;
      state.accessKeyReveal = "";
      state.accessKeyMutation = false;
      state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
      state.sessionMutation = "";
      state.infrastructure = emptyInfrastructureState();
    }
  } catch (error) {
    state.fatalError = error.message;
  } finally {
    state.starting = false;
    state.lastMarkup = "";
    renderPage({ force: true });
    schedulePolling();
  }
}

document.addEventListener("click", async (event) => {
  // Only explicit controls participate in delegated actions. The service form
  // also carries a service id for submission; treating every ancestor with a
  // service id as an opener rebuilt the modal whenever an input or checkbox
  // was clicked, which reset its value and returned focus to the URL field.
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "approve-control-confirm") {
    closeControlConfirmation(true);
    return;
  }
  if (action === "cancel-control-confirm") {
    closeControlConfirmation(false);
    return;
  }
  if (action === "toggle-sidebar") toggleSidebar();
  if (action === "switch-workspace") await switchWorkspace(target.dataset.workspace);
  if (action === "open-service") openService(target.dataset.serviceId);
  if (action === "open-media-detail") openMediaDrawer(target.dataset.mediaId);
  if (action === "close-media-drawer") closeMediaDrawer();
  if (action === "open-request-filter") {
    state.media.filters.requests = String(target.dataset.mediaFilterValue || "pending");
  }
  if (action === "media-filter") {
    const filterName = target.dataset.mediaFilterName;
    if (["libraryType", "requests", "activity"].includes(filterName)) {
      state.media.filters[filterName] = String(target.dataset.mediaFilterValue || "all");
      for (const button of main.querySelectorAll?.(`[data-media-filter-name='${filterName}']`) || []) {
        const active = button.dataset.mediaFilterValue === state.media.filters[filterName];
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      applyMediaFiltersInPlace();
    }
  }
  if (action === "open-infrastructure-target") openInfrastructureTarget(target.dataset.infrastructureTargetId);
  if (action === "open-infrastructure-environment-detail") openInfrastructureEnvironmentDetail(target.dataset.infrastructureTargetId);
  if (action === "open-infrastructure-node") openInfrastructureNode(target.dataset.infrastructureNodeId);
  if (action === "open-infrastructure-workload") openInfrastructureWorkload(target.dataset.infrastructureWorkloadId);
  if (action === "open-portainer-service") openPortainerService(target.dataset.portainerServiceId || "");
  if (action === "open-portainer-overview") {
    const serviceId = String(target.dataset.portainerOverviewId || "").toLowerCase();
    if (normalizedPortainerConfigurations().some(({ id }) => id === serviceId)) {
      event.preventDefault();
      state.infrastructure.portainerFilters = {
        server: serviceId,
        environment: "all",
        state: "all",
        search: ""
      };
      location.hash = "#/portainer";
    }
  }
  if (action === "run-portainer-control") await runPortainerControl(target);
  if (action === "run-proxmox-control") await runProxmoxControl(target);
  if (action === "run-media-control") await runMediaControl(target);
  if (action === "open-infrastructure-endpoint" || action === "add-infrastructure-endpoint") {
    openInfrastructureEndpoint(target.dataset.infrastructureTargetId, target.dataset.infrastructureEndpointId || "");
  }
  if (action === "close-modal") closeModal();
  if (action === "retry-startup") initialize();
  if (action === "refresh-live") refreshOperations({ announce: true });
  if (action === "test-service") testService(target.closest("#service-form"), target);
  if (action === "delete-service") await deleteService(target.dataset.serviceId, target);
  if (action === "test-portainer-service") testPortainerService(target.closest("#portainer-form"), target);
  if (action === "delete-portainer-service") await deletePortainerService(target.dataset.portainerServiceId, target);
  if (action === "test-infrastructure-target") testInfrastructureTarget(target.closest("#proxmox-form"), target);
  if (action === "delete-infrastructure-target") await deleteInfrastructureTarget(target.dataset.infrastructureTargetId, target);
  if (action === "test-infrastructure-endpoint") testInfrastructureEndpoint(target.closest("#proxmox-endpoint-form"), target);
  if (action === "delete-infrastructure-endpoint") await deleteInfrastructureEndpoint(
    target.dataset.infrastructureTargetId,
    target.dataset.infrastructureEndpointId,
    target
  );
  if (action === "retry-infrastructure-targets") {
    target.disabled = true;
    await loadInfrastructureTargets({ render: true });
    if (target.isConnected) target.disabled = false;
  }
  if (action === "rotate-access-key") await rotateAccessKey();
  if (action === "copy-access-key" && state.accessKeyReveal) {
    try {
      await navigator.clipboard.writeText(state.accessKeyReveal);
      showToast("Access key copied. Save it in your password manager.", "success");
    } catch {
      showToast("Copy failed. Select and copy the displayed access key manually.", "danger");
    }
  }
  if (action === "dismiss-access-key") {
    state.accessKeyReveal = "";
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  if (action === "refresh-sessions") {
    target.disabled = true;
    const succeeded = await loadSessions({ render: true });
    if (succeeded) showToast("Authorized browsers refreshed.", "success");
    else showToast(state.sessions.error, "danger");
    if (target.isConnected) target.disabled = false;
  }
  if (action === "revoke-session") {
    target.disabled = true;
    await revokeBrowserSession(target.dataset.sessionId);
    if (target.isConnected) target.disabled = false;
  }
  if (action === "logout") {
    try {
      await api("/api/v2/session", { method: "DELETE", body: {} });
    } finally {
      clearAuthenticatedState();
      renderPage({ force: true });
    }
  }
});

document.addEventListener("change", (event) => {
  const fieldName = String(event.target?.name || "");
  const portainerFilter = event.target?.dataset?.portainerFilter;
  if (portainerFilter && portainerFilter !== "search") {
    state.infrastructure.portainerFilters[portainerFilter] = String(event.target.value || "all");
    if (portainerFilter === "server") state.infrastructure.portainerFilters.environment = "all";
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    announcePortainerFilterResults();
  }
  const infrastructureFilter = event.target?.dataset?.infrastructureFilter;
  if (infrastructureFilter && infrastructureFilter !== "search") {
    state.infrastructure.filters[infrastructureFilter] = String(event.target.value || "all");
    if (infrastructureFilter === "environment") state.infrastructure.filters.node = "all";
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  if (fieldName === "networkMode") {
    syncNetworkPolicyFields(event.target.closest?.("#setup-form, #network-form"));
  }
  const serviceForm = event.target.closest?.("#service-form");
  if (serviceForm && ["authMode", "url", "username", "password", "credential"].includes(fieldName)) {
    syncServiceAuthFields(serviceForm);
    invalidateServiceTest(serviceForm);
  }
  const proxmoxForm = event.target.closest?.("#proxmox-form");
  if (proxmoxForm && ["tlsMode", "url", "certificateFingerprint", "proxmoxTokenId", "proxmoxTokenSecret"].includes(fieldName)) {
    syncProxmoxForm(proxmoxForm);
    invalidateProxmoxTest(proxmoxForm);
  }
  const endpointForm = event.target.closest?.("#proxmox-endpoint-form");
  if (endpointForm && ["tlsMode", "url", "certificateFingerprint", "proxmoxTokenId", "proxmoxTokenSecret"].includes(fieldName)) {
    syncProxmoxForm(endpointForm);
    invalidateProxmoxEndpointTest(endpointForm);
  }
  const portainerForm = event.target.closest?.("#portainer-form");
  if (portainerForm && ["tlsMode", "url", "certificateFingerprint", "accessToken"].includes(fieldName)) {
    syncPortainerForm(portainerForm);
    invalidatePortainerTest(portainerForm);
  }
});

document.addEventListener("input", (event) => {
  const fieldName = String(event.target?.name || "");
  const mediaFilter = event.target?.dataset?.mediaFilter;
  if (["homeSearch", "discover", "library"].includes(mediaFilter)) {
    state.media.filters[mediaFilter] = String(event.target.value || "").slice(0, 120);
    clearTimeout(mediaFilterTimer);
    mediaFilterTimer = setTimeout(applyMediaFiltersInPlace, 80);
  }
  if (event.target?.dataset?.infrastructureFilter === "search") {
    state.infrastructure.filters.search = String(event.target.value || "").slice(0, 120);
    clearTimeout(infrastructureFilterTimer);
    infrastructureFilterTimer = setTimeout(() => {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }, 120);
  }
  if (event.target?.dataset?.portainerFilter === "search") {
    state.infrastructure.portainerFilters.search = String(event.target.value || "").slice(0, 120);
    clearTimeout(infrastructureFilterTimer);
    infrastructureFilterTimer = setTimeout(() => {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
      announcePortainerFilterResults();
    }, 120);
  }
  const serviceForm = event.target.closest?.("#service-form");
  if (serviceForm && ["url", "username", "password", "credential"].includes(fieldName)) {
    syncServiceAuthFields(serviceForm);
    invalidateServiceTest(serviceForm);
  }
  const proxmoxForm = event.target.closest?.("#proxmox-form");
  if (proxmoxForm && ["url", "certificateFingerprint", "proxmoxTokenId", "proxmoxTokenSecret"].includes(fieldName)) {
    syncProxmoxForm(proxmoxForm);
    invalidateProxmoxTest(proxmoxForm);
  }
  const endpointForm = event.target.closest?.("#proxmox-endpoint-form");
  if (endpointForm && ["url", "certificateFingerprint", "proxmoxTokenId", "proxmoxTokenSecret"].includes(fieldName)) {
    syncProxmoxForm(endpointForm);
    invalidateProxmoxEndpointTest(endpointForm);
  }
  const portainerForm = event.target.closest?.("#portainer-form");
  if (portainerForm && ["url", "certificateFingerprint", "accessToken"].includes(fieldName)) {
    syncPortainerForm(portainerForm);
    invalidatePortainerTest(portainerForm);
  }
});

document.addEventListener("error", (event) => {
  if (event.target?.classList?.contains("media-art-image") || event.target?.classList?.contains("hero-art-image")) {
    if (!retryMediaArtwork(event.target)) event.target.remove();
  }
}, true);

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "media-search-form") {
    state.media.filters.library = String(new FormData(event.target).get("query") || state.media.filters.homeSearch || "").slice(0, 120);
    location.hash = "#/library";
  }
  if (event.target.id === "setup-form") submitSetup(event.target);
  if (event.target.id === "access-login-form") submitAccessLogin(event.target);
  if (event.target.id === "service-form") submitService(event.target);
  if (event.target.id === "portainer-form") submitPortainerService(event.target);
  if (event.target.id === "proxmox-form") submitInfrastructureTarget(event.target);
  if (event.target.id === "proxmox-endpoint-form") submitInfrastructureEndpoint(event.target);
  if (event.target.id === "network-form") submitNetwork(event.target);
});

window.addEventListener("hashchange", () => {
  closeControlConfirmation(false, { restoreFocus: false });
  closeMediaDrawer({ restoreFocus: false });
  if (rawRoute() !== "settings") state.accessKeyReveal = "";
  state.lastMarkup = "";
  renderPage({ force: true });
  resetRouteScroll();
  main.focus({ preventScroll: true });
});

window.addEventListener("keydown", (event) => {
  const activeLayer = controlConfirmLayer?.classList.contains("is-open")
    ? controlConfirmLayer
    : modalLayer.classList.contains("is-open")
      ? modalLayer
      : drawerLayer?.classList.contains("is-open") ? drawerLayer : null;
  if (!activeLayer) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (activeLayer === controlConfirmLayer) closeControlConfirmation(false);
    else if (activeLayer === modalLayer) closeModal();
    else closeMediaDrawer();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...activeLayer.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getAttribute?.("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!focusable.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

sessionButton.addEventListener("click", () => {
  if (state.status?.authenticated) location.hash = "#/settings";
});

if (!location.hash || !ROUTES.has(rawRoute())) location.replace(state.workspace === "infrastructure" ? "#/overview" : "#/home");
initialize();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
