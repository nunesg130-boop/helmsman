const DEFAULT_CACHE_ENTRIES = 512;
const DEFAULT_LOOKUPS_PER_CYCLE = 24;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PARTIAL_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_NEGATIVE_TTL_MS = 2 * 60 * 1_000;
const DEFAULT_DEADLINE_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_REQUEST_ROWS = 200;
const MAX_TEXT_CODE_POINTS = 180;
const TARGET_REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const POSTER_PATH = /^\/[A-Za-z0-9_-]{1,196}\.(?:jpe?g|png|webp)$/iu;
const CACHE_MISS = Symbol("cache-miss");

export const SEERR_REQUEST_METADATA_LIMITS = Object.freeze({
  maximumCacheEntries: DEFAULT_CACHE_ENTRIES,
  maximumLookupsPerCycle: DEFAULT_LOOKUPS_PER_CYCLE,
  maximumConcurrency: DEFAULT_CONCURRENCY,
  positiveTtlMs: DEFAULT_POSITIVE_TTL_MS,
  partialTtlMs: DEFAULT_PARTIAL_TTL_MS,
  negativeTtlMs: DEFAULT_NEGATIVE_TTL_MS,
  deadlineMs: DEFAULT_DEADLINE_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
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

function positiveInteger(value, maximum = 9_999_999_999) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value))) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
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

function mediaType(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "movie") return "movie";
  if (["tv", "series", "show"].includes(token)) return "series";
  return null;
}

function posterPath(value) {
  return typeof value === "string" && POSTER_PATH.test(value) ? value : null;
}

function year(value) {
  const direct = positiveInteger(value, 9_999);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(?:-|$)/u.exec(value.trim());
  return match ? positiveInteger(match[1], 9_999) : null;
}

function targetRevision(value) {
  const revision = String(value || "").trim().toLowerCase();
  return TARGET_REVISION.test(revision) ? revision : null;
}

function requestRows(body) {
  const source = record(body);
  if (!source) return null;
  if (Array.isArray(own(source, "results"))) {
    return { field: "results", rows: own(source, "results").slice(0, MAX_REQUEST_ROWS), allRows: own(source, "results") };
  }
  if (Array.isArray(own(source, "requests"))) {
    return { field: "requests", rows: own(source, "requests").slice(0, MAX_REQUEST_ROWS), allRows: own(source, "requests") };
  }
  return null;
}

function requestCandidate(value) {
  const request = record(value);
  const nestedMedia = record(own(request, "media"));
  const media = nestedMedia || request;
  if (!request || !media) return null;
  const type = mediaType(own(media, "mediaType") ?? own(request, "type"));
  const tmdbId = positiveInteger(own(media, "tmdbId") ?? own(media, "tmdb_id"));
  if (!type || !tmdbId) return null;
  const title = safeText(
    own(media, "title") ?? own(media, "name") ?? own(media, "originalTitle") ?? own(media, "originalName")
    ?? own(request, "title") ?? own(request, "name") ?? own(request, "originalTitle") ?? own(request, "originalName")
  );
  const poster = posterPath(own(media, "posterPath") ?? own(media, "poster_path"));
  const releaseYear = year(
    own(media, "year") ?? own(media, "releaseDate") ?? own(media, "release_date")
    ?? own(media, "firstAirDate") ?? own(media, "first_air_date")
  );
  return {
    mediaType: type,
    tmdbId,
    key: `${type}:${tmdbId}`,
    needsLookup: !title || !poster || !releaseYear
  };
}

function normalizedDetail(candidate, value) {
  const detail = record(value);
  if (!detail || positiveInteger(own(detail, "id")) !== candidate.tmdbId) return null;
  const title = safeText(candidate.mediaType === "movie"
    ? own(detail, "title") ?? own(detail, "originalTitle") ?? own(detail, "original_title")
    : own(detail, "name") ?? own(detail, "originalName") ?? own(detail, "original_name"));
  const poster = posterPath(own(detail, "posterPath") ?? own(detail, "poster_path"));
  const releaseYear = year(candidate.mediaType === "movie"
    ? own(detail, "releaseDate") ?? own(detail, "release_date") ?? own(detail, "year")
    : own(detail, "firstAirDate") ?? own(detail, "first_air_date") ?? own(detail, "year"));
  if (!title && !poster && !releaseYear) return null;
  return Object.freeze({
    mediaType: candidate.mediaType,
    tmdbId: candidate.tmdbId,
    ...(title ? { title } : {}),
    ...(releaseYear ? { year: releaseYear } : {}),
    ...(poster ? { posterPath: poster } : {})
  });
}

