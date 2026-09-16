import assert from "node:assert/strict";
import test from "node:test";

import {
  containersFromPortainer,
  environmentsFromPortainer,
  normalizePortainerInventory,
  portainerIdentityIsValid,
  portainerInventoryMetrics,
  portainerVersionFromStatus,
  stacksFromPortainer
} from "../server/portainer-model.mjs";
import { PORTAINER_PROBE_LIMITS, probePortainer } from "../server/portainer-probes.mjs";
import {
  authorizePortainerRoute,
  normalizePortainerEndpointId,
  PORTAINER_ROUTE_IDS
} from "../server/routes.mjs";

const CHECKED_AT = "2026-09-13T12:00:00.000Z";

function dockerEnvironment(id = 1, overrides = {}) {
  return {
    Id: id,
    Name: `Docker ${id}`,
    Status: 1,
    ContainerEngine: "Docker",
    ...overrides
  };
}

function container(id, overrides = {}) {
  return {
    Id: id.repeat(64).slice(0, 64),
    Names: [`/${id}-service`],
    Image: `example/${id}:latest`,
    State: "running",
    Status: "Up 2 hours",
    Created: 1_786_579_200,
    ...overrides
  };
}

test("Portainer internal routes are an exact, frozen, GET-only allowlist", () => {
  assert.deepEqual(PORTAINER_ROUTE_IDS, [
    "systemStatus",
    "legacyStatus",
    "identity",
    "stacks",
    "environments",
    "containers"
  ]);

  const fixedExpectations = new Map([
    ["systemStatus", "/api/system/status"],
    ["legacyStatus", "/api/status"],
    ["identity", "/api/users/me"],
    ["stacks", "/api/stacks"]
  ]);
  for (const [routeId, upstreamPathAndQuery] of fixedExpectations) {
    const route = authorizePortainerRoute(routeId);
    assert.equal(route.allowed, true);
    assert.equal(route.service, "portainer");
    assert.equal(route.internalOnly, true);
    assert.equal(route.method, "GET");
    assert.equal(route.upstreamPathAndQuery, upstreamPathAndQuery);
    assert.equal(route.credentialRequired, !["systemStatus", "legacyStatus"].includes(routeId));
    assert.equal(Object.isFrozen(route), true);
  }

  assert.equal(
    authorizePortainerRoute("environments", "GET", { start: 101 }).upstreamPathAndQuery,
    "/api/endpoints?start=101&limit=100&sort=Name&order=asc&excludeSnapshots=true"
  );
  assert.equal(
    authorizePortainerRoute("containers", "GET", { endpointId: 42 }).upstreamPathAndQuery,
    "/api/endpoints/42/docker/containers/json?all=true"
  );
  assert.equal(authorizePortainerRoute("environments").start, 1);
  assert.equal(authorizePortainerRoute("environments", "GET", { start: 901 }).allowed, true);
  assert.equal(authorizePortainerRoute("containers", "GET", { endpointId: "2147483647" }).allowed, true);

  for (const value of [undefined, null, 0, -1, 1.5, "", "01", "1/containers", "1?all=false", "../1", "2147483648"] ) {
    assert.equal(normalizePortainerEndpointId(value), null);
    assert.equal(authorizePortainerRoute("containers", "GET", { endpointId: value }).code, "ROUTE_NOT_ALLOWED");
  }
  for (const start of [0, -1, 1.5, "01", 902, "../../users", "1&limit=9999"]) {
    assert.equal(authorizePortainerRoute("environments", "GET", { start }).code, "ROUTE_NOT_ALLOWED");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(authorizePortainerRoute("identity", method).code, "METHOD_NOT_ALLOWED");
  }
  assert.equal(authorizePortainerRoute("../../docker", "GET").code, "ROUTE_NOT_ALLOWED");
  assert.equal(authorizePortainerRoute("containers", "GET", []).code, "ROUTE_NOT_ALLOWED");

  const hostileParameters = new Proxy({}, { get() { throw new Error("do not inspect"); } });
  assert.doesNotThrow(() => authorizePortainerRoute("containers", "GET", hostileParameters));
  assert.equal(authorizePortainerRoute("containers", "GET", hostileParameters).code, "ROUTE_NOT_ALLOWED");
  assert.doesNotThrow(() => authorizePortainerRoute("environments", "GET", hostileParameters));
  assert.equal(authorizePortainerRoute("environments", "GET", hostileParameters).code, "ROUTE_NOT_ALLOWED");
});

