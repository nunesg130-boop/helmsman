const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// Reject encoded control/separator bytes and encoded percent itself. The latter
// prevents a second decoding layer upstream from turning `%252e` or `%252f`
// into a traversal or path separator after this allowlist has approved it.
const ENCODED_PATH_HAZARD = /%(?:00|0a|0d|25|2e|2f|5c)/iu;
const MALFORMED_PERCENT = /%(?![a-f0-9]{2})/iu;
const LITERAL_DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/u;
const SECRET_QUERY_KEY = /^(?:api[_-]?key|token|password|authorization|access[_-]?token|secret|target|url|upstream|host)$/iu;
const JELLYFIN_ARTWORK_PATH = /^\/Items\/[A-Za-z0-9_-]{1,160}\/Images\/Primary$/u;
const ARR_ARTWORK_PATH = /^\/MediaCover\/[1-9][0-9]{0,9}\/poster(?:-(?:250|500))?\.jpg$/u;
const SEERR_ARTWORK_PATH = /^\/imageproxy\/tmdb\/t\/p\/w342\/[A-Za-z0-9_-]{1,200}\.(?:jpe?g|png|webp)$/u;
const JELLYFIN_IMAGE_TAG = /^[A-Za-z0-9_-]{1,96}$/u;
const PROXMOX_NODE_NAME = /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const PORTAINER_ENDPOINT_ID = /^[1-9][0-9]{0,9}$/u;
const PORTAINER_CONTAINER_ID = /^[a-f0-9]{64}$/u;
const POSITIVE_RESOURCE_ID = /^[1-9][0-9]{0,9}$/u;

// Proxmox monitoring is intentionally not exposed through the browser bridge.
// Internal callers select one of these opaque identifiers; no request path or
// query supplied by a browser is ever appended to the upstream URL.
const PROXMOX_ROUTES = Object.freeze({
  permissions: "/api2/json/access/permissions",
  version: "/api2/json/version",
  clusterStatus: "/api2/json/cluster/status",
  nodes: "/api2/json/nodes",
  nodeResources: "/api2/json/cluster/resources?type=node",
  guests: "/api2/json/cluster/resources?type=vm",
  storage: "/api2/json/cluster/resources?type=storage"
});
const PROXMOX_NODE_ROUTES = Object.freeze(["tasks", "backups"]);

export const PROXMOX_ROUTE_IDS = Object.freeze([
  ...Object.keys(PROXMOX_ROUTES),
  ...PROXMOX_NODE_ROUTES
]);

// Portainer is an Infrastructure integration, not a browser bridge service.
// Monitoring callers select one of these opaque route identifiers and the
// broker constructs the complete upstream path. A browser can never provide
// an arbitrary Docker API path through this allowlist.
const PORTAINER_ROUTES = Object.freeze({
  systemStatus: "/api/system/status",
  legacyStatus: "/api/status",
  identity: "/api/users/me",
  stacks: "/api/stacks"
});

export const PORTAINER_ROUTE_IDS = Object.freeze([
  ...Object.keys(PORTAINER_ROUTES),
  "environments",
  "containers"
]);

export function normalizePortainerEndpointId(value) {
  const candidate = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!PORTAINER_ENDPOINT_ID.test(candidate)) return null;
  const numeric = Number(candidate);
  return Number.isSafeInteger(numeric) && numeric <= 2_147_483_647 ? numeric : null;
}

export function normalizeProxmoxNodeName(value) {
  if (typeof value !== "string") return null;
  const node = value;
  return PROXMOX_NODE_NAME.test(node) && !node.includes("..") ? node : null;
}

function normalizePositiveResourceId(value, maximum = 2_147_483_647) {
  const candidate = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!POSITIVE_RESOURCE_ID.test(candidate)) return null;
  const numeric = Number(candidate);
  return Number.isSafeInteger(numeric) && numeric <= maximum ? numeric : null;
}

function normalizePortainerContainerId(value) {
  return typeof value === "string" && PORTAINER_CONTAINER_ID.test(value) ? value : null;
}

const PORTAINER_CONTAINER_ACTIONS = Object.freeze({
  start: Object.freeze({ suffix: "start", query: "" }),
  restart: Object.freeze({ suffix: "restart", query: "?t=30" }),
  stop: Object.freeze({ suffix: "stop", query: "?t=30" })
});

/**
 * Builds one exact Portainer container lifecycle request. This is separate
 * from the monitoring authorizer so read-only probes can never be upgraded to
 * writes by changing their HTTP method.
 */
