import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  artworkPathForSource,
  artworkPathsForSource,
  createMediaArtworkCache,
  MEDIA_ARTWORK_LIMITS,
  normalizeArtworkDescriptor,
  seerrPosterArtworkPath
} from "../server/media-artwork.mjs";

const TARGET_A = "11111111-1111-4111-8111-111111111111";
const TARGET_B = "22222222-2222-4222-8222-222222222222";
const JELLYFIN = Object.freeze({
  service: "jellyfin", kind: "primary", resource: "jf_item-42", revision: "jf-tag_123", variant: "w342q85", targetRevision: TARGET_A
});
const RADARR = Object.freeze({ service: "radarr", kind: "poster", resource: "42", variant: "poster-250", targetRevision: TARGET_A });
const SONARR = Object.freeze({ service: "sonarr", kind: "poster", resource: "73", variant: "poster-250", targetRevision: TARGET_A });
const SEERR = Object.freeze({ service: "seerr", kind: "poster", resource: "poster_name-42.jpg", variant: "w342", targetRevision: TARGET_A });
const SEERR_MOVIE = Object.freeze({ service: "seerr", kind: "movie-poster", resource: "45140", variant: "w342", targetRevision: TARGET_A });
const SEERR_TV = Object.freeze({ service: "seerr", kind: "tv-poster", resource: "912", variant: "w342", targetRevision: TARGET_A });

function image(body, contentType = "image/png", status = 200) {
  return { status, contentType, body: Buffer.isBuffer(body) ? body : Buffer.from(body) };
}

function descriptor(...sources) {
  return {
    version: MEDIA_ARTWORK_LIMITS.descriptorVersion,
    sources: sources.map((source) => ({ targetRevision: TARGET_A, ...source }))
  };
}

test("normalizes only bounded service-owned descriptors and derives fixed artwork paths", () => {
  assert.deepEqual(normalizeArtworkDescriptor(descriptor(
    { ...JELLYFIN, service: "JELLYFIN", kind: "PRIMARY" },
    RADARR,
    SONARR,
    SEERR,
    { service: "seerr", kind: "poster", resource: "ignored-fifth.jpg" }
  )), {
    version: 4,
    sources: [JELLYFIN, RADARR, SONARR, SEERR]
  });
  assert.equal(MEDIA_ARTWORK_LIMITS.maximumSources, 4);
  assert.equal(Object.isFrozen(normalizeArtworkDescriptor(descriptor(JELLYFIN))), true);
  assert.equal(Object.isFrozen(normalizeArtworkDescriptor(descriptor(JELLYFIN)).sources), true);

  const deduplicated = normalizeArtworkDescriptor(descriptor(JELLYFIN, JELLYFIN, RADARR));
  assert.deepEqual(deduplicated.sources, [JELLYFIN, RADARR]);
  assert.equal(Object.isFrozen(deduplicated.sources[0]), true);

  assert.equal(artworkPathForSource(JELLYFIN), "/Items/jf_item-42/Images/Primary?maxWidth=342&quality=85&tag=jf-tag_123");
  assert.equal(artworkPathForSource(RADARR), "/MediaCover/42/poster-250.jpg");
  assert.deepEqual(artworkPathsForSource(RADARR), [
    "/MediaCover/42/poster-250.jpg",
    "/MediaCover/42/poster-500.jpg",
    "/MediaCover/42/poster.jpg"
  ]);
  assert.equal(
    artworkPathForSource({ ...RADARR, revision: "638934912000000000" }),
    "/MediaCover/42/poster-250.jpg?lastWrite=638934912000000000"
  );
  assert.deepEqual(artworkPathsForSource({ ...RADARR, revision: "638934912000000000" }), [
    "/MediaCover/42/poster-250.jpg?lastWrite=638934912000000000",
    "/MediaCover/42/poster-500.jpg?lastWrite=638934912000000000",
    "/MediaCover/42/poster.jpg?lastWrite=638934912000000000"
  ]);
  assert.equal(artworkPathForSource(SONARR), "/MediaCover/73/poster-250.jpg");
  assert.equal(artworkPathForSource(SEERR), "/imageproxy/tmdb/t/p/w342/poster_name-42.jpg");
  assert.equal(artworkPathForSource(SEERR_MOVIE), "/api/v1/movie/45140");
  assert.equal(artworkPathForSource(SEERR_TV), "/api/v1/tv/912");
  assert.deepEqual(normalizeArtworkDescriptor(descriptor(SEERR_MOVIE)).sources, [SEERR_MOVIE]);
  assert.deepEqual(normalizeArtworkDescriptor(descriptor(SEERR_TV)).sources, [SEERR_TV]);

  for (const invalid of [
    null,
    [],
    {},
    { sources: "not-an-array" },
    { sources: [JELLYFIN] },
    { version: 1, sources: [JELLYFIN] },
    { version: 4, sources: [{ ...JELLYFIN, targetRevision: undefined }] },
    { version: 4, sources: [{ ...JELLYFIN, targetRevision: "not-a-uuid" }] },
    descriptor(),
    descriptor({ service: "jellyfin", kind: "primary", resource: "../secret" }),
    descriptor({ service: "jellyfin", kind: "primary", resource: "item", revision: "unsafe tag", variant: "w342q85" }),
    descriptor({ service: "jellyfin", kind: "primary", resource: "item", revision: "tag", variant: "original" }),
    descriptor({ service: "jellyfin", kind: "backdrop", resource: "item" }),
    descriptor({ service: "radarr", kind: "poster", resource: "0" }),
    descriptor({ service: "radarr", kind: "poster", resource: "01" }),
    descriptor({ service: "sonarr", kind: "poster", resource: "1/2" }),
    descriptor({ service: "seerr", kind: "poster", resource: "folder/poster.jpg" }),
    descriptor({ service: "seerr", kind: "poster", resource: "poster.svg" }),
    descriptor({ service: "seerr", kind: "movie-poster", resource: "0", variant: "w342" }),
    descriptor({ service: "seerr", kind: "movie-poster", resource: "45140?x=1", variant: "w342" }),
    descriptor({ service: "seerr", kind: "tv-poster", resource: "0", variant: "w342" }),
    descriptor({ service: "seerr", kind: "tv-poster", resource: "912/extra", variant: "w342" }),
    descriptor({ service: "unknown", kind: "poster", resource: "42" })
  ]) {
    assert.equal(normalizeArtworkDescriptor(invalid), null, JSON.stringify(invalid));
  }
  assert.equal(artworkPathForSource({ service: "jellyfin", kind: "primary", resource: "id?x=1" }), null);
  assert.equal(artworkPathForSource({ service: "radarr", kind: "poster", resource: "42/../../../x" }), null);
  assert.equal(artworkPathForSource({ service: "seerr", kind: "poster", resource: "https://evil.test/x.jpg" }), null);
});