test("Portainer models normalize only bounded display and inventory fields", () => {
  const droppedSecret = "portainer-secret-that-must-be-dropped";
  assert.equal(portainerVersionFromStatus({ Version: "2.39.7" }), "2.39.7");
  assert.equal(portainerVersionFromStatus({ version: "3.0.0-sts.1" }), "3.0.0-sts.1");
  assert.equal(portainerVersionFromStatus({ Version: `2.39.7 ${droppedSecret}` }), null);
  assert.equal(portainerIdentityIsValid({ Id: 7, Username: "helmsman" }), true);
  assert.equal(portainerIdentityIsValid({ Id: 7, Username: "" }), false);

  const environments = environmentsFromPortainer([
    {
      Id: 1,
      Name: "Main\u0000 Docker",
      Status: 1,
      ContainerEngine: "Docker",
      AgentVersion: "2.39.7",
      URL: `tcp://${droppedSecret}@docker.invalid:2375`,
      TLSConfig: { TLSCert: droppedSecret },
      PublicURL: droppedSecret
    },
    { Id: 2, Name: "Edge Podman", Status: 2, ContainerEngine: "Podman", EdgeID: "edge-1" },
    { Id: 3, Name: "Kubernetes", Status: 3, Type: 6 },
    { Id: 1, Name: droppedSecret, Status: 4, Type: 1 }
  ]);
  assert.deepEqual(environments, [
    {
      id: 2,
      name: "Edge Podman",
      state: "down",
      platform: "Podman",
      containerCapable: true,
      edge: true,
      agentVersion: null
    },
    {
      id: 3,
      name: "Kubernetes",
      state: "provisioning",
      platform: "Kubernetes",
      containerCapable: false,
      edge: false,
      agentVersion: null
    },
    {
      id: 1,
      name: "Main Docker",
      state: "up",
      platform: "Docker",
      containerCapable: true,
      edge: false,
      agentVersion: "2.39.7"
    }
  ]);

  const safeEnvironment = environments.find(({ id }) => id === 1);
  const containers = containersFromPortainer([
    container("a", {
      Labels: {
        "com.docker.compose.project": "media-stack",
        "com.example.api-key": droppedSecret
      },
      Ports: [
        { PrivatePort: 8096, PublicPort: 8096, Type: "tcp" },
        { PrivatePort: 0, PublicPort: 1, Type: "tcp", Secret: droppedSecret }
      ],
      HostConfig: { NetworkMode: droppedSecret },
      NetworkSettings: { Networks: { secret: droppedSecret } },
      Mounts: [{ Source: `/srv/${droppedSecret}` }]
    }),
    container("b", { State: "exited", Status: "Exited (0) 3 hours ago (unhealthy)" }),
    container("c", { State: "created", Status: "Created from a stale unhealthy result" }),
    container("d", { State: "running", Status: "Up 5 minutes (unhealthy)" }),
    container("e", { State: "restarting", Status: "Restarting (1) 2 seconds ago" }),
    container("f", { State: "dead", Status: "Dead" })
  ], safeEnvironment);

  assert.equal(containers.length, 6);
  assert.equal(containers.find(({ name }) => name === "b-service").health, "informational");
  assert.equal(containers.find(({ name }) => name === "c-service").health, "informational");
  assert.equal(containers.find(({ name }) => name === "a-service").health, "healthy");
  assert.equal(containers.find(({ name }) => name === "d-service").health, "unhealthy");
  assert.equal(containers.find(({ name }) => name === "e-service").health, "unhealthy");
  assert.equal(containers.find(({ name }) => name === "f-service").health, "unhealthy");
  assert.equal(containers.find(({ name }) => name === "a-service").stack, "media-stack");
  assert.deepEqual(containers.find(({ name }) => name === "a-service").ports, [
    { privatePort: 8096, publicPort: 8096, protocol: "tcp" }
  ]);

  const stacks = stacksFromPortainer([{
    Id: 8,
    Name: "Media",
    Status: 1,
    Type: 2,
    EndpointId: 1,
    CreationDate: 1_786_579_200,
    Env: [{ name: "TOKEN", value: droppedSecret }],
    GitConfig: { Authentication: { Password: droppedSecret } },
    EntryPoint: `/srv/${droppedSecret}/compose.yml`,
    ProjectPath: `/srv/${droppedSecret}`
  }], new Map([[1, "Main Docker"]]));
  assert.equal(stacks.length, 1);
  assert.deepEqual(Object.keys(stacks[0]), [
    "id",
    "name",
    "state",
    "type",
    "environmentId",
    "environmentName",
    "createdAt",
    "updatedAt"
  ]);

  const inventory = normalizePortainerInventory({ environments, containers, stacks });
  assert.equal(inventory.environments.length, 3);
  assert.equal(inventory.containers.length, 6);
  assert.equal(inventory.stacks.length, 1);
  assert.deepEqual(portainerInventoryMetrics(inventory), {
    environmentTotal: 3,
    environmentOnline: 1,
    environmentOffline: 1,
    containerTotal: 6,
    containerRunning: 2,
    containerStopped: 2,
    containerUnhealthy: 3,
    containerRestarting: 1,
    stackTotal: 1
  });
  assert.equal(JSON.stringify({ environments, containers, stacks, inventory }).includes(droppedSecret), false);
});

