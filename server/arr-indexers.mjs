// Radarr's and Sonarr's own indexers: what Helmsman reads and the tests it
// may run.
//
// Indexer records carry API keys in their `fields`, so the list is parsed
// into named, harmless properties only. Testing one indexer needs its full
// record: the broker reads it and posts it straight back to the same app's
// test endpoint, without parsing it into anything returned or stored. This
// mirrors Prowlarr's indexer tests (see prowlarr.mjs).

import { cleanProwlarrMessage, parseTestResults, validationMessage } from "./prowlarr.mjs";

export const ARR_INDEXER_SERVICES = Object.freeze(["radarr", "sonarr"]);
export const ARR_INDEXER_OPERATIONS = Object.freeze(["testIndexer", "testAllIndexers"]);

const MAX_INDEXERS = 200;
const INDEXER_RECORD_BYTES = 256 * 1024;

export const ARR_INDEXER_LIMITS = Object.freeze({
  indexerRecordBytes: INDEXER_RECORD_BYTES,
  listBytes: 2 * 1024 * 1024,
  resultBytes: 512 * 1024
});

const STEPS = Object.freeze({
  readIndexer: Object.freeze({ method: "GET", path: (id) => `/api/v3/indexer/${id}`, needsId: true }),
  testIndexer: Object.freeze({ method: "POST", path: () => "/api/v3/indexer/test", needsId: true, needsRecord: true }),
  testAllIndexers: Object.freeze({ method: "POST", path: () => "/api/v3/indexer/testall", body: "" })
});

function indexerId(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

/** Authorizes one step of a Radarr or Sonarr indexer test. */
export function authorizeArrIndexerStep(serviceValue, stepValue, { indexerId: idValue, record } = {}) {
  const service = ARR_INDEXER_SERVICES.includes(serviceValue) ? serviceValue : null;
  const step = STEPS[stepValue];
  const id = indexerId(idValue);
  const refuse = { allowed: false, code: "ROUTE_NOT_ALLOWED", message: "That indexer action is not allowed.", status: 404 };
  if (!service || !step || (step.needsId ? id === null : idValue !== undefined)) return refuse;
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
    service,
    actionId: "arr-indexer",
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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function isoTime(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

/** GET /api/v3/indexer and /api/v3/indexerstatus as safe summaries. */
export function parseArrIndexers(listBody, statusBody) {
  if (!Array.isArray(listBody)) throw new TypeError("invalid indexer list");
  const statuses = new Map();
  for (const entry of Array.isArray(statusBody) ? statusBody.slice(0, MAX_INDEXERS * 2) : []) {
    const id = indexerId(isRecord(entry) ? entry.indexerId : null);
    if (id !== null) statuses.set(id, entry);
  }
  const indexers = [];
  const seen = new Set();
  for (const entry of listBody.slice(0, MAX_INDEXERS)) {
    if (!isRecord(entry)) continue;
    const id = indexerId(entry.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const status = statuses.get(id);
    indexers.push({
      id,
      name: text(entry.name, 80) || `Indexer ${id}`,
      enabled: entry.enableRss === true || entry.enableAutomaticSearch === true || entry.enableInteractiveSearch === true,
      rss: entry.enableRss === true,
      search: entry.enableAutomaticSearch === true || entry.enableInteractiveSearch === true,
      protocol: ["torrent", "usenet"].includes(entry.protocol) ? entry.protocol : "unknown",
      priority: Number.isSafeInteger(entry.priority) ? entry.priority : null,
      // Like Prowlarr, a status record exists only while an indexer is failing.
      failing: Boolean(status),
      disabledUntil: isoTime(status?.disabledTill),
      failingSince: isoTime(status?.initialFailure),
      lastFailureAt: isoTime(status?.mostRecentFailure)
    });
  }
  return indexers.sort((left, right) => Number(right.failing) - Number(left.failing) || left.name.localeCompare(right.name));
}

export { cleanProwlarrMessage as cleanArrMessage, parseTestResults as parseArrTestResults, validationMessage as arrValidationMessage };