test("uses descriptor order for fallback and stops at the first valid image", async () => {
  const calls = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source, options) => {
      calls.push({ source, options });
      if (source.service === "jellyfin") throw new Error("private upstream detail");
      if (source.service === "radarr") return image("missing", "image/png", 404);
      if (source.service === "sonarr") return image("sonarr-poster", "image/webp");
      return image("must-not-be-requested", "image/jpeg");
    }
  });

  const result = await cache.get(descriptor(JELLYFIN, RADARR, SONARR, SEERR));
  assert.equal(result.source, "sonarr");
  assert.equal(result.contentType, "image/webp");
  assert.deepEqual(result.body, Buffer.from("sonarr-poster"));
  assert.deepEqual(calls.map(({ source }) => source.service), ["jellyfin", "radarr", "radarr", "radarr", "sonarr"]);
  assert.deepEqual(calls.map(({ options }) => options.path), [
    "/Items/jf_item-42/Images/Primary?maxWidth=342&quality=85&tag=jf-tag_123",
    "/MediaCover/42/poster-250.jpg",
    "/MediaCover/42/poster-500.jpg",
    "/MediaCover/42/poster.jpg",
    "/MediaCover/73/poster-250.jpg"
  ]);
});

test("reads a valid image from the persistent cache before contacting its service", async () => {
  let fetches = 0;
  const reads = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    persistentStore: {
      async get(key) {
        reads.push(key);
        return { body: Buffer.from("disk-poster"), contentType: "image/png" };
      },
      async set() {}
    },
    fetchSource: async () => {
      fetches += 1;
      return image("network-poster");
    }
  });

  const result = await cache.get(descriptor(JELLYFIN));
  assert.deepEqual(result.body, Buffer.from("disk-poster"));
  assert.equal(result.source, "jellyfin");
  assert.equal(fetches, 0);
  assert.equal(reads.length, 1);
  assert.match(reads[0], /^jellyfin:/u);
});

