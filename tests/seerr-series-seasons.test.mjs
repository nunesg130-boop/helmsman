import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSeerrSeriesSeasons } from "../server/seerr-series-seasons.mjs";

const TARGET_REVISION = "11111111-1111-4111-8111-111111111111";

function detail() {
  return {
    id: 1396,
    name: "Example",
    secretServer: { rootFolder: "/private/media", apiKey: "must-not-leak" },
    seasons: [
      { seasonNumber: 10, name: "Future", episodeCount: 8, airDate: "2027-01-01" },
      { seasonNumber: 0, name: "Specials", episodeCount: 4, airDate: "2020-01-01" },
      { seasonNumber: 1, name: "One", episodeCount: 10, airDate: "2021-01-01" },
      { seasonNumber: 2, name: "Two", episodeCount: 10, airDate: "2022-01-01" },
      { seasonNumber: 3, name: "Three", episodeCount: 10, airDate: "2023-01-01" },
      { seasonNumber: 4, name: "Four", episodeCount: 10, airDate: "2024-01-01" },
      { seasonNumber: 5, name: "Five", episodeCount: 10, airDate: "2025-01-01" },
      { seasonNumber: 6, name: "Six", episodeCount: 10, airDate: "2026-01-01" },
      { seasonNumber: 7, name: "Seven", episodeCount: 10, airDate: "invalid" },
      { seasonNumber: 8, name: "Eight", episodeCount: 10, airDate: null },
      { seasonNumber: 9, name: "Nine", episodeCount: 0, airDate: null }
    ],
    mediaInfo: {
      seasons: [
        { seasonNumber: 2, status: 2 },
        { seasonNumber: 3, status: 3 },
        { seasonNumber: 4, status: 4 },
        { seasonNumber: 5, status: 5 },
        { seasonNumber: 6, status: 6 },
        { seasonNumber: 7, status: 7 },
        { seasonNumber: 8, status: 7 }
      ],
      requests: [
        { status: 4, is4k: false, requestedBy: { email: "secret@example.test" }, seasons: [{ seasonNumber: 7 }] },
        { status: 5, is4k: false, seasons: [{ seasonNumber: 8 }] },
        { status: 3, is4k: false, seasons: [{ seasonNumber: 10 }] },
        { status: 2, is4k: true, seasons: [{ seasonNumber: 1 }] }
      ]
    }
  };
}

test("Seerr TV details are reduced to bounded standard-quality season state", () => {
  const normalized = normalizeSeerrSeriesSeasons(detail(), { tmdbId: 1396, targetRevision: TARGET_REVISION });
  assert.ok(normalized);
  assert.match(normalized.detailRevision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(normalized), ["tmdbId", "targetRevision", "detailRevision", "seasons"]);
  assert.deepEqual(normalized.seasons.map((season) => season.seasonNumber), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(normalized.seasons[0].requestable, false, "Specials are display-only in the first version");
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 1).requestable, true, "4K requests do not block standard requests");
  for (const number of [2, 3, 4, 5, 6, 7, 9]) {
    assert.equal(normalized.seasons.find((season) => season.seasonNumber === number).requestable, false);
  }
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 7).requestState, "failed");
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 7).airDate, null);
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 8).requestable, true);
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 10).requestState, "declined");
  assert.equal(normalized.seasons.find((season) => season.seasonNumber === 10).requestable, true);
  assert.equal(JSON.stringify(normalized).includes("secret"), false);
  assert.equal(JSON.stringify(normalized).includes("rootFolder"), false);
});

test("detail revisions cover requestability state but ignore discarded upstream fields", () => {
  const first = detail();
  const second = detail();
  second.secretServer.apiKey = "different-secret";
  const baseline = normalizeSeerrSeriesSeasons(first, { tmdbId: 1396, targetRevision: TARGET_REVISION });
  const irrelevantChange = normalizeSeerrSeriesSeasons(second, { tmdbId: 1396, targetRevision: TARGET_REVISION });
  assert.equal(irrelevantChange.detailRevision, baseline.detailRevision);

  second.mediaInfo.seasons[0].status = 7;
  const relevantChange = normalizeSeerrSeriesSeasons(second, { tmdbId: 1396, targetRevision: TARGET_REVISION });
  assert.notEqual(relevantChange.detailRevision, baseline.detailRevision);
});

test("invalid identities and unbounded season collections are rejected or bounded", () => {
  assert.equal(normalizeSeerrSeriesSeasons(detail(), {
    tmdbId: 1397,
    targetRevision: TARGET_REVISION
  }), null);
  assert.equal(normalizeSeerrSeriesSeasons(detail(), {
    tmdbId: 1396,
    targetRevision: "not-a-revision"
  }), null);

  const oversized = detail();
  oversized.seasons = Array.from({ length: 400 }, (_, index) => ({
    seasonNumber: index,
    name: `Season ${index}`,
    episodeCount: 1
  }));
  const normalized = normalizeSeerrSeriesSeasons(oversized, {
    tmdbId: 1396,
    targetRevision: TARGET_REVISION
  });
  assert.equal(normalized.seasons.length, 256);
  assert.equal(normalized.seasons[0].seasonNumber, 0);
  assert.equal(normalized.seasons.at(-1).seasonNumber, 255);
});