function overlayMetadata(value, metadata) {
  const request = record(value);
  if (!request || !metadata) return value;
  const nestedMedia = record(own(request, "media"));
  const source = nestedMedia || request;
  const suppliedTitle = safeText(
    own(source, "title") ?? own(source, "name") ?? own(source, "originalTitle") ?? own(source, "originalName")
  );
  const suppliedPoster = posterPath(own(source, "posterPath") ?? own(source, "poster_path"));
  const suppliedYear = year(
    own(source, "year") ?? own(source, "releaseDate") ?? own(source, "release_date")
    ?? own(source, "firstAirDate") ?? own(source, "first_air_date")
  );
  const enriched = {
    ...source,
    ...(!suppliedTitle && metadata.title ? { title: metadata.title } : {}),
    ...(!suppliedYear && metadata.year ? { year: metadata.year } : {}),
    ...(!suppliedPoster && metadata.posterPath ? { posterPath: metadata.posterPath } : {})
  };
  return nestedMedia ? { ...request, media: enriched } : enriched;
}

function abortable(value, signal) {
  if (!signal) return Promise.resolve(value).catch(() => null);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolve(result);
    };
    const aborted = () => finish(null);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(finish, () => finish(null));
  });
}

/**
 * Creates a presentation-only Seerr request metadata cache. Detail lookups are
 * restricted to typed TMDb IDs extracted from Seerr's own bounded request list.
 */