test("writes successful upstream artwork through to the persistent cache", async () => {
  const writes = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    persistentStore: {
      async get() { return null; },
      async set(key, entry) { writes.push({ key, entry }); }
    },
    fetchSource: async () => image("network-poster", "image/webp")
  });

  const result = await cache.get(descriptor(JELLYFIN));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result.body, Buffer.from("network-poster"));
  assert.equal(writes.length, 1);
  assert.match(writes[0].key, /^jellyfin:/u);
  assert.deepEqual(writes[0].entry.body, Buffer.from("network-poster"));
  assert.equal(writes[0].entry.contentType, "image/webp");
});

test("resolves a Sonarr TV poster through a typed Seerr detail fallback", async () => {
  const calls = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source, options) => {
      calls.push({ source, options });
      if (source.service === "sonarr") return image("missing", "image/jpeg", 404);
      if (options.phase === "metadata") {
        return {
          status: 200,
          contentType: "application/json; charset=utf-8",
          body: Buffer.from(JSON.stringify({ posterPath: "/vision_quest.jpg" }))
        };
      }
      return image("seerr-tv-poster", "image/jpeg");
    }
  });

  const result = await cache.get(descriptor(SONARR, SEERR_TV));
  assert.equal(result.source, "seerr");
  assert.deepEqual(result.body, Buffer.from("seerr-tv-poster"));
  assert.deepEqual(calls.map(({ options }) => [options.phase, options.path]), [
    ["image", "/MediaCover/73/poster-250.jpg"],
    ["image", "/MediaCover/73/poster-500.jpg"],
    ["image", "/MediaCover/73/poster.jpg"],
    ["metadata", "/api/v1/tv/912"],
    ["image", "/imageproxy/tmdb/t/p/w342/vision_quest.jpg"]
  ]);
});

test("resolves a request poster on demand through the typed Seerr movie route", async () => {
  const calls = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source, options) => {
      calls.push({ source, options });
      if (options.phase === "metadata") {
        return {
          status: 200,
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ id: 45_140, title: "Resolved Movie", posterPath: "/resolved_movie.jpg" }))
        };
      }
      return image("resolved-movie-poster", "image/jpeg");
    }
  });

  const result = await cache.get(descriptor(SEERR_MOVIE));
  assert.equal(result.source, "seerr");
  assert.deepEqual(result.body, Buffer.from("resolved-movie-poster"));
  assert.deepEqual(calls.map(({ options }) => [options.phase, options.path]), [
    ["metadata", "/api/v1/movie/45140"],
    ["image", "/imageproxy/tmdb/t/p/w342/resolved_movie.jpg"]
  ]);
});

test("accepts only a filename-like Seerr poster path from TV details", async () => {
  assert.equal(seerrPosterArtworkPath({ posterPath: "/poster-name_1.webp" }), "/imageproxy/tmdb/t/p/w342/poster-name_1.webp");
  assert.equal(seerrPosterArtworkPath({ poster_path: "poster.jpg" }), "/imageproxy/tmdb/t/p/w342/poster.jpg");
  for (const posterPath of [
    "https://evil.test/poster.jpg",
    "//evil.test/poster.jpg",
    "/folder/poster.jpg",
    "/../poster.jpg",
    "/poster.svg",
    "/poster.jpg?token=secret",
    ""
  ]) assert.equal(seerrPosterArtworkPath({ posterPath }), null, posterPath);

  let calls = 0;
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      calls += 1;
      return {
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ posterPath: "https://evil.test/poster.jpg" }))
      };
    }
  });
  assert.equal(await cache.get(descriptor(SEERR_TV)), null);
  assert.equal(calls, 1, "invalid detail metadata cannot trigger a second outbound request");
});