export function authorizePortainerContainerAction(operationValue, parameters = {}) {
  const operation = typeof operationValue === "string" ? operationValue : "";
  const definition = PORTAINER_CONTAINER_ACTIONS[operation];
  const endpointId = normalizePortainerEndpointId(parameters?.endpointId);
  const containerId = normalizePortainerContainerId(parameters?.containerId);
  if (!definition || endpointId === null || !containerId) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That Portainer container action is not allowed.",
      status: 404
    };
  }
  const upstreamPath = `/api/endpoints/${endpointId}/docker/containers/${containerId}/${definition.suffix}`;
  return Object.freeze({
    allowed: true,
    service: "portainer",
    actionId: "container",
    operation,
    endpointId,
    containerId,
    method: "POST",
    upstreamPath,
    upstreamPathAndQuery: `${upstreamPath}${definition.query}`,
    isArtwork: false,
    isLogin: false,
    internalOnly: true,
    credentialRequired: true
  });
}

const PROXMOX_WORKLOAD_ACTIONS = new Set(["start", "reboot", "shutdown"]);

/** Builds one exact Proxmox VM/LXC lifecycle request. */
export function authorizeProxmoxWorkloadAction(operationValue, parameters = {}) {
  const operation = typeof operationValue === "string" ? operationValue : "";
  const node = normalizeProxmoxNodeName(parameters?.node);
  const type = parameters?.type === "qemu" ? "qemu" : parameters?.type === "lxc" ? "lxc" : null;
  const vmid = normalizePositiveResourceId(parameters?.vmid, 999_999_999);
  if (!PROXMOX_WORKLOAD_ACTIONS.has(operation) || !node || !type || vmid === null) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That Proxmox workload action is not allowed.",
      status: 404
    };
  }
  const upstreamPath = `/api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${operation}`;
  return Object.freeze({
    allowed: true,
    service: "proxmox",
    actionId: "workload",
    operation,
    node,
    type,
    vmid,
    method: "POST",
    upstreamPath,
    upstreamPathAndQuery: upstreamPath,
    isArtwork: false,
    isLogin: false,
    internalOnly: true
  });
}

const MEDIA_ACTIONS = Object.freeze({
  retryRequest: Object.freeze({
    service: "seerr",
    path: (id) => `/api/v1/request/${id}/retry`,
    body: ""
  }),
  searchMovie: Object.freeze({
    service: "radarr",
    path: () => "/api/v3/command",
    body: (id) => JSON.stringify({ name: "MoviesSearch", movieIds: [id] })
  }),
  searchSeries: Object.freeze({
    service: "sonarr",
    path: () => "/api/v3/command",
    body: (id) => JSON.stringify({ name: "SeriesSearch", seriesId: id })
  })
});

/**
 * Builds the complete path and body for a narrowly supported media recovery
 * action. The caller supplies only a current local resource identifier.
 */
export function authorizeMediaAction(operationValue, parameters = {}) {
  const operation = typeof operationValue === "string" ? operationValue : "";
  const definition = MEDIA_ACTIONS[operation];
  const service = canonicalServiceId(parameters?.service);
  const resourceId = normalizePositiveResourceId(parameters?.resourceId, 9_999_999_999);
  if (!definition || service !== definition.service || resourceId === null) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That media recovery action is not allowed.",
      status: 404
    };
  }
  const upstreamPath = definition.path(resourceId);
  const body = typeof definition.body === "function" ? definition.body(resourceId) : definition.body;
  return Object.freeze({
    allowed: true,
    service,
    actionId: "media",
    operation,
    resourceId,
    method: "POST",
    upstreamPath,
    upstreamPathAndQuery: upstreamPath,
    body,
    isArtwork: false,
    isLogin: false,
    internalOnly: true
  });
}