test("Portainer container ports retain first-seen order while removing exact duplicates", () => {
  const boundedPorts = [
    { PrivatePort: 8096, PublicPort: 8096, Type: "tcp" },
    { PrivatePort: 8096, PublicPort: 8096, Type: "tcp" },
    { PrivatePort: 8096, PublicPort: 8096, Type: "udp" },
    ...Array.from({ length: 29 }, (_, index) => ({
      PrivatePort: 10_000 + index,
      PublicPort: null,
      Type: "tcp"
    })),
    { PrivatePort: 65_535, PublicPort: 65_535, Type: "tcp" }
  ];
  const [normalized] = containersFromPortainer([
    container("a", { Ports: boundedPorts })
  ], { id: 1, name: "Main Docker" });

  assert.deepEqual(normalized.ports.slice(0, 3), [
    { privatePort: 8096, publicPort: 8096, protocol: "tcp" },
    { privatePort: 8096, publicPort: 8096, protocol: "udp" },
    { privatePort: 10_000, publicPort: null, protocol: "tcp" }
  ]);
  assert.equal(normalized.ports.length, 31);
  assert.equal(normalized.ports.some(({ privatePort }) => privatePort === 65_535), false);
});

test("Portainer probe uses v3 status, bounded pagination, and Docker gateway inventory", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    Id: index + 1,
    Name: `Kubernetes ${String(index + 1).padStart(3, "0")}`,
    Status: 1,
    Type: 6
  }));
  const request = async (routeId, options) => {
    calls.push({ routeId, ...options });
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 7, Username: "helmsman" } };
    if (routeId === "environments" && options.start === 1) return { status: 200, body: firstPage };
    if (routeId === "environments" && options.start === 101) {
      return { status: 200, body: [dockerEnvironment(101, { Name: "Main Docker" })] };
    }
    if (routeId === "stacks") return { status: 200, body: [{ Id: 1, Name: "Media", Status: 1, EndpointId: 101 }] };
    if (routeId === "containers" && options.endpointId === 101) {
      return { status: 200, body: [container("a")] };
    }
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  };

  const result = await probePortainer(request, { checkedAt: CHECKED_AT });
  assert.equal(result.ok, true);
  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.version, "3.0.0");
  assert.equal(result.checkedAt, CHECKED_AT);
  assert.equal(calls.some(({ routeId }) => routeId === "legacyStatus"), false);
  assert.deepEqual(
    calls.filter(({ routeId }) => routeId === "environments").map(({ start }) => start),
    [1, 101]
  );
  assert.deepEqual(
    calls.filter(({ routeId }) => routeId === "containers").map(({ endpointId }) => endpointId),
    [101]
  );
  assert.ok(calls.every(({ method }) => method === "GET"));
  assert.ok(calls.every(({ responseType }) => responseType === "json"));
  assert.ok(calls.every(({ purpose }) => purpose === "portainer-health-probe"));
  assert.equal(result.inventory.environments.length, 101);
  assert.equal(result.inventory.containers.length, 1);
  assert.equal(result.inventory.stacks.length, 1);
  assert.equal(result.metrics.environmentTotal, 101);
  assert.equal(result.metrics.containerRunning, 1);
  assert.equal(result.metrics.stackTotal, 1);
  assert.equal(JSON.stringify(result).includes("body"), false);
});

