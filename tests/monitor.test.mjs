import assert from "node:assert/strict";
import test from "node:test";
import { createHealthIncidentEngine } from "../server/health-engine.mjs";
import {
  createOperationsMonitor,
  MONITOR_INTERVAL_LIMITS,
  OperationsMonitor,
  PIPELINE_STAGES
} from "../server/monitor.mjs";

const START = Date.parse("2026-09-12T20:00:00.000Z");
const RADARR_TARGET_REVISION = "22222222-2222-4222-8222-222222222222";
const JELLYFIN_TARGET_REVISION = "11111111-1111-4111-8111-111111111111";

test("monitor creates a serializable, sanitized operations snapshot and feeds the incident engine", async () => {
  let clock = START;
  const secret = "qbt_ThisMustNeverAppearInMonitoring";
  const username = "private-admin-username";
  const engine = createHealthIncidentEngine({
    failureThreshold: 1,
    now: () => clock,
    idFactory: () => "incident-1"
  });
  const monitor = createOperationsMonitor({
    now: () => clock,
    incidentEngine: engine,
    loadServices: async () => [
      {
        id: "jellyfin",
        url: "https://" + `${username}:${secret}@media.example.test/?api_key=${secret}`,
        authorization: `Bearer ${secret}`,
        password: secret
      },
      { id: "seerr", apiKey: secret, username },
      { id: username, token: secret },
      { id: "disabled-secret", enabled: false, token: secret }
    ],
    probe: async (service) => {
      clock += 5;
      if (service.id === "jellyfin") {
        return {
          connectionState: "connected",
          latencyMs: 11,
          body: `raw body ${secret}`,
          headers: { authorization: `Bearer ${secret}` },
          username,
          checks: [
            { id: "status", ok: true, impact: "critical", stage: "library", message: username },
            {
              id: "artwork",
              ok: false,
              impact: "optional",
              code: "HTTP_ERROR",
              status: 404,
              stage: "library",
              body: secret,
              metrics: { failed: 3, arbitrarySecretMetric: 99 }
            }
          ]
        };
      }
      return {
        connectionState: "connected",
        checks: [
          { id: "requests", ok: true, stage: "requests", metrics: { waiting: 2 } },
          { id: "trending", ok: false, impact: "optional", code: "HTTP_ERROR", status: 503, stage: "discovery" }
        ],
        response: { url: `https://example.test/?token=${secret}`, body: secret }
      };
    }
  });

  const snapshot = await monitor.refresh();
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)));
  assert.equal(snapshot.generatedAt, "2026-09-12T20:00:00.010Z");
  assert.deepEqual(snapshot.services.map(({ id }) => id), ["jellyfin", "seerr"]);
  assert.equal(snapshot.services[0].state, "limited");
  assert.equal(snapshot.services[0].connectionState, "connected");
  assert.equal(snapshot.services[0].latencyMs, 11);
  assert.deepEqual(snapshot.services[0].checks[1], {
    id: "artwork",
    state: "limited",
    ok: false,
    impact: "optional",
    code: "HTTP_ERROR",
    httpStatus: 404,
    latencyMs: 10,
    checkedAt: "2026-09-12T20:00:00.010Z",
    stages: ["library"],
    metrics: { failed: 3 },
    service: "jellyfin"
  });
  assert.equal(snapshot.overall.state, "limited");
  assert.equal(snapshot.overall.affectedServiceCount, 2);
  assert.equal(snapshot.incidents.open.length, 2);
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "requests").state, "healthy");
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "library").state, "limited");
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "downloads").state, "stale");
  assert.equal(snapshot.history.length, 1);

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(username), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("api_key"), false);
  assert.equal(serialized.includes("raw body"), false);
  assert.equal(serialized.includes("arbitrarySecretMetric"), false);
  assert.equal(serialized.includes("https://"), false);
});

