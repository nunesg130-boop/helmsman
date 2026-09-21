import { createHash } from "node:crypto";

const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_NEGATIVE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_ARR_NEGATIVE_TTL_MS = 30 * 1_000;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_FETCHES = 3;
const DEFAULT_MAX_PENDING_FETCHES = 64;
const ARTWORK_DESCRIPTOR_VERSION = 4;
const MAX_SOURCE_COUNT = 4;
const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024;
const IMAGE_CONTENT_TYPE = /^image\/(?:avif|gif|jpeg|png|webp)$/u;
const JELLYFIN_RESOURCE = /^[A-Za-z0-9_-]{1,160}$/u;
const JELLYFIN_REVISION = /^[A-Za-z0-9_-]{1,96}$/u;
const ARR_RESOURCE = /^[1-9][0-9]{0,9}$/u;
const ARR_REVISION = /^[0-9]{1,20}$/u;
const SEERR_RESOURCE = /^[A-Za-z0-9_-]{1,196}\.(?:jpe?g|png|webp)$/u;
const TARGET_REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WAITER_ABORTED = Symbol("artwork-waiter-aborted");
const TRANSIENT_FAILURE_CODES = new Set([
  "ABORT_ERR",
  "BROKER_BUSY",
  "BROKER_STOPPING",
  "ARTWORK_CACHE_CLOSED",
  "ARTWORK_QUEUE_FULL",
  "CHECK_CANCELLED",
  "ECANCELED",
  "ECANCELLED",
  "ERR_CANCELED",
  "ERR_CANCELLED",
  "ETIMEDOUT",
  "PROBE_CANCELLED",
  "PROBE_TIMEOUT",
  "TARGET_CHANGED",
  "TIMEOUT",
  "UPSTREAM_TIMEOUT"
]);
const TRANSIENT_FAILURE_NAMES = new Set(["AbortError", "TimeoutError"]);

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function normalizedSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const service = typeof value.service === "string" ? value.service.toLowerCase() : "";
  const kind = typeof value.kind === "string" ? value.kind.toLowerCase() : "";
  const resource = typeof value.resource === "string" ? value.resource : "";
  const variant = typeof value.variant === "string" ? value.variant.toLowerCase() : "";
  const revision = typeof value.revision === "string" ? value.revision : "";
  const targetRevision = typeof value.targetRevision === "string" ? value.targetRevision.toLowerCase() : "";
  if (!TARGET_REVISION.test(targetRevision)) return null;
  if (service === "jellyfin"
    && kind === "primary"
    && variant === "w342q85"
    && JELLYFIN_RESOURCE.test(resource)
    && JELLYFIN_REVISION.test(revision)) {
    return Object.freeze({ service, kind, resource, revision, variant, targetRevision });
  }
  if (["radarr", "sonarr"].includes(service)
    && kind === "poster"
    && variant === "poster-250"
    && ARR_RESOURCE.test(resource)
    && (!revision || ARR_REVISION.test(revision))) {
    return Object.freeze({ service, kind, resource, ...(revision ? { revision } : {}), variant, targetRevision });
  }
  if (service === "seerr" && kind === "poster" && variant === "w342" && SEERR_RESOURCE.test(resource)) {
    return Object.freeze({ service, kind, resource, variant, targetRevision });
  }
  if (service === "seerr"
    && ["movie-poster", "tv-poster"].includes(kind)
    && variant === "w342"
    && ARR_RESOURCE.test(resource)) {
    return Object.freeze({ service, kind, resource, variant, targetRevision });
  }
  return null;
}

