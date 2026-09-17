import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMediaSnapshot,
  inventoryFromProbeBody,
  MEDIA_SCHEMA,
  normalizeServiceMediaInventory
} from "../server/media-model.mjs";

const GENERATED_AT = "2026-09-13T12:00:00.000Z";
const HASH = "0123456789abcdef0123456789abcdef01234567";
const TARGETS = Object.freeze({
  jellyfin: "11111111-1111-4111-8111-111111111111",
  radarr: "22222222-2222-4222-8222-222222222222",
  sonarr: "33333333-3333-4333-8333-333333333333",
  seerr: "44444444-4444-4444-8444-444444444444"
});

function service(id, additions) {
  const inventory = {};
  for (const [checkId, body] of Object.entries(additions)) {
    const partial = inventoryFromProbeBody(id, checkId, body);
    for (const [key, values] of Object.entries(partial)) {
      if (!inventory[key]) inventory[key] = [];
      inventory[key].push(...values);
    }
  }
  return { id, inventory };
}

test("unifies media by provider identifiers and derives the full lifecycle", () => {
  const services = [
    service("seerr", {
      requests: {
        results: [{
          id: 71,
          status: 2,
          createdAt: "2026-09-10T10:00:00Z",
          media: { mediaType: "movie", tmdbId: 101, imdbId: "tt1234567", title: "Signal", posterPath: "/signal.jpg" }
        }]
      },
      trending: {
        results: [{ id: 101, mediaType: "movie", title: "Signal", posterPath: "/signal.jpg", releaseDate: "2026-09-20" }]
      }
    }),
    service("radarr", {
      catalog: [{
        id: 9,
        title: "Signal",
        year: 2026,
        tmdbId: 101,
        imdbId: "tt1234567",
        monitored: true,
        hasFile: true,
        added: "2026-09-12T10:00:00Z",
        images: [{ coverType: "poster", url: "/MediaCover/9/poster.jpg?lastWrite=638934912000000000" }]
      }],
      queue: {
        records: [{
          id: 501,
          movie: { id: 9, title: "Signal", year: 2026, tmdbId: 101, imdbId: "tt1234567" },
          downloadId: HASH.toUpperCase(),
          status: "downloading",
          size: 1000,
          sizeleft: 750,
          timeleft: "00:10:00"
        }]
      },
      calendar: [{ id: 9, title: "Signal", tmdbId: 101, digitalRelease: "2026-09-20T00:00:00Z" }]
    }),
    service("jellyfin", {
      library: {
        Items: [{
          Id: "abcdef0123456789abcdef0123456789",
          Type: "Movie",
          Name: "Signal",
          ProductionYear: 2026,
          ProviderIds: { Tmdb: "101", Imdb: "tt1234567" },
          ImageTags: { Primary: "0123456789abcdef0123456789abcdef" },
          DateCreated: "2026-09-12T11:00:00Z"
        }]
      },
      latest: [{
        Id: "abcdef0123456789abcdef0123456789",
        Type: "Movie",
        Name: "Signal",
        ProviderIds: { Tmdb: "101" },
        ImageTags: { Primary: "0123456789abcdef0123456789abcdef" },
        DateCreated: "2026-09-12T11:00:00Z"
      }]
    }),
    service("qbittorrent", {
      torrents: [{ hash: HASH, name: "Signal.2026", state: "downloading", progress: 0.4, dlspeed: 2048, eta: 320 }]
    }),
    service("bazarr", {
      wantedMovies: {
        total: 1,
        data: [{ id: 44, title: "Signal", tmdbId: 101, missing_subtitles: ["English", "Spanish"] }]
      }
    })
  ];

  const media = buildMediaSnapshot(services, GENERATED_AT, TARGETS);
  assert.equal(media.schema, MEDIA_SCHEMA);
  const signalRecords = media.records.filter(({ providerIds }) => providerIds.tmdb === 101);
  assert.equal(signalRecords.length, 1, "provider-ID aliases must collapse to one record");
  const signal = signalRecords[0];
  assert.deepEqual(signal.sources, ["jellyfin", "radarr", "seerr", "bazarr"]);
  assert.deepEqual(signal.actionTargets, [{ service: "radarr", resourceId: 9 }]);
  assert.equal(signal.lifecycle.stage, "available");
  assert.deepEqual(signal.lifecycle.steps.map(({ complete }) => complete), [true, true, true, true, true]);
  assert.match(signal.artworkUrl, /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u);

  const token = signal.artworkUrl.split("/").pop();
  assert.equal(media.artwork[token].version, 4);
  assert.deepEqual(media.artwork[token].sources, [
    {
      service: "jellyfin",
      kind: "primary",
      resource: "abcdef0123456789abcdef0123456789",
      revision: "0123456789abcdef0123456789abcdef",
      variant: "w342q85",
      targetRevision: TARGETS.jellyfin
    },
    {
      service: "radarr",
      kind: "poster",
      resource: "9",
      revision: "638934912000000000",
      variant: "poster-250",
      targetRevision: TARGETS.radarr
    },
    { service: "seerr", kind: "poster", resource: "signal.jpg", variant: "w342", targetRevision: TARGETS.seerr }
  ]);
  assert.equal(media.activity.length, 1);
  assert.equal(media.activity[0].queueId, 501);
  assert.deepEqual(media.activity[0].queueActionTarget, { service: "radarr", queueId: 501 });
  assert.equal(media.activity[0].downloadId, HASH);
  assert.equal(media.activity[0].progress, 40);
  assert.equal(media.activity[0].downloadSpeedBps, 2048);
  assert.equal(media.activity[0].etaSeconds, 320);
  assert.equal(media.requests[0].mediaId, signal.id);
  assert.deepEqual(media.requests[0].actionTargets, [{ service: "radarr", resourceId: 9 }]);
  assert.equal(media.calendar[0].mediaId, signal.id);
  assert.equal(media.subtitleBacklog[0].mediaId, signal.id);
  assert.equal(media.home.recentlyAdded[0].id, signal.id);
  assert.equal(media.metrics.libraryTotal, 1);
});