test("Portainer probe falls back to the legacy status route only after v3 returns 404", async () => {
  const calls = [];
  const result = await probePortainer(async (routeId) => {
    calls.push(routeId);
    if (routeId === "systemStatus") return { status: 404, body: { message: "not found" } };
    if (routeId === "legacyStatus") return { status: 200, body: { Version: "2.39.7" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") return { status: 200, body: [] };
    if (routeId === "stacks") return { status: 204, body: null };
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.deepEqual(calls, ["systemStatus", "legacyStatus", "identity", "environments", "stacks"]);
  assert.equal(result.ok, true);
  assert.equal(result.state, "healthy");
  assert.equal(result.version, "2.39.7");
  assert.equal(result.inventory.environments.length, 0);
});

test("Portainer probe deadline retains partial inventory and emits one bounded coverage failure", async () => {
  assert.equal(PORTAINER_PROBE_LIMITS.defaultDeadlineMs, 45_000);
  assert.ok(PORTAINER_PROBE_LIMITS.maximumDeadlineMs < 5 * 60_000);
  assert.equal(PORTAINER_PROBE_LIMITS.maximumContainerConcurrency, 1);
  const calls = [];
  const rejectedDetail = "raw deadline rejection must not survive";
  const result = await probePortainer(async (routeId, options) => {
    calls.push({ routeId, endpointId: options.endpointId ?? null });
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") {
      return {
        status: 200,
        body: [dockerEnvironment(1), dockerEnvironment(2), dockerEnvironment(3)]
      };
    }
    if (routeId === "stacks") return { status: 204, body: null };
    if (routeId === "containers" && options.endpointId === 1) {
      return { status: 200, body: [container("a")] };
    }
    if (routeId === "containers" && options.endpointId === 2) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error(rejectedDetail), {
          name: "AbortError",
          code: "ABORT_ERR",
          status: 502
        }));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error(`The deadline must stop later environment calls, saw: ${routeId} ${options.endpointId}`);
  }, { checkedAt: CHECKED_AT, deadlineMs: 250, timeoutMs: 5_000 });

  assert.deepEqual(
    calls.filter(({ routeId }) => routeId === "containers").map(({ endpointId }) => endpointId),
    [1, 2]
  );
  assert.equal(result.inventory.containers.length, 1);
  assert.equal(result.metrics.containerTotal, 1);
  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "limited");
  const partial = result.checks.filter(({ code }) => code === "PORTAINER_INVENTORY_PARTIAL");
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, "inventory-coverage");
  assert.equal(partial[0].state, "limited");
  assert.notEqual(partial[0].affectsHealth, false);
  assert.equal(
    partial[0].reports[0].message,
    "Portainer inventory collection reached Helmsman's bounded monitoring deadline. Any completed results were retained; unfinished checks will be retried during the next cycle."
  );
  assert.equal(result.checks.some(({ id }) => id === "containers-2" || id === "containers-3"), false);
  assert.equal(JSON.stringify(result).includes(rejectedDetail), false);
});

