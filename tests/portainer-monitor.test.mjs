import assert from "node:assert/strict";
import test from "node:test";

import { createHealthIncidentEngine } from "../server/health-engine.mjs";
import { createOperationsMonitor } from "../server/monitor.mjs";
import { probePortainer } from "../server/portainer-probes.mjs";

const START = Date.parse("2026-09-13T12:00:00.000Z");
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
const FOURTH_ID = "44444444-4444-4444-8444-444444444444";

function healthyPortainer(checkedAt) {
  return {
    state: "healthy",
    connectionState: "connected",
    checkedAt,
    latencyMs: 12,
    version: "3.0.0",
    checks: [{
      id: "containers-1",
      label: "Example Docker containers",
      ok: true,
      state: "healthy",
      importance: "important",
      metrics: { containerTotal: 1, containerRunning: 0, containerStopped: 1 }
    }],
    metrics: {
      environmentTotal: 1,
      environmentOnline: 1,
      containerTotal: 1,
      containerRunning: 0,
      containerStopped: 1,
      containerUnhealthy: 0,
      stackTotal: 1
    },
    inventory: {
      environments: [{
        id: 1,
        name: "Example Docker",
        state: "up",
        platform: "Docker",
        containerCapable: true,
        edge: false,
        agentVersion: "2.39.7"
      }],
      containers: [{
        id: "a".repeat(64),
        name: "maintenance-job",
        image: "example/maintenance:latest",
        environmentId: 1,
        environmentName: "Example Docker",
        state: "exited",
        status: "Exited (0) 1 hour ago",
        health: "informational",
        stack: "ops",
        createdAt: "2026-08-01T00:00:00.000Z",
        ports: [],
        secretLabel: "must-not-survive"
      }],
      stacks: [{
        id: 7,
        name: "Ops",
        state: "active",
        type: 2,
        environmentId: 1,
        environmentName: "Example Docker",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: null,
        env: [{ value: "must-not-survive" }]
      }]
    }
  };
}

function deniedPortainer(checkedAt) {
  return {
    state: "auth_required",
    connectionState: "auth_required",
    checkedAt,
    latencyMs: 21,
    version: "2.39.7",
    checks: [{
      id: "identity",
      label: "Token authorization",
      ok: false,
      state: "auth_required",
      importance: "important",
      code: "AUTH_REQUIRED",
      status: 403,
      reports: [{
        severity: "error",
        source: "Portainer · Token authorization",
        message: "GET /api/users/me returned HTTP 403 (Forbidden)."
      }]
    }],
    metrics: {},
    inventory: { environments: [], containers: [], stacks: [] }
  };
}

