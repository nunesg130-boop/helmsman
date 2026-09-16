import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBridgeRoute } from "../server/routes.mjs";
import {
  buildProbePlan,
  deriveSanitizedServiceProbe,
  probeService,
  SERVICE_AUTH_SCHEMA,
  SERVICE_IDS,
  SERVICE_REPORT_LIMITS,
  serviceAuthMetadata
} from "../server/service-probes.mjs";

const CHECKED_AT = "2026-09-13T01:00:00.000Z";
const RAW_SECRET = "credential-and-title-that-must-not-escape";

function baseFixtures() {
  return {
    jellyfin: {
      status: { Version: "10.11.8", ServerName: RAW_SECRET, LocalAddress: `http://${RAW_SECRET}` },
      identity: { Version: "10.11.8", Id: "server-id", ServerName: RAW_SECRET },
      library: { Items: [] },
      latest: [],
      resume: { Items: [] },
      nextUp: { Items: [] },
      sessions: []
    },
    seerr: {
      status: { version: "2.7.3", commitTag: RAW_SECRET },
      identity: { id: 7, username: RAW_SECRET, email: RAW_SECRET },
      requestCounts: { total: 19, pending: 3, approved: 4, processing: 2, available: 10, apiKey: RAW_SECRET },
      requests: { results: [] },
      trending: { results: [] }
    },
    radarr: {
      status: { version: "6.3.0.10514", appName: "Radarr", startupPath: RAW_SECRET },
      health: [],
      queue: { totalRecords: 1, records: [{ status: "downloading", title: RAW_SECRET, downloadId: RAW_SECRET }] },
      catalog: [],
      calendar: []
    },
    sonarr: {
      status: { version: "4.0.15.2941", appName: "Sonarr", startupPath: RAW_SECRET },
      health: [],
      queue: { totalRecords: 0, records: [] },
      catalog: [],
      calendar: []
    },
    prowlarr: {
      status: { version: "2.3.0.5236", appName: "Prowlarr", startupPath: RAW_SECRET },
      health: [],
      indexers: []
    },
    bazarr: {
      status: { data: { bazarr_version: "1.5.3", directory: RAW_SECRET } },
      health: { data: [] },
      wantedMovies: { total: 2, data: [{ title: RAW_SECRET }] },
      wantedEpisodes: { total: 5, data: [{ title: RAW_SECRET }] }
    },
    qbittorrent: {
      version: "5.2.1",
      transfer: { dl_info_speed: 1024, up_info_speed: 0, connection_status: "connected", secret: RAW_SECRET },
      torrents: [
        { state: "downloading", progress: 0.5, name: RAW_SECRET, hash: RAW_SECRET },
        { state: "stalledUP", progress: 1, name: RAW_SECRET },
        { state: "pausedUP", progress: 1, name: RAW_SECRET }
      ]
    }
  };
}

function fixtureTransport(fixtures, overrides = {}) {
  return async (service, _path, options) => {
    const override = overrides[`${service}:${options.checkId}`];
    if (typeof override === "function") return override();
    if (override !== undefined) return override;
    return { status: 200, body: fixtures[service][options.checkId], latencyMs: 17 };
  };
}

test("exports frozen write-only authentication metadata", () => {
  assert.equal(SERVICE_AUTH_SCHEMA.schema, 1);
  assert.deepEqual(Object.keys(SERVICE_AUTH_SCHEMA.services), SERVICE_IDS);
  assert.equal(Object.isFrozen(SERVICE_AUTH_SCHEMA), true);
  assert.equal(Object.isFrozen(serviceAuthMetadata("qbit")), true);
  assert.deepEqual(
    serviceAuthMetadata("qbittorrent").modes.password.storedFields.map(({ id }) => id),
    ["username", "password"]
  );
  assert.deepEqual(
    serviceAuthMetadata("seerr").modes.login.transientFields.map(({ id }) => id),
    ["username", "password"]
  );
  assert.deepEqual(
    serviceAuthMetadata("seerr").modes.login.storedFields.map(({ id }) => id),
    ["session"]
  );
  for (const metadata of Object.values(SERVICE_AUTH_SCHEMA.services)) {
    for (const mode of Object.values(metadata.modes)) {
      for (const field of [...(mode.storedFields || []), ...(mode.transientFields || [])]) {
        assert.equal(field.secret, true);
        assert.equal(field.writeOnly, true);
        assert.equal(Object.hasOwn(field, "value"), false);
      }
    }
  }
});

