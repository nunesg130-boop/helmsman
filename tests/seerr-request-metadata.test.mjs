import assert from "node:assert/strict";
import test from "node:test";
import { inventoryFromProbeBody } from "../server/media-model.mjs";
import { createSeerrRequestMetadataEnricher } from "../server/seerr-request-metadata.mjs";

const REVISION_A = "11111111-1111-4111-8111-111111111111";
const REVISION_B = "22222222-2222-4222-8222-222222222222";

function request(id, mediaType, tmdbId, additions = {}) {
  return {
    id,
    status: 2,
    media: { mediaType, tmdbId, status: 3, ...additions }
  };
}

test("enriches unique movie and series requests with normalized Seerr detail metadata", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    fetchDetail: async (candidate, context) => {
      calls.push({ ...candidate, targetRevision: context.targetRevision, timeoutMs: context.timeoutMs });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return candidate.mediaType === "movie"
        ? { id: 101, title: "Signal", releaseDate: "2026-07-10", posterPath: "/signal.jpg" }
        : { id: 202, name: "Beacon", firstAirDate: "2025-01-02", posterPath: "/beacon.webp" };
    }
  });
  const input = {
    pageInfo: { pages: 1 },
    results: [
      request(1, "movie", 101),
      request(2, "movie", 101),
      request(3, "tv", 202)
    ]
  };

  const enriched = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(enriched.pageInfo, { pages: 1 }, "the Seerr response envelope must be retained");
  assert.equal(calls.length, 2, "duplicate TMDb identities must share one lookup");
  assert.equal(maximumActive, 2);
  assert.ok(calls.every(({ targetRevision }) => targetRevision === REVISION_A));
  assert.ok(calls.every(({ timeoutMs }) => timeoutMs === 8_000));

  const inventory = inventoryFromProbeBody("seerr", "requests", enriched).requests;
  assert.deepEqual(inventory.map(({ title }) => title), ["Signal", "Signal", "Beacon"]);
  assert.deepEqual(inventory.map(({ year }) => year), [2026, 2026, 2025]);
  assert.deepEqual(inventory.map(({ artwork }) => artwork?.resource), ["signal.jpg", "signal.jpg", "beacon.webp"]);
  enricher.close();
});

test("bounds new lookups per cycle while cached results let later requests make progress", async () => {
  const calls = [];
  const enricher = createSeerrRequestMetadataEnricher({
    maximumLookupsPerCycle: 3,
    maximumConcurrency: 2,
    fetchDetail: async ({ tmdbId }) => {
      calls.push(tmdbId);
      return { id: tmdbId, title: `Title ${tmdbId}`, posterPath: `/poster-${tmdbId}.jpg` };
    }
  });
  const input = {
    results: Array.from({ length: 10 }, (_, index) => request(index + 1, "movie", index + 1))
  };

  const first = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(first.results.slice(0, 4).map(({ media }) => media.title || null), [
    "Title 1", "Title 2", "Title 3", null
  ]);

  const second = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(second.results.slice(0, 7).map(({ media }) => media.title || null), [
    "Title 1", "Title 2", "Title 3", "Title 4", "Title 5", "Title 6", null
  ]);
  enricher.close();
});

test("keys positive and negative cache entries by target revision and expires failures", async () => {
  let clock = 10_000;
  let calls = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    now: () => clock,
    negativeTtlMs: 1_000,
    fetchDetail: async ({ tmdbId }) => {
      calls += 1;
      if (calls === 1) return { id: tmdbId + 1, title: "Wrong record" };
      return { id: tmdbId, title: "Recovered", posterPath: "/recovered.png" };
    }
  });
  const input = { results: [request(1, "movie", 77)] };

  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  assert.equal(calls, 1);
  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  assert.equal(calls, 1, "invalid details should be negatively cached briefly");

  clock += 1_001;
  const recovered = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(recovered.results[0].media.title, "Recovered");
  assert.equal(calls, 2);

  const changedTarget = await enricher.enrich(input, { targetRevision: REVISION_B });
  assert.equal(changedTarget.results[0].media.title, "Recovered");
  assert.equal(calls, 3, "metadata from a previous target revision must never be reused");
  enricher.close();
});

test("does not negative-cache transient metadata transport failures", async () => {
  let calls = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    fetchDetail: async ({ tmdbId }) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("broker busy"), { code: "BROKER_BUSY" });
      return { id: tmdbId, title: "Recovered immediately", posterPath: "/recovered.jpg" };
    }
  });
  const input = { results: [request(1, "movie", 88)] };

  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  const recovered = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(recovered.results[0].media.title, "Recovered immediately");
  assert.equal(calls, 2);
  enricher.close();
});