export function createSeerrRequestMetadataEnricher(options = {}) {
  if (typeof options.fetchDetail !== "function") {
    throw new TypeError("A Seerr request metadata transport is required.");
  }
  const fetchDetail = options.fetchDetail;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const maximumCacheEntries = boundedInteger(options.maximumCacheEntries, DEFAULT_CACHE_ENTRIES, 1, 4_096);
  const maximumLookupsPerCycle = boundedInteger(options.maximumLookupsPerCycle, DEFAULT_LOOKUPS_PER_CYCLE, 1, 200);
  const maximumConcurrency = boundedInteger(options.maximumConcurrency, DEFAULT_CONCURRENCY, 1, 4);
  const positiveTtlMs = boundedInteger(options.positiveTtlMs, DEFAULT_POSITIVE_TTL_MS, 1_000, 7 * 24 * 60 * 60 * 1_000);
  const partialTtlMs = boundedInteger(options.partialTtlMs, DEFAULT_PARTIAL_TTL_MS, 1_000, 24 * 60 * 60 * 1_000);
  const negativeTtlMs = boundedInteger(options.negativeTtlMs, DEFAULT_NEGATIVE_TTL_MS, 1_000, 60 * 60 * 1_000);
  const deadlineMs = boundedInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, 250, 30_000);
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 250, 10_000);
  const fetchSignal = options.signal;
  const closeController = new AbortController();
  const cache = new Map();
  const inFlight = new Map();
  const pending = [];
  const cursors = new Map();
  let active = 0;
  let closed = false;

  function cacheKey(revision, candidate) {
    return `${revision}:${candidate.key}`;
  }

  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return CACHE_MISS;
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Number(now())) {
      cache.delete(key);
      return CACHE_MISS;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  function remember(key, value) {
    const ttl = value
      ? value.title && value.posterPath && value.year ? positiveTtlMs : partialTtlMs
      : negativeTtlMs;
    cache.delete(key);
    cache.set(key, { value, expiresAt: Number(now()) + ttl });
    while (cache.size > maximumCacheEntries) cache.delete(cache.keys().next().value);
  }

  function operationSignal(timeoutSignal) {
    const signals = [closeController.signal];
    if (fetchSignal) signals.push(fetchSignal);
    if (timeoutSignal) signals.push(timeoutSignal);
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }

  function pump() {
    while (!closed && active < maximumConcurrency && pending.length) {
      const task = pending.shift();
      if (inFlight.get(task.key) !== task) continue;
      active += 1;
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const signal = operationSignal(timeoutSignal);
      const operation = Promise.resolve().then(async () => {
        try {
          const detail = await fetchDetail(task.candidate, {
            signal,
            targetRevision: task.revision,
            timeoutMs: requestTimeoutMs
          });
          const normalized = normalizedDetail(task.candidate, detail);
          if (!closed && !signal.aborted) remember(task.key, normalized);
          return normalized;
        } catch {
          // Transport failures, timeouts, cancellation, and broker saturation
          // are transient. Only a completed but unusable response is negatively
          // cached, so a later monitoring cycle can recover immediately.
          return null;
        }
      });

      operation.then((result) => {
        if (inFlight.get(task.key) === task) inFlight.delete(task.key);
        task.resolve(result);
      });

      // A transport is expected to honor the signal. The abortable wrapper also
      // releases this scheduler slot if a faulty transport does not, while the
      // unresolved task stays deduplicated until it actually settles or closes.
      abortable(operation, signal).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function schedule(revision, candidate) {
    const key = cacheKey(revision, candidate);
    const existing = inFlight.get(key);
    if (existing) return existing;
    if (inFlight.size >= MAX_REQUEST_ROWS) return null;
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    const task = { key, revision, candidate, promise, resolve };
    inFlight.set(key, task);
    pending.push(task);
    pump();
    return task;
  }

  function rememberCursor(revision, cursor) {
    cursors.delete(revision);
    cursors.set(revision, cursor);
    while (cursors.size > 32) cursors.delete(cursors.keys().next().value);
  }

  async function enrich(body, context = {}) {
    const collection = requestRows(body);
    const revision = targetRevision(context.targetRevision);
    if (closed || !collection || !revision || context.signal?.aborted || fetchSignal?.aborted) return body;

    const candidates = new Map();
    for (const row of collection.rows) {
      const candidate = requestCandidate(row);
      if (candidate?.needsLookup && !candidates.has(candidate.key)) candidates.set(candidate.key, candidate);
    }
    if (!candidates.size) return body;

    const candidateList = [...candidates.values()];
    const start = (cursors.get(revision) || 0) % candidateList.length;
    const waiting = new Set();
    let scheduled = 0;
    let lastScheduledOffset = -1;
    for (let offset = 0; offset < candidateList.length; offset += 1) {
      const candidate = candidateList[(start + offset) % candidateList.length];
      const key = cacheKey(revision, candidate);
      const hit = cached(key);
      if (hit !== CACHE_MISS) continue;
      let task = inFlight.get(key);
      if (!task && scheduled < maximumLookupsPerCycle) {
        task = schedule(revision, candidate);
        if (!task) break;
        scheduled += 1;
        lastScheduledOffset = offset;
      }
      if (task) waiting.add(task.promise);
    }
    rememberCursor(
      revision,
      (start + (lastScheduledOffset >= 0 ? lastScheduledOffset + 1 : 1)) % candidateList.length
    );

    if (waiting.size) {
      const deadline = new AbortController();
      const stop = () => deadline.abort();
      const outerSignal = context.signal;
      if (outerSignal) outerSignal.addEventListener("abort", stop, { once: true });
      if (fetchSignal) fetchSignal.addEventListener("abort", stop, { once: true });
      closeController.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, deadlineMs);
      try {
        await abortable(Promise.all(waiting), deadline.signal);
      } finally {
        clearTimeout(timer);
        if (outerSignal) outerSignal.removeEventListener("abort", stop);
        if (fetchSignal) fetchSignal.removeEventListener("abort", stop);
        closeController.signal.removeEventListener("abort", stop);
      }
    }

    const metadata = new Map();
    for (const candidate of candidateList) {
      const hit = cached(cacheKey(revision, candidate));
      if (hit !== CACHE_MISS && hit) metadata.set(candidate.key, hit);
    }
    if (!metadata.size) return body;
    return {
      ...body,
      [collection.field]: collection.allRows.map((row) => {
        const candidate = requestCandidate(row);
        return overlayMetadata(row, candidate ? metadata.get(candidate.key) : null);
      })
    };
  }

  return Object.freeze({
    enrich,
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      closeController.abort();
      while (pending.length) {
        const task = pending.shift();
        if (inFlight.get(task.key) === task) inFlight.delete(task.key);
        task.resolve(null);
      }
      for (const task of inFlight.values()) task.resolve(null);
      inFlight.clear();
      cursors.clear();
    }
  });
}