test("serves a cached initial snapshot until the first live cycle replaces it", async () => {
  const cached = {
    version: 1,
    generatedAt: "2026-09-12T19:59:00.000Z",
    cache: {
      state: "cached",
      storedAt: "2026-09-12T19:59:05.000Z",
      generatedAt: "2026-09-12T19:59:00.000Z"
    },
    overall: { state: "healthy", serviceCount: 0, affectedServiceCount: 0, openIncidentCount: 0, code: null },
    services: [],
    pipeline: { state: "healthy", stages: [] },
    infrastructure: { state: "healthy", environments: [], services: [], portainer: [], loki: [] },
    incidents: { open: [], recent: [] },
    media: { generatedAt: "2026-09-12T19:59:00.000Z", records: [], artwork: {} },
    workload: {},
    events: [],
    history: []
  };
  const monitor = createOperationsMonitor({
    initialSnapshot: cached,
    now: () => START,
    loadServices: async () => [],
    probe: async () => ({ ok: true })
  });

  assert.deepEqual(monitor.getSnapshot().cache, cached.cache);
  const live = await monitor.refresh();
  assert.equal(live.cache, undefined);
  assert.equal(live.generatedAt, "2026-09-12T20:00:00.000Z");
});

test("refresh calls are coalesced and scheduled cycles never overlap", async () => {
  let active = 0;
  let maximumActive = 0;
  let probeCalls = 0;
  const pending = [];
  const scheduled = [];
  const cleared = [];
  const monitor = new OperationsMonitor({
    intervalMs: 45_000,
    loadServices: () => [{ id: "jellyfin" }],
    probe: (_service, context) => new Promise((resolve) => {
      probeCalls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      pending.push({
        signal: context.signal,
        resolve: () => {
          active -= 1;
          resolve({ ok: true, latencyMs: 4 });
        }
      });
    }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer)
  });

  const first = monitor.start();
  const coalesced = monitor.refresh();
  assert.strictEqual(coalesced, first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 1);
  assert.equal(maximumActive, 1);
  pending.shift().resolve();
  await first;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 45_000);

  scheduled.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 2);
  const second = monitor.refresh();
  assert.equal(maximumActive, 1);
  monitor.stop();
  assert.equal(pending[0].signal.aborted, true);
  pending.shift().resolve();
  await second;
  assert.equal(monitor.getSnapshot().services[0].state, "healthy");
  assert.equal(scheduled.length, 0);
  assert.equal(cleared.length, 0);
});

test("a full seven-service cycle bounds parallel service probes", async () => {
  let active = 0;
  let maximumActive = 0;
  const monitor = createOperationsMonitor({
    loadServices: () => [
      "jellyfin",
      "seerr",
      "radarr",
      "sonarr",
      "prowlarr",
      "qbittorrent",
      "bazarr"
    ].map((id) => ({ id })),
    probe: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { ok: true };
    }
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services.length, 7);
  assert.equal(maximumActive, 4);
});

test("publishes a bounded media model from sanitized per-service inventory", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [
      { id: "radarr", targetRevision: RADARR_TARGET_REVISION },
      { id: "jellyfin", targetRevision: JELLYFIN_TARGET_REVISION }
    ],
    probe: ({ id }) => ({
      ok: true,
      connectionState: "connected",
      inventory: id === "radarr" ? {
        library: [{
          service: "radarr",
          sourceId: "7",
          mediaType: "movie",
          title: "A Movie",
          year: 2026,
          providerIds: { tmdb: 700 },
          monitored: true,
          imported: true,
          artwork: { service: "radarr", kind: "poster", resource: "7", variant: "poster-250" },
          ignored: "https://" + "admin:secret@example.invalid"
        }]
      } : {
        library: [{
          service: "jellyfin",
          sourceId: "abcdef0123456789abcdef0123456789",
          mediaType: "movie",
          title: "A Movie",
          year: 2026,
          providerIds: { tmdb: 700 },
          available: true,
          artwork: {
            service: "jellyfin",
            kind: "primary",
            resource: "abcdef0123456789abcdef0123456789",
            revision: "abcdef0123456789abcdef0123456789",
            variant: "w342q85"
          }
        }]
      }
    })
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.media.schema, 1);
  assert.equal(snapshot.media.records.length, 1);
  assert.equal(snapshot.media.records[0].lifecycle.stage, "available");
  assert.deepEqual(snapshot.media.records[0].sources, ["jellyfin", "radarr"]);
  assert.match(snapshot.media.records[0].artworkUrl, /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u);
  assert.equal(JSON.stringify(snapshot).includes("admin:secret"), false);
});