test("refreshes partial metadata sooner so artwork for future releases can appear", async () => {
  let clock = 20_000;
  let calls = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    now: () => clock,
    partialTtlMs: 1_000,
    fetchDetail: async ({ tmdbId }) => {
      calls += 1;
      return calls === 1
        ? { id: tmdbId, title: "Future Film", releaseDate: "2028-01-01", posterPath: null }
        : { id: tmdbId, title: "Future Film", releaseDate: "2028-01-01", posterPath: "/future-film.jpg" };
    }
  });
  const input = { results: [request(1, "movie", 99)] };

  const partial = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(partial.results[0].media.title, "Future Film");
  assert.equal(Object.hasOwn(partial.results[0].media, "posterPath"), false);
  await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(calls, 1);

  clock += 1_001;
  const completed = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(completed.results[0].media.posterPath, "/future-film.jpg");
  assert.equal(calls, 2);
  enricher.close();
});

test("treats metadata without a release year as partial cache data", async () => {
  let clock = 30_000;
  let calls = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    now: () => clock,
    partialTtlMs: 1_000,
    fetchDetail: async ({ tmdbId }) => {
      calls += 1;
      return calls === 1
        ? { id: tmdbId, title: "Undated Film", posterPath: "/undated-film.jpg" }
        : { id: tmdbId, title: "Undated Film", releaseDate: "2029-06-15", posterPath: "/undated-film.jpg" };
    }
  });
  const input = { results: [request(1, "movie", 100)] };

  const partial = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(partial.results[0].media.title, "Undated Film");
  assert.equal(partial.results[0].media.posterPath, "/undated-film.jpg");
  assert.equal(Object.hasOwn(partial.results[0].media, "year"), false);
  await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(calls, 1);

  clock += 1_001;
  const completed = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(completed.results[0].media.year, 2029);
  assert.equal(calls, 2, "a missing year must use the partial TTL instead of the full positive TTL");
  enricher.close();
});

test("never fetches untyped IDs and rejects unsafe poster paths without replacing supplied fields", async () => {
  const calls = [];
  const enricher = createSeerrRequestMetadataEnricher({
    fetchDetail: async (candidate) => {
      calls.push(candidate);
      return {
        id: candidate.tmdbId,
        title: "<Remote\u0000 Title>",
        releaseDate: "2027-03-01",
        posterPath: "https://attacker.invalid/poster.jpg"
      };
    }
  });
  const input = {
    results: [
      request(1, "movie", 9, { title: "Keep me", posterPath: "/safe.jpg", year: 2020 }),
      request(2, "podcast", 10),
      request(3, "movie", "10/../../admin"),
      request(4, "movie", 11)
    ]
  };

  const enriched = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(calls.map(({ mediaType, tmdbId }) => [mediaType, tmdbId]), [["movie", 11]]);
  assert.equal(enriched.results[0].media.title, "Keep me");
  assert.equal(enriched.results[0].media.posterPath, "/safe.jpg");
  assert.equal(enriched.results[3].media.title, "‹Remote Title›");
  assert.equal(enriched.results[3].media.year, 2027);
  assert.equal(Object.hasOwn(enriched.results[3].media, "posterPath"), false);
  enricher.close();
});

test("accepts only canonical positive-integer TMDb IDs", async () => {
  const calls = [];
  const enricher = createSeerrRequestMetadataEnricher({
    fetchDetail: async ({ tmdbId }) => {
      calls.push(tmdbId);
      return { id: tmdbId, title: `Title ${tmdbId}`, releaseDate: "2026-01-01", posterPath: `/poster-${tmdbId}.jpg` };
    }
  });
  const invalidIds = [true, [12], "0x10", "1e2", "0012"];
  const input = {
    results: [
      ...invalidIds.map((tmdbId, index) => request(index + 1, "movie", tmdbId)),
      request(10, "movie", 77),
      request(11, "movie", "78")
    ]
  };

  const enriched = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(calls, [77, 78]);
  assert.ok(enriched.results.slice(0, invalidIds.length).every(({ media }) => !Object.hasOwn(media, "title")));
  assert.deepEqual(enriched.results.slice(-2).map(({ media }) => media.title), ["Title 77", "Title 78"]);
  enricher.close();
});