test("replaces an ID-only Seerr request label with the real same-service Discover title", () => {
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: [{
          id: 71,
          status: 2,
          createdAt: "2026-09-10T10:00:00Z",
          media: { mediaType: "movie", tmdbId: 1_108_427, status: 3 }
        }]
      },
      trending: {
        results: [{
          id: 1_108_427,
          mediaType: "movie",
          title: "Moana",
          overview: "An ocean voyage.",
          releaseDate: "2026-07-10"
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.records.length, 1);
  assert.equal(media.records[0].title, "Moana");
  assert.equal(media.discover[0].title, "Moana");
  assert.equal(media.requests[0].title, "Moana");
  assert.equal(media.requests[0].id, "seerr-request:71");
  assert.equal(media.requests[0].requestId, 71);
  assert.equal(media.requests[0].requestStatus, "approved");
  assert.equal(media.requests[0].mediaStatus, "processing");
  assert.equal(media.requests[0].requestFulfilled, false);
  assert.equal(media.requests[0].available, false);
  assert.doesNotMatch(JSON.stringify(media), /Movie 1108427/u);
});

test("keeps an unresolved Seerr request identifiable by its typed TMDb ID", () => {
  const body = {
    results: [{
      id: 72,
      type: "tv",
      status: 1,
      media: { mediaType: "tv", tmdbId: 91_872, status: 1 }
    }]
  };
  const inventory = inventoryFromProbeBody("seerr", "requests", body);

  assert.equal(inventory.requests[0].title, "Series · TMDb 91872");
  assert.equal(inventory.requests[0].titleFallback, true);
  assert.deepEqual(inventory.requests[0].providerIds, { tmdb: 91_872 });
  assert.deepEqual(inventory.requests[0].artworkFallback, {
    service: "seerr",
    kind: "tv-poster",
    resource: "91872",
    variant: "w342"
  });

  const media = buildMediaSnapshot([service("seerr", { requests: body })], GENERATED_AT, TARGETS);
  assert.match(media.requests[0].artworkUrl, /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u);
  const token = media.requests[0].artworkUrl.split("/").pop();
  assert.deepEqual(media.artwork[token].sources, [{
    service: "seerr",
    kind: "tv-poster",
    resource: "91872",
    variant: "w342",
    targetRevision: TARGETS.seerr
  }]);
});

test("counts only approval-pending Seerr requests in the pending summary", () => {
  const statuses = [
    { id: 201, title: "Awaiting Decision", requestStatus: 1, mediaStatus: 2 },
    { id: 202, title: "Processing Request", requestStatus: 2, mediaStatus: 3 },
    { id: 203, title: "Partially Acquired", requestStatus: 2, mediaStatus: 4 },
    { id: 204, title: "Completed Unknown", requestStatus: 5, mediaStatus: 1 },
    { id: 205, title: "Removed Request", requestStatus: 5, mediaStatus: 7 },
    { id: 206, title: "Failed Request", requestStatus: 4, mediaStatus: 1 },
    { id: 207, title: "Already Available", requestStatus: 1, mediaStatus: 5 }
  ];
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: statuses.map(({ id, title, requestStatus, mediaStatus }) => ({
          id,
          status: requestStatus,
          media: { mediaType: "movie", tmdbId: 20_000 + id, title, status: mediaStatus }
        }))
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.requests.length, statuses.length);
  assert.equal(media.metrics.pendingRequestTotal, 1);
  assert.deepEqual(media.home.pendingRequests.map(({ requestId, title }) => ({ requestId, title })), [
    { requestId: 201, title: "Awaiting Decision" }
  ]);
  assert.deepEqual(Object.fromEntries(media.requests.map(({ title, requestBucket }) => [title, requestBucket])), {
    "Already Available": "available",
    "Awaiting Decision": "pending",
    "Completed Unknown": "in_progress",
    "Failed Request": "attention",
    "Partially Acquired": "in_progress",
    "Processing Request": "in_progress",
    "Removed Request": "closed"
  });
  const removed = media.requests.find(({ requestId }) => requestId === 205);
  assert.equal(removed.requestStatus, "completed");
  assert.equal(removed.mediaStatus, "deleted");
  assert.equal(removed.requestFulfilled, false);
  assert.equal(removed.available, false);
});