test("builds bounded GET-only plans containing only already allowlisted routes", () => {
  const publicChecks = [];
  const credentialProofChecks = [];
  for (const service of SERVICE_IDS) {
    const bridge = service === "qbittorrent" ? "qbit" : service;
    const plan = buildProbePlan(service, { timeoutMs: 1234 });
    assert.ok(plan.length >= 2);
    for (const entry of plan) {
      assert.equal(entry.method, "GET");
      assert.equal(entry.timeoutMs, 1234);
      assert.ok(entry.maxBytes > 0 && entry.maxBytes <= 4 * 1024 * 1024);
      assert.ok(Array.isArray(entry.stages) && entry.stages.length > 0);
      assert.equal(typeof entry.credentialRequired, "boolean");
      assert.equal(typeof entry.credentialProof, "boolean");
      if (!entry.credentialRequired) {
        publicChecks.push(`${service}:${entry.id}`);
        assert.equal(entry.credentialProof, false);
      }
      if (entry.credentialProof) credentialProofChecks.push(`${service}:${entry.id}`);
      assert.equal(entry.credentialProof && !entry.credentialRequired, false);
      assert.equal(Object.isFrozen(entry), true);
      const allowed = authorizeBridgeRoute(service, "GET", `/bridge/${bridge}${entry.path}`);
      assert.equal(allowed.allowed, true, `${service} ${entry.path} is not broker-allowlisted`);
      assert.doesNotMatch(entry.path, /(?:api[_-]?key|password|token|secret)=/iu);
    }
    assert.ok(buildProbePlan(service, { includeOptional: false }).every(({ importance }) => importance !== "optional"));
  }
  assert.deepEqual(buildProbePlan("radarr").find(({ id }) => id === "queue").stages, ["imports"]);
  assert.equal(buildProbePlan("radarr").find(({ id }) => id === "queue").stages.includes("search"), false);
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "status").credentialRequired, false);
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "identity").path, "/System/Info");
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "identity").credentialRequired, true);
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "identity").credentialProof, true);
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "sessions").path, "/Sessions?ActiveWithinSeconds=900");
  assert.equal(buildProbePlan("jellyfin").find(({ id }) => id === "sessions").affectsHealth, false);
  assert.match(buildProbePlan("jellyfin").find(({ id }) => id === "library").path, /(?:^|&)EnableImages=true(?:&|$)/u);
  assert.match(buildProbePlan("jellyfin").find(({ id }) => id === "resume").path, /(?:^|&)EnableImageTypes=Primary(?:&|$)/u);
  assert.match(buildProbePlan("jellyfin").find(({ id }) => id === "nextUp").path, /(?:^|&)EnableImageTypes=Primary(?:&|$)/u);
  assert.doesNotMatch(buildProbePlan("jellyfin").find(({ id }) => id === "library").path, /Fields=[^&]*ImageTags/u);
  assert.equal(buildProbePlan("radarr").find(({ id }) => id === "catalog").path, "/api/v3/movie?excludeLocalCovers=true");
  assert.equal(buildProbePlan("sonarr").find(({ id }) => id === "catalog").path, "/api/v3/series?includeSeasonImages=false");
  assert.equal(buildProbePlan("sonarr").find(({ id }) => id === "calendar").path, "/api/v3/calendar?includeSeries=true");
  assert.equal(
    authorizeBridgeRoute("jellyfin", "GET", "/bridge/jellyfin/Sessions?ActiveWithinSeconds=900").allowed,
    true
  );
  for (const unsafe of [
    "/bridge/jellyfin/Sessions",
    "/bridge/jellyfin/Sessions?ActiveWithinSeconds=901",
    "/bridge/jellyfin/Sessions?ActiveWithinSeconds=900&UserId=7"
  ]) assert.equal(authorizeBridgeRoute("jellyfin", "GET", unsafe).allowed, false, unsafe);
  assert.equal(
    authorizeBridgeRoute("sonarr", "GET", "/bridge/sonarr/api/v3/calendar?includeSeries=true").allowed,
    true
  );
  for (const unsafe of [
    "/bridge/sonarr/api/v3/calendar",
    "/bridge/sonarr/api/v3/calendar?includeSeries=false",
    "/bridge/sonarr/api/v3/calendar?includeSeries=true&includeEpisodeImages=true"
  ]) assert.equal(authorizeBridgeRoute("sonarr", "GET", unsafe).allowed, false, unsafe);
  assert.equal(buildProbePlan("seerr").find(({ id }) => id === "status").path, "/api/v1/status");
  assert.equal(buildProbePlan("seerr").find(({ id }) => id === "status").credentialRequired, false);
  assert.equal(buildProbePlan("seerr").find(({ id }) => id === "requestCounts").credentialRequired, true);
  assert.equal(buildProbePlan("seerr").find(({ id }) => id === "requestCounts").credentialProof, false);
  assert.equal(authorizeBridgeRoute("seerr", "GET", "/bridge/seerr/api/v1/movie/123").allowed, true);
  assert.equal(authorizeBridgeRoute("seerr", "GET", "/bridge/seerr/api/v1/tv/456").allowed, true);
  for (const unsafe of [
    "/bridge/seerr/api/v1/movie/not-a-number",
    "/bridge/seerr/api/v1/movie/123?appendToResponse=credits",
    "/bridge/seerr/api/v1/tv/456?language=en"
  ]) assert.equal(authorizeBridgeRoute("seerr", "GET", unsafe).allowed, false, unsafe);
  assert.equal(buildProbePlan("prowlarr").find(({ id }) => id === "indexers").label, "Blocked indexers");
  assert.deepEqual(publicChecks, ["jellyfin:status", "seerr:status"]);
  assert.deepEqual(credentialProofChecks, [
    "jellyfin:identity",
    "seerr:identity",
    "radarr:status",
    "sonarr:status",
    "prowlarr:status",
    "bazarr:status",
    "qbittorrent:version"
  ]);
});