test("preserves request rows beyond the bounded enrichment window", async () => {
  const calls = [];
  const enricher = createSeerrRequestMetadataEnricher({
    maximumLookupsPerCycle: 200,
    maximumConcurrency: 4,
    fetchDetail: async ({ tmdbId }) => {
      calls.push(tmdbId);
      return {
        id: tmdbId,
        title: `Title ${tmdbId}`,
        releaseDate: "2026-01-01",
        posterPath: `/poster-${tmdbId}.jpg`
      };
    }
  });
  const input = {
    pageInfo: { results: 205 },
    results: Array.from({ length: 205 }, (_, index) => request(index + 1, "movie", index + 1))
  };

  const enriched = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(enriched.results.length, 205);
  assert.deepEqual(enriched.pageInfo, input.pageInfo);
  assert.equal(calls.length, 200);
  assert.deepEqual(calls, Array.from({ length: 200 }, (_, index) => index + 1));
  assert.equal(enriched.results[0].media.title, "Title 1");
  assert.equal(enriched.results[199].media.title, "Title 200");
  assert.strictEqual(enriched.results[200], input.results[200]);
  assert.strictEqual(enriched.results[204], input.results[204]);
  enricher.close();
});

test("aborting a presentation cycle leaves shared metadata work available to the next cycle", async () => {
  let calls = 0;
  const started = [];
  let finish;
  const enricher = createSeerrRequestMetadataEnricher({
    fetchDetail: async ({ tmdbId }) => {
      calls += 1;
      started.push(tmdbId);
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  const input = { results: [request(1, "movie", 55)] };
  const controller = new AbortController();
  const pending = enricher.enrich(input, { targetRevision: REVISION_A, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  assert.equal(await pending, input);
  assert.deepEqual(started, [55]);

  finish({ id: 55, title: "Background result", posterPath: "/background.jpg" });
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(recovered.results[0].media.title, "Background result");
  assert.equal(calls, 1, "a cancelled presentation waiter must not duplicate shared upstream work");
  enricher.close();
});

test("a presentation deadline does not cancel valid slow metadata", async () => {
  let calls = 0;
  let finish;
  const enricher = createSeerrRequestMetadataEnricher({
    deadlineMs: 250,
    requestTimeoutMs: 1_000,
    fetchDetail: async () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  const input = { results: [request(1, "tv", 45_140)] };

  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  finish({ id: 45_140, name: "The Slow Series", firstAirDate: "2026-01-02", posterPath: "/slow-series.jpg" });
  await new Promise((resolve) => setImmediate(resolve));

  const hydrated = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.equal(hydrated.results[0].media.title, "The Slow Series");
  assert.equal(hydrated.results[0].media.posterPath, "/slow-series.jpg");
  assert.equal(calls, 1);
  enricher.close();
});

test("slow requests cannot starve later metadata in the same fair background batch", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    maximumLookupsPerCycle: 4,
    maximumConcurrency: 2,
    deadlineMs: 500,
    requestTimeoutMs: 250,
    fetchDetail: async ({ tmdbId }, { signal }) => {
      calls.push(tmdbId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (tmdbId <= 2) {
        return new Promise((resolve) => signal.addEventListener("abort", () => {
          active -= 1;
          resolve(null);
        }, { once: true }));
      }
      active -= 1;
      return { id: tmdbId, title: `Title ${tmdbId}`, posterPath: `/poster-${tmdbId}.jpg` };
    }
  });
  const input = { results: Array.from({ length: 4 }, (_, index) => request(index + 1, "movie", index + 1)) };

  const enriched = await enricher.enrich(input, { targetRevision: REVISION_A });
  assert.deepEqual(calls, [1, 2, 3, 4]);
  assert.equal(maximumActive, 2);
  assert.equal(enriched.results[2].media.title, "Title 3");
  assert.equal(enriched.results[3].media.title, "Title 4");
  enricher.close();
});

test("a deadline does not duplicate a never-settling lookup in the next cycle", async () => {
  let calls = 0;
  const enricher = createSeerrRequestMetadataEnricher({
    deadlineMs: 250,
    fetchDetail: async () => {
      calls += 1;
      return new Promise(() => {});
    }
  });
  const input = { results: [request(1, "movie", 66)] };

  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  assert.equal(await enricher.enrich(input, { targetRevision: REVISION_A }), input);
  assert.equal(calls, 1, "an unresolved timed-out lookup must stay deduplicated across cycles");
  enricher.close();
});
