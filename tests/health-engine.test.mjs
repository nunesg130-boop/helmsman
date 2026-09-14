import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_IMPACTS,
  createHealthIncidentEngine,
  HEALTH_STATES,
  HealthIncidentEngine
} from "../server/health-engine.mjs";

function fixture(options = {}) {
  let clock = Date.parse("2026-09-12T12:00:00.000Z");
  let sequence = 0;
  const transitions = [];
  const dependencies = [];
  const engine = createHealthIncidentEngine({
    now: () => clock,
    idFactory: () => `incident-${++sequence}`,
    onTransition: (event) => transitions.push(event),
    onDependencyChange: (event) => dependencies.push(event),
    ...options
  });
  return {
    engine,
    transitions,
    dependencies,
    now: () => clock,
    advance: (milliseconds) => { clock += milliseconds; return clock; }
  };
}

function fail(engine, values = {}) {
  return engine.recordResult({
    service: "seerr",
    capability: "trending",
    ok: false,
    impact: "optional",
    code: "HTTP_ERROR",
    status: 500,
    ...values
  });
}

test("exports the complete health-state and capability-impact contracts", () => {
  assert.deepEqual(HEALTH_STATES, [
    "healthy",
    "limited",
    "degraded",
    "down",
    "auth_required",
    "stale"
  ]);
  assert.deepEqual(CAPABILITY_IMPACTS, ["optional", "important", "critical"]);
  assert.equal(new HealthIncidentEngine() instanceof HealthIncidentEngine, true);
});

test("requires two matching consecutive failures before opening an incident", () => {
  const { engine, advance, transitions } = fixture();

  const first = fail(engine);
  assert.equal(first.transitions.length, 0);
  assert.equal(first.capability.pendingFailure.count, 1);
  assert.equal(engine.snapshot().incidents.length, 0);

  advance(1_000);
  const second = fail(engine);
  assert.equal(second.transitions.length, 1);
  assert.equal(second.transitions[0].type, "opened");
  assert.equal(second.capability.state, "limited");
  assert.equal(second.capability.pendingFailure, null);
  assert.equal(transitions.length, 1);

  const [incident] = engine.snapshot().incidents;
  assert.equal(incident.key, "seerr/trending/HTTP_ERROR/500");
  assert.equal(incident.occurrenceCount, 2);
  assert.equal(incident.firstSeen, "2026-09-12T12:00:00.000Z");
  assert.equal(incident.lastSeen, "2026-09-12T12:00:01.000Z");
});

test("deduplicates the same service, capability, code, and status", () => {
  const { engine, advance } = fixture();
  fail(engine);
  advance(50);
  fail(engine);
  advance(50);
  fail(engine);

  let snapshot = engine.snapshot();
  assert.equal(snapshot.incidents.length, 1);
  assert.equal(snapshot.incidents[0].occurrenceCount, 3);

  advance(50);
  fail(engine, { status: 502 });
  assert.equal(engine.snapshot().incidents[0].status, 500, "a one-off replacement was not debounced");
  advance(50);
  fail(engine, { status: 502 });

  snapshot = engine.snapshot();
  assert.equal(snapshot.incidents.length, 1);
  assert.equal(snapshot.incidents[0].status, 502);
  assert.equal(snapshot.incidents[0].occurrenceCount, 2);
  assert.deepEqual(
    snapshot.recentTransitions.slice(0, 2).map(({ type }) => type),
    ["opened", "superseded"]
  );
});

test("maps impact to limited, degraded, and down while identifying authentication failures", () => {
  const { engine } = fixture();
  const cases = [
    ["optional", "optional-check", 500, "limited"],
    ["important", "important-check", 500, "degraded"],
    ["critical", "critical-check", 500, "down"],
    ["optional", "auth-check", 401, "auth_required"]
  ];

  for (const [impact, capability, status, expected] of cases) {
    const result = {
      service: "example",
      capability,
      ok: false,
      impact,
      code: status === 401 ? "UNAUTHORIZED" : "HTTP_ERROR",
      status
    };
    engine.observe(result);
    engine.observe(result);
    const current = engine.snapshot().services[0].capabilities.find(({ name }) => name === capability);
    assert.equal(current.state, expected);
  }

  assert.equal(engine.snapshot().overall.state, "down");
});

test("emits an escalation and a recovery with stable incident timing", () => {
  const { engine, advance, transitions } = fixture();
  fail(engine);
  advance(100);
  fail(engine);
  advance(100);
  fail(engine, { impact: "critical" });

  assert.deepEqual(transitions.map(({ type }) => type), ["opened", "escalated"]);
  assert.equal(transitions[1].previousState, "limited");
  assert.equal(transitions[1].state, "down");

  advance(100);
  const recovery = engine.recordResult({
    service: "seerr",
    capability: "trending",
    ok: true,
    impact: "critical",
    latencyMs: 42
  });
  assert.equal(recovery.transitions[0].type, "recovered");
  assert.equal(recovery.capability.state, "healthy");
  assert.equal(recovery.capability.latencyMs, 42);

  const snapshot = engine.snapshot();
  assert.equal(snapshot.incidents.length, 0);
  assert.equal(snapshot.recentRecoveries.length, 1);
  assert.equal(snapshot.recentRecoveries[0].previousState, "down");
  assert.equal(snapshot.recentRecoveries[0].occurrenceCount, 3);
  assert.equal(snapshot.recentRecoveries[0].recoveredAt, "2026-09-12T12:00:00.300Z");
});