test("partial media-inventory failures stay visible without degrading service or pipeline health", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "radarr" }],
    probe: () => ({
      state: "healthy",
      connectionState: "connected",
      checks: [
        { id: "status", state: "healthy", importance: "core", stages: ["search", "imports"] },
        {
          id: "catalog",
          state: "limited",
          importance: "optional",
          code: "HTTP_ERROR",
          status: 404,
          stages: ["imports"],
          affectsHealth: false,
          reports: [{ severity: "warning", source: "Radarr · Movie catalog", message: "The read-only catalog endpoint was not found." }]
        }
      ]
    })
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services[0].state, "healthy");
  assert.equal(snapshot.services[0].checks[1].state, "limited");
  assert.equal(snapshot.services[0].checks[1].reports.length, 1);
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "imports").state, "healthy");
  assert.equal(snapshot.incidents.open.length, 0);
});

test("monitor publishes missing-unit completeness for partially imported series", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "sonarr" }],
    probe: () => ({
      ok: true,
      connectionState: "connected",
      inventory: {
        library: [{
          service: "sonarr",
          sourceId: "90",
          mediaType: "series",
          title: "Partial Series",
          providerIds: { tvdb: 900 },
          monitored: true,
          imported: true,
          missingCount: 9
        }]
      }
    })
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.media.records[0].lifecycle.stage, "imported");
  assert.equal(snapshot.media.home.missing[0].missingCount, 9);
  assert.deepEqual({
    missingTotal: snapshot.media.metrics.missingTotal,
    missingMovies: snapshot.media.metrics.missingMovies,
    missingEpisodes: snapshot.media.metrics.missingEpisodes
  }, { missingTotal: 9, missingMovies: 0, missingEpisodes: 9 });
});

test("monitor exposes bounded Now Playing media without Jellyfin session metadata", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "jellyfin" }],
    probe: () => ({
      ok: true,
      connectionState: "connected",
      inventory: {
        nowPlaying: [{
          service: "jellyfin",
          sourceId: "abcdef0123456789abcdef0123456789",
          mediaType: "movie",
          title: "Playing Movie",
          providerIds: { tmdb: 505 },
          available: true,
          state: "playing",
          progress: 50,
          username: "must-not-survive",
          deviceName: "must-not-survive"
        }]
      }
    })
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.media.home.nowPlaying.length, 1);
  assert.equal(snapshot.media.home.nowPlaying[0].mediaId, "movie:tmdb:505");
  assert.equal(snapshot.media.home.nowPlaying[0].state, "playing");
  assert.equal(snapshot.media.metrics.nowPlayingTotal, 1);
  assert.equal(JSON.stringify(snapshot).includes("must-not-survive"), false);
});

test("the fallback incident adapter deduplicates failures and records recovery", async () => {
  let clock = START;
  let failing = true;
  const monitor = createOperationsMonitor({
    now: () => clock,
    loadServices: () => [{ id: "qbittorrent" }],
    probe: () => failing
      ? { ok: false, code: "ECONNREFUSED", state: "down", impact: "critical" }
      : { ok: true }
  });

  let snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "down");
  assert.equal(snapshot.incidents.open.length, 0);
  clock += 30_000;
  snapshot = await monitor.refresh();
  assert.equal(snapshot.incidents.open.length, 1);
  assert.equal(snapshot.incidents.open[0].occurrenceCount, 2);
  assert.equal(snapshot.incidents.open[0].code, "ECONNREFUSED");

  failing = false;
  clock += 30_000;
  snapshot = await monitor.refresh();
  assert.equal(snapshot.incidents.open.length, 0);
  assert.equal(snapshot.incidents.recent.length, 1);
  assert.equal(snapshot.incidents.recent[0].state, "healthy");
  assert.equal(snapshot.incidents.recent[0].recoveredAt, "2026-09-12T20:01:00.000Z");
});