test("multiple Portainer servers stay infrastructure-only and use distinct incident identities", async () => {
  const forbiddenToken = "ptr_access-token-must-not-survive";
  const incidentEngine = createHealthIncidentEngine({
    now: () => START,
    failureThreshold: 1,
    idFactory: () => "portainer-incident"
  });
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [{ id: "jellyfin" }],
    probe: (_service, context) => ({
      state: "healthy",
      connectionState: "connected",
      checkedAt: context.checkedAt,
      checks: [{ id: "status", label: "Status", ok: true, state: "healthy", importance: "core", stages: ["library"] }]
    }),
    loadInfrastructureServices: () => [
      {
        id: FIRST_ID,
        type: "portainer",
        displayName: "Lab Portainer",
        url: `https://${forbiddenToken}@portainer-one.invalid:9443`,
        accessToken: forbiddenToken,
        enabled: true,
        monitoringEnabled: true
      },
      {
        id: SECOND_ID,
        type: "portainer",
        displayName: "Production Portainer",
        url: "https://portainer-two.invalid:9443",
        accessToken: forbiddenToken,
        enabled: true,
        monitoringEnabled: true
      }
    ],
    probeInfrastructureService: (service, context) => (
      service.id === FIRST_ID ? healthyPortainer(context.checkedAt) : deniedPortainer(context.checkedAt)
    )
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.overall.state, "healthy", "Infrastructure failures must not degrade the Media summary.");
  assert.equal(snapshot.overall.serviceCount, 1);
  assert.deepEqual(snapshot.services.map(({ id }) => id), ["jellyfin"]);
  assert.equal(snapshot.services.some(({ id }) => id === "portainer"), false);
  assert.equal(Object.hasOwn(snapshot.media, "portainer"), false);
  assert.equal(JSON.stringify(snapshot.media).includes("portainer"), false);

  assert.equal(snapshot.infrastructure.targetCount, 0);
  assert.equal(snapshot.infrastructure.environmentCount, 0);
  assert.equal(snapshot.infrastructure.serviceCount, 2);
  assert.equal(snapshot.infrastructure.affectedServiceCount, 1);
  assert.equal(snapshot.infrastructure.state, "auth_required");
  assert.deepEqual(snapshot.infrastructure.services.map(({ id }) => id), [FIRST_ID, SECOND_ID]);
  assert.deepEqual(snapshot.infrastructure.portainer, snapshot.infrastructure.services);
  assert.equal(snapshot.infrastructure.services[0].inventory.containers[0].health, "informational");
  assert.equal(snapshot.infrastructure.services[0].metrics.containerStopped, 1);
  assert.equal(snapshot.infrastructure.services[1].capabilities[0].httpStatus, 403);
  assert.match(snapshot.infrastructure.services[1].reports[0].message, /HTTP 403 \(Forbidden\)/u);

  assert.equal(snapshot.incidents.open.length, 1);
  assert.equal(snapshot.incidents.open[0].service, `portainer-${SECOND_ID}`);
  assert.equal(snapshot.incidents.open[0].capability, "identity");
  assert.equal(snapshot.incidents.open[0].code, "AUTH_REQUIRED");
  assert.equal(snapshot.overall.openIncidentCount, 0, "Portainer incidents stay outside the Media incident count.");

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(forbiddenToken), false);
  assert.equal(serialized.includes("portainer-one.invalid"), false);
  assert.equal(serialized.includes("secretLabel"), false);
  assert.equal(serialized.includes('"env"'), false);
});