const policies = {
  jellyfin: {
    GET: {
      exact: new Set([
        "/System/Info/Public",
        "/System/Info",
        "/Items",
        "/Items/Latest",
        "/UserItems/Resume",
        "/Shows/NextUp",
        "/Sessions"
      ]),
      patterns: [
        /^\/(?:Items\/[^/]+|Users\/[^/]+\/Items\/[^/]+)$/u,
        JELLYFIN_ARTWORK_PATH
      ]
    },
    POST: {
      exact: new Set(["/Users/AuthenticateByName"]),
      patterns: []
    }
  },
  seerr: {
    GET: {
      exact: new Set([
        "/api/v1/status",
        "/api/v1/auth/me",
        "/api/v1/search",
        "/api/v1/request",
        "/api/v1/request/count",
        "/api/v1/discover/trending"
      ]),
      patterns: [/^\/api\/v1\/(?:movie|tv)\/[0-9]+$/u, SEERR_ARTWORK_PATH]
    },
    POST: {
      exact: new Set(["/api/v1/auth/local"]),
      patterns: []
    }
  },
  radarr: {
    GET: {
      exact: new Set([
        "/api/v3/system/status",
        "/api/v3/health",
        "/api/v3/calendar",
        "/api/v3/queue",
        "/api/v3/movie",
        "/api/v3/moviefile"
      ]),
      patterns: [ARR_ARTWORK_PATH]
    }
  },
  sonarr: {
    GET: {
      exact: new Set([
        "/api/v3/system/status",
        "/api/v3/health",
        "/api/v3/calendar",
        "/api/v3/queue",
        "/api/v3/series",
        "/api/v3/episode",
        "/api/v3/episodefile"
      ]),
      patterns: [ARR_ARTWORK_PATH]
    }
  },
  prowlarr: {
    GET: {
      exact: new Set([
        "/api/v1/system/status",
        "/api/v1/health",
        "/api/v1/indexerstatus"
      ]),
      patterns: []
    }
  },
  bazarr: {
    GET: {
      exact: new Set([
        "/api/system/status",
        "/api/system/health",
        "/api/movies/wanted",
        "/api/episodes/wanted"
      ]),
      patterns: []
    }
  },
  qbittorrent: {
    GET: {
      exact: new Set([
        "/api/v2/app/version",
        "/api/v2/app/webapiVersion",
        "/api/v2/sync/maindata",
        "/api/v2/torrents/info",
        "/api/v2/torrents/properties",
        "/api/v2/torrents/files",
        "/api/v2/transfer/info"
      ]),
      patterns: []
    }
  }
};

export const SERVICE_IDS = Object.freeze(Object.keys(policies));

export function canonicalServiceId(value) {
  const id = String(value || "").toLowerCase();
  if (id === "qbit") return "qbittorrent";
  return SERVICE_IDS.includes(id) ? id : null;
}

function validateQuery(url) {
  if (url.search.length > 4096 || MALFORMED_PERCENT.test(url.search)) {
    return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The bridge query is malformed or too large." };
  }
  let count = 0;
  for (const [key, value] of url.searchParams) {
    count += 1;
    if (count > 64
      || !key
      || key.length > 80
      || value.length > 2048
      || CONTROL_CHARACTERS.test(key)
      || CONTROL_CHARACTERS.test(value)
      || SECRET_QUERY_KEY.test(key)) {
      return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The bridge query contains an unsupported field." };
    }
  }
  return { allowed: true };
}