test("positively caches images until TTL expiry and returns detached buffers with stable ETags", async () => {
  let now = 10_000;
  let fetches = 0;
  const sourceBody = Buffer.from("stable-image-content");
  const expectedEtag = `"${createHash("sha256").update(sourceBody).digest("base64url")}"`;
  const cache = createMediaArtworkCache({
    clock: () => now,
    positiveTtlMs: 1_000,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      fetches += 1;
      return image(sourceBody, "IMAGE/PNG; charset=binary");
    }
  });

  const first = await cache.get(descriptor(JELLYFIN));
  assert.equal(first.etag, expectedEtag);
  assert.equal(first.contentType, "image/png");
  first.body.fill(0);

  now = 10_999;
  const cached = await cache.get(descriptor(JELLYFIN));
  assert.equal(fetches, 1);
  assert.deepEqual(cached.body, sourceBody, "callers cannot mutate the cached body");
  assert.equal(cached.etag, first.etag);

  now = 11_000;
  const refreshed = await cache.get(descriptor(JELLYFIN));
  assert.equal(fetches, 2, "the positive entry expires at the TTL boundary");
  assert.equal(refreshed.etag, expectedEtag, "the ETag is content-derived, not fetch-derived");
});

test("briefly caches a versioned Arr miss, then retries it ahead of the fallback", async () => {
  let now = 20_000;
  let primaryAvailable = false;
  const calls = [];
  const cache = createMediaArtworkCache({
    clock: () => now,
    positiveTtlMs: 10_000,
    negativeTtlMs: 1_000,
    arrNegativeTtlMs: 1_000,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source) => {
      calls.push(source.service);
      if (source.service === "radarr") {
        return primaryAvailable ? image("preferred-radarr", "image/jpeg") : image("not-found", "image/jpeg", 404);
      }
      return image("seerr-fallback", "image/png");
    }
  });

  const versionedRadarr = { ...RADARR, revision: "638934912000000000" };
  const first = await cache.get(descriptor(versionedRadarr, SEERR));
  assert.equal(first.source, "seerr");
  assert.deepEqual(calls, ["radarr", "radarr", "radarr", "seerr"], "all fixed Arr cover sizes are tried before Seerr");

  now = 20_999;
  const cachedFallback = await cache.get(descriptor(versionedRadarr, SEERR));
  assert.equal(cachedFallback.source, "seerr");
  assert.deepEqual(calls, ["radarr", "radarr", "radarr", "seerr"], "neither the short negative nor positive entry is retried early");

  primaryAvailable = true;
  now = 21_000;
  const preferred = await cache.get(descriptor(versionedRadarr, SEERR));
  assert.equal(preferred.source, "radarr");
  assert.deepEqual(preferred.body, Buffer.from("preferred-radarr"));
  assert.deepEqual(calls, ["radarr", "radarr", "radarr", "seerr", "radarr"]);
});

test("uses the 500px Arr poster when its 250px derivative is missing", async () => {
  const paths = [];
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (_source, { path }) => {
      paths.push(path);
      return path.includes("poster-250.jpg")
        ? image("missing", "image/jpeg", 404)
        : image("medium-poster", "image/jpeg");
    }
  });

  const result = await cache.get(descriptor(RADARR));
  assert.deepEqual(result.body, Buffer.from("medium-poster"));
  assert.deepEqual(paths, [
    "/MediaCover/42/poster-250.jpg",
    "/MediaCover/42/poster-500.jpg"
  ]);
});

test("does not negative-cache transient HTTP responses or unrevisioned Arr misses", async () => {
  for (const status of [408, 425, 429, 500, 503]) {
    let calls = 0;
    const cache = createMediaArtworkCache({
      revisionFor: (source) => source.targetRevision,
      fetchSource: async () => ++calls === 1
        ? image("temporary", "image/jpeg", status)
        : image("recovered", "image/jpeg")
    });
    assert.equal(await cache.get(descriptor(SEERR)), null, String(status));
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 }, String(status));
    assert.deepEqual((await cache.get(descriptor(SEERR))).body, Buffer.from("recovered"), String(status));
    assert.equal(calls, 2, String(status));
  }

  let arrCalls = 0;
  const arrCache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => ++arrCalls <= 3
      ? image("not-ready", "image/jpeg", 404)
      : image("ready", "image/jpeg")
  });
  assert.equal(await arrCache.get(descriptor(RADARR)), null);
  assert.deepEqual(arrCache.stats(), { entries: 0, bytes: 0 });
  assert.deepEqual((await arrCache.get(descriptor(RADARR))).body, Buffer.from("ready"));
  assert.equal(arrCalls, 4);
});