test("four concurrent Portainer servers leave broker headroom with at most four container requests", async () => {
  let activeContainerRequests = 0;
  let maximumContainerRequests = 0;
  let totalContainerRequests = 0;
  const services = [FIRST_ID, SECOND_ID, THIRD_ID, FOURTH_ID].map((id, index) => ({
    id,
    type: "portainer",
    displayName: `Portainer ${index + 1}`,
    enabled: true,
    monitoringEnabled: true
  }));
  const monitor = createOperationsMonitor({
    now: () => START,
    loadServices: () => [],
    probe: () => { throw new Error("Media probes must not run."); },
    loadInfrastructureServices: () => services,
    probeInfrastructureService: (_service, context) => probePortainer(async (routeId) => {
      if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
      if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
      if (routeId === "environments") {
        return {
          status: 200,
          body: Array.from({ length: 6 }, (_, index) => ({
            Id: index + 1,
            Name: `Docker ${index + 1}`,
            Status: 1,
            ContainerEngine: "Docker"
          }))
        };
      }
      if (routeId === "stacks") return { status: 204, body: null };
      if (routeId === "containers") {
        totalContainerRequests += 1;
        activeContainerRequests += 1;
        maximumContainerRequests = Math.max(maximumContainerRequests, activeContainerRequests);
        // setImmediate keeps the first batch pending long enough to expose the
        // product of the monitor's outer fanout and each probe's inner fanout.
        await new Promise((resolve) => setImmediate(resolve));
        activeContainerRequests -= 1;
        return { status: 200, body: [] };
      }
      throw new Error(`Unexpected Portainer route: ${routeId}`);
    }, { checkedAt: context.checkedAt })
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.infrastructure.services.length, 4);
  assert.equal(totalContainerRequests, 24);
  assert.ok(
    maximumContainerRequests <= 4,
    `container inventory fanout reached ${maximumContainerRequests}; expected at most 4`
  );
});

test("requestRefresh coalesces in-flight Portainer work into exactly one immediate trailing cycle", async (t) => {
  const pending = [];
  const scheduled = [];
  let loadCalls = 0;
  let probeCalls = 0;
  const monitor = createOperationsMonitor({
    now: () => START,
    intervalMs: 60_000,
    loadServices: () => [],
    probe: () => { throw new Error("Media probes must not run."); },
    loadInfrastructureServices: () => {
      loadCalls += 1;
      return [{
        id: FIRST_ID,
        type: "portainer",
        displayName: "Refresh race Portainer",
        enabled: true,
        monitoringEnabled: true
      }];
    },
    probeInfrastructureService: (_service, context) => new Promise((resolve) => {
      probeCalls += 1;
      pending.push(() => resolve(healthyPortainer(context.checkedAt)));
    }),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer: () => {}
  });
  t.after(() => monitor.stop());

  const first = monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 1);
  const coalesced = [monitor.requestRefresh(), monitor.requestRefresh(), monitor.requestRefresh()];
  assert.ok(coalesced.every((promise) => promise === first));
  pending.shift()();
  await first;

  for (let attempt = 0; attempt < 20 && probeCalls < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(probeCalls, 2, "one immediate trailing cycle should begin after the coalesced cycle");
  assert.equal(loadCalls, 2);
  assert.equal(scheduled.length, 0, "the regular timer must wait until trailing work finishes");
  pending.shift()();

  for (let attempt = 0; attempt < 20 && scheduled.length < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(probeCalls, 2, "three coalesced requests must not create three trailing cycles");
  assert.equal(loadCalls, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60_000);
});

test("TARGET_CHANGED during Portainer credential use publishes no false failure or incident", async () => {
  const incidentEngine = createHealthIncidentEngine({
    now: () => START,
    failureThreshold: 1,
    idFactory: () => "target-race-incident"
  });
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [],
    probe: () => { throw new Error("Media probes must not run."); },
    loadInfrastructureServices: () => [{
      id: FIRST_ID,
      type: "portainer",
      displayName: "Changing Portainer",
      enabled: true,
      monitoringEnabled: true
    }],
    probeInfrastructureService: () => {
      throw Object.assign(new Error("credential revision changed during use"), { code: "TARGET_CHANGED" });
    }
  });

  const snapshot = await monitor.refresh();
  assert.equal(snapshot.infrastructure.state, "stale");
  assert.equal(snapshot.infrastructure.serviceCount, 0);
  assert.deepEqual(snapshot.infrastructure.services, []);
  assert.equal(snapshot.incidents.open.some(({ service }) => service === `portainer-${FIRST_ID}`), false);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("PROBE_FAILED"), false);
  assert.equal(serialized.includes("TARGET_CHANGED"), false);
  assert.equal(serialized.includes("credential revision changed"), false);
});

test("infrastructure services with monitoring disabled are not probed and retire prior incidents", async () => {
  let monitoringEnabled = true;
  let probeCalls = 0;
  const incidentEngine = createHealthIncidentEngine({
    now: () => START,
    failureThreshold: 1,
    idFactory: () => "disabled-monitoring-incident"
  });
  const monitor = createOperationsMonitor({
    now: () => START,
    incidentEngine,
    loadServices: () => [],
    probe: () => { throw new Error("Media probes must not run."); },
    loadInfrastructureServices: () => [{
      id: FIRST_ID,
      type: "loki",
      displayName: "Optional Loki monitoring",
      enabled: true,
      monitoringEnabled
    }],
    probeInfrastructureService: (_service, context) => {
      probeCalls += 1;
      return deniedPortainer(context.checkedAt);
    }
  });

  const failing = await monitor.refresh();
  assert.equal(probeCalls, 1);
  assert.equal(failing.infrastructure.serviceCount, 1);
  assert.equal(failing.incidents.open.length, 1);
  assert.equal(failing.incidents.open[0].service, `loki-${FIRST_ID}`);

  monitoringEnabled = false;
  const disabled = await monitor.refresh();
  assert.equal(probeCalls, 1, "a service with monitoring disabled must not be probed");
  assert.equal(disabled.infrastructure.serviceCount, 0);
  assert.deepEqual(disabled.infrastructure.services, []);
  assert.deepEqual(disabled.infrastructure.loki, []);
  assert.equal(disabled.incidents.open.length, 0, "disabling monitoring must retire its active incident");
});