test("monitor accepts the sanitized service-probe schema without retaining its transport inputs", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "radarr" }],
    probe: () => ({
      schema: 1,
      service: "radarr",
      state: "degraded",
      connectionState: "connected",
      checkedAt: "2026-09-12T20:00:00.000Z",
      version: "v6.3.0.10514",
      latencyMs: 247,
      checks: [
        { id: "status", importance: "core", state: "healthy", status: 200, code: null, latencyMs: 50, stages: ["search", "imports"] },
        { id: "health", importance: "important", state: "healthy", status: 200, code: null, latencyMs: 60, stages: ["search", "imports"] },
        {
          id: "queue",
          importance: "important",
          state: "degraded",
          status: 200,
          code: "INVALID_RESPONSE",
          latencyMs: 247,
          stages: ["imports"],
          metrics: { queueTotal: 8, queueFailed: 1, importsBlocked: 2 }
        }
      ],
      metrics: { queueTotal: 8, queueFailed: 1, importsBlocked: 2, untrusted: "secret" }
    })
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services[0].state, "degraded");
  assert.equal(snapshot.services[0].connectionState, "connected");
  assert.equal(snapshot.services[0].version, "v6.3.0.10514");
  assert.equal(snapshot.services[0].checks[0].impact, "critical");
  assert.equal(snapshot.services[0].checks[2].code, "INVALID_RESPONSE");
  assert.deepEqual(snapshot.services[0].metrics, {
    importsBlocked: 2,
    queueFailed: 1,
    queueTotal: 8
  });
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "search").state, "healthy");
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "search").metrics.importsBlocked, undefined);
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "imports").state, "degraded");
  assert.equal(snapshot.pipeline.stages.find(({ id }) => id === "imports").metrics.importsBlocked, 2);
  assert.equal(JSON.stringify(snapshot).includes("untrusted"), false);
});

test("monitor preserves Arr health semantics without inventing CHECK_FAILED or HTTP 200 failures", async () => {
  const engine = createHealthIncidentEngine({ failureThreshold: 1, now: () => START });
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine: engine,
    loadServices: () => ["radarr", "sonarr", "prowlarr"].map((id) => ({ id })),
    probe: ({ id }) => {
      const health = id === "radarr"
        ? {
            state: "limited",
            code: "HEALTH_WARNING",
            metrics: { healthNotices: 0, healthWarnings: 1, healthErrors: 0 }
          }
        : id === "sonarr"
          ? {
              state: "degraded",
              code: "HEALTH_ERROR",
              metrics: { healthNotices: 0, healthWarnings: 0, healthErrors: 1 }
            }
          : {
              state: "healthy",
              code: null,
              metrics: { healthNotices: 1, healthWarnings: 0, healthErrors: 0 }
            };
      return {
        schema: 1,
        service: id,
        state: health.state,
        connectionState: "connected",
        checkedAt: "2026-09-12T20:00:00.000Z",
        checks: [{
          id: "health",
          importance: "important",
          status: 200,
          stages: ["search"],
          ...health
        }],
        metrics: health.metrics
      };
    }
  });

  const snapshot = await monitor.refresh();
  const radarr = snapshot.services.find(({ id }) => id === "radarr");
  const sonarr = snapshot.services.find(({ id }) => id === "sonarr");
  const prowlarr = snapshot.services.find(({ id }) => id === "prowlarr");
  assert.deepEqual(
    [radarr.checks[0].state, radarr.checks[0].code, radarr.checks[0].httpStatus],
    ["limited", "HEALTH_WARNING", null]
  );
  assert.deepEqual(
    [sonarr.checks[0].state, sonarr.checks[0].code, sonarr.checks[0].httpStatus],
    ["degraded", "HEALTH_ERROR", null]
  );
  assert.deepEqual(prowlarr.checks[0].metrics, {
    healthErrors: 0,
    healthNotices: 1,
    healthWarnings: 0
  });
  assert.equal(prowlarr.state, "healthy");
  assert.deepEqual(
    snapshot.incidents.open.map(({ code, httpStatus }) => [code, httpStatus]).sort(),
    [["HEALTH_ERROR", null], ["HEALTH_WARNING", null]]
  );
  assert.equal(snapshot.incidents.open.some(({ code }) => code === "CHECK_FAILED"), false);
});

