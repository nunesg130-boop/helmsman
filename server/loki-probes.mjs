const AUTH_STATUSES = new Set([401, 403]);

function boundedText(value, maximum = 96) {
  const text = typeof value === "string" ? value : "";
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function responseStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function parsedJson(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !Array.isArray(value)) return value;
  try {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function check(id, label, ok, options = {}) {
  const status = responseStatus(options.status);
  return {
    id,
    label,
    ok,
    state: ok ? "healthy" : options.state || "limited",
    importance: options.importance || "important",
    code: ok ? null : options.code || "LOKI_CHECK_FAILED",
    status,
    latencyMs: Number.isFinite(options.latencyMs) && options.latencyMs >= 0
      ? Math.min(Math.round(options.latencyMs), 60_000)
      : null,
    metrics: {},
    reports: []
  };
}

/**
 * Runs a bounded, GET-only Loki readiness and query-capability probe. The
 * caller owns DNS pinning, TLS, credentials, deadlines, and response limits.
 */
export async function probeLoki(requestLoki, options = {}) {
  if (typeof requestLoki !== "function") throw new TypeError("A Loki request function is required.");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const checks = [];
  const checkedAtMilliseconds = Date.parse(options.checkedAt);
  const queryEndMilliseconds = Number.isFinite(checkedAtMilliseconds)
    ? checkedAtMilliseconds
    : Date.now();
  const queryStartMilliseconds = Math.max(0, queryEndMilliseconds - 60_000);

  const run = async (routeId, parameters = {}) => {
    const started = now();
    const response = await requestLoki(routeId, parameters);
    const ended = now();
    return {
      status: responseStatus(response?.status),
      body: response?.body,
      latencyMs: Math.max(0, Math.min(60_000, Math.round(ended - started)))
    };
  };

  const readiness = await run("ready");
  if (AUTH_STATUSES.has(readiness.status)) {
    checks.push(check("readiness", "Connection and authentication", false, {
      state: "auth_required",
      importance: "critical",
      code: "AUTHENTICATION_REQUIRED",
      status: readiness.status,
      latencyMs: readiness.latencyMs
    }));
    return {
      ok: false,
      state: "auth_required",
      // Any bounded HTTP response proves the network/TLS connection worked;
      // the authorization failure belongs to Loki's service health.
      connectionState: "connected",
      version: null,
      checks,
      metrics: {}
    };
  }
  const readinessText = boundedText(Buffer.isBuffer(readiness.body)
    ? readiness.body.toString("utf8")
    : readiness.body, 32).toLowerCase();
  const ready = readiness.status !== null
    && readiness.status >= 200
    && readiness.status < 300
    && readinessText === "ready";
  checks.push(check("readiness", "Loki readiness", ready, {
    state: "degraded",
    importance: "critical",
    code: readiness.status === null ? "INVALID_RESPONSE" : "LOKI_NOT_READY",
    status: readiness.status,
    latencyMs: readiness.latencyMs
  }));

  const identity = await run("buildInfo");
  const identityBody = parsedJson(identity.body);
  const version = boundedText(identityBody?.version, 64) || null;
  const identityOk = identity.status !== null
    && identity.status >= 200
    && identity.status < 300
    && Boolean(identityBody);
  checks.push(check("identity", "Loki API identity", identityOk, {
    state: AUTH_STATUSES.has(identity.status) ? "auth_required" : "limited",
    importance: "important",
    code: AUTH_STATUSES.has(identity.status) ? "AUTHENTICATION_REQUIRED" : "INVALID_RESPONSE",
    status: identity.status,
    latencyMs: identity.latencyMs
  }));

  // Exercise the same query_range capability used by the Explorer without
  // selecting real streams or retaining any returned log data. An exact
  // matcher for Helmsman's reserved probe label should normally return an
  // empty, successful stream response.
  const query = await run("queryRange", {
    queryInput: {
      query: "{__helmsman_probe__=\"1\"}",
      start: (BigInt(queryStartMilliseconds) * 1_000_000n).toString(),
      end: (BigInt(queryEndMilliseconds) * 1_000_000n).toString(),
      direction: "backward",
      limit: 1
    }
  });
  const queryBody = parsedJson(query.body);
  const queryOk = query.status !== null
    && query.status >= 200
    && query.status < 300
    && queryBody?.status === "success"
    && queryBody?.data?.resultType === "streams"
    && Array.isArray(queryBody?.data?.result);
  checks.push(check("query", "Log query API", queryOk, {
    state: AUTH_STATUSES.has(query.status) ? "auth_required" : "limited",
    importance: "important",
    code: AUTH_STATUSES.has(query.status) ? "AUTHENTICATION_REQUIRED" : "LOKI_QUERY_UNAVAILABLE",
    status: query.status,
    latencyMs: query.latencyMs
  }));

  const authFailure = checks.some(({ state }) => state === "auth_required");
  const state = authFailure
    ? "auth_required"
    : !ready ? "degraded" : identityOk && queryOk ? "healthy" : "limited";
  return {
    ok: state === "healthy",
    state,
    // Receiving a bounded HTTP response proves transport connectivity even
    // when Loki reports not-ready or rejects one protected capability.
    connectionState: "connected",
    version,
    checks,
    metrics: {}
  };
}
