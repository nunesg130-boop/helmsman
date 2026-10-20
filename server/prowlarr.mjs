// Prowlarr indexers: what Helmsman reads and the few actions it may take.
//
// Prowlarr's indexer and application records carry API keys, passwords and
// cookies in their `fields`. Everything here copies only named, harmless
// properties, so those values never leave the server process: not to the
// browser, the logs, the event journal or the agent's model.
//
// Testing one indexer is the exception that needs its full record: Prowlarr
// only tests a definition sent back to it. The broker fetches that record and
// posts it straight back to the same Prowlarr; it is never parsed into
// anything returned or stored.

const MAX_INDEXERS = 300;
const MAX_APPLICATIONS = 50;
const INDEXER_RECORD_BYTES = 256 * 1024;

export const PROWLARR_LIMITS = Object.freeze({
  indexerRecordBytes: INDEXER_RECORD_BYTES,
  listBytes: 2 * 1024 * 1024,
  resultBytes: 512 * 1024
});

/**
 * The only Prowlarr calls the action path may make. Each returns a frozen
 * route in the same shape as the bridge's own routes, always internal-only.
 */
const ACTION_STEPS = Object.freeze({
  readIndexer: Object.freeze({ method: "GET", path: (id) => `/api/v1/indexer/${id}`, needsId: true }),
  testIndexer: Object.freeze({ method: "POST", path: () => "/api/v1/indexer/test", needsId: true, needsRecord: true }),
  testAllIndexers: Object.freeze({ method: "POST", path: () => "/api/v1/indexer/testall", body: "" }),
  syncApps: Object.freeze({ method: "POST", path: () => "/api/v1/command", body: JSON.stringify({ name: "ApplicationIndexerSync" }) }),
  testApps: Object.freeze({ method: "POST", path: () => "/api/v1/applications/testall", body: "" })
});

export const PROWLARR_OPERATIONS = Object.freeze(["testIndexer", "testAllIndexers", "syncApps", "testApps"]);

function indexerId(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

/**
 * Authorizes one step of a Prowlarr action. `record` is required only for
 * testIndexer and must be the JSON text of the indexer that readIndexer
 * returned, with the same id.
 */
export function authorizeProwlarrStep(stepValue, { indexerId: idValue, record } = {}) {
  const step = ACTION_STEPS[stepValue];
  const id = indexerId(idValue);
  const refuse = { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "That Prowlarr action is not allowed.", status: 404 };
  if (!step || (step.needsId ? id === null : idValue !== undefined)) return refuse;
  let body = step.body ?? "";
  if (step.needsRecord) {
    if (typeof record !== "string" || !record || Buffer.byteLength(record, "utf8") > INDEXER_RECORD_BYTES) return refuse;
    let parsed;
    try {
      parsed = JSON.parse(record);
    } catch {
      return refuse;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.id !== id) return refuse;
    body = JSON.stringify(parsed);
  } else if (record !== undefined) {
    return refuse;
  }
  const upstreamPath = step.path(id);
  return Object.freeze({
    allowed: true,
    service: "prowlarr",
    actionId: "prowlarr",
    step: stepValue,
    ...(id !== null ? { indexerId: id } : {}),
    method: step.method,
    upstreamPath,
    upstreamPathAndQuery: upstreamPath,
    body,
    isArtwork: false,
    isLogin: false,
    internalOnly: true
  });
}

// ------------------------------------------------------------- parsing --

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max = 120) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoTime(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

/**
 * Error text from Prowlarr, cleaned for display. Long tokens that look like
 * keys and query strings are removed in case a message quotes a URL.
 */
export function cleanProwlarrMessage(value, max = 200) {
  return text(value, 400)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, (url) => url.replace(/\?\S*/u, "?…"))
    .replace(/\b(?:api[_-]?key|apikey|token|passkey|password|cookie)\s*[=:]\s*\S+/giu, "[removed]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, "[removed]")
    .slice(0, max);
}

/** Prowlarr's validation failures, as one short message. */
export function validationMessage(value) {
  const failures = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.validationFailures) ? value.validationFailures : [];
  const messages = [];
  for (const failure of failures.slice(0, 5)) {
    const message = cleanProwlarrMessage(isRecord(failure) ? failure.errorMessage : failure, 160);
    if (message && !messages.includes(message)) messages.push(message);
    if (messages.length === 2) break;
  }
  return messages.join(" ");
}