test("monitor retains blocked-indexer evidence as a limited Prowlarr condition", async () => {
  const engine = createHealthIncidentEngine({ failureThreshold: 1, now: () => START });
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine: engine,
    loadServices: () => [{ id: "prowlarr" }],
    probe: () => ({
      schema: 1,
      service: "prowlarr",
      state: "limited",
      connectionState: "connected",
      checkedAt: "2026-09-12T20:00:00.000Z",
      checks: [{
        id: "indexers",
        importance: "important",
        state: "limited",
        status: 200,
        code: "INDEXERS_BLOCKED",
        stages: ["search"],
        metrics: { indexersBlocked: 2 }
      }],
      metrics: { indexersBlocked: 2 }
    })
  });

  const snapshot = await monitor.refresh();
  const service = snapshot.services[0];
  assert.equal(service.state, "limited");
  assert.deepEqual(service.metrics, { indexersBlocked: 2 });
  assert.deepEqual(service.checks[0].metrics, { indexersBlocked: 2 });
  assert.equal(service.checks[0].code, "INDEXERS_BLOCKED");
  assert.equal(service.checks[0].httpStatus, null);
  assert.equal(snapshot.incidents.open[0].code, "INDEXERS_BLOCKED");
  assert.equal(snapshot.incidents.open[0].httpStatus, null);
});

test("current check reports are bounded, defensively sanitized, and never retained as incident evidence", async () => {
  const secret = "qbt_ThisMustNeverAppearInReportEvidence_123456";
  const pathSecret = "Ab3Def5Gh7Jk9Lm2Np4Qr6St8Vx0Yz1Bc";
  const userinfoSecret = "temporary-login";
  const marker = "CURRENT_REPORT_ONLY_MARKER";
  const observed = [];
  const incidentEngine = {
    recordResult(result) {
      observed.push(structuredClone(result));
    },
    snapshot() {
      return { incidents: [], recentRecoveries: [], recentTransitions: [] };
    }
  };
  let includeReports = true;
  const reports = Array.from({ length: 14 }, (_, index) => ({
    severity: index % 3 === 0 ? "notice" : index % 3 === 1 ? "warning" : "error",
    source: index === 0 ? `Radarr<health>\n${"s".repeat(160)}` : `health-${index}`,
    message: index === 0
      ? `${marker}\nauthorization: Bearer ${secret} webhook /hooks/${pathSecret}/notify https://${userinfoSecret}@service.test/status /data/downloads ${"m".repeat(700)}`
      : `Current service report ${index}`,
    rawBody: secret,
    credential: secret
  }));
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [{ id: "radarr" }],
    probe: () => ({
      state: "limited",
      connectionState: "connected",
      checks: [{
        id: "health",
        state: "limited",
        importance: "important",
        code: "HEALTH_WARNING",
        reports: includeReports ? reports : undefined
      }]
    })
  });

  let snapshot = await monitor.refresh();
  const retained = snapshot.services[0].checks[0].reports;
  assert.equal(retained.length, 12);
  assert.deepEqual(Object.keys(retained[0]).sort(), ["message", "severity", "source"]);
  assert.equal(retained[0].severity, "notice");
  assert.equal(retained[0].source.includes("<"), false);
  assert.equal(retained[0].source.includes(">"), false);
  assert.equal(retained[0].source.includes("\n"), false);
  assert.ok([...retained[0].source].length <= 96);
  assert.ok([...retained[0].message].length <= 600);
  assert.equal(JSON.stringify(retained).includes(secret), false);
  assert.equal(JSON.stringify(retained).includes(pathSecret), false);
  assert.equal(JSON.stringify(retained).includes(userinfoSecret), false);
  assert.equal(retained[0].message.includes("/data/downloads"), true);
  assert.equal(retained[0].message.includes("[REDACTED]"), true);

  assert.equal(observed.some((entry) => Object.hasOwn(entry, "reports")), false);
  for (const retainedArea of [
    snapshot.overall,
    snapshot.pipeline,
    snapshot.incidents,
    snapshot.workload,
    snapshot.events,
    snapshot.history
  ]) {
    assert.equal(JSON.stringify(retainedArea).includes(marker), false);
  }

  includeReports = false;
  snapshot = await monitor.refresh();
  assert.equal(Object.hasOwn(snapshot.services[0].checks[0], "reports"), false);
  assert.equal(JSON.stringify(snapshot).includes(marker), false);
});