test("does not negatively cache transient saturation, cancellation, or timeout failures", async () => {
  const cases = [
    { error: Object.assign(new Error("busy"), { code: "BROKER_BUSY" }), label: "broker saturation" },
    { error: Object.assign(new Error("timed out"), { code: "UPSTREAM_TIMEOUT" }), label: "upstream timeout" },
    { error: Object.assign(new Error("cancelled"), { code: "CHECK_CANCELLED" }), label: "explicit cancellation" },
    { error: Object.assign(new Error("aborted"), { name: "AbortError" }), label: "abort error" }
  ];

  for (const { error, label } of cases) {
    let fetches = 0;
    const cache = createMediaArtworkCache({
      revisionFor: (source) => source.targetRevision,
      fetchSource: async () => {
        fetches += 1;
        if (fetches === 1) throw error;
        return image("recovered-image");
      }
    });

    assert.equal(await cache.get(descriptor(JELLYFIN)), null, label);
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 }, label);
    assert.deepEqual((await cache.get(descriptor(JELLYFIN))).body, Buffer.from("recovered-image"), label);
    assert.equal(fetches, 2, label);
  }

  let signalFetches = 0;
  const controller = new AbortController();
  controller.abort();
  const signalCache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      signalFetches += 1;
      return image("recovered-after-signal");
    }
  });
  assert.equal(await signalCache.get(descriptor(JELLYFIN), { signal: controller.signal }), null);
  assert.deepEqual(signalCache.stats(), { entries: 0, bytes: 0 });
  assert.equal(signalFetches, 0, "an already-aborted caller does not start upstream work");
  assert.deepEqual((await signalCache.get(descriptor(JELLYFIN))).body, Buffer.from("recovered-after-signal"));
});

test("continues to negatively cache definitive thrown artwork rejections", async () => {
  let now = 30_000;
  let fetches = 0;
  const cache = createMediaArtworkCache({
    clock: () => now,
    negativeTtlMs: 1_000,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      fetches += 1;
      if (fetches === 1) {
        throw Object.assign(new Error("unsupported content"), { code: "UPSTREAM_CONTENT_REJECTED" });
      }
      return image("valid-on-retry");
    }
  });

  assert.equal(await cache.get(descriptor(JELLYFIN)), null);
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 0 });
  now = 30_999;
  assert.equal(await cache.get(descriptor(JELLYFIN)), null);
  assert.equal(fetches, 1, "the definitive rejection remains cached through its negative TTL");
  now = 31_000;
  assert.deepEqual((await cache.get(descriptor(JELLYFIN))).body, Buffer.from("valid-on-retry"));
  assert.equal(fetches, 2);
});

test("isolates cache entries by validated target revision", async () => {
  let revision = TARGET_A;
  let fetches = 0;
  const cache = createMediaArtworkCache({
    revisionFor: () => revision,
    fetchSource: async () => image(`fetch-${++fetches}`)
  });

  assert.deepEqual((await cache.get(descriptor(RADARR))).body, Buffer.from("fetch-1"));
  assert.deepEqual((await cache.get(descriptor(RADARR))).body, Buffer.from("fetch-1"));
  assert.equal(fetches, 1);

  revision = TARGET_B;
  assert.equal(await cache.get(descriptor(RADARR)), null);
  assert.equal(fetches, 1, "a stale descriptor cannot consume or refresh cached bytes after retargeting");
  const retargeted = descriptor({ ...RADARR, targetRevision: TARGET_B });
  assert.deepEqual((await cache.get(retargeted)).body, Buffer.from("fetch-2"));
  assert.equal(fetches, 2, "a new target revision cannot consume the old target's cached image");

  revision = "invalid revision with spaces";
  assert.equal(await cache.get(retargeted), null);
  assert.equal(fetches, 2, "an invalid revision fails closed before loading a source");
});

test("isolates cached bytes by source artwork revision and variant", async () => {
  let fetches = 0;
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => image(`artwork-${++fetches}`)
  });
  const firstRevision = descriptor(JELLYFIN);
  const secondRevision = descriptor({ ...JELLYFIN, revision: "jf-tag_456" });

  assert.deepEqual((await cache.get(firstRevision)).body, Buffer.from("artwork-1"));
  assert.deepEqual((await cache.get(firstRevision)).body, Buffer.from("artwork-1"));
  assert.deepEqual((await cache.get(secondRevision)).body, Buffer.from("artwork-2"));
  assert.equal(fetches, 2, "an updated upstream artwork tag cannot reuse stale cached bytes");
});