test("keeps same-series requests distinct and scopes fulfillment to each Seerr request", () => {
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: [
          {
            id: 81,
            type: "tv",
            status: 2,
            is4k: true,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              status: 5,
              status4k: 3,
              seasons: [{ seasonNumber: 2, status: 5, status4k: 3 }]
            },
            seasons: [{ seasonNumber: 2, status: 5 }]
          },
          {
            id: 82,
            type: "tv",
            status: 5,
            is4k: false,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              status: 5,
              status4k: 3
            },
            // The real request-list query supplies request.seasons but commonly
            // omits media.seasons. Parent AVAILABLE remains authoritative.
            seasons: [{ seasonNumber: 1, status: 5 }]
          },
          {
            id: 83,
            type: "tv",
            status: 5,
            is4k: false,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              status: 3,
              seasons: [{ seasonNumber: 3, status: 3 }]
            },
            seasons: [{ seasonNumber: 3, status: 5 }]
          },
          {
            id: 84,
            type: "tv",
            status: 2,
            is4k: false,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              // Parent partial state may describe a different season. No
              // media-season availability row exists for Season 6.
              status: 4
            },
            seasons: [{ seasonNumber: 6, status: 2 }]
          },
          {
            id: 85,
            type: "tv",
            status: 5,
            is4k: false,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              status: 4,
              seasons: [
                { seasonNumber: 4, status: 5, status4k: 1 },
                { seasonNumber: 5, status: 4, status4k: 1 }
              ]
            },
            // These are request-workflow statuses, not availability statuses.
            seasons: [{ seasonNumber: 4, status: 5 }, { seasonNumber: 5, status: 5 }]
          },
          {
            id: 86,
            type: "tv",
            status: 2,
            is4k: false,
            media: {
              mediaType: "tv",
              tmdbId: 912,
              // Parent processing state is likewise not Season 7 evidence.
              status: 3
            },
            seasons: [{ seasonNumber: 7, status: 2 }]
          }
        ]
      }
    }),
    service("jellyfin", {
      library: {
        Items: [{
          Id: "abcdef0123456789abcdef0123456789",
          Type: "Series",
          Name: "Scoped Series",
          ProviderIds: { Tmdb: 912 }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.records.length, 1, "the title remains one provider-ID media record");
  assert.equal(media.records[0].available, true, "the series itself exists in Jellyfin");
  assert.equal(media.requests.length, 6, "separate request IDs must not collapse");
  assert.deepEqual(media.requests.map(({ id }) => id), ["seerr-request:81", "seerr-request:82", "seerr-request:83", "seerr-request:84", "seerr-request:85", "seerr-request:86"]);

  const seasonTwo4k = media.requests.find(({ requestId }) => requestId === 81);
  assert.equal(seasonTwo4k.title, "Scoped Series");
  assert.equal(seasonTwo4k.mediaStatus, "processing", "a 4K request uses status4k, not the standard status");
  assert.deepEqual(seasonTwo4k.requestedSeasons, [2]);
  assert.deepEqual(seasonTwo4k.seasonStatuses, [{ seasonNumber: 2, status: "processing" }]);
  assert.equal(seasonTwo4k.requestScope, "seasons");
  assert.equal(seasonTwo4k.requestCompleted, false);
  assert.equal(seasonTwo4k.requestFulfilled, false);
  assert.equal(seasonTwo4k.available, false, "older series content cannot fulfill a new season request");

  const completedStandard = media.requests.find(({ requestId }) => requestId === 82);
  assert.equal(completedStandard.requestStatus, "completed");
  assert.equal(completedStandard.mediaStatus, "available");
  assert.deepEqual(completedStandard.seasonStatuses, [{ seasonNumber: 1, status: "unknown" }]);
  assert.equal(completedStandard.requestCompleted, true);
  assert.equal(completedStandard.requestFulfilled, true);
  assert.equal(completedStandard.available, true, "Seerr's parent AVAILABLE state covers omitted media-season relations");
  assert.equal(completedStandard.imported, true);
  assert.equal(completedStandard.monitored, false);
  assert.equal(completedStandard.lifecycle.stage, "available");

  const completedButProcessing = media.requests.find(({ requestId }) => requestId === 83);
  assert.equal(completedButProcessing.requestStatus, "completed");
  assert.equal(completedButProcessing.mediaStatus, "processing");
  assert.deepEqual(completedButProcessing.seasonStatuses, [{ seasonNumber: 3, status: "processing" }]);
  assert.equal(completedButProcessing.requestCompleted, true);
  assert.equal(completedButProcessing.requestFulfilled, false, "completion alone is not availability evidence");
  assert.equal(completedButProcessing.available, false);

  const parentPartialOnly = media.requests.find(({ requestId }) => requestId === 84);
  assert.equal(parentPartialOnly.mediaStatus, "partially_available", "the source parent state remains visible for diagnostics");
  assert.deepEqual(parentPartialOnly.seasonStatuses, [{ seasonNumber: 6, status: "unknown" }]);
  assert.equal(parentPartialOnly.requestScope, "seasons");
  assert.equal(parentPartialOnly.partiallyAvailable, false, "title-wide partial state cannot prove a requested season is partially acquired");
  assert.equal(parentPartialOnly.available, false);
  assert.equal(parentPartialOnly.lifecycle.stage, "requested");

  const partiallyAvailable = media.requests.find(({ requestId }) => requestId === 85);
  assert.deepEqual(partiallyAvailable.requestedSeasons, [4, 5]);
  assert.deepEqual(partiallyAvailable.seasonStatuses, [
    { seasonNumber: 4, status: "available" },
    { seasonNumber: 5, status: "partially_available" }
  ]);
  assert.equal(partiallyAvailable.requestCompleted, true);
  assert.equal(partiallyAvailable.requestFulfilled, false, "completed SeasonRequest rows are not media availability proof");
  assert.equal(partiallyAvailable.partiallyAvailable, true);
  assert.equal(partiallyAvailable.available, false);

  const parentProcessingOnly = media.requests.find(({ requestId }) => requestId === 86);
  assert.equal(parentProcessingOnly.mediaStatus, "processing", "the source parent state remains visible for diagnostics");
  assert.deepEqual(parentProcessingOnly.seasonStatuses, [{ seasonNumber: 7, status: "unknown" }]);
  assert.equal(parentProcessingOnly.requestScope, "seasons");
  assert.equal(parentProcessingOnly.monitored, false, "title-wide lifecycle must not advance a requested season");
  assert.equal(parentProcessingOnly.downloading, false);
  assert.equal(parentProcessingOnly.lifecycle.stage, "requested");
});

test("does not apply an unrelated title-wide Sonarr queue entry to a season request", () => {
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: [{
          id: 87,
          type: "tv",
          status: 2,
          media: { mediaType: "tv", tmdbId: 917, status: 3 },
          seasons: [{ seasonNumber: 2, status: 2 }]
        }]
      }
    }),
    service("sonarr", {
      catalog: [{
        id: 17,
        title: "Scoped Queue",
        tmdbId: 917,
        monitored: true,
        statistics: { episodeCount: 20, episodeFileCount: 10 }
      }],
      queue: {
        records: [{
          id: 1701,
          series: { id: 17, title: "Scoped Queue", tmdbId: 917 },
          title: "Scoped.Queue.S09E01",
          downloadId: HASH,
          status: "downloading",
          size: 1_000,
          sizeleft: 500
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.records[0].monitored, true);
  assert.equal(media.records[0].downloading, true, "the title record retains real Sonarr activity");
  assert.deepEqual(media.requests[0].requestedSeasons, [2]);
  assert.equal(media.requests[0].monitored, false);
  assert.equal(media.requests[0].downloading, false, "season 9 activity cannot describe the season 2 request");
  assert.equal(media.requests[0].lifecycle.stage, "requested");
});

test("treats Seerr availability as media-server evidence without a separate Jellyfin catalog match", () => {
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: [{
          id: 84,
          status: 5,
          media: { mediaType: "movie", tmdbId: 914, title: "Already Scanned", status: 5 }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.requests[0].requestCompleted, true);
  assert.equal(media.requests[0].requestFulfilled, true);
  assert.equal(media.requests[0].imported, true);
  assert.equal(media.requests[0].available, true);
  assert.equal(media.requests[0].lifecycle.stage, "available");
  assert.deepEqual(media.requests[0].lifecycle.steps.map(({ complete }) => complete), [true, true, true, true, true]);
});

test("uses an exact Jellyfin movie match while Seerr availability sync is behind", () => {
  const media = buildMediaSnapshot([
    service("seerr", {
      requests: {
        results: [{
          id: 86,
          status: 5,
          media: { mediaType: "movie", tmdbId: 916, title: "Library Truth", status: 3 }
        }]
      }
    }),
    service("jellyfin", {
      library: {
        Items: [{
          Id: "abcdef0123456789abcdef0123456791",
          Type: "Movie",
          Name: "Library Truth",
          ProviderIds: { Tmdb: "916" }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  const request = media.requests[0];
  assert.equal(request.mediaStatus, "processing", "Seerr may briefly lag behind its Jellyfin scan");
  assert.equal(request.requestFulfilled, false, "the Seerr-specific fulfillment signal remains truthful");
  assert.equal(request.available, true, "the exact Jellyfin movie match is direct availability evidence");
  assert.equal(request.imported, true);
  assert.equal(request.lifecycle.stage, "available");
});

test("matches Jellyfin's TheMovieDb provider alias to Seerr and Radarr records", () => {
  const media = buildMediaSnapshot([
    service("seerr", { trending: { results: [{ id: 915, mediaType: "movie", title: "Alias Match" }] } }),
    service("radarr", { catalog: [{ id: 15, title: "Alias Match", tmdbId: 915, monitored: true }] }),
    service("jellyfin", {
      library: {
        Items: [{
          Id: "abcdef0123456789abcdef0123456790",
          Type: "Movie",
          Name: "Alias Match",
          ProviderIds: { TheMovieDb: "915" }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  const matches = media.records.filter(({ providerIds }) => providerIds.tmdb === 915);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].sources, ["jellyfin", "radarr", "seerr"]);
  assert.equal(matches[0].available, true);
});

test("normalizes Discover availability and rejects entries without a real title", () => {
  const inventory = inventoryFromProbeBody("seerr", "trending", {
    results: [
      { id: 201, mediaType: "movie", originalTitle: "Original Movie", mediaInfo: null },
      { id: 202, mediaType: "tv", originalName: "Original Series", mediaInfo: { status: 5 } },
      { id: 203, mediaType: "movie", mediaInfo: { status: 1 } },
      { id: 204, mediaType: "movie", title: "Blocked Movie", mediaInfo: { status: 6 } },
      { id: 205, mediaType: "movie", title: "Deleted Movie", mediaInfo: { status: 7 } }
    ]
  });

  assert.equal(inventory.discover.length, 4);
  assert.deepEqual(inventory.discover.map(({ title, mediaType, state, mediaStatus }) => ({
    title, mediaType, state, mediaStatus
  })), [
    { title: "Original Movie", mediaType: "movie", state: "not_requested", mediaStatus: "not_requested" },
    { title: "Original Series", mediaType: "series", state: "available", mediaStatus: "available" },
    { title: "Blocked Movie", mediaType: "movie", state: "blocklisted", mediaStatus: "blocklisted" },
    { title: "Deleted Movie", mediaType: "movie", state: "deleted", mediaStatus: "deleted" }
  ]);
  assert.doesNotMatch(JSON.stringify(inventory), /Movie 203/u);
});

test("deduplicates calendar resources while preserving distinct episodes and explicit state", () => {
  const firstEpisode = {
    id: 301,
    title: "Lights Out",
    tvdbId: 3_001,
    airDateUtc: "2026-09-14T01:00:00Z",
    seasonNumber: 2,
    episodeNumber: 1,
    hasFile: false,
    series: { id: 90, title: "Lights Out", tvdbId: 900, monitored: true }
  };
  const media = buildMediaSnapshot([
    service("sonarr", {
      calendar: [
        firstEpisode,
        { ...firstEpisode },
        {
          ...firstEpisode,
          id: 302,
          title: "Second Episode",
          tvdbId: 3_002,
          episodeNumber: 2,
          airDateUtc: "2026-09-15T01:00:00Z"
        }
      ]
    }),
    service("radarr", {
      calendar: [{
        id: 401,
        title: "Oceans Three",
        tmdbId: 4_001,
        digitalRelease: "2026-09-15T02:00:00Z",
        monitored: true,
        hasFile: false
      }]
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.calendar.length, 3);
  assert.deepEqual(media.calendar.map(({ id }) => id).sort(), [
    "radarr-calendar:401",
    "sonarr-calendar:301",
    "sonarr-calendar:302"
  ]);
  const episodeOne = media.calendar.find(({ id }) => id === "sonarr-calendar:301");
  const episodeTwo = media.calendar.find(({ id }) => id === "sonarr-calendar:302");
  assert.equal(episodeOne.mediaType, "episode");
  assert.equal(episodeOne.title, "Lights Out");
  assert.equal(episodeOne.episodeTitle, undefined, "a duplicate episode/series title is suppressed");
  assert.equal(episodeOne.state, "upcoming");
  assert.equal(episodeOne.monitored, true);
  assert.equal(episodeOne.lifecycle.stage, "monitored");
  assert.equal(episodeTwo.episodeTitle, "Second Episode");
  assert.ok(media.calendar.every(({ state }) => state !== "unknown"));
  const movie = media.calendar.find(({ id }) => id === "radarr-calendar:401");
  assert.equal(movie.seasonNumber, undefined);
  assert.equal(movie.episodeNumber, undefined);
});

test("never title-matches records without a shared provider identifier", () => {
  const media = buildMediaSnapshot([
    service("radarr", {
      catalog: [
        { id: 1, title: "Collision", tmdbId: 111, monitored: true },
        { id: 2, title: "Collision", tmdbId: 222, monitored: true }
      ]
    }),
    service("seerr", {
      trending: { results: [{ id: 333, mediaType: "movie", title: "Collision" }] }
    })
  ], GENERATED_AT, TARGETS);
  assert.deepEqual(
    media.records.filter(({ title }) => title === "Collision").map(({ providerIds }) => providerIds.tmdb).sort(),
    [111, 222, 333]
  );
});

test("a bridging identifier merges records transitively without using titles", () => {
  const media = buildMediaSnapshot([
    service("seerr", { trending: { results: [{ id: 77, mediaType: "series", name: "One Name" }] } }),
    service("sonarr", { catalog: [{ id: 7, title: "Another Name", tvdbId: 88, imdbId: "tt7654321", monitored: true }] }),
    service("jellyfin", {
      library: {
        Items: [{
          Id: "fedcba9876543210fedcba9876543210",
          Type: "Series",
          Name: "Canonical Name",
          ProviderIds: { Tmdb: 77, Tvdb: 88, Imdb: "tt7654321" }
        }]
      }
    })
  ], GENERATED_AT);
  const matches = media.records.filter(({ providerIds }) => providerIds.tmdb === 77 || providerIds.tvdb === 88);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].providerIds, { tmdb: 77, tvdb: 88, imdb: "tt7654321" });
  assert.equal(matches[0].title, "Canonical Name");
});

test("keeps Sonarr episodes distinct from each other and their parent series", () => {
  const sonarr = service("sonarr", {
    catalog: [{
      id: 90,
      title: "Shared Series",
      tvdbId: 900,
      tmdbId: 912,
      monitored: true,
      remotePoster: "https://artworks.thetvdb.com/banners/v4/series/900/posters/example.jpg",
      images: [{
        coverType: "poster",
        url: "/MediaCover/90/poster.jpg?lastWrite=638934912000000090",
        remoteUrl: "https://artworks.thetvdb.com/banners/v4/series/900/posters/example.jpg"
      }]
    }],
    calendar: [
      {
        id: 101,
        seriesId: 90,
        title: "Pilot",
        airDateUtc: "2026-09-14T01:00:00Z",
        seasonNumber: 1,
        episodeNumber: 1,
        series: {
          id: 90,
          title: "Shared Series",
          tvdbId: 900,
          images: [{
            coverType: "poster",
            url: "/MediaCover/90/poster.jpg?lastWrite=638934912000000090",
            remoteUrl: "https://artworks.thetvdb.com/banners/v4/series/900/posters/example.jpg"
          }]
        }
      },
      {
        id: 102,
        seriesId: 90,
        title: "Second",
        airDateUtc: "2026-09-21T01:00:00Z",
        seasonNumber: 1,
        episodeNumber: 2,
        series: { id: 90, title: "Shared Series", tvdbId: 900 }
      }
    ]
  });
  const media = buildMediaSnapshot([sonarr], GENERATED_AT, TARGETS);
  assert.equal(media.records.filter(({ mediaType }) => mediaType === "series").length, 1);
  const episodes = media.records.filter(({ mediaType }) => mediaType === "episode");
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map(({ id }) => id).sort(), ["sonarr:101", "sonarr:102"]);
  assert.equal(new Set(media.calendar.map(({ mediaId }) => mediaId)).size, 2);
  assert.ok(media.calendar.every(({ parentProviderIds }) => parentProviderIds.tvdb === 900));
  assert.ok(media.calendar.every(({ artworkUrl }) => typeof artworkUrl === "string"));
  assert.equal(media.library.some(({ mediaType }) => mediaType === "episode"), false, "calendar episodes are not library titles");
  for (const item of media.calendar) {
    const descriptor = media.artwork[item.artworkUrl.split("/").pop()];
    assert.equal(descriptor.sources[0].resource, "90", "a Sonarr cover must retain the parent series ID");
    assert.equal(descriptor.sources[0].revision, "638934912000000090");
    assert.deepEqual(descriptor.sources[1], {
      service: "seerr",
      kind: "tv-poster",
      resource: "912",
      variant: "w342",
      targetRevision: TARGETS.seerr
    }, "the parent series' TMDb ID creates a typed Seerr fallback when Sonarr's local cache is cold");
  }
  assert.doesNotMatch(JSON.stringify(media), /artworks\.thetvdb\.com/u, "Sonarr's remote TVDB URL must never cross the normalized boundary");
});

test("publishes bounded Seerr season request targets for series and episode-derived views", () => {
  const jellyfinSeriesId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const media = buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: jellyfinSeriesId,
          Type: "Series",
          Name: "Jellyfin Series",
          ProviderIds: { Tmdb: "700", Tvdb: "7_000" }
        }]
      },
      resume: {
        Items: [{
          Id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          Type: "Episode",
          Name: "Resume Episode",
          SeriesName: "Jellyfin Series",
          SeriesId: jellyfinSeriesId,
          ProviderIds: { Tmdb: "999" },
          UserData: { PlayedPercentage: 25 }
        }]
      },
      sessions: [{
        NowPlayingItem: {
          Id: "cccccccccccccccccccccccccccccccc",
          Type: "Episode",
          Name: "Playing Episode",
          SeriesName: "Jellyfin Series",
          SeriesId: jellyfinSeriesId,
          ProviderIds: { Tmdb: "998" },
          RunTimeTicks: 1_000
        },
        PlayState: { PositionTicks: 500, IsPaused: false }
      }]
    }),
    service("sonarr", {
      catalog: [{
        id: 90,
        title: "Sonarr Series",
        tmdbId: 912,
        tvdbId: 900,
        monitored: true
      }, {
        id: 91,
        title: "TVDB-only Series",
        tvdbId: 901,
        monitored: true
      }, {
        id: 92,
        title: "Out-of-range Series",
        tmdbId: 10_000_000_000,
        monitored: true
      }, {
        id: 93,
        title: "Malformed Provider Series",
        tmdbId: true,
        monitored: true
      }],
      calendar: [{
        id: 101,
        title: "Sonarr Episode",
        tmdbId: 9_120,
        airDateUtc: "2026-09-14T01:00:00Z",
        seasonNumber: 2,
        episodeNumber: 1,
        series: { id: 90, title: "Sonarr Series", tmdbId: 912, tvdbId: 900 }
      }, {
        id: 102,
        title: "Episode ID Is Not A Series ID",
        tmdbId: 9_121,
        airDateUtc: "2026-09-15T01:00:00Z",
        seasonNumber: 1,
        episodeNumber: 1,
        series: { id: 91, title: "TVDB-only Series", tvdbId: 901 }
      }]
    }),
    service("seerr", {
      trending: {
        results: [{ id: 313, mediaType: "tv", name: "Discover Series" }]
      }
    }),
    service("radarr", {
      catalog: [{ id: 1, title: "Movie", tmdbId: 314, monitored: true }]
    })
  ], GENERATED_AT, TARGETS);

  const expected = (resourceId) => ({ service: "seerr", resourceId });
  assert.deepEqual(
    media.records.find(({ providerIds }) => providerIds.tmdb === 700)?.seasonRequestTarget,
    expected(700),
    "a canonical series publishes its validated TMDb request target"
  );
  assert.deepEqual(
    media.records.find(({ providerIds }) => providerIds.tmdb === 912)?.seasonRequestTarget,
    expected(912)
  );
  assert.deepEqual(
    media.discover.find(({ providerIds }) => providerIds.tmdb === 313)?.seasonRequestTarget,
    expected(313),
    "a Seerr-only series uses the same bounded target contract"
  );
  assert.equal(
    Object.hasOwn(media.records.find(({ title }) => title === "Out-of-range Series"), "seasonRequestTarget"),
    false,
    "out-of-range provider IDs must not cross the normalized boundary"
  );
  assert.equal(
    Object.hasOwn(media.records.find(({ title }) => title === "Malformed Provider Series"), "seasonRequestTarget"),
    false,
    "coercible non-ID values must not become a request target"
  );
  assert.equal(
    Object.hasOwn(media.records.find(({ title }) => title === "Movie"), "seasonRequestTarget"),
    false,
    "movies never expose a season request target"
  );

  const sonarrEpisode = media.calendar.find(({ id }) => id === "sonarr-calendar:101");
  const tvdbOnlyEpisode = media.calendar.find(({ id }) => id === "sonarr-calendar:102");
  assert.deepEqual(sonarrEpisode.seasonRequestTarget, expected(912));
  assert.notEqual(sonarrEpisode.seasonRequestTarget.resourceId, 9_120, "an episode TMDb ID is never used as the series target");
  assert.equal(Object.hasOwn(tvdbOnlyEpisode, "seasonRequestTarget"), false);

  assert.deepEqual(media.home.continueWatching[0].seasonRequestTarget, expected(700));
  assert.notEqual(media.home.continueWatching[0].seasonRequestTarget.resourceId, 999);
  assert.deepEqual(media.home.nowPlaying[0].seasonRequestTarget, expected(700));
  assert.notEqual(media.home.nowPlaying[0].seasonRequestTarget.resourceId, 998);
  assert.equal(Object.hasOwn(media.home.continueWatching[0], "seriesSourceId"), false);
  assert.equal(Object.hasOwn(media.home.nowPlaying[0], "seriesSourceId"), false);
});

test("publishes canonical Continue Watching episode targets only from a resolved Jellyfin parent series", () => {
  const firstSeriesId = "11111111111111111111111111111111";
  const inheritedSeriesId = "22222222222222222222222222222222";
  const unknownSeriesId = "33333333333333333333333333333333";
  const media = buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: firstSeriesId,
          Type: "Series",
          Name: "SeriesId Parent",
          ProviderIds: { Tmdb: "700" }
        }, {
          Id: inheritedSeriesId,
          Type: "Series",
          Name: "Inherited Artwork Parent",
          ProviderIds: { Tmdb: "701" }
        }]
      },
      resume: {
        Items: [{
          Id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          Type: "Episode",
          Name: "SeriesId Episode",
          SeriesName: "SeriesId Parent",
          SeriesId: firstSeriesId,
          ProviderIds: { Tmdb: "9001", Tvdb: "8001" },
          UserData: { PlayedPercentage: 10 }
        }, {
          Id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          Type: "Episode",
          Name: "Inherited Artwork Episode",
          SeriesName: "Inherited Artwork Parent",
          ParentPrimaryImageItemId: inheritedSeriesId,
          ParentPrimaryImageTag: "inherited_parent_tag",
          ProviderIds: { Tmdb: "9002", Tvdb: "8002" },
          UserData: { PlayedPercentage: 20 }
        }, {
          Id: "cccccccccccccccccccccccccccccccc",
          Type: "Episode",
          Name: "Unresolved Parent Episode",
          SeriesName: "Unknown Parent",
          ParentPrimaryImageItemId: unknownSeriesId,
          ParentPrimaryImageTag: "unknown_parent_tag",
          ProviderIds: { Tmdb: "9003", Tvdb: "8003" },
          UserData: { PlayedPercentage: 30 }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  const expected = (resourceId) => ({ service: "seerr", resourceId });
  const canonicalEpisode = (tmdbId) => media.records.find((item) => (
    item.mediaType === "episode" && item.providerIds.tmdb === tmdbId
  ));
  const continueEpisode = (tmdbId) => media.home.continueWatching.find((item) => item.providerIds.tmdb === tmdbId);

  assert.deepEqual(canonicalEpisode(9_001)?.seasonRequestTarget, expected(700));
  assert.deepEqual(continueEpisode(9_001)?.seasonRequestTarget, expected(700));
  assert.deepEqual(
    canonicalEpisode(9_002)?.seasonRequestTarget,
    expected(701),
    "a validated inherited primary-image resource may identify an existing Jellyfin series"
  );
  assert.deepEqual(continueEpisode(9_002)?.seasonRequestTarget, expected(701));
  assert.equal(Object.hasOwn(canonicalEpisode(9_003), "seasonRequestTarget"), false);
  assert.equal(Object.hasOwn(continueEpisode(9_003), "seasonRequestTarget"), false);
  assert.notEqual(canonicalEpisode(9_003)?.seasonRequestTarget?.resourceId, 9_003, "an episode TMDb ID is never promoted");
  assert.doesNotMatch(JSON.stringify(media), /parentSeriesEvidence|seriesSourceId|homeArtwork/u);
});

test("fails closed when merged episode evidence identifies conflicting parent series", () => {
  const jellyfinSeriesId = "dddddddddddddddddddddddddddddddd";
  const media = buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: jellyfinSeriesId,
          Type: "Series",
          Name: "Jellyfin Parent",
          ProviderIds: { Tmdb: "710", Tvdb: "7100" }
        }]
      },
      resume: {
        Items: [{
          Id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          Type: "Episode",
          Name: "Conflicted Episode",
          SeriesName: "Jellyfin Parent",
          SeriesId: jellyfinSeriesId,
          ProviderIds: { Tmdb: "9100", Tvdb: "8100" },
          UserData: { PlayedPercentage: 40 }
        }]
      }
    }),
    service("sonarr", {
      catalog: [{
        id: 90,
        title: "Different Sonarr Parent",
        tmdbId: 711,
        tvdbId: 7_110,
        monitored: true
      }],
      calendar: [{
        id: 901,
        title: "Conflicted Episode",
        tvdbId: 8_100,
        airDateUtc: "2026-09-20T01:00:00Z",
        seasonNumber: 1,
        episodeNumber: 1,
        series: {
          id: 90,
          title: "Different Sonarr Parent",
          tmdbId: 711,
          tvdbId: 7_110
        }
      }]
    })
  ], GENERATED_AT, TARGETS);

  const canonical = media.records.find((item) => item.mediaType === "episode" && item.providerIds.tvdb === 8_100);
  const resume = media.home.continueWatching.find((item) => item.providerIds.tvdb === 8_100);
  assert.equal(Object.hasOwn(canonical, "seasonRequestTarget"), false);
  assert.equal(Object.hasOwn(resume, "seasonRequestTarget"), false);
});

test("does not publish an episode season target without one current canonical parent", () => {
  const media = buildMediaSnapshot([
    service("sonarr", {
      calendar: [{
        id: 902,
        title: "Orphaned Episode",
        tvdbId: 8_200,
        airDateUtc: "2026-09-21T01:00:00Z",
        seasonNumber: 1,
        episodeNumber: 2,
        series: {
          id: 91,
          title: "Missing Catalog Parent",
          tmdbId: 712,
          tvdbId: 7_120
        }
      }]
    })
  ], GENERATED_AT, TARGETS);

  const episode = media.calendar.find(({ id }) => id === "sonarr-calendar:902");
  assert.ok(episode);
  assert.equal(
    Object.hasOwn(episode, "seasonRequestTarget"),
    false,
    "the UI must not receive a capability that requireCurrentSeriesTarget will reject"
  );
});

test("does not let one resolved parent authorize a merged episode with unresolved parent evidence", () => {
  const resolvedSeriesId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
  const unresolvedSeriesId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";
  const media = buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: resolvedSeriesId,
          Type: "Series",
          Name: "Resolved Parent",
          ProviderIds: { Tmdb: "720" }
        }]
      },
      resume: {
        Items: [{
          Id: "ccccccccccccccccccccccccccccccc3",
          Type: "Episode",
          Name: "Unresolved Parent Episode",
          SeriesName: "Unresolved Parent",
          SeriesId: unresolvedSeriesId,
          ProviderIds: { Tvdb: "8300" },
          UserData: { PlayedPercentage: 10 }
        }, {
          Id: "ddddddddddddddddddddddddddddddd4",
          Type: "Episode",
          Name: "Resolved Parent Episode",
          SeriesName: "Resolved Parent",
          SeriesId: resolvedSeriesId,
          ProviderIds: { Tvdb: "8300" },
          UserData: { PlayedPercentage: 20 }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  const canonical = media.records.find((item) => item.mediaType === "episode" && item.providerIds.tvdb === 8_300);
  assert.ok(canonical);
  assert.equal(Object.hasOwn(canonical, "seasonRequestTarget"), false);
  assert.equal(media.home.continueWatching.length, 2);
  assert.ok(media.home.continueWatching.every((item) => !Object.hasOwn(item, "seasonRequestTarget")));
});

test("keeps providerless Arr records and queue activity in separate public ID namespaces", () => {
  const media = buildMediaSnapshot([
    service("sonarr", {
      catalog: [{
        id: 501,
        title: "Catalog Series",
        monitored: true
      }],
      queue: {
        records: [{
          id: 501,
          series: { id: 90, title: "Blocked Other Series" },
          trackedDownloadState: "failed",
          statusMessage: "Import failed"
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  const record = media.records.find(({ title }) => title === "Catalog Series");
  const activity = media.activity.find(({ title }) => title === "Blocked Other Series");
  assert.ok(record);
  assert.ok(activity);
  assert.equal(record.id, "sonarr:501");
  assert.equal(activity.id, "activity:sonarr:501");
  assert.notEqual(activity.id, record.id);
  assert.deepEqual(activity.queueActionTarget, { service: "sonarr", queueId: 501 });
});

test("uses fast Radarr poster metadata and Seerr's fixed image proxy for future movies", () => {
  const media = buildMediaSnapshot([
    service("radarr", {
      catalog: [{
        id: 701,
        title: "Future Signal",
        year: 2027,
        tmdbId: 7_001,
        monitored: true,
        hasFile: false,
        isAvailable: false,
        digitalRelease: "2027-01-10T00:00:00Z",
        images: [{
          coverType: "poster",
          url: "https://image.tmdb.org/t/p/original/future_signal.jpg",
          remoteUrl: "https://image.tmdb.org/t/p/original/future_signal.jpg"
        }]
      }],
      calendar: [{
        id: 701,
        title: "Future Signal",
        year: 2027,
        tmdbId: 7_001,
        monitored: true,
        hasFile: false,
        isAvailable: false,
        digitalRelease: "2027-01-10T00:00:00Z"
      }]
    })
  ], GENERATED_AT, TARGETS);

  const title = media.library.find(({ providerIds }) => providerIds.tmdb === 7_001);
  const upcoming = media.home.upcoming.find(({ providerIds }) => providerIds.tmdb === 7_001);
  assert.ok(title);
  assert.ok(upcoming);
  assert.equal(title.available, false);
  assert.equal(title.imported, false);
  assert.equal(title.monitored, true);
  assert.equal(title.lifecycle.stage, "monitored");
  assert.equal(title.missingCount, 0, "Radarr says the unreleased movie is not missing yet");
  assert.equal(media.metrics.missingMovies, 0);
  assert.equal(upcoming.artworkUrl, title.artworkUrl);
  const descriptor = media.artwork[title.artworkUrl.split("/").pop()];
  assert.deepEqual(descriptor.sources, [{
    service: "radarr",
    kind: "poster",
    resource: "701",
    variant: "poster-250",
    targetRevision: TARGETS.radarr
  }, {
    service: "seerr",
    kind: "poster",
    resource: "future_signal.jpg",
    variant: "w342",
    targetRevision: TARGETS.seerr
  }]);
});

test("does not mint Arr artwork URLs without poster evidence", () => {
  const media = buildMediaSnapshot([
    service("radarr", {
      catalog: [{ id: 44, title: "No Poster", tmdbId: 4_400, monitored: true, hasFile: false, isAvailable: false }]
    })
  ], GENERATED_AT, TARGETS);
  assert.equal(media.library[0].artworkUrl, null);
  assert.deepEqual(media.artwork, {});
});

test("counts missing movie and episode units independently from imported lifecycle state", () => {
  const media = buildMediaSnapshot([
    service("sonarr", {
      catalog: [{
        id: 90,
        title: "Partial Series",
        tvdbId: 900,
        monitored: true,
        statistics: { episodeCount: 10, episodeFileCount: 1 }
      }]
    }),
    service("radarr", {
      catalog: [{ id: 91, title: "Missing Movie", tmdbId: 901, monitored: true, hasFile: false, isAvailable: true }]
    })
  ], GENERATED_AT, TARGETS);

  const series = media.records.find(({ providerIds }) => providerIds.tvdb === 900);
  assert.equal(series.imported, true, "one imported episode must retain the Imported lifecycle stage");
  assert.equal(series.lifecycle.stage, "imported");
  assert.equal(series.missingCount, 9);
  assert.equal(media.home.missing.some(({ id }) => id === series.id), true);

  assert.deepEqual({
    missingTotal: media.metrics.missingTotal,
    missingMovies: media.metrics.missingMovies,
    missingEpisodes: media.metrics.missingEpisodes
  }, {
    missingTotal: 10,
    missingMovies: 1,
    missingEpisodes: 9
  });
});

test("publishes Jellyfin Now Playing without session, user, or device metadata", () => {
  const media = buildMediaSnapshot([
    service("jellyfin", {
      sessions: [{
        Id: "private-session-id",
        UserName: "private-user",
        DeviceName: "private-device",
        RemoteEndPoint: "192.168.1.20",
        NowPlayingItem: {
          Id: "1234567890abcdef1234567890abcdef",
          Type: "Movie",
          Name: "Playing Movie",
          ProductionYear: 2026,
          RunTimeTicks: 8_000,
          ProviderIds: { Tmdb: 808 },
          ImageTags: { Primary: "abcdef0123456789abcdef0123456789" }
        },
        PlayState: { PositionTicks: 2_000, IsPaused: false, AudioStreamIndex: 7 }
      }]
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.home.nowPlaying.length, 1);
  assert.deepEqual({
    title: media.home.nowPlaying[0].title,
    state: media.home.nowPlaying[0].state,
    progress: media.home.nowPlaying[0].progress,
    mediaId: media.home.nowPlaying[0].mediaId
  }, {
    title: "Playing Movie",
    state: "playing",
    progress: 25,
    mediaId: "movie:tmdb:808"
  });
  assert.equal(media.metrics.nowPlayingTotal, 1);
  assert.match(media.home.nowPlaying[0].artworkUrl, /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u);
  const serialized = JSON.stringify(media);
  for (const forbidden of ["private-session-id", "private-user", "private-device", "192.168.1.20", "AudioStreamIndex"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("uses base series covers for Continue Watching and prefers Resume over Next Up", () => {
  const seriesId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const resumeEpisodeId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const nextEpisodeId = "cccccccccccccccccccccccccccccccc";
  const movieId = "dddddddddddddddddddddddddddddddd";
  const inheritedOnlySeriesId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const inheritedOnlyEpisodeId = "ffffffffffffffffffffffffffffffff";
  const media = buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: seriesId,
          Type: "Series",
          Name: "Base Cover Series",
          ProviderIds: { Tmdb: 700 },
          ImageTags: { Primary: "series-library-cover" },
          DateCreated: "2026-09-12T10:00:00Z"
        }]
      },
      latest: [{
        Id: seriesId,
        Type: "Series",
        Name: "Base Cover Series",
        ProviderIds: { Tmdb: 700 },
        ImageTags: { Primary: "series-library-cover" },
        DateCreated: "2026-09-12T10:00:00Z"
      }],
      resume: {
        Items: [{
          Id: resumeEpisodeId,
          Type: "Episode",
          Name: "Paused Episode",
          SeriesName: "Base Cover Series",
          SeriesId: seriesId,
          SeriesPrimaryImageTag: "series-resume-cover",
          ProviderIds: { Tvdb: 7_001 },
          ImageTags: { Primary: "resume-frame" },
          UserData: { PlayedPercentage: 48 }
        }, {
          Id: inheritedOnlyEpisodeId,
          Type: "Episode",
          Name: "Inherited Episode",
          SeriesName: "Inherited Cover Series",
          SeriesId: inheritedOnlySeriesId,
          SeriesPrimaryImageTag: "inherited-series-cover",
          ProviderIds: { Tvdb: 7_002 },
          ImageTags: { Primary: "inherited-episode-frame" },
          UserData: { PlayedPercentage: 22 }
        }, {
          Id: movieId,
          Type: "Movie",
          Name: "Distinct Resume Movie",
          ProviderIds: { Tmdb: 701 },
          ImageTags: { Primary: "movie-cover" },
          UserData: { PlayedPercentage: 31 }
        }]
      },
      nextUp: {
        Items: [{
          Id: nextEpisodeId,
          Type: "Episode",
          Name: "Next Episode",
          SeriesName: "Base Cover Series",
          SeriesId: seriesId,
          SeriesPrimaryImageTag: "series-next-cover",
          ProviderIds: { Tvdb: 7_003 },
          ImageTags: { Primary: "next-episode-frame" }
        }]
      },
      sessions: [{
        NowPlayingItem: {
          Id: resumeEpisodeId,
          Type: "Episode",
          Name: "Paused Episode",
          SeriesName: "Base Cover Series",
          ProviderIds: { Tvdb: 7_001 },
          ImageTags: { Primary: "now-playing-frame" },
          RunTimeTicks: 1_000
        },
        PlayState: { PositionTicks: 500, IsPaused: true }
      }]
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.home.continueWatching.length, 3, "the same series must appear only once while distinct movies remain");
  assert.deepEqual(
    media.home.continueWatching.map(({ sourceId }) => sourceId),
    [resumeEpisodeId, inheritedOnlyEpisodeId, movieId],
    "Resume is ordered before and wins over the same series from Next Up"
  );

  const seriesResume = media.home.continueWatching[0];
  const inheritedResume = media.home.continueWatching[1];
  const movieResume = media.home.continueWatching[2];
  const seriesDescriptor = media.artwork[seriesResume.artworkUrl.split("/").pop()];
  const inheritedDescriptor = media.artwork[inheritedResume.artworkUrl.split("/").pop()];
  const movieDescriptor = media.artwork[movieResume.artworkUrl.split("/").pop()];
  assert.equal(seriesDescriptor.sources[0].resource, seriesId);
  assert.equal(seriesDescriptor.sources[0].revision, "series-library-cover");
  assert.equal(inheritedDescriptor.sources[0].resource, inheritedOnlySeriesId);
  assert.equal(inheritedDescriptor.sources[0].revision, "inherited-series-cover");
  assert.equal(movieDescriptor.sources[0].resource, movieId);
  assert.equal(movieDescriptor.sources[0].revision, "movie-cover");
  assert.notEqual(seriesDescriptor.sources[0].resource, resumeEpisodeId, "an episode resume frame cannot become the card cover");
  assert.equal(Object.hasOwn(seriesResume, "homeArtwork"), false);
  assert.equal(Object.hasOwn(seriesResume, "seriesSourceId"), false);

  const nowPlayingDescriptor = media.artwork[media.home.nowPlaying[0].artworkUrl.split("/").pop()];
  assert.equal(nowPlayingDescriptor.sources[0].resource, resumeEpisodeId, "Now Playing keeps its item-specific artwork");
  assert.equal(media.home.recentlyAdded[0].artworkUrl, seriesResume.artworkUrl, "Recently Added keeps the library series cover");
});

test("never falls back to an episode frame when a Continue Watching base cover is unavailable", () => {
  const media = buildMediaSnapshot([
    service("jellyfin", {
      resume: {
        Items: [{
          Id: "1234567890abcdef1234567890abcdef",
          Type: "Episode",
          Name: "Frame-only Episode",
          SeriesName: "Frame-only Series",
          SeriesId: "fedcba0987654321fedcba0987654321",
          SeriesPrimaryImageTag: "unsafe tag?",
          ProviderIds: { Tvdb: 8_001 },
          ImageTags: { Primary: "episode-frame-only" },
          UserData: { PlayedPercentage: 12 }
        }]
      }
    })
  ], GENERATED_AT, TARGETS);

  assert.equal(media.home.continueWatching.length, 1);
  assert.equal(media.home.continueWatching[0].artworkUrl, null);
  assert.match(media.records[0].artworkUrl, /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u, "other views retain the item artwork");
});

test("publishes Jellyfin artwork only with validated image and connection revisions", () => {
  const snapshotFor = (ImageTags, targetRevision = TARGETS.jellyfin) => buildMediaSnapshot([
    service("jellyfin", {
      library: {
        Items: [{
          Id: "abcdef0123456789abcdef0123456789",
          Type: "Movie",
          Name: "Tagged Movie",
          ProviderIds: { Tmdb: 404 },
          ...(ImageTags === undefined ? {} : { ImageTags })
        }]
      }
    })
  ], GENERATED_AT, targetRevision ? { jellyfin: targetRevision } : {});

  const first = snapshotFor({ Primary: "tag-one_123" });
  const second = snapshotFor({ Primary: "tag-two_456" });
  const missing = snapshotFor(undefined);
  const invalid = snapshotFor({ Primary: "unsafe tag?" });
  const retargeted = snapshotFor({ Primary: "tag-one_123" }, "55555555-5555-4555-8555-555555555555");
  const unbound = snapshotFor({ Primary: "tag-one_123" }, null);
  const invalidBinding = snapshotFor({ Primary: "tag-one_123" }, "not-a-target-revision");
  assert.notEqual(first.records[0].artworkUrl, second.records[0].artworkUrl);
  assert.notEqual(first.records[0].artworkUrl, retargeted.records[0].artworkUrl);
  const token = first.records[0].artworkUrl.split("/").pop();
  assert.deepEqual(first.artwork[token], {
    version: 4,
    sources: [{
      service: "jellyfin",
      kind: "primary",
      resource: "abcdef0123456789abcdef0123456789",
      revision: "tag-one_123",
      variant: "w342q85",
      targetRevision: TARGETS.jellyfin
    }]
  });
  assert.equal(missing.records[0].artworkUrl, null);
  assert.equal(invalid.records[0].artworkUrl, null);
  assert.equal(unbound.records[0].artworkUrl, null);
  assert.equal(invalidBinding.records[0].artworkUrl, null);
  assert.deepEqual(missing.artwork, {});
  assert.deepEqual(invalid.artwork, {});
});

test("retains only a safe Arr poster lastWrite revision", () => {
  const valid = inventoryFromProbeBody("radarr", "catalog", [{
    id: 7,
    title: "Versioned Poster",
    tmdbId: 700,
    images: [{ coverType: "poster", url: "/MediaCover/7/poster.jpg?lastWrite=638934912000000007" }]
  }]);
  const unsafe = inventoryFromProbeBody("radarr", "catalog", [{
    id: 8,
    title: "Unversioned Poster",
    tmdbId: 800,
    images: [{ coverType: "poster", url: "https://evil.test/MediaCover/8/poster.jpg?lastWrite=638934912000000008" }]
  }]);
  const urlBase = inventoryFromProbeBody("sonarr", "catalog", [{
    id: 9,
    title: "URL base poster",
    tvdbId: 900,
    images: [{ coverType: "poster", url: "/sonarr/MediaCover/9/poster-500.jpg?lastWrite=638934912000000009" }]
  }]);
  assert.equal(valid.library[0].artwork.revision, "638934912000000007");
  assert.equal(unsafe.library[0].artwork.revision, undefined);
  assert.equal(urlBase.library[0].artwork.revision, "638934912000000009");
  assert.equal(valid.library[0].artwork.variant, "poster-250");
});

test("bounds and revalidates hostile inventory at the monitor boundary", () => {
  const hostile = {
    library: Array.from({ length: 700 }, (_, index) => ({
      service: "radarr",
      sourceId: String(index + 1),
      mediaType: "movie",
      title: index === 0 ? "Safe\u0000 ‹title›" : `Movie ${index}`,
      providerIds: { tmdb: index + 1 },
      artwork: { service: "radarr", kind: "poster", resource: String(index + 1) },
      unexpected: "https://" + "admin:secret@example.invalid/private"
    })),
    activity: [{
      service: "radarr",
      sourceId: "1",
      mediaType: "movie",
      title: "Safe",
      providerIds: { tmdb: 1 },
      queueId: "1/delete?blocklist=false",
      error: `apiKey=private-media-key-123 ${"x".repeat(600)}<script>`,
      progress: 500
    }],
    ignored: [{ secret: "must not survive" }]
  };
  const normalized = normalizeServiceMediaInventory("radarr", hostile);
  assert.equal(normalized.library.length, 500);
  assert.equal(normalized.activity[0].progress, 100);
  assert.equal(Object.hasOwn(normalized.activity[0], "queueId"), false);
  assert.ok(Array.from(normalized.activity[0].error).length <= 420);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /admin:secret|private-media-key-123|must not survive|<script>/u);
  assert.match(normalized.activity[0].error, /\[REDACTED\]/u);
});

test("returns a complete empty model when media services are absent", () => {
  const media = buildMediaSnapshot([], GENERATED_AT);
  assert.deepEqual(media.records, []);
  assert.deepEqual(media.library, []);
  assert.deepEqual(media.home.nowPlaying, []);
  assert.deepEqual(media.home.continueWatching, []);
  assert.deepEqual(media.activity, []);
  assert.deepEqual(media.artwork, {});
  assert.equal(media.metrics.activeDownloadTotal, 0);
  assert.equal(media.metrics.nowPlayingTotal, 0);
});
