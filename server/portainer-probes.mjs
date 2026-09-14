import {
  containersFromPortainer,
  environmentsFromPortainer,
  normalizePortainerInventory,
  PORTAINER_MODEL_LIMITS,
  portainerIdentityIsValid,
  portainerInventoryMetrics,
  portainerVersionFromStatus,
  stacksFromPortainer
} from "./portainer-model.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_DEADLINE_MS = 45_000;
const MIN_PROBE_DEADLINE_MS = 250;
const MAX_PROBE_DEADLINE_MS = 240_000;
const MAX_CONTAINER_ENVIRONMENTS = 25;
const MAX_ENVIRONMENT_PAGES = 5;
const ENVIRONMENT_PAGE_SIZE = 100;
const MAX_CHECKS = 32;
const MAX_REPORTS = 12;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const FAILURE_STATE_PRIORITY = Object.freeze({
  auth_required: 0,
  down: 1,
  degraded: 2,
  limited: 3,
  stale: 4,
  healthy: 5
});
const CHECK_IMPORTANCE_PRIORITY = Object.freeze({
  core: 0,
  important: 1,
  optional: 2
});

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

function text(value, fallback = "", maximum = 300) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value).replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, maximum);
}

function statusCode(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function timeoutMs(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(MAX_TIMEOUT_MS, Math.max(250, number)) : DEFAULT_TIMEOUT_MS;
}

function probeDeadlineMs(value) {
  const number = Number(value);
  return Number.isSafeInteger(number)
    ? Math.min(MAX_PROBE_DEADLINE_MS, Math.max(MIN_PROBE_DEADLINE_MS, number))
    : DEFAULT_PROBE_DEADLINE_MS;
}

function responseEnvelope(value) {
  const source = record(value);
  if (source && statusCode(own(source, "status")) !== null && Object.hasOwn(source, "body")) {
    return { status: statusCode(own(source, "status")), body: own(source, "body") };
  }
  return { status: 200, body: value };
}

async function invoke(request, routeId, parameters, options) {
  const controller = new AbortController();
  const outerSignal = options.signal;
  const deadlineSignal = options.deadlineSignal;
  let cancelled = false;
  let deadlineExpired = false;
  let timedOut = false;
  const cancelFromOuter = () => {
    cancelled = true;
    controller.abort();
  };
  const cancelFromDeadline = () => {
    deadlineExpired = true;
    controller.abort();
  };
  const cancelFromTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  if (outerSignal?.aborted) cancelFromOuter();
  else outerSignal?.addEventListener?.("abort", cancelFromOuter, { once: true });
  if (deadlineSignal?.aborted) cancelFromDeadline();
  else deadlineSignal?.addEventListener?.("abort", cancelFromDeadline, { once: true });
  const timer = setTimeout(cancelFromTimeout, timeoutMs(options.timeoutMs));
  const started = performance.now();
  try {
    const response = responseEnvelope(await request(routeId, {
      ...parameters,
      method: "GET",
      responseType: "json",
      signal: controller.signal,
      timeoutMs: timeoutMs(options.timeoutMs),
      purpose: "portainer-health-probe"
    }));
    return { ...response, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  } catch (error) {
    return {
      status: statusCode(own(error, "status") ?? own(error, "statusCode")),
      error,
      timedOut: timedOut && !cancelled && !deadlineExpired,
      deadlineExpired: deadlineExpired && !cancelled,
      cancelled,
      latencyMs: Math.max(0, Math.round(performance.now() - started))
    };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener?.("abort", cancelFromOuter);
    deadlineSignal?.removeEventListener?.("abort", cancelFromDeadline);
  }
}

function failure(observation, importance = "important", options = {}) {
  const status = statusCode(observation?.status);
  const rawCode = text(own(observation?.error, "code"), "", 64).toUpperCase();
  if (options.credentialRequired === false && (status === 401 || status === 403)) {
    return { state: importance === "core" ? "down" : "degraded", code: "HTTP_ERROR", status };
  }
  if (rawCode === "CREDENTIAL_NOT_CONFIGURED") {
    return { state: "auth_required", code: rawCode, status };
  }
  if (status === 401 || (status === 403 && options.authenticationProof === true)) {
    return { state: "auth_required", code: "AUTH_REQUIRED", status };
  }
  if (status === 403) {
    return { state: importance === "optional" ? "limited" : "degraded", code: "FORBIDDEN", status };
  }
  if (observation?.cancelled || ["ABORT_ERR", "CHECK_CANCELLED", "PROBE_CANCELLED"].includes(rawCode)) {
    return { state: "stale", code: "CHECK_CANCELLED", status: null };
  }
  if (observation?.timedOut || ["ETIMEDOUT", "PROBE_TIMEOUT", "UPSTREAM_TIMEOUT"].includes(rawCode)) {
    return { state: "down", code: "TIMEOUT", status: null };
  }
  if (["TLS_PIN_MISMATCH", "TLS_CERTIFICATE_UNTRUSTED", "TLS_CERTIFICATE_INVALID"].includes(rawCode)) {
    return { state: importance === "core" ? "down" : "degraded", code: rawCode, status: null };
  }
  if (["UPSTREAM_REDIRECT_REJECTED", "UPSTREAM_CONTENT_REJECTED", "UPSTREAM_RESPONSE_FAILED"].includes(rawCode)) {
    return { state: importance === "core" ? "down" : importance === "optional" ? "limited" : "degraded", code: rawCode, status: null };
  }
  if (rawCode === "BROKER_BUSY") {
    return { state: "limited", code: rawCode, status: null };
  }
  if (!status || ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "UPSTREAM_UNREACHABLE"].includes(rawCode)) {
    return { state: "down", code: "UNREACHABLE", status: null };
  }
  if (rawCode === "UPSTREAM_RESPONSE_TOO_LARGE") {
    return { state: importance === "optional" ? "limited" : "degraded", code: "RESPONSE_TOO_LARGE", status: null };
  }
  if (status === 413) {
    return { state: importance === "optional" ? "limited" : "degraded", code: "RESPONSE_TOO_LARGE", status };
  }
  if (status >= 500 && importance === "core") return { state: "down", code: "HTTP_ERROR", status };
  return { state: importance === "optional" ? "limited" : "degraded", code: "HTTP_ERROR", status };
}

function report(source, message, severity = "error") {
  return {
    severity,
    source: text(source, "Portainer", 96),
    message: text(message, "Portainer monitoring failed.", 600)
  };
}

function failureMessage(route, result, environmentName = "") {
  const subject = environmentName ? `${environmentName} (${route})` : route;
  if (result.status === 401 && result.code === "AUTH_REQUIRED") return `${subject} returned HTTP 401 (Unauthorized). Portainer rejected the saved access token.`;
  if (result.status === 401) return `${subject} returned HTTP 401 before token verification. Portainer status checks do not send the access token.`;
  if (result.status === 403 && result.code === "AUTH_REQUIRED") return `${subject} returned HTTP 403 (Forbidden). Portainer rejected the saved access token for identity verification.`;
  if (result.status === 403 && result.code === "HTTP_ERROR") return `${subject} returned HTTP 403 before token verification. Portainer status checks do not send the access token.`;
  if (result.status === 403) return `${subject} returned HTTP 403 (Forbidden). The authenticated Portainer user cannot read this capability or environment.`;
  if (result.status === 404) return `${subject} returned HTTP 404 (Not Found). Check the Portainer version, base URL, and environment identity.`;
  if (result.code === "TIMEOUT") return `${subject} did not respond within the monitoring timeout.`;
  if (result.code === "UNREACHABLE") return `${subject} could not be reached. Check the Portainer address, TLS trust, and network path.`;
  if (result.code === "TLS_PIN_MISMATCH") return `${subject} presented a certificate that does not match the configured SHA-256 fingerprint.`;
  if (result.code === "TLS_CERTIFICATE_UNTRUSTED") return `${subject} presented a certificate that system trust could not verify.`;
  if (result.code === "TLS_CERTIFICATE_INVALID") return `${subject} presented an invalid, expired, or not-yet-valid certificate.`;
  if (result.code === "UPSTREAM_REDIRECT_REJECTED") return `${subject} returned a redirect. Configure the final Portainer HTTPS URL directly.`;
  if (result.code === "UPSTREAM_CONTENT_REJECTED") return `${subject} returned HTML instead of the expected Portainer API response.`;
  if (result.code === "UPSTREAM_RESPONSE_FAILED") return `${subject} closed the response before the Portainer API payload was complete.`;
  if (result.code === "BROKER_BUSY") return `${subject} was deferred because Helmsman's bounded upstream request budget was full.`;
  if (result.code === "RESPONSE_TOO_LARGE") return `${subject} exceeded Helmsman's bounded Portainer response limit.`;
  if (result.code === "CHECK_CANCELLED") return `${subject} was cancelled before the Portainer check completed.`;
  if (result.status) return `${subject} returned HTTP ${result.status}. Review Portainer and its reverse-proxy logs.`;
  return `${subject} failed before Helmsman received a valid response.`;
}

function check(id, label, importance, observation, parsed = null, options = {}) {
  const common = {
    id,
    label,
    importance,
    stages: [],
    latencyMs: observation?.latencyMs ?? null,
    status: statusCode(observation?.status),
    metrics: options.metrics || {},
    ...(options.affectsHealth === false ? { affectsHealth: false } : {})
  };
  if (parsed?.ok) {
    return { ...common, ok: true, state: parsed.state || "healthy", code: parsed.code || null };
  }
  const result = parsed?.failure || failure(observation, importance, options);
  return {
    ...common,
    ok: false,
    state: result.state,
    code: result.code,
    status: result.status,
    reports: [report(
      options.reportSource || `Portainer · ${label}`,
      options.message || failureMessage(options.route || label, result, options.environmentName),
      importance === "optional" ? "warning" : "error"
    )]
  };
}

function successful(observation) {
  return observation && !observation.error && observation.status >= 200 && observation.status < 300;
}

function healthState(checks) {
  const active = checks.filter((entry) => entry.affectsHealth !== false);
  if (active.some(({ state }) => state === "auth_required")) return "auth_required";
  if (active.some(({ state }) => state === "down")) return active.some(({ state }) => state === "healthy") ? "degraded" : "down";
  if (active.some(({ state }) => state === "degraded")) return "degraded";
  if (active.some(({ state }) => state === "limited")) return "limited";
  if (active.length && active.every(({ state }) => state === "stale")) return "stale";
  return active.length ? "healthy" : "stale";
}

function partialCoverageCheck() {
  return {
    id: "inventory-coverage",
    label: "Inventory coverage",
    importance: "important",
    stages: [],
    latencyMs: null,
    status: null,
    metrics: {},
    ok: false,
    state: "limited",
    code: "PORTAINER_INVENTORY_PARTIAL",
    reports: [report(
      "Portainer · Inventory coverage",
      "Portainer inventory collection reached Helmsman's bounded monitoring deadline. Any completed results were retained; unfinished checks will be retried during the next cycle.",
      "warning"
    )]
  };
}

function boundedChecks(checks) {
  if (checks.length <= MAX_CHECKS) return checks;
  return checks
    .map((entry, index) => {
      const affectsHealth = entry.affectsHealth !== false;
      const failed = entry.ok !== true || entry.state !== "healthy";
      return {
        entry,
        index,
        category: entry.code === "PORTAINER_INVENTORY_PARTIAL" ? -1
          : affectsHealth && failed ? 0
          : affectsHealth ? 1
            : failed ? 2 : 3,
        statePriority: FAILURE_STATE_PRIORITY[entry.state] ?? FAILURE_STATE_PRIORITY.stale,
        importancePriority: CHECK_IMPORTANCE_PRIORITY[entry.importance] ?? CHECK_IMPORTANCE_PRIORITY.important
      };
    })
    .sort((left, right) => (
      left.category - right.category
      || left.statePriority - right.statePriority
      || left.importancePriority - right.importancePriority
      || left.index - right.index
    ))
    .slice(0, MAX_CHECKS)
    .sort((left, right) => left.index - right.index)
    .map(({ entry }) => entry);
}

function environmentFailureCheck(environment) {
  if (!["down", "error", "provisioning", "unknown"].includes(environment.state)) return null;
  const provisioning = environment.state === "provisioning";
  const unknown = environment.state === "unknown";
  const code = environment.state === "error" ? "PORTAINER_ENVIRONMENT_ERROR"
    : environment.state === "down" ? "PORTAINER_ENVIRONMENT_DOWN"
      : provisioning ? "PORTAINER_ENVIRONMENT_PROVISIONING" : "PORTAINER_ENVIRONMENT_UNKNOWN";
  const state = environment.state === "error" ? "degraded"
    : environment.state === "down" ? "down"
      : "limited";
  return {
    id: `environment-${environment.id}`,
    label: `${environment.name} environment`,
    importance: provisioning || unknown ? "optional" : "important",
    stages: [],
    latencyMs: null,
    status: null,
    metrics: {},
    ok: false,
    state,
    code,
    ...(provisioning ? { affectsHealth: false } : {}),
    reports: [report(
      `Portainer · ${environment.name}`,
      provisioning
        ? `${environment.name} is still provisioning in Portainer.`
        : unknown
          ? `${environment.name} returned an unknown Portainer status.`
          : `${environment.name} is ${environment.state} in Portainer.`,
      state === "down" || state === "degraded" ? "error" : "warning"
    )]
  };
}

function containerCheck(environment, observation, containers = null) {
  const id = `containers-${environment.id}`;
  if (!successful(observation)) {
    return check(id, `${environment.name} containers`, "important", observation, null, {
      route: `GET /api/endpoints/${environment.id}/docker/containers/json?all=true`,
      environmentName: environment.name,
      reportSource: `Portainer · ${environment.name}`
    });
  }
  if (!containers) {
    const result = { state: "degraded", code: "INVALID_RESPONSE", status: observation.status };
    return check(id, `${environment.name} containers`, "important", observation, { failure: result }, {
      reportSource: `Portainer · ${environment.name}`,
      message: `${environment.name} returned a container response Helmsman could not safely accept.`
    });
  }
  const unhealthy = containers.filter(({ health }) => health === "unhealthy");
  const running = containers.filter(({ state }) => state === "running").length;
  const stopped = containers.filter(({ state }) => ["created", "exited"].includes(state)).length;
  const restarting = containers.filter(({ state }) => state === "restarting").length;
  if (!unhealthy.length) {
    return check(id, `${environment.name} containers`, "important", observation, { ok: true }, {
      metrics: { containerTotal: containers.length, containerRunning: running, containerStopped: stopped }
    });
  }
  const examples = unhealthy.slice(0, 5).map(({ name, state, status }) => `${name}: ${state === "running" ? status : state}`);
  const result = { state: "degraded", code: "CONTAINERS_UNHEALTHY", status: observation.status };
  return {
    ...check(id, `${environment.name} containers`, "important", observation, { failure: result }, {
      metrics: {
        containerTotal: containers.length,
        containerRunning: running,
        containerStopped: stopped,
        containerUnhealthy: unhealthy.length,
        containerRestarting: restarting
      },
      reportSource: `Portainer · ${environment.name}`,
      message: `${unhealthy.length} container${unhealthy.length === 1 ? "" : "s"} need attention: ${examples.join("; ")}.`
    })
  };
}

async function mapWithConcurrency(items, concurrency, operation, shouldStop = () => false) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length && !shouldStop()) {
      const current = index;
      index += 1;
      output[current] = await operation(items[current], current);
    }
  }));
  return output.filter((entry) => entry !== undefined && entry !== null);
}