test("coalesces concurrent requests for the same trusted artwork source", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      fetches += 1;
      await gate;
      return image("one-upstream-response");
    }
  });

  const first = cache.get(descriptor(JELLYFIN));
  const second = cache.get(descriptor(JELLYFIN));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.body, Buffer.from("one-upstream-response"));
  assert.deepEqual(right.body, Buffer.from("one-upstream-response"));
  assert.equal(fetches, 1);
});

test("lets an aborted coalesced waiter leave shared upstream work available to a live waiter", async () => {
  let fetches = 0;
  let upstreamSignal;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (_source, { signal }) => {
      fetches += 1;
      upstreamSignal = signal;
      await gate;
      return image("shared-upstream-response");
    }
  });
  const cancelled = new AbortController();
  const live = new AbortController();
  const first = cache.get(descriptor(JELLYFIN, RADARR), { signal: cancelled.signal });
  const second = cache.get(descriptor(JELLYFIN, RADARR), { signal: live.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  cancelled.abort();
  assert.equal(await first, null);
  assert.equal(fetches, 1, "aborting one waiter must not cancel or duplicate the shared fetch");
  assert.equal(upstreamSignal.aborted, false, "a live coalesced waiter keeps shared upstream work alive");
  release();
  assert.deepEqual((await second).body, Buffer.from("shared-upstream-response"));
  assert.equal(fetches, 1);
});

test("an aborted artwork waiter stops before scheduling a fallback", async () => {
  const calls = [];
  let upstreamSignal;
  const cache = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source, { signal }) => {
      calls.push(source.service);
      if (source.service === "jellyfin") {
        upstreamSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return image("missing", "image/png", 404);
      }
      return image("fallback");
    }
  });
  const controller = new AbortController();
  const pending = cache.get(descriptor(JELLYFIN, RADARR), { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(upstreamSignal.aborted, true, "unique abandoned upstream work is cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["jellyfin"]);
});

test("removes abandoned queued fetches without consuming the pending budget", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const cache = createMediaArtworkCache({
    maxConcurrentFetches: 1,
    maxPendingFetches: 1,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source) => {
      calls.push(source.resource);
      if (source.resource === "1") await gate;
      return image(source.resource);
    }
  });
  const active = cache.get(descriptor({ ...RADARR, resource: "1" }));
  const cancelled = new AbortController();
  const abandoned = cache.get(descriptor({ ...RADARR, resource: "2" }), { signal: cancelled.signal });
  await new Promise((resolve) => setImmediate(resolve));
  cancelled.abort();
  assert.equal(await abandoned, null);
  const replacement = cache.get(descriptor({ ...RADARR, resource: "3" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["1"], "the replacement waits but is accepted into the freed queue slot");
  release();
  assert.deepEqual((await replacement).body, Buffer.from("3"));
  await active;
  assert.deepEqual(calls, ["1", "3"]);
});

test("discards a completed fetch when its target rotates while upstream work is active", async () => {
  let revision = TARGET_A;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const cache = createMediaArtworkCache({
    revisionFor: () => revision,
    fetchSource: async () => {
      fetches += 1;
      await gate;
      return image(`target-${fetches}`);
    }
  });
  const stale = cache.get(descriptor(RADARR));
  await new Promise((resolve) => setImmediate(resolve));
  revision = TARGET_B;
  release();
  assert.equal(await stale, null);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });

  const current = descriptor({ ...RADARR, targetRevision: TARGET_B });
  const freshCache = createMediaArtworkCache({
    revisionFor: () => TARGET_B,
    fetchSource: async () => image("new-target")
  });
  assert.deepEqual((await freshCache.get(current)).body, Buffer.from("new-target"));
});

test("bounds artwork fetch concurrency and sheds work beyond its pending queue", async () => {
  let active = 0;
  let maximumActive = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createMediaArtworkCache({
    maxConcurrentFetches: 2,
    maxPendingFetches: 2,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return image(`poster-${source.resource}`);
    }
  });
  const requests = [1, 2, 3, 4].map((resource) => cache.get(descriptor({
    service: "radarr",
    kind: "poster",
    resource: String(resource),
    variant: "poster-250"
  })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(maximumActive, 2);

  const overflow = await cache.get(descriptor({
    service: "radarr", kind: "poster", resource: "5", variant: "poster-250"
  }));
  assert.equal(overflow, null, "queue overflow is retryable and is not exposed as an unhandled failure");
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });

  release();
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result?.contentType === "image/png"));
  assert.equal(maximumActive, 2);
  assert.deepEqual(cache.stats(), {
    entries: 4,
    bytes: [1, 2, 3, 4].reduce((sum, resource) => sum + Buffer.byteLength(`poster-${resource}`), 0)
  });
  assert.equal(MEDIA_ARTWORK_LIMITS.defaultMaximumConcurrentFetches, 3);
  assert.equal(MEDIA_ARTWORK_LIMITS.defaultMaximumPendingFetches, 64);
});

