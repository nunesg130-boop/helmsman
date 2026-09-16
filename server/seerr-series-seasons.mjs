import { createHash } from "node:crypto";

const MAX_SEASONS = 256;
const MAX_TEXT_CODE_POINTS = 120;
const MAX_TMDB_ID = 9_999_999_999;
const TARGET_REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

const MEDIA_STATUS = Object.freeze({
  1: "unknown",
  2: "pending",
  3: "processing",
  4: "partially_available",
  5: "available",
  6: "blocklisted",
  7: "deleted"
});

const REQUEST_STATUS = Object.freeze({
  1: "pending",
  2: "approved",
  3: "declined",
  4: "failed",
  5: "completed"
});

const BLOCKED_MEDIA_STATES = new Set([
  "pending",
  "processing",
  "partially_available",
  "available",
  "blocklisted"
]);

const BLOCKED_REQUEST_STATES = new Set(["pending", "approved", "failed"]);
const REQUEST_STATE_PRIORITY = Object.freeze({ pending: 5, approved: 4, failed: 3, completed: 2, declined: 1 });

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

function integer(value, minimum, maximum) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value))) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function safeText(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let normalized;
  try {
    normalized = String(value).normalize("NFKC");
  } catch {
    return null;
  }
  normalized = normalized
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  const points = Array.from(normalized);
  return points.length <= MAX_TEXT_CODE_POINTS
    ? normalized
    : `${points.slice(0, MAX_TEXT_CODE_POINTS - 1).join("")}\u2026`;
}

function safeDate(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function mediaStatus(value) {
  const numeric = integer(value, 1, 7);
  if (numeric !== null) return MEDIA_STATUS[numeric] || "unknown";
  const normalized = String(value || "").trim().toLowerCase().replace(/[ -]+/gu, "_");
  return Object.values(MEDIA_STATUS).includes(normalized) ? normalized : "unknown";
}

function requestStatus(value) {
  const numeric = integer(value, 1, 5);
  if (numeric !== null) return REQUEST_STATUS[numeric] || null;
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(REQUEST_STATUS).includes(normalized) ? normalized : null;
}

function standardRequest(value) {
  const request = record(value);
  if (!request || own(request, "is4k") === true) return null;
  const status = requestStatus(own(request, "status") ?? own(request, "requestStatus"));
  if (!status) return null;
  const seasons = [];
  const seen = new Set();
  for (const seasonValue of Array.isArray(own(request, "seasons")) ? own(request, "seasons") : []) {
    const season = record(seasonValue);
    const seasonNumber = integer(
      own(season, "seasonNumber") ?? own(season, "season_number") ?? seasonValue,
      0,
      10_000
    );
    if (seasonNumber === null || seen.has(seasonNumber)) continue;
    seen.add(seasonNumber);
    seasons.push({
      seasonNumber,
      status: requestStatus(own(season, "status") ?? own(season, "requestStatus")) || status
    });
    if (seasons.length >= MAX_SEASONS) break;
  }
  return { status, seasons };
}

function preferredRequestState(current, candidate) {
  if (!candidate) return current;
  if (!current || REQUEST_STATE_PRIORITY[candidate] > REQUEST_STATE_PRIORITY[current]) return candidate;
  return current;
}

function canonicalRevisionPayload(tmdbId, targetRevision, seasons) {
  return JSON.stringify({
    tmdbId,
    targetRevision,
    seasons: seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      episodeCount: season.episodeCount,
      status: season.status,
      requestState: season.requestState,
      requestable: season.requestable
    }))
  });
}

/**
 * Converts Seerr's rich TV detail response into the bounded season contract
 * used by the browser. User, server, profile, path, and raw request metadata
 * are deliberately discarded here at the broker boundary.
 */
export function normalizeSeerrSeriesSeasons(value, context = {}) {
  const detail = record(value);
  const tmdbId = integer(context.tmdbId, 1, MAX_TMDB_ID);
  const targetRevision = typeof context.targetRevision === "string"
    ? context.targetRevision.trim().toLowerCase()
    : "";
  if (!detail
    || tmdbId === null
    || !TARGET_REVISION.test(targetRevision)
    || integer(own(detail, "id"), 1, MAX_TMDB_ID) !== tmdbId) {
    return null;
  }

  const mediaInfo = record(own(detail, "mediaInfo")) || {};
  const statuses = new Map();
  for (const value of Array.isArray(own(mediaInfo, "seasons")) ? own(mediaInfo, "seasons") : []) {
    const source = record(value);
    if (!source) continue;
    const seasonNumber = integer(own(source, "seasonNumber") ?? own(source, "season_number"), 0, 10_000);
    if (seasonNumber === null || statuses.has(seasonNumber)) continue;
    statuses.set(seasonNumber, mediaStatus(own(source, "status")));
    if (statuses.size >= MAX_SEASONS) break;
  }

  const requestStates = new Map();
  let wholeSeriesRequestState = null;
  for (const value of Array.isArray(own(mediaInfo, "requests")) ? own(mediaInfo, "requests") : []) {
    const request = standardRequest(value);
    if (!request) continue;
    if (!request.seasons.length) {
      wholeSeriesRequestState = preferredRequestState(wholeSeriesRequestState, request.status);
      continue;
    }
    for (const season of request.seasons) {
      requestStates.set(
        season.seasonNumber,
        preferredRequestState(requestStates.get(season.seasonNumber) || null, season.status)
      );
    }
  }

  const seasons = [];
  const seen = new Set();
  for (const value of Array.isArray(own(detail, "seasons")) ? own(detail, "seasons") : []) {
    const source = record(value);
    if (!source) continue;
    const seasonNumber = integer(own(source, "seasonNumber") ?? own(source, "season_number"), 0, 10_000);
    if (seasonNumber === null || seen.has(seasonNumber)) continue;
    const episodeCount = integer(own(source, "episodeCount") ?? own(source, "episode_count"), 0, 100_000) ?? 0;
    const status = statuses.get(seasonNumber) || "unknown";
    const requestState = preferredRequestState(
      requestStates.get(seasonNumber) || null,
      wholeSeriesRequestState
    );
    const requestable = seasonNumber >= 1
      && episodeCount > 0
      && !BLOCKED_MEDIA_STATES.has(status)
      && !BLOCKED_REQUEST_STATES.has(requestState);
    seen.add(seasonNumber);
    seasons.push(Object.freeze({
      seasonNumber,
      name: safeText(own(source, "name")) || (seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`),
      episodeCount,
      airDate: safeDate(own(source, "airDate") ?? own(source, "air_date")),
      status,
      requestState,
      requestable
    }));
    if (seasons.length >= MAX_SEASONS) break;
  }
  seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
  const detailRevision = createHash("sha256")
    .update(canonicalRevisionPayload(tmdbId, targetRevision, seasons), "utf8")
    .digest("hex");
  return Object.freeze({
    tmdbId,
    targetRevision,
    detailRevision,
    seasons: Object.freeze(seasons)
  });
}

export const SEERR_SERIES_SEASON_LIMITS = Object.freeze({
  maximumSeasons: MAX_SEASONS,
  maximumSelectedSeasons: 100
});