test("external Portainer cancellation remains stale rather than partial coverage", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await probePortainer(async (_routeId, options) => {
    assert.equal(options.signal.aborted, true);
    throw Object.assign(new Error("external cancellation detail"), {
      name: "AbortError",
      code: "ABORT_ERR"
    });
  }, { checkedAt: CHECKED_AT, deadlineMs: 250, signal: controller.signal });

  assert.equal(result.state, "stale");
  assert.equal(result.checks.some(({ code }) => code === "CHECK_CANCELLED"), true);
  assert.equal(result.checks.some(({ code }) => code === "PORTAINER_INVENTORY_PARTIAL"), false);
});

test("Portainer probe reports a precise, sanitized access-token rejection", async () => {
  const upstreamSecret = "raw-upstream-token-detail-must-not-survive";
  const calls = [];
  const result = await probePortainer(async (routeId) => {
    calls.push(routeId);
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") {
      return { status: 403, body: { message: upstreamSecret, token: upstreamSecret } };
    }
    throw new Error(`Token rejection must stop protected inventory calls, saw: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.deepEqual(calls, ["systemStatus", "identity"]);
  assert.equal(result.ok, false);
  assert.equal(result.state, "auth_required");
  assert.equal(result.connectionState, "auth_required");
  const identity = result.checks.find(({ id }) => id === "identity");
  assert.equal(identity.code, "AUTH_REQUIRED");
  assert.equal(identity.status, 403);
  assert.match(identity.reports[0].message, /HTTP 403 \(Forbidden\)/u);
  assert.match(identity.reports[0].message, /rejected the saved access token for identity verification/u);
  assert.equal(result.checks.find(({ id }) => id === "environments").code, "NOT_CHECKED");
  assert.equal(JSON.stringify(result).includes(upstreamSecret), false);
});

test("a public status 401 reports server failure without blaming the saved token", async () => {
  const calls = [];
  const result = await probePortainer(async (routeId) => {
    calls.push(routeId);
    if (routeId === "systemStatus") return { status: 401, body: { message: "reverse proxy requires authentication" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") return { status: 200, body: [] };
    if (routeId === "stacks") return { status: 204, body: null };
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.deepEqual(calls, ["systemStatus", "identity", "environments", "stacks"]);
  assert.equal(result.connectionState, "connected", "the protected identity proof succeeded");
  assert.equal(result.state, "degraded");
  const status = result.checks.find(({ id }) => id === "status");
  assert.equal(status.state, "down");
  assert.equal(status.code, "HTTP_ERROR");
  assert.equal(status.status, 401);
  assert.match(status.reports[0].message, /status checks do not send the access token/u);
  assert.doesNotMatch(status.reports[0].message, /rejected the saved access token/iu);
});

test("a per-environment 403 stays an authorization failure after identity succeeds", async () => {
  const result = await probePortainer(async (routeId) => {
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") return { status: 200, body: [dockerEnvironment()] };
    if (routeId === "stacks") return { status: 204, body: null };
    if (routeId === "containers") return { status: 403, body: { message: "do not reflect me" } };
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "degraded");
  const containers = result.checks.find(({ id }) => id === "containers-1");
  assert.equal(containers.code, "FORBIDDEN");
  assert.equal(containers.status, 403);
  assert.match(containers.reports[0].message, /authenticated Portainer user cannot read this capability or environment/u);
  assert.equal(JSON.stringify(result).includes("do not reflect me"), false);
});

test("an unknown but fresh environment status consistently makes Portainer limited", async () => {
  const result = await probePortainer(async (routeId) => {
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") {
      return { status: 200, body: [dockerEnvironment(7, { Name: "Unclassified Docker", Status: 9 })] };
    }
    if (routeId === "stacks") return { status: 204, body: null };
    throw new Error(`An unknown environment must not be queried for containers: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "limited");
  assert.equal(result.ok, false);
  assert.equal(result.inventory.environments[0].state, "unknown");
  const environment = result.checks.find(({ id }) => id === "environment-7");
  assert.equal(environment.state, "limited");
  assert.equal(environment.code, "PORTAINER_ENVIRONMENT_UNKNOWN");
  assert.equal(environment.importance, "optional");
  assert.match(environment.reports[0].message, /unknown Portainer status/u);
});

test("stopped containers stay informational while unhealthy containers degrade Portainer", async () => {
  async function run(containerResponse) {
    return probePortainer(async (routeId) => {
      if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
      if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
      if (routeId === "environments") return { status: 200, body: [dockerEnvironment()] };
      if (routeId === "stacks") return { status: 204, body: null };
      if (routeId === "containers") return { status: 200, body: containerResponse };
      throw new Error(`Unexpected Portainer route: ${routeId}`);
    }, { checkedAt: CHECKED_AT });
  }

  const stopped = await run([
    container("a", { State: "exited", Status: "Exited (0) 3 hours ago (unhealthy)" }),
    container("b", { State: "created", Status: "Created from a stale unhealthy result" })
  ]);
  assert.equal(stopped.state, "healthy");
  assert.equal(stopped.metrics.containerStopped, 2);
  assert.equal(stopped.metrics.containerUnhealthy, 0);
  assert.equal(stopped.checks.find(({ id }) => id === "containers-1").ok, true);

  const unhealthy = await run([
    container("c", { Names: ["/transcoder"], State: "running", Status: "Up 3 minutes (unhealthy)" })
  ]);
  assert.equal(unhealthy.state, "degraded");
  assert.equal(unhealthy.metrics.containerUnhealthy, 1);
  const containers = unhealthy.checks.find(({ id }) => id === "containers-1");
  assert.equal(containers.code, "CONTAINERS_UNHEALTHY");
  assert.match(containers.reports[0].message, /transcoder: Up 3 minutes \(unhealthy\)/u);
});

test("bounded inventory truncation is exposed as a non-blocking warning capability", async () => {
  let containerCalls = 0;
  const result = await probePortainer(async (routeId) => {
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") {
      return {
        status: 200,
        body: Array.from({ length: 26 }, (_, index) => dockerEnvironment(index + 1))
      };
    }
    if (routeId === "stacks") return { status: 204, body: null };
    if (routeId === "containers") {
      containerCalls += 1;
      return { status: 200, body: [] };
    }
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.equal(containerCalls, 25);
  assert.equal(result.inventory.environments.length, 26);
  assert.equal(result.state, "healthy", "bounded truncation warning is informational to aggregate health");
  const limit = result.checks.find(({ id }) => id === "inventory-limits");
  assert.equal(limit.ok, false);
  assert.equal(limit.state, "limited");
  assert.equal(limit.code, "INVENTORY_LIMIT_REACHED");
  assert.equal(limit.importance, "optional");
  assert.equal(limit.affectsHealth, false);
  assert.equal(limit.reports[0].severity, "warning");
  assert.match(limit.reports[0].message, /25 of 26 eligible environments/u);

  let aggregateContainerCalls = 0;
  const aggregate = await probePortainer(async (routeId, options) => {
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") {
      return { status: 200, body: [dockerEnvironment(1), dockerEnvironment(2)] };
    }
    if (routeId === "stacks") return { status: 204, body: null };
    if (routeId === "containers") {
      aggregateContainerCalls += 1;
      const offset = options.endpointId * 10_000;
      return {
        status: 200,
        body: Array.from({ length: 3_000 }, (_, index) => ({
          Id: (offset + index).toString(16).padStart(64, "0"),
          Names: [`/container-${options.endpointId}-${index}`],
          Image: "example/inventory:latest",
          State: "running",
          Status: options.endpointId === 2 && index === 2_999
            ? "Up 1 hour (unhealthy)"
            : "Up 1 hour"
        }))
      };
    }
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.equal(aggregateContainerCalls, 2);
  assert.equal(aggregate.inventory.containers.length, 5_000);
  assert.equal(
    aggregate.inventory.containers.filter(({ environmentId }) => environmentId === 1).length,
    3_000,
    "the first environment retains its complete inventory within the global budget"
  );
  assert.equal(
    aggregate.inventory.containers.filter(({ environmentId }) => environmentId === 2).length,
    2_000,
    "the next environment receives only the deterministic remaining budget"
  );
  assert.equal(aggregate.metrics.containerTotal, 5_000);
  assert.equal(aggregate.state, "degraded");
  assert.equal(
    aggregate.inventory.containers.some(({ status }) => /unhealthy/u.test(status)),
    false,
    "the unhealthy record lies beyond the deterministic retained-inventory budget"
  );
  const secondEnvironmentCheck = aggregate.checks.find(({ id }) => id === "containers-2");
  assert.equal(secondEnvironmentCheck.code, "CONTAINERS_UNHEALTHY");
  assert.match(secondEnvironmentCheck.reports[0].message, /container-2-2999/u);
  const aggregateLimit = aggregate.checks.find(({ id }) => id === "inventory-limits");
  assert.equal(aggregateLimit.code, "INVENTORY_LIMIT_REACHED");
  assert.equal(aggregateLimit.affectsHealth, false);
  assert.match(aggregateLimit.reports[0].message, /combined inventory exceeded 5000 containers/u);
  assert.match(aggregateLimit.reports[0].message, /only the first 5000 were retained/u);
  assert.doesNotMatch(
    aggregateLimit.reports[0].message,
    /environment reached the 5000-container response limit/u,
    "neither individual 3,000-container response reached its per-environment cap"
  );
});

test("bounded check selection retains a health-affecting failure that explains aggregate state", async () => {
  const environments = [
    ...Array.from({ length: 29 }, (_, index) => ({
      Id: index + 1,
      Name: `Provisioning ${String(index + 1).padStart(2, "0")}`,
      Status: 3,
      Type: 6
    })),
    dockerEnvironment(100, { Name: "Production Docker" })
  ];
  const result = await probePortainer(async (routeId) => {
    if (routeId === "systemStatus") return { status: 200, body: { Version: "3.0.0" } };
    if (routeId === "identity") return { status: 200, body: { Id: 1, Username: "helmsman" } };
    if (routeId === "environments") return { status: 200, body: environments };
    if (routeId === "stacks") return { status: 204, body: null };
    if (routeId === "containers") {
      return {
        status: 200,
        body: [container("a", {
          Names: ["/production-api"],
          State: "running",
          Status: "Up 2 minutes (unhealthy)"
        })]
      };
    }
    throw new Error(`Unexpected Portainer route: ${routeId}`);
  }, { checkedAt: CHECKED_AT });

  assert.equal(result.state, "degraded");
  assert.equal(result.checks.length, 32, "the fixture must exercise the check cap");
  const explanatory = result.checks.filter((check) => check.affectsHealth !== false && !check.ok);
  assert.ok(explanatory.length > 0, "a non-healthy aggregate must retain explanatory health evidence");
  assert.equal(explanatory[0].id, "containers-100");
  assert.equal(explanatory[0].code, "CONTAINERS_UNHEALTHY");
});