test("queues fallback artwork ahead of waiting primary sources", async () => {
  const started = [];
  let releaseBlockers;
  const blockers = new Promise((resolve) => { releaseBlockers = resolve; });
  const cache = createMediaArtworkCache({
    maxConcurrentFetches: 2,
    maxPendingFetches: 8,
    revisionFor: (source) => source.service === "jellyfin" ? TARGET_B : source.targetRevision,
    fetchSource: async (source) => {
      started.push(`${source.service}:${source.resource}`);
      if (source.resource === "1" || source.resource === "2") await blockers;
      return image(`${source.service}:${source.resource}`);
    }
  });
  const blockerOne = cache.get(descriptor({ ...RADARR, resource: "1" }));
  const blockerTwo = cache.get(descriptor({ ...RADARR, resource: "2" }));
  const normalThree = cache.get(descriptor({ ...RADARR, resource: "3" }));
  const normalFour = cache.get(descriptor({ ...RADARR, resource: "4" }));
  await new Promise((resolve) => setImmediate(resolve));

  const fallback = cache.get(descriptor(JELLYFIN, SEERR));
  await new Promise((resolve) => setImmediate(resolve));
  releaseBlockers();
  await Promise.all([blockerOne, blockerTwo, normalThree, normalFour, fallback]);
  const fallbackIndex = started.indexOf(`seerr:${SEERR.resource}`);
  assert.ok(fallbackIndex >= 0);
  assert.ok(fallbackIndex < started.indexOf("radarr:3"));
  assert.ok(fallbackIndex < started.indexOf("radarr:4"));
});