export function normalizeArtworkDescriptor(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== ARTWORK_DESCRIPTOR_VERSION
    || !Array.isArray(value.sources)) return null;
  const sources = [];
  const seen = new Set();
  for (const raw of value.sources.slice(0, MAX_SOURCE_COUNT)) {
    const source = normalizedSource(raw);
    if (!source) continue;
    const key = `${source.service}:${source.targetRevision}:${source.kind}:${source.resource}:${source.revision || ""}:${source.variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources.length
    ? Object.freeze({ version: ARTWORK_DESCRIPTOR_VERSION, sources: Object.freeze(sources) })
    : null;
}

export function artworkPathForSource(value) {
  return artworkPathsForSource(value)?.[0] || null;
}

export function artworkPathsForSource(value) {
  const source = normalizedSource(value);
  if (!source) return null;
  if (source.service === "jellyfin") {
    return [`/Items/${source.resource}/Images/Primary?maxWidth=342&quality=85&tag=${encodeURIComponent(source.revision)}`];
  }
  if (source.service === "seerr" && source.kind === "poster") {
    return [`/imageproxy/tmdb/t/p/w342/${source.resource}`];
  }
  if (source.service === "seerr" && source.kind === "movie-poster") return [`/api/v1/movie/${source.resource}`];
  if (source.service === "seerr" && source.kind === "tv-poster") return [`/api/v1/tv/${source.resource}`];
  const query = source.revision ? `?lastWrite=${source.revision}` : "";
  return [
    `/MediaCover/${source.resource}/poster-250.jpg${query}`,
    `/MediaCover/${source.resource}/poster-500.jpg${query}`,
    `/MediaCover/${source.resource}/poster.jpg${query}`
  ];
}

export function seerrPosterArtworkPath(detailsValue) {
  const details = detailsValue && typeof detailsValue === "object" && !Array.isArray(detailsValue)
    ? detailsValue
    : null;
  const candidate = details?.posterPath ?? details?.poster_path;
  if (typeof candidate !== "string") return null;
  const match = /^\/?([A-Za-z0-9_-]{1,196}\.(?:jpe?g|png|webp))$/iu.exec(candidate);
  return match ? `/imageproxy/tmdb/t/p/w342/${match[1]}` : null;
}

function isSeerrPosterLookup(source) {
  return source.service === "seerr" && ["movie-poster", "tv-poster"].includes(source.kind);
}

function normalizedTargetRevision(value) {
  return typeof value === "string" && TARGET_REVISION.test(value.toLowerCase()) ? value.toLowerCase() : "";
}

function requestSignal(value) {
  return value
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function"
    ? value
    : null;
}

function waitForPending(pending, signalValue) {
  const signal = requestSignal(signalValue);
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(WAITER_ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(WAITER_ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function isTransientFailure(error, signal) {
  if (signal?.aborted) return true;
  const code = typeof error?.code === "string" ? error.code.trim().toUpperCase() : "";
  const name = typeof error?.name === "string" ? error.name.trim() : "";
  return TRANSIENT_FAILURE_CODES.has(code) || TRANSIENT_FAILURE_NAMES.has(name);
}

function normalizedResponse(value) {
  const status = Number(value?.status);
  const contentType = String(value?.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const body = Buffer.isBuffer(value?.body) ? value.body : null;
  if (!Number.isInteger(status) || status < 200 || status >= 300) return null;
  if (!body || body.length < 1 || body.length > MAX_ARTWORK_BYTES || !IMAGE_CONTENT_TYPE.test(contentType)) return null;
  return {
    body: Buffer.from(body),
    contentType,
    etag: `"${createHash("sha256").update(body).digest("base64url")}"`
  };
}

function isTransientResponse(value) {
  const status = Number(value?.status);
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

function seerrDetails(value) {
  const status = Number(value?.status);
  const contentType = String(value?.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const body = Buffer.isBuffer(value?.body) ? value.body : null;
  if (!Number.isInteger(status) || status < 200 || status >= 300) return null;
  if (!body || body.length < 2 || body.length > MAX_METADATA_BYTES || contentType !== "application/json") return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createMediaArtworkCache(options = {}) {
  if (typeof options.fetchSource !== "function") throw new TypeError("An artwork source loader is required.");
  const fetchSource = options.fetchSource;
  const persistentStore = options.persistentStore
    && typeof options.persistentStore.get === "function"
    && typeof options.persistentStore.set === "function"
    ? options.persistentStore
    : null;
  const revisionFor = typeof options.revisionFor === "function" ? options.revisionFor : () => "";
  const fetchSignal = requestSignal(options.fetchSignal);
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const positiveTtlMs = boundedInteger(options.positiveTtlMs, DEFAULT_POSITIVE_TTL_MS, 1_000, 7 * 24 * 60 * 60 * 1_000);
  const negativeTtlMs = boundedInteger(options.negativeTtlMs, DEFAULT_NEGATIVE_TTL_MS, 1_000, 24 * 60 * 60 * 1_000);
  const arrNegativeTtlMs = boundedInteger(options.arrNegativeTtlMs, DEFAULT_ARR_NEGATIVE_TTL_MS, 1_000, 5 * 60 * 1_000);
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 1_024);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, MAX_ARTWORK_BYTES, 256 * 1024 * 1024);
  const maxConcurrentFetches = boundedInteger(options.maxConcurrentFetches, DEFAULT_MAX_CONCURRENT_FETCHES, 1, 16);
  const maxPendingFetches = boundedInteger(options.maxPendingFetches, DEFAULT_MAX_PENDING_FETCHES, 0, 1_024);
  const cache = new Map();
  const inFlight = new Map();
  const pendingFetches = [];
  let cachedBytes = 0;
  let activeFetches = 0;
  let generation = 0;
  let closed = false;

  function schedulerError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function startFetch(task) {
    if (task.signal) task.signal.removeEventListener("abort", task.onAbort);
    if (task.signal?.aborted) {
      task.reject(schedulerError("CHECK_CANCELLED", "The artwork fetch no longer has a waiting request."));
      return;
    }
    activeFetches += 1;
    Promise.resolve()
      .then(task.operation)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeFetches -= 1;
        while (!closed && activeFetches < maxConcurrentFetches && pendingFetches.length) {
          startFetch(pendingFetches.shift());
        }
      });
  }

  function scheduleFetch(operation, highPriority = false, signalValue) {
    if (closed) return Promise.reject(schedulerError("ARTWORK_CACHE_CLOSED", "The artwork cache is closed."));
    const signal = requestSignal(signalValue);
    if (signal?.aborted) {
      return Promise.reject(schedulerError("CHECK_CANCELLED", "The artwork fetch no longer has a waiting request."));
    }
    return new Promise((resolve, reject) => {
      const task = {
        operation,
        resolve,
        reject,
        highPriority,
        signal,
        onAbort: null
      };
      if (activeFetches < maxConcurrentFetches) {
        startFetch(task);
        return;
      }
      if (pendingFetches.length >= maxPendingFetches) {
        reject(schedulerError("ARTWORK_QUEUE_FULL", "The artwork fetch queue is full."));
        return;
      }
      if (!highPriority) {
        pendingFetches.push(task);
      } else {
        const firstNormal = pendingFetches.findIndex((candidate) => !candidate.highPriority);
        if (firstNormal < 0) pendingFetches.push(task);
        else pendingFetches.splice(firstNormal, 0, task);
      }
      if (signal) {
        task.onAbort = () => {
          const index = pendingFetches.indexOf(task);
          if (index < 0) return;
          pendingFetches.splice(index, 1);
          reject(schedulerError("CHECK_CANCELLED", "The artwork fetch no longer has a waiting request."));
        };
        signal.addEventListener("abort", task.onAbort, { once: true });
      }
    });
  }

  async function waitForInFlight(entry, signal) {
    entry.waiters += 1;
    try {
      return await waitForPending(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    }
  }

  function remove(key) {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.body?.length || 0;
    cache.delete(key);
  }

  function touch(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
  }

  function prune(now) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) remove(key);
    }
    while (cache.size > maxEntries || cachedBytes > maxBytes) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      remove(first);
    }
  }

  async function get(descriptorValue, context = {}) {
    const descriptor = normalizeArtworkDescriptor(descriptorValue);
    if (!descriptor) return null;
    const waiterSignal = requestSignal(context.signal);
    if (waiterSignal?.aborted) return null;
    const now = Number(clock());
    if (!Number.isFinite(now)) throw new TypeError("The artwork cache clock returned an invalid time.");
    prune(now);
    for (let sourceIndex = 0; sourceIndex < descriptor.sources.length; sourceIndex += 1) {
      if (waiterSignal?.aborted) return null;
      const source = descriptor.sources[sourceIndex];
      const currentTargetRevision = normalizedTargetRevision(await revisionFor(source));
      if (waiterSignal?.aborted) return null;
      if (!currentTargetRevision || currentTargetRevision !== source.targetRevision) continue;
      const key = `${source.service}:${source.targetRevision}:${source.kind}:${source.resource}:${source.revision || ""}:${source.variant}`;
      const cached = cache.get(key);
      if (cached?.expiresAt > now) {
        touch(key, cached);
        if (cached.negative) continue;
        return { body: Buffer.from(cached.body), contentType: cached.contentType, etag: cached.etag, source: source.service };
      }
      if (cached) remove(key);
      if (persistentStore) {
        let persisted = null;
        try {
          persisted = await persistentStore.get(key);
        } catch {
          // A damaged or unavailable disk cache must never prevent a trusted
          // upstream image fetch.
        }
        if (waiterSignal?.aborted) return null;
        const persistedTargetRevision = normalizedTargetRevision(await revisionFor(source));
        if (persistedTargetRevision !== source.targetRevision) continue;
        const normalizedPersisted = normalizedResponse({
          status: 200,
          contentType: persisted?.contentType,
          body: persisted?.body
        });
        if (normalizedPersisted) {
          const entry = {
            ...normalizedPersisted,
            negative: false,
            expiresAt: now + positiveTtlMs
          };
          cache.set(key, entry);
          cachedBytes += entry.body.length;
          prune(now);
          return { body: Buffer.from(entry.body), contentType: entry.contentType, etag: entry.etag, source: source.service };
        }
      }
      let flight = inFlight.get(key);
      if (flight?.controller.signal.aborted) {
        if (inFlight.get(key) === flight) inFlight.delete(key);
        flight = null;
      }
      if (!flight) {
        const fetchGeneration = generation;
        const controller = new AbortController();
        const sourceSignal = fetchSignal
          ? AbortSignal.any([fetchSignal, controller.signal])
          : controller.signal;
        flight = { controller, promise: null, settled: false, waiters: 0 };
        const currentFlight = flight;
        flight.promise = scheduleFetch(async () => {
          let normalized = null;
          // Unrevisioned Arr covers may be generated immediately after a
          // catalog refresh. Versioned misses use a much shorter negative TTL
          // than other definitive failures so the local cache recovers fast.
          let shouldCacheFailure = !(["radarr", "sonarr"].includes(source.service) && !source.revision);
          for (const path of artworkPathsForSource(source) || []) {
            try {
              let response = await fetchSource(source, {
                path,
                phase: isSeerrPosterLookup(source) ? "metadata" : "image",
                targetRevision: source.targetRevision,
                signal: sourceSignal
              });
              if (isSeerrPosterLookup(source)) {
                if (isTransientResponse(response)) {
                  shouldCacheFailure = false;
                  break;
                }
                const posterPath = seerrPosterArtworkPath(seerrDetails(response));
                if (!posterPath) break;
                response = await fetchSource(source, {
                  path: posterPath,
                  phase: "image",
                  targetRevision: source.targetRevision,
                  signal: sourceSignal
                });
              }
              normalized = normalizedResponse(response);
              if (normalized) break;
              if (isTransientResponse(response)) {
                shouldCacheFailure = false;
                break;
              }
              // Some Arr installations have the original poster before the
              // 250px derivative. Only a 404 advances to that fixed fallback.
              if (Number(response?.status) !== 404) break;
            } catch (error) {
              // Upstream error details remain in monitor health. Artwork failures
              // always fall through to the next trusted source. Capacity,
              // cancellation, and timeout failures are retryable and must not
              // poison the negative cache.
              shouldCacheFailure = !isTransientFailure(error, sourceSignal)
                && !(["radarr", "sonarr"].includes(source.service) && !source.revision);
              break;
            }
          }
          const completedTargetRevision = normalizedTargetRevision(await revisionFor(source));
          if (sourceSignal.aborted || completedTargetRevision !== source.targetRevision) return null;
          const completedAt = Number(clock());
          if (!Number.isFinite(completedAt)) throw new TypeError("The artwork cache clock returned an invalid time.");
          if (closed) return null;
          if (fetchGeneration !== generation) return normalized;
          if (!normalized) {
            if (shouldCacheFailure) {
              const failureTtlMs = ["radarr", "sonarr"].includes(source.service)
                ? arrNegativeTtlMs
                : negativeTtlMs;
              cache.set(key, { negative: true, expiresAt: completedAt + failureTtlMs });
              prune(completedAt);
            }
            return null;
          }
          const entry = { ...normalized, negative: false, expiresAt: completedAt + positiveTtlMs };
          cache.set(key, entry);
          cachedBytes += entry.body.length;
          prune(completedAt);
          if (persistentStore) {
            Promise.resolve(persistentStore.set(key, entry)).catch(() => {});
          }
          return entry;
        }, sourceIndex > 0, controller.signal).finally(() => {
          currentFlight.settled = true;
          if (inFlight.get(key) === currentFlight) inFlight.delete(key);
        });
        inFlight.set(key, flight);
      }
      let entry;
      try {
        entry = await waitForInFlight(flight, waiterSignal);
      } catch (error) {
        if (waiterSignal?.aborted) return null;
        if (isTransientFailure(error, fetchSignal)) continue;
        throw error;
      }
      if (entry === WAITER_ABORTED) return null;
      if (!entry) {
        continue;
      }
      return { body: Buffer.from(entry.body), contentType: entry.contentType, etag: entry.etag, source: source.service };
    }
    return null;
  }

  return Object.freeze({
    get,
    clear() {
      generation += 1;
      cache.clear();
      cachedBytes = 0;
    },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      const error = schedulerError("ARTWORK_CACHE_CLOSED", "The artwork cache is closed.");
      while (pendingFetches.length) {
        const task = pendingFetches.shift();
        if (task.signal) task.signal.removeEventListener("abort", task.onAbort);
        task.reject(error);
      }
      for (const entry of inFlight.values()) entry.controller.abort();
      cache.clear();
      cachedBytes = 0;
    },
    stats() {
      return Object.freeze({ entries: cache.size, bytes: cachedBytes });
    }
  });
}

export const MEDIA_ARTWORK_LIMITS = Object.freeze({
  descriptorVersion: ARTWORK_DESCRIPTOR_VERSION,
  maximumSources: MAX_SOURCE_COUNT,
  maximumArtworkBytes: MAX_ARTWORK_BYTES,
  maximumMetadataBytes: MAX_METADATA_BYTES,
  defaultMaximumConcurrentFetches: DEFAULT_MAX_CONCURRENT_FETCHES,
  defaultMaximumPendingFetches: DEFAULT_MAX_PENDING_FETCHES
});