/**
 * Merges GET /api/v1/indexer, /api/v1/indexerstatus and (optionally)
 * /api/v1/indexerstats into a list of safe indexer summaries.
 */
export function parseIndexers(listBody, statusBody, statsBody = null) {
  if (!Array.isArray(listBody)) throw new TypeError("invalid Prowlarr indexer list");
  const statuses = new Map();
  for (const entry of Array.isArray(statusBody) ? statusBody.slice(0, MAX_INDEXERS * 2) : []) {
    const id = indexerId(isRecord(entry) ? entry.indexerId : null);
    if (id !== null) statuses.set(id, entry);
  }
  const stats = new Map();
  const statsList = isRecord(statsBody) && Array.isArray(statsBody.indexers) ? statsBody.indexers : [];
  for (const entry of statsList.slice(0, MAX_INDEXERS * 2)) {
    const id = indexerId(isRecord(entry) ? entry.indexerId : null);
    if (id !== null) stats.set(id, entry);
  }
  const indexers = [];
  const seen = new Set();
  for (const entry of listBody.slice(0, MAX_INDEXERS)) {
    if (!isRecord(entry)) continue;
    const id = indexerId(entry.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const status = statuses.get(id);
    const stat = stats.get(id);
    const disabledUntil = isoTime(status?.disabledTill);
    indexers.push({
      id,
      name: text(entry.name, 80) || `Indexer ${id}`,
      enabled: entry.enable === true,
      protocol: ["torrent", "usenet"].includes(entry.protocol) ? entry.protocol : "unknown",
      privacy: ["public", "private", "semiPrivate"].includes(entry.privacy) ? entry.privacy : "unknown",
      priority: Number.isSafeInteger(entry.priority) ? entry.priority : null,
      // Prowlarr keeps a status record only while an indexer is failing.
      failing: Boolean(status),
      disabledUntil,
      failingSince: isoTime(status?.initialFailure),
      lastFailureAt: isoTime(status?.mostRecentFailure),
      queries: count(stat?.numberOfQueries),
      grabs: count(stat?.numberOfGrabs),
      failedQueries: count(stat?.numberOfFailedQueries),
      averageResponseMs: count(stat?.averageResponseTime)
    });
  }
  return indexers.sort((left, right) => Number(right.failing) - Number(left.failing) || left.name.localeCompare(right.name));
}

/** GET /api/v1/applications, keeping only names. */
export function parseApplications(body) {
  if (!Array.isArray(body)) return [];
  const applications = [];
  for (const entry of body.slice(0, MAX_APPLICATIONS)) {
    const id = indexerId(isRecord(entry) ? entry.id : null);
    if (id === null) continue;
    applications.push({
      id,
      name: text(entry.name, 80) || `Application ${id}`,
      kind: text(entry.implementationName ?? entry.implementation, 40),
      syncLevel: ["disabled", "addOnly", "fullSync"].includes(entry.syncLevel) ? entry.syncLevel : "unknown"
    });
  }
  return applications.sort((left, right) => left.name.localeCompare(right.name));
}

/** A testall response: [{ id, isValid, validationFailures }]. */
export function parseTestResults(body) {
  if (!Array.isArray(body)) throw new TypeError("invalid Prowlarr test response");
  const results = [];
  for (const entry of body.slice(0, MAX_INDEXERS)) {
    const id = indexerId(isRecord(entry) ? entry.id : null);
    if (id === null) continue;
    const ok = entry.isValid === true;
    results.push({ id, ok, message: ok ? "" : validationMessage(entry.validationFailures) || "The test failed." });
  }
  return results;
}