function validateArtworkQuery(service, upstreamPath, url) {
  if (service === "jellyfin" && JELLYFIN_ARTWORK_PATH.test(upstreamPath)) {
    const fields = [...url.searchParams];
    const expected = new Map([
      ["maxWidth", "342"],
      ["quality", "85"]
    ]);
    if (fields.length !== 3) {
      return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The artwork resize query is fixed by Helmsman." };
    }
    let tag = null;
    for (const [key, value] of fields) {
      if (key === "tag") {
        if (tag !== null || !JELLYFIN_IMAGE_TAG.test(value)) {
          return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The artwork revision query is invalid." };
        }
        tag = value;
        continue;
      }
      if (!expected.has(key) || expected.get(key) !== value) {
        return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The artwork resize query is fixed by Helmsman." };
      }
      expected.delete(key);
    }
    if (expected.size || tag === null) {
      return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The artwork resize query is fixed by Helmsman." };
    }
    return { allowed: true };
  }
  if ((service === "radarr" || service === "sonarr") && ARR_ARTWORK_PATH.test(upstreamPath)) {
    const fields = [...url.searchParams];
    if (fields.length === 0) return { allowed: true };
    if (fields.length === 1 && fields[0][0] === "lastWrite" && /^[0-9]{1,20}$/u.test(fields[0][1])) {
      return { allowed: true };
    }
    return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The artwork cache query is not allowed." };
  }
  if (service === "seerr" && SEERR_ARTWORK_PATH.test(upstreamPath) && url.search) {
    return { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The Seerr artwork route does not accept a query." };
  }
  return { allowed: true };
}

function validateFixedCapabilityQuery(service, upstreamPath, url) {
  const fields = [...url.searchParams];
  if (service === "seerr" && /^\/api\/v1\/(?:movie|tv)\/[0-9]+$/u.test(upstreamPath)) {
    return fields.length === 0
      ? { allowed: true }
      : {
          allowed: false,
          code: "QUERY_NOT_ALLOWED",
          message: "The Seerr metadata lookup does not accept a query."
        };
  }
  if (service === "jellyfin" && upstreamPath === "/Sessions") {
    if (fields.length === 1 && fields[0][0] === "ActiveWithinSeconds" && fields[0][1] === "900") {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: "QUERY_NOT_ALLOWED",
      message: "The Jellyfin session query is fixed by the read-only monitoring capability."
    };
  }
  if (service === "radarr" && upstreamPath === "/api/v3/movie") {
    return fields.length === 1 && fields[0][0] === "excludeLocalCovers" && fields[0][1] === "true"
      ? { allowed: true }
      : { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The Radarr catalog query is fixed by Helmsman." };
  }
  if (service === "sonarr" && upstreamPath === "/api/v3/series") {
    return fields.length === 1 && fields[0][0] === "includeSeasonImages" && fields[0][1] === "false"
      ? { allowed: true }
      : { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The Sonarr catalog query is fixed by Helmsman." };
  }
  if (service === "sonarr" && upstreamPath === "/api/v3/calendar") {
    return fields.length === 1 && fields[0][0] === "includeSeries" && fields[0][1] === "true"
      ? { allowed: true }
      : { allowed: false, code: "QUERY_NOT_ALLOWED", message: "The Sonarr calendar query is fixed by Helmsman." };
  }
  return { allowed: true };
}

export function authorizeBridgeRoute(serviceValue, methodValue, requestUrl) {
  const service = canonicalServiceId(serviceValue);
  if (!service) return { allowed: false, code: "SERVICE_NOT_SUPPORTED", message: "That service is not supported." };
  const method = String(methodValue || "GET").toUpperCase();
  const policyMethod = method === "HEAD" ? "GET" : method;
  const methodPolicy = policies[service][policyMethod];
  if (!methodPolicy) {
    return { allowed: false, code: "METHOD_NOT_ALLOWED", message: "That method is not allowed for this service.", status: 405 };
  }

  if (typeof requestUrl !== "string" || !requestUrl.startsWith("/")) {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is invalid." };
  }
  const rawPath = requestUrl.split("?", 1)[0];
  // URL parsing normalizes encoded dot segments. Reject them from the raw path
  // before parsing so an alternate spelling cannot become an allowed route.
  if (rawPath.includes("\\")
    || LITERAL_DOT_SEGMENT.test(rawPath)
    || ENCODED_PATH_HAZARD.test(rawPath)
    || MALFORMED_PERCENT.test(rawPath)) {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is invalid." };
  }

  let url;
  try {
    url = new URL(requestUrl, "http://broker.invalid");
  } catch {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is invalid." };
  }
  const bridgeName = service === "qbittorrent" ? "qbit" : service;
  const prefix = `/bridge/${bridgeName}`;
  if (!url.pathname.startsWith(`${prefix}/`)) {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is not allowed." };
  }
  const upstreamPath = url.pathname.slice(prefix.length);
  if (!upstreamPath
    || upstreamPath.length > 1024
    || CONTROL_CHARACTERS.test(upstreamPath)
    || upstreamPath.includes("\\")
    || ENCODED_PATH_HAZARD.test(upstreamPath)) {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is not allowed." };
  }
  const pathAllowed = methodPolicy.exact.has(upstreamPath)
    || methodPolicy.patterns.some((pattern) => pattern.test(upstreamPath));
  if (!pathAllowed) {
    return { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "The bridge route is not allowed.", status: 404 };
  }
  const query = validateQuery(url);
  if (!query.allowed) return query;
  const fixedCapabilityQuery = validateFixedCapabilityQuery(service, upstreamPath, url);
  if (!fixedCapabilityQuery.allowed) return fixedCapabilityQuery;
  const artworkQuery = validateArtworkQuery(service, upstreamPath, url);
  if (!artworkQuery.allowed) return artworkQuery;

  const isArtwork = (service === "jellyfin" && JELLYFIN_ARTWORK_PATH.test(upstreamPath))
    || (["radarr", "sonarr"].includes(service) && ARR_ARTWORK_PATH.test(upstreamPath))
    || (service === "seerr" && SEERR_ARTWORK_PATH.test(upstreamPath));

  const isLogin = (service === "jellyfin" && upstreamPath === "/Users/AuthenticateByName")
    || (service === "seerr" && upstreamPath === "/api/v1/auth/local");
  return {
    allowed: true,
    service,
    method,
    upstreamPath,
    upstreamPathAndQuery: `${upstreamPath}${url.search}`,
    isArtwork,
    isLogin,
    internalOnly: isLogin
  };
}

export function authorizeProxmoxRoute(routeIdValue, methodValue = "GET", parameters = {}) {
  const routeId = typeof routeIdValue === "string" ? routeIdValue : "";
  const method = String(methodValue || "GET").toUpperCase();
  if (method !== "GET") {
    return {
      allowed: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Proxmox monitoring permits read-only GET requests only.",
      status: 405
    };
  }
  const nodeScoped = PROXMOX_NODE_ROUTES.includes(routeId);
  if (!Object.hasOwn(PROXMOX_ROUTES, routeId) && !nodeScoped) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That Proxmox monitoring capability is not allowed.",
      status: 404
    };
  }
  let node = null;
  try {
    node = nodeScoped && parameters && typeof parameters === "object" && !Array.isArray(parameters)
      ? normalizeProxmoxNodeName(parameters.node)
      : null;
  } catch {
    node = null;
  }
  if (nodeScoped && !node) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That Proxmox monitoring capability is not allowed.",
      status: 404
    };
  }
  const upstreamPathAndQuery = nodeScoped
    ? `/api2/json/nodes/${encodeURIComponent(node)}/tasks?source=archive${routeId === "backups" ? "&typefilter=vzdump" : ""}&limit=100`
    : PROXMOX_ROUTES[routeId];
  const separator = upstreamPathAndQuery.indexOf("?");
  const upstreamPath = separator < 0
    ? upstreamPathAndQuery
    : upstreamPathAndQuery.slice(0, separator);
  return Object.freeze({
    allowed: true,
    service: "proxmox",
    routeId,
    ...(node ? { node } : {}),
    method: "GET",
    upstreamPath,
    upstreamPathAndQuery,
    isArtwork: false,
    isLogin: false,
    internalOnly: true
  });
}