test("uses Seerr's exact supported paths and authentication metadata", async () => {
  const fixtures = baseFixtures();
  const calls = [];
  const result = await probeService("seerr", async (service, path, options) => {
    calls.push({
      id: options.checkId,
      path,
      credentialRequired: options.credentialRequired,
      credentialProof: options.credentialProof
    });
    return { status: 200, body: fixtures[service][options.checkId] };
  }, { checkedAt: CHECKED_AT });

  assert.deepEqual(calls, [
    { id: "status", path: "/api/v1/status", credentialRequired: false, credentialProof: false },
    { id: "identity", path: "/api/v1/auth/me", credentialRequired: true, credentialProof: true },
    { id: "requestCounts", path: "/api/v1/request/count", credentialRequired: true, credentialProof: false },
    { id: "requests", path: "/api/v1/request?take=200&skip=0&sort=added", credentialRequired: true, credentialProof: false },
    { id: "trending", path: "/api/v1/discover/trending?page=1", credentialRequired: true, credentialProof: false }
  ]);
  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
});

test("applies optional Seerr request metadata without adding it to health checks", async () => {
  const fixtures = baseFixtures();
  fixtures.seerr.requests = {
    results: [{ id: 71, status: 2, media: { mediaType: "movie", tmdbId: 101, status: 3 } }]
  };
  const calls = [];
  let enrichmentContext = null;
  const targetRevision = "44444444-4444-4444-8444-444444444444";
  const result = await probeService("seerr", async (service, _path, options) => {
    calls.push(options.checkId);
    assert.equal(options.targetRevision, targetRevision);
    return { status: 200, body: fixtures[service][options.checkId] };
  }, {
    checkedAt: CHECKED_AT,
    targetRevision,
    enrichSeerrRequests: async (body, context) => {
      enrichmentContext = context;
      return {
        ...body,
        results: body.results.map((request) => ({
          ...request,
          media: { ...request.media, title: "Signal", year: 2026, posterPath: "/signal.jpg" }
        }))
      };
    }
  });

  assert.deepEqual(calls, ["status", "identity", "requestCounts", "requests", "trending"]);
  assert.equal(enrichmentContext.targetRevision, targetRevision);
  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.inventory.requests[0].title, "Signal");
  assert.equal(result.inventory.requests[0].year, 2026);
  assert.equal(result.inventory.requests[0].artwork.resource, "signal.jpg");
  assert.equal(result.checks.some(({ id }) => id === "requestMetadata"), false);
});

test("isolates Seerr request metadata failures from request inventory and health", async () => {
  const fixtures = baseFixtures();
  fixtures.seerr.requests = {
    results: [{ id: 71, status: 2, media: { mediaType: "movie", tmdbId: 101, status: 3 } }]
  };
  const result = await probeService("seerr", fixtureTransport(fixtures), {
    checkedAt: CHECKED_AT,
    targetRevision: "44444444-4444-4444-8444-444444444444",
    enrichSeerrRequests: async () => {
      throw new Error(RAW_SECRET);
    }
  });

  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.inventory.requests.length, 1);
  assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);
});

test("rejects malformed Seerr enrichment output without degrading the request check", async () => {
  const fixtures = baseFixtures();
  fixtures.seerr.requests = {
    results: [{ id: 71, status: 2, media: { mediaType: "movie", tmdbId: 101, status: 3 } }]
  };
  const result = await probeService("seerr", fixtureTransport(fixtures), {
    checkedAt: CHECKED_AT,
    targetRevision: "44444444-4444-4444-8444-444444444444",
    enrichSeerrRequests: async () => ({ results: "not-an-array" })
  });

  assert.equal(result.state, "healthy");
  assert.equal(result.checks.find(({ id }) => id === "requests").state, "healthy");
  assert.equal(result.inventory.requests.length, 1);
});

test("returns healthy, sanitized, deterministic results for every supported service", async () => {
  const fixtures = baseFixtures();
  for (const service of SERVICE_IDS) {
    const result = await probeService(service, fixtureTransport(fixtures), {
      checkedAt: CHECKED_AT,
      clock: () => 0
    });
    assert.equal(result.schema, 1);
    assert.equal(result.service, service);
    assert.equal(result.state, "healthy", `${service} was not healthy`);
    assert.equal(result.connectionState, "connected", `${service} connection was not verified`);
    assert.equal(result.checkedAt, CHECKED_AT);
    assert.equal(result.latencyMs, 17);
    assert.ok(result.checks.every(({ state }) => state === "healthy"));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(RAW_SECRET), false);
    assert.equal(serialized.includes("body"), false);
    assert.equal(serialized.includes("path"), false);
    assert.equal(serialized.includes("username"), false);
  }

  const seerr = await probeService("seerr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.deepEqual(seerr.metrics, {
    totalRequests: 19,
    pendingRequests: 3,
    approvedRequests: 4,
    processingRequests: 2,
    availableRequests: 10
  });
  const bazarr = await probeService("bazarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.deepEqual(bazarr.metrics, {
    healthNotices: 0,
    healthWarnings: 0,
    healthErrors: 0,
    missingMovieSubtitles: 2,
    missingEpisodeSubtitles: 5,
    subtitleBacklog: 7
  });
  const prowlarr = await probeService("prowlarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.deepEqual(prowlarr.metrics, {
    healthNotices: 0,
    healthWarnings: 0,
    healthErrors: 0,
    indexersBlocked: 0
  });
  assert.equal(prowlarr.checks.find(({ id }) => id === "indexers").state, "healthy");
});

test("runs one service's checks sequentially to preserve the broker request budget", async () => {
  const fixtures = baseFixtures();
  let active = 0;
  let maximumActive = 0;
  const result = await probeService("bazarr", async (_service, _path, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { status: 200, body: fixtures.bazarr[options.checkId], latencyMs: 1 };
  }, { checkedAt: CHECKED_AT });
  assert.equal(result.state, "healthy");
  assert.equal(maximumActive, 1);
});