test("marks silent capabilities stale and recovers them on fresh evidence", () => {
  const { engine, now, advance } = fixture({ staleAfterMs: 1_000 });
  engine.registerCapability({ service: "jellyfin", capability: "api", impact: "critical" });
  engine.recordResult({ service: "jellyfin", capability: "api", ok: true });
  assert.equal(engine.snapshot().overall.state, "healthy");

  advance(1_001);
  assert.equal(engine.sweepStale(now()), 1);
  let snapshot = engine.snapshot();
  assert.equal(snapshot.overall.state, "stale");
  assert.equal(snapshot.incidents[0].code, "STALE");
  assert.equal(snapshot.incidents[0].firstSeen, "2026-09-12T12:00:01.000Z");

  engine.recordResult({ service: "jellyfin", capability: "api", ok: true });
  snapshot = engine.snapshot();
  assert.equal(snapshot.overall.state, "healthy");
  assert.equal(snapshot.recentRecoveries[0].previousState, "stale");
});

test("retiring a service removes its pending health state and open incidents", () => {
  const { engine, now, advance, transitions } = fixture({ failureThreshold: 2, staleAfterMs: 1_000 });
  engine.recordResult({ service: "jellyfin", capability: "status", ok: true, impact: "critical" });
  const queueFailure = {
    service: "radarr",
    capability: "queue",
    ok: false,
    impact: "important",
    code: "UNREACHABLE"
  };
  engine.recordResult(queueFailure);
  engine.recordResult(queueFailure);
  engine.recordResult({
    service: "radarr",
    capability: "health",
    ok: false,
    impact: "important",
    code: "HTTP_ERROR",
    status: 500
  });
  assert.equal(engine.snapshot().incidents.some(({ service }) => service === "radarr"), true);

  advance(100);
  assert.equal(engine.retireService("radarr", now()), 2);
  let snapshot = engine.snapshot();
  assert.equal(snapshot.services.some(({ id }) => id === "radarr"), false);
  assert.equal(snapshot.incidents.some(({ service }) => service === "radarr"), false);
  assert.equal(snapshot.recentRecoveries.some(({ service }) => service === "radarr"), false);
  assert.equal(transitions.at(-1).type, "retired");

  advance(10_000);
  engine.sweepStale(now());
  snapshot = engine.snapshot();
  assert.equal(snapshot.services.some(({ id }) => id === "radarr"), false);
  assert.equal(snapshot.incidents.some(({ service }) => service === "radarr"), false);
});

test("exposes dependency blockers and calls a safe dependency-change hook", () => {
  const { engine, dependencies } = fixture();
  engine.registerCapability({ service: "qbittorrent", capability: "api", impact: "critical" });
  engine.registerCapability({
    service: "radarr",
    capability: "acquisition",
    impact: "important",
    dependsOn: ["qbittorrent/api"]
  });
  engine.recordResult({ service: "qbittorrent", capability: "api", ok: true });
  engine.recordResult({ service: "radarr", capability: "acquisition", ok: true });
  dependencies.length = 0;

  const outage = {
    service: "qbittorrent",
    capability: "api",
    ok: false,
    impact: "critical",
    code: "NETWORK_ERROR"
  };
  engine.recordResult(outage);
  engine.recordResult(outage);

  let dependent = engine.snapshot().services
    .find(({ id }) => id === "radarr")
    .capabilities.find(({ name }) => name === "acquisition");
  assert.deepEqual(dependent.blockedBy, [{
    service: "qbittorrent",
    capability: "api",
    state: "down",
    missing: false
  }]);
  assert.equal(dependencies.at(-1).blocked, true);

  engine.recordResult({ service: "qbittorrent", capability: "api", ok: true });
  dependent = engine.snapshot().services
    .find(({ id }) => id === "radarr")
    .capabilities.find(({ name }) => name === "acquisition");
  assert.deepEqual(dependent.blockedBy, []);
  assert.equal(dependencies.at(-1).blocked, false);
});

test("snapshots are serializable, detached, bounded, and omit arbitrary upstream data", () => {
  const { engine } = fixture({
    onTransition() {
      throw new Error("a broken hook must not stop processing");
    }
  });
  const unsafe = {
    service: "seerr",
    capability: "status",
    ok: false,
    impact: "important",
    code: "https://seerr.invalid/?apiKey=supersecret",
    status: 500,
    message: "Bearer supersecret",
    url: "https://seerr.invalid/?apiKey=supersecret",
    details: { password: "supersecret" },
    headers: { authorization: "Bearer supersecret" }
  };
  engine.recordResult(unsafe);
  engine.recordResult(unsafe);

  const snapshot = engine.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.doesNotThrow(() => structuredClone(snapshot));
  assert.equal(serialized.includes("supersecret"), false);
  assert.equal(serialized.includes("seerr.invalid"), false);
  assert.equal(snapshot.incidents[0].code, "CHECK_FAILED");
  assert.equal(Object.hasOwn(snapshot.incidents[0], "details"), false);

  snapshot.incidents[0].state = "healthy";
  assert.equal(engine.snapshot().incidents[0].state, "degraded", "caller mutated internal incident state");
});

test("rejects unnamed capabilities and self-dependencies", () => {
  const { engine } = fixture();
  assert.throws(
    () => engine.recordResult({ service: "seerr", capability: "", ok: true }),
    /Capability name/u
  );
  assert.throws(
    () => engine.registerCapability({
      service: "seerr",
      capability: "status",
      dependsOn: ["seerr/status"]
    }),
    /cannot depend on itself/u
  );
});