export function authorizePortainerRoute(routeIdValue, methodValue = "GET", parameters = {}) {
  const routeId = typeof routeIdValue === "string" ? routeIdValue : "";
  const method = String(methodValue || "GET").toUpperCase();
  if (method !== "GET") {
    return {
      allowed: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Portainer monitoring permits read-only GET requests only.",
      status: 405
    };
  }
  if (!PORTAINER_ROUTE_IDS.includes(routeId)) {
    return {
      allowed: false,
      code: "ROUTE_NOT_ALLOWED",
      message: "That Portainer monitoring capability is not allowed.",
      status: 404
    };
  }
  let endpointId = null;
  let start = null;
  if (routeId === "containers") {
    try {
      endpointId = parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? normalizePortainerEndpointId(parameters.endpointId)
        : null;
    } catch {
      endpointId = null;
    }
    if (endpointId === null) {
      return {
        allowed: false,
        code: "ROUTE_NOT_ALLOWED",
        message: "That Portainer monitoring capability is not allowed.",
        status: 404
      };
    }
  }
  if (routeId === "environments") {
    let candidate = 1;
    try {
      candidate = parameters && typeof parameters === "object" && !Array.isArray(parameters)
        ? parameters.start ?? 1
        : 1;
    } catch {
      candidate = null;
    }
    start = normalizePortainerEndpointId(candidate);
    if (start === null || start > 901) {
      return {
        allowed: false,
        code: "ROUTE_NOT_ALLOWED",
        message: "That Portainer monitoring capability is not allowed.",
        status: 404
      };
    }
  }
  const upstreamPathAndQuery = routeId === "containers"
    ? `/api/endpoints/${endpointId}/docker/containers/json?all=true`
    : routeId === "environments"
      ? `/api/endpoints?start=${start}&limit=100&sort=Name&order=asc&excludeSnapshots=true`
      : PORTAINER_ROUTES[routeId];
  const separator = upstreamPathAndQuery.indexOf("?");
  const upstreamPath = separator < 0
    ? upstreamPathAndQuery
    : upstreamPathAndQuery.slice(0, separator);
  return Object.freeze({
    allowed: true,
    service: "portainer",
    routeId,
    ...(endpointId === null ? {} : { endpointId }),
    ...(start === null ? {} : { start }),
    method: "GET",
    upstreamPath,
    upstreamPathAndQuery,
    isArtwork: false,
    isLogin: false,
    internalOnly: true,
    credentialRequired: !["systemStatus", "legacyStatus"].includes(routeId)
  });
}