test("closing the cache rejects queued artwork and prevents active work from repopulating it", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createMediaArtworkCache({
    maxConcurrentFetches: 1,
    maxPendingFetches: 1,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => {
      await gate;
      return image("late-artwork");
    }
  });
  const active = cache.get(descriptor(RADARR));
  const queued = cache.get(descriptor(SONARR));
  await new Promise((resolve) => setImmediate(resolve));
  cache.close();

  assert.equal(await queued, null);
  release();
  assert.equal(await active, null);
  assert.equal(await cache.get(descriptor(SEERR)), null);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test("rejects non-images, unsafe MIME types, empty bodies, and oversized artwork before fallback", async () => {
  const oversized = Buffer.alloc(MEDIA_ARTWORK_LIMITS.maximumArtworkBytes + 1, 1);
  const cases = [
    { response: image("html", "text/html"), label: "HTML" },
    { response: image("svg", "image/svg+xml"), label: "SVG" },
    { response: image(Buffer.alloc(0), "image/png"), label: "empty image" },
    { response: image(oversized, "image/jpeg"), label: "oversized image" },
    { response: image("error", "image/png", 500), label: "non-success status" },
    { response: { status: 200, contentType: "image/png", body: "not-a-buffer" }, label: "non-buffer body" }
  ];

  for (const { response, label } of cases) {
    const calls = [];
    const cache = createMediaArtworkCache({
      revisionFor: (source) => source.targetRevision,
      fetchSource: async (source) => {
        calls.push(source.service);
        return source.service === "jellyfin" ? response : image("safe-fallback", "image/webp");
      }
    });
    const result = await cache.get(descriptor(JELLYFIN, RADARR));
    assert.equal(result.source, "radarr", label);
    assert.deepEqual(result.body, Buffer.from("safe-fallback"), label);
    assert.deepEqual(calls, ["jellyfin", "radarr"], label);
  }
});

test("enforces LRU entry and byte budgets", async () => {
  let fetches = 0;
  const countCache = createMediaArtworkCache({
    maxEntries: 2,
    maxBytes: MEDIA_ARTWORK_LIMITS.maximumArtworkBytes,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async (source) => image(`${source.resource}:${++fetches}`)
  });
  const first = descriptor({ service: "radarr", kind: "poster", resource: "1", variant: "poster-250" });
  const second = descriptor({ service: "radarr", kind: "poster", resource: "2", variant: "poster-250" });
  const third = descriptor({ service: "radarr", kind: "poster", resource: "3", variant: "poster-250" });

  await countCache.get(first);
  await countCache.get(second);
  await countCache.get(first); // Touch the first entry, making the second LRU.
  await countCache.get(third);
  assert.deepEqual(countCache.stats(), { entries: 2, bytes: Buffer.byteLength("1:1") + Buffer.byteLength("3:3") });
  await countCache.get(second);
  assert.equal(fetches, 4, "the least-recently-used count entry was evicted");
  assert.equal(countCache.stats().entries, 2);

  const largeBytes = 3 * 1024 * 1024;
  let largeFetches = 0;
  const byteCache = createMediaArtworkCache({
    maxEntries: 10,
    maxBytes: MEDIA_ARTWORK_LIMITS.maximumArtworkBytes,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => image(Buffer.alloc(largeBytes, ++largeFetches))
  });
  await byteCache.get(first);
  assert.deepEqual(byteCache.stats(), { entries: 1, bytes: largeBytes });
  await byteCache.get(second);
  assert.deepEqual(byteCache.stats(), { entries: 1, bytes: largeBytes });
  await byteCache.get(first);
  assert.equal(largeFetches, 3, "the byte budget evicts the older large image");
  assert.deepEqual(byteCache.stats(), { entries: 1, bytes: largeBytes });
});

test("strips caller-supplied URLs, paths, and credentials before invoking the loader", async () => {
  const leaked = "credential-that-must-not-cross-the-artwork-boundary";
  const calls = [];
  const fetchLifetime = new AbortController();
  const cache = createMediaArtworkCache({
    revisionFor: (source) => {
      calls.push({ phase: "revision", source });
      return source.targetRevision;
    },
    fetchSource: async (source, options) => {
      calls.push({ phase: "fetch", source, options });
      return image("trusted-image");
    },
    fetchSignal: fetchLifetime.signal
  });
  const untrustedDescriptor = {
    version: 4,
    url: `https://evil.test/${leaked}`,
    credential: leaked,
    sources: [{
      ...JELLYFIN,
      url: `https://evil.test/${leaked}`,
      path: `/arbitrary/${leaked}`,
      apiKey: leaked,
      authorization: `Bearer ${leaked}`
    }]
  };

  const requestLifetime = new AbortController();
  const result = await cache.get(untrustedDescriptor, { signal: requestLifetime.signal });
  assert.deepEqual(result.body, Buffer.from("trusted-image"));
  assert.equal(calls.length, 3, "the target binding is checked before and after the fetch");
  for (const call of calls) {
    assert.deepEqual(call.source, JELLYFIN);
    assert.deepEqual(Object.keys(call.source), ["service", "kind", "resource", "revision", "variant", "targetRevision"]);
    assert.equal(JSON.stringify(call).includes(leaked), false);
    assert.equal(JSON.stringify(call).includes("evil.test"), false);
  }
  assert.equal(calls[1].options.path, "/Items/jf_item-42/Images/Primary?maxWidth=342&quality=85&tag=jf-tag_123");
  assert.equal(calls[1].options.targetRevision, TARGET_A);
  assert.equal(calls[1].options.signal instanceof AbortSignal, true);
  assert.notEqual(calls[1].options.signal, requestLifetime.signal, "a caller cannot directly cancel shared upstream work");

  assert.equal(await cache.get({ sources: [{ url: "https://evil.test/raw.jpg", credential: leaked }] }), null);
});

test("validates construction, cache controls, and clock failures", async () => {
  assert.throws(() => createMediaArtworkCache(), /source loader/u);

  const cache = createMediaArtworkCache({
    clock: () => Number.NaN,
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => image("unused")
  });
  await assert.rejects(cache.get(descriptor(SEERR)), /invalid time/u);

  const usable = createMediaArtworkCache({
    revisionFor: (source) => source.targetRevision,
    fetchSource: async () => image("image")
  });
  await usable.get(descriptor(SEERR));
  assert.equal(Object.isFrozen(usable.stats()), true);
  assert.deepEqual(usable.stats(), { entries: 1, bytes: 5 });
  usable.clear();
  assert.deepEqual(usable.stats(), { entries: 0, bytes: 0 });
});