/**
 * Executes Portainer's fixed read-only API plan. Raw upstream bodies are
 * projected immediately into the bounded inventory model and never returned.
 */
export async function probePortainer(request, options = {}) {
  if (typeof request !== "function") throw new TypeError("A Portainer probe transport is required.");
  const deadlineController = new AbortController();
  const deadlineMs = probeDeadlineMs(options.deadlineMs);
  const deadlineTimer = setTimeout(() => deadlineController.abort(), deadlineMs);
  deadlineTimer.unref?.();
  try {
    return await executePortainerProbe(request, {
      ...options,
      deadlineMs,
      deadlineSignal: deadlineController.signal
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function executePortainerProbe(request, options) {
  const checkedAt = new Date(options.checkedAt ?? Date.now()).toISOString();
  const checks = [];
  let deadlineReached = false;
  const deadlineExpired = () => options.deadlineSignal.aborted && !options.signal?.aborted;

  let statusObservation = await invoke(request, "systemStatus", {}, options);
  let statusRoute = "GET /api/system/status";
  if (statusObservation.status === 404) {
    statusObservation = await invoke(request, "legacyStatus", {}, options);
    statusRoute = "GET /api/status";
  }
  let version = null;
  if (statusObservation.deadlineExpired) {
    deadlineReached = true;
  } else {
    if (successful(statusObservation)) version = portainerVersionFromStatus(statusObservation.body);
    checks.push(version
      ? check("status", "Server status", "core", statusObservation, { ok: true })
      : check("status", "Server status", "core", statusObservation, successful(statusObservation)
        ? { failure: { state: "degraded", code: "INVALID_RESPONSE", status: statusObservation.status } }
        : null, { route: statusRoute, credentialRequired: false }));
  }
  statusObservation.body = null;

  let identityValid = false;
  if (!deadlineReached) {
    const identityObservation = await invoke(request, "identity", {}, options);
    if (identityObservation.deadlineExpired) {
      deadlineReached = true;
    } else {
      identityValid = successful(identityObservation) && portainerIdentityIsValid(identityObservation.body);
      checks.push(identityValid
        ? check("identity", "Token authorization", "important", identityObservation, { ok: true })
        : check("identity", "Token authorization", "important", identityObservation, successful(identityObservation)
          ? { failure: { state: "degraded", code: "INVALID_RESPONSE", status: identityObservation.status } }
          : null, { route: "GET /api/users/me", authenticationProof: true }));
    }
    identityObservation.body = null;
  }

  let environments = [];
  let environmentFailure = null;
  let environmentLimitReached = false;
  if (identityValid && !deadlineReached) {
    const pages = [];
    let rawEnvironmentCount = 0;
    for (let page = 0; page < MAX_ENVIRONMENT_PAGES; page += 1) {
      const start = page * ENVIRONMENT_PAGE_SIZE + 1;
      const observation = await invoke(request, "environments", { start }, options);
      if (observation.deadlineExpired) {
        observation.body = null;
        deadlineReached = true;
        break;
      }
      if (!successful(observation)) {
        observation.body = null;
        environmentFailure = { observation, start };
        break;
      }
      if (!Array.isArray(observation.body)) {
        observation.body = null;
        environmentFailure = {
          observation,
          start,
          invalid: true
        };
        break;
      }
      const pageLength = observation.body.length;
      rawEnvironmentCount += pageLength;
      try {
        pages.push(...environmentsFromPortainer(observation.body));
      } catch {
        observation.body = null;
        environmentFailure = { observation, start, invalid: true };
        break;
      }
      observation.body = null;
      if (pageLength < ENVIRONMENT_PAGE_SIZE) break;
    }
    environmentLimitReached = rawEnvironmentCount >= PORTAINER_MODEL_LIMITS.maximumEnvironments;
    try {
      environments = environmentsFromPortainer(pages);
    } catch {
      environmentFailure = environmentFailure || { observation: { status: 200, latencyMs: null }, start: 1, invalid: true };
    }
  }
  if (deadlineReached) {
    // One aggregate coverage capability is added after all safely completed
    // inventory has been normalized.
  } else if (!identityValid) {
    checks.push({
      id: "environments",
      label: "Environment inventory",
      importance: "important",
      stages: [],
      latencyMs: null,
      status: null,
      metrics: {},
      ok: false,
      state: "stale",
      code: "NOT_CHECKED",
      affectsHealth: false
    });
  } else if (environmentFailure) {
    const result = environmentFailure.invalid
      ? { state: "degraded", code: "INVALID_RESPONSE", status: environmentFailure.observation.status }
      : failure(environmentFailure.observation, "important");
    checks.push(check("environments", "Environment inventory", "important", environmentFailure.observation, { failure: result }, {
      route: `GET /api/endpoints (page starting ${environmentFailure.start})`,
      metrics: { environmentTotal: environments.length }
    }));
  } else {
    checks.push({
      id: "environments",
      label: "Environment inventory",
      importance: "important",
      stages: [],
      latencyMs: null,
      status: 200,
      metrics: {
        environmentTotal: environments.length,
        environmentOnline: environments.filter(({ state }) => state === "up").length,
        environmentOffline: environments.filter(({ state }) => ["down", "error"].includes(state)).length
      },
      ok: true,
      state: "healthy",
      code: null
    });
  }

  const environmentNames = new Map(environments.map((entry) => [entry.id, entry.name]));
  let stacks = [];
  let stackLimitReached = false;
  if (identityValid && !deadlineReached) {
    const observation = await invoke(request, "stacks", {}, options);
    if (observation.deadlineExpired) {
      observation.body = null;
      deadlineReached = true;
    } else if (successful(observation) || observation.status === 204) {
      try {
        stackLimitReached = Array.isArray(observation.body)
          && observation.body.length >= PORTAINER_MODEL_LIMITS.maximumStacks;
        stacks = stacksFromPortainer(observation.status === 204 ? [] : observation.body, environmentNames);
        observation.body = null;
        checks.push(check("stacks", "Stack inventory", "optional", observation, { ok: true }, {
          affectsHealth: false,
          metrics: { stackTotal: stacks.length }
        }));
      } catch {
        observation.body = null;
        checks.push(check("stacks", "Stack inventory", "optional", observation, {
          failure: { state: "limited", code: "INVALID_RESPONSE", status: observation.status }
        }, { affectsHealth: false, route: "GET /api/stacks" }));
      }
    } else {
      observation.body = null;
      checks.push(check("stacks", "Stack inventory", "optional", observation, null, {
        affectsHealth: false,
        route: "GET /api/stacks"
      }));
    }
  }

  const eligibleContainerEnvironments = environments.filter(({ containerCapable, state }) => containerCapable && state === "up");
  const inventoryEnvironments = eligibleContainerEnvironments.slice(0, MAX_CONTAINER_ENVIRONMENTS);
  const containerConcurrency = 1;
  let remainingContainerBudget = PORTAINER_MODEL_LIMITS.maximumContainers;
  const containerResults = await mapWithConcurrency(inventoryEnvironments, containerConcurrency, async (environment) => {
    const observation = await invoke(request, "containers", { endpointId: environment.id }, options);
    if (observation.deadlineExpired) {
      observation.body = null;
      deadlineReached = true;
      return null;
    }
    let normalizedContainers = null;
    const limitReached = successful(observation)
      && Array.isArray(observation.body)
      && observation.body.length >= PORTAINER_MODEL_LIMITS.maximumContainers;
    if (successful(observation)) {
      try {
        normalizedContainers = containersFromPortainer(observation.body, environment);
      } catch {
        normalizedContainers = null;
      }
    }
    observation.body = null;
    const available = Math.max(0, remainingContainerBudget);
    const containers = normalizedContainers ? normalizedContainers.slice(0, available) : [];
    const aggregateLimitReached = Boolean(normalizedContainers && containers.length < normalizedContainers.length);
    remainingContainerBudget -= containers.length;
    return {
      containers,
      limitReached,
      aggregateLimitReached,
      check: containerCheck(environment, observation, normalizedContainers)
    };
  }, () => deadlineReached || deadlineExpired());
  if (containerResults.length < inventoryEnvironments.length && deadlineExpired()) {
    deadlineReached = true;
  }
  const containers = containerResults.flatMap((entry) => entry.containers || []);
  const aggregateContainerLimitReached = containerResults.some(({ aggregateLimitReached }) => aggregateLimitReached);
  const limitedContainerEnvironments = containerResults.filter(({ limitReached }) => limitReached);
  const limitFacts = [
    ...(environmentLimitReached
      ? [`Portainer returned at least ${PORTAINER_MODEL_LIMITS.maximumEnvironments} environments; only the first ${PORTAINER_MODEL_LIMITS.maximumEnvironments} were retained.`]
      : []),
    ...(eligibleContainerEnvironments.length > MAX_CONTAINER_ENVIRONMENTS
      ? [`Container inventory is capped at ${MAX_CONTAINER_ENVIRONMENTS} of ${eligibleContainerEnvironments.length} eligible environments per cycle.`]
      : []),
    ...(limitedContainerEnvironments.length
      ? [`${limitedContainerEnvironments.length} environment${limitedContainerEnvironments.length === 1 ? "" : "s"} reached the ${PORTAINER_MODEL_LIMITS.maximumContainers}-container response limit.`]
      : []),
    ...(aggregateContainerLimitReached
      ? [`The combined inventory exceeded ${PORTAINER_MODEL_LIMITS.maximumContainers} containers; only the first ${PORTAINER_MODEL_LIMITS.maximumContainers} were retained.`]
      : []),
    ...(stackLimitReached
      ? [`Portainer returned at least ${PORTAINER_MODEL_LIMITS.maximumStacks} stacks; only the first ${PORTAINER_MODEL_LIMITS.maximumStacks} were retained.`]
      : [])
  ];
  if (limitFacts.length) {
    checks.push({
      id: "inventory-limits",
      label: "Inventory limits",
      importance: "optional",
      stages: [],
      latencyMs: null,
      status: null,
      metrics: {},
      ok: false,
      state: "limited",
      code: "INVENTORY_LIMIT_REACHED",
      affectsHealth: false,
      reports: [report("Portainer · Inventory limits", limitFacts.join(" "), "warning")]
    });
  }
  checks.push(...environments.map(environmentFailureCheck).filter(Boolean));
  checks.push(...containerResults.map((entry) => entry.check));
  if (deadlineReached) checks.push(partialCoverageCheck());

  const inventory = normalizePortainerInventory({ environments, containers, stacks });
  const metrics = portainerInventoryMetrics(inventory);
  const state = healthState(checks);
  const identityCheck = checks.find(({ id }) => id === "identity");
  const statusCheck = checks.find(({ id }) => id === "status");
  const connectionState = identityCheck?.ok ? "connected"
    : identityCheck?.state === "auth_required" ? "auth_required"
      : statusCheck?.state === "down" ? "down" : "unverified";
  const latencies = checks.map(({ latencyMs }) => latencyMs).filter(Number.isFinite);
  return {
    ok: state === "healthy",
    state,
    connectionState,
    checkedAt,
    latencyMs: latencies.length ? Math.max(...latencies) : null,
    version,
    checks: boundedChecks(checks).map((entry) => ({
      ...entry,
      reports: Array.isArray(entry.reports) ? entry.reports.slice(0, MAX_REPORTS) : undefined
    })),
    metrics,
    inventory
  };
}

export const PORTAINER_PROBE_LIMITS = Object.freeze({
  maximumContainerEnvironments: MAX_CONTAINER_ENVIRONMENTS,
  maximumEnvironmentPages: MAX_ENVIRONMENT_PAGES,
  maximumContainerConcurrency: 1,
  defaultDeadlineMs: DEFAULT_PROBE_DEADLINE_MS,
  minimumDeadlineMs: MIN_PROBE_DEADLINE_MS,
  maximumDeadlineMs: MAX_PROBE_DEADLINE_MS
});