test("retains only bounded Jellyfin now-playing media and play state", async () => {
  const fixtures = baseFixtures();
  const privateSession = "private-session-id-that-must-not-survive";
  const privateUser = "private-jellyfin-user";
  const privateDevice = "private-bedroom-device";
  fixtures.jellyfin.sessions = [{
    Id: privateSession,
    UserName: privateUser,
    DeviceName: privateDevice,
    Client: "Secret client metadata",
    RemoteEndPoint: "192.168.1.20",
    NowPlayingItem: {
      Id: "abcdef0123456789abcdef0123456789",
      Type: "Episode",
      Name: "The Episode",
      SeriesName: "The Series",
      ProductionYear: 2026,
      ParentIndexNumber: 2,
      IndexNumber: 4,
      RunTimeTicks: 1_000,
      ProviderIds: { Tvdb: 555 },
      ImageTags: { Primary: "abcdef0123456789abcdef0123456789" },
      Path: `/private/${privateUser}`
    },
    PlayState: {
      PositionTicks: 250,
      IsPaused: true,
      AudioStreamIndex: 4,
      SubtitleStreamIndex: 8
    }
  }, {
    Id: "private-audio-session",
    NowPlayingItem: {
      Id: "fedcba9876543210fedcba9876543210",
      Type: "Audio",
      Name: "Private music title",
      ProviderIds: { MusicBrainzTrack: "private-track-id" }
    },
    PlayState: { PositionTicks: 100 }
  }];
  const result = await probeService("jellyfin", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.deepEqual(result.inventory.nowPlaying, [{
    service: "jellyfin",
    sourceId: "abcdef0123456789abcdef0123456789",
    mediaType: "episode",
    title: "The Series",
    year: 2026,
    providerIds: { tvdb: 555 },
    artwork: {
      service: "jellyfin",
      kind: "primary",
      resource: "abcdef0123456789abcdef0123456789",
      revision: "abcdef0123456789abcdef0123456789",
      variant: "w342q85"
    },
    available: true,
    progress: 25,
    seasonNumber: 2,
    episodeNumber: 4,
    state: "paused",
    episodeTitle: "The Episode"
  }]);
  assert.equal(result.checks.find(({ id }) => id === "sessions").affectsHealth, false);
  const serialized = JSON.stringify(result);
  for (const forbidden of [privateSession, privateUser, privateDevice, "Secret client metadata", "192.168.1.20", "AudioStreamIndex", "SubtitleStreamIndex", "/private/", "Private music title", "private-track-id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("keeps individual failures and differentiates important from optional outages", async () => {
  const fixtures = baseFixtures();
  const calls = [];
  const seerr = await probeService("seerr", async (service, path, options) => {
    calls.push(options.checkId);
    if (options.checkId === "requestCounts") {
      return { status: 500, body: { message: RAW_SECRET }, latencyMs: 21 };
    }
    return { status: 200, body: fixtures[service][options.checkId], latencyMs: 12 };
  }, { checkedAt: CHECKED_AT });
  assert.deepEqual(calls.sort(), ["identity", "requestCounts", "requests", "status", "trending"]);
  assert.equal(seerr.state, "limited");
  assert.equal(seerr.connectionState, "connected");
  assert.deepEqual(
    seerr.checks.find(({ id }) => id === "requestCounts"),
    {
      id: "requestCounts",
      label: "Request workflow",
      importance: "optional",
      stages: ["requests"],
      latencyMs: 21,
      status: 500,
      code: "HTTP_ERROR",
      state: "limited",
      reports: [{
        severity: "warning",
        source: "Seerr · Request workflow",
        message: "GET /api/v1/request/count returned HTTP 500. Seerr reported a server-side failure; review its logs and retry."
      }]
    }
  );

  const bazarr = await probeService("bazarr", fixtureTransport(fixtures, {
    "bazarr:wantedEpisodes": () => {
      throw Object.assign(new Error(`upstream exposed ${RAW_SECRET}`), { status: 503, code: "PRIVATE_CODE" });
    }
  }), { checkedAt: CHECKED_AT, clock: () => 10 });
  assert.equal(bazarr.state, "limited");
  assert.equal(bazarr.checks.find(({ id }) => id === "wantedEpisodes").state, "limited");
  assert.equal(JSON.stringify(bazarr).includes(RAW_SECRET), false);
});

test("explains fixed media-capability failures without reflecting upstream bodies", async () => {
  const fixtures = baseFixtures();
  const cases = [
    [400, /rejected the fixed read-only request; verify its base URL, version, and permissions/u],
    [401, /rejected the stored credential/u],
    [403, /Grant the credential read permission/u],
    [404, /Verify the Radarr base URL and version/u],
    [429, /Wait for the next cycle or reduce competing API traffic/u],
    [503, /server-side failure/u]
  ];
  for (const [status, message] of cases) {
    const result = await probeService("radarr", fixtureTransport(fixtures, {
      "radarr:catalog": { status, body: { message: RAW_SECRET }, latencyMs: 4 }
    }), { checkedAt: CHECKED_AT });
    const catalog = result.checks.find(({ id }) => id === "catalog");
    assert.equal(result.state, "healthy", "optional media inventory must fail partially without degrading service health");
    assert.equal(catalog.affectsHealth, false);
    assert.equal(catalog.status, status);
    assert.match(catalog.reports[0].message, /^GET \/api\/v3\/movie\?excludeLocalCovers=true /u);
    assert.match(catalog.reports[0].message, message);
    assert.equal(JSON.stringify(catalog).includes(RAW_SECRET), false);
  }

  const unreachable = await probeService("seerr", fixtureTransport(fixtures, {
    "seerr:trending": () => {
      throw Object.assign(new Error(`network ${RAW_SECRET}`), { code: "ENETUNREACH" });
    }
  }), { checkedAt: CHECKED_AT, clock: () => 2 });
  const report = unreachable.checks.find(({ id }) => id === "trending").reports[0];
  assert.match(report.message, /could not reach Seerr/u);
  assert.equal(report.message.includes(RAW_SECRET), false);
});

test("classifies rejected credentials separately from reachability failures", async () => {
  const fixtures = baseFixtures();
  const auth = await probeService("jellyfin", fixtureTransport(fixtures, {
    "jellyfin:identity": { status: 401, body: { token: RAW_SECRET }, latencyMs: 9 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(auth.state, "auth_required");
  assert.equal(auth.connectionState, "auth_required");
  assert.equal(auth.checks.find(({ id }) => id === "identity").code, "AUTH_REQUIRED");

  const unreachable = await probeService("prowlarr", async () => {
    throw Object.assign(new Error(`connect ${RAW_SECRET}`), { code: "ENETUNREACH" });
  }, { checkedAt: CHECKED_AT, clock: () => 1 });
  assert.equal(unreachable.state, "down");
  assert.equal(unreachable.connectionState, "down");
  assert.ok(unreachable.checks.every(({ state, code }) => state === "down" && code === "UNREACHABLE"));
  assert.equal(JSON.stringify(unreachable).includes(RAW_SECRET), false);

  const unavailable = await probeService("sonarr", async () => ({
    status: 503,
    body: { message: RAW_SECRET },
    latencyMs: 30
  }), { checkedAt: CHECKED_AT });
  assert.equal(unavailable.state, "down");
  assert.equal(unavailable.connectionState, "down");
  assert.equal(unavailable.checks.find(({ id }) => id === "status").state, "down");
});

test("keeps connection verification separate from protected capability health", async () => {
  const fixtures = baseFixtures();
  const rejected = await probeService("seerr", fixtureTransport(fixtures, {
    "seerr:identity": { status: 403, body: { token: RAW_SECRET }, latencyMs: 9 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(rejected.state, "auth_required");
  assert.equal(rejected.connectionState, "auth_required", "public telemetry must not make a rejected key look connected");

  const countsCannotProveCredential = await probeService("seerr", fixtureTransport(fixtures, {
    "seerr:identity": { status: 401, body: { token: RAW_SECRET }, latencyMs: 9 },
    "seerr:requestCounts": { status: 200, body: fixtures.seerr.requestCounts, latencyMs: 4 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(countsCannotProveCredential.connectionState, "auth_required");

  const partiallyAuthorized = await probeService("radarr", fixtureTransport(fixtures, {
    "radarr:health": { status: 403, body: { token: RAW_SECRET }, latencyMs: 9 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(partiallyAuthorized.state, "auth_required");
  assert.equal(partiallyAuthorized.connectionState, "connected", "the parsed status proof verifies the credential");

  const malformed = await probeService("jellyfin", fixtureTransport(fixtures, {
    "jellyfin:identity": { status: 200, body: "<html>login</html>", latencyMs: 9 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(malformed.state, "degraded");
  assert.equal(malformed.connectionState, "unverified", "an unparseable 2xx response must not prove authentication");

  const cancelled = new AbortController();
  cancelled.abort();
  const stale = await probeService("radarr", async () => {
    throw new Error("must not run");
  }, { signal: cancelled.signal, checkedAt: CHECKED_AT, clock: () => 0 });
  assert.equal(stale.connectionState, "unverified");
});

test("preserves actionable broker transport classifications without retaining error messages", async () => {
  const fixtures = baseFixtures();
  const cases = [
    ["CREDENTIAL_NOT_CONFIGURED", 409, "auth_required", "CREDENTIAL_NOT_CONFIGURED"],
    ["UPSTREAM_TIMEOUT", 504, "down", "TIMEOUT"],
    ["UPSTREAM_UNREACHABLE", 502, "down", "UNREACHABLE"],
    ["UPSTREAM_RESPONSE_TOO_LARGE", 502, "degraded", "RESPONSE_TOO_LARGE"],
    ["UPSTREAM_REDIRECT_REJECTED", 502, "degraded", "INVALID_RESPONSE"],
    ["UPSTREAM_CONTENT_REJECTED", 502, "degraded", "INVALID_RESPONSE"]
  ];
  for (const [transportCode, status, expectedState, expectedCode] of cases) {
    const result = await probeService("radarr", fixtureTransport(fixtures, {
      "radarr:health": () => {
        throw Object.assign(new Error(`transport included ${RAW_SECRET}`), {
          code: transportCode,
          status
        });
      }
    }), { checkedAt: CHECKED_AT });
    const health = result.checks.find(({ id }) => id === "health");
    assert.equal(health.state, expectedState, transportCode);
    assert.equal(health.code, expectedCode, transportCode);
    assert.equal(JSON.stringify(result).includes(RAW_SECRET), false, transportCode);
  }
});

test("rejects malformed and cross-wired payloads without exposing their content", async () => {
  const fixtures = baseFixtures();
  const result = await probeService("radarr", fixtureTransport(fixtures, {
    "radarr:status": {
      status: 200,
      body: { version: "6.3.0", appName: "Sonarr", apiKey: RAW_SECRET },
      latencyMs: 5
    },
    "radarr:health": { status: 200, body: { arbitrary: RAW_SECRET }, latencyMs: 6 }
  }), { checkedAt: CHECKED_AT });
  assert.equal(result.state, "degraded");
  assert.equal(result.connectionState, "unverified");
  assert.equal(result.version, null);
  assert.equal(result.checks.find(({ id }) => id === "status").code, "INVALID_RESPONSE");
  assert.equal(result.checks.find(({ id }) => id === "health").code, "INVALID_RESPONSE");
  assert.equal(JSON.stringify(result).includes(RAW_SECRET), false);

  const tooLarge = deriveSanitizedServiceProbe("qbittorrent", [
    { id: "version", status: 200, body: "5".repeat(5_000), latencyMs: 1 },
    { id: "transfer", status: 200, body: fixtures.qbittorrent.transfer, latencyMs: 1 },
    { id: "torrents", status: 200, body: fixtures.qbittorrent.torrents, latencyMs: 1 }
  ], { checkedAt: CHECKED_AT });
  assert.equal(tooLarge.checks.find(({ id }) => id === "version").code, "INVALID_RESPONSE");
});

test("maps Arr health result types without treating notices as failures", async () => {
  const expectations = [
    {
      entries: [{ type: "Notice" }, { type: "ok" }],
      state: "healthy",
      code: null,
      metrics: { healthNotices: 1, healthWarnings: 0, healthErrors: 0 }
    },
    {
      entries: [{ type: "warning" }],
      state: "limited",
      code: "HEALTH_WARNING",
      metrics: { healthNotices: 0, healthWarnings: 1, healthErrors: 0 }
    },
    {
      entries: [{ type: "error" }],
      state: "degraded",
      code: "HEALTH_ERROR",
      metrics: { healthNotices: 0, healthWarnings: 0, healthErrors: 1 }
    }
  ];

  for (const service of ["radarr", "sonarr", "prowlarr"]) {
    for (const expectation of expectations) {
      const fixtures = baseFixtures();
      fixtures[service].health = expectation.entries;
      const result = await probeService(service, fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
      const health = result.checks.find(({ id }) => id === "health");
      assert.equal(health.state, expectation.state, `${service} ${expectation.entries[0].type}`);
      assert.equal(health.code, expectation.code, `${service} ${expectation.entries[0].type}`);
      assert.deepEqual(health.metrics, expectation.metrics, `${service} ${expectation.entries[0].type}`);
      assert.equal(result.connectionState, "connected", `${service} health must remain separate from authentication`);
    }
  }
});

test("returns the Arr services' own actionable health reports", async () => {
  const examples = {
    radarr: [
      {
        source: "DownloadClientCheck",
        type: "warning",
        message: "Download client qBittorrent places downloads in the root folder /data/downloads."
      },
      {
        source: "IndexerLongTermStatusCheck",
        type: "warning",
        message: "Indexers unavailable for more than 6 hours: ExampleIndexer (Prowlarr) at 10.44.1.20:9696."
      }
    ],
    sonarr: [
      { source: "ImportListSyncCheck", type: "notice", message: "List sync is delayed for Anime List." }
    ],
    prowlarr: [
      { source: "IndexerStatusCheck", type: "error", message: "1337x failed through proxy Byparr." }
    ]
  };

  for (const [service, health] of Object.entries(examples)) {
    const fixtures = baseFixtures();
    fixtures[service].health = health;
    const result = await probeService(service, fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
    const check = result.checks.find(({ id }) => id === "health");
    assert.deepEqual(check.reports, health.map(({ source, type, message }) => ({
      severity: type,
      source,
      message
    })));
  }

  const fixtures = baseFixtures();
  fixtures.radarr.health = [{ type: "warning", message: "A warning without a source." }];
  const fallback = await probeService("radarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.deepEqual(fallback.checks.find(({ id }) => id === "health").reports, [{
    severity: "warning",
    source: "Radarr health",
    message: "A warning without a source."
  }]);
});

test("bounds and sanitizes Arr health reports without losing operational details", async () => {
  assert.deepEqual(SERVICE_REPORT_LIMITS, {
    reportsPerCheck: 12,
    sourceCodePoints: 96,
    messageCodePoints: 600
  });
  assert.equal(Object.isFrozen(SERVICE_REPORT_LIMITS), true);

  const apiSecret = "aB3dE5fG7hJ9kL2mN4pQ6rS8tV0xY1zC";
  const bearerSecret = "eyJhbGciOiJIUzI1NiJ9.payloadPart123.signaturePart456";
  const cookieSecret = "s%3Aprivate-session-value-that-must-never-escape";
  const opaqueSecret = "credential-and-title-that-must-not-escape";
  const pathSecret = "Ab3Def5Gh7Jk9Lm2Np4Qr6St8Vx0Yz1Bc";
  const userinfoSecret = "temporary-login";
  const uuidSecret = "123e4567-e89b-42d3-a456-426614174000";
  const longSource = `Health<script>alert(1)</script>\u0000\u001b[31m ${"source ".repeat(40)}`;
  const longMessage = [
    "Indexer ExampleIndexer failed at http://10.44.1.20:9696 and path /data/downloads/movies.",
    `<img src=x onerror=alert(1)>\r\nSecond line\u0007`,
    `apiKey=${apiSecret}&safe=true`,
    `Authorization: Bearer ${bearerSecret}`,
    `Cookie: connect.sid=${cookieSecret}; Path=/`,
    `URL http://admin:super-secret-password@10.44.1.20:7878/api/v3/health`,
    `single userinfo https://${userinfoSecret}@10.44.1.20:7878/api/v3/health`,
    `opaque ${opaqueSecret}`,
    `request ${uuidSecret}`,
    `webhook http://10.44.1.20:7878/hooks/${pathSecret}/notify`,
    "x".repeat(900)
  ].join(" ");
  const fixtures = baseFixtures();
  fixtures.radarr.health = Array.from({ length: 15 }, (_, index) => ({
    type: index === 0 ? "error" : "warning",
    source: index === 0 ? longSource : `Check ${index}`,
    message: index === 0 ? longMessage : `Report ${index} for /data/downloads and 1337x.`
  }));

  const result = await probeService("radarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  const check = result.checks.find(({ id }) => id === "health");
  assert.equal(check.metrics.healthErrors, 1);
  assert.equal(check.metrics.healthWarnings, 14, "report display cap must not change health counters");
  assert.equal(check.reports.length, SERVICE_REPORT_LIMITS.reportsPerCheck);
  assert.deepEqual(Object.keys(check.reports[0]), ["severity", "source", "message"]);
  assert.equal(check.reports[0].severity, "error");
  assert.ok(Array.from(check.reports[0].source).length <= SERVICE_REPORT_LIMITS.sourceCodePoints);
  assert.ok(Array.from(check.reports[0].message).length <= SERVICE_REPORT_LIMITS.messageCodePoints);
  assert.match(check.reports[0].message, /ExampleIndexer/u);
  assert.match(check.reports[0].message, /10\.44\.1\.20:9696/u);
  assert.match(check.reports[0].message, /\/data\/downloads\/movies/u);
  assert.match(check.reports[0].message, /\[REDACTED\]/u);
  assert.doesNotMatch(check.reports[0].source, /[<>\u0000-\u001f\u007f-\u009f]/u);
  assert.doesNotMatch(check.reports[0].message, /[<>\u0000-\u001f\u007f-\u009f]/u);
  const serialized = JSON.stringify(check.reports);
  for (const secret of [apiSecret, bearerSecret, cookieSecret, opaqueSecret, pathSecret, userinfoSecret, uuidSecret, "super-secret-password"]) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});

test("redacts short labelled credentials while retaining ordinary diagnostic states", async () => {
  const secrets = ["smallCredential7", "shortAuth8", "tiny pass 9", "shortToken0"];
  const fixtures = baseFixtures();
  fixtures.radarr.health = [
    { source: "CredentialCheck", type: "warning", message: `credential=${secrets[0]}` },
    { source: "AuthCheck", type: "warning", message: `request?auth=${secrets[1]}&mode=test` },
    { source: "PasswordCheck", type: "warning", message: `password is "${secrets[2]}"` },
    { source: "TokenCheck", type: "warning", message: `access token was ${secrets[3]}` },
    { source: "StateCheck", type: "warning", message: "Password is invalid; token refresh is unavailable." }
  ];

  const result = await probeService("radarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  const reports = result.checks.find(({ id }) => id === "health").reports;
  const serialized = JSON.stringify(reports);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  assert.equal(reports.slice(0, 4).every(({ message }) => message.includes("[REDACTED]")), true);
  assert.equal(reports[4].message, "Password is invalid; token refresh is unavailable.");
});

test("uses curated failure reports and never reflects failed, malformed, or unrelated endpoint bodies", async () => {
  const fixtures = baseFixtures();
  const failureSecret = "Error body API key=do-not-copy-this-secret-123456789";
  const failed = await probeService("radarr", fixtureTransport(fixtures, {
    "radarr:health": {
      status: 500,
      body: [{ source: "Injected", type: "error", message: failureSecret }],
      latencyMs: 2
    },
    "radarr:queue": {
      status: 200,
      body: { totalRecords: 1, records: [{ status: "failed", message: failureSecret }] },
      latencyMs: 2
    }
  }), { checkedAt: CHECKED_AT });
  assert.deepEqual(failed.checks.find(({ id }) => id === "health").reports, [{
    severity: "error",
    source: "Radarr · Application health",
    message: "GET /api/v3/health returned HTTP 500. Radarr reported a server-side failure; review its logs and retry."
  }]);
  assert.equal(Object.hasOwn(failed.checks.find(({ id }) => id === "queue"), "reports"), false);
  assert.equal(JSON.stringify(failed).includes(failureSecret), false);

  fixtures.sonarr.health = [{ source: "Injected", type: "future-severity", message: failureSecret }];
  const malformed = await probeService("sonarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  const malformedHealth = malformed.checks.find(({ id }) => id === "health");
  assert.equal(malformedHealth.code, "INVALID_RESPONSE");
  assert.deepEqual(malformedHealth.reports, [{
    severity: "error",
    source: "Sonarr · Application health",
    message: "GET /api/v3/health returned a response Helmsman could not safely accept. Verify the Sonarr version, base URL, and reverse-proxy configuration."
  }]);

  fixtures.prowlarr.health = [{ source: "NoMessageCheck", type: "warning" }];
  const missingMessage = await probeService("prowlarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.equal(Object.hasOwn(missingMessage.checks.find(({ id }) => id === "health"), "reports"), false);
});

test("rejects unknown Arr health types but preserves Bazarr's untyped issue format", async () => {
  for (const service of ["radarr", "sonarr", "prowlarr"]) {
    const fixtures = baseFixtures();
    fixtures[service].health = [{ type: "future-severity", message: RAW_SECRET }];
    const result = await probeService(service, fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
    const health = result.checks.find(({ id }) => id === "health");
    assert.equal(health.state, "degraded", service);
    assert.equal(health.code, "INVALID_RESPONSE", service);
    assert.equal(Object.hasOwn(health, "metrics"), false, service);
  }

  const fixtures = baseFixtures();
  fixtures.bazarr.health = { data: [{ message: RAW_SECRET }] };
  const bazarr = await probeService("bazarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  const health = bazarr.checks.find(({ id }) => id === "health");
  assert.equal(health.state, "limited");
  assert.equal(health.code, "HEALTH_WARNING");
  assert.deepEqual(health.metrics, { healthNotices: 0, healthWarnings: 1, healthErrors: 0 });
  assert.equal(JSON.stringify(bazarr).includes(RAW_SECRET), false);
});

test("recognizes current Arr queue status and tracked-download state enums", async () => {
  const fixtures = baseFixtures();
  fixtures.sonarr.queue = {
    totalRecords: 5,
    records: [
      { status: "downloadClientUnavailable" },
      { status: "Warning" },
      { trackedDownloadState: "Failed" },
      { trackedDownloadState: "FailedPending" },
      { status: "completed", trackedDownloadStatus: "Warning" }
    ]
  };
  const sonarr = await probeService("sonarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  const queue = sonarr.checks.find(({ id }) => id === "queue");
  assert.equal(queue.state, "degraded");
  assert.deepEqual(queue.metrics, {
    queueTotal: 5,
    queueFailed: 3,
    queueStalled: 0,
    importsBlocked: 2
  });
});

test("derives actionable Arr, indexer, and download counters without media identity", async () => {
  const fixtures = baseFixtures();
  fixtures.radarr.health = [{ type: "warning", message: RAW_SECRET }, { type: "error", message: RAW_SECRET }];
  fixtures.radarr.queue = {
    totalRecords: 3,
    records: [
      { status: "failed", title: RAW_SECRET },
      { status: "stalled", title: RAW_SECRET },
      { status: "completed", trackedDownloadStatus: "warning", trackedDownloadState: "importBlocked", title: RAW_SECRET }
    ]
  };
  const radarr = await probeService("radarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.equal(radarr.state, "degraded");
  assert.deepEqual(radarr.metrics, {
    healthNotices: 0,
    healthWarnings: 1,
    healthErrors: 1,
    queueTotal: 3,
    queueFailed: 1,
    queueStalled: 1,
    importsBlocked: 1
  });
  assert.deepEqual(radarr.checks.find(({ id }) => id === "queue").stages, ["imports"]);
  assert.deepEqual(radarr.checks.find(({ id }) => id === "queue").metrics, {
    queueTotal: 3,
    queueFailed: 1,
    queueStalled: 1,
    importsBlocked: 1
  });

  fixtures.prowlarr.indexers = [
    { id: 1, name: RAW_SECRET },
    { id: 2, name: RAW_SECRET, disabledTill: "2026-09-14T00:00:00.000Z", mostRecentFailure: RAW_SECRET }
  ];
  const prowlarr = await probeService("prowlarr", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.equal(prowlarr.state, "limited");
  assert.deepEqual(prowlarr.metrics, {
    healthNotices: 0,
    healthWarnings: 0,
    healthErrors: 0,
    indexersBlocked: 2
  });
  const indexers = prowlarr.checks.find(({ id }) => id === "indexers");
  assert.equal(indexers.state, "limited");
  assert.equal(indexers.code, "INDEXERS_BLOCKED");

  fixtures.qbittorrent.transfer.connection_status = "disconnected";
  fixtures.qbittorrent.torrents = [
    { state: "stalledDL", progress: 0.4, name: RAW_SECRET },
    { state: "stalledUP", progress: 1, name: RAW_SECRET },
    { state: "pausedUP", progress: 1, name: RAW_SECRET },
    { state: "missingFiles", progress: 0.2, name: RAW_SECRET }
  ];
  const qbit = await probeService("qbittorrent", fixtureTransport(fixtures), { checkedAt: CHECKED_AT });
  assert.equal(qbit.state, "degraded");
  assert.deepEqual(qbit.metrics, {
    downloadSpeedBps: 1024,
    uploadSpeedBps: 0,
    connectionStatus: "disconnected",
    torrentsTotal: 4,
    downloading: 0,
    stalled: 1,
    errored: 1,
    paused: 1,
    completed: 2
  });
  assert.equal(JSON.stringify(qbit).includes(RAW_SECRET), false);
});

test("an externally cancelled probe is stale and never calls the transport", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await probeService("bazarr", async () => {
    calls += 1;
    throw new Error("must not run");
  }, { signal: controller.signal, checkedAt: CHECKED_AT, clock: () => 0 });
  assert.equal(calls, 0);
  assert.equal(result.state, "stale");
  assert.ok(result.checks.every(({ state, code }) => state === "stale" && code === "CHECK_CANCELLED"));
});
