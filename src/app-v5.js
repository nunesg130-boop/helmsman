import {
  escapeOperationsHtml as escapeHtml,
  incidentNextStep,
  infrastructureSnapshotForTargets,
  normalizeInfrastructureSnapshot,
  normalizeOperationsReports,
  normalizeOperationsSnapshot,
  proxmoxBrandLinkMarkup,
  renderInfrastructureOverview,
  renderOperationsOverview,
  renderOperationsReports,
  renderReportIgnoreButton,
  serviceIconMarkup,
  workloadIconMarkup
} from "./ui/operations-views.js";
import {
  MANUAL_TEMPLATE,
  manualSnippet,
  parseManual,
  searchManualEntries
} from "./ui/manual-markdown.js";
import { createNetworkMapController } from "./ui/network-map.js";

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
const globalRefreshButton = document.querySelector("#global-refresh");
const sessionButton = document.querySelector("#session-button");
const privacyButton = document.querySelector("#privacy-button");
const skipLink = document.querySelector("#skip-link");
let infrastructureFilterTimer = null;
let mediaFilterTimer = null;
let loggingFilterTimer = null;
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

function emptyLoggingState() {
  return {
    journal: {
      loaded: false,
      loading: false,
      error: "",
      storage: null,
      entries: [],
      nextCursor: "",
      filters: {
        search: "",
        level: "all",
        kind: "all",
        source: "all",
        range: "24h"
      },
      requestGeneration: 0
    },
    settings: { loaded: false, loading: false, saving: false, error: "", level: "normal", debugUntil: null, defaultHours: 4, maximumHours: 24 },
    output: { loaded: false, loading: false, error: "", lines: [], capturing: false },
    loki: {
      loading: false,
      error: "",
      entries: [],
      truncated: false,
      stats: null,
      connectorId: "",
      range: "1h",
      service: "",
      contextService: "",
      query: "{job=~\".+\"}",
      search: "",
      requestGeneration: 0,
      lastRunAt: "",
      resultRouteHash: ""
    }
  };
}

const SERVICE_WORKER_URL = "./sw.js";

const renderPolicy = globalThis.trustedTypes?.createPolicy("helmsman-render", {
  createHTML: (markup) => markup,
  // The only script URL Helmsman ever loads at run time is its own worker.
  createScriptURL: (url) => {
    if (url !== SERVICE_WORKER_URL) throw new TypeError("That script URL is not allowed.");
    return url;
  }
}) ?? null;

function setMarkup(element, markup) {
  element.innerHTML = renderPolicy ? renderPolicy.createHTML(markup) : markup;
}

const SERVICE_ORDER = ["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "qbittorrent", "bazarr"];
const SERVICE_URL_PLACEHOLDERS = Object.freeze({
  jellyfin: "http://media-server:8096",
  seerr: "http://request-manager:5055",
  radarr: "http://movie-manager:7878",
  sonarr: "http://series-manager:8989",
  prowlarr: "http://indexer-manager:9696",
  qbittorrent: "http://download-client:8080",
  bazarr: "http://subtitle-manager:6767"
});
const MEDIA_CONNECTION_CATEGORIES = Object.freeze([
  Object.freeze({ id: "media-server", kicker: "Playback", title: "Media server", description: "Library discovery, playback state, and recently added media.", services: Object.freeze(["jellyfin"]) }),
  Object.freeze({ id: "requests", kicker: "Discovery", title: "Requests", description: "Audience discovery and request workflow visibility.", services: Object.freeze(["seerr"]) }),
  Object.freeze({ id: "media-management", kicker: "Automation", title: "Media management", description: "Movie and series monitoring, queues, imports, and health.", services: Object.freeze(["radarr", "sonarr"]) }),
  Object.freeze({ id: "indexers", kicker: "Search", title: "Indexers", description: "Indexer availability and blocked-source visibility.", services: Object.freeze(["prowlarr"]) }),
  Object.freeze({ id: "download-clients", kicker: "Acquisition", title: "Download clients", description: "Transfer state and active download workload.", services: Object.freeze(["qbittorrent"]) }),
  Object.freeze({ id: "subtitles", kicker: "Accessibility", title: "Subtitles", description: "Subtitle health and wanted-item backlog.", services: Object.freeze(["bazarr"]) })
]);
const SHARED_ROUTES = new Set(["logs", "settings"]);
const SYSTEM_ROUTES = new Set(["system", "launchpad", "manual", ...SHARED_ROUTES]);
const MEDIA_ROUTES = new Set(["overview", "discover", "library", "requests", "activity", "calendar", "health", "connections", ...SHARED_ROUTES]);
const INFRASTRUCTURE_ROUTES = new Set(["overview", "connectors", "proxmox", "workloads", "portainer", "network", "incidents", ...SHARED_ROUTES]);
const ROUTES = new Set([...SYSTEM_ROUTES, ...MEDIA_ROUTES, ...INFRASTRUCTURE_ROUTES, "home", "pipeline", "services", "environments", "nodes"]);
const MEDIA_ROUTE_ALIASES = Object.freeze({ home: "overview", pipeline: "health", incidents: "health", services: "connections" });
const INFRASTRUCTURE_ROUTE_ALIASES = Object.freeze({
  environments: "proxmox",
  nodes: "proxmox",
  pipeline: "overview",
  services: "connectors",
  connections: "connectors"
});
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const INFRASTRUCTURE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SEASON_DETAIL_REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const SEASON_DETAIL_CACHE_TTL_MS = 60_000;
const MAX_SEASON_CATALOG_SIZE = 256;
const MAX_REQUESTED_SEASONS = 100;
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
  system: "Overview",
  home: "Overview",
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
  network: "Network",
  launchpad: "Launchpad",
  manual: "Manual",
  logs: "Logs",
  settings: "Settings"
});
const WORKSPACES = new Set(["system", "media", "infrastructure"]);

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
  route: "overview",
  workspace: savedWorkspace(),
  sidebarCollapsed: savedSidebarCollapsed(),
  status: null,
  config: null,
  snapshot: null,
  csrfToken: "",
  starting: true,
  refreshing: false,
  globalRefreshing: false,
  operationsRequestGeneration: 0,
  operationsRefreshPromise: null,
  actionMutation: "",
  actionAwaitingRefresh: "",
  fatalError: "",
  pollTimer: null,
  lastMarkup: "",
  sessions: {
    loaded: false,
    currentSessionId: "",
    items: [],
    error: ""
  },
  sessionMutation: "",
  infrastructure: emptyInfrastructureState(),
  logging: emptyLoggingState(),
  agent: emptyAgentState(),
  prowlarr: emptyProwlarrState(),
  arrIndexers: {},
  launchpad: { loaded: false, loading: false, links: [], filter: "", error: "" },
  manual: emptyManualState(),
  search: { query: "", open: false, active: 0, results: [] },
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
    drawerReturnFocus: null,
    seasonDetails: new Map(),
    seasonLoads: new Map(),
    seasonGeneration: 0
  },
  modalReturnFocus: null,
  confirmationResolver: null,
  confirmationReturnFocus: null,
  authGateFocusApplied: false
};

// Compare the bounded view model rather than the raw monitor payload. Raw
// service metrics include fast-moving values such as qBittorrent transfer
// speed which are not rendered on these pages and must not repaint the UI.
// Visible volatile values are patched in place by updateVolatileOperationsUi.
function operationalFingerprint(snapshot) {
  if (!snapshot) return "";
  const normalized = normalizeOperationsSnapshot(snapshot, state.infrastructure.targets);
  const route = currentRoute();
  const includeOperationsStructure = state.workspace === "system"
    ? route === "system"
    : state.workspace === "media"
      ? ["overview", "health", "connections"].includes(route)
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
  const infrastructure = ["system", "infrastructure"].includes(state.workspace)
    && ["system", "overview", "connectors", "proxmox", "workloads", "portainer"].includes(route)
    ? normalizeInfrastructureSnapshot(snapshot, state.infrastructure.targets)
    : null;
  const configuredInfrastructureIds = new Set(state.infrastructure.targets.map(({ id }) => id));
  const infrastructureTargets = infrastructure
    ? infrastructure.targets.filter(({ id }) => !["system", "overview", "connectors"].includes(route) || configuredInfrastructureIds.has(id))
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
  const includePortainerStructure = ["system", "infrastructure"].includes(state.workspace)
    && ["system", "overview", "connectors", "portainer"].includes(route);
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
  const lokiStructure = state.workspace === "infrastructure" && ["overview", "connectors", "logs"].includes(route)
    ? (Array.isArray(snapshot?.infrastructure?.services) ? snapshot.infrastructure.services : [])
      .filter((service) => service?.type === "loki")
      .map((service) => ({
        id: service.id,
        state: service.state,
        connectionState: service.connectionState,
        checkedAt: service.checkedAt || service.lastCheckedAt,
        latencyMs: service.latencyMs,
        version: service.version
      }))
    : null;
  const visibleInfrastructureServiceIds = new Set([
    ...infrastructureTargets.flatMap((target) => [target.id, `proxmox-${target.id}`]),
    ...fingerprintPortainers.flatMap((service) => [service.id, `portainer-${service.id}`])
  ]);
  const infrastructureEventsStructure = (
    (state.workspace === "infrastructure" && route === "overview")
    || (state.workspace === "system" && route === "system")
  )
    ? {
        incidents: normalized.incidents
          .filter((entry) => entry.scope === "infrastructure" && visibleInfrastructureServiceIds.has(entry.service))
          .map(({ id, service, serviceName, capability, state: incidentState, code, status, summary, occurrenceCount, firstSeen, lastSeen }) => ({
            id,
            service,
            serviceName,
            capability,
            state: incidentState,
            code,
            status,
            summary,
            occurrenceCount,
            firstSeen,
            lastSeen
          })),
        recoveries: normalized.recentRecoveries
          .filter((entry) => entry.scope === "infrastructure" && visibleInfrastructureServiceIds.has(entry.service))
          .map(({ id, service, serviceName, capability, previousState, occurrenceCount, firstSeen, lastSeen, recoveredAt }) => ({
            id,
            service,
            serviceName,
            capability,
            previousState,
            occurrenceCount,
            firstSeen,
            lastSeen,
            recoveredAt
          }))
      }
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
  const mediaStructure = (
    (state.workspace === "media" && !["health", "connections", "logs", "settings"].includes(route))
    || (state.workspace === "system" && route === "system")
  )
    ? mediaStructuralFingerprint(snapshot?.media)
    : "";
  const cacheState = snapshot?.cache?.state === "cached"
    ? `cached:${snapshot.cache.storedAt || snapshot.cache.generatedAt || snapshot.generatedAt || "unknown"}`
    : "live";
  return `${cacheState}\n${structure}\n${JSON.stringify(liveShape)}\n${JSON.stringify(infrastructureStructure)}\n${JSON.stringify(portainerStructure)}\n${JSON.stringify(lokiStructure)}\n${JSON.stringify(infrastructureEventsStructure)}\n${JSON.stringify(logs)}\n${mediaStructure}`;
}

function rawRoute() {
  return String(location.hash || "#/overview")
    .replace(/^#\//u, "")
    .split("?", 1)[0];
}

const LOGGING_VIEWS = new Set(["overview", "helmsman", "output", "loki"]);
const LOGGING_CONTEXT_IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]{0,99}$/u;
const LOGGING_CONTEXT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function validLoggingTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function loggingRouteContext(hash = location.hash) {
  const query = String(hash || "").split("?", 2)[1] || "";
  const params = new URLSearchParams(query);
  const viewCandidate = String(params.get("view") || "overview").toLowerCase();
  const context = {
    view: LOGGING_VIEWS.has(viewCandidate) ? viewCandidate : "overview",
    service: "",
    code: "",
    from: validLoggingTimestamp(params.get("from")),
    to: validLoggingTimestamp(params.get("to")),
    connectorId: "",
    containerId: "",
    node: "",
    workloadId: ""
  };
  for (const [parameter, property] of [
    ["service", "service"],
    ["connector", "connectorId"],
    ["container", "containerId"],
    ["node", "node"],
    ["workload", "workloadId"]
  ]) {
    const candidate = String(params.get(parameter) || "").toLowerCase();
    if (LOGGING_CONTEXT_IDENTIFIER.test(candidate)) context[property] = candidate;
  }
  const code = String(params.get("code") || "").toUpperCase();
  if (LOGGING_CONTEXT_CODE.test(code)) context.code = code;
  return context;
}

function loggingContextHref(values = {}) {
  const params = new URLSearchParams();
  const view = LOGGING_VIEWS.has(values.view) ? values.view : "loki";
  if (view !== "overview") params.set("view", view);
  for (const [parameter, raw] of [
    ["service", values.service],
    ["connector", values.connectorId],
    ["container", values.containerId],
    ["node", values.node],
    ["workload", values.workloadId]
  ]) {
    const candidate = String(raw || "").toLowerCase();
    if (LOGGING_CONTEXT_IDENTIFIER.test(candidate)) params.set(parameter, candidate);
  }
  const code = String(values.code || "").toUpperCase();
  if (LOGGING_CONTEXT_CODE.test(code)) params.set("code", code);
  const from = validLoggingTimestamp(values.from);
  const to = validLoggingTimestamp(values.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  return `#/logs${query ? `?${query}` : ""}`;
}

function lokiConnectorIdForMonitorService(value) {
  const serviceId = String(value || "").toLowerCase();
  if (!serviceId.startsWith("loki-")) return "";
  const connectorId = serviceId.slice("loki-".length);
  return normalizedLokiConfigurations().some(({ id }) => id === connectorId) ? connectorId : "";
}

function canonicalLoggingHash() {
  return loggingContextHref(loggingRouteContext());
}

function currentRoute() {
  const candidate = rawRoute();
  if (state.workspace === "system") {
    return SYSTEM_ROUTES.has(candidate) ? candidate : "system";
  }
  if (state.workspace === "media") {
    const aliased = MEDIA_ROUTE_ALIASES[candidate] || candidate;
    return MEDIA_ROUTES.has(aliased) ? aliased : "overview";
  }
  const aliased = INFRASTRUCTURE_ROUTE_ALIASES[candidate] || candidate;
  return INFRASTRUCTURE_ROUTES.has(aliased) ? aliased : "overview";
}

function workspaceLandingRoute(workspace) {
  return workspace === "system" ? "system" : "overview";
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

async function switchWorkspace(value, requestedRoute = "") {
  const workspace = String(value || "").toLowerCase();
  if (!WORKSPACES.has(workspace)) return;
  const allowedRoutes = workspace === "system"
    ? SYSTEM_ROUTES
    : workspace === "media"
      ? MEDIA_ROUTES
      : INFRASTRUCTURE_ROUTES;
  const requestedDestination = String(requestedRoute || "").toLowerCase();
  if (workspace === state.workspace && !requestedDestination) return;
  closeModal();
  closeMediaDrawer();
  state.workspace = workspace;
  try {
    globalThis.localStorage?.setItem("helmsman.workspace", workspace);
  } catch {
    // A private browser can deny storage; the in-memory workspace still works.
  }
  const candidate = rawRoute();
  const destination = requestedDestination && allowedRoutes.has(requestedDestination)
    ? requestedDestination
    : SHARED_ROUTES.has(candidate)
      ? candidate
      : workspaceLandingRoute(workspace);
  location.hash = destination === "logs" ? canonicalLoggingHash() : `#/${destination}`;
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  if (["system", "infrastructure"].includes(workspace) && state.status?.authenticated) {
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
    headers.set("X-Helmsman-CSRF", state.csrfToken);
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
      : "The Helmsman server could not be reached.");
  }
  let payload = null;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE", "Helmsman returned malformed data.");
    }
  }
  if (!response.ok) {
    const fallbackMessage = response.status >= 500 && response.status <= 599 && payload === null
      ? `The server or gateway returned HTTP ${response.status} without a Helmsman error message.`
      : `Helmsman returned HTTP ${response.status}.`;
    throw new ApiError(
      response.status,
      payload?.code || "HTTP_ERROR",
      payload?.message || fallbackMessage
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

// A compact time for narrow lists: no seconds, and no date when it is today.
function formatShortTime(value, fallback = "Not yet") {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return fallback;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
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
    // Idle qBittorrent shows "firewalled" until a peer connects in; the
    // server marks that healthy, so say why instead of sounding an alarm.
    evidence.push(check.connectionStatus === "firewalled" && check.state === "healthy"
      ? "Firewalled while idle (normal until a peer connects)"
      : `Transfer ${check.connectionStatus}`);
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

function authenticationState(value = state.status?.authentication) {
  const source = value && typeof value === "object" ? value : {};
  return {
    provider: source.provider === "jellyfin" ? "jellyfin" : null,
    configured: source.configured === true,
    ownerName: safeSessionText(source.ownerName, "", 80) || null,
    legacyAccessKeyAvailable: source.legacyAccessKeyAvailable === true
  };
}

function automaticDeviceName() {
  const platform = safeSessionText(navigator.userAgentData?.platform || navigator.platform, "", 40);
  const userAgent = String(navigator.userAgent || "");
  const browser = /Edg\//u.test(userAgent)
    ? "Edge"
    : /Firefox\//u.test(userAgent)
      ? "Firefox"
      : /(?:Chrome|CriOS)\//u.test(userAgent)
        ? "Chrome"
        : /Safari\//u.test(userAgent) ? "Safari" : "";
  const name = browser ? [browser, platform ? `on ${platform}` : ""].filter(Boolean).join(" ") : platform;
  return safeSessionText(name, "Browser", 80);
}

function configuredJellyfinConnection(config = state.config) {
  const services = Array.isArray(config?.services) ? config.services : [];
  return services.some((service) => service?.id === "jellyfin" && service?.configured !== false);
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
        <label for="${cidrsId}"><span>Allowed private CIDRs · one per line</span><textarea id="${cidrsId}" name="allowedCidrs" rows="5" aria-describedby="${cidrsHelpId}" ${manual ? "required" : "disabled"} placeholder="10.44.1.20/32&#10;10.44.1.30/32">${escapeHtml(allowedCidrs.join("\n"))}</textarea><small id="${cidrsHelpId}">CIDR mode permits every safe private address inside these ranges. Prefer exact service addresses unless that broader access is intentional.</small></label>
      </div>
    </fieldset>
    <label class="check-row"><input type="checkbox" name="allowPublicHttps" ${policy.allowPublicHttps ? "checked" : ""}/><span><strong>Allow registered public HTTPS targets</strong><small>Independent of the private-address mode. Only exact HTTPS URLs you save may be reached; public HTTP, redirects, and protected system ranges remain blocked.</small></span></label>`;
}

function renderSetup() {
  return `
    <section class="setup-v5" aria-labelledby="setup-title">
      ${renderGateHeader("First-time setup", "Claim this container", "Define what the broker may reach. Next, connect Jellyfin and enroll the administrator account that will sign in to Helmsman.", "setup-title")}
      <form class="glass-form" id="setup-form" autocomplete="off" data-form-type="other" data-network-mode="exact">
        <div class="form-section">
          <div class="form-section__number">01</div>
          <div class="form-section__body">
            <h3>Container claim</h3>
            <p>Run <code>docker compose logs helmsman</code> and paste the newest one-time setup token.</p>
            <label><span>One-time setup token</span><input name="setupToken" type="password" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" required placeholder="Paste token from container logs" /></label>
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
        <div class="security-note security-note--good">${icon("lock")}<div><strong>Credentials stay out of the browser</strong><span>Service credentials are encrypted in the container data volume. Jellyfin passwords are used only for sign-in or enrollment and are discarded immediately.</span></div></div>
        <p class="form-error" id="setup-error" role="alert"></p>
        <div class="form-actions"><button class="button button--primary" type="submit">Claim and continue</button></div>
      </form>
    </section>`;
}

function renderJellyfinLogin() {
  const ownerCopy = "Sign in with the enrolled Jellyfin administrator account.";
  return `
    <section class="setup-v5 setup-v5--login" aria-labelledby="jellyfin-login-title">
      ${renderGateHeader("Browser access", "Sign in with Jellyfin", ownerCopy, "jellyfin-login-title")}
      <form class="glass-form glass-form--compact glass-form--login" id="jellyfin-login-form" autocomplete="on" data-form-type="login">
        <div class="form-section">
          <div class="form-section__number">01</div>
          <div class="form-section__body">
            <h3>Jellyfin credentials</h3>
            <div class="form-grid form-grid--stacked">
              <label><span>Username</span><input name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="320" required /></label>
              <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
            </div>
          </div>
        </div>
        <div class="security-note security-note--good">${icon("lock")}<div><strong>Your Jellyfin password is never stored by Helmsman</strong><span>It is sent once to the configured Jellyfin server, discarded immediately, and exchanged for a revocable Helmsman browser session.</span></div></div>
        <div class="security-note">${icon("shield")}<div><strong>Protect the Jellyfin connection</strong><span>Use HTTPS for Jellyfin, or use private HTTP only on a network you trust. HTTP does not encrypt this password between Helmsman and Jellyfin.</span></div></div>
        <p class="form-error" id="jellyfin-login-error" role="alert"></p>
        <div class="form-actions"><button class="button button--primary" type="submit">Sign in</button></div>
      </form>
    </section>`;
}

function renderLegacyAccessLogin() {
  return `
    <section class="setup-v5" aria-labelledby="legacy-access-title">
      ${renderGateHeader("Migration access", "Sign in with the legacy key", "Use the existing Helmsman access key once, then enroll a Jellyfin administrator from Settings.", "legacy-access-title")}
      <form class="glass-form glass-form--compact" id="legacy-access-login-form" autocomplete="off" data-form-type="other">
        <div class="form-section">
          <div class="form-section__number">01</div>
          <div class="form-section__body">
            <h3>Legacy access key</h3>
            <label><span>Helmsman access key</span><input name="accessKey" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" data-protonpass-ignore="true" data-form-type="other" required /></label>
          </div>
        </div>
        <div class="security-note">${icon("lock")}<div><strong>Temporary migration path</strong><span>The key is exchanged for a browser session and is never stored in this browser. Enrolling Jellyfin removes legacy key access.</span></div></div>
        <p class="form-error" id="legacy-access-login-error" role="alert"></p>
        <div class="form-actions"><button class="button button--primary" type="submit">Continue migration</button></div>
      </form>
    </section>`;
}

function renderAuthenticationRecovery() {
  return `
    <section class="setup-v5" aria-labelledby="authentication-recovery-title">
      ${renderGateHeader("Browser access", "Jellyfin enrollment required", "This container has been claimed, but a Jellyfin owner has not been enrolled and no legacy migration key is available.", "authentication-recovery-title")}
      <div class="recovery-command"><strong>Use an existing setup session</strong><span>Open Settings in the browser that claimed this container, connect Jellyfin, and enroll the Jellyfin administrator account.</span></div>
      <div class="recovery-command"><strong>No setup session remains?</strong><code>docker compose run --rm --no-deps helmsman reset-access --confirm</code><span>Run this from the deployment host with the main service stopped. Saved connections and monitoring credentials are preserved.</span></div>
    </section>`;
}

function renderStarting() {
  return `<section class="state-page"><span class="state-page__spinner">${icon("refresh")}</span><h2>Starting Helmsman</h2><p>Connecting to the Helmsman server…</p></section>`;
}

function renderFatal() {
  return `<section class="state-page state-page--error">${icon("x")}<h2>Helmsman unavailable</h2><p>${escapeHtml(state.fatalError)}</p><button class="button" type="button" data-action="retry-startup">Try again</button></section>`;
}

function snapshotIsCached() {
  return state.snapshot?.cache?.state === "cached";
}

function renderCachedSnapshotNotice() {
  if (!snapshotIsCached()) return "";
  const observedAt = state.snapshot.cache?.generatedAt || state.snapshot.generatedAt;
  return `<aside class="cached-snapshot-notice" role="status">${icon("refresh")}<span><strong>Cached data</strong><small>Last updated ${escapeHtml(formatTime(observedAt, "before this restart"))}. A live health check is running; controls remain unavailable until it completes.</small></span></aside>`;
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
  let encoded = "";
  for (let index = 0; index < input.length; index += 1) {
    encoded += input.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `m-${encoded}`;
}

function safeMediaFocusKey(value) {
  const candidate = String(value || "");
  return /^m-[a-z0-9]{4,720}$/u.test(candidate) ? candidate : "";
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

function normalizedSeasonRequestTarget(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!raw || safeCapabilityId(raw.service) !== "seerr") return null;
  const mediaId = raw.mediaId ?? raw.resourceId;
  if (!Number.isSafeInteger(mediaId) || mediaId < 1 || mediaId > 9_999_999_999) return null;
  return { service: "seerr", mediaId };
}

function normalizedQueueActionTarget(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const service = safeCapabilityId(raw?.service);
  const queueId = raw?.queueId;
  if (!raw
    || !["radarr", "sonarr"].includes(service)
    || !Number.isSafeInteger(queueId)
    || queueId < 1
    || queueId > 2_147_483_647) return null;
  return { service, queueId };
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
    seasonRequestTarget: normalizedSeasonRequestTarget(raw.seasonRequestTarget),
    queueActionTarget: normalizedQueueActionTarget(raw.queueActionTarget),
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
          seasonRequestTarget: entry.seasonRequestTarget || base.seasonRequestTarget,
          title,
          lifecycle: { ...(entry.lifecycle || {}) }
        };
      } else {
        candidate = { ...base, ...entry, title, lifecycle: { ...base.lifecycle, ...entry.lifecycle } };
      }
    }
    if (!candidate || typeof candidate !== "object") return [];
    const item = normalizeMediaItem(candidate, `${collectionName}:${index}`);
    if (seen.has(item.id)) return [];
    seen.add(item.id);
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
  const allIndex = new Map();
  [records, library, discover, requests, activity, calendar, subtitleBacklog, ...Object.values(home)].forEach((entries) => {
    entries.forEach((item) => {
      if (allSeen.has(item.id)) {
        const index = allIndex.get(item.id);
        const retained = all[index];
        // Continue Watching episodes resolve to the same canonical ID as their
        // record. Keep the canonical drawer data, but do not discard the
        // parent-series request capability carried by the narrower home row.
        if (retained && !retained.seasonRequestTarget && item.seasonRequestTarget) {
          all[index] = { ...retained, seasonRequestTarget: item.seasonRequestTarget };
        }
        return;
      }
      allSeen.add(item.id);
      allIndex.set(item.id, all.length);
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
    seasonRequestTarget: item.seasonRequestTarget,
    queueActionTarget: item.queueActionTarget,
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
  const detail = item.error
    || item.subtitle
    || (item.service ? `${mediaStatusLabel(item)} via ${item.service}` : mediaTypeLabel(item.mediaType));
  return `<button class="pipeline-row media-overview-download" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}">
    ${renderMediaArt(item, "pipeline-art")}<span class="pipeline-main"><span class="pipeline-title"><strong>${escapeHtml(item.title)}</strong><em class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</em></span><span class="pipeline-subtitle">${escapeHtml(detail)}</span>${item.progress === null ? "" : `<span class="media-overview-download__progress"><progress data-media-progress value="${item.progress}" max="100">${item.progress}%</progress><small data-media-progress-label>${item.progress}%</small></span>`}</span><span class="pipeline-aside"><strong data-media-speed>${escapeHtml(formatMediaSpeed(item.downloadSpeedBps))}</strong><small data-media-eta>${escapeHtml(formatMediaEta(item.etaSeconds))}</small></span>${icon("chevron")}
  </button>`;
}

function mediaHomeHealthTone(value) {
  const stateValue = statusClass(value);
  if (stateValue === "healthy") return "success";
  if (["limited", "degraded"].includes(stateValue)) return "warning";
  if (["down", "auth-required", "authentication-required"].includes(stateValue)) return "danger";
  if (stateValue === "checking") return "info";
  return "neutral";
}

function mediaHomeHealthIcon(value) {
  const stateValue = statusClass(value);
  if (stateValue === "healthy") return "check";
  if (["limited", "degraded"].includes(stateValue)) return "more";
  if (stateValue === "down") return "x";
  if (["auth-required", "authentication-required"].includes(stateValue)) return "lock";
  if (stateValue === "disabled") return "pause";
  return "refresh";
}

function mediaHomeConnectionPresentation(value) {
  return {
    connected: { label: "Connected", tone: "success" },
    auth_required: { label: "Authentication required", tone: "danger" },
    down: { label: "Unavailable", tone: "danger" },
    unverified: { label: "Unverified", tone: "neutral" }
  }[String(value || "unverified")] || { label: "Unverified", tone: "neutral" };
}

function mediaHomeServiceSummary(service) {
  if (service.message) return service.message;
  if (!service.capabilities.length) return service.state === "disabled" ? "Monitoring disabled" : "No capability results yet";
  if (!service.failedCapabilities.length) return `${service.healthyCapabilityCount} of ${service.capabilities.length} capabilities healthy`;
  const first = service.failedCapabilities[0];
  return `${first.name}${service.failedCapabilities.length > 1 ? ` and ${service.failedCapabilities.length - 1} more` : ""} ${first.state === "stale" ? "is stale" : "needs attention"}`;
}

function renderMediaHomeServiceState(service, heading, presentation) {
  return `<span class="operations-service__health" aria-label="${escapeHtml(service.name)} ${escapeHtml(heading.toLowerCase())}: ${escapeHtml(presentation.label)}"><span class="operations-service__state"><i class="is-${escapeHtml(presentation.tone)}" aria-hidden="true"></i>${escapeHtml(presentation.label)}</span></span>`;
}

function renderMediaHomeService(service) {
  const connection = mediaHomeConnectionPresentation(service.connectionState);
  const serviceHealth = {
    label: statusLabel(service.state),
    tone: mediaHomeHealthTone(service.state)
  };
  const states = `<span class="operations-service__states">${renderMediaHomeServiceState(service, "Connection health", connection)}${renderMediaHomeServiceState(service, "Service health", serviceHealth)}</span>`;
  const content = `<span class="operations-service__mark">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span><span class="operations-service__copy"><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(mediaHomeServiceSummary(service))}</small></span>${states}${SERVICE_ORDER.includes(service.id) ? icon("chevron") : ""}`;
  const actionLabel = `Open ${service.name} connection details. Connection health: ${connection.label}. Service health: ${serviceHealth.label}.`;
  return SERVICE_ORDER.includes(service.id)
    ? `<li><button class="operations-service" type="button" data-action="open-service" data-service-id="${escapeHtml(service.id)}" aria-label="${escapeHtml(actionLabel)}">${content}</button></li>`
    : `<li><article class="operations-service">${content}</article></li>`;
}

function renderMediaHomeServiceHealth(operations) {
  return `<section class="operations-panel operations-services media-home-card media-home-card--services" aria-labelledby="media-home-services-title" data-home-slot="service-health">
    <header class="operations-section-heading media-home-card__heading"><div><h2 id="media-home-services-title">Service health</h2></div><a class="media-overview-card-link" href="#/health" aria-label="Open service health">${icon("more")}</a></header>
    <div class="media-overview-service-columns" aria-hidden="true"><span>Service</span><span>Connection</span><span>Service health</span></div>
    ${operations.services.length ? `<ul class="operations-services__list">${operations.services.map(renderMediaHomeService).join("")}</ul>` : renderMediaEmpty("No monitored services", "Add a media connection to begin collecting health signals.", "shield")}
  </section>`;
}

function mediaOverviewLifecycle(media) {
  const monitored = media.metrics.monitoredTotal
    ?? media.records.filter((item) => item.monitored).length;
  const imported = media.records.filter((item) => item.imported).length;
  const requested = media.requests.length || media.metrics.pendingRequestTotal;
  return [
    { id: "requested", label: "Requested", detail: "Known requests in Seerr", count: requested, icon: "inbox" },
    { id: "monitored", label: "Monitored", detail: "Tracked by Sonarr or Radarr", count: monitored, icon: "search" },
    { id: "downloading", label: "Downloading", detail: "Active qBittorrent transfers", count: media.metrics.activeDownloadTotal, icon: "download" },
    { id: "imported", label: "Imported", detail: "Imported records in view", count: imported, icon: "settings" },
    { id: "available", label: "Available", detail: "Titles in your Jellyfin library", count: media.metrics.libraryTotal, icon: "check" }
  ];
}

function renderMediaHomePipeline(media) {
  const stages = mediaOverviewLifecycle(media);
  return `<section class="operations-panel operations-pipeline media-home-card media-home-card--pipeline" aria-labelledby="media-home-pipeline-title" data-home-slot="media-pipeline">
    <header class="operations-section-heading media-home-card__heading"><div><h2 id="media-home-pipeline-title">Media pipeline</h2></div><a class="media-overview-card-link" href="#/activity" aria-label="Open media activity">${icon("chevron")}</a></header>
    <ol class="operations-pipeline__list">${stages.map((stage) => `<li class="operations-pipeline__stage ${stage.count > 0 ? "is-healthy" : "is-stale"}" data-overview-lifecycle-id="${stage.id}"><span class="operations-pipeline__marker">${icon(stage.icon)}</span><div><strong>${escapeHtml(stage.label)}</strong><small>${escapeHtml(stage.detail)}</small></div><em aria-label="${stage.count} items">${stage.count.toLocaleString()}</em></li>`).join("")}</ol>
  </section>`;
}

function renderMediaHomeDownloads(downloads, { promoted = false } = {}) {
  return `<section class="pipeline-panel media-home-card media-home-card--downloads${promoted ? " is-promoted" : ""}" data-home-slot="downloads"${promoted ? " data-home-promoted=\"true\"" : ""}><header class="panel-heading media-home-card__heading"><div><h2>Downloads &amp; imports</h2></div><a class="media-overview-card-link" href="#/activity" aria-label="Open all activity">${icon("chevron")}</a></header><div class="pipeline-list">${downloads.length ? downloads.map(renderHomeActivityRow).join("") : renderMediaEmpty("No active transfers", "Downloads and blocked imports will appear here.", "download")}</div></section>`;
}

function mediaOverviewEpisodeLabel(feature) {
  const parts = [];
  if (feature.seasonNumber !== null && feature.episodeNumber !== null) {
    parts.push(`S${feature.seasonNumber} E${feature.episodeNumber}`);
  }
  if (feature.subtitle && feature.subtitle !== feature.title) parts.push(feature.subtitle);
  if (!parts.length) parts.push([mediaTypeLabel(feature.mediaType), feature.year].filter(Boolean).join(" · "));
  return parts.filter(Boolean).join(" · ");
}

function renderMediaHomeContinueWatching(feature) {
  return `<section class="cinema-hero media-home-card media-home-card--continue" data-home-slot="continue-watching" data-media-key="${feature.key}">
    <header class="media-home-card__heading"><div><h2>Continue watching</h2></div><a class="media-overview-card-link" href="#/library" aria-label="Open media library">${icon("chevron")}</a></header>
    <div class="media-overview-resume">${renderArtworkImage(feature, { className: "hero-art-image", eager: true })}<div class="hero-shade"></div>
      <div class="hero-content"><h3>${escapeHtml(feature.title)}</h3><p>${escapeHtml(mediaOverviewEpisodeLabel(feature))}</p>${feature.progress === null ? "" : `<div class="hero-progress"><progress data-media-progress value="${feature.progress}" max="100" aria-label="${escapeHtml(`${feature.title} watched`)}">${feature.progress}%</progress><span data-media-progress-label data-media-progress-suffix=" watched">${feature.progress}% watched</span></div>`}<div class="hero-actions"><button class="primary-button" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(feature.id)}" data-media-key="${feature.key}">${icon("eye")} View details</button></div></div>
    </div>
  </section>`;
}

function mediaOverviewEventTime(item) {
  return item.requestedAt || item.addedAt || item.releaseAt || "";
}

function mediaOverviewAttention(media, operations) {
  const entries = [];
  const seen = new Set();
  const addMedia = (item, kind, detail, tone, iconName) => {
    const id = `${kind}:${item.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ id, kind, detail, tone, iconName, at: mediaOverviewEventTime(item), item });
  };
  media.home.pendingRequests.forEach((item) => addMedia(item, "New request", item.title, "info", "inbox"));
  media.home.blockedImports.forEach((item) => addMedia(item, "Import failed", `${item.title}${item.error ? ` · ${item.error}` : ""}`, "danger", "x"));
  media.activity.forEach((item) => {
    const activityState = normalizedMediaToken(item.state);
    if (item.error) addMedia(item, "Import failed", `${item.title} · ${item.error}`, "danger", "x");
    else if (activityState === "imported") addMedia(item, "Import completed", item.title, "success", "check");
    else if (activityState === "completed") addMedia(item, "Download completed", item.title, "success", "check");
  });
  operations.incidents.filter(({ scope }) => scope !== "infrastructure").forEach((incident) => {
    entries.push({
      id: `incident:${incident.id}`,
      incidentId: incident.id,
      kind: incident.state === "down" ? "Service unavailable" : "Service warning",
      detail: `${incident.serviceName} · ${incident.summary}`,
      tone: incident.state === "down" ? "danger" : "warning",
      iconName: incident.state === "down" ? "x" : "more",
      at: incident.lastSeen || incident.firstSeen || "",
      href: "#/health"
    });
  });
  return entries
    .map((entry, index) => ({ ...entry, index, stamp: Number.isFinite(Date.parse(entry.at)) ? Date.parse(entry.at) : 0 }))
    .sort((left, right) => right.stamp - left.stamp || left.index - right.index)
    .slice(0, 6);
}

function renderMediaOverviewEvent(entry) {
  const timestamp = entry.stamp > 0 ? new Date(entry.stamp).toISOString() : "";
  const content = `<span class="media-overview-event__mark is-${escapeHtml(entry.tone)}">${icon(entry.iconName)}</span><span class="media-overview-event__copy"><strong>${escapeHtml(entry.kind)}</strong><small>${escapeHtml(entry.detail)}</small></span><time${timestamp ? ` datetime="${timestamp}"` : ""} data-overview-event-time title="${escapeHtml(formatTime(entry.at, ""))}">${escapeHtml(formatShortTime(entry.at, "Current"))}</time>`;
  if (entry.item) {
    return `<li><button class="media-overview-event" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(entry.item.id)}" data-media-key="${entry.item.key}">${content}</button></li>`;
  }
  return `<li><a class="media-overview-event" href="${entry.href}" data-overview-incident-id="${escapeHtml(entry.incidentId)}">${content}</a></li>`;
}

function renderMediaOverviewShelf(items, {
  title,
  titleId,
  slot,
  emptyTitle = "Nothing here yet",
  emptyCopy = "Media will appear here after the next refresh."
}) {
  return `<section class="media-home-card media-overview-recent" data-home-slot="${escapeHtml(slot)}" aria-labelledby="${escapeHtml(titleId)}"><header class="media-home-card__heading"><div><h2 id="${escapeHtml(titleId)}">${escapeHtml(title)}</h2></div><a class="media-overview-card-link" href="#/library" aria-label="Open media library">${icon("chevron")}</a></header>${items.length ? `<div class="media-overview-recent__rail">${items.slice(0, 12).map((item, index) => `<button class="media-overview-poster" type="button" data-action="open-media-detail" data-media-id="${escapeHtml(item.id)}" data-media-key="${item.key}" aria-label="Open ${escapeHtml(item.title)} details"><span class="media-overview-poster__art">${renderArtworkImage(item, { eager: index < 6 })}<span class="poster-monogram" aria-hidden="true">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span><span class="media-overview-poster__shade"></span><span class="media-overview-poster__copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml([item.year, mediaTypeLabel(item.mediaType)].filter(Boolean).join(" · "))}</small></span></span></button>`).join("")}</div>` : renderMediaEmpty(emptyTitle, emptyCopy, "library")}</section>`;
}

function renderMediaHome() {
  const media = mediaSnapshotForUi();
  const continueWatching = media.home.continueWatching;
  const hasContinueWatching = continueWatching.length > 0;
  const feature = hasContinueWatching ? continueWatching[0] : null;
  const downloads = [...new Map([...media.home.blockedImports, ...media.home.activeDownloads].map((item) => [item.key, item])).values()].slice(0, 8);
  const operations = normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []);
  const attention = mediaOverviewAttention(media, operations);
  const downloadsCard = renderMediaHomeDownloads(downloads, { promoted: !hasContinueWatching });
  return `<div class="page media-desktop-page media-home-page operations-page">
    <div class="media-home-bento ${hasContinueWatching ? "has-continue-watching" : "has-promoted-downloads"}">
      ${hasContinueWatching ? renderMediaHomeContinueWatching(feature) : downloadsCard}
      ${renderMediaHomeServiceHealth(operations)}
      ${hasContinueWatching ? downloadsCard : ""}
      <section class="activity-panel media-home-card media-home-card--attention" data-home-slot="requests-and-warnings"><header class="panel-heading media-home-card__heading"><div><h2>Requests &amp; warnings</h2></div><a class="media-overview-card-link" href="#/requests" aria-label="Open all requests">${icon("chevron")}</a></header>${attention.length ? `<ul class="media-overview-events">${attention.map(renderMediaOverviewEvent).join("")}</ul>` : renderMediaEmpty("All clear", "New requests and service warnings will appear here.", "check")}</section>
      ${renderMediaHomePipeline(media)}
    </div>
    ${renderMediaOverviewShelf(media.home.recentlyAdded, { title: "Recently added", titleId: "media-overview-recent-title", slot: "recently-added", emptyTitle: "Nothing new yet", emptyCopy: "Recently added Jellyfin titles will appear here." })}
    ${continueWatching.length > 1 ? renderMediaOverviewShelf(continueWatching.slice(1), { title: "More to continue", titleId: "media-overview-more-title", slot: "continue-queue" }) : ""}
  </div>`;
}

function systemOverviewRouteButton(workspace, route, label) {
  return `<button class="system-overview-link" type="button" data-action="switch-workspace" data-workspace="${escapeHtml(workspace)}" data-workspace-route="${escapeHtml(route)}">${escapeHtml(label)} ${icon("chevron")}</button>`;
}

function renderSystemHealthGauge(score, overall, healthy, total) {
  const segmentCount = 28;
  const activeSegments = Math.round((score / 100) * segmentCount);
  const segments = Array.from({ length: segmentCount }, (_, index) => (
    `<i class="${index < activeSegments ? "is-active" : ""}" aria-hidden="true"></i>`
  )).join("");
  return `<div class="system-health-gauge is-${escapeHtml(statusClass(overall))}" role="img" aria-label="${score}% system health, ${healthy} of ${total} monitored services healthy">
    <div class="system-health-gauge__segments">${segments}</div>
    <div class="system-health-gauge__value"><strong>${score}%</strong><span>${healthy} of ${total} healthy</span></div>
  </div>`;
}

const REPORT_ID_PATTERN = /^[a-f0-9]{32}$/u;

// Every warning or error the monitor is currently reporting, across media
// services, Proxmox environments, and Portainer/Loki connections.
function currentWarningReports() {
  const snapshot = snapshotForUi();
  const groups = [
    ...(Array.isArray(snapshot.services) ? snapshot.services : []).map((service) => ({
      name: service?.label || service?.id,
      checks: service?.checks
    })),
    ...(Array.isArray(snapshot.infrastructure?.environments) ? snapshot.infrastructure.environments : [])
      .map((target) => ({ name: target?.displayName, checks: target?.capabilities })),
    ...(Array.isArray(snapshot.infrastructure?.services) ? snapshot.infrastructure.services : [])
      .map((service) => ({ name: service?.displayName, checks: service?.capabilities }))
  ];
  const seen = new Set();
  const warnings = [];
  for (const group of groups) {
    const name = safeSessionText(group.name, "Service", 80);
    for (const check of Array.isArray(group.checks) ? group.checks : []) {
      for (const report of normalizeOperationsReports(check?.reports, `${name} health`)) {
        if (report.severity === "notice" || !report.id || seen.has(report.id)) continue;
        seen.add(report.id);
        warnings.push({ ...report, name });
      }
    }
  }
  return warnings.slice(0, 24);
}

function acknowledgedWarnings() {
  const entries = Array.isArray(snapshotForUi().acknowledgements) ? snapshotForUi().acknowledgements : [];
  return entries.flatMap((entry) => {
    const id = typeof entry?.id === "string" && REPORT_ID_PATTERN.test(entry.id) ? entry.id : null;
    const message = safeSessionText(entry?.message, "", 600);
    if (!id || !message) return [];
    const acknowledgedAt = Date.parse(entry.acknowledgedAt);
    return [{
      id,
      message,
      name: safeSessionText(entry.label, "", 80) || safeSessionText(entry.monitor, "Service", 80),
      source: safeSessionText(entry.source, "", 96),
      acknowledgedAt: Number.isFinite(acknowledgedAt) ? new Date(acknowledgedAt) : null
    }];
  }).slice(0, 200);
}

function renderSystemWarningsCard() {
  const warnings = currentWarningReports();
  const ignored = acknowledgedWarnings();
  if (!warnings.length && !ignored.length) return "";
  return `<section class="system-overview-card system-overview-card--warnings" aria-labelledby="system-warnings-title">
    <header><div><span class="section-kicker">Needs attention</span><h3 id="system-warnings-title">Warnings</h3></div></header>
    ${warnings.length
      ? `<ul class="system-warning-list">${warnings.map((warning) => `<li class="system-warning is-${escapeHtml(warning.severity)}">
          <i class="health-dot is-${warning.severity === "error" ? "degraded" : "limited"}" aria-hidden="true"></i>
          <div><strong>${escapeHtml(warning.name)}</strong><p>${escapeHtml(warning.message)}</p><small>${escapeHtml(warning.source)}</small></div>
          ${renderReportIgnoreButton(warning)}
        </li>`).join("")}</ul>`
      : `<p class="system-warnings-empty">No active warnings. Ignored warnings stay listed below until they clear.</p>`}
    ${ignored.length
      ? `<details class="system-ignored-warnings">
          <summary>Ignored warnings <span>${ignored.length}</span></summary>
          <p>These no longer affect system health. Each is restored automatically once it has been gone for 24 hours.</p>
          <ul>${ignored.map((entry) => `<li>
            <div><strong>${escapeHtml(entry.name)}</strong><p>${escapeHtml(entry.message)}</p><small>${escapeHtml(entry.source)}${entry.acknowledgedAt ? ` · ignored ${escapeHtml(entry.acknowledgedAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}` : ""}</small></div>
            <button class="operations-report__ignore is-restore" type="button" data-action="restore-acknowledgement" data-report-id="${escapeHtml(entry.id)}">Restore</button>
          </li>`).join("")}</ul>
        </details>`
      : ""}
  </section>`;
}

async function setReportAcknowledged(target, acknowledge) {
  const reportId = String(target?.dataset?.reportId || "");
  if (!REPORT_ID_PATTERN.test(reportId) || target.disabled) return;
  target.disabled = true;
  target.setAttribute("aria-busy", "true");
  try {
    const snapshot = acknowledge
      ? await api("/api/v2/acknowledgements", { method: "POST", body: { reportId } })
      : await api(`/api/v2/acknowledgements/${reportId}`, { method: "DELETE" });
    // Supersede any snapshot request that started before this change.
    state.operationsRequestGeneration += 1;
    state.snapshot = snapshot;
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    updateVolatileOperationsUi();
    showToast(acknowledge
      ? "Warning ignored. It no longer affects system health."
      : "Warning restored. It counts toward system health again.", "success");
  } catch (error) {
    if (error?.status === 401) await initialize();
    else showToast(error?.message || "That change could not be saved.", "danger");
    target.disabled = false;
    target.removeAttribute("aria-busy");
  }
}

function renderSystemOverview() {
  const media = mediaSnapshotForUi();
  const operations = normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []);
  const infrastructure = configuredInfrastructureSnapshotForUi();
  const portainers = configuredPortainerServicesForUi();
  const mediaServices = operations.services.filter(({ state: serviceState }) => statusClass(serviceState) !== "disabled");
  const infrastructureEntries = [
    ...infrastructure.targets
      .filter((target) => target.enabled !== false && target.monitoringEnabled !== false)
      .map((target) => ({
        id: target.id,
        provider: "proxmox",
        name: target.displayName,
        detail: target.environmentKind === "cluster" ? target.clusterName || "Proxmox cluster" : target.environmentName || "Proxmox environment",
        state: statusClass(target.state),
        connectionState: target.connectionState
      })),
    ...portainers
      .filter((service) => service.enabled !== false && service.monitoringEnabled !== false)
      .map((service) => ({
        id: service.id,
        provider: "portainer",
        name: service.displayName,
        detail: service.inventory?.environments?.length
          ? `${service.inventory.environments.length} environment${service.inventory.environments.length === 1 ? "" : "s"}`
          : "Portainer server",
        state: statusClass(service.state),
        connectionState: service.connectionState
      }))
  ];
  const monitored = [
    ...mediaServices.map((service) => ({ state: statusClass(service.state) })),
    ...infrastructureEntries
  ];
  const healthy = monitored.filter(({ state: itemState }) => itemState === "healthy").length;
  const score = monitored.length ? Math.round((healthy / monitored.length) * 100) : 0;
  const infrastructureState = combinedInfrastructureState(infrastructure, portainers);
  const overall = [statusClass(operations.overall.state), statusClass(infrastructureState)]
    .sort((left, right) => (WORKSPACE_STATE_PRIORITY[left] ?? 99) - (WORKSPACE_STATE_PRIORITY[right] ?? 99))[0] || "disabled";
  const mediaConnected = mediaServices.filter(({ connectionState }) => connectionState === "connected").length;
  const infrastructureConnected = infrastructureEntries.filter(({ connectionState }) => connectionState === "connected").length;
  const activeIncidents = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets).incidents.length;
  const pipeline = mediaOverviewLifecycle(media);
  const systemCopy = monitored.length
    ? overall === "healthy" ? "Every monitored media and infrastructure service is healthy." : "One or more monitored services needs attention."
    : "Connect media or infrastructure services to begin monitoring system health.";
  return `<div class="page system-overview-page">
    <section class="system-overview-hero">
      <div><span class="section-kicker">All systems</span><h2>System overview</h2><p>Media and infrastructure health in one live, read-only view.</p></div>
      <span class="operations-status-badge is-${escapeHtml(statusClass(overall))}"><i aria-hidden="true"></i>${escapeHtml(statusLabel(overall))}</span>
    </section>
    <div class="system-overview-grid">
      <section class="system-overview-card system-overview-card--health" aria-labelledby="system-health-title">
        <header><div><span class="section-kicker">Live assessment</span><h3 id="system-health-title">System health</h3></div></header>
        ${renderSystemHealthGauge(score, overall, healthy, monitored.length)}
        <p class="system-health-copy">${escapeHtml(systemCopy)}</p>
        <dl class="system-health-facts">
          <div><dt>Media connections</dt><dd>${mediaConnected}/${mediaServices.length}</dd></div>
          <div><dt>Infrastructure connections</dt><dd>${infrastructureConnected}/${infrastructureEntries.length}</dd></div>
          <div><dt>Active incidents</dt><dd>${activeIncidents}</dd></div>
        </dl>
      </section>
      <section class="system-overview-card system-overview-card--media" aria-labelledby="system-media-title">
        <header><div><span class="section-kicker">Media operations</span><h3 id="system-media-title">Service health</h3></div>${systemOverviewRouteButton("media", "health", "Open media")}</header>
        ${mediaServices.length ? `<ul class="system-service-list">${mediaServices.slice(0, 7).map((service) => `<li><button class="system-service-row" type="button" data-action="open-overview-service" data-overview-kind="media" data-overview-id="${escapeHtml(service.id)}" aria-label="${escapeHtml(`Open ${service.name} in Media health: ${statusLabel(service.state)}`)}"><span class="system-service-icon">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span><span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(mediaHomeServiceSummary(service))}</small></span><span class="system-service-state is-${escapeHtml(statusClass(service.state))}"><i class="health-dot is-${escapeHtml(statusClass(service.state))}"></i>${escapeHtml(statusLabel(service.state))}</span></button></li>`).join("")}</ul>` : renderMediaEmpty("No monitored media services", "Add a media connection to begin collecting health signals.", "shield")}
      </section>
      <section class="system-overview-card system-overview-card--infrastructure" aria-labelledby="system-infrastructure-title">
        <header><div><span class="section-kicker">Infrastructure operations</span><h3 id="system-infrastructure-title">Connections</h3></div>${systemOverviewRouteButton("infrastructure", "overview", "Open infrastructure")}</header>
        ${infrastructureEntries.length ? `<ul class="system-service-list">${infrastructureEntries.slice(0, 7).map((entry) => `<li><button class="system-service-row" type="button" data-action="open-overview-service" data-overview-kind="${escapeHtml(entry.provider)}" data-overview-id="${escapeHtml(entry.id)}" aria-label="${escapeHtml(`Open ${entry.name}: ${statusLabel(entry.state)}`)}"><span class="system-service-icon">${serviceIconMarkup(entry.provider, entry.name.slice(0, 1))}</span><span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.detail)}</small></span><span class="system-service-state is-${escapeHtml(entry.state)}"><i class="health-dot is-${escapeHtml(entry.state)}"></i>${escapeHtml(statusLabel(entry.state))}</span></button></li>`).join("")}</ul>` : renderMediaEmpty("No infrastructure connections", "Connect Proxmox or Portainer to add infrastructure health.", "server")}
      </section>
      <section class="system-overview-card system-overview-card--pipeline" aria-labelledby="system-pipeline-title">
        <header><div><span class="section-kicker">End-to-end signal</span><h3 id="system-pipeline-title">Media pipeline</h3></div>${systemOverviewRouteButton("media", "activity", "Open activity")}</header>
        <ol class="system-pipeline-list">${pipeline.map((stage) => `<li><span class="system-pipeline-marker">${icon(stage.icon)}</span><span><strong>${escapeHtml(stage.label)}</strong><small>${escapeHtml(stage.detail)}</small></span><em>${stage.count.toLocaleString()}</em></li>`).join("")}</ol>
      </section>
    </div>
    ${renderAgentOverviewCard()}
    ${renderSystemWarningsCard()}
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
  const finalVisibleDay = localDateKey(days.at(-1));
  const later = [];
  media.calendar.forEach((item) => {
    const key = localDateKey(item.releaseAt);
    if (grouped.has(key)) grouped.get(key).push(item);
    else if (key && key > finalVisibleDay) later.push(item);
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
  // The indexer panel goes inside the page so it shares the page's padding
  // and lines up with the cards above it at every width.
  return renderOperationsOverview(mediaOnlyOperationsSnapshot(), [], renderProwlarrPanel());
}

function mediaRecordById(id) {
  const media = mediaSnapshotForUi();
  return media.all.find((item) => item.id === id) || null;
}

function configuredMediaConnection(serviceId) {
  if (snapshotIsCached()) return null;
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
  const queueTarget = item.queueActionTarget;
  const queueState = String(item.state || "").toLowerCase();
  if (queueTarget
    && (item.error || /(?:blocked|failed|error)/u.test(queueState))
    && configuredMediaConnection(queueTarget.service)?.targetRevision) {
    return [{
      serviceId: queueTarget.service,
      operation: "blocklistAndSearch",
      queueId: String(queueTarget.queueId),
      label: "Block release & search again",
      copy: `Remove this failed download, blocklist the release, and let ${queueTarget.service === "radarr" ? "Radarr" : "Sonarr"} seek a replacement.`,
      tone: "danger"
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
    const targetId = action.queueId || action.resourceId;
    const key = `media:${action.serviceId}:${action.operation}:${targetId}`;
    const busy = state.actionMutation === key;
    const awaitingRefresh = state.actionAwaitingRefresh === key;
    const targetAttribute = action.queueId
      ? `data-control-queue-id="${escapeHtml(action.queueId)}"`
      : `data-control-resource-id="${escapeHtml(action.resourceId)}"`;
    return `<div class="control-action-row"><span><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(action.copy)}</small></span><button class="button ${action.tone === "danger" ? "button--danger" : "button--primary"}" type="button" data-action="run-media-control" data-media-id="${escapeHtml(item.id)}" data-control-service="${escapeHtml(action.serviceId)}" data-control-operation="${escapeHtml(action.operation)}" ${targetAttribute} data-control-key="${escapeHtml(key)}" ${state.actionMutation ? "disabled" : ""} ${busy && !awaitingRefresh ? "aria-busy=\"true\"" : ""}>${awaitingRefresh ? `${icon("refresh")} Refresh required` : busy ? `${icon("refresh")} Working…` : escapeHtml(action.label)}</button></div>`;
  }).join("")}</div></section>`;
}

const SEASON_AVAILABILITY_STATES = new Set([
  "not_requested", "pending", "processing", "partially_available", "available", "blocklisted", "deleted", "unknown"
]);
const SEASON_REQUEST_STATES = new Set(["pending", "approved", "declined", "failed", "completed", "unknown"]);

function normalizedSeasonState(value, allowed) {
  const token = normalizedMediaToken(value);
  return allowed.has(token) ? token : "unknown";
}

function normalizedSeasonAirDate(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return "";
  const date = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(candidate) ? candidate : "";
}

function normalizeSeasonDetail(value, expectedTarget, expectedRevision) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const tmdbId = mediaNumber(raw?.tmdbId, 1, 9_999_999_999);
  const targetRevision = mediaText(raw?.targetRevision, "", 80).toLowerCase();
  const detailRevision = mediaText(raw?.detailRevision, "", 80).toLowerCase();
  const tvdbMappingPresent = raw?.tvdbMappingPresent !== false;
  if (!raw
    || !Number.isSafeInteger(tmdbId)
    || tmdbId !== expectedTarget.mediaId
    || targetRevision !== expectedRevision
    || !SEASON_DETAIL_REVISION_PATTERN.test(detailRevision)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Helmsman received invalid season details from the container.");
  }
  const seasons = [];
  const seen = new Set();
  for (const entry of (Array.isArray(raw.seasons) ? raw.seasons : []).slice(0, MAX_SEASON_CATALOG_SIZE)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const seasonNumber = mediaNumber(entry.seasonNumber, 0, 10_000);
    if (!Number.isSafeInteger(seasonNumber) || seen.has(seasonNumber)) continue;
    seen.add(seasonNumber);
    const episodeCount = mediaNumber(entry.episodeCount, 0, 100_000);
    seasons.push({
      seasonNumber,
      name: mediaText(entry.name, seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`, 100),
      episodeCount: Number.isSafeInteger(episodeCount) ? episodeCount : null,
      airDate: normalizedSeasonAirDate(entry.airDate),
      status: normalizedSeasonState(entry.status, SEASON_AVAILABILITY_STATES),
      requestState: normalizedSeasonState(entry.requestState, SEASON_REQUEST_STATES),
      requestable: seasonNumber > 0 && entry.requestable === true
    });
  }
  seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
  return { tmdbId, targetRevision, detailRevision, tvdbMappingPresent, seasons };
}

function seasonRequestContext(item) {
  const target = item?.seasonRequestTarget;
  if (!target || target.service !== "seerr" || !Number.isSafeInteger(target.mediaId)) return null;
  const connection = configuredMediaConnection("seerr");
  const targetRevision = mediaText(connection?.targetRevision, "", 80).toLowerCase();
  return {
    target,
    connection,
    targetRevision,
    key: targetRevision ? `${target.mediaId}:${targetRevision}` : ""
  };
}

function storeSeasonDetail(key, value) {
  state.media.seasonDetails.delete(key);
  state.media.seasonDetails.set(key, value);
  while (state.media.seasonDetails.size > 128) {
    state.media.seasonDetails.delete(state.media.seasonDetails.keys().next().value);
  }
}

function formatSeasonAirDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "Air date pending";
}

function seasonStatusLabel(season) {
  if (season.seasonNumber === 0) return "Specials · view only";
  if (season.requestState === "pending") return "Awaiting approval";
  if (season.requestState === "approved" && season.status !== "available") return "Requested";
  if (season.requestState === "failed") return "Request failed";
  if (season.requestState === "declined") return "Declined";
  return {
    available: "Available",
    partially_available: season.requestable ? "Partial · request remaining" : "Partially available",
    processing: "Acquiring",
    pending: "Pending",
    blocklisted: "Blocklisted",
    deleted: "Removed",
    not_requested: "Not requested",
    unknown: season.requestable ? "Available to request" : "Status unavailable"
  }[season.status] || "Status unavailable";
}

function seasonStatusTone(season) {
  if (season.seasonNumber === 0) return "neutral";
  if (season.requestState === "failed" || season.status === "blocklisted") return "danger";
  if (season.requestState === "pending") return "pending";
  if (season.status === "available") return "available";
  if (["processing", "partially_available"].includes(season.status) || season.requestState === "approved") return "active";
  return season.requestable ? "requestable" : "neutral";
}

function renderSeasonPanelState(title, copy, { retry = false, mediaId = "", busy = false } = {}) {
  return `<div class="drawer-season-state" role="status"><span class="drawer-season-state__icon">${icon(busy ? "refresh" : "library")}</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(copy)}</small></span>${retry ? `<button class="button" type="button" data-action="retry-season-details" data-media-id="${escapeHtml(mediaId)}">Try again</button>` : ""}</div>`;
}

function renderMediaSeasonPanelContent(item) {
  const context = seasonRequestContext(item);
  if (!context?.connection || !context.targetRevision) {
    return renderSeasonPanelState(
      "Season requests unavailable",
      "Helmsman needs a current Seerr connection before it can load or request seasons.",
      { retry: true, mediaId: item.id }
    );
  }
  const detail = state.media.seasonDetails.get(context.key);
  if (!detail || detail.state === "loading") {
    return renderSeasonPanelState("Loading seasons", "Checking the current Seerr season catalog…", { busy: true });
  }
  if (detail.state === "error") {
    return renderSeasonPanelState(
      "Seasons could not be loaded",
      mediaText(detail.message, "The season catalog is temporarily unavailable.", 220),
      { retry: true, mediaId: item.id }
    );
  }
  if (!detail.seasons.length) {
    return renderSeasonPanelState("No seasons reported", "Seerr did not return a season catalog for this series.");
  }
  const requestableCount = detail.seasons.filter(({ requestable }) => requestable).length;
  const controlKey = `media:seerr:requestSeasons:${context.target.mediaId}`;
  const busy = state.actionMutation === controlKey;
  const awaitingRefresh = state.actionAwaitingRefresh === controlKey;
  return `<fieldset class="drawer-season-picker" data-season-picker data-detail-revision="${detail.detailRevision}" aria-describedby="drawer-season-help-${item.key}">
    <legend>Seasons</legend>
    ${detail.tvdbMappingPresent ? "" : `<div class="drawer-season-warning" role="note">${icon("shield")}<span><strong>TVDB mapping not reported</strong><small>Seerr may be unable to pass an auto-approved request to Sonarr. Verify this title's TVDB or anthology-season mapping before requesting it again.</small></span></div>`}
    <p class="drawer-season-help" id="drawer-season-help-${item.key}">${requestableCount
      ? `Choose up to ${MAX_REQUESTED_SEASONS} seasons. Helmsman sends one request to Seerr.`
      : "Every reported season is already available, requested, or not requestable."}</p>
    <div class="drawer-season-grid">${detail.seasons.map((season) => {
      const label = season.seasonNumber === 0 ? "Specials" : season.name || `Season ${season.seasonNumber}`;
      const numberedLabel = `Season ${season.seasonNumber}`;
      const episodeCopy = season.episodeCount === null ? "Episode count pending" : `${season.episodeCount} ${season.episodeCount === 1 ? "episode" : "episodes"}`;
      const detailCopy = label.toLocaleLowerCase() === numberedLabel.toLocaleLowerCase()
        ? `${episodeCopy} · ${formatSeasonAirDate(season.airDate)}`
        : `${numberedLabel} · ${episodeCopy} · ${formatSeasonAirDate(season.airDate)}`;
      const disabled = !season.requestable || Boolean(state.actionMutation);
      return `<label class="drawer-season-option is-${seasonStatusTone(season)} ${disabled ? "is-disabled" : ""}">
        <input type="checkbox" name="seasonNumber" value="${season.seasonNumber}" data-season-select ${disabled ? "disabled" : ""}/>
        <span class="drawer-season-option__copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detailCopy)}</small><em>${escapeHtml(seasonStatusLabel(season))}</em></span>
      </label>`;
    }).join("")}</div>
    <div class="drawer-season-actions"><span data-season-selection-summary aria-live="polite">No seasons selected</span><button class="button button--primary" type="button" data-action="request-seasons" data-media-id="${escapeHtml(item.id)}" data-control-operation="requestSeasons" data-control-key="${escapeHtml(controlKey)}" disabled ${busy && !awaitingRefresh ? "aria-busy=\"true\"" : ""}>${awaitingRefresh ? `${icon("refresh")} Refresh required` : busy ? `${icon("refresh")} Working…` : "Request selected"}</button></div>
  </fieldset>`;
}

function renderMediaSeasonPanel(item) {
  if (!item?.seasonRequestTarget) return "";
  return `<section class="drawer-season-panel" data-season-panel data-media-id="${escapeHtml(item.id)}" aria-labelledby="drawer-season-title-${item.key}"><header><span class="drawer-kicker">Series catalog</span><h3 id="drawer-season-title-${item.key}" data-season-panel-heading tabindex="-1">${item.mediaType === "episode" ? "Series seasons" : "Seasons"}</h3></header>${renderMediaSeasonPanelContent(item)}</section>`;
}

function selectedSeasonNumbers(panel) {
  const values = [...(panel?.querySelectorAll?.("[data-season-select]") || [])]
    .filter((input) => input.checked && !input.disabled)
    .flatMap((input) => {
      const seasonNumber = mediaNumber(input.value, 1, 10_000);
      return Number.isSafeInteger(seasonNumber) ? [seasonNumber] : [];
    });
  return [...new Set(values)].sort((left, right) => left - right);
}

function syncSeasonSelection(panel, changedInput = null) {
  if (!panel) return;
  const checkedInputs = [...(panel.querySelectorAll?.("[data-season-select]") || [])]
    .filter((input) => input.checked && !input.disabled);
  let limitReached = false;
  if (checkedInputs.length > MAX_REQUESTED_SEASONS) {
    const overflow = changedInput?.checked && checkedInputs.includes(changedInput)
      ? [changedInput]
      : checkedInputs.slice(MAX_REQUESTED_SEASONS);
    overflow.forEach((input) => { input.checked = false; });
    limitReached = true;
  }
  const selected = selectedSeasonNumbers(panel);
  const summary = panel.querySelector?.("[data-season-selection-summary]");
  const button = panel.querySelector?.("[data-action='request-seasons']");
  if (summary) summary.textContent = limitReached
    ? `${MAX_REQUESTED_SEASONS} seasons selected · limit reached`
    : selected.length
      ? `${selected.length} ${selected.length === 1 ? "season" : "seasons"} selected`
      : "No seasons selected";
  if (button) {
    button.disabled = !selected.length || Boolean(state.actionMutation);
    if (!state.actionMutation) button.textContent = selected.length === 1 ? "Request season" : "Request selected";
  }
}

function patchMediaSeasonPanel(mediaId) {
  if (!drawerLayer?.classList.contains("is-open") || state.media.selectedId !== mediaId) return;
  const item = mediaRecordById(mediaId);
  const panel = drawerLayer.querySelector?.("[data-season-panel]");
  if (!item || !panel) return;
  const active = document.activeElement;
  const restoreInside = typeof panel.contains === "function" && panel.contains(active);
  setMarkup(panel, `<header><span class="drawer-kicker">Series catalog</span><h3 id="drawer-season-title-${item.key}" data-season-panel-heading tabindex="-1">${item.mediaType === "episode" ? "Series seasons" : "Seasons"}</h3></header>${renderMediaSeasonPanelContent(item)}`);
  syncSeasonSelection(panel);
  if (restoreInside) requestAnimationFrame(() => panel.querySelector?.("[data-season-panel-heading]")?.focus());
}

async function loadSeasonDetailsForMedia(mediaId, { force = false } = {}) {
  const item = mediaRecordById(mediaId);
  const context = seasonRequestContext(item);
  if (!item?.seasonRequestTarget || !context?.key || !context.connection) {
    patchMediaSeasonPanel(mediaId);
    return false;
  }
  const cached = state.media.seasonDetails.get(context.key);
  if (!force
    && cached?.state === "ready"
    && Number.isFinite(cached.loadedAt)
    && Date.now() - cached.loadedAt >= 0
    && Date.now() - cached.loadedAt <= SEASON_DETAIL_CACHE_TTL_MS) {
    patchMediaSeasonPanel(mediaId);
    return true;
  }
  const pending = state.media.seasonLoads.get(context.key);
  if (pending) {
    const result = await pending;
    patchMediaSeasonPanel(mediaId);
    return result;
  }
  const generation = state.media.seasonGeneration;
  storeSeasonDetail(context.key, { state: "loading" });
  patchMediaSeasonPanel(mediaId);
  let operation;
  operation = (async () => {
    try {
      const payload = await api(`/api/v2/media/series/${context.target.mediaId}/seasons?targetRevision=${encodeURIComponent(context.targetRevision)}`);
      const detail = normalizeSeasonDetail(payload, context.target, context.targetRevision);
      if (generation !== state.media.seasonGeneration) return false;
      storeSeasonDetail(context.key, { state: "ready", loadedAt: Date.now(), ...detail });
      return true;
    } catch (error) {
      if (generation !== state.media.seasonGeneration) return false;
      if (error?.status === 401) {
        await initialize();
        return false;
      }
      storeSeasonDetail(context.key, {
        state: "error",
        message: mediaText(error?.message, "The season catalog is temporarily unavailable.", 220)
      });
      return false;
    } finally {
      if (state.media.seasonLoads.get(context.key) === operation) state.media.seasonLoads.delete(context.key);
      if (generation === state.media.seasonGeneration) patchMediaSeasonPanel(mediaId);
    }
  })();
  state.media.seasonLoads.set(context.key, operation);
  return operation;
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
  return `<aside class="title-drawer ${item.seasonRequestTarget ? "title-drawer--seasons" : ""}" role="dialog" aria-modal="true" aria-labelledby="media-drawer-title">
    <button class="icon-button drawer-close" type="button" data-action="close-media-drawer" aria-label="Close media details">${icon("x")}</button>
    <div class="drawer-visual">${renderArtworkImage(item, { className: "hero-art-image", eager: true })}<div class="hero-shade"></div><span class="drawer-poster poster-art">${renderArtworkImage(item, { eager: true, priority: "auto" })}<span class="poster-monogram" aria-hidden="true">${escapeHtml(item.title.slice(0, 1).toUpperCase())}</span></span></div>
    <div class="drawer-body"><div class="drawer-heading-block"><div class="drawer-title-row"><div><span class="drawer-kicker">${escapeHtml(kicker)}</span><h2 id="media-drawer-title" tabindex="-1">${escapeHtml(item.title)}</h2><span class="status-pill status-${mediaStatusTone(item)}"><i></i>${escapeHtml(mediaStatusLabel(item))}</span></div></div>${renderMediaSeasonPanel(item)}<p class="drawer-summary">${escapeHtml(item.summary || item.error || "Helmsman matched this record across the connected media stack using provider identifiers.")}</p>${providerEntries.length ? `<div class="genre-row">${providerEntries.map(([provider, id]) => `<span>${escapeHtml(provider)} · ${escapeHtml(id)}</span>`).join("")}</div>` : ""}</div>
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
  if (item.seasonRequestTarget) void loadSeasonDetailsForMedia(item.id);
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
              <div class="logging-incident-actions"><time>${escapeHtml(formatTime(entry.lastSeen))}</time><a class="button button--compact" href="${escapeHtml(loggingContextHref({ view: "loki", service: entry.service, connectorId: lokiConnectorIdForMonitorService(entry.service), code: entry.code, from: entry.firstSeen }))}">View logs ${icon("chevron")}</a></div>
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
  const lokiId = serviceId.startsWith("loki-") ? serviceId.slice("loki-".length) : serviceId;
  const loki = normalizedLokiConfigurations().find((service) => service.id === lokiId);
  if (loki) return loki.displayName;
  const media = state.config?.services?.find((service) => service.id === serviceId);
  return safeSessionText(media?.name || value, "Service", 100);
}

function safeLogTimestamp(value) {
  const parsed = Date.parse(value);
  return value && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeLogLevel(value) {
  const candidate = String(value || "info").toLowerCase();
  if (candidate === "warning") return "warn";
  return ["debug", "info", "warn", "error"].includes(candidate) ? candidate : "info";
}

function safeLogDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000);
  } catch {
    return "";
  }
}

function normalizeJournalEntry(value, index) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const status = safeLogHttpStatus(source.httpStatus ?? source.status);
  const service = source.service
    ? logServiceDisplayName(source.service)
    : safeSessionText(source.component || source.source, "Helmsman", 100);
  const code = safeLogCode(source.code);
  const event = safeSessionText(source.event || source.type, "", 80).replaceAll("_", " ");
  const outcome = safeSessionText(source.outcome, "", 40).replaceAll("_", " ");
  return {
    id: safeSessionText(source.id || source.sequence, `entry-${index + 1}`, 120),
    at: safeLogTimestamp(source.at || source.createdAt || source.timestamp) || new Date(0).toISOString(),
    level: safeLogLevel(source.level || source.severity),
    source: service,
    scope: mediaText(source.capability, "", 80),
    category: safeSessionText(source.category || source.event || source.type, "application", 80),
    message: mediaText(source.message || source.summary || [event, outcome].filter(Boolean).join(" · ") || source.code, "Application event", 1_000),
    evidence: [
      source.message ? [event, outcome].filter(Boolean).join(" · ") : "",
      mediaText(source.capability, "", 80),
      mediaText(source.operation, "", 80),
      mediaText(source.route, "", 200),
      code,
      status === null ? "" : `HTTP ${status}`,
      Number.isFinite(source.durationMs) ? `${Math.round(source.durationMs).toLocaleString()} ms` : "",
      safeSessionText(source.correlationId, "", 120)
    ].filter(Boolean).join(" · "),
    details: typeof source.detail === "string" ? source.detail.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").slice(0, 4_000) : safeLogDetails(source.details || source.metadata || source.context)
  };
}

function journalEntriesForUi() {
  if (state.logging.journal.loaded || state.logging.journal.error || state.logging.journal.entries.length) {
    return state.logging.journal.entries;
  }
  return safeLogEntriesForSnapshot(state.snapshot)
    .map(normalizeJournalEntry)
    .sort((left, right) => right.at.localeCompare(left.at));
}

function normalizeJournalStorage(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const bytes = Number(source.bytes ?? source.usedBytes ?? source.sizeBytes ?? source.totalBytes);
  const maximum = Number(source.maxBytes ?? source.maximumBytes ?? source.limitBytes);
  const count = Number(source.entryCount ?? source.entries ?? source.count);
  const retention = Number(source.retentionDays ?? source.days);
  const rawState = String(source.state || "healthy").toLowerCase();
  const issueCodes = (Array.isArray(source.issueCodes) ? source.issueCodes : [])
    .map(safeLogCode)
    .filter(Boolean)
    .slice(0, 12);
  const stateName = rawState === "unavailable"
    ? "down"
    : ["healthy", "degraded", "limited", "down", "stale"].includes(rawState) ? rawState : "healthy";
  return {
    state: stateName,
    persistent: source.persistent !== false,
    writable: source.writable !== false,
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
    maximum: Number.isSafeInteger(maximum) && maximum > 0 ? maximum : null,
    count: Number.isSafeInteger(count) && count >= 0 ? count : null,
    retentionDays: Number.isSafeInteger(retention) && retention > 0 ? retention : null,
    lastWriteAt: safeLogTimestamp(source.lastWriteAt || source.updatedAt),
    issueCodes,
    message: safeSessionText(source.message, issueCodes.length
      ? `Journal needs attention · ${issueCodes.join(" · ")}`
      : source.persistent === false ? "Persistent journal unavailable" : "Persistent journal available", 240)
  };
}

function normalizeJournalPayload(payload) {
  const entries = (Array.isArray(payload?.entries) ? payload.entries : [])
    .slice(0, 500)
    .map(normalizeJournalEntry)
    .sort((left, right) => right.at.localeCompare(left.at));
  return {
    storage: normalizeJournalStorage(payload?.storage),
    entries,
    nextCursor: safeSessionText(payload?.nextCursor, "", 500)
  };
}

function journalEntryKey(entry) {
  return `${entry.id}\u0000${entry.at}\u0000${entry.message}`;
}

async function loadJournalLogs({ append = false, render = true } = {}) {
  if (!state.status?.authenticated || state.logging.journal.loading) return false;
  const journal = state.logging.journal;
  const generation = ++journal.requestGeneration;
  journal.loading = true;
  journal.error = "";
  if (render) {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  try {
    const cursor = append && journal.nextCursor ? `&cursor=${encodeURIComponent(journal.nextCursor)}` : "";
    const payload = normalizeJournalPayload(await api(`/api/v2/logs?limit=200${journalServerFilters()}${cursor}`));
    if (generation !== journal.requestGeneration) return false;
    if (append) {
      const seen = new Set(journal.entries.map(journalEntryKey));
      journal.entries = [...journal.entries, ...payload.entries.filter((entry) => !seen.has(journalEntryKey(entry)))]
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, 1_000);
    } else {
      journal.entries = payload.entries;
    }
    journal.storage = payload.storage;
    journal.nextCursor = payload.nextCursor;
    journal.loaded = true;
    return true;
  } catch (error) {
    if (generation === journal.requestGeneration) journal.error = error.message;
    return false;
  } finally {
    if (generation === journal.requestGeneration) journal.loading = false;
    if (render && generation === journal.requestGeneration) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
  }
}

function loggingSubnavigation(view) {
  return `<nav class="logging-subnav" aria-label="Logging sections">
    <a href="#/logs" ${view === "overview" ? "aria-current=\"page\" class=\"is-active\"" : ""}>Overview</a>
    <a href="#/logs?view=helmsman" ${view === "helmsman" ? "aria-current=\"page\" class=\"is-active\"" : ""}>Helmsman logs</a>
    <a href="#/logs?view=output" ${view === "output" ? "aria-current=\"page\" class=\"is-active\"" : ""}>Server output</a>
    <a href="#/logs?view=loki" ${view === "loki" ? "aria-current=\"page\" class=\"is-active\"" : ""}>Loki Explorer</a>
  </nav>`;
}

function storageFact(storage) {
  if (!storage) return "Loading persistent journal status…";
  const usage = storage.bytes === null ? "Usage pending" : storage.maximum === null
    ? formatMetricBytes(storage.bytes)
    : `${formatMetricBytes(storage.bytes)} of ${formatMetricBytes(storage.maximum)}`;
  const retention = storage.retentionDays === null ? "bounded retention" : `${storage.retentionDays} day retention`;
  return `${usage} · ${retention}`;
}

function renderLoggingOverview() {
  const journal = state.logging.journal;
  const storage = journal.storage;
  const loki = normalizedLokiConfigurations();
  const enabledLoki = loki.filter(({ enabled }) => enabled);
  const monitoredLoki = enabledLoki.filter(({ monitoringEnabled }) => monitoringEnabled);
  const monitoredHealth = monitoredLoki.map(({ id }) => lokiHealthById(id)).filter(Boolean);
  const unhealthyLokiState = ["down", "auth-required", "degraded", "limited"]
    .find((candidate) => monitoredHealth.some(({ state }) => state === candidate));
  const lokiState = !loki.length
    ? "stale"
    : !enabledLoki.length
      ? "disabled"
      : unhealthyLokiState
        ? unhealthyLokiState
        : monitoredLoki.length && monitoredHealth.length === monitoredLoki.length
          ? "healthy"
          : "stale";
  const lokiStatusLabel = !loki.length
    ? "Not connected"
    : !enabledLoki.length
      ? "Saved · disabled"
      : monitoredLoki.length
        ? `${enabledLoki.length} enabled · ${statusLabel(lokiState)}`
        : `${enabledLoki.length} query-ready · monitoring off`;
  const recentEntries = journalEntriesForUi();
  const counts = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
    level,
    recentEntries.filter((entry) => entry.level === level).length
  ]));
  const journalState = journal.error ? "down" : journal.loaded ? storage?.state || "healthy" : "stale";
  const journalStatusLabel = journal.error
    ? "Unavailable"
    : !journal.loaded ? "Loading" : journalState === "healthy" ? "Available" : statusLabel(journalState);
  return `${loggingSubnavigation("overview")}
    <div class="logging-overview-grid">
      <section class="logging-source-card is-${escapeHtml(journalState)}" aria-labelledby="helmsman-log-source-title">
        <header><span class="logging-source-card__mark">${icon("logs")}</span><div><span class="section-kicker">Built in</span><h3 id="helmsman-log-source-title">Helmsman logs</h3></div><span class="logging-health"><i class="health-dot is-${statusClass(journalState)}"></i>${escapeHtml(journalStatusLabel)}</span></header>
        <p>${escapeHtml(journal.error || storage?.message || "Persistent, sanitized application events remain available without an external logging system.")}</p>
        <dl><div><dt>Events loaded</dt><dd>${recentEntries.length.toLocaleString()}</dd></div><div><dt>Storage</dt><dd>${escapeHtml(storageFact(storage))}</dd></div><div><dt>Last write</dt><dd>${escapeHtml(formatTime(storage?.lastWriteAt, "Waiting for the first event"))}</dd></div></dl>
        <footer><a class="button button--primary" href="#/logs?view=helmsman">Open Helmsman logs</a><button class="button" type="button" data-action="refresh-journal">${icon("refresh")} Refresh</button></footer>
      </section>
      <section class="logging-source-card is-${escapeHtml(lokiState)}" aria-labelledby="loki-log-source-title">
        <header><span class="logging-source-card__mark">${icon("server")}</span><div><span class="section-kicker">External source</span><h3 id="loki-log-source-title">Loki</h3></div><span class="logging-health"><i class="health-dot is-${statusClass(lokiState)}"></i>${escapeHtml(lokiStatusLabel)}</span></header>
        <p>${loki.length ? "Query the log streams already collected by Loki without leaving Helmsman." : "Connect Loki as an Infrastructure observability service to search host, container, and application logs."}</p>
        <dl><div><dt>Connections</dt><dd>${loki.length}</dd></div><div><dt>Authentication</dt><dd>${escapeHtml(loki.length ? [...new Set(loki.map(({ authMode }) => authModeLabel(authMode)))].join(", ") : "Not configured")}</dd></div><div><dt>Results</dt><dd>${state.logging.loki.entries.length.toLocaleString()} from last query</dd></div></dl>
        <footer>${loki.length ? `<a class="button button--primary" href="#/logs?view=loki">Open Loki Explorer</a>` : `<button class="button button--primary" type="button" data-action="open-loki-service">${icon("plus")} Connect Loki</button>`}</footer>
      </section>
    </div>
    <section class="logging-stat-grid" aria-label="Loaded Helmsman event counts">
      ${[["info", "Info"], ["warn", "Warnings"], ["error", "Errors"], ["debug", "Debug"]].map(([level, label]) => `<div class="logging-stat is-${level}"><span>${label}</span><strong>${counts[level]}</strong></div>`).join("")}
    </section>
    ${recentEntries.length ? `<section class="logging-results" aria-labelledby="logging-recent-title"><header><div><span class="section-kicker">Latest persistent evidence</span><h3 id="logging-recent-title">Recent Helmsman events</h3></div><a class="button button--compact" href="#/logs?view=helmsman">View all</a></header><div class="logging-entry-list">${recentEntries.slice(0, 6).map(renderJournalEntry).join("")}</div></section>` : ""}
    <div class="logging-privacy">${icon("shield")}<div><strong>Two separate log sources</strong><p>Helmsman logs are sanitized before they are stored. Loki results are displayed transiently and may contain sensitive text collected from other systems; Helmsman does not copy those results into its journal.</p></div></div>`;
}

function journalRangeStart(range) {
  const milliseconds = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 }[range];
  return milliseconds ? Date.now() - milliseconds : 0;
}

function filteredJournalEntries() {
  const filters = state.logging.journal.filters;
  const search = filters.search.trim().toLowerCase();
  const cutoff = journalRangeStart(filters.range);
  return journalEntriesForUi().filter((entry) => (
    (filters.level === "all" || entry.level === filters.level)
    && (filters.source === "all" || entry.source === filters.source)
    && (!cutoff || Date.parse(entry.at) >= cutoff)
    && (!search || `${entry.message} ${entry.source} ${entry.category} ${entry.evidence}`.toLowerCase().includes(search))
  ));
}

function renderJournalEntry(entry) {
  const sourceLabel = [entry.source, entry.scope].filter(Boolean).join(" · ");
  return `<article class="logging-entry is-${escapeHtml(entry.level)}">
    <time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatTime(entry.at, "Unknown time"))}</time>
    <span class="log-level is-${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span>
    <span class="logging-entry__source">${escapeHtml(sourceLabel)}</span>
    <div class="logging-entry__content"><strong>${escapeHtml(entry.message)}</strong><small>${escapeHtml([entry.category, entry.evidence].filter(Boolean).join(" · "))}</small>${entry.details ? `<details><summary>Full detail</summary><pre>${escapeHtml(entry.details)}</pre></details>` : ""}</div>
  </article>`;
}

const JOURNAL_KINDS = Object.freeze([
  ["all", "Everything"],
  ["health", "Health checks"],
  ["request", "Service requests"],
  ["agent", "Agent"],
  ["action", "Actions"],
  ["application", "Errors and app events"],
  ["authentication", "Sign-ins"],
  ["configuration", "Settings changes"],
  ["connector", "Connections"],
  ["security", "Security"]
]);

function journalServerFilters() {
  const filters = state.logging.journal.filters;
  const params = new URLSearchParams();
  if (["debug", "info", "warn", "error"].includes(filters.level)) params.set("level", filters.level);
  if (JOURNAL_KINDS.some(([value]) => value === filters.kind && value !== "all")) params.set("category", filters.kind);
  const text = params.toString();
  return text ? `&${text}` : "";
}

// The download uses the same level, kind, time and search as the list.
function journalExportUrl() {
  const filters = state.logging.journal.filters;
  const params = new URLSearchParams(journalServerFilters().slice(1));
  const cutoff = journalRangeStart(filters.range);
  if (cutoff) params.set("from", new Date(cutoff).toISOString());
  const search = filters.search.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 100);
  if (search) params.set("q", search);
  const text = params.toString();
  return `/api/v2/logs/export${text ? `?${text}` : ""}`;
}

function debugLoggingActive() {
  const settings = state.logging.settings;
  return settings.level === "debug" && Boolean(settings.debugUntil) && Date.parse(settings.debugUntil) > Date.now();
}

function renderDebugLoggingNotice() {
  if (!state.logging.settings.loaded) return "";
  return debugLoggingActive()
    ? `<div class="logging-debug-notice is-on">${icon("logs")}<span><strong>Debug logging is on</strong> until ${escapeHtml(formatTime(state.logging.settings.debugUntil, "later"))}: every health check, service request and agent step is recorded.</span><a class="button button--compact" href="#/settings" data-settings-tab="logging">Change</a></div>`
    : `<div class="logging-debug-notice">${icon("logs")}<span>Normal logging. Turn on debug logging in Settings to record every health check, service request and agent step for a few hours.</span><a class="button button--compact" href="#/settings" data-settings-tab="logging">Settings</a></div>`;
}

async function loadLoggingSettings({ render = true } = {}) {
  const settings = state.logging.settings;
  if (!state.status?.authenticated || settings.loading) return;
  settings.loading = true;
  try {
    const payload = await api("/api/v2/logs/settings");
    Object.assign(settings, {
      level: payload?.level === "debug" ? "debug" : "normal",
      debugUntil: safeLogTimestamp(payload?.debugUntil) || null,
      defaultHours: Number.isSafeInteger(payload?.defaultHours) ? payload.defaultHours : 4,
      maximumHours: Number.isSafeInteger(payload?.maximumHours) ? payload.maximumHours : 24,
      error: ""
    });
  } catch (error) {
    settings.error = safeSessionText(error?.message, "Logging settings could not be loaded.", 200);
  } finally {
    settings.loading = false;
    settings.loaded = true;
    if (render && ["logs", "settings"].includes(currentRoute())) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
  }
}

async function saveLoggingSettings(debug, hours) {
  const settings = state.logging.settings;
  if (settings.saving) return;
  settings.saving = true;
  settings.error = "";
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  try {
    const payload = await api("/api/v2/logs/settings", { method: "PUT", body: debug ? { debug: true, hours } : { debug: false } });
    settings.level = payload?.level === "debug" ? "debug" : "normal";
    settings.debugUntil = safeLogTimestamp(payload?.debugUntil) || null;
    showToast(debug ? `Debug logging is on for ${hours} hour${hours === 1 ? "" : "s"}.` : "Debug logging is off.", "success");
  } catch (error) {
    settings.error = safeSessionText(error?.message, "Logging settings could not be saved.", 200);
  } finally {
    settings.saving = false;
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
}

function renderLoggingSettings() {
  const settings = state.logging.settings;
  if (!settings.loaded && !settings.loading) void loadLoggingSettings();
  const active = debugLoggingActive();
  const hourOptions = [1, 2, 4, 8, 12, 24].filter((hours) => hours <= settings.maximumHours);
  return `<header class="detail-hero"><div><span class="section-kicker">Diagnostics</span><h2>Logging</h2><p>Helmsman always records sign-ins, setting changes, actions, outages and errors with their full detail. Debug logging adds every health check, every request to your services and every agent step, for a few hours at a time.</p></div></header>
    <div class="settings-grid-v5">
      <section class="glass-panel settings-card-v5 logging-settings-card" aria-labelledby="logging-level-title"><header><div><span class="section-kicker">Detail level</span><h3 id="logging-level-title">Debug logging</h3></div>${icon("logs")}</header><div class="settings-card-v5__body">
        <div class="security-note ${active ? "security-note--good" : ""}">${icon(active ? "check" : "logs")}<div><strong>${active ? "Debug logging is on" : "Normal logging"}</strong><span>${active ? `Switches back to normal at ${escapeHtml(formatTime(settings.debugUntil, "the set time"))}, or when Helmsman restarts.` : "Milestones, errors with full detail, and a summary of each agent run."}</span></div></div>
        ${active
          ? `<div class="button-row"><button class="button" type="button" data-action="logging-debug-off" ${settings.saving ? "disabled" : ""}>Turn off now</button></div>`
          : `<form class="logging-debug-form" id="logging-debug-form"><label><span>Keep it on for</span><select name="hours">${hourOptions.map((hours) => `<option value="${hours}" ${hours === settings.defaultHours ? "selected" : ""}>${hours} hour${hours === 1 ? "" : "s"}</option>`).join("")}</select></label><button class="button button--primary" type="submit" ${settings.saving ? "disabled" : ""}>Turn on debug logging</button></form>`}
        ${settings.error ? `<p class="form-error" role="alert">${escapeHtml(settings.error)}</p>` : ""}
        <p class="settings-help">Debug entries take more space. Helmsman keeps a fixed amount of log storage (50 MB by default, up to 14 days) and deletes the oldest entries first.</p>
      </div></section>
      <section class="glass-panel settings-card-v5" aria-labelledby="logging-privacy-title"><header><div><span class="section-kicker">Privacy</span><h3 id="logging-privacy-title">What is never logged</h3></div>${icon("shield")}</header><div class="settings-card-v5__body">
        <p>Passwords, API keys, tokens, cookies, request and response bodies, and headers are never written to the log. Error messages and server output are scrubbed of anything that looks like a key, a password or a credential in a link before they are stored or shown.</p>
        <div class="button-row"><a class="button" href="#/logs?view=helmsman">Open Helmsman logs</a><a class="button" href="#/logs?view=output">Server output</a></div>
      </div></section>
    </div>`;
}

async function loadServerOutput({ render = true } = {}) {
  const output = state.logging.output;
  if (!state.status?.authenticated || output.loading) return;
  output.loading = true;
  if (render) {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  try {
    const payload = await api("/api/v2/logs/output?limit=1000");
    output.lines = (Array.isArray(payload?.lines) ? payload.lines : []).slice(-1_000).map((line) => ({
      at: safeLogTimestamp(line?.at) || "",
      stream: line?.stream === "stderr" ? "stderr" : "stdout",
      text: safeSessionText(line?.text, "", 500)
    }));
    output.capturing = payload?.capturing === true;
    output.error = "";
  } catch (error) {
    output.error = safeSessionText(error?.message, "Server output could not be loaded.", 200);
  } finally {
    output.loading = false;
    output.loaded = true;
    if (render && currentRoute() === "logs") {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
  }
}

function renderServerOutput() {
  const output = state.logging.output;
  const lines = [...output.lines].reverse();
  return `${loggingSubnavigation("output")}
    <section class="logging-status-strip is-${output.error ? "down" : "healthy"}"><span class="health-dot is-${output.error ? "down" : "healthy"}"></span><div><strong>${escapeHtml(output.error || (output.capturing || lines.length ? "Helmsman's recent server output" : "Server output is shown when Helmsman runs as its container"))}</strong><small>The most recent ${lines.length.toLocaleString()} lines since Helmsman started, newest first. The full history stays in docker logs.</small></div><button class="button button--compact" type="button" data-action="refresh-server-output" ${output.loading ? "disabled aria-busy=\"true\"" : ""}>${icon("refresh")} ${output.loading ? "Loading…" : "Refresh"}</button></section>
    <section class="logging-results" aria-labelledby="server-output-title"><header><div><span class="section-kicker">stdout and stderr</span><h3 id="server-output-title">Server output</h3></div><span class="count-pill">${lines.length}</span></header>
      ${lines.length ? `<ol class="server-output-list">${lines.map((line) => `<li class="is-${line.stream}"><time datetime="${escapeHtml(line.at)}">${escapeHtml(formatTime(line.at, ""))}</time><span>${line.stream === "stderr" ? "err" : "out"}</span><code>${escapeHtml(line.text)}</code></li>`).join("")}</ol>` : `<div class="logging-empty">${icon("logs")}<strong>${output.loading ? "Loading output" : "No output yet"}</strong><span>${output.capturing ? "Helmsman has not printed anything since it started." : "Run Helmsman from its container to see its output here."}</span></div>`}
    </section>
    <div class="logging-privacy">${icon("shield")}<div><strong>Scrubbed before display</strong><p>Anything that looks like a key, password, token or one-time setup token is replaced with [removed].</p></div></div>`;
}

function renderHelmsmanLogs() {
  const journal = state.logging.journal;
  const entries = filteredJournalEntries();
  const sources = [...new Set(journalEntriesForUi().map(({ source }) => source))].sort((left, right) => left.localeCompare(right));
  const filters = journal.filters;
  const journalState = journal.error ? "down" : journal.loaded ? journal.storage?.state || "healthy" : "stale";
  return `${loggingSubnavigation("helmsman")}
    <section class="logging-status-strip is-${escapeHtml(journalState)}"><span class="health-dot is-${statusClass(journalState)}"></span><div><strong>${escapeHtml(journal.error || (journal.loaded ? journal.storage?.message || "Persistent Helmsman journal available" : "Loading the persistent journal"))}</strong><small>${escapeHtml(storageFact(journal.storage))}</small></div><button class="button button--compact" type="button" data-action="refresh-journal" ${journal.loading ? "disabled aria-busy=\"true\"" : ""}>${icon("refresh")} ${journal.loading ? "Loading…" : "Refresh"}</button></section>
    <div class="logging-toolbar">
      <label class="logging-search" for="journal-search">${icon("search")}<span class="sr-only">Search Helmsman logs</span><input id="journal-search" type="search" value="${escapeHtml(filters.search)}" placeholder="Search messages, services, or codes" data-journal-filter="search" autocomplete="off" /></label>
      <label><span>Level</span><select data-journal-filter="level"><option value="all">All levels</option>${["error", "warn", "info", "debug"].map((level) => `<option value="${level}" ${filters.level === level ? "selected" : ""}>${level === "warn" ? "Warnings" : `${level[0].toUpperCase()}${level.slice(1)}`}</option>`).join("")}</select></label>
      <label><span>Kind</span><select data-journal-filter="kind">${JOURNAL_KINDS.map(([value, label]) => `<option value="${value}" ${filters.kind === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label><span>Source</span><select data-journal-filter="source"><option value="all">All sources</option>${sources.map((source) => `<option value="${escapeHtml(source)}" ${filters.source === source ? "selected" : ""}>${escapeHtml(source)}</option>`).join("")}</select></label>
      <label><span>Time</span><select data-journal-filter="range">${[["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["all", "All loaded"]].map(([value, label]) => `<option value="${value}" ${filters.range === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <a class="button logging-download" href="${escapeHtml(journalExportUrl())}" download>${icon("download")} Download</a>
    </div>
    ${renderDebugLoggingNotice()}
    <section class="logging-results" aria-labelledby="helmsman-log-results-title"><header><div><span class="section-kicker">Newest first</span><h3 id="helmsman-log-results-title">Helmsman events</h3></div><span class="count-pill">${entries.length}</span></header>
      <div class="logging-entry-list">${journal.loading && !journal.loaded ? `<div class="logging-empty">${icon("refresh")}<strong>Loading journal</strong><span>Reading bounded events from Helmsman's protected data volume.</span></div>` : journal.error ? `<div class="logging-empty is-error">${icon("x")}<strong>Journal unavailable</strong><span>${escapeHtml(journal.error)}</span></div>` : entries.length ? entries.map(renderJournalEntry).join("") : `<div class="logging-empty">${icon("logs")}<strong>No matching events</strong><span>Adjust the filters or wait for Helmsman to record an application event.</span></div>`}</div>
      ${journal.nextCursor ? `<footer class="logging-pagination"><button class="button" type="button" data-action="load-more-journal" ${journal.loading ? "disabled" : ""}>Load older events</button></footer>` : ""}
    </section>
    <div class="logging-privacy">${icon("shield")}<div><strong>Sanitized before storage</strong><p>Credentials, authorization headers, request bodies, and upstream response bodies are excluded from this journal.</p></div></div>`;
}

function authModeLabel(value) {
  return { none: "No authentication", basic: "Basic authentication", bearer: "Bearer token" }[value] || "No authentication";
}

function normalizeLokiEntry(value, index) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawLabels = source.labels && typeof source.labels === "object" && !Array.isArray(source.labels) ? source.labels : {};
  const labels = Object.entries(rawLabels).slice(0, 32).flatMap(([key, rawValue]) => {
    const safeKey = String(key || "");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(safeKey)) return [];
    return [[safeKey, safeSessionText(rawValue, "", 512)]];
  });
  return {
    id: safeSessionText(source.id, `loki-${index + 1}`, 120),
    at: safeLogTimestamp(source.at || source.timestamp || source.createdAt) || new Date(0).toISOString(),
    line: mediaText(source.line || source.message, "Empty log line", 4_000),
    labels
  };
}

function lokiRangeMilliseconds(value) {
  return { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 }[value] || 3_600_000;
}

function boundedLokiWindow(context, range) {
  const maximumRange = 86_400_000;
  const selectedRange = Math.min(maximumRange, lokiRangeMilliseconds(range));
  const contextualEnd = Date.parse(context.to);
  const endMilliseconds = Number.isFinite(contextualEnd) ? contextualEnd : Date.now();
  const contextualStart = Date.parse(context.from);
  let startMilliseconds = Number.isFinite(contextualStart)
    ? contextualStart
    : endMilliseconds - selectedRange;
  if (startMilliseconds >= endMilliseconds) startMilliseconds = endMilliseconds - selectedRange;
  if (endMilliseconds - startMilliseconds > maximumRange) startMilliseconds = endMilliseconds - maximumRange;
  return {
    start: new Date(startMilliseconds).toISOString(),
    end: new Date(endMilliseconds).toISOString()
  };
}

function normalizedLokiEntries(result) {
  if (Array.isArray(result?.entries)) return result.entries;
  if (!Array.isArray(result?.streams)) return [];
  return result.streams.flatMap((stream) => {
    const labels = stream?.labels && typeof stream.labels === "object" ? stream.labels : {};
    return (Array.isArray(stream?.entries) ? stream.entries : []).map((entry) => ({
      ...entry,
      labels
    }));
  });
}

function lokiFilterServiceToken(value) {
  const service = String(value || "").toLowerCase();
  if (service.startsWith("loki-") && lokiConnectorIdForMonitorService(service)) return "";
  if (service.startsWith("portainer-")) return "portainer";
  if (service.startsWith("proxmox-")) return "proxmox";
  return service;
}

function filteredLokiEntriesForUi() {
  const logging = state.logging.loki;
  const context = loggingRouteContext();
  const terms = [
    lokiFilterServiceToken(logging.service || context.service),
    context.code,
    context.containerId,
    context.node,
    context.workloadId,
    logging.search.trim()
  ].filter((value, index, values) => value && values.indexOf(value) === index)
    .map((value) => value.toLowerCase());
  if (!terms.length) return logging.entries;
  return logging.entries.filter((entry) => {
    const searchable = `${entry.line} ${entry.labels.map(([key, value]) => `${key}=${value}`).join(" ")}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

function syncLokiQueryControls(form) {
  if (!form) return;
  const data = new FormData(form);
  state.logging.loki.connectorId = String(data.get("connectorId") || "");
  state.logging.loki.range = ["15m", "1h", "6h", "24h"].includes(data.get("range"))
    ? String(data.get("range"))
    : "1h";
  state.logging.loki.service = String(data.get("service") || "").slice(0, 100);
  state.logging.loki.query = String(data.get("query") || "").slice(0, 2_000);
  state.logging.loki.search = String(data.get("search") || "").slice(0, 200);
}

function invalidateLokiQueryResults({ inPlace = false } = {}) {
  const logging = state.logging.loki;
  logging.requestGeneration += 1;
  logging.loading = false;
  logging.error = "";
  logging.entries = [];
  logging.truncated = false;
  logging.stats = null;
  logging.lastRunAt = "";
  logging.resultRouteHash = "";
  if (!inPlace) return;
  const results = main.querySelector?.("#loki-results-title")?.closest?.(".logging-results");
  if (!results) return;
  const count = results.querySelector(".count-pill");
  const summary = results.querySelector("header p");
  const list = results.querySelector(".logging-entry-list");
  if (count) count.textContent = "0";
  if (summary) summary.textContent = "Query controls changed. Run the query to load matching entries.";
  if (list) setMarkup(list, `<div class="logging-empty">${icon("search")}<strong>Run the updated query</strong><span>Previous results were cleared so they are not shown under different controls.</span></div>`);
  results.querySelector(".logging-pagination")?.remove();
  main.querySelector?.(".logging-query-error")?.remove();
}

function currentLokiConfiguration() {
  const configurations = queryableLokiConfigurations();
  return configurations.find(({ id }) => id === state.logging.loki.connectorId) || configurations[0] || null;
}

async function runLokiQuery({ render = true } = {}) {
  const logging = state.logging.loki;
  const connector = currentLokiConfiguration();
  const generation = ++logging.requestGeneration;
  logging.entries = [];
  logging.truncated = false;
  logging.stats = null;
  logging.lastRunAt = "";
  logging.resultRouteHash = "";
  if (!connector) {
    logging.loading = false;
    logging.error = "Enable a Loki connection before running a query.";
    if (render) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
    return false;
  }
  logging.loading = true;
  logging.error = "";
  if (render) {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  let query = logging.query.trim();
  if (!query || query.length > 2_000) {
    logging.loading = false;
    logging.error = query ? "Keep the LogQL query below 2,000 characters." : "Enter a LogQL stream selector.";
    if (render) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
    return false;
  }
  const context = loggingRouteContext();
  const { start, end } = boundedLokiWindow(context, logging.range);
  try {
    const result = await api(`/api/v2/logging/loki/${encodeURIComponent(connector.id)}/query`, {
      method: "POST",
      body: {
        targetRevision: connector.targetRevision,
        query,
        start,
        end,
        direction: "backward",
        limit: 200
      }
    });
    if (generation !== logging.requestGeneration) return false;
    logging.entries = normalizedLokiEntries(result).slice(0, 500).map(normalizeLokiEntry);
    logging.truncated = result?.truncated === true;
    logging.stats = result?.stats && typeof result.stats === "object" && !Array.isArray(result.stats) ? result.stats : null;
    logging.lastRunAt = new Date().toISOString();
    logging.resultRouteHash = canonicalLoggingHash();
    return true;
  } catch (error) {
    if (generation === logging.requestGeneration) {
      logging.entries = [];
      logging.truncated = false;
      logging.stats = null;
      logging.lastRunAt = "";
      logging.resultRouteHash = "";
      logging.error = error.message;
    }
    return false;
  } finally {
    if (generation === logging.requestGeneration) logging.loading = false;
    if (render && generation === logging.requestGeneration) {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
  }
}

function renderLokiEntry(entry) {
  return `<article class="logging-entry logging-entry--loki"><time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatTime(entry.at, "Unknown time"))}</time><div class="logging-entry__content"><strong>${escapeHtml(entry.line)}</strong>${entry.labels.length ? `<ul class="logging-labels" aria-label="Loki stream labels">${entry.labels.map(([key, value]) => `<li><span>${escapeHtml(key)}</span>=${escapeHtml(value)}</li>`).join("")}</ul>` : ""}</div></article>`;
}

function renderLokiExplorer() {
  const configurations = normalizedLokiConfigurations();
  const connectors = configurations.filter(({ enabled }) => enabled);
  const logging = state.logging.loki;
  const context = loggingRouteContext();
  const visibleEntries = filteredLokiEntriesForUi();
  if (!connectors.length) {
    const saved = configurations[0] || null;
    return `${loggingSubnavigation("loki")}<section class="logging-empty logging-empty--setup">${icon("server")}<span class="section-kicker">External log source</span><h3>${saved ? "Enable a Loki connection to begin exploring logs" : "Connect Loki to begin exploring logs"}</h3><p>${saved ? "Your Loki connection is saved but disabled. Review it under Infrastructure Connectors and enable it before Helmsman can run queries." : "Configure Loki under Infrastructure Connectors. Helmsman will query it through the protected server-side connection without storing the returned log lines."}</p>${context.service ? `<div class="logging-context"><strong>Pending context</strong><span>${escapeHtml(logServiceDisplayName(context.service))}${context.code ? ` · ${escapeHtml(context.code)}` : ""}</span></div>` : ""}<button class="button button--primary" type="button" data-action="open-loki-service"${saved ? ` data-loki-service-id="${escapeHtml(saved.id)}"` : ""}>${icon(saved ? "settings" : "plus")} ${saved ? "Review Loki connection" : "Connect Loki"}</button><a class="button" href="#/logs?view=helmsman">Open Helmsman logs</a></section>`;
  }
  const selectedId = connectors.some(({ id }) => id === logging.connectorId) ? logging.connectorId : connectors[0].id;
  if (!logging.connectorId) logging.connectorId = selectedId;
  const services = [...new Set([
    ...SERVICE_ORDER,
    "helmsman",
    "proxmox",
    "portainer",
    ...(context.service ? [context.service] : [])
  ])];
  const stats = logging.stats || {};
  const lineCount = stats.totalLinesProcessed ?? stats.lines;
  const byteCount = stats.totalBytesProcessed ?? stats.bytes;
  const executionTime = stats.execTimeMs;
  const summary = [
    Number.isFinite(Number(stats.streams)) ? `${Number(stats.streams).toLocaleString()} streams` : "",
    lineCount !== null && lineCount !== undefined && Number.isFinite(Number(lineCount)) ? `${Number(lineCount).toLocaleString()} lines` : "",
    byteCount !== null && byteCount !== undefined && Number.isFinite(Number(byteCount)) ? formatMetricBytes(Number(byteCount)) : "",
    executionTime !== null && executionTime !== undefined && Number.isFinite(Number(executionTime)) ? `${Math.max(0, Math.round(Number(executionTime))).toLocaleString()} ms` : "",
    logging.lastRunAt ? `Queried ${formatTime(logging.lastRunAt)}` : ""
  ].filter(Boolean).join(" · ");
  return `${loggingSubnavigation("loki")}
    ${context.service || context.code || context.containerId || context.node || context.workloadId ? `<div class="logging-context"><strong>Opened with context</strong><span>${escapeHtml([context.service && logServiceDisplayName(context.service), context.code, context.containerId && `container ${context.containerId.slice(0, 12)}`, context.node && `node ${context.node}`, context.workloadId && `workload ${context.workloadId}`].filter(Boolean).join(" · "))}</span><a href="#/logs?view=loki">Clear context</a></div>` : ""}
    <form class="logging-query" id="loki-query-form">
      <div class="logging-query__primary"><label><span>Loki connection</span><select name="connectorId">${connectors.map((connector) => `<option value="${escapeHtml(connector.id)}" ${selectedId === connector.id ? "selected" : ""}>${escapeHtml(connector.displayName)}</option>`).join("")}</select></label><label><span>Time range</span><select name="range">${[["15m", "Last 15 minutes"], ["1h", "Last hour"], ["6h", "Last 6 hours"], ["24h", "Last 24 hours"]].map(([value, label]) => `<option value="${value}" ${logging.range === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label><span>Service text</span><select name="service"><option value="">Any service</option>${services.map((service) => `<option value="${escapeHtml(service)}" ${(logging.service || context.service) === service ? "selected" : ""}>${escapeHtml(logServiceDisplayName(service))}</option>`).join("")}</select></label></div>
      <label class="logging-query__logql"><span>LogQL stream selector</span><input name="query" type="text" value="${escapeHtml(logging.query)}" maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false" required /></label>
      <label class="logging-query__search"><span>Contains text</span><input name="search" type="search" value="${escapeHtml(logging.search)}" maxlength="200" autocomplete="off" placeholder="Optional exact text filter" /></label>
      <button class="button button--primary" type="submit" ${logging.loading ? "disabled aria-busy=\"true\"" : ""}>${icon(logging.loading ? "refresh" : "search")} ${logging.loading ? "Querying…" : "Run query"}</button>
      <p class="logging-query__note">Queries are bounded to 200 newest entries. Context and text filters match both returned lines and stream labels. Returned Loki data remains transient in this browser.</p>
    </form>
    ${logging.error ? `<div class="logging-query-error" role="alert">${icon("x")}<span>${escapeHtml(logging.error)}</span></div>` : ""}
    <section class="logging-results" aria-labelledby="loki-results-title"><header><div><span class="section-kicker">Transient results</span><h3 id="loki-results-title">Loki log entries</h3><p>${escapeHtml(summary || "Run a query to load bounded log entries.")}</p></div><span class="count-pill">${visibleEntries.length}</span></header><div class="logging-entry-list">${logging.loading && !logging.entries.length ? `<div class="logging-empty">${icon("refresh")}<strong>Querying Loki</strong><span>Waiting for the bounded server-side query.</span></div>` : visibleEntries.length ? visibleEntries.map(renderLokiEntry).join("") : logging.entries.length ? `<div class="logging-empty"><strong>No returned entries match this context</strong><span>Adjust the service, context, or text filter and run the query again.</span></div>` : `<div class="logging-empty">${icon("search")}<strong>No Loki results loaded</strong><span>Choose a time range and run a query. Empty results do not affect the persistent Helmsman journal.</span></div>`}</div>${logging.truncated ? `<footer class="logging-pagination"><span>Result limit reached. Narrow the time range or LogQL selector before applying context filters.</span></footer>` : ""}</section>`;
}

function renderLogsPage() {
  const view = loggingRouteContext().view;
  const content = view === "helmsman" ? renderHelmsmanLogs() : view === "output" ? renderServerOutput() : view === "loki" ? renderLokiExplorer() : renderLoggingOverview();
  return `<section class="detail-page logging-page"><header class="detail-hero"><div><span class="section-kicker">Built-in and connected sources</span><h2>Logging</h2><p>Use Helmsman's persistent sanitized journal by default, or query a connected Loki server from the dedicated explorer.</p></div></header>${content}</section>`;
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

function normalizedLokiConfigurations() {
  const source = Array.isArray(state.config?.infrastructureServices)
    ? state.config.infrastructureServices
    : [];
  const seen = new Set();
  return source.slice(0, 16).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = String(raw.id || "").toLowerCase();
    if (!INFRASTRUCTURE_ID_PATTERN.test(id) || seen.has(id) || raw.type !== "loki") return [];
    seen.add(id);
    const protocol = (() => {
      try {
        return new URL(raw.url).protocol;
      } catch {
        return "";
      }
    })();
    const tlsMode = protocol === "http:"
      ? "none"
      : protocol === "https:" && raw.tlsMode === "pinned" ? "pinned" : "system";
    const fingerprint = typeof raw.certificateFingerprint === "string"
      && /^[a-f0-9]{64}$/u.test(raw.certificateFingerprint.toLowerCase())
      ? raw.certificateFingerprint.toLowerCase()
      : "";
    const authMode = ["none", "basic", "bearer"].includes(raw.authMode) ? raw.authMode : "none";
    return [{
      id,
      type: "loki",
      typeName: safeSessionText(raw.typeName, "Loki", 80),
      role: safeSessionText(raw.role, "Log aggregation and search", 80),
      category: safeSessionText(raw.category, "Observability", 80),
      displayName: safeSessionText(raw.displayName, "Loki", 80),
      url: safeSessionText(raw.url, "", 500),
      enabled: raw.enabled !== false,
      monitoringEnabled: raw.monitoringEnabled !== false,
      authMode,
      tenantId: safeSessionText(raw.tenantId, "", 128),
      tlsMode,
      certificateFingerprint: tlsMode === "pinned" ? fingerprint : "",
      targetRevision: safeSessionText(raw.targetRevision, "", 100),
      credentialConfigured: raw.credentialConfigured === true,
      credentialUpdatedAt: safeSessionText(raw.credentialUpdatedAt, "", 40)
    }];
  }).sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id));
}

function queryableLokiConfigurations() {
  return normalizedLokiConfigurations().filter(({ enabled, targetRevision }) => enabled && targetRevision);
}

function lokiConfigurationById(serviceId) {
  return normalizedLokiConfigurations().find(({ id }) => id === serviceId) || null;
}

function lokiHealthById(serviceId) {
  const services = Array.isArray(state.snapshot?.infrastructure?.services)
    ? state.snapshot.infrastructure.services
    : [];
  const raw = services.find((service) => service?.id === serviceId && service?.type === "loki");
  if (!raw) return null;
  const connection = String(raw.connectionState || "unverified").toLowerCase().replaceAll("-", "_");
  return {
    state: statusClass(raw.state),
    connectionState: ["connected", "auth_required", "unverified", "down"].includes(connection) ? connection : "unverified",
    checkedAt: safeLogTimestamp(raw.checkedAt || raw.lastCheckedAt),
    latencyMs: safeCheckLatency(raw.latencyMs),
    version: safeSessionText(raw.version, "", 80)
  };
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
  return `<article class="service-card-v5 infrastructure-card service-card-v5--split" data-connector-provider="proxmox">
    <span class="service-card-v5__letter service-card-v5__brand">${proxmoxBrandLinkMarkup()}</span>
    <button class="service-card-v5__action" type="button" data-action="open-infrastructure-target" data-infrastructure-target-id="${escapeHtml(target.id)}" aria-label="Open ${escapeHtml(target.displayName)} connection settings">
      <span class="service-card-v5__copy"><strong>${escapeHtml(target.displayName)}</strong><small>Proxmox VE · ${escapeHtml(target.environmentKind === "cluster" ? "Cluster" : target.environmentKind === "standalone" ? "Standalone server" : "Discovery pending")}</small><code>${escapeHtml(target.url || environment)}</code></span>
      <span class="service-card-v5__status"><i class="health-dot is-${statusClass(target.state)}"></i><b>${escapeHtml(proxmoxConnectorLabel(target))}</b><small>${target.credentialConfigured ? "API token protected" : "No API token"}</small></span>
      ${icon("chevron")}
    </button>
  </article>`;
}

function renderPortainerConnectorCard(service) {
  return `<button class="service-card-v5 infrastructure-card" type="button" data-action="open-portainer-service" data-portainer-service-id="${escapeHtml(service.id)}" data-connector-provider="portainer">
    <span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup("portainer", "P")}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(service.displayName)}</strong><small>${escapeHtml(service.typeName)} · ${escapeHtml(service.role)}</small><code>${escapeHtml(service.url || "Connection address unavailable")}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-${statusClass(service.state)}"></i><b>${escapeHtml(portainerConnectionLabel(service))}</b><small>${service.credentialConfigured ? "Access token protected" : "No access token"}</small></span>
    ${icon("chevron")}
  </button>`;
}

function lokiConnectionLabel(service) {
  const health = lokiHealthById(service.id);
  if (!service.enabled) return "Disabled";
  if (!service.monitoringEnabled) return "Query enabled · Monitoring off";
  if (!health) return service.authMode === "none" || service.credentialConfigured ? "Waiting for verification" : "Credential required";
  if (health.connectionState === "connected") return health.state === "healthy" ? "Connected · Healthy" : `Connected · ${statusLabel(health.state)}`;
  if (health.connectionState === "auth_required") return "Authentication required";
  if (health.connectionState === "down") return "Connection unavailable";
  return "Waiting for verification";
}

function renderLokiConnectorCard(service) {
  const health = lokiHealthById(service.id);
  const stateName = !service.enabled ? "disabled" : service.monitoringEnabled ? health?.state || "stale" : "stale";
  const credential = service.authMode === "none"
    ? "No authentication"
    : service.credentialConfigured ? `${authModeLabel(service.authMode)} protected` : "Credential missing";
  return `<button class="service-card-v5 infrastructure-card" type="button" data-action="open-loki-service" data-loki-service-id="${escapeHtml(service.id)}" data-connector-provider="loki">
    <span class="service-card-v5__letter service-card-v5__brand logging-connector-mark">${icon("logs")}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(service.displayName)}</strong><small>Loki · Observability</small><code>${escapeHtml(service.url || "Connection address unavailable")}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-${statusClass(stateName)}"></i><b>${escapeHtml(lokiConnectionLabel(service))}</b><small>${escapeHtml(credential)}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderAvailableInfrastructureConnector({ provider, name, role, detail, action, actionLabel }) {
  if (provider === "proxmox") {
    return `<article class="service-card-v5 infrastructure-card connector-card--available service-card-v5--split" data-connector-provider="proxmox">
      <span class="service-card-v5__letter service-card-v5__brand">${proxmoxBrandLinkMarkup()}</span>
      <button class="service-card-v5__action" type="button" data-action="${escapeHtml(action)}" aria-label="Set up ${escapeHtml(name)}">
        <span class="service-card-v5__copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role)}</small><code>${escapeHtml(detail)}</code></span>
        <span class="service-card-v5__status"><i class="health-dot is-disabled"></i><b>Available</b><small>${escapeHtml(actionLabel)}</small></span>
        ${icon("chevron")}
      </button>
    </article>`;
  }
  return `<button class="service-card-v5 infrastructure-card connector-card--available" type="button" data-action="${escapeHtml(action)}" data-connector-provider="${escapeHtml(provider)}">
    <span class="service-card-v5__letter service-card-v5__brand${provider === "loki" ? " logging-connector-mark" : ""}">${provider === "loki" ? icon("logs") : serviceIconMarkup(provider, name.slice(0, 1))}</span>
    <span class="service-card-v5__copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role)}</small><code>${escapeHtml(detail)}</code></span>
    <span class="service-card-v5__status"><i class="health-dot is-disabled"></i><b>Available</b><small>${escapeHtml(actionLabel)}</small></span>
    ${icon("chevron")}
  </button>`;
}

function renderInfrastructureConnectorsPage() {
  const proxmoxTargets = configuredInfrastructureTargetsForUi();
  const portainerServices = configuredPortainerServicesForUi();
  const lokiServices = normalizedLokiConfigurations();
  const configuredCount = proxmoxTargets.length + portainerServices.length + lokiServices.length;
  const proxmoxAction = proxmoxTargets.length
    ? `<button class="button button--compact" type="button" data-action="open-infrastructure-target">${icon("plus")} Add environment</button>`
    : "";
  const portainerAction = portainerServices.length
    ? `<button class="button button--compact" type="button" data-action="open-portainer-service">${icon("plus")} Add server</button>`
    : "";
  const lokiAction = lokiServices.length
    ? `<button class="button button--compact" type="button" data-action="open-loki-service">${icon("plus")} Add source</button>`
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
  const lokiContent = lokiServices.length
    ? lokiServices.map(renderLokiConnectorCard).join("")
    : renderAvailableInfrastructureConnector({
        provider: "loki",
        name: "Loki",
        role: "Centralized log aggregation and search",
        detail: "No log sources configured",
        action: "open-loki-service",
        actionLabel: "Connect an existing Loki server"
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
    },
    {
      id: "observability",
      kicker: "Observability",
      title: "Loki",
      description: "Search logs already collected from hosts, containers, and applications without leaving Helmsman.",
      summary: `${lokiServices.length} configured`,
      action: lokiAction,
      content: `<div class="service-grid-v5 infrastructure-target-grid">${lokiContent}</div>`
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

// AI agent -------------------------------------------------------------
// The agent itself runs in the container (server/agent.mjs). These views
// read its state, show its reports and approvals on the Overview, offer a
// chat box, and configure it from Settings. Nothing here assumes a
// particular model server, model, phone or homelab.

const AGENT_NOTE_LABELS = Object.freeze({
  incident: "Incident",
  recovery: "Recovered",
  digest: "Daily summary",
  "check-in": "Check-in",
  "rule-action": "Rule action",
  "agent-action": "Agent action"
});
const AGENT_NOTE_TONES = Object.freeze({ incident: "degraded", recovery: "healthy", digest: "stale", "check-in": "stale", "rule-action": "limited", "agent-action": "limited" });
const AGENT_CHAT_LIMIT = 12;
const AGENT_QUESTION_LIMIT = 1_000;
const AGENT_OPERATION_LABELS = Object.freeze({ restart: "Restart", start: "Start", reboot: "Reboot", stop: "Stop", shutdown: "Shut down", blocklistAndSearch: "Clear stuck" });

function emptyAgentState() {
  return {
    loaded: false,
    error: "",
    data: null,
    chat: [],
    decisions: new Map(),
    // Saved conversations: ratings by conversation id, the one being
    // corrected, and the Settings review list.
    ratings: new Map(),
    ratingVersion: 0,
    editingAnswer: "",
    chatRestored: false,
    training: { loaded: false, loading: false, error: "", status: null, items: [], busy: "" },
    draft: "",
    helperDraft: "",
    asking: false,
    busy: ""
  };
}

function agentData() {
  return state.agent.data;
}

function agentFingerprint(data) {
  if (!data) return "";
  return JSON.stringify([data.config, data.status?.enabled, data.status?.lastModel?.ok, data.notes?.map(({ id }) => id), data.proposals?.map(({ id, status }) => `${id}:${status}`)]);
}

async function loadAgent({ render = false } = {}) {
  if (!state.status?.authenticated) return false;
  const previous = agentFingerprint(state.agent.data);
  try {
    state.agent.data = await api("/api/v2/agent");
    state.agent.error = "";
  } catch (error) {
    if (error?.status === 401) return false;
    state.agent.error = safeSessionText(error?.message, "The agent could not be reached.", 180);
  }
  state.agent.loaded = true;
  if (!state.agent.chatRestored && state.agent.data?.config?.conversations?.keep) void restoreAgentChat();
  syncAgentHelper();
  if (render && previous !== agentFingerprint(state.agent.data) && ["system", "settings"].includes(currentRoute())) {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
  return true;
}

function rerenderAgent() {
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
  syncAgentHelper();
}

function agentStatus(data) {
  if (!data) return { tone: "stale", label: "Loading" };
  if (data.status?.configurationProblem) return { tone: "down", label: "Settings problem" };
  if (!data.config?.ai) return { tone: "disabled", label: "Not set up" };
  if (!data.status?.enabled) return { tone: "disabled", label: "Off" };
  if (data.status?.restart?.holding) return { tone: "stale", label: data.status.restart.kind === "restarting" ? "Holding alerts: restart" : "Holding alerts: node unreachable" };
  if (data.status?.lastModel && data.status.lastModel.ok === false) return { tone: "degraded", label: "Model unreachable" };
  return { tone: "healthy", label: "Watching" };
}

function agentNoteTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderAgentProposal(proposal) {
  const busy = state.agent.busy === proposal.id;
  return `<li class="agent-proposal">
    <div><strong>${escapeHtml(AGENT_OPERATION_LABELS[proposal.operation] || proposal.operation)} ${escapeHtml(proposal.target)}</strong><p>${escapeHtml(proposal.reason || "Suggested by the agent.")} <small>Expires ${escapeHtml(agentNoteTime(proposal.expiresAt))}.</small></p></div>
    <div class="agent-proposal__actions">
      <button class="button button--compact" type="button" data-action="agent-proposal" data-decision="decline" data-proposal-id="${escapeHtml(proposal.id)}" ${busy ? "disabled" : ""}>Decline</button>
      <button class="button button--compact button--primary" type="button" data-action="agent-proposal" data-decision="approve" data-proposal-id="${escapeHtml(proposal.id)}" ${busy ? "disabled aria-busy=\"true\"" : ""}>${busy ? "Working…" : "Approve"}</button>
    </div>
  </li>`;
}

function renderAgentNote(note) {
  const tone = AGENT_NOTE_TONES[note.kind] || "stale";
  return `<li class="agent-note">
    <i class="health-dot is-${tone}" aria-hidden="true"></i>
    <div>
      <header><strong>${escapeHtml(note.title || AGENT_NOTE_LABELS[note.kind] || "Note")}</strong><time datetime="${escapeHtml(note.at)}">${escapeHtml(agentNoteTime(note.at))}</time></header>
      <p>${escapeHtml(note.text || "")}</p>
      <small>${escapeHtml(AGENT_NOTE_LABELS[note.kind] || "Note")}${note.model ? ` · ${escapeHtml(note.model)}` : " · Helmsman facts"}${note.notified ? " · sent to phone" : ""}</small>
      ${note.conversationId && agentData()?.config?.conversations?.keep ? renderAnswerRating(note.conversationId, note.text) : ""}
    </div>
  </li>`;
}

// An approval request shown right where it was made: under the chat answer
// that created it, with its buttons, and afterwards with what happened.
function renderInlineProposal(id) {
  const pending = (agentData()?.proposals || []).find((proposal) => proposal.id === id);
  if (pending) return `<ul class="agent-inline-proposals">${renderAgentProposal(pending)}</ul>`;
  const decided = state.agent.decisions.get(id);
  if (!decided) return `<p class="agent-proposal-outcome is-stale">${icon("more")}<span>No longer waiting: it expired or was decided elsewhere.</span></p>`;
  const tone = decided.status === "approved" ? "ok" : decided.status === "declined" ? "stale" : "bad";
  const text = decided.status === "approved"
    ? `Approved: ${decided.label}. ${decided.outcome || "Done."}`
    : decided.status === "declined" ? `Declined: ${decided.label}.` : `${decided.label} did not run: ${decided.outcome || "the action failed."}`;
  return `<p class="agent-proposal-outcome is-${tone}">${icon(tone === "ok" ? "check" : tone === "bad" ? "x" : "more")}<span>${escapeHtml(text)}</span></p>`;
}

// Requests that did not come from this chat (incident reports, stuck
// downloads), shown in the strip above the conversation.
function backgroundProposals(proposals) {
  const inChat = new Set(state.agent.chat.flatMap((message) => message.proposals || []));
  return proposals.filter((proposal) => !inChat.has(proposal.id));
}

function renderAgentChatMessages(ready) {
  const messages = state.agent.chat;
  return `${messages.length ? messages.map((message) => `<li class="agent-chat__message is-${message.role}${message.error ? " is-error" : ""}">
        <p>${escapeHtml(message.content)}</p>
        ${(message.proposals || []).map(renderInlineProposal).join("")}
        ${message.role === "assistant" && message.conversationId ? renderAnswerRating(message.conversationId, message.content) : ""}
      </li>`).join("") : `<li class="agent-chat__empty">${ready ? "Ask how things look, why something is failing, or what changed today. Answers come from your own model and Helmsman's live data." : "Connect a model server in Settings to ask questions."}</li>`}
      ${state.agent.asking ? `<li class="agent-chat__message is-assistant is-thinking"><p>Thinking…</p></li>` : ""}`;
}

function renderAgentChat(data) {
  const ready = Boolean(data?.config?.ai);
  const messages = state.agent.chat;
  return `<section class="agent-chat" aria-labelledby="agent-chat-title">
    <header><h4 id="agent-chat-title">Ask the agent</h4>${messages.length ? `<button class="agent-text-button" type="button" data-action="agent-chat-clear">Clear</button>` : ""}</header>
    <ol class="agent-chat__messages" aria-live="polite">${renderAgentChatMessages(ready)}</ol>
    <form class="agent-chat__form" id="agent-ask-form">
      <label class="sr-only" for="agent-ask-input">Question for the agent</label>
      <textarea id="agent-ask-input" name="question" rows="2" maxlength="${AGENT_QUESTION_LIMIT}" placeholder="${ready ? "How is everything looking?" : "Set up the agent first"}" ${ready ? "" : "disabled"}>${escapeHtml(state.agent.draft)}</textarea>
      <button class="button button--primary" type="submit" ${!ready || state.agent.asking ? "disabled" : ""}>${state.agent.asking ? "Asking…" : "Ask"}</button>
    </form>
  </section>`;
}

function renderAgentOverviewCard() {
  const data = agentData();
  if (!state.agent.loaded) return "";
  const status = agentStatus(data);
  const header = `<header><div><span class="section-kicker">Local AI</span><h3 id="system-agent-title">Agent</h3></div><div class="agent-card__meta"><span class="system-service-state is-${status.tone}"><i class="health-dot is-${status.tone}"></i>${escapeHtml(status.label)}</span><a class="system-overview-link" href="#/settings" data-settings-tab="agent">Agent settings ${icon("chevron")}</a></div></header>`;
  if (!data) {
    return `<section class="system-overview-card system-overview-card--agent" aria-labelledby="system-agent-title">${header}${renderMediaEmpty("Agent unavailable", state.agent.error || "The agent could not be reached.", "shield")}</section>`;
  }
  if (!data.config?.ai) {
    return `<section class="system-overview-card system-overview-card--agent" aria-labelledby="system-agent-title">${header}
      <div class="agent-intro">
        <p>Connect a model running on your own hardware and Helmsman will explain problems in plain language, send a daily summary, answer questions, and suggest fixes for you to approve.</p>
        <a class="button button--primary" href="#/settings" data-settings-tab="agent">Set up the agent</a>
      </div>
    </section>`;
  }
  const proposals = data.proposals || [];
  const notes = (data.notes || []).slice(0, 6);
  const digestBusy = state.agent.busy === "digest";
  return `<section class="system-overview-card system-overview-card--agent" aria-labelledby="system-agent-title">${header}
    <div class="agent-overview">
      <section class="agent-reports" aria-labelledby="agent-reports-title">
        <header><h4 id="agent-reports-title">Reports</h4><button class="agent-text-button" type="button" data-action="agent-run" data-job="digest" ${digestBusy ? "aria-disabled=\"true\" aria-busy=\"true\"" : ""}>${digestBusy ? "Writing summary…" : "Summarize now"}</button></header>
        ${backgroundProposals(proposals).length ? `<div class="agent-proposals"><span class="section-kicker">Waiting for your approval</span><ul>${backgroundProposals(proposals).map(renderAgentProposal).join("")}</ul></div>` : ""}
        ${notes.length
          ? `<ul class="agent-notes">${notes.map(renderAgentNote).join("")}</ul>`
          : `<p class="agent-empty">No reports yet. The agent writes one when something breaks or recovers, at the daily summary time, and during periodic check-ins.</p>`}
      </section>
      ${renderAgentChat(data)}
    </div>
  </section>`;
}

// Settings -----------------------------------------------------------

function agentRuleServiceOptions() {
  const snapshot = state.snapshot || {};
  const options = [];
  const seen = new Set();
  const add = (id, label) => {
    const value = String(id || "");
    if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/u.test(value) || seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: safeSessionText(label, value, 80) });
  };
  for (const service of snapshot.services || []) add(service.id, service.label || service.name || service.id);
  for (const service of snapshot.infrastructure?.portainer || []) add(service.id, `${service.displayName || "Portainer"} (Portainer)`);
  for (const service of snapshot.infrastructure?.services || []) add(service.id, service.displayName || service.name || service.id);
  for (const environment of snapshot.infrastructure?.environments || []) add(environment.id, `${environment.displayName || "Proxmox"} (Proxmox)`);
  return options;
}

function agentRuleTargetOptions() {
  const snapshot = state.snapshot || {};
  const containers = [];
  for (const service of snapshot.infrastructure?.portainer || []) {
    for (const container of service.inventory?.containers || []) {
      const name = String(container.name || "").replace(/^\//u, "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) continue;
      containers.push({ value: `container|${service.id}|${name}`, label: `${name} · ${service.displayName || "Portainer"}` });
    }
  }
  const guests = [];
  for (const environment of snapshot.infrastructure?.environments || []) {
    for (const workload of environment.workloads || []) {
      if (workload.template || !Number.isSafeInteger(Number(workload.vmid))) continue;
      guests.push({ value: `guest|${environment.id}|${Number(workload.vmid)}`, label: `${workload.name || "Guest"} (${workload.type === "lxc" ? "LXC" : "VM"} ${Number(workload.vmid)}) · ${environment.displayName || "Proxmox"}` });
    }
  }
  const byLabel = (left, right) => left.label.localeCompare(right.label);
  return { containers: containers.sort(byLabel), guests: guests.sort(byLabel) };
}

function agentRuleSentence(rule) {
  const services = new Map(agentRuleServiceOptions().map(({ value, label }) => [value, label]));
  const serviceLabel = services.get(rule.when.service) || rule.when.service;
  let target;
  if (rule.then.kind === "container") {
    const portainer = (state.snapshot?.infrastructure?.portainer || []).find(({ id }) => id === rule.then.serviceId);
    target = `container ${rule.then.containerName}${portainer?.displayName ? ` on ${portainer.displayName}` : ""}`;
  } else {
    const environment = (state.snapshot?.infrastructure?.environments || []).find(({ id }) => id === rule.then.environmentId);
    const workload = environment?.workloads?.find(({ vmid }) => Number(vmid) === rule.then.vmid);
    target = `${workload?.name ? `${workload.name} ` : ""}(guest ${rule.then.vmid})${environment?.displayName ? ` on ${environment.displayName}` : ""}`;
  }
  return {
    title: `When ${serviceLabel} is down for ${rule.when.minutes} min, ${rule.then.operation} ${target}`,
    detail: `At most once per incident · ${rule.cooldownMinutes} min cooldown · up to ${rule.maxPerDay} a day`
  };
}

function renderAgentSetupSteps(data) {
  const configured = data?.config || {};
  const steps = [
    {
      done: Boolean(configured.ai),
      title: "Run a model server on your network",
      detail: "Any OpenAI-compatible server works: Ollama, LM Studio, llama.cpp's server or vLLM. A 3–4B model on a 4 GB GPU is enough. The server must listen on your network, not only on localhost."
    },
    { done: Boolean(configured.ai), title: "Connect it below", detail: "Enter its address, test it, and pick one of the models it lists." },
    { done: Boolean(configured.ai && configured.settings?.enabled), title: "Turn the agent on", detail: "Choose which events it reports and your time zone for the daily summary." },
    { done: Boolean(configured.notify), optional: true, tab: "notifications", title: "Send reports to your phone", detail: "Through a Home Assistant notify action, such as the Companion app's mobile_app action." },
    { done: Boolean(configured.rules?.length || configured.containerHealth?.enabled), optional: true, tab: "automation", title: "Let it fix things", detail: "Restart unhealthy containers, or restart or start something when a service stays down. The model never acts on its own; Helmsman's code checks every action." }
  ];
  return `<section class="glass-panel settings-card-v5 agent-setup">
    <header><div><span class="section-kicker">Getting started</span><h3>Set up the agent</h3></div>${icon("book")}</header>
    <div class="settings-card-v5__body">
      <ol class="agent-steps">${steps.map((step, index) => `<li class="${step.done ? "is-done" : ""}">
        <span class="agent-steps__marker" aria-hidden="true">${step.done ? icon("check") : index + 1}</span>
        <div><strong>${escapeHtml(step.title)}${step.optional ? ` <em>Optional</em>` : ""}</strong><p>${escapeHtml(step.detail)}</p>${step.tab ? `<button class="agent-text-button" type="button" data-action="settings-tab" data-settings-tab="${step.tab}">Open ${step.tab === "notifications" ? "Notifications" : "Automation"}</button>` : ""}</div>
        <span class="sr-only">${step.done ? "Done" : "Not done"}</span>
      </li>`).join("")}</ol>
      <p class="agent-setup__more">Full guide, including GPU sizing and how to expose Ollama on your network: <a href="https://github.com/nunesg130-boop/helmsman/blob/main/docs/LOCAL-AI.md" target="_blank" rel="noopener noreferrer">docs/LOCAL-AI.md</a>.</p>
    </div>
  </section>`;
}

function renderAgentModelCard(data) {
  const ai = data?.config?.ai;
  const limits = data?.limits || {};
  const context = limits.contextTokens || { min: 2048, max: 131072, default: 4096 };
  const timeout = limits.timeoutSeconds || { min: 10, max: 300, default: 120 };
  return `<form class="glass-panel settings-card-v5" id="agent-ai-form">
    <header><div><span class="section-kicker">Step 2 · Model</span><h3>Model server</h3></div>${icon("server")}</header>
    <div class="settings-card-v5__body">
      <div class="form-grid">
        <label><span>Server address</span><input name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://model-server:11434" value="${escapeHtml(ai?.url || "")}" required /><small>Ollama uses port 11434, LM Studio 1234. Leave off /v1.</small></label>
        <label><span>Model</span><input name="model" type="text" autocomplete="off" spellcheck="false" list="agent-model-options" placeholder="Test the server to list its models" value="${escapeHtml(ai?.model || "")}" required /><datalist id="agent-model-options"></datalist></label>
        <label><span>API key <em>optional</em></span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${ai?.apiKeyConfigured ? "Saved. Leave empty to keep it" : "Only if your server requires one"}" /></label>
        ${ai?.apiKeyConfigured ? `<label class="check-row"><input name="clearApiKey" type="checkbox" /><span><strong>Remove the saved API key</strong><small>Use this when the server no longer needs a key.</small></span></label>` : ""}
      </div>
      <details class="agent-advanced"><summary>Advanced</summary>
        <div class="form-grid form-grid--two">
          <label><span>Context size (tokens)</span><input name="contextTokens" type="number" min="${context.min}" max="${context.max}" step="256" value="${Number(ai?.contextTokens || context.default)}" /><small>Match the context your server loads the model with.</small></label>
          <label><span>Timeout (seconds)</span><input name="timeoutSeconds" type="number" min="${timeout.min}" max="${timeout.max}" value="${Number(ai?.timeoutSeconds || timeout.default)}" /></label>
        </div>
      </details>
      <p class="agent-test-result" id="agent-ai-test-result" role="status"></p>
      <div class="button-row">
        <button class="button" type="button" data-action="agent-test-ai">Test connection</button>
        <button class="button button--primary" type="submit">${ai ? "Save model" : "Connect model"}</button>
        ${ai ? `<button class="button button--danger" type="button" data-action="agent-remove" data-agent-part="ai">Disconnect</button>` : ""}
      </div>
    </div>
  </form>`;
}

const AGENT_VOICE_PRESETS = Object.freeze({
  brief: "Answer in one or two short sentences. Skip greetings, and don't recap service health unless I ask about it.",
  detailed: "Explain in a short paragraph. Name the service, host or container involved, say how you know, and suggest one next step.",
  friendly: "Be warm and casual, like a friend who helps run the homelab. Keep answers short and skip the jargon."
});

function agentVoiceCountText(text, data) {
  const tokens = Math.ceil(String(text || "").length / 3.2);
  const context = Number(data?.config?.ai?.contextTokens || 4096);
  return `${String(text || "").length.toLocaleString()} characters · about ${tokens.toLocaleString()} tokens of your ${context.toLocaleString()}-token context`;
}

function renderAgentVoiceCard(data) {
  const ai = data?.config?.ai;
  const limit = Number(data?.limits?.extraInstructions || 2000);
  const text = ai?.extraInstructions || "";
  return `<form class="glass-panel settings-card-v5" id="agent-voice-form">
    <header><div><span class="section-kicker">Optional · Personality</span><h3>How the agent responds</h3></div>${icon("edit")}</header>
    <div class="settings-card-v5__body">
      <p>Tell the agent how to talk: length, tone, what to include. Your text is added to its built-in instructions. The safety rules always come last, so they can't be turned off here.</p>
      <div class="agent-voice__presets" role="group" aria-label="Start from a preset">
        ${Object.keys(AGENT_VOICE_PRESETS).map((name) => `<button class="button button--compact" type="button" data-action="agent-voice-preset" data-preset="${name}" ${ai ? "" : "disabled"}>${name[0].toUpperCase()}${name.slice(1)}</button>`).join("")}
      </div>
      <label><span class="sr-only">Response instructions</span><textarea id="agent-voice-input" name="extraInstructions" rows="6" maxlength="${limit}" placeholder="${ai ? "Such as: Keep answers under three sentences and always name the host involved." : "Connect a model server first."}" ${ai ? "" : "disabled"}>${escapeHtml(text)}</textarea></label>
      <small class="agent-voice__count" id="agent-voice-count" aria-live="polite">${escapeHtml(agentVoiceCountText(text, data))}</small>
      <p class="agent-voice__hint">Small models follow short, specific instructions best, and every token here leaves less room for live data.</p>
      <div class="button-row"><button class="button button--primary" type="submit" ${ai ? "" : "disabled"}>Save instructions</button></div>
    </div>
  </form>`;
}

async function submitAgentVoice(form) {
  const text = String(new FormData(form).get("extraInstructions") || "");
  await agentMutation("/ai", "PUT", { extraInstructions: text }, text.trim() ? "Response instructions saved." : "Response instructions cleared.");
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function renderAgentBehaviorCard(data) {
  const settings = data?.config?.settings || {};
  const triggers = settings.triggers || {};
  const checkIn = data?.limits?.checkInHours || { min: 1, max: 24, default: 6 };
  const localZone = browserTimeZone();
  const zone = settings.timeZone || localZone;
  const triggerRow = (name, title, detail) => `<label class="check-row"><input name="${name}" type="checkbox" ${triggers[name] !== false ? "checked" : ""}/><span><strong>${title}</strong><small>${detail}</small></span></label>`;
  return `<form class="glass-panel settings-card-v5" id="agent-settings-form">
    <header><div><span class="section-kicker">Step 3 · Behavior</span><h3>What the agent does</h3></div>${icon("bell")}</header>
    <div class="settings-card-v5__body">
      <label class="check-row"><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""}/><span><strong>Agent on</strong><small>Watch Helmsman's health checks and write reports. Without a model it still reports Helmsman's own facts.</small></span></label>
      <h4>Report on</h4>
      ${triggerRow("incidents", "New or worsening problems", "One report and one notification per service outage.")}
      ${triggerRow("recoveries", "Recoveries", "When a service that was down is healthy again.")}
      ${triggerRow("digest", "Daily summary", "A short morning-style summary of the last day.")}
      ${triggerRow("checkIn", "Periodic check-ins", "A quiet look over everything. Notifies only when something needs attention.")}
      <div class="form-grid form-grid--two">
        <label><span>Daily summary time</span><input name="digestTime" type="time" value="${escapeHtml(settings.digestTime || "07:30")}" /></label>
        <label><span>Check-in every (hours)</span><input name="checkInHours" type="number" min="${checkIn.min}" max="${checkIn.max}" value="${Number(settings.checkInHours || checkIn.default)}" /></label>
      </div>
      <label><span>Time zone</span><input name="timeZone" type="text" autocomplete="off" spellcheck="false" placeholder="Region/City, such as Europe/Berlin" value="${escapeHtml(zone)}" />${zone !== localZone ? `<small>This browser is in ${escapeHtml(localZone)}. <button class="agent-text-button" type="button" data-action="agent-use-local-zone" data-zone="${escapeHtml(localZone)}">Use it</button></small>` : ""}</label>
      <div class="button-row"><button class="button button--primary" type="submit">Save behavior</button></div>
      <h4>In this browser</h4>
      ${renderAgentHelperSetting()}
    </div>
  </form>`;
}

function renderAgentNotifyCard(data) {
  const notify = data?.config?.notify;
  return `<form class="glass-panel settings-card-v5" id="agent-notify-form">
    <header><div><span class="section-kicker">Home Assistant</span><h3>Phone notifications</h3></div>${icon("bell")}</header>
    <div class="settings-card-v5__body">
      <p>Reports are sent through a Home Assistant notify action. Notes still appear on the Overview without this.</p>
      <div class="form-grid">
        <label><span>Home Assistant address</span><input name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://homeassistant.local:8123" value="${escapeHtml(notify?.url || "")}" required /><small>Use a local address. Public addresses are refused unless your outbound policy allows public HTTPS.</small></label>
        <label><span>Long-lived access token</span><input name="token" type="password" autocomplete="new-password" placeholder="${notify?.tokenConfigured ? "Saved. Leave empty to keep it" : "Profile → Security → Long-lived access tokens"}" ${notify?.tokenConfigured ? "" : "required"} /></label>
        <label><span>Notify action</span><input name="service" type="text" autocomplete="off" spellcheck="false" placeholder="mobile_app_your_phone" value="${escapeHtml(notify?.service || "")}" required /><small>Find it under Developer tools → Actions by typing notify.mobile_app. Enter the part after notify.</small></label>
        <label><span>Helmsman address <em>optional</em></span><input name="helmsmanUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(location.origin)}" value="${escapeHtml(notify?.helmsmanUrl || "")}" /><small>Tapping a notification opens this page.</small></label>
      </div>
      <p class="agent-test-result" id="agent-notify-test-result" role="status"></p>
      <div class="button-row">
        ${notify ? `<button class="button" type="button" data-action="agent-test-notify">Send test</button>` : ""}
        <button class="button button--primary" type="submit">${notify ? "Save notifications" : "Connect Home Assistant"}</button>
        ${notify ? `<button class="button button--danger" type="button" data-action="agent-remove" data-agent-part="notify">Remove</button>` : ""}
      </div>
    </div>
  </form>`;
}

function renderAgentRulesCard(data) {
  const rules = data?.config?.rules || [];
  const limits = data?.limits || {};
  const minutes = limits.ruleMinutes || { min: 1, max: 120, default: 5 };
  const cooldown = limits.cooldownMinutes || { min: 10, max: 1440, default: 60 };
  const perDay = limits.maxPerDay || { min: 1, max: 10, default: 3 };
  const services = agentRuleServiceOptions();
  const { containers, guests } = agentRuleTargetOptions();
  const autonomy = Boolean(data?.config?.settings?.autonomy);
  const canAdd = services.length && (containers.length || guests.length) && rules.length < Number(limits.rules || 20);
  return `<section class="glass-panel settings-card-v5 agent-rules">
    <header><div><span class="section-kicker">When a service stays down</span><h3>Rules</h3></div>${icon("shield")}</header>
    <div class="settings-card-v5__body">
      <p>A rule restarts or starts one container or guest when a service stays down. Helmsman runs it once per incident, within its cooldown and daily limit, and never more than 10 actions a day across all rules.</p>
      ${autonomy ? "" : `<div class="security-note">${icon("lock")}<div><strong>Rules are paused</strong><span>Turn on “Let rules act” above for them to run.</span></div></div>`}
      ${rules.length ? `<ul class="agent-rule-list">${rules.map((rule) => {
        const sentence = agentRuleSentence(rule);
        return `<li class="${rule.enabled ? "" : "is-disabled"}">
          <div><strong>${escapeHtml(sentence.title)}</strong><small>${escapeHtml(sentence.detail)}</small></div>
          <div class="agent-rule-list__actions">
            <button class="button button--compact" type="button" data-action="agent-rule-toggle" data-rule-id="${escapeHtml(rule.id)}">${rule.enabled ? "Pause" : "Enable"}</button>
            <button class="button button--compact button--danger" type="button" data-action="agent-rule-delete" data-rule-id="${escapeHtml(rule.id)}" aria-label="Delete rule: ${escapeHtml(sentence.title)}">Delete</button>
          </div>
        </li>`;
      }).join("")}</ul>` : ""}
      ${canAdd ? `<form id="agent-rule-form" class="agent-rule-form">
        <h4>New rule</h4>
        <div class="form-grid form-grid--two">
          <label><span>When this service is down</span><select name="service" required>${services.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</select></label>
          <label><span>For at least (minutes)</span><input name="minutes" type="number" min="${minutes.min}" max="${minutes.max}" value="${minutes.default}" required /></label>
          <label><span>Do this</span><select name="operation" required><option value="restart">Restart (containers)</option><option value="start">Start (containers or guests)</option><option value="reboot">Reboot (guests)</option></select></label>
          <label><span>To</span><select name="target" required>
            ${containers.length ? `<optgroup label="Containers">${containers.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</optgroup>` : ""}
            ${guests.length ? `<optgroup label="VMs and LXCs">${guests.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}</optgroup>` : ""}
          </select></label>
          <label><span>Cooldown (minutes)</span><input name="cooldownMinutes" type="number" min="${cooldown.min}" max="${cooldown.max}" value="${cooldown.default}" required /></label>
          <label><span>At most per day</span><input name="maxPerDay" type="number" min="${perDay.min}" max="${perDay.max}" value="${perDay.default}" required /></label>
        </div>
        <p class="form-error" id="agent-rule-error" role="alert"></p>
        <div class="button-row"><button class="button button--primary" type="submit">${icon("plus")} Add rule</button></div>
      </form>` : `<p class="agent-empty">${rules.length >= Number(limits.rules || 20) ? "The rule limit is reached." : "Rules need a monitored service and a Portainer or Proxmox connection to act on."}</p>`}
    </div>
  </section>`;
}

// ------------------------------------------------ saved conversations --

function rememberRating(item) {
  if (!item?.id) return;
  if (item.rating || item.correction) state.agent.ratings.set(item.id, { rating: item.rating || null, correction: item.correction || null });
  else state.agent.ratings.delete(item.id);
  state.agent.ratingVersion += 1;
}

// After a reload, the recent chat comes back from the saved conversations.
async function restoreAgentChat() {
  state.agent.chatRestored = true;
  if (state.agent.chat.length) return;
  try {
    const payload = await api("/api/v2/agent/conversations/chat");
    const items = (Array.isArray(payload?.items) ? payload.items : []).slice(0, 20).reverse();
    if (state.agent.chat.length || !items.length) return;
    for (const item of items) {
      rememberRating(item);
      state.agent.chat.push({ role: "user", content: safeSessionText(item.question, "", 2_000) });
      state.agent.chat.push({ role: "assistant", content: safeSessionText(item.answer, "", 4_000), proposals: [], conversationId: item.id });
    }
    rerenderAgent();
  } catch {
    // The chat simply starts empty.
  }
}

// Good, Bad and Fix answer under a saved answer. A fixed answer is what the
// model should have said; it is the most useful training example there is.
function renderAnswerRating(id, answer) {
  const rating = state.agent.ratings.get(id) || {};
  const editing = state.agent.editingAnswer === id;
  const button = (value, label, iconName) => `<button class="agent-rating__button${rating.rating === value ? " is-active" : ""}" type="button" data-action="agent-rate" data-conversation-id="${escapeHtml(id)}" data-rating="${value}" aria-pressed="${rating.rating === value ? "true" : "false"}" title="${label}">${icon(iconName)}<span>${label}</span></button>`;
  return `<div class="agent-rating">
    <div class="agent-rating__buttons">
      ${button("up", "Good", "check")}
      ${button("down", "Bad", "x")}
      <button class="agent-rating__button${rating.correction ? " is-active" : ""}" type="button" data-action="agent-edit-answer" data-conversation-id="${escapeHtml(id)}" title="Write the answer it should have given">${icon("edit")}<span>${rating.correction ? "Edit fix" : "Fix answer"}</span></button>
    </div>
    ${rating.correction && !editing ? `<p class="agent-rating__correction"><strong>Your answer:</strong> ${escapeHtml(rating.correction)}</p>` : ""}
    ${editing ? `<form class="agent-correction-form" data-conversation-id="${escapeHtml(id)}">
      <label class="sr-only" for="agent-correction-${escapeHtml(id)}">The answer it should have given</label>
      <textarea id="agent-correction-${escapeHtml(id)}" name="correction" rows="3" maxlength="4000">${escapeHtml(rating.correction || answer || "")}</textarea>
      <div class="agent-correction-form__actions">${rating.correction ? `<button class="button button--compact" type="button" data-action="agent-clear-fix" data-conversation-id="${escapeHtml(id)}">Remove fix</button>` : ""}<button class="button button--compact" type="button" data-action="agent-edit-cancel">Cancel</button><button class="button button--compact button--primary" type="submit">Save answer</button></div>
    </form>` : ""}
  </div>`;
}

async function rateConversation(id, body) {
  if (!/^[a-f0-9-]{36}$/u.test(String(id || ""))) return;
  try {
    const updated = await api(`/api/v2/agent/conversations/${id}/rating`, { method: "POST", body });
    rememberRating(updated);
    const item = state.agent.training.items.find((entry) => entry.id === id);
    if (item) Object.assign(item, { rating: updated.rating, correction: updated.correction });
    if (body.correction !== undefined) state.agent.editingAnswer = "";
    if (state.agent.training.loaded) void loadTraining({ render: false });
  } catch (error) {
    showToast(error?.message || "That rating could not be saved.", "danger");
  }
  rerenderAgent();
}

async function loadTraining({ render = true } = {}) {
  const training = state.agent.training;
  if (training.loading || !state.status?.authenticated) return;
  training.loading = true;
  try {
    const payload = await api("/api/v2/agent/conversations");
    training.status = payload?.status || null;
    training.items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of training.items) rememberRating(item);
    training.error = "";
  } catch (error) {
    training.error = safeSessionText(error?.message, "Saved conversations could not be read.", 200);
  } finally {
    training.loading = false;
    training.loaded = true;
    if (render && currentRoute() === "settings") rerenderAgent();
  }
}

async function saveTrainingSettings(form) {
  const keep = form.querySelector("input[name='keep']")?.checked === true;
  const reports = form.querySelector("input[name='reports']")?.checked === true;
  state.agent.training.busy = "settings";
  rerenderAgent();
  try {
    const payload = await api("/api/v2/agent/conversations/settings", { method: "PUT", body: { keep, reports } });
    state.agent.training.status = payload?.status || state.agent.training.status;
    showToast(keep ? "Conversations are being saved for training." : "Conversations are no longer saved.", "success");
    await loadAgent();
  } catch (error) {
    showToast(error?.message || "That setting could not be saved.", "danger");
  } finally {
    state.agent.training.busy = "";
    rerenderAgent();
  }
}

async function deleteTraining() {
  if (!(await confirmAgentChange("Every saved conversation, rating and fixed answer is deleted. Training files you already downloaded are not affected.", { title: "Delete all saved conversations?", confirmLabel: "Delete all" }))) return;
  try {
    await api("/api/v2/agent/conversations", { method: "DELETE" });
    state.agent.ratings.clear();
    state.agent.ratingVersion += 1;
    for (const message of state.agent.chat) delete message.conversationId;
    showToast("Saved conversations deleted.", "success");
  } catch (error) {
    showToast(error?.message || "They could not be deleted.", "danger");
  }
  await loadTraining();
}

function renderAgentTrainingCard(data) {
  const training = state.agent.training;
  if (!training.loaded && !training.loading) void loadTraining();
  const policy = data.config?.conversations || { keep: false, reports: true };
  const status = training.status;
  const usable = status ? status.ratedUp + status.corrected : 0;
  const size = status ? formatMetricBytes(status.bytes) : "";
  const items = training.items.slice(0, 12);
  return `<section class="glass-panel settings-card-v5 agent-training-card">
    <header><div><span class="section-kicker">Your own model</span><h3>Training data</h3></div>${icon("book")}</header>
    <div class="settings-card-v5__body">
      <form id="agent-conversations-form" class="agent-training-form">
        <label class="check-row"><input name="keep" type="checkbox" ${policy.keep ? "checked" : ""}/><span><strong>Keep conversations for training</strong><small>Saves each chat answer with everything the model was shown, so you can rate it and export training data. Secrets are scrubbed first. Stored only on this server, for 90 days or 100 MB.</small></span></label>
        <label class="check-row"><input name="reports" type="checkbox" ${policy.reports ? "checked" : ""}/><span><strong>Include reports</strong><small>Also save incident notes, recoveries and summaries, not just chat.</small></span></label>
        <div class="button-row"><button class="button button--primary" type="submit" ${training.busy ? "disabled" : ""}>Save</button></div>
      </form>
      ${status ? `<dl class="agent-facts">
        <div><dt>Saved</dt><dd>${status.conversations.toLocaleString()} conversation${status.conversations === 1 ? "" : "s"}${status.conversations ? ` · ${escapeHtml(size)}` : ""}</dd></div>
        <div><dt>Rated</dt><dd>${status.ratedUp} good · ${status.ratedDown} bad · ${status.corrected} fixed</dd></div>
        <div><dt>Ready to train on</dt><dd>${usable}</dd></div>
      </dl>` : training.error ? `<p class="form-error">${escapeHtml(training.error)}</p>` : `<p class="agent-empty">Loading…</p>`}
      <p class="agent-voice__hint">Rate answers with Good or Bad, or use Fix answer to write what it should have said. The download includes good and fixed answers, ready for the training script; aim for a few hundred before training.</p>
      <div class="button-row">
        <a class="button button--compact${usable ? "" : " is-disabled"}" href="/api/v2/agent/conversations/export/rated" download ${usable ? "" : "aria-disabled=\"true\" tabindex=\"-1\""}>${icon("download")} Download good and fixed (${usable})</a>
        <a class="button button--compact${status?.conversations ? "" : " is-disabled"}" href="/api/v2/agent/conversations/export/all" download ${status?.conversations ? "" : "aria-disabled=\"true\" tabindex=\"-1\""}>${icon("download")} Everything not rated bad</a>
        <button class="button button--compact button--danger" type="button" data-action="agent-training-delete" ${status?.conversations ? "" : "disabled"}>Delete all</button>
      </div>
      ${items.length ? `<h4>Latest answers</h4><ul class="agent-training-list">${items.map((item) => `<li>
        <div class="agent-training-list__head"><span class="agent-training-list__source">${escapeHtml(item.source === "question" ? "Chat" : AGENT_NOTE_LABELS[item.source] || "Report")}</span><time datetime="${escapeHtml(item.at)}">${escapeHtml(agentNoteTime(item.at))}</time></div>
        ${item.question && item.source === "question" ? `<p class="agent-training-list__question">${escapeHtml(item.question)}</p>` : ""}
        <p class="agent-training-list__answer">${escapeHtml(item.answer)}</p>
        ${renderAnswerRating(item.id, item.answer)}
      </li>`).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function renderAgentSettings() {
  if (!state.agent.loaded) {
    return `<section class="agent-settings"><div class="empty-state"><span>Loading agent settings…</span></div></section>`;
  }
  const data = agentData();
  if (!data) {
    return `<section class="agent-settings"><div class="empty-state"><strong>Agent unavailable</strong><span>${escapeHtml(state.agent.error || "The agent could not be reached.")}</span></div></section>`;
  }
  const status = agentStatus(data);
  return `<section class="agent-settings" aria-labelledby="agent-settings-title">
    <header class="detail-hero"><div><span class="section-kicker">Local AI</span><h2 id="agent-settings-title">Agent</h2><p>An assistant that runs on your own hardware. It watches Helmsman's health checks, explains problems, and only changes things through rules you write or actions you approve.</p></div><span class="system-service-state is-${status.tone}"><i class="health-dot is-${status.tone}"></i>${escapeHtml(status.label)}</span></header>
    ${data.status?.configurationProblem ? `<div class="security-note">${icon("lock")}<div><strong>The saved agent settings could not be read</strong><span>${escapeHtml(String(data.status.configurationProblem))}. Saving any card below replaces them.</span></div></div>` : ""}
    ${renderAgentSetupSteps(data)}
    <div class="settings-grid-v5">
      ${renderAgentModelCard(data)}
      ${renderAgentVoiceCard(data)}
      ${renderAgentBehaviorCard(data)}
      ${renderAgentTrainingCard(data)}
    </div>
  </section>`;
}

function renderAgentUnavailable(kind) {
  if (!state.agent.loaded) return `<section class="agent-settings"><div class="empty-state"><span>Loading ${kind}…</span></div></section>`;
  return `<section class="agent-settings"><div class="empty-state"><strong>Agent unavailable</strong><span>${escapeHtml(state.agent.error || "The agent could not be reached.")}</span></div></section>`;
}

function renderAgentNotificationsTab() {
  const data = agentData();
  if (!data) return renderAgentUnavailable("notification settings");
  const triggers = data.config?.settings?.triggers || {};
  const enabled = Boolean(data.config?.settings?.enabled);
  const sent = [
    [triggers.incidents !== false, "New or worsening problems", "One notification per service outage."],
    [triggers.recoveries !== false, "Recoveries", "When a service that was down is healthy again."],
    [triggers.digest !== false, "Daily summary", `At ${escapeHtml(data.config?.settings?.digestTime || "07:30")} in ${escapeHtml(data.config?.settings?.timeZone || "UTC")}.`],
    [triggers.checkIn !== false, "Check-ins", "Only when something needs attention."],
    [Boolean(data.config?.downloads?.enabled), "Stuck downloads", "Each one, with an Approve button, or what was cleared automatically."],
    [Boolean(data.config?.indexers?.enabled), "Failing indexers", "Only after the agent's retests also fail."],
    [true, "Automatic actions", "Repeat container restarts, giving up on a container, and failed actions."]
  ];
  return `<section class="agent-settings" aria-labelledby="agent-notifications-title">
    <header class="detail-hero"><div><span class="section-kicker">Agent</span><h2 id="agent-notifications-title">Notifications</h2><p>Where the agent's reports go besides the Overview.</p></div></header>
    <div class="settings-grid-v5">
      ${renderAgentNotifyCard(data)}
      <section class="glass-panel settings-card-v5">
        <header><div><span class="section-kicker">Sent to your phone</span><h3>What you'll hear about</h3></div>${icon("bell")}</header>
        <div class="settings-card-v5__body">
          ${enabled ? "" : `<div class="security-note">${icon("lock")}<div><strong>The agent is off</strong><span>Nothing is sent until it's turned on under Agent.</span></div></div>`}
          <ul class="agent-sent-list">${sent.map(([on, title, detail]) => `<li class="${on ? "" : "is-off"}"><i class="health-dot is-${on ? "healthy" : "disabled"}" aria-hidden="true"></i><div><strong>${title}</strong><small>${on ? detail : "Off"}</small></div></li>`).join("")}</ul>
          <div class="button-row"><button class="button button--compact" type="button" data-action="settings-tab" data-settings-tab="agent">Change what's reported</button></div>
        </div>
      </section>
    </div>
  </section>`;
}

function renderAgentAutonomyCard(data) {
  const settings = data.config?.settings || {};
  const today = Number(data.status?.automaticActionsToday || 0);
  return `<form class="glass-panel settings-card-v5" id="agent-autonomy-form">
    <header><div><span class="section-kicker">Master switch</span><h3>Automatic actions</h3></div>${icon("shield")}</header>
    <div class="settings-card-v5__body">
      <label class="check-row agent-autonomy"><input name="autonomy" type="checkbox" ${settings.autonomy ? "checked" : ""}/><span><strong>Let rules act</strong><small>Container health restarts and the rules below run only while this is on. Everything the model suggests still waits for your approval.</small></span></label>
      <dl class="agent-facts"><div><dt>Automatic actions in the last 24 hours</dt><dd>${today} of 10</dd></div></dl>
      <p class="agent-voice__hint">All automatic actions together stop at 10 a day, whatever each rule allows.</p>
      <div class="button-row"><button class="button button--primary" type="submit">Save</button></div>
    </div>
  </form>`;
}

const RISKY_CONTAINER = /portainer|helmsman|postgres|mariadb|mysql|mongo|redis|valkey|influx|home-?assistant|hass|traefik|nginx-proxy|caddy|authentik|vaultwarden|unifi/iu;

function renderAgentHealthCard(data) {
  const policy = data.config?.containerHealth || { enabled: false, scope: "all", containers: [], minutes: 3, repeatCount: 3, repeatHours: 24 };
  const limits = data.limits || {};
  const minutes = limits.healthMinutes || { min: 1, max: 60 };
  const repeat = limits.repeatCount || { min: 2, max: 10 };
  const hours = limits.repeatHours || { min: 1, max: 168 };
  const inventory = new Map();
  for (const server of state.snapshot?.infrastructure?.portainer || []) {
    for (const container of server.inventory?.containers || []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(container.name)) continue;
      const entry = inventory.get(container.name) || { name: container.name, unhealthy: false, image: container.image };
      entry.unhealthy ||= container.health === "unhealthy";
      inventory.set(container.name, entry);
    }
  }
  for (const name of policy.containers) if (!inventory.has(name)) inventory.set(name, { name, unhealthy: false, missing: true });
  const names = [...inventory.values()].sort((left, right) => left.name.localeCompare(right.name));
  // Before the first save, suggest leaving databases and core services alone.
  const firstTime = !policy.enabled && !policy.containers.length && policy.scope === "all";
  const picked = (entry) => (firstTime ? RISKY_CONTAINER.test(`${entry.name} ${entry.image || ""}`) : policy.containers.includes(entry.name));
  const seen = data.containerHealth || [];
  return `<form class="glass-panel settings-card-v5 agent-health" id="agent-health-form">
    <header><div><span class="section-kicker">Docker health checks</span><h3>Unhealthy containers</h3></div>${icon("containers")}</header>
    <div class="settings-card-v5__body">
      <p>When a container's health check fails, Helmsman restarts it. If it keeps going unhealthy, Helmsman stops restarting it and tells you instead.</p>
      <label class="check-row"><input name="enabled" type="checkbox" ${policy.enabled ? "checked" : ""}/><span><strong>Restart unhealthy containers</strong><small>Needs “Let rules act”. With it off, you're told about unhealthy containers but nothing is restarted.</small></span></label>
      <div class="form-grid form-grid--two">
        <label><span>Wait before restarting (minutes)</span><input name="minutes" type="number" min="${minutes.min}" max="${minutes.max}" value="${Number(policy.minutes)}" required /><small>Some containers report unhealthy briefly while starting.</small></label>
        <label><span>Give up after (times)</span><input name="repeatCount" type="number" min="${repeat.min}" max="${repeat.max}" value="${Number(policy.repeatCount)}" required /><small>Unhealthy this many times within the window below.</small></label>
        <label><span>Within (hours)</span><input name="repeatHours" type="number" min="${hours.min}" max="${hours.max}" value="${Number(policy.repeatHours)}" required /></label>
      </div>
      <fieldset class="agent-health__scope">
        <legend>Which containers</legend>
        <label class="agent-radio"><input type="radio" name="scope" value="all" ${policy.scope === "all" ? "checked" : ""}/> All except the ones ticked below</label>
        <label class="agent-radio"><input type="radio" name="scope" value="only" ${policy.scope === "only" ? "checked" : ""}/> Only the ones ticked below</label>
      </fieldset>
      ${names.length ? `<div class="agent-health__list" role="group" aria-label="Containers">${names.map((entry) => `<label class="agent-health__item"><input type="checkbox" name="containers" value="${escapeHtml(entry.name)}" ${picked(entry) ? "checked" : ""}/><span>${escapeHtml(entry.name)}</span>${entry.unhealthy ? `<em class="is-bad">unhealthy</em>` : entry.missing ? `<em>not found</em>` : ""}</label>`).join("")}</div>` : `<p class="agent-empty">Connect Portainer to choose containers.</p>`}
      ${firstTime && names.some(picked) ? `<p class="agent-voice__hint">Databases, Portainer, Helmsman and similar core services are ticked to be left alone. Change it if you like.</p>` : ""}
      ${seen.length ? `<h4>This week</h4><ul class="agent-health__seen">${seen.map((entry) => `<li><i class="health-dot is-${entry.gaveUp ? "down" : entry.unhealthyNow ? "degraded" : "limited"}" aria-hidden="true"></i><div><strong>${escapeHtml(entry.name)}${entry.server ? ` <small>${escapeHtml(entry.server)}</small>` : ""}</strong><small>Unhealthy ${entry.episodes} time${entry.episodes === 1 ? "" : "s"} · restarted ${entry.restarts}${entry.gaveUp ? " · stopped restarting, needs you" : entry.unhealthyNow ? " · unhealthy now" : ""}</small></div></li>`).join("")}</ul>` : ""}
      <div class="button-row"><button class="button button--primary" type="submit">Save</button></div>
    </div>
  </form>`;
}

const STUCK_KIND_LABELS = Object.freeze({ stalled: "Stalled", failed: "Failed", import: "Import blocked" });

function renderAgentDownloadsCard(data) {
  const policy = data.config?.downloads || { enabled: false, minutes: 60, automatic: false };
  const limits = data.limits?.stuckMinutes || { min: 10, max: 1440 };
  const stuck = data.downloads || [];
  const connected = (state.snapshot?.services || []).some((service) => ["radarr", "sonarr"].includes(service.id) && service.connectionState === "connected");
  return `<form class="glass-panel settings-card-v5 agent-downloads" id="agent-downloads-form">
    <header><div><span class="section-kicker">Radarr and Sonarr queues</span><h3>Stuck downloads</h3></div>${icon("download")}</header>
    <div class="settings-card-v5__body">
      <p>When a download stays stalled, failed or blocked from importing, Helmsman offers to remove it, blocklist that release and search for another, the same as the "Block release &amp; search again" button.</p>
      ${connected ? "" : `<div class="security-note">${icon("link")}<div><strong>Radarr or Sonarr isn't connected</strong><span>Connect one under Media → Connections for this to have anything to watch.</span></div></div>`}
      <label class="check-row"><input name="enabled" type="checkbox" ${policy.enabled ? "checked" : ""}/><span><strong>Watch for stuck downloads</strong><small>You get a notification and an Approve button for each one.</small></span></label>
      <label><span>Stuck for at least (minutes)</span><input name="minutes" type="number" min="${limits.min}" max="${limits.max}" value="${Number(policy.minutes)}" required /><small>Stalled torrents sometimes recover on their own, so give them a while.</small></label>
      <label class="check-row"><input name="automatic" type="checkbox" ${policy.automatic ? "checked" : ""}/><span><strong>Clear stalled and failed downloads by myself</strong><small>Needs “Let rules act”. Blocked imports always ask first, since the file may be fine and only need a manual import.</small></span></label>
      ${policy.enabled ? `<h4>Right now</h4>${stuck.length ? `<ul class="agent-health__seen">${stuck.map((item) => `<li><i class="health-dot is-${item.kind === "import" ? "limited" : "degraded"}" aria-hidden="true"></i><div><strong>${escapeHtml(item.title)} <small>${escapeHtml(item.service === "radarr" ? "Radarr" : "Sonarr")} · ${escapeHtml(STUCK_KIND_LABELS[item.kind] || "Stuck")}</small></strong><small>${escapeHtml(item.message || "")}</small><small>${item.pendingApproval ? "Waiting for your approval on the Overview" : item.waitingMinutes > 0 ? `Stuck ${item.stuckMinutes} min · Helmsman acts after ${item.waitingMinutes} more` : `Stuck ${item.stuckMinutes} min`}</small></div></li>`).join("")}</ul>` : `<p class="agent-empty">Nothing is stuck.</p>`}` : ""}
      <div class="button-row"><button class="button button--primary" type="submit">Save</button></div>
    </div>
  </form>`;
}

async function submitAgentDownloads(form) {
  const data = new FormData(form);
  const body = {
    enabled: data.get("enabled") === "on",
    minutes: Number(String(data.get("minutes") || "").trim()),
    automatic: data.get("automatic") === "on"
  };
  const autonomy = Boolean(agentData()?.config?.settings?.autonomy);
  await agentMutation("/downloads", "PUT", body, body.automatic && !autonomy
    ? "Saved. Turn on “Let rules act” for automatic clean-up; until then each one asks first."
    : "Stuck downloads saved.");
}

function renderAgentAutomationTab() {
  const data = agentData();
  if (!data) return renderAgentUnavailable("automation settings");
  return `<section class="agent-settings" aria-labelledby="agent-automation-title">
    <header class="detail-hero"><div><span class="section-kicker">Agent</span><h2 id="agent-automation-title">Automation</h2><p>What Helmsman may fix by itself. The model never acts on its own: these are checked and run by Helmsman's code, within limits you set.</p></div></header>
    <div class="settings-grid-v5">
      ${renderAgentAutonomyCard(data)}
      ${renderAgentHealthCard(data)}
      ${renderAgentDownloadsCard(data)}
      ${renderAgentIndexersCard(data)}
      ${renderAgentRulesCard(data)}
    </div>
  </section>`;
}

// Actions ------------------------------------------------------------

function agentFormNumber(form, name) {
  const raw = String(new FormData(form).get(name) ?? "").trim();
  return raw === "" ? undefined : Number(raw);
}

function agentFormText(form, name) {
  return String(new FormData(form).get(name) ?? "").trim();
}

function setAgentTestResult(id, tone, message) {
  const element = document.getElementById(id);
  if (!element) return;
  element.className = `agent-test-result is-${tone}`;
  element.textContent = message;
}

async function agentMutation(path, method, body, successMessage) {
  try {
    state.agent.data = await api(`/api/v2/agent${path}`, { method, body });
    state.agent.error = "";
    if (successMessage) showToast(successMessage, "success");
    rerenderAgent();
    return true;
  } catch (error) {
    if (error?.status === 401) await initialize();
    else showToast(error?.message || "That change could not be saved.", "danger");
    return false;
  }
}

async function testAgentModel(button) {
  const form = button.closest("form");
  if (!form || button.disabled) return;
  const url = agentFormText(form, "url");
  if (!url) {
    setAgentTestResult("agent-ai-test-result", "degraded", "Enter the server address first.");
    return;
  }
  const body = { url };
  const model = agentFormText(form, "model");
  const apiKey = String(new FormData(form).get("apiKey") || "");
  if (model) body.model = model;
  if (apiKey) {
    body.apiKey = apiKey;
    body.authMode = "bearer";
  }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setAgentTestResult("agent-ai-test-result", "stale", "Testing…");
  try {
    const result = await api("/api/v2/agent/ai/test", { method: "POST", body });
    const models = Array.isArray(result?.models) ? result.models : [];
    const list = document.getElementById("agent-model-options");
    if (list) list.replaceChildren(...models.map((name) => Object.assign(document.createElement("option"), { value: name })));
    if (!models.length) setAgentTestResult("agent-ai-test-result", "limited", "Connected, but the server lists no models. Download one on the server first.");
    else if (result.model && !result.modelAvailable) setAgentTestResult("agent-ai-test-result", "limited", `Connected. The server does not have “${result.model}”. It has: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`);
    else if (result.model) setAgentTestResult("agent-ai-test-result", "healthy", `Connected in ${Number(result.latencyMs) || 0} ms. “${result.model}” is available.`);
    else {
      const input = form.querySelector("input[name='model']");
      if (input && models.length === 1) input.value = models[0];
      setAgentTestResult("agent-ai-test-result", "healthy", `Connected. Pick a model: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`);
    }
  } catch (error) {
    if (error?.status === 401) await initialize();
    else setAgentTestResult("agent-ai-test-result", "degraded", error?.message || "The model server could not be reached.");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function submitAgentModel(form) {
  const body = {
    url: agentFormText(form, "url"),
    model: agentFormText(form, "model")
  };
  const contextTokens = agentFormNumber(form, "contextTokens");
  const timeoutSeconds = agentFormNumber(form, "timeoutSeconds");
  if (contextTokens !== undefined) body.contextTokens = contextTokens;
  if (timeoutSeconds !== undefined) body.timeoutSeconds = timeoutSeconds;
  const apiKey = String(new FormData(form).get("apiKey") || "");
  if (apiKey) {
    body.apiKey = apiKey;
    body.authMode = "bearer";
  } else if (new FormData(form).get("clearApiKey")) {
    body.clearApiKey = true;
    body.authMode = "none";
  }
  const firstConnection = !agentData()?.config?.ai;
  const saved = await agentMutation("/ai", "PUT", body, "Model saved.");
  // A first connection also switches the agent on, which is what setting
  // it up means; the behavior card can turn it off again.
  if (saved && firstConnection && !agentData()?.config?.settings?.enabled) {
    await agentMutation("/settings", "PUT", { enabled: true, timeZone: browserTimeZone() }, "");
  }
}

async function submitAgentSettings(form) {
  const data = new FormData(form);
  const body = {
    enabled: data.get("enabled") === "on",
    triggers: {
      incidents: data.get("incidents") === "on",
      recoveries: data.get("recoveries") === "on",
      digest: data.get("digest") === "on",
      checkIn: data.get("checkIn") === "on"
    },
    digestTime: agentFormText(form, "digestTime") || "07:30",
    timeZone: agentFormText(form, "timeZone") || browserTimeZone()
  };
  const checkInHours = agentFormNumber(form, "checkInHours");
  if (checkInHours !== undefined) body.checkInHours = checkInHours;
  await agentMutation("/settings", "PUT", body, "Agent behavior saved.");
}

async function submitAgentAutonomy(form) {
  const autonomy = new FormData(form).get("autonomy") === "on";
  await agentMutation("/settings", "PUT", { autonomy }, autonomy ? "Automatic actions on." : "Automatic actions off. Nothing runs by itself.");
}

async function submitAgentHealth(form) {
  const data = new FormData(form);
  const number = (name) => Number(String(data.get(name) || "").trim());
  const body = {
    enabled: data.get("enabled") === "on",
    scope: data.get("scope") === "only" ? "only" : "all",
    containers: data.getAll("containers").map(String),
    minutes: number("minutes"),
    repeatCount: number("repeatCount"),
    repeatHours: number("repeatHours")
  };
  const autonomy = Boolean(agentData()?.config?.settings?.autonomy);
  await agentMutation("/container-health", "PUT", body, body.enabled && !autonomy
    ? "Saved. Turn on “Let rules act” for restarts to happen; until then you're only told."
    : "Container health saved.");
}

async function submitAgentNotify(form) {
  const body = {
    url: agentFormText(form, "url"),
    service: agentFormText(form, "service").replace(/^notify\./u, ""),
    helmsmanUrl: agentFormText(form, "helmsmanUrl")
  };
  const token = String(new FormData(form).get("token") || "").trim();
  if (token) body.token = token;
  await agentMutation("/notify", "PUT", body, "Notifications saved. Send a test to check them.");
}

async function testAgentNotify(button) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setAgentTestResult("agent-notify-test-result", "stale", "Sending…");
  try {
    await api("/api/v2/agent/notify/test", { method: "POST", body: {} });
    setAgentTestResult("agent-notify-test-result", "healthy", "Sent. Check your phone.");
  } catch (error) {
    if (error?.status === 401) await initialize();
    else setAgentTestResult("agent-notify-test-result", "degraded", error?.message || "The notification could not be sent.");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function removeAgentPart(part) {
  if (!["ai", "notify"].includes(part)) return;
  const label = part === "ai" ? "Disconnect the model server? The agent keeps reporting Helmsman's own facts." : "Remove phone notifications? The saved token is deleted.";
  if (!(await confirmAgentChange(label, { confirmLabel: part === "ai" ? "Disconnect" : "Remove" }))) return;
  await agentMutation(`/${part}`, "DELETE", undefined, part === "ai" ? "Model disconnected." : "Notifications removed.");
}

function confirmAgentChange(message, { title = "Confirm change", confirmLabel = "Continue", tone = "danger" } = {}) {
  return confirmControl({ title, message, confirmLabel, tone });
}

function agentRuleId(service, target) {
  const base = `${service}-${target}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 38) || "rule";
  const existing = new Set((agentData()?.config?.rules || []).map(({ id }) => id));
  let id = base;
  for (let index = 2; existing.has(id); index += 1) id = `${base}-${index}`.slice(0, 48);
  return /^[a-z0-9]/u.test(id) ? id : `r-${id}`.slice(0, 48);
}

async function submitAgentRule(form) {
  const error = form.querySelector("#agent-rule-error");
  const fail = (message) => {
    if (error) error.textContent = message;
  };
  const [kind, connectionId, name] = agentFormText(form, "target").split("|");
  const operation = agentFormText(form, "operation");
  const service = agentFormText(form, "service");
  if (kind === "container" && !["restart", "start"].includes(operation)) return fail("Containers can be restarted or started.");
  if (kind === "guest" && !["start", "reboot"].includes(operation)) return fail("VMs and LXCs can be started or rebooted.");
  if (!["container", "guest"].includes(kind) || !connectionId || !name) return fail("Choose what the rule acts on.");
  const rule = {
    id: agentRuleId(service, name),
    enabled: true,
    when: { service, minutes: agentFormNumber(form, "minutes") },
    then: kind === "container"
      ? { kind, serviceId: connectionId, containerName: name, operation }
      : { kind, environmentId: connectionId, vmid: Number(name), operation },
    cooldownMinutes: agentFormNumber(form, "cooldownMinutes"),
    maxPerDay: agentFormNumber(form, "maxPerDay")
  };
  const rules = [...(agentData()?.config?.rules || []), rule];
  await agentMutation("/rules", "PUT", { rules }, agentData()?.config?.settings?.autonomy ? "Rule added." : "Rule added. Turn on “Let rules act” for it to run.");
}

async function changeAgentRule(ruleId, change) {
  const rules = agentData()?.config?.rules || [];
  if (!rules.some(({ id }) => id === ruleId)) return;
  if (change === "delete" && !(await confirmAgentChange("Helmsman stops using this rule immediately.", { title: "Delete this rule?", confirmLabel: "Delete rule" }))) return;
  const next = change === "delete"
    ? rules.filter(({ id }) => id !== ruleId)
    : rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule));
  await agentMutation("/rules", "PUT", { rules: next }, change === "delete" ? "Rule deleted." : "Rule updated.");
}

async function decideAgentProposal(button) {
  const id = String(button.dataset.proposalId || "");
  const decision = button.dataset.decision === "approve" ? "approve" : "decline";
  if (!/^[a-f0-9-]{36}$/u.test(id) || state.agent.busy) return;
  const proposal = (agentData()?.proposals || []).find((candidate) => candidate.id === id);
  const label = `${AGENT_OPERATION_LABELS[proposal?.operation] || "Run"} ${proposal?.target || "this target"}`.toLowerCase().replace(/^./u, (letter) => letter.toUpperCase());
  // Approve is the confirmation for starting and restarting. Actions that
  // take something offline get a second, explicit check.
  if (decision === "approve" && ["stop", "shutdown", "reboot", "blocklistAndSearch"].includes(proposal?.operation)) {
    const confirmed = await confirmAgentChange(`${proposal?.reason ? `${proposal.reason} ` : ""}Helmsman checks the target again before it runs.`, { title: `${label}?`, confirmLabel: label, tone: "danger" });
    if (!confirmed) return;
  }
  state.agent.busy = id;
  rerenderAgent();
  try {
    const result = await api(`/api/v2/agent/proposals/${id}`, { method: "POST", body: { decision } });
    state.agent.decisions.set(id, { status: result?.status || (decision === "approve" ? "approved" : "declined"), outcome: safeSessionText(result?.outcome, "", 200), label });
    showToast(decision === "approve" ? `${label}: done.` : "Declined.", "success");
    if (decision === "approve") helmyReact("celebrate");
  } catch (error) {
    if (error?.status === 401) await initialize();
    else {
      state.agent.decisions.set(id, { status: "failed", outcome: safeSessionText(error?.message, "the action failed.", 200), label });
      showToast(error?.message || "That decision could not be saved.", "danger");
    }
  } finally {
    state.agent.busy = "";
    await loadAgent();
    rerenderAgent();
  }
}

async function runAgentJob(job) {
  if (!["digest", "checkIn"].includes(job) || state.agent.busy) return;
  state.agent.busy = job;
  rerenderAgent();
  try {
    await api("/api/v2/agent/run", { method: "POST", body: { job } });
  } catch (error) {
    if (error?.status === 401) await initialize();
    else showToast(error?.message || "The agent could not write a summary.", "danger");
  } finally {
    state.agent.busy = "";
    await loadAgent();
    rerenderAgent();
  }
}

async function askAgent(source = "page") {
  const fromHelper = source === "helper";
  const question = (fromHelper ? state.agent.helperDraft : state.agent.draft).trim().slice(0, AGENT_QUESTION_LIMIT);
  if (!question || state.agent.asking) return;
  const history = state.agent.chat
    .filter((message) => !message.error)
    .slice(-AGENT_CHAT_LIMIT)
    .map(({ role, content }) => ({ role, content: content.slice(0, 1_500) }));
  state.agent.chat.push({ role: "user", content: question });
  if (fromHelper) {
    state.agent.helperDraft = "";
    const helperInput = document.getElementById("agent-helper-input");
    if (helperInput) helperInput.value = "";
  }
  else state.agent.draft = "";
  state.agent.asking = true;
  rerenderAgent();
  try {
    const result = await api("/api/v2/agent/ask", { method: "POST", body: { question, history } });
    // Keep the ids of any requests this answer made, so they show under it.
    const proposalIds = (Array.isArray(result?.proposals) ? result.proposals : [])
      .map((proposal) => (typeof proposal === "string" ? proposal : proposal?.id))
      .filter((id) => typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id));
    const conversationId = typeof result?.conversationId === "string" && /^[a-f0-9-]{36}$/u.test(result.conversationId) ? result.conversationId : null;
    state.agent.chat.push({ role: "assistant", content: String(result?.answer || "No answer."), proposals: proposalIds, conversationId });
    helmyReact("nod");
    if (result?.proposals?.length) await loadAgent();
  } catch (error) {
    if (error?.status === 401) {
      await initialize();
      return;
    }
    state.agent.chat.push({ role: "assistant", content: error?.message || "The agent could not answer.", error: true });
  } finally {
    state.agent.asking = false;
    state.agent.chat = state.agent.chat.slice(-AGENT_CHAT_LIMIT * 2);
    rerenderAgent();
    document.getElementById(fromHelper ? "agent-helper-input" : "agent-ask-input")?.focus({ preventScroll: true });
  }
}

// Floating agent helper ------------------------------------------------
// A small character that floats over every page. Drag it anywhere; click
// it and it glides to the right edge and opens a mini chat beside itself.
// It lives outside #main-content, so page renders never replace it. Each
// browser can turn it off; the choice is a local display preference only.

const AGENT_HELPER_KEY = "helmsman.agentHelper";
const AGENT_HELPER_HOME_KEY = "helmsman.agentHelperHome";
const AGENT_HELPER_SEEN_KEY = "helmsman.agentHelperSeenNote";
const AGENT_HELPER_MARGIN = 16;

const helper = {
  root: null,
  buddy: null,
  panel: null,
  bubble: null,
  open: false,
  x: 0,
  y: 0,
  home: null,
  drag: null,
  suppressClick: false,
  wanderTimer: 0,
  bubbleTimer: 0,
  renderedKey: "",
  announcedNote: "",
  baselineNote: undefined,
  // The live 3D Helmy, once loaded; the flat image stays as the fallback.
  helmy: null,
  helmyLoad: null,
  onPointer: null
};

const HELMY_MODEL_URL = "./assets/helmy/helmy.glb";

// Loads the 3D helper in the background. Any failure (no WebGL, an old
// browser, a blocked file) leaves the flat picture in place.
function loadHelmy() {
  if (!helper.root || helper.helmy || helper.helmyLoad) return;
  const root = helper.root;
  const container = root.querySelector(".agent-helper__float");
  helper.helmyLoad = import("./ui/agent-helper-3d.js")
    .then(async ({ createHelmy, helmySupported }) => {
      if (!helmySupported()) return;
      const controller = await createHelmy({ container, modelUrl: HELMY_MODEL_URL, reducedMotion: helperReducedMotion() });
      if (helper.root !== root) {
        controller.destroy();
        return;
      }
      controller.onLost = () => {
        if (helper.helmy === controller) helper.helmy = null;
        root.classList.remove("has-3d");
      };
      helper.helmy = controller;
      root.classList.add("has-3d");
      controller.mood(helperMood());
    })
    .catch(() => {
      // The picture is already showing; nothing else to do.
    })
    .finally(() => {
      if (helper.root === root) helper.helmyLoad = null;
    });
}

function helperMood() {
  if (state.agent.asking) return "thinking";
  if (helper.open) return "chat";
  const open = state.snapshot?.incidents?.open;
  return Array.isArray(open) && open.length ? "alert" : "idle";
}

function helmyReact(name) {
  helper.helmy?.react(name);
}

function readHelperStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeHelperStorage(key, value) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage may be blocked; the helper still works for this visit.
  }
}

function agentHelperEnabled() {
  return readHelperStorage(AGENT_HELPER_KEY) !== "off";
}

function helperReducedMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function helperSize() {
  const rect = helper.buddy?.getBoundingClientRect?.();
  return { width: rect?.width || 96, height: rect?.height || 88 };
}

function helperViewport() {
  return { width: globalThis.innerWidth || 1280, height: globalThis.innerHeight || 800 };
}

// Space taken by the phone tab bar at the bottom, when it is showing.
function helperBottomInset() {
  const nav = document.querySelector(".mobile-nav");
  const rect = nav?.getBoundingClientRect?.();
  if (!rect || !rect.height || getComputedStyle(nav).display === "none") return 0;
  return Math.max(0, helperViewport().height - rect.top);
}

function clampHelper(x, y) {
  const { width, height } = helperSize();
  const viewport = helperViewport();
  const bottom = viewport.height - height - AGENT_HELPER_MARGIN - helperBottomInset();
  return {
    x: Math.min(Math.max(AGENT_HELPER_MARGIN, x), Math.max(AGENT_HELPER_MARGIN, viewport.width - width - AGENT_HELPER_MARGIN)),
    y: Math.min(Math.max(AGENT_HELPER_MARGIN + 56, y), Math.max(AGENT_HELPER_MARGIN, bottom))
  };
}

// Out of the way by default: tucked into the bottom-right corner. Pages leave
// room at their end (body.has-agent-helper) so the last row can scroll clear.
function helperDefaultHome() {
  return helperDockPosition();
}

// The home position is saved as fractions of the window, so it stays in a
// sensible place when the window is resized.
function loadHelperHome() {
  try {
    const saved = JSON.parse(readHelperStorage(AGENT_HELPER_HOME_KEY) || "null");
    if (saved && Number.isFinite(saved.fx) && Number.isFinite(saved.fy)) {
      const viewport = helperViewport();
      return clampHelper(saved.fx * viewport.width, saved.fy * viewport.height);
    }
  } catch {
    // Fall back to the default corner.
  }
  const fallback = helperDefaultHome();
  return clampHelper(fallback.x, fallback.y);
}

function saveHelperHome() {
  if (!helper.home) return;
  const viewport = helperViewport();
  writeHelperStorage(AGENT_HELPER_HOME_KEY, JSON.stringify({ fx: helper.home.x / viewport.width, fy: helper.home.y / viewport.height }));
}

function placeHelper(x, y, { glide = false } = {}) {
  const position = clampHelper(x, y);
  if (glide) helper.helmy?.travel(position.x - helper.x);
  helper.x = position.x;
  helper.y = position.y;
  if (!helper.root) return;
  helper.root.classList.toggle("is-gliding", glide && !helperReducedMotion());
  helper.root.style.setProperty("--helper-x", `${Math.round(position.x)}px`);
  helper.root.style.setProperty("--helper-y", `${Math.round(position.y)}px`);
  helper.root.style.setProperty("--helper-bottom-inset", `${Math.round(helperBottomInset())}px`);
  helper.root.classList.toggle("is-left-half", position.x + helperSize().width / 2 < helperViewport().width / 2);
}

function helperDockPosition() {
  const { width, height } = helperSize();
  const viewport = helperViewport();
  return { x: viewport.width - width - AGENT_HELPER_MARGIN, y: viewport.height - height - AGENT_HELPER_MARGIN - helperBottomInset() };
}

function scheduleHelperWander() {
  clearTimeout(helper.wanderTimer);
  if (!helper.root || helperReducedMotion()) return;
  helper.wanderTimer = setTimeout(() => {
    if (helper.root && !helper.open && !helper.drag && document.visibilityState === "visible" && helper.home) {
      // Drift a little around home, never far from where the owner put it,
      // so it does not wander over the page's buttons.
      const dx = (Math.random() - 0.5) * 72;
      const dy = (Math.random() - 0.5) * 28;
      placeHelper(helper.home.x + dx, helper.home.y + dy, { glide: true });
      helper.root.classList.toggle("is-facing-left", dx < 0);
    }
    scheduleHelperWander();
  }, 9_000 + Math.random() * 8_000);
}

function createAgentHelper() {
  const root = document.createElement("div");
  root.className = "agent-helper";
  root.id = "agent-helper";
  setMarkup(root, `
    <div class="agent-helper__bubble" role="status" hidden></div>
    <button class="agent-helper__buddy" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="agent-helper-panel" aria-label="Open the agent chat. Drag to move.">
      <span class="agent-helper__float"><img src="./assets/agent-helper.png" alt="" width="360" height="327" draggable="false" /></span>
      <span class="agent-helper__badge" hidden></span>
    </button>
    <section class="agent-helper__panel" id="agent-helper-panel" role="dialog" aria-labelledby="agent-helper-title" hidden>
      <header>
        <div><h2 id="agent-helper-title">Agent</h2><span class="agent-helper__status"></span></div>
        <div class="agent-helper__tools">
          <button class="agent-helper__tool" type="button" data-action="switch-workspace" data-workspace="system" data-workspace-route="system" title="Open the full view on the Overview">${icon("external")}<span class="sr-only">Open the full view</span></button>
          <button class="agent-helper__tool" type="button" data-helper-action="hide" title="Hide the helper in this browser">${icon("eye")}<span class="sr-only">Hide the helper</span></button>
          <button class="agent-helper__tool" type="button" data-helper-action="close" title="Close">${icon("x")}<span class="sr-only">Close the chat</span></button>
        </div>
      </header>
      <div class="agent-helper__proposals"></div>
      <ol class="agent-chat__messages agent-helper__messages" aria-live="polite"></ol>
      <form class="agent-chat__form" id="agent-helper-form">
        <label class="sr-only" for="agent-helper-input">Question for the agent</label>
        <textarea id="agent-helper-input" name="question" rows="2" maxlength="${AGENT_QUESTION_LIMIT}"></textarea>
        <button class="button button--primary" type="submit">Ask</button>
      </form>
    </section>`);
  document.body.append(root);
  document.body.classList.add("has-agent-helper");
  helper.root = root;
  helper.buddy = root.querySelector(".agent-helper__buddy");
  helper.panel = root.querySelector(".agent-helper__panel");
  helper.bubble = root.querySelector(".agent-helper__bubble");
  helper.renderedKey = "";

  helper.buddy.addEventListener("pointerdown", startHelperDrag);
  helper.buddy.addEventListener("pointerenter", () => helper.helmy?.hover(true));
  helper.buddy.addEventListener("pointerleave", () => helper.helmy?.hover(false));
  helper.onPointer = (event) => helper.helmy?.pointer(event.clientX, event.clientY);
  document.addEventListener("pointermove", helper.onPointer, { passive: true });
  helper.buddy.addEventListener("click", () => {
    if (helper.suppressClick) {
      helper.suppressClick = false;
      return;
    }
    toggleAgentHelper();
  });
  helper.bubble.addEventListener("click", () => openAgentHelper());
  root.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-helper-action]")?.dataset.helperAction;
    if (action === "close") closeAgentHelper();
    if (action === "hide") {
      setAgentHelperEnabled(false);
      showToast("Helper hidden. Turn it back on under Settings → Agent.", "info");
    }
  });
  root.querySelector("#agent-helper-form").addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    askAgent("helper");
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && helper.open) {
      event.stopPropagation();
      closeAgentHelper();
      helper.buddy?.focus({ preventScroll: true });
    }
  });

  helper.home = loadHelperHome();
  placeHelper(helper.home.x, helper.home.y);
  requestAnimationFrame(() => root.classList.add("is-ready"));
  scheduleHelperWander();
  loadHelmy();
}

function removeAgentHelper() {
  clearTimeout(helper.wanderTimer);
  clearTimeout(helper.bubbleTimer);
  helper.helmy?.destroy();
  if (helper.onPointer) document.removeEventListener("pointermove", helper.onPointer);
  helper.root?.remove();
  document.body.classList.remove("has-agent-helper");
  Object.assign(helper, { root: null, buddy: null, panel: null, bubble: null, open: false, drag: null, renderedKey: "", helmy: null, helmyLoad: null, onPointer: null });
}

function startHelperDrag(event) {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  helper.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: helper.x, originY: helper.y, moved: false, lastX: event.clientX, lastAt: event.timeStamp };
  helper.buddy.setPointerCapture?.(event.pointerId);
  helper.buddy.addEventListener("pointermove", moveHelperDrag);
  helper.buddy.addEventListener("pointerup", endHelperDrag);
  helper.buddy.addEventListener("pointercancel", endHelperDrag);
}

function moveHelperDrag(event) {
  const drag = helper.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    helper.root.classList.add("is-dragging");
    if (helper.open) closeAgentHelper({ returnHome: false });
  }
  placeHelper(drag.originX + dx, drag.originY + dy);
  helper.root.classList.toggle("is-facing-left", dx < 0);
  const elapsed = Math.max(1, event.timeStamp - drag.lastAt);
  helper.helmy?.drag(((event.clientX - drag.lastX) / elapsed) * 1000);
  drag.lastX = event.clientX;
  drag.lastAt = event.timeStamp;
}

function endHelperDrag(event) {
  const drag = helper.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  helper.buddy.releasePointerCapture?.(event.pointerId);
  helper.buddy.removeEventListener("pointermove", moveHelperDrag);
  helper.buddy.removeEventListener("pointerup", endHelperDrag);
  helper.buddy.removeEventListener("pointercancel", endHelperDrag);
  helper.drag = null;
  helper.root.classList.remove("is-dragging");
  helper.helmy?.drop();
  if (drag.moved) {
    helper.suppressClick = true;
    helper.home = { x: helper.x, y: helper.y };
    saveHelperHome();
    scheduleHelperWander();
  }
}

function toggleAgentHelper() {
  if (helper.open) closeAgentHelper();
  else openAgentHelper();
}

function openAgentHelper() {
  if (!helper.root || helper.open) return;
  helper.open = true;
  clearTimeout(helper.wanderTimer);
  hideHelperBubble();
  const dock = helperDockPosition();
  placeHelper(dock.x, dock.y, { glide: true });
  helper.root.classList.add("is-open");
  // Docked on the right, he turns toward the chat beside him.
  helper.root.classList.add("is-facing-left");
  helper.buddy.setAttribute("aria-expanded", "true");
  helper.panel.hidden = false;
  markHelperNotesSeen();
  syncAgentHelper({ force: true });
  const input = helper.root.querySelector("#agent-helper-input");
  setTimeout(() => {
    if (helper.open && !input.disabled) input.focus({ preventScroll: true });
    const messages = helper.root?.querySelector(".agent-helper__messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, helperReducedMotion() ? 0 : 420);
}

function closeAgentHelper({ returnHome = true } = {}) {
  if (!helper.root || !helper.open) return;
  helper.open = false;
  helper.root.classList.remove("is-open");
  helper.buddy.setAttribute("aria-expanded", "false");
  helper.panel.hidden = true;
  helper.helmy?.mood(helperMood());
  if (returnHome && helper.home) placeHelper(helper.home.x, helper.home.y, { glide: true });
  scheduleHelperWander();
}

function setAgentHelperEnabled(enabled) {
  writeHelperStorage(AGENT_HELPER_KEY, enabled ? null : "off");
  syncAgentHelper({ force: true });
  const toggle = document.getElementById("agent-helper-toggle");
  if (toggle) toggle.checked = enabled;
}

function markHelperNotesSeen() {
  const newest = agentData()?.notes?.[0]?.id;
  if (newest) writeHelperStorage(AGENT_HELPER_SEEN_KEY, newest);
}

function hideHelperBubble() {
  clearTimeout(helper.bubbleTimer);
  if (helper.bubble) helper.bubble.hidden = true;
}

// A new incident or rule action gets a short speech bubble, once.
function announceHelperNote(note) {
  if (!helper.bubble || helper.open || !note || helper.announcedNote === note.id) return;
  helper.announcedNote = note.id;
  if (!["incident", "rule-action", "recovery"].includes(note.kind)) return;
  helmyReact(note.kind === "incident" ? "alert" : note.kind === "recovery" ? "celebrate" : "nod");
  helper.bubble.textContent = note.title || "New report";
  helper.bubble.hidden = false;
  clearTimeout(helper.bubbleTimer);
  helper.bubbleTimer = setTimeout(hideHelperBubble, 9_000);
}

function syncAgentHelper({ force = false } = {}) {
  const visible = Boolean(state.status?.authenticated && state.agent.loaded && agentData() && agentHelperEnabled());
  if (!visible) {
    if (helper.root) removeAgentHelper();
    return;
  }
  if (!helper.root) createAgentHelper();
  helper.helmy?.mood(helperMood());
  const data = agentData();
  const ready = Boolean(data.config?.ai);
  const proposals = data.proposals || [];
  const newest = data.notes?.[0] || null;
  const seen = readHelperStorage(AGENT_HELPER_SEEN_KEY);
  const unseen = Boolean(newest && newest.id !== seen && !helper.open);
  const badge = helper.root.querySelector(".agent-helper__badge");
  badge.hidden = !(proposals.length || unseen);
  badge.textContent = proposals.length ? String(proposals.length) : "";
  badge.classList.toggle("is-dot", !proposals.length);
  helper.buddy.setAttribute("aria-label", `Open the agent chat${proposals.length ? `, ${proposals.length} waiting for approval` : unseen ? ", new report" : ""}. Drag to move.`);
  // Reports that arrive while the page is open get a speech bubble; the
  // ones already there when it loaded only get the badge.
  if (helper.baselineNote === undefined) helper.baselineNote = newest?.id || "";
  else if (newest && newest.id !== helper.baselineNote) announceHelperNote(newest);
  if (seen === null && newest) writeHelperStorage(AGENT_HELPER_SEEN_KEY, newest.id);
  if (helper.open) markHelperNotesSeen();

  const key = JSON.stringify([ready, agentStatus(data).label, proposals.map(({ id }) => id), state.agent.busy, state.agent.asking, state.agent.chat.length, state.agent.chat.at(-1)?.content, [...state.agent.decisions.keys()], state.agent.ratingVersion, state.agent.editingAnswer]);
  if (!force && key === helper.renderedKey) return;
  helper.renderedKey = key;
  const status = agentStatus(data);
  const statusElement = helper.root.querySelector(".agent-helper__status");
  statusElement.className = `agent-helper__status system-service-state is-${status.tone}`;
  setMarkup(statusElement, `<i class="health-dot is-${status.tone}"></i>${escapeHtml(status.label)}`);
  const background = backgroundProposals(proposals);
  setMarkup(helper.root.querySelector(".agent-helper__proposals"), background.length
    ? `<span class="section-kicker">Waiting for your approval</span><ul>${background.map(renderAgentProposal).join("")}</ul>`
    : "");
  const messages = helper.root.querySelector(".agent-helper__messages");
  setMarkup(messages, ready
    ? renderAgentChatMessages(true)
    : `<li class="agent-chat__empty">Connect a model running on your own hardware to chat here. <button class="agent-text-button" type="button" data-action="switch-workspace" data-workspace="system" data-workspace-route="settings" data-settings-tab="agent">Set up the agent</button></li>`);
  messages.scrollTop = messages.scrollHeight;
  const input = helper.root.querySelector("#agent-helper-input");
  input.disabled = !ready;
  input.placeholder = ready ? "Ask about your homelab…" : "Set up the agent first";
  if (input.value !== state.agent.helperDraft && document.activeElement !== input) input.value = state.agent.helperDraft;
  const submit = helper.root.querySelector("#agent-helper-form button[type='submit']");
  submit.disabled = !ready || state.agent.asking;
  submit.textContent = state.agent.asking ? "Asking…" : "Ask";
}

function renderAgentHelperSetting() {
  return `<label class="check-row agent-helper-setting"><input id="agent-helper-toggle" type="checkbox" ${agentHelperEnabled() ? "checked" : ""}/><span><strong>Show the floating helper</strong><small>A small character that floats over every page. Drag it anywhere; click it to chat. This setting is for this browser only.</small></span></label>`;
}

globalThis.addEventListener?.("resize", () => {
  if (!helper.root) return;
  if (helper.open) {
    const dock = helperDockPosition();
    placeHelper(dock.x, dock.y);
  } else {
    helper.home = loadHelperHome();
    placeHelper(helper.home.x, helper.home.y);
  }
});

document.addEventListener("change", (event) => {
  if (event.target?.id === "agent-helper-toggle") setAgentHelperEnabled(Boolean(event.target.checked));
});

document.addEventListener("input", (event) => {
  if (event.target?.id === "agent-helper-input") state.agent.helperDraft = String(event.target.value || "").slice(0, AGENT_QUESTION_LIMIT);
});

document.addEventListener("keydown", (event) => {
  if (event.target?.id !== "agent-helper-input" || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  askAgent("helper");
});

// Prowlarr indexers ----------------------------------------------------
// Read live from the server (which strips every indexer secret) when the
// Media Health page opens. Tests change nothing in Prowlarr; syncing pushes
// indexers to the connected apps, so it asks first.

function emptyProwlarrState() {
  return { loaded: false, loading: false, error: "", data: null, results: new Map(), appResults: new Map(), busy: "" };
}

function prowlarrConfigured() {
  return Boolean(state.config?.services?.some((service) => service.id === "prowlarr"
    && service.configured !== false && service.enabled !== false && service.monitoringEnabled !== false));
}

function rerenderProwlarr() {
  if (currentRoute() !== "health" || state.workspace !== "media") return;
  state.lastMarkup = "";
  renderPage({ force: true, preserveFocus: true });
}

async function loadProwlarr({ render = true } = {}) {
  if (!state.status?.authenticated || !prowlarrConfigured() || state.prowlarr.loading) return;
  state.prowlarr.loading = true;
  if (render) rerenderProwlarr();
  try {
    state.prowlarr.data = await api("/api/v2/prowlarr/indexers");
    state.prowlarr.error = "";
  } catch (error) {
    if (error?.status === 401) {
      await initialize();
      return;
    }
    state.prowlarr.error = safeSessionText(error?.message, "Prowlarr's indexers could not be read.", 180);
  } finally {
    state.prowlarr.loading = false;
    state.prowlarr.loaded = true;
  }
  if (render) rerenderProwlarr();
}

function prowlarrTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : agentNoteTime(value);
}

function renderProwlarrIndexer(indexer) {
  const result = state.prowlarr.results.get(indexer.id);
  const busy = state.prowlarr.busy === `test:${indexer.id}`;
  const tone = !indexer.enabled ? "disabled" : indexer.failing ? "degraded" : "healthy";
  const status = !indexer.enabled ? "Disabled in Prowlarr"
    : indexer.failing ? `Failing${indexer.failingSince ? ` since ${prowlarrTime(indexer.failingSince)}` : ""}` : "Working";
  const numbers = indexer.queries === null ? "" : [
    `${Number(indexer.queries).toLocaleString()} queries`,
    `${Number(indexer.grabs || 0).toLocaleString()} grabs`,
    indexer.failedQueries ? `${Number(indexer.failedQueries).toLocaleString()} failed` : "",
    indexer.averageResponseMs ? `${Number(indexer.averageResponseMs).toLocaleString()} ms` : ""
  ].filter(Boolean).join(" · ");
  const protocol = { torrent: "Torrent", usenet: "Usenet" }[indexer.protocol] || "";
  const privacy = { public: "Public", private: "Private", semiPrivate: "Semi-private" }[indexer.privacy] || "";
  return `<li class="prowlarr-indexer${indexer.failing ? " is-failing" : ""}">
    <i class="health-dot is-${tone}" aria-hidden="true"></i>
    <div class="prowlarr-indexer__main">
      <strong>${escapeHtml(indexer.name)}</strong>
      <small>${escapeHtml([protocol, privacy].filter(Boolean).join(" · "))}${numbers ? ` · ${escapeHtml(numbers)}` : ""}</small>
      ${result ? `<small class="prowlarr-indexer__result is-${result.ok ? "ok" : "bad"}">${result.ok ? "Passed its test" : `Failed its test: ${escapeHtml(result.message)}`} · ${escapeHtml(prowlarrTime(result.at))}</small>` : ""}
    </div>
    <span class="system-service-state is-${tone}"><i class="health-dot is-${tone}"></i>${escapeHtml(status)}${indexer.failing && indexer.disabledUntil ? `<em>Paused until ${escapeHtml(prowlarrTime(indexer.disabledUntil))}</em>` : ""}</span>
    <button class="button button--compact" type="button" data-action="prowlarr-test" data-indexer-id="${indexer.id}" ${state.prowlarr.busy ? "disabled" : ""}${busy ? ' aria-busy="true"' : ""}>${busy ? "Testing…" : "Test"}</button>
  </li>`;
}

function renderProwlarrPanel() {
  if (!prowlarrConfigured()) return "";
  const prowlarr = state.prowlarr;
  const data = prowlarr.data;
  const busy = prowlarr.busy;
  const indexers = data?.indexers || [];
  const failing = indexers.filter((indexer) => indexer.failing && indexer.enabled).length;
  const button = (action, label, busyLabel) => `<button class="button button--compact" type="button" data-action="${action}" ${busy || !data ? "disabled" : ""}${busy === action ? ' aria-busy="true"' : ""}>${busy === action ? busyLabel : label}</button>`;
  const body = !prowlarr.loaded || (prowlarr.loading && !data)
    ? `<p class="agent-empty">Reading indexers from Prowlarr…</p>`
    : prowlarr.error && !data
      ? `<div class="empty-state"><strong>Indexers unavailable</strong><span>${escapeHtml(prowlarr.error)}</span></div>`
      : !indexers.length
        ? `<p class="agent-empty">Prowlarr has no indexers yet.</p>`
        : `<ul class="prowlarr-indexers">${indexers.map(renderProwlarrIndexer).join("")}</ul>`;
  const apps = data?.applications || [];
  return `<section class="system-overview-card prowlarr-panel" aria-labelledby="prowlarr-indexers-title">
    <header>
      <div><span class="section-kicker">Prowlarr</span><h3 id="prowlarr-indexers-title">Indexers</h3></div>
      <div class="prowlarr-panel__actions">
        ${data ? `<span class="prowlarr-panel__summary">${failing ? `<b>${failing} failing</b> · ` : ""}${indexers.length} indexer${indexers.length === 1 ? "" : "s"}</span>` : ""}
        ${button("prowlarr-test-all", "Test all", "Testing…")}
        <button class="button button--compact" type="button" data-action="prowlarr-refresh" ${prowlarr.loading ? 'disabled aria-busy="true"' : ""}>${icon("refresh")}<span class="sr-only">Refresh indexers</span></button>
      </div>
    </header>
    ${body}
    ${apps.length ? `<footer class="prowlarr-apps">
      <span class="prowlarr-apps__label">Apps</span>
      <span class="prowlarr-apps__list">${apps.map((app) => {
        const result = prowlarr.appResults.get(app.id);
        return `<span class="prowlarr-app${result ? ` is-${result.ok ? "ok" : "bad"}` : ""}" title="${escapeHtml(result && !result.ok ? result.message : app.kind)}">${result ? icon(result.ok ? "check" : "x") : ""}${escapeHtml(app.name)}</span>`;
      }).join("")}</span>
      <span class="prowlarr-apps__actions">${button("prowlarr-test-apps", "Test connections", "Testing…")}${button("prowlarr-sync", "Sync indexers to apps", "Syncing…")}</span>
    </footer>` : ""}
  </section>`;
}

async function runProwlarrAction(action, indexerId = null) {
  const data = state.prowlarr.data;
  if (!data?.targetRevision || state.prowlarr.busy) return;
  const operation = { "prowlarr-test": "testIndexer", "prowlarr-test-all": "testAllIndexers", "prowlarr-sync": "syncApps", "prowlarr-test-apps": "testApps" }[action];
  if (!operation) return;
  if (operation === "syncApps") {
    const confirmed = await confirmControl({
      title: "Sync indexers to apps?",
      message: "Prowlarr sends its indexers to Sonarr, Radarr and its other connected apps, following each app's sync setting.",
      confirmLabel: "Sync indexers"
    });
    if (!confirmed) return;
  }
  state.prowlarr.busy = operation === "testIndexer" ? `test:${indexerId}` : action;
  rerenderProwlarr();
  try {
    const result = await api("/api/v2/actions/prowlarr", {
      method: "POST",
      body: { operation, ...(operation === "testIndexer" ? { indexerId } : {}), targetRevision: data.targetRevision }
    });
    const at = new Date().toISOString();
    if (operation === "testIndexer") {
      state.prowlarr.results.set(indexerId, { ok: result.passed === true, message: result.message || "", at });
      const name = data.indexers.find((indexer) => indexer.id === indexerId)?.name || "The indexer";
      showToast(result.passed ? `${name} passed its test.` : `${name} failed its test.`, result.passed ? "success" : "danger");
    } else if (operation === "testAllIndexers") {
      for (const entry of result.results || []) state.prowlarr.results.set(entry.id, { ok: entry.ok, message: entry.message || "", at });
      const failed = (result.results || []).filter(({ ok }) => !ok).length;
      showToast(failed ? `${failed} indexer${failed === 1 ? "" : "s"} failed the test.` : "Every indexer passed.", failed ? "danger" : "success");
    } else if (operation === "testApps") {
      for (const entry of result.results || []) state.prowlarr.appResults.set(entry.id, { ok: entry.ok, message: entry.message || "" });
      const failed = (result.results || []).filter(({ ok }) => !ok).length;
      showToast(failed ? `${failed} app connection${failed === 1 ? "" : "s"} failed.` : "Prowlarr can reach every app.", failed ? "danger" : "success");
    } else {
      showToast("Prowlarr is syncing its indexers to the apps.", "success");
    }
  } catch (error) {
    if (error?.status === 401) {
      await initialize();
      return;
    }
    showToast(error?.message || "Prowlarr didn't accept that.", "danger");
  } finally {
    state.prowlarr.busy = "";
  }
  await loadProwlarr();
}

// Automation tab ---------------------------------------------------------

function renderAgentIndexersCard(data) {
  const policy = data.config?.indexers || { enabled: false, tests: 2, spacingMinutes: 15 };
  const tests = data.limits?.indexerTests || { min: 1, max: 5 };
  const spacing = data.limits?.indexerSpacingMinutes || { min: 5, max: 120 };
  const watching = data.indexers || [];
  const stateText = (entry) => entry.state === "gaveUp"
    ? `Failed ${entry.tests} test${entry.tests === 1 ? "" : "s"}; you were notified`
    : entry.state === "passed" ? "Passed a retest"
      : entry.tests ? `Failed test ${entry.tests} of ${entry.maxTests}; next test in ${entry.nextTestMinutes} min` : "Testing now";
  return `<form class="glass-panel settings-card-v5 agent-indexers" id="agent-indexers-form">
    <header><div><span class="section-kicker">Prowlarr</span><h3>Indexers</h3></div>${icon("search")}</header>
    <div class="settings-card-v5__body">
      <p>When an indexer starts failing in Prowlarr, the agent tests it, retests it after a while, and notifies you only if it keeps failing. Testing changes nothing in Prowlarr.</p>
      ${prowlarrConfigured() ? "" : `<div class="security-note">${icon("link")}<div><strong>Prowlarr isn't connected</strong><span>Connect it under Media → Connections for this to have anything to test.</span></div></div>`}
      <label class="check-row"><input name="enabled" type="checkbox" ${policy.enabled ? "checked" : ""}/><span><strong>Let the agent test indexers</strong><small>On its own when one fails, and when you ask in chat (“test indexers”, “test 1337x”). When off, you're notified about failing indexers as usual and nothing is tested.</small></span></label>
      <div class="form-grid form-grid--two">
        <label><span>Tests before notifying</span><input name="tests" type="number" min="${tests.min}" max="${tests.max}" value="${Number(policy.tests)}" required /></label>
        <label><span>Minutes between tests</span><input name="spacingMinutes" type="number" min="${spacing.min}" max="${spacing.max}" value="${Number(policy.spacingMinutes)}" required /></label>
      </div>
      <p class="agent-voice__hint">Each test queries the indexer's site, so the agent tests only the failing indexer, and at most 12 tests an hour.</p>
      ${policy.enabled && watching.length ? `<h4>Right now</h4><ul class="agent-health__seen">${watching.map((entry) => `<li><i class="health-dot is-${entry.state === "gaveUp" ? "down" : entry.state === "passed" ? "healthy" : "degraded"}" aria-hidden="true"></i><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(stateText(entry))}</small>${entry.lastMessage ? `<small>${escapeHtml(entry.lastMessage)}</small>` : ""}</div></li>`).join("")}</ul>` : ""}
      <div class="button-row"><button class="button button--primary" type="submit">Save</button></div>
    </div>
  </form>`;
}

async function submitAgentIndexers(form) {
  const data = new FormData(form);
  await agentMutation("/indexers", "PUT", {
    enabled: data.get("enabled") === "on",
    tests: Number(String(data.get("tests") || "").trim()),
    spacingMinutes: Number(String(data.get("spacingMinutes") || "").trim())
  }, "Indexer testing saved.");
}

const SETTINGS_TABS = Object.freeze([
  Object.freeze({ id: "access", label: "Access" }),
  Object.freeze({ id: "agent", label: "Agent" }),
  Object.freeze({ id: "notifications", label: "Notifications" }),
  Object.freeze({ id: "automation", label: "Automation" }),
  Object.freeze({ id: "logging", label: "Logging" }),
  Object.freeze({ id: "about", label: "About" })
]);
const SETTINGS_TAB_KEY = "helmsman.settingsTab";

function settingsTab() {
  let candidate = state.settingsTab;
  if (!candidate) {
    try {
      candidate = globalThis.localStorage?.getItem(SETTINGS_TAB_KEY) || "";
    } catch {
      candidate = "";
    }
  }
  return SETTINGS_TABS.some(({ id }) => id === candidate) ? candidate : "access";
}

function setSettingsTab(id, { focus = false } = {}) {
  if (!SETTINGS_TABS.some((tab) => tab.id === id)) return;
  state.settingsTab = id;
  try {
    globalThis.localStorage?.setItem(SETTINGS_TAB_KEY, id);
  } catch {
    // A private window may block storage; the tab still changes.
  }
  if (currentRoute() !== "settings") return;
  state.lastMarkup = "";
  renderPage({ force: true });
  if (focus) document.getElementById(`settings-tab-${id}`)?.focus({ preventScroll: true });
}

function renderSettingsPage() {
  const policy = state.config?.policy || { allowedCidrs: [], allowPublicHttps: false };
  const networkMode = Array.isArray(policy.allowedCidrs) && policy.allowedCidrs.length ? "manual" : "exact";
  const authentication = authenticationState();
  const jellyfinConnected = configuredJellyfinConnection();
  const ownerName = authentication.ownerName ? escapeHtml(authentication.ownerName) : "Jellyfin owner";
  const appVersion = safeSessionText(state.status?.version, "Version unavailable", 48);
  const tab = settingsTab();
  const panels = {
    access: `<header class="detail-hero"><div><span class="section-kicker">Control plane</span><h2>Security and access</h2><p>Local mode stays simple; HTTPS and Authentik remain optional deployment layers for LAN or external access.</p></div></header>
      <div class="settings-grid-v5">
        <form class="glass-panel settings-card-v5" id="network-form" data-network-mode="${networkMode}"><header><div><span class="section-kicker">Outbound policy</span><h3>Allowed service networks</h3></div>${icon("shield")}</header><div class="settings-card-v5__body">
          ${renderNetworkPolicyFields(policy, "settings")}
          <div class="form-actions"><button class="button button--primary" type="submit">Save network policy</button></div>
        </div></form>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">Browser access</span><h3>Jellyfin owner authentication</h3></div>${icon("lock")}</header><div class="settings-card-v5__body">
          <p>Helmsman signs browsers in through the configured Jellyfin server. The password is used for the one-time authentication exchange and is never saved by Helmsman.</p>
          <div class="security-note ${authentication.configured ? "security-note--good" : ""}">${icon(authentication.configured ? "check" : "lock")}<div><strong>${authentication.configured ? `${ownerName} enrolled` : "Jellyfin owner not enrolled"}</strong><span>${authentication.configured ? "Only this enabled Jellyfin administrator can create new Helmsman browser sessions." : jellyfinConnected ? "Enter the Jellyfin administrator credentials below to finish browser authentication setup." : "Connect Jellyfin under Media → Connections, then return here to enroll its administrator."}</span></div></div>
          ${authentication.configured ? `<div class="button-row"><button class="button" type="button" data-action="refresh-sessions">Refresh browser list</button></div>` : `<form class="network-cidr-fields" id="jellyfin-enroll-form" autocomplete="on" data-form-type="login">
            <div class="form-grid form-grid--two">
              <label><span>Username</span><input name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="320" required /></label>
              <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
            </div>
            <div class="security-note">${icon("shield")}<div><strong>Protect the Jellyfin connection</strong><span>Use HTTPS for Jellyfin, or use private HTTP only on a network you trust. HTTP does not encrypt this password between Helmsman and Jellyfin.</span></div></div>
            <p class="form-error" id="jellyfin-enroll-error" role="alert"></p>
            <div class="button-row"><button class="button button--primary" type="submit">Enroll Jellyfin owner</button><button class="button" type="button" data-action="refresh-sessions">Refresh browser list</button></div>
          </form>`}
          <h4>Authorized browsers</h4>
          ${renderBrowserSessions()}
        </div></section>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">At rest</span><h3>Credential encryption</h3></div>${icon("shield")}</header><div class="settings-card-v5__body"><p>Secrets use AES-256-GCM and never return through the API. ${state.status?.storage?.externalKey ? "This deployment uses an external key file." : "This local deployment uses an automatically generated key in its protected data volume."}</p><div class="security-note security-note--good">${icon("check")}<div><strong>No extra unlock step</strong><span>The container keeps monitoring after every browser closes.</span></div></div></div></section>
        <section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">Deployment edge</span><h3>Authentik and HTTPS</h3></div>${icon("shield")}</header><div class="settings-card-v5__body"><p>Optional for localhost. For LAN or external access, terminate HTTPS at a trusted reverse proxy, put Authentik in front, and firewall the container port so that proxy cannot be bypassed.</p></div></section>
      </div>`,
    agent: renderAgentSettings(),
    notifications: renderAgentNotificationsTab(),
    automation: renderAgentAutomationTab(),
    logging: renderLoggingSettings(),
    about: `<div class="settings-grid-v5"><section class="glass-panel settings-card-v5"><header><div><span class="section-kicker">About</span><h3>Helmsman release</h3></div>${icon("logs")}</header><div class="settings-card-v5__body app-version-v5"><p>Include this exact version when reporting a problem or checking release notes.</p><dl><div><dt>Version</dt><dd data-app-version>${escapeHtml(appVersion)}</dd></div></dl><nav class="button-row app-version-v5__links" aria-label="Helmsman project resources"><a class="button button--compact" href="https://github.com/nunesg130-boop/helmsman" target="_blank" rel="noopener noreferrer" aria-label="Source code (opens in a new tab)">Source</a><a class="button button--compact" href="https://github.com/nunesg130-boop/helmsman/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" aria-label="AGPL-3.0 license (opens in a new tab)">AGPL-3.0 License</a><a class="button button--compact" href="https://github.com/nunesg130-boop/helmsman/blob/main/assets/services/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer" aria-label="Third-party icon notices (opens in a new tab)">Third-party icon notices</a></nav></div></section></div>`
  };
  return `
    <section class="detail-page settings-page-v5">
      <nav class="settings-tabs filter-chips" role="tablist" aria-label="Settings sections">${SETTINGS_TABS.map(({ id, label }) => `<button class="filter-chip ${tab === id ? "is-active" : ""}" type="button" role="tab" id="settings-tab-${id}" aria-selected="${tab === id ? "true" : "false"}" aria-controls="settings-panel" tabindex="${tab === id ? "0" : "-1"}" data-action="settings-tab" data-settings-tab="${id}">${escapeHtml(label)}</button>`).join("")}</nav>
      <div class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby="settings-tab-${tab}">${panels[tab]}</div>
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
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${proxmoxBrandLinkMarkup()}</span><div><span class="section-kicker">${escapeHtml(environmentKindLabel(environment))}</span><h2 id="environment-detail-title" tabindex="-1">${escapeHtml(environment.displayName)}</h2><p>${escapeHtml(environment.environmentKind === "cluster" ? environment.clusterName || environment.environmentName : environment.environmentName)}</p></div><span class="detail-status is-${statusClass(environment.state)}"><i class="health-dot is-${statusClass(environment.state)}"></i>${escapeHtml(statusLabel(environment.state))}</span><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <div class="modal-card__body inventory-detail-body">
      <dl class="inventory-summary-grid"><div><dt>Nodes</dt><dd>${environment.nodes.length}</dd><small>${environment.nodes.filter(({ status }) => status === "online").length} online</small></div><div><dt>Workloads</dt><dd>${workloads.length}</dd><small>${workloads.filter(({ status }) => status === "running").length} running</small></div><div><dt>API endpoints</dt><dd>${endpoints.length}</dd><small>${endpointAvailable} available</small></div><div><dt>Cluster quorum</dt><dd>${environment.environmentKind !== "cluster" ? "N/A" : environment.quorate === true ? "Yes" : environment.quorate === false ? "No" : "—"}</dd><small>${environment.version ? `PVE ${escapeHtml(environment.version)}` : "Version pending"}</small></div></dl>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Connection layer</span><h3>API endpoints</h3><p>Endpoint reachability is separate from the health of the Proxmox nodes it reports.</p></div>${endpoints.length < 4 ? `<button class="button button--compact" type="button" data-action="add-infrastructure-endpoint" data-infrastructure-target-id="${escapeHtml(environment.id)}">${icon("plus")} Add failover endpoint</button>` : ""}</header>
        <div class="endpoint-detail-list">${endpoints.map((endpoint) => `<article class="endpoint-detail-row is-${statusClass(endpoint.state)}"><span class="endpoint-detail-row__status"><i class="health-dot is-${statusClass(endpoint.state)}"></i></span><div><strong>${escapeHtml(endpoint.label)}</strong><code>${escapeHtml(endpoint.url || "Address unavailable")}</code><small>${escapeHtml(environmentEndpointSummary(environment, endpoint))}${endpoint.latencyMs !== null ? ` · ${endpoint.latencyMs} ms` : ""}</small></div><div class="endpoint-badges">${endpoint.primary ? "<span>Primary</span>" : ""}${endpoint.selected ? "<span class=\"is-selected\">In use</span>" : ""}<span>${escapeHtml(endpoint.tlsMode === "pinned" ? "Pinned TLS" : "System TLS")}</span></div><button class="button button--compact" type="button" data-action="${endpoint.primary ? "open-infrastructure-target" : "open-infrastructure-endpoint"}" data-infrastructure-target-id="${escapeHtml(environment.id)}" data-infrastructure-endpoint-id="${escapeHtml(endpoint.id)}">Configure</button></article>`).join("")}</div>
      </section>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Physical layer</span><h3>Nodes</h3></div></header>${environment.nodes.length ? `<div class="inventory-compact-list">${environment.nodes.map((node) => `<button type="button" data-action="open-infrastructure-node" data-infrastructure-node-id="${escapeHtml(node.id)}"><i class="health-dot is-${statusClass(node.state)}"></i><span><strong>${escapeHtml(node.name)}</strong><small>${node.status === "online" ? "Online" : node.status === "offline" ? "Offline" : "State unknown"} · ${node.workloadCount} workload${node.workloadCount === 1 ? "" : "s"}</small></span><span>${node.cpuPercent === null ? "CPU —" : `CPU ${node.cpuPercent}%`}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No node inventory is available yet.</span></div>`}</section>

      <section class="inventory-detail-section"><header><div><span class="section-kicker">Virtual layer</span><h3>Workloads</h3></div><a class="button button--compact" href="#/workloads" data-action="close-modal">View all</a></header>${workloads.length ? `<div class="inventory-compact-list">${workloads.slice(0, 12).map((workload) => `<button type="button" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong><small>${escapeHtml(workload.kind)} ${workload.vmid ?? "—"} · ${escapeHtml(workload.node)}</small></span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No workloads are currently visible.</span></div>`}</section>

      <div class="inventory-detail-columns"><section class="inventory-detail-section"><header><div><span class="section-kicker">Capacity</span><h3>Storage</h3></div></header>${environment.storage.length ? `<div class="storage-detail-list">${environment.storage.map((storage) => `<article><div><strong>${escapeHtml(storage.name)}</strong><small>${escapeHtml(storage.node)}${storage.shared ? " · Shared" : ""}${storage.type ? ` · ${escapeHtml(storage.type)}` : ""}</small></div><span>${storage.usagePercent === null ? "—" : `${storage.usagePercent}%`}</span><small>${storage.usedBytes === null ? escapeHtml(storage.status) : `${formatMetricBytes(storage.usedBytes)} of ${formatMetricBytes(storage.totalBytes)}`}</small></article>`).join("")}</div>` : `<div class="empty-state"><span>No storage inventory is available.</span></div>`}</section>
      <section class="inventory-detail-section" id="environment-recent-activity"><header><div><span class="section-kicker">Bounded history</span><h3>Recent activity</h3></div></header>${environment.activity.length ? `<div class="activity-detail-list">${environment.activity.slice(0, 12).map((entry) => `<article><i class="health-dot is-${entry.status === "success" ? "healthy" : "down"}"></i><div><strong>${escapeHtml(entry.type)}</strong><small>${escapeHtml([entry.node, entry.vmid === null ? "" : `VMID ${entry.vmid}`].filter(Boolean).join(" · "))}</small></div><time>${escapeHtml(formatTime(entry.endedAt))}</time></article>`).join("")}</div>` : `<div class="empty-state"><span>No recent task activity is available.</span></div>`}</section></div>
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
  return `<section class="modal-card modal-card--detail" role="dialog" aria-modal="true" aria-labelledby="node-detail-title"><header class="modal-card__header"><span class="detail-modal-mark">${proxmoxBrandLinkMarkup()}</span><div><span class="section-kicker">${escapeHtml(node.environmentName)}</span><h2 id="node-detail-title" tabindex="-1">${escapeHtml(node.name)}</h2><p>${node.status === "online" ? "Online Proxmox node" : node.status === "offline" ? "Offline Proxmox node" : "Node state unavailable"}</p></div><span class="detail-status is-${statusClass(node.state)}"><i class="health-dot is-${statusClass(node.state)}"></i>${escapeHtml(statusLabel(node.state))}</span><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header><div class="modal-card__body inventory-detail-body"><dl class="inventory-summary-grid"><div><dt>CPU</dt><dd>${node.cpuPercent === null ? "—" : `${node.cpuPercent}%`}</dd><small>${node.cpuCores === null ? "Cores unavailable" : `${node.cpuCores} cores`}</small></div><div><dt>Memory</dt><dd>${escapeHtml(formatMetricRatio(node.memoryUsedBytes, node.memoryTotalBytes))}</dd><small>${node.memoryUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.memoryUsedBytes)} of ${formatMetricBytes(node.memoryTotalBytes)}`}</small></div><div><dt>Root disk</dt><dd>${escapeHtml(formatMetricRatio(node.rootDiskUsedBytes, node.rootDiskTotalBytes))}</dd><small>${node.rootDiskUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.rootDiskUsedBytes)} of ${formatMetricBytes(node.rootDiskTotalBytes)}`}</small></div><div><dt>Uptime</dt><dd>${node.uptimeSeconds === null ? "—" : escapeHtml(formatMetricDuration(node.uptimeSeconds))}</dd><small>${escapeHtml(node.version || "Version unavailable")}</small></div></dl><div class="security-note ${api.available ? "security-note--good" : ""}">${icon(api.available ? "check" : "shield")}<div><strong>Environment API · ${api.available} of ${api.total} endpoints available</strong><span>This connection-layer signal does not override the node state reported by Proxmox.</span></div></div>${warnings.length ? `<div class="detail-warning-list">${warnings.map((warning) => `<div>${icon("shield")}<span>${escapeHtml(warning)}</span></div>`).join("")}</div>` : `<div class="security-note security-note--good">${icon("check")}<div><strong>No node-specific warnings</strong><span>Current bounded CPU, memory, disk, and availability signals are within their alert thresholds.</span></div></div>`}<section class="inventory-detail-section"><header><div><span class="section-kicker">Guests assigned here</span><h3>${workloads.length} workload${workloads.length === 1 ? "" : "s"}</h3></div></header>${workloads.length ? `<div class="inventory-compact-list">${workloads.map((workload) => `<button type="button" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong><small>${escapeHtml(workload.kind)} ${workload.vmid ?? "—"}</small></span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span>${icon("chevron")}</button>`).join("")}</div>` : `<div class="empty-state"><span>No VM or container is assigned to this node.</span></div>`}</section></div><footer class="modal-card__footer"><button class="button" type="button" data-action="open-infrastructure-environment-detail" data-infrastructure-target-id="${escapeHtml(node.environmentId)}">Open environment</button><button class="button button--primary" type="button" data-action="close-modal">Done</button></footer></section>`;
}

function openInfrastructureNode(nodeId) {
  const node = infrastructureNodeById(nodeId);
  if (!node) return showToast("That Proxmox node is no longer available.", "danger");
  openModal(renderInfrastructureNodeDetail(node), "#node-detail-title");
}

function proxmoxActionContext(workload) {
  if (snapshotIsCached()) return null;
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
      <div class="environment-card__heading">
        <span class="environment-card__icon">${proxmoxBrandLinkMarkup()}</span>
        <button class="environment-card__main" type="button" data-action="open-infrastructure-environment-detail" data-infrastructure-target-id="${escapeHtml(environment.id)}" aria-label="Open ${escapeHtml(environment.displayName)} environment details">
          <span class="environment-card__copy"><span class="section-kicker">${escapeHtml(environmentKindLabel(environment))}</span><strong>${escapeHtml(environment.displayName)}</strong><small>${environment.environmentKind === "cluster" ? escapeHtml(environment.clusterName || environment.environmentName) : escapeHtml(environment.environmentName)}</small></span>
          <span class="environment-card__state"><i class="health-dot is-${statusClass(environment.state)}"></i>${escapeHtml(statusLabel(environment.state))}</span>
          ${icon("chevron")}
        </button>
      </div>
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
    return `<article class="glass-panel infrastructure-node-card is-${statusClass(node.state)}">
      <span class="node-mark">${proxmoxBrandLinkMarkup()}</span>
      <button class="infrastructure-node-card__main" type="button" data-action="open-infrastructure-node" data-infrastructure-node-id="${escapeHtml(node.id)}" aria-label="Open ${escapeHtml(node.name)} node details">
        <header><span><small>${escapeHtml(node.environmentName)}</small><strong>${escapeHtml(node.name)}</strong></span><i class="health-dot is-${statusClass(node.state)}"></i></header>
        <dl><div><dt>CPU</dt><dd>${node.cpuPercent === null ? "—" : `${node.cpuPercent}%`}</dd><small>${node.cpuCores === null ? "Cores unavailable" : `${node.cpuCores} cores`}</small></div><div><dt>Memory</dt><dd>${escapeHtml(formatMetricRatio(node.memoryUsedBytes, node.memoryTotalBytes))}</dd><small>${node.memoryUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.memoryUsedBytes)} used`}</small></div><div><dt>Root disk</dt><dd>${escapeHtml(formatMetricRatio(node.rootDiskUsedBytes, node.rootDiskTotalBytes))}</dd><small>${node.rootDiskUsedBytes === null ? "Usage unavailable" : `${formatMetricBytes(node.rootDiskUsedBytes)} used`}</small></div><div><dt>Workloads</dt><dd>${node.runningWorkloadCount}/${node.workloadCount}</dd><small>${node.virtualMachineCount} VM · ${node.containerCount} LXC</small></div></dl>
        <footer><span>${node.status === "online" ? "Online" : node.status === "offline" ? "Offline" : "State unknown"}</span><span>${node.uptimeSeconds === null ? "Uptime unavailable" : `Up ${formatMetricDuration(node.uptimeSeconds)}`}${node.version ? ` · ${escapeHtml(node.version)}` : ""} · API ${api.available}/${api.total}</span></footer>
      </button>
    </article>`;
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
    // Proxmox reports an inactive storage (its disk or mount is missing on
    // that node) with no status and zero sizes; say so instead of "0 B".
    const inactive = ["unknown", "unavailable", "inactive", "disabled"].includes(String(entry.status || "unknown").toLowerCase())
      && !entry.totalBytes;
    const usage = inactive ? "Inactive" : entry.usagePercent === null ? "—" : `${entry.usagePercent}%`;
    const capacity = inactive
      ? `Not active on ${entry.node}: Proxmox can't reach its disk or mount there. If nothing on ${entry.node} uses it, remove it or limit it to the nodes that do.`
      : entry.usedBytes === null || entry.totalBytes === null
        ? "Capacity unavailable"
        : `${formatMetricBytes(entry.usedBytes)} used · ${formatMetricBytes(freeBytes)} free · ${formatMetricBytes(entry.totalBytes)} total`;
    return `<article class="is-${tone}"><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.environmentName)} · ${escapeHtml(entry.node)}${entry.type ? ` · ${escapeHtml(entry.type)}` : ""}${entry.shared ? " · Shared" : " · Local"} · ${inactive ? "Inactive" : `Status ${escapeHtml(entry.status)}`}</small></div><span class="storage-usage"><i class="health-dot is-${tone}" aria-hidden="true"></i>${usage}</span><small>${capacity}</small>${entry.usagePercent === null ? "" : `<progress max="100" value="${entry.usagePercent}" aria-label="${escapeHtml(entry.name)} storage use">${entry.usagePercent}%</progress>`}</article>`;
  }).join("")}</div>`;
}

function renderProxmoxPage() {
  const snapshot = infrastructureHealth();
  const selectedEnvironment = selectedInfrastructureEnvironment(snapshot);
  const nodes = snapshot.nodes.filter((node) => selectedEnvironment === "all" || node.environmentId === selectedEnvironment);
  const storage = snapshot.storage.filter((entry) => selectedEnvironment === "all" || entry.environmentId === selectedEnvironment);
  const loading = state.infrastructure.loading && !state.infrastructure.loaded;
  return `<section class="detail-page infrastructure-inventory-page infrastructure-proxmox-page" id="infrastructure-proxmox">
    <header class="detail-hero"><div class="proxmox-hero__identity"><span class="proxmox-hero__mark">${proxmoxBrandLinkMarkup()}</span><div><span class="section-kicker">Virtualization topology</span><h2>Proxmox</h2><p>Environments, physical nodes, storage inventory, and confirmed guest power controls in one view.</p></div></div><div class="button-row"><button class="button" type="button" data-action="refresh-live">${icon("refresh")} Check now</button><button class="button button--primary" type="button" data-action="open-infrastructure-target">${icon("plus")} Connect and discover</button></div></header>
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
    <section class="glass-panel infrastructure-workload-panel"><div class="infrastructure-workload-table" role="group" aria-label="Proxmox workloads">
      <div class="workload-row workload-row--header" aria-hidden="true"><span>Name</span><span>Type / VMID</span><span>Environment</span><span>Node</span><span>State</span><span>Memory</span><span></span></div>
      ${workloads.length ? workloads.map((workload) => `<button class="workload-row" type="button" data-action="open-infrastructure-workload" data-infrastructure-workload-id="${escapeHtml(workload.id)}"><span class="workload-name"><i class="workload-type is-${escapeHtml(workload.type)}">${workloadIconMarkup(workload.type)}</i><span><strong>${escapeHtml(workload.name)}</strong>${workload.template ? "<small>Template</small>" : ""}</span></span><span><b>${escapeHtml(workload.kind)}</b><small>${workload.vmid ?? "—"}</small></span><span>${escapeHtml(workload.environmentName)}</span><span>${escapeHtml(workload.node)}</span><span class="workload-state is-${escapeHtml(workload.status)}"><i></i>${escapeHtml(workload.status)}</span><span><b>${escapeHtml(formatMetricRatio(workload.memoryUsedBytes, workload.memoryTotalBytes))}</b><small>${workload.memoryUsedBytes === null ? "—" : formatMetricBytes(workload.memoryUsedBytes)}</small></span>${icon("chevron")}</button>`).join("") : `<div class="empty-state"><strong>No matching workloads</strong><span>Adjust the filters or wait for the first inventory cycle.</span></div>`}
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
  if (snapshotIsCached()) return null;
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
  const logsHref = loggingContextHref({
    view: "loki",
    service: "portainer",
    containerId: container.id
  });
  return `<article class="portainer-container-row is-${tone}" data-portainer-container-key="${escapeHtml(container.key)}" tabindex="-1" aria-label="${escapeHtml(`${container.name}, ${portainerContainerStateLabel(container)}`)}">
    <div class="portainer-container-identity"><span class="portainer-container-mark">${workloadIconMarkup("lxc")}</span><span><strong>${escapeHtml(container.name)}</strong><small>Container ${escapeHtml(container.shortId)}</small><code title="${escapeHtml(container.image)}">${escapeHtml(container.image)}</code></span></div>
    <div class="portainer-container-placement"><span>Stack</span><strong>${escapeHtml(container.stack || "Standalone")}</strong><small>${container.stack ? "Compose-managed container" : "Not assigned to a visible stack"}</small></div>
    <div class="portainer-container-runtime"><span>Runtime</span><span class="portainer-status is-${tone}"><i class="health-dot is-${tone}"></i>${escapeHtml(portainerContainerStateLabel(container))}</span><small>${escapeHtml(container.status)}</small></div>
    <div class="portainer-container-ports"><span>Ports</span>${ports.length ? `<div>${ports.map((port) => `<code>${escapeHtml(port)}</code>`).join("")}</div>` : `<small>No ports reported</small>`}</div>
    <div class="portainer-container-actions"><span>Actions</span><a class="portainer-container-log-link" href="${escapeHtml(logsHref)}">View logs ${icon("chevron")}</a>${renderPortainerContainerControls(container)}</div>
  </article>`;
}

function renderPortainerContainerGroups(containers, offset = 0) {
  const groups = groupedPortainerContainers(containers);
  if (!groups.length) return `<div class="empty-state"><strong>No matching containers</strong><span>Adjust the filters or wait for the next Portainer inventory cycle.</span></div>`;
  return `<div class="portainer-container-groups">${groups.map((group, index) => {
    const titleId = `portainer-container-group-${offset + index}`;
    return `<section class="portainer-container-group" aria-labelledby="${titleId}"><header class="portainer-container-group__header"><span class="portainer-environment-mark">${icon("server")}</span><div><span>Portainer environment</span><h4 id="${titleId}">${escapeHtml(group.serverName)} · ${escapeHtml(group.environmentName)}</h4></div><span class="count-pill">${group.containers.length} container${group.containers.length === 1 ? "" : "s"}</span></header><div class="portainer-container-list">${group.containers.map(renderPortainerContainer).join("")}</div></section>`;
  }).join("")}</div>`;
}

const PORTAINER_OPEN_KEY = "helmsman.portainerOpen";

function portainerOpenState() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(PORTAINER_OPEN_KEY) || "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

// A single connection starts open; with several, each starts closed until
// the owner opens it, and the choice is remembered in this browser.
function portainerInstanceOpen(id, count) {
  const saved = portainerOpenState()[id];
  return typeof saved === "boolean" ? saved : count === 1;
}

function rememberPortainerInstance(id, open) {
  const saved = portainerOpenState();
  saved[id] = Boolean(open);
  try {
    globalThis.localStorage?.setItem(PORTAINER_OPEN_KEY, JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-32))));
  } catch {
    // Storage may be blocked; the section still opens and closes.
  }
}

document.addEventListener("toggle", (event) => {
  const instance = event.target?.closest?.(".portainer-instance");
  if (!instance || instance !== event.target) return;
  const filters = state.infrastructure?.portainerFilters;
  const filtering = filters && (filters.search.trim() !== "" || filters.state !== "all" || filters.environment !== "all");
  if (!filtering) rememberPortainerInstance(String(instance.dataset.portainerInstance || ""), instance.open);
}, true);

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

    <section class="portainer-panel portainer-find"><header><div><span class="section-kicker">Container inventory</span><h3>Find containers</h3><p>Stopped and exited containers are informational. Unhealthy, dead, and restarting containers are clearly flagged. Filters apply to every connection below.</p></div><span class="count-pill">${filtered.containers.length}</span></header>
      <div class="portainer-notice">${icon("shield")}<span><strong>Guarded container controls</strong><small>Every command opens a Helmsman confirmation. Remove, recreate, force-kill, and stack deployment actions remain unavailable.</small></span></div>
      <div class="portainer-filterbar">
        <label><span>Server</span><select id="portainer-server-filter" data-portainer-filter="server"><option value="all">All Portainer servers</option>${services.map((service) => `<option value="${escapeHtml(service.id)}" ${filters.server === service.id ? "selected" : ""}>${escapeHtml(service.displayName)}</option>`).join("")}</select></label>
        <label><span>Environment</span><select id="portainer-environment-filter" data-portainer-filter="environment"><option value="all">All environments</option>${environments.map((environment) => `<option value="${escapeHtml(environment.key)}" ${filters.environment === environment.key ? "selected" : ""}>${escapeHtml(environment.name)} · ${escapeHtml(environment.serverName)}</option>`).join("")}</select></label>
        <label><span>State</span><select id="portainer-state-filter" data-portainer-filter="state"><option value="all">All states</option><option value="running" ${filters.state === "running" ? "selected" : ""}>Running</option><option value="stopped" ${filters.state === "stopped" ? "selected" : ""}>Stopped / created</option><option value="unhealthy" ${filters.state === "unhealthy" ? "selected" : ""}>Unhealthy</option><option value="restarting" ${filters.state === "restarting" ? "selected" : ""}>Restarting</option><option value="dead" ${filters.state === "dead" ? "selected" : ""}>Dead</option><option value="paused" ${filters.state === "paused" ? "selected" : ""}>Paused</option></select></label>
        <label class="filter-search"><span>Name, image, stack, or ID</span><input id="portainer-container-search" type="search" data-portainer-filter="search" value="${escapeHtml(filters.search)}" placeholder="Search containers" /></label>
        <span class="filter-result-count">${filtered.containers.length} result${filtered.containers.length === 1 ? "" : "s"}</span>
      </div>
    </section>

    ${selectedServices.length ? `<div class="portainer-instances">${(() => {
      let groupOffset = 0;
      const filtering = filters.search.trim() !== "" || filters.state !== "all" || filters.environment !== "all";
      return selectedServices.map((service) => {
        const ownEnvironments = filtered.environments.filter((environment) => String(environment.key || "").startsWith(`${service.id}:`));
        const ownContainers = filtered.containers.filter((container) => container.serverId === service.id);
        const ownStacks = filtered.stacks.filter((stack) => stack.serverId === service.id);
        const allContainers = service.inventory.containers;
        const unhealthy = allContainers.filter(({ health }) => health === "unhealthy").length;
        const running = allContainers.filter(({ state: containerState }) => containerState === "running").length;
        const open = filtering ? ownContainers.length > 0 : portainerInstanceOpen(service.id, selectedServices.length);
        const groups = renderPortainerContainerGroups(ownContainers, groupOffset);
        groupOffset += groupedPortainerContainers(ownContainers).length;
        return `<details class="portainer-instance" data-portainer-instance="${escapeHtml(service.id)}" ${open ? "open" : ""}>
          <summary class="portainer-instance__summary">
            <span class="portainer-mark">${serviceIconMarkup("portainer", "P")}</span>
            <span class="portainer-instance__name"><small>${escapeHtml(service.typeName)}</small><strong>${escapeHtml(service.displayName)}</strong></span>
            <span class="portainer-instance__facts">${running}/${allContainers.length} running · ${service.metrics.environmentOnline}/${service.metrics.environmentTotal} environments${unhealthy ? ` · <b>${unhealthy} need${unhealthy === 1 ? "s" : ""} attention</b>` : ""}${filtering ? ` · ${ownContainers.length} match${ownContainers.length === 1 ? "" : "es"}` : ""}</span>
            <span class="portainer-status is-${statusClass(service.state)}"><i class="health-dot is-${statusClass(service.state)}"></i>${escapeHtml(statusLabel(service.state))}</span>
            <span class="portainer-instance__chevron">${icon("chevron")}</span>
          </summary>
          <div class="portainer-instance__body">
            ${renderPortainerConnection(service)}
            <section class="portainer-instance__section"><h4>Environments <span class="count-pill">${ownEnvironments.length}</span></h4>
              ${ownEnvironments.length ? `<div class="portainer-environment-grid">${ownEnvironments.map((environment) => `<article class="portainer-environment-card"><header><span class="portainer-environment-mark">${icon("server")}</span><span><small>${escapeHtml(environment.serverName)}</small><strong>${escapeHtml(environment.name)}</strong></span><span class="portainer-status is-${portainerEnvironmentTone(environment.state)}"><i class="health-dot is-${portainerEnvironmentTone(environment.state)}"></i>${escapeHtml(environment.state)}</span></header><dl class="portainer-summary-grid"><div><dt>Platform</dt><dd>${escapeHtml(environment.platform)}</dd></div><div><dt>Containers</dt><dd>${environmentContainerCounts.get(environment.key) || 0}</dd></div><div><dt>Agent</dt><dd>${escapeHtml(environment.agentVersion || "—")}</dd></div><div><dt>Connection</dt><dd>${environment.edge ? "Edge" : "Direct"}</dd></div></dl></article>`).join("")}</div>` : `<div class="empty-state"><strong>No permitted environments yet</strong><span>Verify that this Portainer user can access at least one environment.</span></div>`}
            </section>
            <section class="portainer-instance__section"><h4>Containers <span class="count-pill">${ownContainers.length}</span></h4>${groups}</section>
            <section class="portainer-instance__section"><h4>Stacks <span class="count-pill">${ownStacks.length}</span></h4>${ownStacks.length ? `<div class="portainer-stack-grid">${ownStacks.map((stack) => `<article class="portainer-stack-card"><header><span class="portainer-environment-mark">${icon("library")}</span><span><small>${escapeHtml(stack.serverName)} · ${escapeHtml(stack.environmentName)}</small><strong>${escapeHtml(stack.name)}</strong></span><span class="portainer-status is-${stack.state === "active" ? "healthy" : "stale"}"><i class="health-dot is-${stack.state === "active" ? "healthy" : "stale"}"></i>${escapeHtml(stack.state)}</span></header><footer><span>Stack ${stack.id}</span><time>${escapeHtml(formatTime(stack.updatedAt || stack.createdAt, "Timestamp unavailable"))}</time></footer></article>`).join("")}</div>` : `<div class="empty-state"><strong>No visible stacks</strong><span>This Portainer user has not returned any stack records for this filter.</span></div>`}</section>
          </div>
        </details>`;
      }).join("");
    })()}</div>` : ""}
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

const LAUNCHPAD_KINDS = new Set(["media", "environment", "service"]);

function safeLaunchHref(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return "";
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function launchHostLabel(href) {
  try {
    const parsed = new URL(href);
    return `${parsed.host}${parsed.pathname !== "/" ? parsed.pathname.replace(/\/$/u, "") : ""}`;
  } catch {
    return href;
  }
}

function savedLaunchAddress(kind, id) {
  const link = state.launchpad.links.find((entry) => entry.kind === kind && entry.id === id);
  return safeLaunchHref(link?.url || "");
}

function launchpadEntries() {
  const operations = normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []);
  const media = (state.config?.services || [])
    .filter((service) => service.configured && SERVICE_ORDER.includes(service.id))
    .sort((left, right) => SERVICE_ORDER.indexOf(left.id) - SERVICE_ORDER.indexOf(right.id))
    .map((service) => {
      const health = operations.services.find(({ id }) => id === service.id);
      return {
        kind: "media",
        id: service.id,
        provider: service.id,
        name: service.name || service.id,
        role: service.role || "Media service",
        connectionUrl: safeLaunchHref(service.url),
        state: statusClass(health?.state || "stale")
      };
    });
  const infrastructure = configuredInfrastructureSnapshotForUi();
  const environments = infrastructure.targets
    .filter((target) => target.enabled !== false)
    .map((target) => ({
      kind: "environment",
      id: target.id,
      provider: "proxmox",
      name: target.displayName || "Proxmox VE",
      role: `Proxmox VE · ${target.environmentKind === "cluster" ? "Cluster" : "Virtualization"}`,
      connectionUrl: safeLaunchHref(target.url),
      state: statusClass(target.state)
    }));
  const portainers = configuredPortainerServicesForUi()
    .filter((service) => service.enabled !== false)
    .map((service) => ({
      kind: "service",
      id: service.id,
      provider: "portainer",
      name: service.displayName || "Portainer",
      role: "Portainer · Containers",
      connectionUrl: safeLaunchHref(service.url),
      state: statusClass(service.state)
    }));
  return [...media, ...environments, ...portainers].map((entry) => {
    const externalUrl = savedLaunchAddress(entry.kind, entry.id);
    return { ...entry, externalUrl, href: externalUrl || entry.connectionUrl };
  });
}

function renderLaunchpadTile(entry) {
  const stateName = entry.state === "disabled" ? "disabled" : entry.state;
  const host = entry.href ? launchHostLabel(entry.href) : "No address available";
  const addressKind = entry.externalUrl ? "External" : "Local";
  const mark = entry.provider === "proxmox"
    ? `<span class="launchpad-tile__icon">${proxmoxBrandLinkMarkup()}</span>`
    : `<span class="launchpad-tile__icon" aria-hidden="true">${serviceIconMarkup(entry.provider, entry.name.slice(0, 1))}</span>`;
  const body = `<span class="launchpad-tile__copy"><strong>${escapeHtml(entry.name)}${entry.href ? icon("external") : ""}</strong><small>${escapeHtml(entry.role)}</small></span>
      <span class="launchpad-tile__meta"><span class="launchpad-tile__state is-${escapeHtml(stateName)}"><i class="health-dot is-${escapeHtml(stateName)}" aria-hidden="true"></i>${escapeHtml(statusLabel(stateName))}</span><span class="launchpad-tile__host" title="${escapeHtml(entry.href || "")}"><em>${addressKind}</em>${escapeHtml(host)}</span></span>`;
  const link = entry.href
    ? `<a class="launchpad-tile__link" href="${escapeHtml(entry.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(entry.name)} (opens in a new tab)">${body}</a>`
    : `<div class="launchpad-tile__link is-unavailable">${body}</div>`;
  const searchText = `${entry.name} ${entry.role}`.toLowerCase();
  const filter = state.launchpad.filter.trim().toLowerCase();
  return `<li class="launchpad-tile" data-launchpad-search="${escapeHtml(searchText)}"${filter && !searchText.includes(filter) ? " hidden" : ""}>${link}${mark}<button class="icon-button launchpad-tile__edit" type="button" data-action="edit-launch-address" data-launch-kind="${escapeHtml(entry.kind)}" data-launch-id="${escapeHtml(entry.id)}" aria-label="Set the external address for ${escapeHtml(entry.name)}" title="External address">${icon("edit")}</button></li>`;
}

function renderLaunchpadGroup(title, entries, id) {
  if (!entries.length) return "";
  const filter = state.launchpad.filter.trim().toLowerCase();
  const anyVisible = !filter || entries.some((entry) => `${entry.name} ${entry.role}`.toLowerCase().includes(filter));
  return `<section class="launchpad-group" aria-labelledby="${id}"${anyVisible ? "" : " hidden"}>
      <header><h3 id="${id}">${escapeHtml(title)}</h3><span class="launchpad-count">${entries.length}</span></header>
      <ul class="launchpad-grid">${entries.map(renderLaunchpadTile).join("")}</ul>
    </section>`;
}

function renderLaunchpadPage() {
  const all = launchpadEntries();
  const filter = state.launchpad.filter.trim().toLowerCase();
  const anyVisible = !filter || all.some((entry) => `${entry.name} ${entry.role}`.toLowerCase().includes(filter));
  const media = all.filter(({ kind }) => kind === "media");
  const infrastructure = all.filter(({ kind }) => kind !== "media");
  const count = all.length;
  const content = !count
    ? `<section class="launchpad-empty">${icon("launchpad")}<h3>No connected services yet</h3><p>Services appear here as soon as you connect them. Add media services under Media Connections, or Proxmox and Portainer under Infrastructure Connectors.</p><div class="button-row"><button class="button button--primary" type="button" data-action="switch-workspace" data-workspace="media" data-workspace-route="connections">Media connections</button><button class="button" type="button" data-action="switch-workspace" data-workspace="infrastructure" data-workspace-route="connectors">Infrastructure connectors</button></div></section>`
    : `<section class="launchpad-empty launchpad-empty--filter" data-launchpad-no-match${anyVisible ? " hidden" : ""}>${icon("search")}<h3>No matching services</h3><p>No connected service matches that search.</p></section>${renderLaunchpadGroup("Media", media, "launchpad-media-title")}${renderLaunchpadGroup("Infrastructure", infrastructure, "launchpad-infrastructure-title")}`;
  return `<div class="page launchpad-page">
    <section class="page-intro launchpad-intro">
      <div><span class="section-kicker">${count} connected service${count === 1 ? "" : "s"}</span><h2>Launchpad</h2><p>Open any connected service in a new tab. External addresses are used first, then the local connection address.</p></div>
      ${count ? `<label class="launchpad-search">${icon("search")}<span class="sr-only">Find a service</span><input id="launchpad-search" type="search" data-launchpad-filter autocomplete="off" spellcheck="false" maxlength="80" placeholder="Find a service" value="${escapeHtml(state.launchpad.filter)}" /></label>` : ""}
    </section>
    ${state.launchpad.error ? `<p class="launchpad-notice" role="status">${escapeHtml(state.launchpad.error)}</p>` : ""}
    ${content}
  </div>`;
}

function applyLaunchpadFilter() {
  const filter = state.launchpad.filter.trim().toLowerCase();
  const page = main.querySelector(".launchpad-page");
  if (!page) return;
  let visibleCount = 0;
  page.querySelectorAll(".launchpad-group").forEach((group) => {
    let groupVisible = 0;
    group.querySelectorAll(".launchpad-tile").forEach((tile) => {
      const matches = !filter || String(tile.dataset.launchpadSearch || "").includes(filter);
      tile.hidden = !matches;
      if (matches) groupVisible += 1;
    });
    group.hidden = groupVisible === 0;
    visibleCount += groupVisible;
  });
  const noMatch = page.querySelector("[data-launchpad-no-match]");
  if (noMatch) noMatch.hidden = visibleCount > 0;
}

async function loadLaunchpadLinks({ render = true } = {}) {
  if (!state.status?.authenticated || state.launchpad.loading) return;
  state.launchpad.loading = true;
  try {
    const payload = await api("/api/v2/launchpad");
    state.launchpad.links = Array.isArray(payload?.links)
      ? payload.links.filter((link) => LAUNCHPAD_KINDS.has(link?.kind) && typeof link?.id === "string" && safeLaunchHref(link?.url))
      : [];
    state.launchpad.error = "";
  } catch {
    state.launchpad.error = "Saved external addresses could not be loaded, so local connection addresses are shown.";
  } finally {
    state.launchpad.loaded = true;
    state.launchpad.loading = false;
  }
  if (render && currentRoute() === "launchpad") {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
  }
}

function openLaunchAddress(kind, id) {
  const entry = launchpadEntries().find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!entry) return showToast("That connection is no longer available.", "danger");
  openModal(`<section class="modal-card modal-card--launchpad" role="dialog" aria-modal="true" aria-labelledby="launch-address-title">
    <header class="modal-card__header"><span class="launchpad-modal__icon">${entry.provider === "proxmox" ? proxmoxBrandLinkMarkup() : serviceIconMarkup(entry.provider, entry.name.slice(0, 1))}</span><div><span class="section-kicker">Launchpad</span><h2 id="launch-address-title" tabindex="-1">${escapeHtml(entry.name)}</h2><p>Set the address your browser should open.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="launch-address-form" data-launch-kind="${escapeHtml(entry.kind)}" data-launch-id="${escapeHtml(entry.id)}" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <label><span>External address</span><input id="launch-address-url" name="url" type="url" inputmode="url" autocapitalize="off" spellcheck="false" maxlength="500" value="${escapeHtml(entry.externalUrl)}" placeholder="https://${escapeHtml(entry.provider)}.example.com" /><small>Used first, for example a reverse-proxy or VPN hostname. Helmsman never connects to this address; it only opens it in your browser.</small></label>
        <div class="launchpad-fallback"><span>Local fallback</span><code>${escapeHtml(entry.connectionUrl || "No connection address")}</code></div>
        <p class="form-error" id="launch-address-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${entry.externalUrl ? `<button class="button button--danger" type="button" data-action="clear-launch-address" data-launch-kind="${escapeHtml(entry.kind)}" data-launch-id="${escapeHtml(entry.id)}">Use local address</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button button--primary" type="submit">Save address</button></div></footer>
    </form>
  </section>`, "#launch-address-url");
}

async function saveLaunchAddress(kind, id, url, form = null) {
  if (!LAUNCHPAD_KINDS.has(kind) || !/^[a-z0-9-]{1,64}$/u.test(id)) return;
  const error = form?.querySelector("#launch-address-error");
  const submit = form?.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (submit) {
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
  }
  try {
    const payload = await api(`/api/v2/launchpad/${kind}/${encodeURIComponent(id)}`, url
      ? { method: "PUT", body: { url } }
      : { method: "DELETE" });
    state.launchpad.links = Array.isArray(payload?.links) ? payload.links : [];
    state.launchpad.loaded = true;
    state.launchpad.error = "";
    closeModal();
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast(url ? "External address saved." : "The Launchpad will use the local address.", "success");
  } catch (caught) {
    if (error) error.textContent = caught.message;
    else showToast(caught.message, "danger");
  } finally {
    if (submit?.isConnected) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  }
}

function submitLaunchAddress(form) {
  if (!form.reportValidity()) return;
  const url = String(new FormData(form).get("url") || "").trim();
  saveLaunchAddress(form.dataset.launchKind, form.dataset.launchId, url, form);
}

// Network ---------------------------------------------------------------
// The 3D network model. Its markup is a stable shell; the controller in
// network-map.js owns the scene and panel inside it, keeps the camera and
// draft across repaints, and recolours items from each monitor snapshot.

let networkMapController = null;

function networkLiveInventory() {
  const infrastructure = configuredInfrastructureSnapshotForUi();
  const portainers = configuredPortainerServicesForUi();
  const operations = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  return {
    nodes: infrastructure.nodes,
    workloads: infrastructure.workloads,
    environments: infrastructure.targets.map((target) => ({ id: target.id, name: target.displayName })),
    containers: portainers.flatMap((service) => service.inventory?.containers || []),
    portainerEnvironments: portainers.flatMap((service) => (service.inventory?.environments || [])
      .map((environment) => ({ id: environment.id, name: environment.name, serverId: service.id, serverName: service.displayName }))),
    services: operations.services
      .filter((service) => !/^(proxmox|portainer)-/u.test(service.id))
      .map((service) => ({ id: service.id, name: service.name, state: service.state, connectionState: service.connectionState }))
  };
}

function networkController() {
  if (!networkMapController) {
    networkMapController = createNetworkMapController({
      setMarkup,
      escapeHtml,
      icon,
      toast: showToast,
      live: networkLiveInventory,
      loadMap: async () => (await api("/api/v2/network-map"))?.networkMap,
      saveMap: async (map, revision) => (await api("/api/v2/network-map", { method: "PUT", body: { map, revision } }))?.networkMap
    });
  }
  return networkMapController;
}

function renderNetworkPage() {
  return `<div class="page network-page" data-network-root></div>`;
}

function syncNetworkPage({ live = false } = {}) {
  const root = main?.querySelector?.("[data-network-root]");
  const active = state.status?.authenticated && state.workspace === "infrastructure" && state.route === "network" && root;
  if (!active) {
    networkMapController?.unmount();
    return;
  }
  const controller = networkController();
  if (!controller.isMountedOn(root)) controller.mount(root);
  else if (live) controller.refreshLive();
}

// Manual ----------------------------------------------------------------
// The owner's Markdown manual lives in the data volume. The page renders it
// through the escaping subset in manual-markdown.js and keeps every edit in
// a modal so monitor repaints of the page never touch an open draft.

const MANUAL_MARKDOWN_LIMIT = 256 * 1024;

function emptyManualState() {
  return {
    loaded: false,
    loading: false,
    error: "",
    markdown: "",
    revision: null,
    updatedAt: null,
    parsed: null,
    filter: "",
    draft: null,
    saving: false,
    pendingTarget: "",
    pendingHighlight: ""
  };
}

function manualDocument() {
  if (!state.manual.parsed) state.manual.parsed = parseManual(state.manual.markdown);
  return state.manual.parsed;
}

function applyManualPayload(manual) {
  const markdown = typeof manual?.markdown === "string" ? manual.markdown : "";
  state.manual.markdown = markdown;
  state.manual.revision = typeof manual?.revision === "string" ? manual.revision : null;
  state.manual.updatedAt = typeof manual?.updatedAt === "string" ? manual.updatedAt : null;
  state.manual.parsed = null;
  state.manual.loaded = true;
  state.manual.error = "";
}

async function loadManual({ render = true } = {}) {
  if (!state.status?.authenticated || state.manual.loading) return;
  state.manual.loading = true;
  try {
    const payload = await api("/api/v2/manual");
    applyManualPayload(payload?.manual);
  } catch (error) {
    state.manual.error = error?.code === "MANUAL_UNAVAILABLE"
      ? "The manual is unavailable because Helmsman could not open its data volume file."
      : "The manual could not be loaded. Check the Helmsman server and refresh.";
  } finally {
    state.manual.loading = false;
  }
  if (render && currentRoute() === "manual") {
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    applyManualFilter();
  }
}

function formatManualBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function renderManualEmpty() {
  return `<section class="manual-empty">
      ${icon("book")}
      <h3>No manual yet</h3>
      <p>Drop a Markdown or text file here, or write your infrastructure manual in Markdown: hosts, addresses, recovery steps, known issues. It is stored privately in <code>manual.json</code> in this server's data volume and becomes searchable from the top bar.</p>
      <ul class="manual-empty__tips">
        <li><code>## Heading</code> starts a section</li>
        <li>Tables with <code>| a | b |</code> rows</li>
        <li><code>&gt; [!WARNING]</code> makes a callout</li>
        <li>Cells reading Pending, Healthy or Critical become status badges</li>
      </ul>
      <p class="manual-empty__guide">The editor's <strong>Formatting help</strong> lists everything the manual understands.</p>
      <div class="button-row"><button class="button button--primary" type="button" data-action="edit-manual">${icon("edit")} ${state.manual.draft !== null && state.manual.draft !== state.manual.markdown ? "Continue editing" : "Write the manual"}</button>${renderManualImportControl()}<button class="button" type="button" data-action="manual-use-template">${icon("library")} Start from template</button></div>
    </section>`;
}

function renderManualToc(documentModel) {
  const items = documentModel.sections.map((section) => `<li data-manual-toc="${escapeHtml(section.id)}"><button type="button" data-action="manual-jump" data-manual-target="${escapeHtml(section.id)}">${escapeHtml(section.title)}</button></li>`).join("");
  return `<nav class="manual-toc" aria-label="Manual sections">
      <span class="section-kicker">Contents</span>
      <ol>${items}</ol>
    </nav>`;
}

function renderManualSections(documentModel) {
  const intro = documentModel.intro.html
    ? `<section class="manual-section manual-section--intro" id="${escapeHtml(documentModel.intro.id)}" data-manual-section="${escapeHtml(documentModel.intro.id)}"><div class="manual-body">${documentModel.intro.html}</div></section>`
    : "";
  const sections = documentModel.sections.map((section) => `<section class="manual-section" id="${escapeHtml(section.id)}" data-manual-section="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-title">
      <header><h3 id="${escapeHtml(section.id)}-title">${escapeHtml(section.title)}</h3></header>
      <div class="manual-body">${section.html || "<p class=\"manual-muted\">This section is empty.</p>"}</div>
    </section>`).join("");
  return intro + sections;
}

function renderManualPage() {
  const manual = state.manual;
  if (!manual.loaded && !manual.error) {
    return `<div class="page manual-page"><section class="manual-empty manual-empty--loading">${icon("book")}<h3>Loading the manual</h3></section></div>`;
  }
  const documentModel = manual.loaded ? manualDocument() : null;
  const hasContent = Boolean(manual.markdown.trim());
  const draftPending = manual.draft !== null && manual.draft !== manual.markdown;
  const updated = manual.updatedAt ? `Updated ${formatTime(manual.updatedAt)}` : "Not written yet";
  const sectionCount = documentModel?.sections.length || 0;
  const kicker = hasContent ? `${sectionCount} section${sectionCount === 1 ? "" : "s"} · ${updated}` : "Owner manual";
  const title = documentModel?.title || "Manual";
  const body = manual.error
    ? `<p class="launchpad-notice" role="status">${escapeHtml(manual.error)}</p>`
    : !hasContent
      ? renderManualEmpty()
      : `<div class="manual-layout">
          ${renderManualToc(documentModel)}
          <div class="manual-content">
            <section class="launchpad-empty launchpad-empty--filter manual-no-match" data-manual-no-match hidden>${icon("search")}<h3>Nothing in the manual matches</h3><p>Try another word, an address or a VMID.</p><button class="button" type="button" data-action="clear-manual-filter">Clear search</button></section>
            ${renderManualSections(documentModel)}
          </div>
        </div>`;
  return `<div class="page manual-page">
    ${manual.loaded ? `<div class="manual-drop-overlay" aria-hidden="true">${icon("book")}<strong>Drop to load into the editor</strong><span>Markdown or text, up to 256 KiB. Nothing is saved until you choose Save manual.</span></div>` : ""}
    <section class="page-intro launchpad-intro manual-intro">
      <div><span class="section-kicker">${escapeHtml(kicker)}</span><h2>${escapeHtml(title)}</h2><p>Your own operations manual, kept in the data volume. Press <kbd>/</kbd> anywhere to search it alongside pages, services and workloads.</p></div>
      <div class="manual-intro__actions">
        ${hasContent ? `<label class="launchpad-search manual-search">${icon("search")}<span class="sr-only">Find in the manual</span><input id="manual-filter" type="search" data-manual-filter autocomplete="off" spellcheck="false" maxlength="80" placeholder="Find in the manual" value="${escapeHtml(manual.filter)}" /></label>` : ""}
        ${manual.loaded && hasContent ? `${renderManualImportControl()}<button class="button" type="button" data-action="edit-manual">${icon("edit")} ${draftPending ? "Continue editing" : "Edit"}</button>` : ""}
      </div>
    </section>
    ${body}
  </div>`;
}

// Highlight every occurrence of the query words inside an element by
// splitting text nodes. Only text is created, never markup.
function markManualMatches(root, words) {
  if (!root || !words.length) return null;
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "giu");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("mark, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let first = null;
  for (const node of nodes) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let index = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > index) fragment.append(document.createTextNode(text.slice(index, match.index)));
      const mark = document.createElement("mark");
      mark.className = "manual-mark";
      mark.textContent = match[0];
      fragment.append(mark);
      first ||= mark;
      index = match.index + match[0].length;
    }
    if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
    node.replaceWith(fragment);
  }
  return first;
}

function manualFilterWords(value) {
  return String(value || "").toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8);
}

function applyManualFilter() {
  const page = main.querySelector(".manual-page");
  if (!page || !state.manual.loaded) return;
  const documentModel = manualDocument();
  const words = manualFilterWords(state.manual.filter);
  const htmlById = new Map([[documentModel.intro.id, documentModel.intro.html], ...documentModel.sections.map(({ id, html }) => [id, html])]);
  let visible = 0;
  page.querySelectorAll("[data-manual-section]").forEach((section) => {
    const id = section.dataset.manualSection;
    const body = section.querySelector(".manual-body");
    if (body && htmlById.has(id)) setMarkup(body, htmlById.get(id) || "");
    const text = section.textContent.toLowerCase();
    const matches = !words.length || words.every((word) => text.includes(word));
    section.hidden = !matches;
    if (matches) {
      visible += 1;
      if (words.length) markManualMatches(body, words);
    }
    const tocEntry = page.querySelector(`[data-manual-toc="${CSS.escape(id)}"]`);
    if (tocEntry) tocEntry.hidden = !matches;
  });
  const noMatch = page.querySelector("[data-manual-no-match]");
  if (noMatch) noMatch.hidden = visible > 0;
  if (filterAnnouncer && words.length) {
    filterAnnouncer.textContent = visible ? `${visible} manual section${visible === 1 ? "" : "s"} match.` : "No manual sections match.";
  }
}

function setManualFilter(value, { rerenderInput = true } = {}) {
  state.manual.filter = String(value || "").slice(0, 80);
  if (rerenderInput) {
    const input = main.querySelector("#manual-filter");
    if (input) input.value = state.manual.filter;
  }
  applyManualFilter();
}

// Overview rows and signal tiles lead to the page that holds the detail.
// Pages can render after data arrives, so the target is looked for over a
// few frames before giving up quietly.
function revealWhenRendered(find, { attempts = 40, onFound = null } = {}) {
  const tick = (remaining) => {
    const element = find();
    if (element) {
      scrollManualElementIntoView(element);
      onFound?.(element);
      // A refresh that lands right after navigation can replace the page;
      // follow the target into the new markup.
      setTimeout(() => {
        if (!element.isConnected && remaining > 0) tick(remaining - 1);
      }, 400);
      return;
    }
    if (remaining > 0) setTimeout(() => tick(remaining - 1), 50);
  };
  requestAnimationFrame(() => tick(attempts));
}

async function openOverviewService(kind, id) {
  const serviceId = String(id || "");
  if (!serviceId) return;
  if (kind === "media") {
    await switchWorkspace("media", "health");
    revealWhenRendered(() => [...main.querySelectorAll(".operations-service[data-service-id]")]
      .find((element) => element.dataset.serviceId === serviceId)?.closest("li") || null);
    return;
  }
  if (kind === "proxmox") {
    await switchWorkspace("infrastructure", "proxmox");
    openInfrastructureEnvironmentDetail(serviceId);
    return;
  }
  if (kind === "portainer") {
    rememberPortainerInstance(serviceId, true);
    await switchWorkspace("infrastructure", "portainer");
    revealWhenRendered(() => [...main.querySelectorAll(".portainer-instance")]
      .find((element) => element.dataset.portainerInstance === serviceId) || null, {
      onFound: (element) => { element.open = true; }
    });
  }
}

// The environment whose recent activity explains a failed-task or backup
// signal: the first one reporting failures, otherwise the first one.
function environmentForActivitySignal(signal) {
  const environments = infrastructureHealth().targets || [];
  const failing = environments.find((environment) => (environment.activity || []).some((entry) => (
    entry.status !== "success" && (signal !== "backups" || /vzdump|backup/iu.test(String(entry.type || "")))
  )));
  return failing || environments[0] || null;
}

async function openInfrastructureSignal(signal) {
  if (signal === "guests") {
    await switchWorkspace("infrastructure", "workloads");
    return;
  }
  if (signal === "tasks" || signal === "backups") {
    const environment = environmentForActivitySignal(signal);
    if (!environment) return showToast("No Proxmox environment is reporting activity yet.", "info");
    openInfrastructureEnvironmentDetail(environment.id);
    revealWhenRendered(() => document.querySelector("#environment-recent-activity"));
    return;
  }
  const sectionId = signal === "storage" ? "proxmox-storage-title" : "proxmox-nodes-title";
  await switchWorkspace("infrastructure", "proxmox");
  revealWhenRendered(() => document.getElementById(sectionId)?.closest("section") || null);
}

function scrollManualElementIntoView(element) {
  if (!element) return;
  const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const block = element.matches("section, h3, h4") ? "start" : "center";
  element.scrollIntoView({ block, behavior: reduceMotion ? "auto" : "smooth" });
  element.classList.remove("is-manual-target");
  // Restart the highlight animation on repeated jumps to the same element.
  void element.offsetWidth;
  element.classList.add("is-manual-target");
  setTimeout(() => element.classList.remove("is-manual-target"), 2400);
}

function jumpToManualTarget(id) {
  const targetId = String(id || "");
  if (!targetId) return;
  let element = document.getElementById(targetId);
  if (element && element.closest("[data-manual-section]")?.hidden) {
    setManualFilter("");
    element = document.getElementById(targetId);
  }
  scrollManualElementIntoView(element);
  const focusable = element?.matches("h3, h4, section") ? element : null;
  if (focusable) {
    focusable.setAttribute("tabindex", "-1");
    focusable.focus({ preventScroll: true });
  }
}

function revealManualTarget() {
  const targetId = state.manual.pendingTarget;
  const highlight = state.manual.pendingHighlight;
  state.manual.pendingTarget = "";
  state.manual.pendingHighlight = "";
  if (!targetId || currentRoute() !== "manual") return;
  if (state.manual.filter) setManualFilter("");
  const element = document.getElementById(targetId);
  if (!element) return;
  const section = element.closest("[data-manual-section]");
  if (highlight && section) markManualMatches(section.querySelector(".manual-body") || section, manualFilterWords(highlight));
  scrollManualElementIntoView(element);
}

function manualEditorStatusText() {
  const draft = state.manual.draft ?? state.manual.markdown;
  const bytes = new TextEncoder().encode(draft).length;
  const over = bytes > MANUAL_MARKDOWN_LIMIT;
  const changed = draft !== state.manual.markdown;
  return {
    over,
    changed,
    text: `${formatManualBytes(bytes)} of 256 KiB${changed ? " · Unsaved changes" : " · Saved"}`
  };
}

function updateManualEditorStatus() {
  const status = modalLayer.querySelector("[data-manual-editor-status]");
  const save = modalLayer.querySelector("[data-action='save-manual']");
  const discard = modalLayer.querySelector("[data-action='discard-manual-draft']");
  const details = manualEditorStatusText();
  if (status) {
    status.textContent = details.over ? `${details.text} · Too large to save` : details.text;
    status.classList.toggle("is-over", details.over);
  }
  if (save) save.disabled = details.over || !details.changed || state.manual.saving;
  if (discard) discard.hidden = !details.changed;
  // Keep the page's button honest about a draft left open in the editor.
  const pageButton = main.querySelector(".manual-intro__actions [data-action='edit-manual'], .manual-empty [data-action='edit-manual']");
  const label = pageButton?.lastChild;
  if (label?.nodeType === Node.TEXT_NODE) {
    label.nodeValue = ` ${details.changed ? "Continue editing" : state.manual.markdown.trim() ? "Edit" : "Write the manual"}`;
  }
}

const MANUAL_FORMAT_GUIDE_URL = "https://github.com/nunesg130-boop/helmsman/blob/main/docs/MANUAL-FORMAT.md";

function renderManualFormattingHelp() {
  const rows = [
    ["# Title", "Page title (the first heading)"],
    ["## Heading", "New section and contents entry"],
    ["### Heading", "Subheading inside a section"],
    ["| A | B |\n|---|---|\n| 1 | 2 |", "Table; each row is a search result"],
    ["| … | Pending |", "State word in a cell becomes a badge"],
    ["| … | Pending — detail |", "Leading state word plus detail"],
    ["- item\n1. step", "Bulleted and numbered lists"],
    ["- [ ] task\n- [x] done", "Checklist items"],
    ["> [!WARNING] Title\n> Text", "Callout: NOTE, TIP, IMPORTANT, WARNING, CAUTION"],
    ["`code`  **bold**  *italic*", "Inline formatting"],
    ["[text](https://…)", "Link (opens in a new tab)"],
    ["```\ncommands\n```", "Code block"],
    ["---", "Divider"]
  ];
  return `<details class="manual-help">
      <summary>${icon("chevron")} Formatting help</summary>
      <div class="manual-help__body">
        <dl class="manual-help__list">${rows.map(([syntax, result]) => `<div><dt><code>${escapeHtml(syntax)}</code></dt><dd>${escapeHtml(result)}</dd></div>`).join("")}</dl>
        <p class="manual-help__states"><span class="manual-state is-healthy"><i aria-hidden="true"></i>Healthy</span><span class="manual-state is-warning"><i aria-hidden="true"></i>Pending</span><span class="manual-state is-danger"><i aria-hidden="true"></i>Critical</span><span class="manual-state is-info"><i aria-hidden="true"></i>Documented</span><span class="manual-state"><i aria-hidden="true"></i>Planned</span></p>
        <p class="manual-help__foot">Raw HTML and images are shown as text. Drop a .md or .txt file here to replace the text. <a href="${MANUAL_FORMAT_GUIDE_URL}" target="_blank" rel="noopener noreferrer">Full formatting guide</a></p>
      </div>
    </details>`;
}

async function useManualTemplate() {
  if (!state.manual.loaded) return;
  const editor = modalLayer.querySelector("#manual-editor");
  const current = editor ? editor.value : state.manual.draft ?? state.manual.markdown;
  if (current.trim() && current !== MANUAL_TEMPLATE) {
    const replace = await confirmControl({
      title: "Replace the editor text with the template?",
      message: "The current text in the editor is replaced. Nothing is saved until you choose Save manual, and Discard changes restores the saved manual.",
      confirmLabel: "Use template"
    });
    if (!replace) return;
  }
  state.manual.draft = MANUAL_TEMPLATE;
  if (editor) {
    editor.value = MANUAL_TEMPLATE;
    modalLayer.querySelector(".manual-editor__notice")?.remove();
    updateManualEditorStatus();
    editor.focus();
    editor.setSelectionRange(0, 0);
    editor.scrollTop = 0;
  } else {
    openManualEditor();
    modalLayer.querySelector(".manual-editor__notice")?.remove();
  }
}

function openManualEditor() {
  if (!state.manual.loaded) return;
  const restoring = state.manual.draft !== null && state.manual.draft !== state.manual.markdown;
  const value = state.manual.draft ?? state.manual.markdown;
  state.manual.draft = value;
  openModal(`<section class="modal-card modal-card--manual-editor" role="dialog" aria-modal="true" aria-labelledby="manual-editor-title" aria-describedby="manual-editor-description">
    <header class="modal-card__header"><span class="manual-editor__mark">${icon("book")}</span><div><span class="section-kicker">Manual</span><h2 id="manual-editor-title" tabindex="-1">Edit manual</h2><p id="manual-editor-description">Markdown, stored unencrypted in the data volume. Keep passwords, keys and tokens out of it.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <div class="modal-card__body manual-editor__body">
      ${restoring ? `<p class="manual-editor__notice" role="status">Your unsaved draft was restored.</p>` : ""}
      <label class="sr-only" for="manual-editor">Manual Markdown</label>
      <textarea id="manual-editor" class="manual-editor__input" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="# Homelab manual&#10;&#10;## Hosts&#10;| Host | Address | State |&#10;|---|---|---|&#10;| media-node | 10.20.0.10 | Healthy |">${escapeHtml(value)}</textarea>
      ${renderManualFormattingHelp()}
    </div>
    <footer class="modal-card__footer"><div class="manual-editor__meta"><button class="button button--compact" type="button" data-action="manual-use-template">${icon("library")} Start from template</button><span class="manual-editor__status" data-manual-editor-status aria-live="polite"></span></div><div class="modal-card__actions"><button class="button button--danger" type="button" data-action="discard-manual-draft" hidden>Discard changes</button><button class="button" type="button" data-action="close-modal">Close</button><button class="button button--primary" type="button" data-action="save-manual">Save manual</button></div></footer>
  </section>`, "#manual-editor");
  updateManualEditorStatus();
}

function discardManualDraft() {
  state.manual.draft = state.manual.markdown;
  const editor = modalLayer.querySelector("#manual-editor");
  if (editor) {
    editor.value = state.manual.markdown;
    editor.focus();
  }
  modalLayer.querySelector(".manual-editor__notice")?.remove();
  updateManualEditorStatus();
}

async function saveManual() {
  if (state.manual.saving) return;
  const markdown = state.manual.draft ?? state.manual.markdown;
  if (new TextEncoder().encode(markdown).length > MANUAL_MARKDOWN_LIMIT) {
    showToast("The manual is over 256 KiB. Shorten it before saving.", "danger");
    return;
  }
  state.manual.saving = true;
  updateManualEditorStatus();
  try {
    const payload = await api("/api/v2/manual", { method: "PUT", body: { markdown, revision: state.manual.revision } });
    applyManualPayload(payload?.manual);
    state.manual.draft = null;
    closeModal();
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    applyManualFilter();
    refreshGlobalSearchResults();
    showToast("Manual saved", "success");
  } catch (error) {
    if (error?.code === "MANUAL_CONFLICT") {
      // Keep the draft, adopt the newer revision, and let the owner decide.
      const draft = state.manual.draft;
      await loadManual({ render: false });
      state.manual.draft = draft;
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
      showToast("The manual changed in another session. Your draft is kept; review it and save again to replace that version.", "danger");
    } else {
      showToast(error?.message || "The manual could not be saved.", "danger");
    }
  } finally {
    state.manual.saving = false;
    updateManualEditorStatus();
  }
}

// Global search -----------------------------------------------------------
// One field in the top bar searches pages, connected services, Proxmox
// workloads and the manual. Results are built from data the dashboard
// already holds; the only request is loading the manual once.

const SEARCH_PAGES = Object.freeze([
  { workspace: "system", route: "system", title: "Overview", area: "Overview", terms: "home system health dashboard" },
  { workspace: "system", route: "launchpad", title: "Launchpad", area: "Overview", terms: "open links services bookmarks" },
  { workspace: "system", route: "manual", title: "Manual", area: "Overview", terms: "docs documentation runbook notes" },
  { workspace: "media", route: "overview", title: "Media overview", area: "Media", terms: "home" },
  { workspace: "media", route: "discover", title: "Discover", area: "Media", terms: "search movies series find request" },
  { workspace: "media", route: "library", title: "Library", area: "Media", terms: "movies series jellyfin" },
  { workspace: "media", route: "requests", title: "Requests", area: "Media", terms: "seerr approvals" },
  { workspace: "media", route: "activity", title: "Activity", area: "Media", terms: "downloads queue imports qbittorrent" },
  { workspace: "media", route: "calendar", title: "Calendar", area: "Media", terms: "releases upcoming schedule" },
  { workspace: "media", route: "health", title: "Media health", area: "Media", terms: "incidents warnings pipeline" },
  { workspace: "media", route: "connections", title: "Media connections", area: "Media", terms: "services api keys setup" },
  { workspace: "infrastructure", route: "overview", title: "Infrastructure overview", area: "Infrastructure", terms: "home" },
  { workspace: "infrastructure", route: "connectors", title: "Connectors", area: "Infrastructure", terms: "proxmox portainer loki connections" },
  { workspace: "infrastructure", route: "proxmox", title: "Proxmox", area: "Infrastructure", terms: "nodes cluster environments" },
  { workspace: "infrastructure", route: "workloads", title: "Workloads", area: "Infrastructure", terms: "vms containers lxc qemu guests" },
  { workspace: "infrastructure", route: "portainer", title: "Portainer", area: "Infrastructure", terms: "docker containers stacks" },
  { workspace: "infrastructure", route: "network", title: "Network", area: "Infrastructure", terms: "map topology 3d diagram router switch lan" },
  { workspace: "infrastructure", route: "incidents", title: "Incidents", area: "Infrastructure", terms: "alerts problems" },
  { workspace: "system", route: "logs", title: "Logs", area: "Shared", terms: "journal loki events" },
  { workspace: "system", route: "settings", title: "Settings", area: "Shared", terms: "sessions network security" }
]);

const SEARCH_GROUP_LIMITS = Object.freeze({ pages: 3, services: 4, workloads: 5, manual: 6 });

function searchWords(query) {
  return String(query || "").toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8);
}

function matchesAllWords(haystack, words) {
  const value = haystack.toLowerCase();
  return words.every((word) => value.includes(word));
}

function searchScore(name, words, query) {
  const value = name.toLowerCase();
  const phrase = query.trim().toLowerCase();
  if (value === phrase) return 100;
  if (value.startsWith(phrase)) return 80;
  if (value.includes(phrase)) return 60;
  return words.filter((word) => value.includes(word)).length * 10;
}

function buildGlobalSearchResults(query) {
  const words = searchWords(query);
  if (!words.length || !state.status?.authenticated) return [];
  const results = [];
  const ranked = (items) => items.sort((left, right) => right.score - left.score);

  const pages = ranked(SEARCH_PAGES
    .filter((page) => matchesAllWords(`${page.title} ${page.area} ${page.terms}`, words))
    .map((page) => ({ group: "pages", kind: "page", title: page.title, meta: page.area, page, score: searchScore(page.title, words, query) })));
  results.push(...pages.slice(0, SEARCH_GROUP_LIMITS.pages));

  const services = ranked(launchpadEntries()
    .filter((entry) => entry.href && matchesAllWords(`${entry.name} ${entry.role} ${entry.provider} ${entry.href}`, words))
    .map((entry) => ({ group: "services", kind: "service", title: entry.name, meta: entry.role, state: entry.state, entry, score: searchScore(entry.name, words, query) })));
  results.push(...services.slice(0, SEARCH_GROUP_LIMITS.services));

  const workloads = ranked(infrastructureHealth().workloads
    .filter((workload) => matchesAllWords(`${workload.name} ${workload.kind} ${workload.vmid ?? ""} ${workload.node} ${workload.environmentName} ${(workload.tags || []).join(" ")}`, words))
    .map((workload) => ({
      group: "workloads",
      kind: "workload",
      title: workload.name,
      meta: `${workload.kind} ${workload.vmid ?? "—"} · ${workload.node} · ${workload.status}`,
      workload,
      score: searchScore(`${workload.name}`, words, query) + (String(workload.vmid ?? "") === query.trim() ? 90 : 0)
    })));
  results.push(...workloads.slice(0, SEARCH_GROUP_LIMITS.workloads));

  if (state.manual.loaded && state.manual.markdown) {
    for (const match of searchManualEntries(manualDocument().entries, query, SEARCH_GROUP_LIMITS.manual)) {
      results.push({
        group: "manual",
        kind: "manual",
        title: match.entry.kind === "section" ? match.entry.text : match.entry.sectionTitle || "Manual",
        meta: match.entry.kind === "section" ? "Section" : "",
        snippet: match.entry.kind === "section" ? null : manualSnippet(match.entry.text, match.matchStart, match.matchLength),
        targetId: match.entry.id,
        query
      });
    }
  }
  return results;
}

const SEARCH_GROUP_TITLES = Object.freeze({ pages: "Pages", services: "Services", workloads: "Workloads", manual: "Manual" });

function renderSearchOption(result, index) {
  const active = index === state.search.active;
  const leading = result.kind === "service"
    ? `<span class="helmsman-search__icon">${result.entry.provider === "proxmox" ? proxmoxBrandLinkMarkup() : serviceIconMarkup(result.entry.provider, result.title.slice(0, 1))}</span>`
    : result.kind === "workload"
      ? `<span class="helmsman-search__icon workload-type is-${escapeHtml(result.workload.type)}">${workloadIconMarkup(result.workload.type)}</span>`
      : `<span class="helmsman-search__icon">${icon(result.kind === "manual" ? "book" : "chevron")}</span>`;
  const snippet = result.snippet
    ? `<span class="helmsman-search__snippet">${escapeHtml(result.snippet.before)}<mark>${escapeHtml(result.snippet.match)}</mark>${escapeHtml(result.snippet.after)}</span>`
    : "";
  const trailing = result.kind === "service" ? icon("external") : "";
  return `<button class="helmsman-search__option${active ? " is-active" : ""}" type="button" role="option" id="helmsman-search-option-${index}" aria-selected="${active ? "true" : "false"}" data-action="helmsman-search-select" data-search-index="${index}" tabindex="-1">
      ${leading}
      <span class="helmsman-search__copy"><strong>${escapeHtml(result.title)}</strong>${result.meta ? `<small>${escapeHtml(result.meta)}</small>` : ""}${snippet}</span>
      ${trailing}
    </button>`;
}

function renderGlobalSearchPanel() {
  const panel = document.querySelector("#helmsman-search-results");
  const input = document.querySelector("#helmsman-search-input");
  if (!panel || !input) return;
  const { query, results, open } = state.search;
  panel.hidden = !open;
  input.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) {
    input.removeAttribute("aria-activedescendant");
    return;
  }
  if (!query.trim()) {
    setMarkup(panel, `<p class="helmsman-search__hint">Search pages, services, workloads${state.manual.markdown ? " and your manual" : ""}. Try a name, an address or a VMID.</p>`);
    input.removeAttribute("aria-activedescendant");
    return;
  }
  if (!results.length) {
    setMarkup(panel, `<p class="helmsman-search__hint">Nothing matches “${escapeHtml(query.trim())}”.${state.manual.loading ? " The manual is still loading." : ""}</p>`);
    input.removeAttribute("aria-activedescendant");
    return;
  }
  let index = 0;
  const groups = Object.keys(SEARCH_GROUP_TITLES).map((group) => {
    const members = results.filter((result) => result.group === group);
    if (!members.length) return "";
    const options = members.map((result) => renderSearchOption(result, index++)).join("");
    return `<div class="helmsman-search__group" role="group" aria-labelledby="helmsman-search-group-${group}"><span class="helmsman-search__group-title" id="helmsman-search-group-${group}">${SEARCH_GROUP_TITLES[group]}</span>${options}</div>`;
  }).join("");
  setMarkup(panel, groups);
  input.setAttribute("aria-activedescendant", `helmsman-search-option-${state.search.active}`);
}

function orderedSearchResults(results) {
  const order = Object.keys(SEARCH_GROUP_TITLES);
  return [...results].sort((left, right) => order.indexOf(left.group) - order.indexOf(right.group));
}

function updateGlobalSearch(value) {
  state.search.query = String(value || "").slice(0, 120);
  state.search.results = orderedSearchResults(buildGlobalSearchResults(state.search.query));
  state.search.active = 0;
  state.search.open = true;
  renderGlobalSearchPanel();
}

function refreshGlobalSearchResults() {
  if (!state.search.open) return;
  state.search.results = orderedSearchResults(buildGlobalSearchResults(state.search.query));
  state.search.active = Math.min(state.search.active, Math.max(0, state.search.results.length - 1));
  renderGlobalSearchPanel();
}

async function ensureManualForSearch() {
  if (!state.status?.authenticated || state.manual.loaded || state.manual.loading) return;
  await loadManual({ render: false });
  refreshGlobalSearchResults();
}

function openGlobalSearch() {
  const container = document.querySelector("#helmsman-search");
  const input = document.querySelector("#helmsman-search-input");
  if (!container || !input || container.hidden) return;
  container.classList.add("is-expanded");
  input.focus();
  input.select();
}

function closeGlobalSearch({ clear = false, blur = false } = {}) {
  const input = document.querySelector("#helmsman-search-input");
  state.search.open = false;
  if (clear) {
    state.search.query = "";
    state.search.results = [];
    if (input) input.value = "";
  }
  renderGlobalSearchPanel();
  document.querySelector("#helmsman-search")?.classList.remove("is-expanded");
  if (blur) input?.blur();
}

async function activateSearchResult(index) {
  const result = state.search.results[index];
  if (!result) return;
  closeGlobalSearch({ clear: true, blur: true });
  if (result.kind === "page") {
    const { workspace, route } = result.page;
    if (workspace === state.workspace) location.hash = route === "logs" ? canonicalLoggingHash() : `#/${route}`;
    else await switchWorkspace(workspace, route);
    return;
  }
  if (result.kind === "service") {
    globalThis.open?.(result.entry.href, "_blank", "noopener,noreferrer");
    return;
  }
  if (result.kind === "workload") {
    if (state.workspace !== "infrastructure" || currentRoute() !== "workloads") {
      await switchWorkspace("infrastructure", "workloads");
    }
    openInfrastructureWorkload(result.workload.id);
    return;
  }
  if (result.kind === "manual") {
    state.manual.pendingTarget = result.targetId;
    state.manual.pendingHighlight = result.query;
    if (state.workspace === "system" && currentRoute() === "manual") {
      revealManualTarget();
    } else if (state.workspace === "system") {
      location.hash = "#/manual";
    } else {
      await switchWorkspace("system", "manual");
    }
  }
}

function handleGlobalSearchKeydown(event) {
  const { results } = state.search;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!state.search.open) {
      updateGlobalSearch(event.target.value);
      return;
    }
    if (!results.length) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    state.search.active = (state.search.active + step + results.length) % results.length;
    renderGlobalSearchPanel();
    document.querySelector(`#helmsman-search-option-${state.search.active}`)?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    activateSearchResult(state.search.active);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (state.search.query) closeGlobalSearch({ clear: true });
    else closeGlobalSearch({ blur: true });
  }
}

function isTypingTarget(element) {
  return Boolean(element?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function initializeGlobalSearch() {
  const container = document.querySelector("#helmsman-search");
  const input = document.querySelector("#helmsman-search-input");
  if (!container || !input) return;
  input.addEventListener("focus", () => {
    container.classList.add("is-expanded");
    state.search.open = true;
    state.search.results = orderedSearchResults(buildGlobalSearchResults(state.search.query));
    renderGlobalSearchPanel();
    ensureManualForSearch();
  });
  input.addEventListener("keydown", handleGlobalSearchKeydown);
  // Keep focus in the field while a result is clicked.
  container.addEventListener("mousedown", (event) => {
    if (event.target.closest(".helmsman-search__option")) event.preventDefault();
  });
  container.addEventListener("focusout", (event) => {
    if (!container.contains(event.relatedTarget)) closeGlobalSearch();
  });
  window.addEventListener("keydown", (event) => {
    const key = String(event.key || "");
    const overlayOpen = Boolean(document.body?.classList?.contains("has-overlay"));
    const shortcut = (key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target))
      || (key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey);
    if (!shortcut || overlayOpen || container.hidden) return;
    event.preventDefault?.();
    openGlobalSearch();
  });
}

function updateGlobalSearchChrome() {
  const container = document.querySelector("#helmsman-search");
  if (!container) return;
  const available = Boolean(state.status?.authenticated);
  if (container.hidden === available) container.hidden = !available;
  if (!available && state.search.open) closeGlobalSearch({ clear: true });
}

function renderAuthenticatedRoute() {
  if (state.workspace === "system") {
    if (state.route === "system") return renderSystemOverview();
    if (state.route === "launchpad") return renderLaunchpadPage();
    if (state.route === "manual") return renderManualPage();
    if (state.route === "logs") return renderLogsPage();
    return renderSettingsPage();
  }
  if (state.workspace === "media") {
    if (state.route === "overview") return renderMediaHome();
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
  if (state.route === "network") return renderNetworkPage();
  if (state.route === "logs") return renderLogsPage();
  return renderSettingsPage();
}

function applyContextualLoggingLinks() {
  if (state.workspace !== "media" || !["overview", "health"].includes(state.route)) return;
  const incidents = normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []).incidents
    .filter(({ scope }) => scope !== "infrastructure");
  const links = [...(main.querySelectorAll?.(".operations-incidents__list .operations-incident .operations-text-link[href='#/logs']") || [])];
  links.forEach((link, index) => {
    const incident = incidents[index];
    if (!incident) return;
    link.setAttribute("href", loggingContextHref({
      view: "loki",
      service: incident.service,
      code: incident.code,
      from: incident.firstSeen
    }));
  });
}

function renderPage({ force = false, preserveFocus = false } = {}) {
  state.route = currentRoute();
  const canonicalHash = state.route === "logs" ? canonicalLoggingHash() : `#/${state.route}`;
  if (location.hash !== canonicalHash) location.replace(canonicalHash);
  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const routeTitle = ROUTE_TITLES[state.route] || "Overview";
  pageTitle.textContent = routeTitle;

  let markup;
  if (state.starting) markup = renderStarting();
  else if (state.fatalError) markup = renderFatal();
  else if (state.status?.setupRequired) markup = renderSetup();
  else if (!state.status?.authenticated) {
    const authentication = authenticationState();
    if (authentication.configured && authentication.provider === "jellyfin") markup = renderJellyfinLogin();
    else if (authentication.legacyAccessKeyAvailable) markup = renderLegacyAccessLogin();
    else markup = renderAuthenticationRecovery();
  }
  else markup = `${renderCachedSnapshotNotice()}${renderAuthenticatedRoute()}`;
  const viewTitle = state.starting
    ? "Starting"
    : state.fatalError
      ? "Unavailable"
      : state.status?.setupRequired
        ? "First-time setup"
        : !state.status?.authenticated
          ? authenticationState().configured ? "Jellyfin sign in" : authenticationState().legacyAccessKeyAvailable ? "Migration sign in" : "Authentication setup"
          : routeTitle;
  document.title = `${viewTitle} · Helmsman`;

  if (!force && markup === state.lastMarkup) {
    syncNetworkPage();
    return;
  }
  const focusedReference = preserveFocus ? focusReference(document.activeElement) : null;
  const documentScrollTop = preserveFocus
    ? Number(globalThis.scrollY ?? document.documentElement?.scrollTop ?? document.body?.scrollTop ?? 0)
    : 0;
  state.lastMarkup = markup;
  setMarkup(main, markup);
  applyContextualLoggingLinks();
  if (preserveFocus) resolveFocusReference(focusedReference, main)?.focus({ preventScroll: true });
  if (state.status?.authenticated) {
    state.authGateFocusApplied = false;
  } else if (!preserveFocus && !state.authGateFocusApplied && !state.starting && !state.fatalError) {
    const focusTarget = state.status?.setupRequired
      ? main.querySelector("input[name='setupToken']")
      : authenticationState().configured
        ? main.querySelector("input[name='username']")
        : authenticationState().legacyAccessKeyAvailable ? main.querySelector("input[name='accessKey']") : null;
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      state.authGateFocusApplied = true;
    }
  }
  if (preserveFocus && Number.isFinite(documentScrollTop)) {
    if (typeof globalThis.scrollTo === "function") globalThis.scrollTo({ top: documentScrollTop, left: 0, behavior: "instant" });
    else if (document.documentElement) document.documentElement.scrollTop = documentScrollTop;
  }
  applyMediaFiltersInPlace();
  syncNetworkPage();
  updateChrome();
  syncAgentHelper();
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

const MEDIA_CONNECTION_PRIORITY = Object.freeze({
  down: 0,
  auth_required: 1,
  unverified: 2,
  connected: 3
});

function mediaConnectionSummary(services) {
  const states = services
    .filter(({ state: serviceState }) => statusClass(serviceState) !== "disabled")
    .map(({ connectionState }) => {
      const candidate = String(connectionState || "unverified").toLowerCase().replaceAll("-", "_");
      return Object.prototype.hasOwnProperty.call(MEDIA_CONNECTION_PRIORITY, candidate) ? candidate : "unverified";
    });
  const state = states.sort((left, right) => MEDIA_CONNECTION_PRIORITY[left] - MEDIA_CONNECTION_PRIORITY[right])[0] || "unverified";
  return {
    connected: { state: "healthy", label: "Connected" },
    auth_required: { state: "auth-required", label: "Authentication required" },
    down: { state: "down", label: "Unavailable" },
    unverified: { state: "stale", label: "Unverified" }
  }[state];
}

function monitorSummaryMarkup({ infrastructureWorkspace, systemWorkspace, overall, connection, summaryText }) {
  const mobileDot = `<i class="monitor-summary__mobile-dot health-dot is-${escapeHtml(statusClass(overall))}" data-monitor-mobile-dot aria-hidden="true"></i>`;
  return `<span class="monitor-summary__metrics" data-monitor-media-summary><a class="monitor-summary__metric" href="#/connections" aria-label="Open media connection health"><small>Connection health</small><span class="monitor-summary__value"><i class="health-dot is-${escapeHtml(connection.state)}" data-monitor-connection-dot aria-hidden="true"></i><strong data-monitor-connection-state>${escapeHtml(connection.label)}</strong></span>${icon("chevron")}</a><a class="monitor-summary__metric" href="#/health" aria-label="Open media service health"><small>Service health</small><span class="monitor-summary__value"><i class="health-dot is-${escapeHtml(statusClass(overall))}" data-monitor-service-dot aria-hidden="true"></i><strong data-monitor-service-state>${escapeHtml(statusLabel(overall))}</strong></span>${icon("chevron")}</a></span><a class="monitor-summary__single" href="#/incidents" data-monitor-infrastructure-summary hidden><i class="health-dot is-${escapeHtml(statusClass(overall))}" data-monitor-infrastructure-dot aria-hidden="true"></i><span data-monitor-infrastructure-text>${escapeHtml(summaryText)}</span></a><a class="monitor-summary__single" href="#/system" data-monitor-system-summary hidden><i class="health-dot is-${escapeHtml(statusClass(overall))}" data-monitor-system-dot aria-hidden="true"></i><span data-monitor-system-text>${escapeHtml(summaryText)}</span></a><span class="monitor-summary__checked" data-monitor-checked hidden>${escapeHtml(summaryText)}</span>${mobileDot}`;
}

function updateMonitorSummary({ infrastructureWorkspace, systemWorkspace, overall, services, summaryText }) {
  const connection = mediaConnectionSummary(services);
  const serviceLabel = statusLabel(overall);
  monitorSummary.setAttribute(
    "aria-label",
    systemWorkspace
      ? `Open combined overview. System health: ${serviceLabel}.`
      : infrastructureWorkspace
      ? `Open infrastructure incidents. Connection health: ${connection.label}. Service health: ${serviceLabel}.`
      : `Open media health. Connection health: ${connection.label}. Service health: ${serviceLabel}.`
  );

  const mediaSummary = monitorSummary.querySelector("[data-monitor-media-summary]");
  const infrastructureSummary = monitorSummary.querySelector("[data-monitor-infrastructure-summary]");
  const systemSummary = monitorSummary.querySelector("[data-monitor-system-summary]");
  const connectionDot = monitorSummary.querySelector("[data-monitor-connection-dot]");
  const connectionState = monitorSummary.querySelector("[data-monitor-connection-state]");
  const serviceDot = monitorSummary.querySelector("[data-monitor-service-dot]");
  const serviceState = monitorSummary.querySelector("[data-monitor-service-state]");
  const infrastructureDot = monitorSummary.querySelector("[data-monitor-infrastructure-dot]");
  const infrastructureText = monitorSummary.querySelector("[data-monitor-infrastructure-text]");
  const systemDot = monitorSummary.querySelector("[data-monitor-system-dot]");
  const systemText = monitorSummary.querySelector("[data-monitor-system-text]");
  const checkedText = monitorSummary.querySelector("[data-monitor-checked]");
  const mobileDot = monitorSummary.querySelector("[data-monitor-mobile-dot]");
  const canPatch = mediaSummary && infrastructureSummary && systemSummary && connectionDot && connectionState
    && serviceDot && serviceState && infrastructureDot && infrastructureText && systemDot && systemText && checkedText && mobileDot;

  if (!canPatch) {
    setMarkup(monitorSummary, monitorSummaryMarkup({ infrastructureWorkspace, systemWorkspace, overall, connection, summaryText }));
    return;
  }

  mediaSummary.hidden = infrastructureWorkspace || systemWorkspace;
  checkedText.hidden = true;
  infrastructureSummary.hidden = !infrastructureWorkspace;
  systemSummary.hidden = !systemWorkspace;
  connectionDot.className = `health-dot is-${connection.state}`;
  connectionState.textContent = connection.label;
  serviceDot.className = `health-dot is-${statusClass(overall)}`;
  serviceState.textContent = serviceLabel;
  infrastructureDot.className = `health-dot is-${statusClass(overall)}`;
  infrastructureText.textContent = summaryText;
  systemDot.className = `health-dot is-${statusClass(overall)}`;
  systemText.textContent = summaryText;
  checkedText.textContent = summaryText;
  mobileDot.className = `monitor-summary__mobile-dot health-dot is-${statusClass(overall)}`;
}

function updateChrome() {
  const normalized = normalizeOperationsSnapshot(snapshotForUi(), state.infrastructure.targets);
  const infrastructure = configuredInfrastructureSnapshotForUi();
  const portainers = configuredPortainerServicesForUi();
  const infrastructureWorkspace = state.workspace === "infrastructure";
  const systemWorkspace = state.workspace === "system";
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
  const infrastructureOverall = combinedInfrastructureState(infrastructure, portainers);
  const overall = systemWorkspace
    ? [statusClass(normalized.overall.state), statusClass(infrastructureOverall)]
      .sort((left, right) => (WORKSPACE_STATE_PRIORITY[left] ?? 99) - (WORKSPACE_STATE_PRIORITY[right] ?? 99))[0] || "disabled"
    : infrastructureWorkspace
      ? infrastructureOverall
      : normalized.overall.state;
  if (pageEyebrow) pageEyebrow.textContent = systemWorkspace
    ? "All systems"
    : infrastructureWorkspace
      ? "Infrastructure"
      : "Media";
  document.documentElement?.setAttribute?.("data-workspace", state.workspace);
  document.querySelectorAll("[data-action='switch-workspace']").forEach((button) => {
    const active = button.dataset.workspace === state.workspace;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll(".workspace-media-only").forEach((element) => {
    element.hidden = state.workspace !== "media";
  });
  document.querySelectorAll(".workspace-infrastructure-only").forEach((element) => {
    const requiredService = element.dataset.serviceNav;
    element.hidden = !infrastructureWorkspace
      || (Boolean(requiredService) && navigationAvailability[requiredService] !== true);
  });
  document.querySelectorAll(".workspace-system-only").forEach((element) => {
    element.hidden = !systemWorkspace;
  });
  const workspaceHome = `#/${workspaceLandingRoute(state.workspace)}`;
  document.querySelectorAll(".brand, .mobile-brand").forEach((link) => {
    link.setAttribute("href", workspaceHome);
    link.setAttribute("aria-label", systemWorkspace
      ? "Helmsman combined overview"
      : infrastructureWorkspace
        ? "Helmsman infrastructure overview"
        : "Helmsman media overview");
  });
  document.querySelectorAll("[data-infrastructure-incident-count]").forEach((element) => {
    element.textContent = String(infrastructureCount);
    element.hidden = infrastructureCount === 0;
  });
  const authenticated = Boolean(state.status?.authenticated);
  updateGlobalSearchChrome();
  modeBadge.textContent = authenticated ? statusLabel(overall) : "Helmsman server";
  modeBadge.dataset.state = statusClass(overall);
  const infrastructureTime = latestInfrastructureCheck(infrastructure.targets, portainers);
  const time = systemWorkspace
    ? [state.snapshot?.generatedAt, infrastructureTime].filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    : infrastructureWorkspace
      ? infrastructureTime
      : state.snapshot?.generatedAt;
  const summaryText = state.refreshing
    ? systemWorkspace ? "Checking all systems…" : infrastructureWorkspace ? "Checking infrastructure…" : "Checking services…"
    : `Last ${systemWorkspace ? "system" : infrastructureWorkspace ? "infrastructure" : "container"} check ${formatTime(time, "pending")}`;
  const monitoredConnections = (infrastructureWorkspace || systemWorkspace)
    ? [...infrastructure.targets, ...portainers]
    : normalized.services;
  updateMonitorSummary({ infrastructureWorkspace, systemWorkspace, overall, services: monitoredConnections, summaryText });
  const initials = String(state.status?.session?.name || "HM").split(/\s+/u).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "HM";
  sessionButton.querySelector("span").textContent = initials;
  sessionButton.disabled = !authenticated;
  sessionButton.setAttribute("aria-disabled", authenticated ? "false" : "true");
  sessionButton.setAttribute("aria-label", authenticated ? "Open browser session settings" : "Browser session unavailable until signed in");
  sessionButton.setAttribute("title", authenticated ? "Browser session settings" : "Sign in to manage browser sessions");
  if (privacyButton) {
    const alertCount = systemWorkspace ? infrastructureCount + count : infrastructureWorkspace ? infrastructureCount : count;
    const alertDot = privacyButton.querySelector(".secure-indicator");
    if (alertDot) alertDot.hidden = !authenticated || alertCount === 0;
    const alertDestination = systemWorkspace ? "combined system overview" : infrastructureWorkspace ? "infrastructure incidents" : "media health alerts";
    privacyButton.setAttribute("aria-label", authenticated
      ? `Open ${alertDestination}${alertCount ? `, ${alertCount} active` : ", no active alerts"}`
      : "Health alerts are available after sign in");
    privacyButton.setAttribute("title", authenticated ? `Open ${alertDestination}` : "Sign in to review health alerts");
  }
  if (globalRefreshButton) {
    const busy = Boolean(state.globalRefreshing || state.refreshing);
    globalRefreshButton.hidden = !authenticated;
    globalRefreshButton.disabled = busy;
    globalRefreshButton.classList.toggle("is-busy", busy);
    globalRefreshButton.setAttribute("aria-busy", busy ? "true" : "false");
    globalRefreshButton.setAttribute("aria-label", busy ? "Refreshing everything" : "Refresh everything now");
    globalRefreshButton.setAttribute("title", busy ? "Refreshing…" : "Refresh everything now");
  }
  applySidebarState();
}

function formatAssessmentTime(value, fallback = "Waiting for data") {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return fallback;
  // Today's times drop the date so they fit the small fact tiles.
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

  const lifecycleRows = [...main.querySelectorAll("[data-overview-lifecycle-id]")];
  if (lifecycleRows.length) {
    const lifecycle = new Map(mediaOverviewLifecycle(mediaSnapshotForUi()).map((stage) => [stage.id, stage]));
    lifecycleRows.forEach((row) => {
      const stage = lifecycle.get(row.dataset.overviewLifecycleId);
      const element = row.querySelector("em");
      if (!stage || !element) return;
      element.textContent = stage.count.toLocaleString();
      element.setAttribute("aria-label", `${stage.count} items`);
      row.classList.toggle("is-healthy", stage.count > 0);
      row.classList.toggle("is-stale", stage.count === 0);
    });
  } else {
    const pipelineCounts = [...main.querySelectorAll(".operations-pipeline__stage > em")];
    snapshot.pipeline.filter((stage) => stage.count !== null).forEach((stage, index) => {
      const element = pipelineCounts[index];
      if (!element) return;
      element.textContent = String(stage.count);
      element.setAttribute("aria-label", `${stage.count} items`);
    });
  }

  for (const link of main.querySelectorAll("[data-overview-incident-id]")) {
    const incident = snapshot.incidents.find(({ id }) => id === link.dataset.overviewIncidentId);
    if (incident) updateTimeElement(link.querySelector("[data-overview-event-time]"), incident.lastSeen || incident.firstSeen, "Current", formatShortTime);
  }
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
  const endpointCount = target.endpoints?.length || 1;
  facts.push(`${endpointCount} API endpoint${endpointCount === 1 ? "" : "s"}`);
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
      if (!target) continue;
      const facts = element.querySelector("[data-infrastructure-target-facts]");
      if (facts) facts.textContent = infrastructureTargetFacts(target).join(" · ");

      const setTargetValue = (selector, value) => {
        const targetElement = element.querySelector(selector);
        if (targetElement) targetElement.textContent = value;
      };
      const cpuCores = target.nodes
        .map((node) => node.cpuCores)
        .filter((value) => value !== null);
      const coreTotal = cpuCores.length
        ? cpuCores.reduce((total, value) => total + value, 0)
        : null;

      setTargetValue("[data-infrastructure-target-metric='cpu']", target.metrics.nodeCpuPercent === null
        ? "Waiting"
        : `${target.metrics.nodeCpuPercent.toLocaleString()}%`);
      setTargetValue("[data-infrastructure-target-metric='memory']", formatMetricRatio(target.metrics.nodeMemoryUsedBytes, target.metrics.nodeMemoryTotalBytes));
      setTargetValue("[data-infrastructure-target-metric='disk']", formatMetricRatio(target.metrics.nodeDiskUsedBytes, target.metrics.nodeDiskTotalBytes));
      setTargetValue("[data-infrastructure-target-metric='workloads']", target.metrics.guestTotal === null
        ? "Waiting"
        : target.metrics.guestTotal.toLocaleString());
      setTargetValue("[data-infrastructure-target-detail='cpu']", coreTotal === null
        ? "Core count pending"
        : `${coreTotal.toLocaleString()} cores`);
      setTargetValue("[data-infrastructure-target-detail='memory']", target.metrics.nodeMemoryUsedBytes === null || target.metrics.nodeMemoryTotalBytes === null
        ? "Aggregate use pending"
        : `${formatMetricBytes(target.metrics.nodeMemoryUsedBytes)} / ${formatMetricBytes(target.metrics.nodeMemoryTotalBytes)}`);
      setTargetValue("[data-infrastructure-target-detail='disk']", target.metrics.nodeDiskUsedBytes === null || target.metrics.nodeDiskTotalBytes === null
        ? "Aggregate use pending"
        : `${formatMetricBytes(target.metrics.nodeDiskUsedBytes)} / ${formatMetricBytes(target.metrics.nodeDiskTotalBytes)}`);
      setTargetValue("[data-infrastructure-target-detail='workloads']", target.metrics.guestTotal === null
        ? "Inventory pending"
        : `${target.metrics.virtualMachineTotal ?? 0} VM · ${target.metrics.containerTotal ?? 0} LXC`);
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
  if (state.workspace === "media" && ["overview", "health"].includes(state.route)) {
    updateOverviewVolatile(normalizeOperationsSnapshot(mediaOnlyOperationsSnapshot(), []));
  }
  if (state.workspace === "infrastructure" && state.route === "incidents") updateIncidentsVolatile(snapshot);
  updateMediaVolatileUi();
  updateServiceModalVolatile(snapshot);
  updateInfrastructureVolatile();
  updatePortainerVolatile();
  syncNetworkPage({ live: true });
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
    requestSeasons: { title: "Request these seasons?", confirmLabel: "Request seasons" },
    searchMovie: { title: "Search Radarr again?", confirmLabel: "Search Radarr" },
    searchSeries: { title: "Search Sonarr again?", confirmLabel: "Search Sonarr" },
    blocklistAndSearch: { title: "Block this release and search again?", confirmLabel: "Block & search", tone: "danger" }
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
  const urlPlaceholder = SERVICE_URL_PLACEHOLDERS[service.id] || "https://service.example";
  return `<section class="modal-card modal-card--service" role="dialog" aria-modal="true" aria-labelledby="service-modal-title">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${serviceIconMarkup(service.id, service.name.slice(0, 1))}</span><div><span class="section-kicker">Service connection</span><h2 id="service-modal-title">${escapeHtml(service.name)}</h2><p>${escapeHtml(service.role)}</p></div><button class="icon-button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="service-form" data-service-id="${escapeHtml(service.id)}" data-original-url="${escapeHtml(service.url)}" data-original-auth-mode="${escapeHtml(selectedMode)}" data-auth-mode="${escapeHtml(selectedMode)}" data-credential-configured="${service.credentialConfigured ? "true" : "false"}" autocomplete="off" data-form-type="${options.find((option) => option.id === selectedMode)?.input === "login" ? "login" : "other"}">
      <div class="modal-card__body">
        <label><span>Full service URL</span><input name="url" type="url" autocomplete="url" value="${escapeHtml(service.url)}" required placeholder="${escapeHtml(urlPlaceholder)}" /><small>Use an address reachable from inside this container. The target must fit the allowed network policy.</small></label>
        ${renderServiceAuthentication(service)}
        <label class="check-row"><input name="monitoringEnabled" type="checkbox" ${service.monitoringEnabled !== false ? "checked" : ""}/><span><strong>Monitor this service</strong><small>Run safe read-only checks in the container even when no browser is open.</small></span></label>
        <div class="credential-state ${service.credentialConfigured ? "is-configured" : ""}">${icon(service.credentialConfigured ? "check" : "lock")}<div><strong>${service.credentialConfigured ? "Encrypted credential saved" : "No credential saved"}</strong><span>Saved values are write-only and cannot be displayed by this interface.</span></div></div>
        ${health ? `<div class="service-health-inline" aria-label="Saved monitor status"><span class="health-dot is-${savedMonitorTone(health)}" data-monitor-dot aria-hidden="true"></span><div class="service-health-inline__copy"><small>Saved monitor</small><strong data-monitor-state>${escapeHtml(savedMonitorLabel(health))}</strong></div><span data-monitor-latency>${escapeHtml(healthLatency)}</span><span data-monitor-checked>${escapeHtml(formatTime(healthCheckedAt))}</span></div>` : ""}
        <div class="service-monitor-reports" data-monitor-reports data-report-fingerprint="${escapeHtml(reportsFingerprint)}" aria-live="polite"${reports.length ? "" : " hidden"}>${renderOperationsReports(reports, service.name)}</div>
        ${ARR_INDEXER_SERVICES.includes(service.id) && service.configured ? `<section class="arr-indexers" data-arr-indexers="${escapeHtml(service.id)}" aria-labelledby="arr-indexers-title">${renderArrIndexers(service.id)}</section>` : ""}
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
    if (ARR_INDEXER_SERVICES.includes(service.id) && service.configured) void loadArrIndexers(service.id);
  }
}

// ------------------------------------------- Radarr and Sonarr indexers --
// Each app's own indexer list, read by the server without the indexers'
// keys, with Test and Test all, as in the Prowlarr panel.
const ARR_INDEXER_SERVICES = Object.freeze(["radarr", "sonarr"]);
const ARR_INDEXER_LABELS = Object.freeze({ radarr: "Radarr", sonarr: "Sonarr" });

function arrIndexerState(service) {
  state.arrIndexers[service] ||= { loaded: false, loading: false, error: "", data: null, busy: "", results: new Map() };
  return state.arrIndexers[service];
}

function rerenderArrIndexers(service) {
  const section = modalLayer?.querySelector?.(`[data-arr-indexers="${service}"]`);
  if (section) setMarkup(section, renderArrIndexers(service));
}

async function loadArrIndexers(service) {
  const current = arrIndexerState(service);
  if (current.loading || !state.status?.authenticated) return;
  current.loading = true;
  rerenderArrIndexers(service);
  try {
    current.data = await api(`/api/v2/${service}/indexers`);
    current.error = "";
  } catch (error) {
    current.error = safeSessionText(error?.message, `${ARR_INDEXER_LABELS[service]}'s indexers could not be read.`, 200);
  } finally {
    current.loading = false;
    current.loaded = true;
    rerenderArrIndexers(service);
  }
}

async function runArrIndexerTest(service, indexerId = null) {
  const current = arrIndexerState(service);
  if (!current.data?.targetRevision || current.busy) return;
  const single = Number.isSafeInteger(indexerId);
  current.busy = single ? `test:${indexerId}` : "test-all";
  rerenderArrIndexers(service);
  try {
    const result = await api("/api/v2/actions/arr-indexers", {
      method: "POST",
      body: single
        ? { service, operation: "testIndexer", indexerId, targetRevision: current.data.targetRevision }
        : { service, operation: "testAllIndexers", targetRevision: current.data.targetRevision }
    });
    const at = new Date().toISOString();
    if (single) {
      current.results.set(indexerId, { ok: result?.passed === true, message: safeSessionText(result?.message, "The test failed.", 240), at });
    } else {
      for (const entry of Array.isArray(result?.results) ? result.results : []) {
        if (Number.isSafeInteger(entry?.id)) current.results.set(entry.id, { ok: entry.ok === true, message: safeSessionText(entry.message, "The test failed.", 240), at });
      }
      const failed = [...current.results.values()].filter((entry) => !entry.ok).length;
      showToast(failed ? `${failed} indexer${failed === 1 ? "" : "s"} failed the test in ${ARR_INDEXER_LABELS[service]}.` : `Every ${ARR_INDEXER_LABELS[service]} indexer passed.`, failed ? "danger" : "success");
    }
  } catch (error) {
    showToast(safeSessionText(error?.message, "The indexer test could not run.", 200), "danger");
  } finally {
    current.busy = "";
    rerenderArrIndexers(service);
    void loadArrIndexers(service);
  }
}

function renderArrIndexers(service) {
  const current = arrIndexerState(service);
  const label = ARR_INDEXER_LABELS[service];
  const indexers = current.data?.indexers || [];
  const failing = indexers.filter((indexer) => indexer.failing && indexer.enabled).length;
  const disabled = Boolean(current.busy) || !current.data;
  const body = !current.loaded || (current.loading && !current.data)
    ? `<p class="agent-empty">Reading ${escapeHtml(label)}'s indexers…</p>`
    : current.error && !current.data
      ? `<div class="empty-state"><strong>Indexers unavailable</strong><span>${escapeHtml(current.error)}</span></div>`
      : !indexers.length
        ? `<p class="agent-empty">${escapeHtml(label)} has no indexers.</p>`
        : `<ul class="prowlarr-indexers">${indexers.map((indexer) => {
          const result = current.results.get(indexer.id);
          const busy = current.busy === `test:${indexer.id}`;
          const tone = !indexer.enabled ? "disabled" : indexer.failing ? "degraded" : "healthy";
          const status = !indexer.enabled ? `Disabled in ${label}`
            : indexer.failing ? `Failing${indexer.failingSince ? ` since ${prowlarrTime(indexer.failingSince)}` : ""}${indexer.disabledUntil ? ` · paused until ${prowlarrTime(indexer.disabledUntil)}` : ""}` : "Working";
          const uses = [indexer.rss ? "RSS" : "", indexer.search ? "Search" : ""].filter(Boolean).join(" + ");
          const protocol = { torrent: "Torrent", usenet: "Usenet" }[indexer.protocol] || "";
          return `<li class="prowlarr-indexer${indexer.failing ? " is-failing" : ""}">
            <i class="health-dot is-${tone}" aria-hidden="true"></i>
            <div class="prowlarr-indexer__main">
              <strong>${escapeHtml(indexer.name)}</strong>
              <small>${escapeHtml([status, protocol, uses].filter(Boolean).join(" · "))}</small>
              ${result ? `<small class="prowlarr-indexer__result is-${result.ok ? "ok" : "bad"}">${result.ok ? "Passed its test" : `Failed its test: ${escapeHtml(result.message)}`} · ${escapeHtml(prowlarrTime(result.at))}</small>` : ""}
            </div>
            <button class="button button--compact" type="button" data-action="arr-indexer-test" data-arr-service="${escapeHtml(service)}" data-indexer-id="${indexer.id}" ${disabled ? "disabled" : ""}${busy ? ' aria-busy="true"' : ""}>${busy ? "Testing…" : "Test"}</button>
          </li>`;
        }).join("")}</ul>`;
  return `<header>
      <div><span class="section-kicker">${escapeHtml(label)}</span><h3 id="arr-indexers-title">Indexers</h3></div>
      <div class="prowlarr-panel__actions">
        ${current.data ? `<span class="prowlarr-panel__summary">${failing ? `<b>${failing} failing</b> · ` : ""}${indexers.length} indexer${indexers.length === 1 ? "" : "s"}${current.data.statusAvailable === false ? " · failure details not reported" : ""}</span>` : ""}
        <button class="button button--compact" type="button" data-action="arr-indexer-test-all" data-arr-service="${escapeHtml(service)}" ${disabled || !indexers.length ? "disabled" : ""}${current.busy === "test-all" ? ' aria-busy="true"' : ""}>${current.busy === "test-all" ? "Testing…" : "Test all"}</button>
        <button class="button button--compact" type="button" data-action="arr-indexer-refresh" data-arr-service="${escapeHtml(service)}" ${current.loading ? 'disabled aria-busy="true"' : ""}>${icon("refresh")}<span class="sr-only">Refresh indexers</span></button>
      </div>
    </header>
    ${body}
    <p class="arr-indexers__note">Tests run in ${escapeHtml(label)} itself, with its own settings. Indexer keys never leave Helmsman's server.</p>`;
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
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${proxmoxBrandLinkMarkup()}</span><div><span class="section-kicker">${existing ? "Primary API endpoint" : "Connect and discover"}</span><h2 id="proxmox-modal-title" tabindex="-1">${existing ? escapeHtml(displayName) : "New Proxmox environment"}</h2><p id="proxmox-modal-description">${escapeHtml(description)}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="proxmox-form" data-infrastructure-target-id="${escapeHtml(target?.id || "")}" data-original-url="${escapeHtml(target?.url || "")}" data-original-tls-mode="${escapeHtml(tlsMode)}" data-original-fingerprint="${escapeHtml(target?.certificateFingerprint || "")}" data-credential-configured="${target?.credentialConfigured ? "true" : "false"}" data-target-enabled="${target?.enabled === false ? "false" : "true"}" data-monitoring-interval-seconds="${target?.monitoringIntervalSeconds || 60}" data-discovery-confirmed="false" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <div class="form-grid form-grid--two">
          <label for="proxmox-display-name"><span>Display name</span><input id="proxmox-display-name" name="displayName" type="text" autocomplete="off" autocapitalize="words" maxlength="80" value="${escapeHtml(displayName)}" required placeholder="Example Proxmox" /></label>
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
        <div class="form-grid form-grid--two"><label for="portainer-display-name"><span>Display name</span><input id="portainer-display-name" name="displayName" type="text" maxlength="80" autocomplete="off" value="${escapeHtml(service?.displayName || "")}" required placeholder="Example Portainer" /></label><label for="portainer-url"><span>Full Portainer URL</span><input id="portainer-url" name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value="${escapeHtml(service?.url || "")}" required placeholder="https://portainer.example.internal:9443" /><small>HTTPS only. Use an address reachable from inside this container.</small></label></div>
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

function lokiConnectionUnchanged(form) {
  if (!form?.dataset?.lokiServiceId) return false;
  const data = new FormData(form);
  const url = String(data.get("url") || "").trim();
  const authMode = String(data.get("authMode") || "none");
  const tenantId = String(data.get("tenantId") || "").trim();
  let secure = false;
  try {
    secure = new URL(url).protocol === "https:";
  } catch {
    secure = false;
  }
  const tlsMode = secure
    ? String(data.get("tlsMode") || "system") === "pinned" ? "pinned" : "system"
    : "none";
  const fingerprint = tlsMode === "pinned" ? normalizedFingerprint(data.get("certificateFingerprint")) : "";
  return url === form.dataset.originalUrl
    && authMode === form.dataset.originalAuthMode
    && tenantId === form.dataset.originalTenantId
    && tlsMode === form.dataset.originalTlsMode
    && fingerprint === form.dataset.originalFingerprint;
}

function syncLokiForm(form) {
  if (!form) return;
  const url = form.querySelector("input[name='url']");
  const urlValue = String(url?.value || "").trim();
  let protocol = "";
  let urlMessage = "";
  if (urlValue) {
    try {
      protocol = new URL(urlValue).protocol;
      if (!["http:", "https:"].includes(protocol)) urlMessage = "Use a complete HTTP or HTTPS Loki URL.";
    } catch {
      urlMessage = "Enter a complete Loki URL.";
    }
  }
  setFieldValidity(url, urlMessage);
  const secure = protocol === "https:";
  const tlsFieldset = form.querySelector("[data-loki-tls-controls]");
  if (tlsFieldset) tlsFieldset.hidden = !secure;
  for (const input of form.querySelectorAll("input[name='tlsMode']")) input.disabled = !secure;
  const tlsMode = secure && form.querySelector("input[name='tlsMode']:checked")?.value === "pinned" ? "pinned" : "system";
  const fingerprintPanel = form.querySelector("[data-loki-tls-panel='pinned']");
  const fingerprint = form.querySelector("input[name='certificateFingerprint']");
  if (fingerprintPanel) fingerprintPanel.hidden = !secure || tlsMode !== "pinned";
  if (fingerprint) {
    fingerprint.disabled = !secure || tlsMode !== "pinned";
    fingerprint.required = secure && tlsMode === "pinned";
    const compact = normalizedFingerprint(fingerprint.value);
    setFieldValidity(fingerprint, fingerprint.required && compact && !/^[a-f0-9]{64}$/u.test(compact)
      ? "Enter a valid SHA-256 certificate fingerprint."
      : "");
  }
  const transportNote = form.querySelector("[data-loki-transport-note]");
  if (transportNote) {
    transportNote.classList.toggle("is-warning", protocol === "http:");
    transportNote.querySelector("strong").textContent = protocol === "http:" ? "Private HTTP connection" : "Protected Loki connection";
    transportNote.querySelector("span").textContent = protocol === "http:"
      ? "HTTP is allowed only for unauthenticated Loki on a target that passes Helmsman's private-network policy."
      : "HTTPS uses either system certificate trust or the exact pinned leaf-certificate fingerprint.";
  }
  const authMode = ["none", "basic", "bearer"].includes(form.querySelector("input[name='authMode']:checked")?.value)
    ? form.querySelector("input[name='authMode']:checked").value
    : "none";
  const authSelection = form.querySelector("input[name='authMode']:checked");
  setFieldValidity(authSelection, protocol === "http:" && authMode !== "none"
    ? "Basic and bearer authentication require an HTTPS Loki URL."
    : "");
  const username = form.querySelector("input[name='username']");
  const password = form.querySelector("input[name='password']");
  const bearerToken = form.querySelector("input[name='bearerToken']");
  const retaining = form.dataset.credentialConfigured === "true" && lokiConnectionUnchanged(form);
  for (const panel of form.querySelectorAll("[data-loki-auth-panel]")) {
    const selected = panel.dataset.lokiAuthPanel === authMode;
    panel.hidden = !selected;
    for (const input of panel.querySelectorAll("input")) input.disabled = !selected;
  }
  if (username && password) {
    const supplied = Boolean(username.value || password.value);
    username.required = authMode === "basic" && (!retaining || supplied);
    password.required = authMode === "basic" && (!retaining || supplied);
  }
  if (bearerToken) bearerToken.required = authMode === "bearer" && (!retaining || Boolean(bearerToken.value));
  const note = form.querySelector("[data-loki-credential-note]");
  if (note) note.textContent = authMode === "none"
    ? "No authentication header will be sent to Loki."
    : retaining
      ? "Leave the credential fields blank to keep the protected values. Changing the URL, tenant, authentication mode, or certificate trust requires them again."
      : `${authModeLabel(authMode)} values are write-only and never returned to this browser.`;
}

function invalidateLokiTest(form) {
  if (!form) return;
  advanceServiceTestRevision(form);
  const panel = form.querySelector("#loki-test-result");
  if (panel) panel.hidden = true;
}

function lokiDraftBody(form) {
  const data = new FormData(form);
  const authMode = ["none", "basic", "bearer"].includes(data.get("authMode")) ? String(data.get("authMode")) : "none";
  const url = String(data.get("url") || "").trim();
  let secure = false;
  try {
    secure = new URL(url).protocol === "https:";
  } catch {
    secure = false;
  }
  const tlsMode = secure ? data.get("tlsMode") === "pinned" ? "pinned" : "system" : "none";
  const body = {
    type: "loki",
    displayName: String(data.get("displayName") || "").trim(),
    url,
    enabled: data.get("enabled") === "on",
    monitoringEnabled: data.get("monitoringEnabled") === "on",
    authMode,
    tenantId: String(data.get("tenantId") || "").trim(),
    tlsMode,
    certificateFingerprint: tlsMode === "pinned" ? normalizedFingerprint(data.get("certificateFingerprint")) : null
  };
  if (authMode === "basic") {
    const username = String(data.get("username") || "");
    const password = String(data.get("password") || "");
    if (username || password) body.credentials = { username, password };
  } else if (authMode === "bearer") {
    const bearerToken = String(data.get("bearerToken") || "");
    if (bearerToken) body.credentials = { token: bearerToken };
  }
  return body;
}

function renderLokiModal(service = null) {
  const existing = Boolean(service);
  const authMode = service?.authMode || "none";
  const secure = service?.url ? (() => {
    try {
      return new URL(service.url).protocol === "https:";
    } catch {
      return true;
    }
  })() : true;
  const tlsMode = secure ? service?.tlsMode === "pinned" ? "pinned" : "system" : "none";
  const health = service ? lokiHealthById(service.id) : null;
  const credentialTitle = authMode === "none"
    ? "No authentication configured"
    : service?.credentialConfigured ? "Protected Loki credential saved" : "No Loki credential saved";
  return `<section class="modal-card modal-card--service modal-card--loki" role="dialog" aria-modal="true" aria-labelledby="loki-modal-title" aria-describedby="loki-modal-description">
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand logging-connector-mark">${icon("logs")}</span><div><span class="section-kicker">Observability</span><h2 id="loki-modal-title" tabindex="-1">${existing ? escapeHtml(service.displayName) : "Connect Loki"}</h2><p id="loki-modal-description">${existing ? "Edit this Loki connection without exposing its saved credential." : "Connect an existing Loki server for transient log search inside Helmsman."}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
    <form id="loki-form" data-loki-service-id="${escapeHtml(service?.id || "")}" data-original-url="${escapeHtml(service?.url || "")}" data-original-auth-mode="${escapeHtml(authMode)}" data-original-tenant-id="${escapeHtml(service?.tenantId || "")}" data-original-tls-mode="${escapeHtml(tlsMode)}" data-original-fingerprint="${escapeHtml(service?.certificateFingerprint || "")}" data-credential-configured="${service?.credentialConfigured ? "true" : "false"}" autocomplete="off" data-form-type="other">
      <div class="modal-card__body">
        <div class="form-grid form-grid--two"><label for="loki-display-name"><span>Display name</span><input id="loki-display-name" name="displayName" type="text" maxlength="80" autocomplete="off" value="${escapeHtml(service?.displayName || "Loki")}" required /></label><label for="loki-url"><span>Full Loki URL</span><input id="loki-url" name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value="${escapeHtml(service?.url || "")}" required placeholder="http://loki.internal:3100" /><small>Use an address reachable from inside the Helmsman container.</small></label></div>
        <div class="security-note ${secure ? "security-note--good" : ""}" data-loki-transport-note>${icon(secure ? "shield" : "lock")}<div><strong>${secure ? "Protected Loki connection" : "Private HTTP connection"}</strong><span>${secure ? "HTTPS uses either system certificate trust or the exact pinned leaf-certificate fingerprint." : "HTTP is allowed only for unauthenticated Loki on a target that passes Helmsman's private-network policy."}</span></div></div>
        <fieldset class="auth-method-fieldset" data-loki-tls-controls ${secure ? "" : "hidden"}><legend>Certificate trust</legend><div class="auth-mode-grid"><label class="option-card-v5"><input name="tlsMode" type="radio" value="system" ${tlsMode === "system" ? "checked" : ""}/><span><strong>System trust</strong><small>Use a trusted CA and matching hostname.</small></span></label><label class="option-card-v5"><input name="tlsMode" type="radio" value="pinned" ${tlsMode === "pinned" ? "checked" : ""}/><span><strong>Pinned fingerprint</strong><small>Use the exact SHA-256 leaf certificate.</small></span></label></div></fieldset>
        <div class="service-auth-panel" data-loki-tls-panel="pinned" ${secure && tlsMode === "pinned" ? "" : "hidden"}><label for="loki-certificate-fingerprint"><span>SHA-256 certificate fingerprint</span><input id="loki-certificate-fingerprint" name="certificateFingerprint" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" value="${escapeHtml(service?.certificateFingerprint || "")}" ${secure && tlsMode === "pinned" ? "required" : "disabled"} placeholder="64 hexadecimal characters" /></label></div>
        <fieldset class="auth-method-fieldset"><legend>Loki authentication</legend><div class="auth-mode-grid auth-mode-grid--three"><label class="option-card-v5"><input name="authMode" type="radio" value="none" ${authMode === "none" ? "checked" : ""}/><span><strong>None</strong><small>No authorization header</small></span></label><label class="option-card-v5"><input name="authMode" type="radio" value="basic" ${authMode === "basic" ? "checked" : ""}/><span><strong>Basic</strong><small>Username and password</small></span></label><label class="option-card-v5"><input name="authMode" type="radio" value="bearer" ${authMode === "bearer" ? "checked" : ""}/><span><strong>Bearer</strong><small>Protected access token</small></span></label></div></fieldset>
        <div class="service-auth-panel" data-loki-auth-panel="basic" ${authMode === "basic" ? "" : "hidden"}><div class="form-grid form-grid--stacked"><label for="loki-username"><span>Username</span><input id="loki-username" name="username" type="text" autocomplete="username" maxlength="180" ${authMode === "basic" ? "" : "disabled"} placeholder="${service?.credentialConfigured && authMode === "basic" ? "Blank keeps the saved username" : "Loki username"}" /></label><label for="loki-password"><span>Password</span><input id="loki-password" name="password" type="password" autocomplete="new-password" maxlength="500" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" ${authMode === "basic" ? "" : "disabled"} placeholder="${service?.credentialConfigured && authMode === "basic" ? "Blank keeps the saved password" : "Loki password"}" /></label></div></div>
        <div class="service-auth-panel" data-loki-auth-panel="bearer" ${authMode === "bearer" ? "" : "hidden"}><label for="loki-bearer-token"><span>Bearer token</span><input id="loki-bearer-token" name="bearerToken" type="password" autocomplete="new-password" maxlength="2000" data-1p-ignore="true" data-bwignore="true" data-lpignore="true" ${authMode === "bearer" ? "" : "disabled"} placeholder="${service?.credentialConfigured && authMode === "bearer" ? "Blank keeps the saved token" : "Paste bearer token"}" /></label></div>
        <p class="auth-retention-note" data-loki-credential-note>${authMode === "none" ? "No authentication header will be sent to Loki." : service?.credentialConfigured ? "Leave credential fields blank to keep the protected values." : `${authModeLabel(authMode)} values are write-only and never returned to this browser.`}</p>
        <label for="loki-tenant-id"><span>Tenant ID <small>Optional</small></span><input id="loki-tenant-id" name="tenantId" type="text" maxlength="128" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(service?.tenantId || "")}" placeholder="X-Scope-OrgID value" /><small>Leave blank for single-tenant Loki.</small></label>
        <div class="form-grid form-grid--two"><label class="check-row"><input name="enabled" type="checkbox" ${service?.enabled === false ? "" : "checked"}/><span><strong>Enable this connection</strong><small>Disabled connections remain saved but cannot be queried.</small></span></label><label class="check-row"><input name="monitoringEnabled" type="checkbox" ${service?.monitoringEnabled === false ? "" : "checked"}/><span><strong>Monitor Loki</strong><small>Check readiness and bounded query access when Helmsman refreshes.</small></span></label></div>
        <div class="credential-state ${service?.credentialConfigured || authMode === "none" ? "is-configured" : ""}">${icon(service?.credentialConfigured || authMode === "none" ? "check" : "lock")}<div><strong>${escapeHtml(credentialTitle)}</strong><span>Saved credential values are encrypted, destination-bound, and cannot be displayed by this interface.</span></div></div>
        ${health ? `<div class="service-health-inline" aria-label="Saved Loki monitor status"><span class="health-dot is-${statusClass(health.state)}"></span><div class="service-health-inline__copy"><small>Saved monitor</small><strong>${escapeHtml(lokiConnectionLabel(service))}</strong></div><span>${escapeHtml([health.version ? `Loki ${health.version}` : "", health.latencyMs === null ? "" : `${health.latencyMs} ms`].filter(Boolean).join(" · "))}</span><span>${escapeHtml(formatTime(health.checkedAt))}</span></div>` : ""}
        <div class="connection-test-result" id="loki-test-result" role="status" aria-live="polite" hidden><span class="health-dot is-checking" aria-hidden="true"></span><div><span class="connection-test-result__kicker">Current connection test</span><strong data-test-title></strong><small data-test-detail></small><div data-test-capabilities></div><small class="connection-test-result__note" data-test-note></small></div></div>
        <p class="form-error" id="loki-error" role="alert"></p>
      </div>
      <footer class="modal-card__footer">${existing ? `<button class="button button--danger" type="button" data-action="delete-loki-service" data-loki-service-id="${escapeHtml(service.id)}">Remove connection</button>` : "<span></span>"}<div class="modal-card__actions"><button class="button" type="button" data-action="test-loki-service">Test connection</button><button class="button button--primary" type="submit">${existing ? "Save connection" : "Connect Loki"}</button></div></footer>
    </form>
  </section>`;
}

function openLokiService(serviceId = "") {
  const service = serviceId ? lokiConfigurationById(serviceId) : null;
  if (serviceId && !service) return showToast("That Loki connection is no longer available.", "danger");
  openModal(renderLokiModal(service), "#loki-display-name");
  syncLokiForm(modalLayer.querySelector("#loki-form"));
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
    <header class="modal-card__header"><span class="service-card-v5__letter service-card-v5__brand">${proxmoxBrandLinkMarkup()}</span><div><span class="section-kicker">Explicit failover trust</span><h2 id="proxmox-endpoint-modal-title" tabindex="-1">${existing ? escapeHtml(endpoint.label) : "Add API endpoint"}</h2><p>${escapeHtml(environment.displayName)} · Every address, certificate, and token is verified independently.</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close">${icon("x")}</button></header>
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

function beginGateSubmission(form, busyLabel) {
  if (!form || form.dataset.submitting === "true") return null;
  const submit = form.querySelector("button[type='submit']");
  const originalLabel = submit?.textContent || "";
  form.dataset.submitting = "true";
  form.setAttribute("aria-busy", "true");
  if (submit) {
    submit.disabled = true;
    submit.textContent = busyLabel;
  }
  return { submit, originalLabel };
}

function endGateSubmission(form, submission) {
  if (!form || !submission) return;
  delete form.dataset.submitting;
  form.removeAttribute("aria-busy");
  if (submission.submit?.isConnected) {
    submission.submit.disabled = false;
    submission.submit.textContent = submission.originalLabel;
  }
}

function applyAuthenticationResult(result, { jellyfinOwner = "" } = {}) {
  const returnedStatus = result?.status && typeof result.status === "object" ? result.status : {};
  const suppliedAuthentication = result?.authentication && typeof result.authentication === "object"
    ? result.authentication
    : returnedStatus.authentication;
  let authentication = authenticationState(suppliedAuthentication || state.status?.authentication);
  if (jellyfinOwner && (!authentication.configured || authentication.provider !== "jellyfin")) {
    authentication = {
      provider: "jellyfin",
      configured: true,
      ownerName: safeSessionText(result?.ownerName || jellyfinOwner, "Jellyfin owner", 80),
      legacyAccessKeyAvailable: false
    };
  }
  state.csrfToken = String(result?.csrfToken || returnedStatus.csrfToken || state.csrfToken || "");
  state.status = {
    ...state.status,
    ...returnedStatus,
    setupRequired: false,
    authenticated: true,
    session: result?.session || returnedStatus.session || state.status?.session || null,
    authentication
  };
}

async function submitSetup(form) {
  const submission = beginGateSubmission(form, "Claiming…");
  if (!submission) return;
  const error = form.querySelector("#setup-error");
  const data = new FormData(form);
  error.textContent = "";
  try {
    const result = await api("/api/v2/setup/claim", {
      method: "POST",
      csrf: false,
      body: {
        setupToken: String(data.get("setupToken") || ""),
        deviceName: automaticDeviceName(),
        origin: location.origin,
        allowedCidrs: allowedCidrsForForm(form, data),
        allowPublicHttps: data.get("allowPublicHttps") === "on"
      }
    });
    applyAuthenticationResult(result);
    state.config = result.config;
    state.lastMarkup = "";
    await Promise.all([loadOperations(), loadSessions()]);
    state.workspace = "media";
    try {
      globalThis.localStorage?.setItem("helmsman.workspace", "media");
    } catch {
      // The setup flow can continue without local preference storage.
    }
    const jellyfinConnected = configuredJellyfinConnection(result.config);
    location.hash = jellyfinConnected ? "#/settings" : "#/connections";
    renderPage({ force: true });
    showToast(jellyfinConnected
      ? "Container claimed. Enroll the Jellyfin owner to finish browser sign-in."
      : "Container claimed. Connect Jellyfin, then enroll its administrator.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  } finally {
    endGateSubmission(form, submission);
  }
}

function jellyfinAuthenticationError(error, action = "sign in") {
  if (error?.status === 401) return "The Jellyfin username or password was not accepted.";
  if (error?.status === 403) return action === "enroll"
    ? "This Jellyfin account must be enabled and have administrator access before it can be enrolled."
    : "This account is not the enrolled Jellyfin owner.";
  if (error?.status === 409 || error?.code === "JELLYFIN_NOT_CONFIGURED") {
    return "Connect and verify Jellyfin under Media → Connections before enrolling an owner.";
  }
  if (error?.status === 429) return "Too many sign-in attempts. Wait a moment, then try again.";
  if (error?.status === 0) return "Helmsman could not be reached. Check the connection and try again.";
  return action === "enroll"
    ? "The Jellyfin owner could not be enrolled. Check the connection and credentials, then try again."
    : "Jellyfin sign-in could not be completed. Check the connection and try again.";
}

async function submitJellyfinLogin(form) {
  const submission = beginGateSubmission(form, "Signing in…");
  if (!submission) return;
  const error = form.querySelector("#jellyfin-login-error");
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const passwordInput = form.querySelector("input[name='password']");
  error.textContent = "";
  try {
    const result = await api("/api/v2/auth/jellyfin/login", {
      method: "POST",
      csrf: false,
      body: {
        username,
        password: String(data.get("password") || ""),
        deviceName: automaticDeviceName(),
        origin: location.origin
      }
    });
    if (passwordInput) passwordInput.value = "";
    applyAuthenticationResult(result, { jellyfinOwner: username });
    await loadAuthenticatedData();
    renderPage({ force: true });
  } catch (caught) {
    error.textContent = jellyfinAuthenticationError(caught);
  } finally {
    if (passwordInput) passwordInput.value = "";
    endGateSubmission(form, submission);
  }
}

async function submitJellyfinEnrollment(form) {
  const submission = beginGateSubmission(form, "Enrolling…");
  if (!submission) return;
  const error = form.querySelector("#jellyfin-enroll-error");
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  const passwordInput = form.querySelector("input[name='password']");
  error.textContent = "";
  try {
    const result = await api("/api/v2/auth/jellyfin/enroll", {
      method: "POST",
      body: {
        username,
        password: String(data.get("password") || ""),
        deviceName: automaticDeviceName(),
        origin: location.origin
      }
    });
    if (passwordInput) passwordInput.value = "";
    applyAuthenticationResult(result, { jellyfinOwner: username });
    state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
    await loadSessions();
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast("Jellyfin owner enrolled. New browsers can now sign in with Jellyfin.", "success");
  } catch (caught) {
    error.textContent = jellyfinAuthenticationError(caught, "enroll");
  } finally {
    if (passwordInput) passwordInput.value = "";
    endGateSubmission(form, submission);
  }
}

async function submitLegacyAccessLogin(form) {
  const submission = beginGateSubmission(form, "Signing in…");
  if (!submission) return;
  const error = form.querySelector("#legacy-access-login-error");
  const data = new FormData(form);
  const accessKeyInput = form.querySelector("input[name='accessKey']");
  error.textContent = "";
  try {
    const result = await api("/api/v2/access/login", {
      method: "POST",
      csrf: false,
      body: {
        accessKey: String(data.get("accessKey") || ""),
        deviceName: automaticDeviceName(),
        origin: location.origin
      }
    });
    if (accessKeyInput) accessKeyInput.value = "";
    applyAuthenticationResult(result);
    await loadAuthenticatedData();
    location.hash = "#/settings";
    renderPage({ force: true });
    showToast("Legacy access accepted. Enroll the Jellyfin owner to complete migration.", "success");
  } catch (caught) {
    if (caught?.status === 401) error.textContent = "The legacy access key was not accepted.";
    else if (caught?.status === 429) error.textContent = "Too many sign-in attempts. Wait a moment, then try again.";
    else if (caught?.status === 0) error.textContent = "Helmsman could not be reached. Check the connection and try again.";
    else error.textContent = "Legacy sign-in could not be completed. Check the connection and try again.";
  } finally {
    if (accessKeyInput) accessKeyInput.value = "";
    endGateSubmission(form, submission);
  }
}

async function submitService(form) {
  const serviceId = form.dataset.serviceId;
  const error = form.querySelector("#service-error");
  syncServiceAuthFields(form);
  if (!form.reportValidity()) return;
  error.textContent = "";
  try {
    const result = await api(`/api/v2/services/${encodeURIComponent(serviceId)}`, {
      method: "PUT",
      body: serviceDraftBody(form, { includeMonitoring: true })
    });
    closeModal();
    if (result?.browserAuthenticationReset === true) {
      await initialize();
      showToast("Jellyfin authorization changed. All browsers were signed out; sign in again.", "success");
      return;
    }
    await loadAuthenticatedData({ refresh: true });
    const needsOwnerEnrollment = serviceId === "jellyfin" && !authenticationState().configured;
    if (needsOwnerEnrollment) location.hash = "#/settings";
    renderPage({ force: true, preserveFocus: true });
    showToast(needsOwnerEnrollment
      ? "Jellyfin connected. Enroll its administrator to finish browser sign-in."
      : "Connection saved. Its credential cannot be read back.", "success");
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

async function testLokiService(form, button) {
  if (!form) return;
  syncLokiForm(form);
  if (!form.reportValidity()) return;
  const error = form.querySelector("#loki-error");
  const panel = form.querySelector("#loki-test-result");
  const serviceId = form.dataset.lokiServiceId;
  const hasNewCredential = Boolean(
    form.querySelector("input[name='username']")?.value
    || form.querySelector("input[name='password']")?.value
    || form.querySelector("input[name='bearerToken']")?.value
  );
  const useSaved = Boolean(serviceId) && lokiConnectionUnchanged(form) && !hasNewCredential;
  const revision = advanceServiceTestRevision(form);
  error.textContent = "";
  panel.hidden = false;
  panel.dataset.state = "checking";
  panel.querySelector(".health-dot").className = "health-dot is-checking";
  panel.querySelector("[data-test-title]").textContent = "Testing Loki connection";
  panel.querySelector("[data-test-detail]").textContent = "Checking readiness, authorization, labels, and bounded query access…";
  setMarkup(panel.querySelector("[data-test-capabilities]"), "");
  panel.querySelector("[data-test-note]").textContent = "Read-only test — nothing is saved.";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await api(useSaved
      ? `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}/test`
      : "/api/v2/infrastructure/services/test", {
      method: "POST",
      body: useSaved ? {} : lokiDraftBody(form)
    });
    if (form.isConnected && form.dataset.testRevision === revision) {
      showConnectionTestResult(form, { ...result, service: "loki" }, "#loki-test-result");
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

async function submitLokiService(form) {
  syncLokiForm(form);
  if (!form.reportValidity()) return;
  const serviceId = form.dataset.lokiServiceId;
  const error = form.querySelector("#loki-error");
  const submit = form.querySelector("button[type='submit']");
  error.textContent = "";
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const selectedBeforeSave = state.logging.loki.connectorId;
    const saved = await api(serviceId
      ? `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}`
      : "/api/v2/infrastructure/services", {
      method: serviceId ? "PUT" : "POST",
      body: lokiDraftBody(form)
    });
    closeModal();
    await loadAuthenticatedData({ refresh: true });
    const queryable = queryableLokiConfigurations();
    const savedQueryable = queryable.find(({ id }) => id === saved?.id);
    if (!selectedBeforeSave || selectedBeforeSave === serviceId) {
      state.logging.loki.connectorId = savedQueryable?.id || queryable[0]?.id || "";
      state.logging.loki.entries = [];
      state.logging.loki.truncated = false;
      state.logging.loki.stats = null;
      state.logging.loki.lastRunAt = "";
      state.logging.loki.resultRouteHash = "";
    }
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    showToast(serviceId ? "Loki connection updated." : "Loki connected.", "success");
  } catch (caught) {
    error.textContent = caught.message;
  } finally {
    if (submit?.isConnected) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
    }
  }
}

async function deleteLokiService(serviceId, button) {
  if (!INFRASTRUCTURE_ID_PATTERN.test(String(serviceId || ""))) return;
  const service = lokiConfigurationById(serviceId);
  if (!service) return;
  const targetRevision = service.targetRevision;
  await runConfirmedDeletion(button, {
    key: `delete:loki:${serviceId}`,
    title: "Remove Loki connection?",
    message: `Remove ${service.displayName} and its protected authentication values? Built-in Helmsman logs will remain available.`,
    confirmLabel: "Remove connection",
    path: `/api/v2/infrastructure/services/${encodeURIComponent(serviceId)}`,
    validate: () => lokiConfigurationById(serviceId)?.targetRevision === targetRevision,
    staleMessage: "That Loki connection changed while confirmation was open. Review it before removing it.",
    successMessage: "Loki connection and its protected authentication values were removed.",
    applyLocalSuccess: () => {
      if (state.config && Array.isArray(state.config.infrastructureServices)) {
        state.config.infrastructureServices = state.config.infrastructureServices.filter(({ id }) => id !== serviceId);
      }
      if (state.logging.loki.connectorId === serviceId) {
        state.logging.loki.connectorId = "";
        state.logging.loki.entries = [];
        state.logging.loki.truncated = false;
        state.logging.loki.stats = null;
        state.logging.loki.error = "";
        state.logging.loki.lastRunAt = "";
        state.logging.loki.resultRouteHash = "";
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
    const result = await api("/api/v2/config", {
      method: "PUT",
      body: {
        allowedCidrs: allowedCidrsForForm(form, data),
        allowPublicHttps: data.get("allowPublicHttps") === "on"
      }
    });
    if (result?.browserAuthenticationReset === true) {
      await initialize();
      showToast("The Jellyfin network boundary changed. All browsers were signed out; sign in again.", "success");
      return;
    }
    state.config = result;
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
      if (item.seasonRequestTarget) void loadSeasonDetailsForMedia(item.id);
      requestAnimationFrame(() => {
        const actionControl = drawerLayer.querySelector(`[data-control-operation='${focusOperation}']`);
        const preferred = actionControl && !actionControl.disabled
          ? actionControl
          : drawerLayer.querySelector("#media-drawer-title");
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
  if (state.actionMutation) return { confirmed: false, accepted: false, outcomeUnknown: false, refreshed: false };
  const returnFocus = focusReference(button);
  const presentation = controlConfirmationPresentation(operation);
  const confirmed = await confirmControl({ ...presentation, message });
  if (!confirmed || state.actionMutation) return { confirmed: false, accepted: false, outcomeUnknown: false, refreshed: false };
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
    return { confirmed: true, accepted: false, outcomeUnknown: false, refreshed: false, stale: true };
  }
  let accepted = false;
  let outcomeUnknown = false;
  let refreshed = false;
  setControlBusy(button, key);
  try {
    await api(path, { method: "POST", body });
    accepted = true;
    showToast(successMessage, "success");
  } catch (error) {
    outcomeUnknown = ["ACTION_OUTCOME_UNKNOWN", "NETWORK_ERROR", "INVALID_RESPONSE"].includes(error?.code)
      || error?.status === 0
      || Number.isSafeInteger(error?.status) && error.status >= 500 && error.status <= 599
      || !Number.isSafeInteger(error?.status);
    showToast(error.message, "danger");
  } finally {
    refreshed = await refreshOperations({ afterCurrent: true });
    if (outcomeUnknown) {
      state.actionAwaitingRefresh = key;
      showToast(refreshed
        ? "The action may have reached the service. Review the refreshed state before trying again."
        : "The action may have been accepted, but current state could not be refreshed. Wait before trying another action.", "danger");
    } else if (!refreshed && accepted) {
      state.actionAwaitingRefresh = key;
      showToast("The action may have been accepted, but current state could not be refreshed. Wait before trying another action.", "danger");
    } else {
      state.actionAwaitingRefresh = "";
      state.actionMutation = "";
    }
    refreshControlSurface({ workloadId, mediaId, focusOperation: operation, returnFocus });
  }
  return { confirmed: true, accepted, outcomeUnknown, refreshed };
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
  const queueId = String(button?.dataset.controlQueueId || "");
  const item = mediaRecordById(mediaId);
  const connection = configuredMediaConnection(serviceId);
  const allowed = mediaControlActions(item).some((action) => (
    action.serviceId === serviceId
    && action.operation === operation
    && String(action.resourceId || "") === resourceId
    && String(action.queueId || "") === queueId
  ));
  if (!item || !connection?.targetRevision || !allowed) {
    showToast("That media action is no longer available. Refresh the media view and try again.", "danger");
    return;
  }
  const retry = operation === "retryRequest";
  const queueRecovery = operation === "blocklistAndSearch";
  const validate = () => {
    const currentItem = mediaRecordById(mediaId);
    const currentConnection = configuredMediaConnection(serviceId);
    return currentConnection?.targetRevision === connection.targetRevision
      && mediaControlActions(currentItem).some((action) => (
        action.serviceId === serviceId
        && action.operation === operation
        && String(action.resourceId || "") === resourceId
        && String(action.queueId || "") === queueId
      ));
  };
  await performControl(button, {
    key: button.dataset.controlKey,
    message: retry
      ? `Retry the failed Seerr request for ${item.title} (request ${resourceId})?`
      : queueRecovery
        ? `Remove ${item.title} and its downloaded data from the download client, blocklist this release in ${serviceId === "radarr" ? "Radarr" : "Sonarr"}, and allow it to look for a replacement according to its settings?`
      : item.mediaType === "episode"
        ? `Search the Sonarr series containing ${item.title}? Sonarr may send a matching release to the download client.`
        : `Search again for ${item.title} in ${serviceId === "radarr" ? "Radarr" : "Sonarr"}? It may send a matching release to the download client.`,
    path: "/api/v2/actions/media",
    body: queueRecovery
      ? {
          serviceId,
          operation,
          queueId: Number(queueId),
          targetRevision: connection.targetRevision
        }
      : {
          serviceId,
          operation,
          resourceId: Number(resourceId),
          targetRevision: connection.targetRevision
        },
    successMessage: retry
      ? `Seerr retry started for ${item.title}.`
      : queueRecovery
        ? `${serviceId === "radarr" ? "Radarr" : "Sonarr"} accepted the blocklist and replacement action for ${item.title}.`
      : `${serviceId === "radarr" ? "Radarr" : "Sonarr"} search started for ${item.title}.`,
    mediaId,
    operation,
    validate,
    staleMessage: "That media action is no longer available. Refresh the media view and try again."
  });
}

function seasonSelectionCopy(seasonNumbers) {
  const labels = seasonNumbers.map((seasonNumber) => `Season ${seasonNumber}`);
  if (labels.length < 2) return labels[0] || "the selected season";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

async function runSeasonRequest(button) {
  if (state.actionMutation) return;
  const panel = button?.closest?.("[data-season-panel]");
  const mediaId = String(button?.dataset.mediaId || panel?.dataset?.mediaId || "");
  const item = mediaRecordById(mediaId);
  const context = seasonRequestContext(item);
  const detail = context?.key ? state.media.seasonDetails.get(context.key) : null;
  const seasonNumbers = selectedSeasonNumbers(panel);
  const requestable = new Set((detail?.state === "ready" ? detail.seasons : [])
    .filter((season) => season.requestable && season.seasonNumber > 0)
    .map(({ seasonNumber }) => seasonNumber));
  if (!item
    || !context?.connection
    || !context.targetRevision
    || detail?.state !== "ready"
    || !SEASON_DETAIL_REVISION_PATTERN.test(detail.detailRevision || "")
    || !seasonNumbers.length
    || seasonNumbers.length > MAX_REQUESTED_SEASONS
    || seasonNumbers.some((seasonNumber) => !requestable.has(seasonNumber))) {
    showToast("Those seasons are no longer available to request. Reload the season catalog and try again.", "danger");
    if (item?.seasonRequestTarget) await loadSeasonDetailsForMedia(mediaId, { force: true });
    return;
  }
  const captured = {
    mediaId: context.target.mediaId,
    targetRevision: context.targetRevision,
    detailRevision: detail.detailRevision,
    seasonNumbers
  };
  const requestSubject = item.mediaType === "episode"
    ? `the parent series linked to ${item.title} (TMDb ${captured.mediaId})`
    : `${item.title} (TMDb ${captured.mediaId})`;
  const validate = () => {
    const currentItem = mediaRecordById(mediaId);
    const currentContext = seasonRequestContext(currentItem);
    const currentDetail = currentContext?.key ? state.media.seasonDetails.get(currentContext.key) : null;
    const currentRequestable = new Set((currentDetail?.state === "ready" ? currentDetail.seasons : [])
      .filter((season) => season.requestable && season.seasonNumber > 0)
      .map(({ seasonNumber }) => seasonNumber));
    const currentSelection = selectedSeasonNumbers(panel);
    return currentContext?.target.mediaId === captured.mediaId
      && currentContext.targetRevision === captured.targetRevision
      && currentDetail?.detailRevision === captured.detailRevision
      && currentSelection.length === captured.seasonNumbers.length
      && currentSelection.every((seasonNumber, index) => seasonNumber === captured.seasonNumbers[index])
      && captured.seasonNumbers.every((seasonNumber) => currentRequestable.has(seasonNumber));
  };
  const result = await performControl(button, {
    key: `media:seerr:requestSeasons:${captured.mediaId}`,
    message: `Request ${seasonSelectionCopy(captured.seasonNumbers)} for ${requestSubject} through Seerr?`,
    path: "/api/v2/actions/media",
    body: {
      serviceId: "seerr",
      operation: "requestSeasons",
      resourceId: captured.mediaId,
      seasonNumbers: captured.seasonNumbers,
      targetRevision: captured.targetRevision,
      detailRevision: captured.detailRevision
    },
    successMessage: `${captured.seasonNumbers.length === 1 ? "Season request" : "Season requests"} submitted for ${item.title}.`,
    mediaId,
    operation: "requestSeasons",
    validate,
    staleMessage: "The series, Seerr connection, or season catalog changed. Review the current seasons and try again."
  });
  if (result?.confirmed && !result?.stale) {
    state.media.seasonDetails.delete(`${captured.mediaId}:${captured.targetRevision}`);
    if (drawerLayer?.classList.contains("is-open") && state.media.selectedId === mediaId) {
      await loadSeasonDetailsForMedia(mediaId, { force: true });
    }
  }
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

// One refresh for the whole app: runs a full health check (media and
// infrastructure) and reloads whatever the current page shows.
async function refreshEverything({ announce = true } = {}) {
  if (!state.status?.authenticated || state.globalRefreshing) return false;
  state.globalRefreshing = true;
  updateChrome();
  const route = currentRoute();
  try {
    const tasks = [
      refreshOperations({ afterCurrent: true }),
      loadInfrastructureTargets({ render: false }),
      loadAgent({ render: false })
    ];
    if (route === "health") tasks.push(loadProwlarr({ render: false }));
    if (route === "logs") tasks.push(loadJournalLogs({ render: false }), loadLoggingSettings({ render: false }));
    if (route === "logs" && loggingRouteContext().view === "output") tasks.push(loadServerOutput({ render: false }));
    if (route === "launchpad") tasks.push(loadLaunchpadLinks({ render: false }));
    if (route === "settings") tasks.push(loadSessions({ render: false }));
    const [operations] = await Promise.allSettled(tasks);
    const ok = operations.status === "fulfilled" && operations.value === true;
    if (!state.status?.authenticated) return false;
    state.lastMarkup = "";
    renderPage({ force: true, preserveFocus: true });
    if (announce) showToast(ok ? "Everything is up to date." : "Some checks could not finish. Try again in a moment.", ok ? "success" : "danger");
    return ok;
  } finally {
    state.globalRefreshing = false;
    updateChrome();
  }
}

// Coming back to the tab or window shows the latest results at once instead
// of waiting for the next 30-second poll. The server keeps checking while
// the tab is hidden, so this only fetches what it already has.
let lastReturnRefreshAt = 0;
async function refreshOnReturn() {
  if (document.visibilityState !== "visible" || !state.status?.authenticated || state.starting) return;
  const now = Date.now();
  if (now - lastReturnRefreshAt < 5_000) return;
  lastReturnRefreshAt = now;
  schedulePolling();
  try {
    await loadOperations();
    await loadAgent({ render: currentRoute() === "system" });
    if (["system", "infrastructure"].includes(state.workspace)) await loadInfrastructureTargets({ render: false });
  } catch {
    // The regular poll retries.
  }
}

document.addEventListener("visibilitychange", () => { refreshOnReturn(); });
globalThis.addEventListener?.("focus", () => { refreshOnReturn(); });

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
  if (render && ["system", "infrastructure"].includes(state.workspace)) {
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
  if (render && ["system", "infrastructure"].includes(state.workspace)) {
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
  state.status = {
    ...state.status,
    authenticated: false,
    session: null,
    csrfToken: null,
    authentication: state.status?.authentication
      ? { ...state.status.authentication, ownerName: null }
      : state.status?.authentication
  };
  state.csrfToken = "";
  state.config = null;
  state.snapshot = null;
  state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
  state.sessionMutation = "";
  state.actionMutation = "";
  state.actionAwaitingRefresh = "";
  state.media.seasonGeneration += 1;
  state.media.seasonDetails.clear();
  state.media.seasonLoads.clear();
  state.operationsRequestGeneration += 1;
  state.operationsRefreshPromise = null;
  state.refreshing = false;
  state.infrastructure = emptyInfrastructureState();
  state.logging = emptyLoggingState();
  state.agent = emptyAgentState();
  state.prowlarr = emptyProwlarrState();
  state.lastMarkup = "";
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
  const [config] = await Promise.all([api("/api/v2/config"), loadOperations(), loadSessions(), loadAgent().catch(() => false)]);
  state.config = config;
  state.infrastructure.targets = normalizedInfrastructureTargets(config?.infrastructureEnvironments || config?.infrastructureTargets || []);
  state.infrastructure.loaded = true;
  state.infrastructure.error = "";
  if (state.workspace === "media" && currentRoute() === "health") void loadProwlarr();
  if (options.refresh) await refreshOperations();
}

function applyLoggingRouteContext() {
  const context = loggingRouteContext();
  if (context.service) {
    state.logging.loki.service = context.service;
    state.logging.loki.contextService = context.service;
  } else if (state.logging.loki.contextService) {
    if (state.logging.loki.service === state.logging.loki.contextService) state.logging.loki.service = "";
    state.logging.loki.contextService = "";
  }
  if (context.connectorId && queryableLokiConfigurations().some(({ id }) => id === context.connectorId)) {
    state.logging.loki.connectorId = context.connectorId;
  } else {
    const connectorId = lokiConnectorIdForMonitorService(context.service);
    if (connectorId && queryableLokiConfigurations().some(({ id }) => id === connectorId)) {
      state.logging.loki.connectorId = connectorId;
    }
  }
}

async function loadLoggingRouteData({ contextualQuery = true } = {}) {
  if (!state.status?.authenticated || currentRoute() !== "logs") return;
  applyLoggingRouteContext();
  if (!state.logging.settings.loaded) void loadLoggingSettings({ render: true });
  if (loggingRouteContext().view === "output") await loadServerOutput({ render: false });
  if (!state.logging.journal.loaded) await loadJournalLogs({ render: false });
  const context = loggingRouteContext();
  const hasContext = Boolean(context.service || context.code || context.from || context.containerId || context.node || context.workloadId);
  if (contextualQuery && context.view === "loki" && hasContext && queryableLokiConfigurations().length) {
    await runLokiQuery({ render: false });
  }
}

function schedulePolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (document.visibilityState === "visible" && state.status?.authenticated) {
      try {
        await loadOperations();
        // Keeps the helper's badge current on every page; only the Overview re-renders.
        await loadAgent({ render: currentRoute() === "system" });
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
    if (state.status.authenticated) {
      await loadAuthenticatedData();
      if (currentRoute() === "logs") await loadLoggingRouteData();
      if (currentRoute() === "launchpad") await loadLaunchpadLinks({ render: false });
      if (currentRoute() === "manual") await loadManual({ render: false });
    }
    else {
      state.config = null;
      state.snapshot = null;
      state.sessions = { loaded: false, currentSessionId: "", items: [], error: "" };
      state.sessionMutation = "";
      state.manual = emptyManualState();
      state.infrastructure = emptyInfrastructureState();
      state.media.seasonGeneration += 1;
      state.media.seasonDetails.clear();
      state.media.seasonLoads.clear();
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
  if (action === "edit-manual") {
    openManualEditor();
    return;
  }
  if (action === "agent-test-ai") {
    await testAgentModel(target);
    return;
  }
  if (action === "agent-test-notify") {
    await testAgentNotify(target);
    return;
  }
  if (action === "agent-remove") {
    await removeAgentPart(target.dataset.agentPart);
    return;
  }
  if (action === "agent-rule-toggle" || action === "agent-rule-delete") {
    await changeAgentRule(String(target.dataset.ruleId || ""), action === "agent-rule-delete" ? "delete" : "toggle");
    return;
  }
  if (action === "agent-rate") {
    const id = target.dataset.conversationId;
    const current = state.agent.ratings.get(id)?.rating || null;
    await rateConversation(id, { rating: current === target.dataset.rating ? null : target.dataset.rating });
    return;
  }
  if (action === "agent-edit-answer") {
    state.agent.editingAnswer = String(target.dataset.conversationId || "");
    rerenderAgent();
    requestAnimationFrame(() => document.getElementById(`agent-correction-${state.agent.editingAnswer}`)?.focus());
    return;
  }
  if (action === "agent-edit-cancel") {
    state.agent.editingAnswer = "";
    rerenderAgent();
    return;
  }
  if (action === "agent-clear-fix") {
    await rateConversation(target.dataset.conversationId, { correction: null });
    return;
  }
  if (action === "agent-training-delete") {
    await deleteTraining();
    return;
  }
  if (action === "agent-proposal") {
    await decideAgentProposal(target);
    return;
  }
  if (action === "agent-run") {
    await runAgentJob(target.dataset.job);
    return;
  }
  if (action === "agent-chat-clear") {
    state.agent.chat = [];
    rerenderAgent();
    return;
  }
  if (action === "settings-tab") {
    setSettingsTab(String(target.dataset.settingsTab || ""), { focus: Boolean(target.closest?.(".settings-tabs")) });
    if (currentRoute() !== "settings") location.hash = "#/settings";
    return;
  }
  if (["prowlarr-test", "prowlarr-test-all", "prowlarr-sync", "prowlarr-test-apps"].includes(action)) {
    await runProwlarrAction(action, action === "prowlarr-test" ? Number(target.dataset.indexerId) : null);
    return;
  }
  if (action === "prowlarr-refresh") {
    await loadProwlarr();
    return;
  }
  if (action === "agent-voice-preset") {
    const input = document.getElementById("agent-voice-input");
    const preset = AGENT_VOICE_PRESETS[target.dataset.preset];
    if (input && preset) {
      input.value = preset;
      const count = document.getElementById("agent-voice-count");
      if (count) count.textContent = agentVoiceCountText(preset, agentData());
      input.focus({ preventScroll: true });
    }
    return;
  }
  if (action === "agent-use-local-zone") {
    const input = target.closest("form")?.querySelector("input[name='timeZone']");
    if (input) input.value = String(target.dataset.zone || "");
    return;
  }
  if (action === "manual-use-template") {
    await useManualTemplate();
    return;
  }
  if (action === "save-manual") {
    await saveManual();
    return;
  }
  if (action === "discard-manual-draft") {
    discardManualDraft();
    return;
  }
  if (action === "manual-jump") {
    jumpToManualTarget(target.dataset.manualTarget);
    return;
  }
  if (action === "clear-manual-filter") {
    setManualFilter("");
    return;
  }
  if (action === "helmsman-search-select") {
    await activateSearchResult(Number(target.dataset.searchIndex));
    return;
  }
  if (action === "open-helmsman-search") {
    openGlobalSearch();
    return;
  }
  if (action === "edit-launch-address") {
    openLaunchAddress(target.dataset.launchKind, target.dataset.launchId);
    return;
  }
  if (action === "clear-launch-address") {
    await saveLaunchAddress(target.dataset.launchKind, target.dataset.launchId, "", target.closest("form"));
    return;
  }
  if (action === "acknowledge-report") {
    await setReportAcknowledged(target, true);
    return;
  }
  if (action === "restore-acknowledgement") {
    await setReportAcknowledged(target, false);
    return;
  }
  if (action === "toggle-sidebar") toggleSidebar();
  if (action === "switch-workspace") await switchWorkspace(target.dataset.workspace, target.dataset.workspaceRoute);
  if (action === "open-service") openService(target.dataset.serviceId);
  if (action === "open-overview-service") await openOverviewService(target.dataset.overviewKind, target.dataset.overviewId);
  if (action === "open-infrastructure-signal") await openInfrastructureSignal(target.dataset.infrastructureSignal);
  if (action === "open-media-detail") openMediaDrawer(target.dataset.mediaId);
  if (action === "close-media-drawer") closeMediaDrawer();
  if (action === "retry-season-details") await loadSeasonDetailsForMedia(String(target.dataset.mediaId || ""), { force: true });
  if (action === "request-seasons") await runSeasonRequest(target);
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
  if (action === "open-loki-service") openLokiService(target.dataset.lokiServiceId || "");
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
  if (action === "refresh-live" || action === "global-refresh") await refreshEverything();
  if (action === "refresh-journal") await loadJournalLogs();
  if (action === "logging-debug-off") await saveLoggingSettings(false);
  if (action === "arr-indexer-test" && ARR_INDEXER_SERVICES.includes(target.dataset.arrService)) await runArrIndexerTest(target.dataset.arrService, Number(target.dataset.indexerId));
  if (action === "arr-indexer-test-all" && ARR_INDEXER_SERVICES.includes(target.dataset.arrService)) await runArrIndexerTest(target.dataset.arrService);
  if (action === "arr-indexer-refresh" && ARR_INDEXER_SERVICES.includes(target.dataset.arrService)) await loadArrIndexers(target.dataset.arrService);
  if (action === "refresh-server-output") await loadServerOutput();
  if (action === "load-more-journal") await loadJournalLogs({ append: true });
  if (action === "test-service") testService(target.closest("#service-form"), target);
  if (action === "delete-service") await deleteService(target.dataset.serviceId, target);
  if (action === "test-portainer-service") testPortainerService(target.closest("#portainer-form"), target);
  if (action === "delete-portainer-service") await deletePortainerService(target.dataset.portainerServiceId, target);
  if (action === "test-loki-service") testLokiService(target.closest("#loki-form"), target);
  if (action === "delete-loki-service") await deleteLokiService(target.dataset.lokiServiceId, target);
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
  if (event.target?.dataset?.seasonSelect !== undefined) {
    syncSeasonSelection(event.target.closest?.("[data-season-panel]"), event.target);
  }
  const fieldName = String(event.target?.name || "");
  const lokiQueryForm = event.target.closest?.("#loki-query-form");
  if (lokiQueryForm && ["connectorId", "range", "service", "query", "search"].includes(fieldName)) {
    syncLokiQueryControls(lokiQueryForm);
    invalidateLokiQueryResults({ inPlace: true });
  }
  const journalFilter = event.target?.dataset?.journalFilter;
  if (journalFilter && journalFilter !== "search" && ["level", "kind", "source", "range"].includes(journalFilter)) {
    state.logging.journal.filters[journalFilter] = String(event.target.value || "all");
    if (["level", "kind"].includes(journalFilter)) {
      // Level and kind are filtered by the server so debug entries cannot
      // crowd the rest out of the loaded page.
      state.logging.journal.nextCursor = "";
      void loadJournalLogs();
    } else {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }
  }
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
  const lokiForm = event.target.closest?.("#loki-form");
  if (lokiForm && ["tlsMode", "authMode", "url", "tenantId", "certificateFingerprint", "username", "password", "bearerToken"].includes(fieldName)) {
    syncLokiForm(lokiForm);
    invalidateLokiTest(lokiForm);
  }
});

document.addEventListener("input", (event) => {
  const fieldName = String(event.target?.name || "");
  if (event.target?.id === "agent-voice-input") {
    const count = document.getElementById("agent-voice-count");
    if (count) count.textContent = agentVoiceCountText(event.target.value, agentData());
    return;
  }
  if (event.target?.id === "agent-ask-input") {
    state.agent.draft = String(event.target.value || "").slice(0, AGENT_QUESTION_LIMIT);
    return;
  }
  const lokiQueryForm = event.target.closest?.("#loki-query-form");
  if (lokiQueryForm && ["query", "search"].includes(fieldName)) {
    syncLokiQueryControls(lokiQueryForm);
    invalidateLokiQueryResults({ inPlace: true });
  }
  if (event.target?.matches?.("[data-manual-filter]")) {
    setManualFilter(event.target.value, { rerenderInput: false });
    return;
  }
  if (event.target?.id === "manual-editor") {
    state.manual.draft = String(event.target.value || "");
    updateManualEditorStatus();
    return;
  }
  if (event.target?.id === "helmsman-search-input") {
    updateGlobalSearch(event.target.value);
    return;
  }
  if (event.target?.matches?.("[data-launchpad-filter]")) {
    state.launchpad.filter = String(event.target.value || "").slice(0, 80);
    applyLaunchpadFilter();
    return;
  }
  if (event.target?.dataset?.journalFilter === "search") {
    state.logging.journal.filters.search = String(event.target.value || "").slice(0, 160);
    clearTimeout(loggingFilterTimer);
    loggingFilterTimer = setTimeout(() => {
      state.lastMarkup = "";
      renderPage({ force: true, preserveFocus: true });
    }, 120);
  }
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
  const lokiForm = event.target.closest?.("#loki-form");
  if (lokiForm && ["url", "tenantId", "certificateFingerprint", "username", "password", "bearerToken"].includes(fieldName)) {
    syncLokiForm(lokiForm);
    invalidateLokiTest(lokiForm);
  }
});

document.addEventListener("error", (event) => {
  if (event.target?.classList?.contains("media-art-image") || event.target?.classList?.contains("hero-art-image")) {
    if (!retryMediaArtwork(event.target)) event.target.remove();
  }
}, true);

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "loki-query-form") {
    syncLokiQueryControls(event.target);
    runLokiQuery();
  }
  if (event.target.id === "media-search-form") {
    state.media.filters.library = String(new FormData(event.target).get("query") || state.media.filters.homeSearch || "").slice(0, 120);
    location.hash = "#/library";
  }
  if (event.target.id === "setup-form") submitSetup(event.target);
  if (event.target.id === "jellyfin-login-form") submitJellyfinLogin(event.target);
  if (event.target.id === "jellyfin-enroll-form") submitJellyfinEnrollment(event.target);
  if (event.target.id === "legacy-access-login-form") submitLegacyAccessLogin(event.target);
  if (event.target.id === "service-form") submitService(event.target);
  if (event.target.id === "portainer-form") submitPortainerService(event.target);
  if (event.target.id === "loki-form") submitLokiService(event.target);
  if (event.target.id === "proxmox-form") submitInfrastructureTarget(event.target);
  if (event.target.id === "proxmox-endpoint-form") submitInfrastructureEndpoint(event.target);
  if (event.target.id === "network-form") submitNetwork(event.target);
  if (event.target.id === "launch-address-form") submitLaunchAddress(event.target);
  if (event.target.id === "agent-ai-form") submitAgentModel(event.target);
  if (event.target.id === "agent-voice-form") submitAgentVoice(event.target);
  if (event.target.id === "agent-autonomy-form") submitAgentAutonomy(event.target);
  if (event.target.id === "agent-health-form") submitAgentHealth(event.target);
  if (event.target.id === "agent-downloads-form") submitAgentDownloads(event.target);
  if (event.target.id === "agent-indexers-form") submitAgentIndexers(event.target);
  if (event.target.id === "agent-conversations-form") void saveTrainingSettings(event.target);
  if (event.target.classList?.contains("agent-correction-form")) {
    const correction = String(new FormData(event.target).get("correction") || "").trim();
    void rateConversation(event.target.dataset.conversationId, { correction: correction || null });
  }
  if (event.target.id === "logging-debug-form") {
    const hours = Number(new FormData(event.target).get("hours"));
    void saveLoggingSettings(true, Number.isSafeInteger(hours) && hours >= 1 ? hours : state.logging.settings.defaultHours);
  }
  if (event.target.id === "agent-settings-form") submitAgentSettings(event.target);
  if (event.target.id === "agent-notify-form") submitAgentNotify(event.target);
  if (event.target.id === "agent-rule-form") submitAgentRule(event.target);
  if (event.target.id === "agent-ask-form") askAgent();
});

window.addEventListener("hashchange", async () => {
  closeControlConfirmation(false, { restoreFocus: false });
  closeMediaDrawer({ restoreFocus: false });
  if (currentRoute() === "logs"
    && state.logging.loki.resultRouteHash
    && state.logging.loki.resultRouteHash !== canonicalLoggingHash()) {
    invalidateLokiQueryResults();
  }
  state.lastMarkup = "";
  renderPage({ force: true });
  if (currentRoute() === "logs" && state.status?.authenticated) {
    await loadLoggingRouteData();
    state.lastMarkup = "";
    renderPage({ force: true });
  }
  if (currentRoute() === "launchpad" && state.status?.authenticated) await loadLaunchpadLinks();
  if (currentRoute() === "manual" && state.status?.authenticated) await loadManual();
  if (state.status?.authenticated) void loadAgent({ render: ["system", "settings"].includes(currentRoute()) });
  if (state.status?.authenticated && state.workspace === "media" && currentRoute() === "health") void loadProwlarr();
  resetRouteScroll();
  main.focus({ preventScroll: true });
  if (currentRoute() === "manual") revealManualTarget();
});

document.addEventListener("keydown", (event) => {
  // Arrow keys move between Settings tabs, as in a standard tab list.
  if (!event.target?.matches?.(".settings-tabs [role='tab']")) return;
  const ids = SETTINGS_TABS.map(({ id }) => id);
  const index = ids.indexOf(event.target.dataset.settingsTab);
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: ids.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  setSettingsTab(ids[(next + ids.length) % ids.length], { focus: true });
});

// Links elsewhere can open a particular Settings tab.
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("[data-settings-tab]:not([data-action='settings-tab'])");
  if (!link) return;
  const id = String(link.dataset.settingsTab || "");
  if (!SETTINGS_TABS.some((tab) => tab.id === id)) return;
  state.settingsTab = id;
  try {
    globalThis.localStorage?.setItem(SETTINGS_TAB_KEY, id);
  } catch {
    // Storage may be blocked.
  }
  if (currentRoute() === "settings") setSettingsTab(id);
}, true);

document.addEventListener("keydown", (event) => {
  // Enter sends a question; Shift+Enter starts a new line.
  if (event.target?.id !== "agent-ask-input" || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  askAgent();
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

privacyButton?.addEventListener("click", () => {
  if (state.status?.authenticated) {
    location.hash = state.workspace === "system"
      ? "#/system"
      : state.workspace === "infrastructure"
        ? "#/incidents"
        : "#/health";
    return;
  }
  showToast("Complete setup or sign in to review health alerts.");
});

skipLink?.addEventListener("click", (event) => {
  event.preventDefault();
  main.focus({ preventScroll: false });
});

// In-manual anchor links scroll within the page instead of changing the
// hash, which Helmsman uses for routing.
document.addEventListener("click", (event) => {
  if (state.route !== "manual") return;
  const link = event.target?.closest?.(".manual-body a[href^='#']");
  if (!link || typeof link.getAttribute !== "function") return;
  event.preventDefault?.();
  const fragment = String(link.getAttribute("href") || "").slice(1);
  const candidates = [fragment, `manual-${fragment}`];
  const targetId = candidates.find((candidate) => candidate && document.getElementById(candidate)?.closest(".manual-page"));
  if (targetId) jumpToManualTarget(targetId);
});

// Manual import: a dropped or chosen .md/.txt file is read in the browser and
// placed in the editor as a draft. Nothing reaches the server until the owner
// presses Save manual.
const MANUAL_IMPORT_EXTENSIONS = /\.(?:md|markdown|txt)$/iu;
let manualDragDepth = 0;

function renderManualImportControl() {
  return `<label class="button manual-import" for="manual-import-input">${icon("download")} Import file<input id="manual-import-input" class="sr-only" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" data-manual-import /></label>`;
}

function manualFileFromTransfer(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  return files.length === 1 ? files[0] : files.length > 1 ? false : null;
}

function transferHasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

async function importManualFile(file) {
  if (!file || !state.manual.loaded) return;
  if (!MANUAL_IMPORT_EXTENSIONS.test(String(file.name || ""))) {
    showToast("Import a .md, .markdown or .txt file.", "danger");
    return;
  }
  if (file.size > MANUAL_MARKDOWN_LIMIT) {
    showToast("That file is over 256 KiB. Shorten it before importing.", "danger");
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    showToast("That file could not be read.", "danger");
    return;
  }
  if (text.includes("\u0000")) {
    showToast("That file is not plain text.", "danger");
    return;
  }
  state.manual.draft = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const editor = modalLayer.querySelector("#manual-editor");
  if (editor) {
    editor.value = state.manual.draft;
    modalLayer.querySelector(".manual-editor__notice")?.remove();
    updateManualEditorStatus();
    editor.focus();
  } else {
    openManualEditor();
    modalLayer.querySelector(".manual-editor__notice")?.remove();
  }
  showToast(`Loaded ${String(file.name).slice(0, 80)}. Review it, then save`);
}

function setManualDragging(active) {
  main.querySelector(".manual-page")?.classList.toggle("is-dragging", active);
  modalLayer.querySelector(".modal-card--manual-editor")?.classList.toggle("is-dragging", active);
}

function manualDropAvailable() {
  return Boolean(state.status?.authenticated && state.manual.loaded && currentRoute() === "manual");
}

document.addEventListener("dragenter", (event) => {
  if (!manualDropAvailable() || !transferHasFiles(event)) return;
  manualDragDepth += 1;
  setManualDragging(true);
});

document.addEventListener("dragover", (event) => {
  if (!manualDropAvailable() || !transferHasFiles(event)) return;
  event.preventDefault?.();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (event) => {
  if (!manualDropAvailable() || !transferHasFiles(event)) return;
  manualDragDepth = Math.max(0, manualDragDepth - 1);
  if (!manualDragDepth) setManualDragging(false);
});

document.addEventListener("drop", (event) => {
  if (!manualDropAvailable() || !transferHasFiles(event)) return;
  event.preventDefault?.();
  manualDragDepth = 0;
  setManualDragging(false);
  const file = manualFileFromTransfer(event.dataTransfer);
  if (file === false) {
    showToast("Drop one file at a time.", "danger");
    return;
  }
  importManualFile(file);
});

document.addEventListener("change", (event) => {
  if (!event.target?.matches?.("[data-manual-import]")) return;
  const file = event.target.files?.[0];
  event.target.value = "";
  importManualFile(file);
});

initializeGlobalSearch();
if (!location.hash || !ROUTES.has(rawRoute())) location.replace(`#/${workspaceLandingRoute(state.workspace)}`);
initialize();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(renderPolicy?.createScriptURL ? renderPolicy.createScriptURL(SERVICE_WORKER_URL) : SERVICE_WORKER_URL).catch(() => {});
}