test("malformed check reports are discarded without changing health state", async () => {
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "sonarr" }],
    probe: () => ({
      state: "healthy",
      connectionState: "connected",
      checks: [{
        id: "health",
        state: "healthy",
        importance: "important",
        reports: [
          null,
          "not-an-object",
          { severity: "future", source: "health", message: "unsupported severity" },
          { severity: "warning", source: "", message: "empty source" },
          { severity: "warning", source: "health", message: 42 }
        ]
      }]
    })
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services[0].state, "healthy");
  assert.equal(Object.hasOwn(snapshot.services[0].checks[0], "reports"), false);
});

test("report accessors cannot fail a healthy service or bypass redaction", async () => {
  const throwingReport = { severity: "warning", message: "unused" };
  Object.defineProperty(throwingReport, "source", {
    enumerable: true,
    get() { throw new Error("report source getter must stay isolated"); }
  });
  const inheritedReport = Object.create({
    severity: "warning",
    source: "inherited",
    message: "must not be accepted"
  });
  const statusCheck = { id: "status", state: "healthy", importance: "critical" };
  Object.defineProperty(statusCheck, "reports", {
    enumerable: true,
    get() { throw new Error("report collection getter must stay isolated"); }
  });
  const shortSecrets = ["smallCredential7", "shortAuth8", "tiny pass 9", "shortToken0"];
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [{ id: "radarr" }],
    probe: () => ({
      state: "healthy",
      connectionState: "connected",
      checks: [statusCheck, {
        id: "health",
        state: "healthy",
        importance: "important",
        reports: [
          throwingReport,
          inheritedReport,
          { severity: "warning", source: "credential", message: `credential=${shortSecrets[0]}` },
          { severity: "warning", source: "auth", message: `request?auth=${shortSecrets[1]}&mode=test` },
          { severity: "warning", source: "password", message: `password is "${shortSecrets[2]}"` },
          { severity: "warning", source: "token", message: `access token was ${shortSecrets[3]}` },
          { severity: "warning", source: "state", message: "Password is invalid; token refresh is unavailable." }
        ]
      }]
    })
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.services[0].state, "healthy");
  assert.equal(Object.hasOwn(snapshot.services[0].checks[0], "reports"), false);
  const reports = snapshot.services[0].checks[1].reports;
  assert.equal(reports.length, 5);
  const serialized = JSON.stringify(reports);
  for (const secret of shortSecrets) assert.equal(serialized.includes(secret), false, `snapshot leaked ${secret}`);
  assert.equal(reports.slice(0, 4).every(({ message }) => message.includes("[REDACTED]")), true);
  assert.equal(reports[4].message, "Password is invalid; token refresh is unavailable.");
});

test("history is bounded and contains derived status only", async () => {
  let clock = START;
  let calls = 0;
  const monitor = createOperationsMonitor({
    historyLimit: 2,
    now: () => clock,
    loadServices: () => [{ id: "radarr", apiKey: "history-secret" }],
    probe: () => ({ ok: calls++ > 0, code: "HTTP_ERROR", body: "history-secret" })
  });
  await monitor.refresh();
  clock += 30_000;
  await monitor.refresh();
  clock += 30_000;
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.history.length, 2);
  assert.deepEqual(snapshot.history.map(({ generatedAt }) => generatedAt), [
    "2026-09-12T20:00:30.000Z",
    "2026-09-12T20:01:00.000Z"
  ]);
  assert.equal(JSON.stringify(snapshot.history).includes("history-secret"), false);
  assert.deepEqual(Object.keys(snapshot.history[0]).sort(), [
    "generatedAt",
    "openIncidentCount",
    "overallState",
    "pipelineStates",
    "serviceStates"
  ]);
});

test("service-loader failures are sanitized, published, and recover cleanly", async () => {
  let clock = START;
  let fail = true;
  const received = [];
  const monitor = createOperationsMonitor({
    now: () => clock,
    loadServices: () => {
      if (fail) throw Object.assign(new Error("Bearer must-not-leak"), { code: "qbt_MUST_NOT_LEAK_SECRET" });
      return [{ id: "jellyfin" }];
    },
    probe: () => ({ ok: true }),
    incidentEngine: createHealthIncidentEngine({ failureThreshold: 1, now: () => clock })
  });
  monitor.subscribe((snapshot) => {
    received.push(snapshot);
    snapshot.overall.state = "tampered-by-listener";
    throw new Error("subscriber failure");
  });

  let snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "down");
  assert.equal(snapshot.overall.code, "SERVICE_LOAD_FAILED");
  assert.equal(snapshot.incidents.open.length, 1);
  assert.equal(JSON.stringify(snapshot).includes("MUST_NOT_LEAK"), false);
  assert.equal(monitor.getSnapshot().overall.state, "down");

  fail = false;
  clock += 30_000;
  snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "healthy");
  assert.equal(snapshot.incidents.open.length, 0);
  assert.ok(snapshot.incidents.recent.some(({ service, capability }) => (
    service === "helmsman" && capability === "service_loader"
  )));
  assert.equal(received.length, 2);
});

test("disabled services retire their capabilities and open incidents", async () => {
  let clock = START;
  let radarrEnabled = true;
  const engine = createHealthIncidentEngine({ failureThreshold: 2, staleAfterMs: 60_000, now: () => clock });
  const monitor = createOperationsMonitor({
    now: () => clock,
    incidentEngine: engine,
    loadServices: () => [
      { id: "jellyfin" },
      { id: "radarr", enabled: radarrEnabled }
    ],
    probe: (service) => ({
      checks: [{
        id: "status",
        ok: service.id === "jellyfin",
        state: service.id === "jellyfin" ? "healthy" : "down",
        impact: "critical",
        code: service.id === "jellyfin" ? null : "UNREACHABLE",
        stage: service.id === "jellyfin" ? "library" : "search"
      }]
    })
  });

  await monitor.refresh();
  clock += 30_000;
  let snapshot = await monitor.refresh();
  assert.equal(snapshot.incidents.open.some(({ service }) => service === "radarr"), true);

  radarrEnabled = false;
  clock += 30_000;
  snapshot = await monitor.refresh();
  assert.deepEqual(snapshot.services.map(({ id }) => id), ["jellyfin"]);
  assert.equal(snapshot.overall.state, "healthy");
  assert.equal(snapshot.overall.openIncidentCount, 0);
  assert.equal(snapshot.incidents.open.some(({ service }) => service === "radarr"), false);
  assert.equal(snapshot.events.some(({ service, type }) => service === "radarr" && type === "retired"), true);

  clock += 10 * 60_000;
  snapshot = await monitor.refresh();
  assert.equal(snapshot.incidents.open.some(({ service }) => service === "radarr"), false);
});

test("configuration enforces the 30 to 60 second polling contract", () => {
  assert.deepEqual(MONITOR_INTERVAL_LIMITS, {
    minimumMs: 30_000,
    maximumMs: 60_000,
    defaultMs: 30_000
  });
  assert.equal(PIPELINE_STAGES.length, 6);
  const base = { loadServices: () => [], probe: async () => ({ ok: true }) };
  assert.throws(() => new OperationsMonitor({ ...base, intervalMs: 29_999 }), /between 30000 and 60000/u);
  assert.throws(() => new OperationsMonitor({ ...base, intervalMs: 60_001 }), /between 30000 and 60000/u);
  assert.doesNotThrow(() => new OperationsMonitor({ ...base, intervalMs: 60_000 }));
});
