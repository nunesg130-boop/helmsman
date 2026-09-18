import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const BASIC_PASSWORD = "loki-basic-password-that-must-remain-encrypted";
const BEARER_TOKEN = "loki-bearer-token-that-must-remain-encrypted";

function request(port, pathname, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.csrf ? { "X-Jellofin-Csrf": options.csrf } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          json: bytes.length ? JSON.parse(bytes.toString("utf8")) : null
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-loki-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const testCalls = [];
  const queryCalls = [];
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    lookup: async (hostname) => {
      assert.match(hostname, /^loki-(?:http|basic|bearer)\.test$/u);
      const addresses = {
        "loki-http.test": "10.20.30.60",
        "loki-basic.test": "10.20.30.61",
        "loki-bearer.test": "10.20.30.62"
      };
      return [{ address: addresses[hostname], family: 4 }];
    },
    testInfrastructureServiceConnection: async (input) => {
      assert.equal(input.type, "loki");
      testCalls.push({
        url: input.target.url,
        address: input.targetResolution.pinned.address,
        authMode: input.authMode,
        tenantId: input.tenantId,
        tlsMode: input.tlsMode,
        credentials: Object.fromEntries(
          Object.entries(input.credentials).map(([field, value]) => [field, value.toString("utf8")])
        )
      });
      return { type: "loki", state: "healthy", connectionState: "connected", version: "3.5.1" };
    },
    executeLokiRead: async (input) => {
      queryCalls.push({
        service: structuredClone(input.service),
        url: input.target.url,
        address: input.targetResolution.pinned.address,
        credentials: Object.fromEntries(
          Object.entries(input.credentials).map(([field, value]) => [field, value.toString("utf8")])
        ),
        routeId: input.routeId,
        parameters: structuredClone(input.parameters)
      });
      return {
        streams: [{ labels: { job: "helmsman" }, entries: [{ timestamp: input.parameters.end, line: "ready" }] }],
        truncated: false
      };
    }
  });
  const server = http.createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (!await controlPlane.handle(incoming, response, url)) {
        response.statusCode = 404;
        response.end();
      }
    } catch (error) {
      const payload = Buffer.from(JSON.stringify({
        code: error?.code || "INTERNAL_ERROR",
        message: error instanceof ControlPlaneError ? error.message : "Request failed."
      }), "utf8");
      response.statusCode = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      response.setHeader("Content-Type", "application/json");
      response.end(payload);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    root,
    store,
    setupToken,
    testCalls,
    queryCalls,
    controlPlane,
    server,
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`
  };
}

async function stop(context) {
  await new Promise((resolve) => context.server.close(resolve));
  await context.controlPlane.close();
  await rm(context.root, { recursive: true, force: true });
}

async function claim(context) {
  const response = await request(context.port, "/api/v2/setup/claim", {
    method: "POST",
    origin: context.origin,
    body: {
      setupToken: context.setupToken,
      deviceName: "Loki test browser",
      origin: context.origin,
      allowedCidrs: ["10.0.0.0/8"],
      allowPublicHttps: false
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return {
    origin: context.origin,
    cookie: response.headers["set-cookie"][0].split(";", 1)[0],
    csrf: response.json.csrfToken
  };
}

async function createLoki(context, authentication, body) {
  const response = await request(context.port, "/api/v2/infrastructure/services", {
    method: "POST",
    ...authentication,
    body
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json;
}

function validQuery(targetRevision, overrides = {}) {
  return {
    targetRevision,
    query: "{job=\"helmsman\"}",
    start: "2026-09-18T00:00:00Z",
    end: "2026-09-18T00:30:00Z",
    direction: "backward",
    limit: 100,
    ...overrides
  };
}

async function assertPlaintextAbsent(directory, value) {
  for (const name of await readdir(directory)) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, name));
    } catch (error) {
      if (error?.code === "EISDIR") continue;
      throw error;
    }
    assert.equal(bytes.includes(Buffer.from(value, "utf8")), false, name);
  }
}

test("Loki metadata, private HTTP, saved tests, and bounded query execution are first-class", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const listed = await request(context.port, "/api/v2/infrastructure/services", authentication);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const definition = listed.json.definitions.find(({ id }) => id === "loki");
    assert.equal(definition.category, "observability");
    assert.equal(definition.authMode, "none");
    assert.deepEqual(definition.authOptions.map(({ id }) => id), ["none", "basic", "bearer"]);

    const created = await createLoki(context, authentication, {
      type: "loki",
      displayName: " Home Loki ",
      url: "http://loki-http.test:3100/",
      enabled: true,
      monitoringEnabled: true,
      authMode: "none",
      tenantId: "home_lab",
      tlsMode: "none"
    });
    assert.equal(created.displayName, "Home Loki");
    assert.equal(created.url, "http://loki-http.test:3100");
    assert.equal(created.category, "observability");
    assert.equal(created.authMode, "none");
    assert.equal(created.tenantId, "home_lab");
    assert.equal(created.credentialConfigured, true);
    assert.deepEqual(created.credentialFields, []);
    assert.equal(Object.hasOwn(created, "credentials"), false);

    const savedTest = await request(
      context.port,
      `/api/v2/infrastructure/services/${created.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(savedTest.status, 200, JSON.stringify(savedTest.json));
    assert.deepEqual(context.testCalls.at(-1), {
      url: "http://loki-http.test:3100",
      address: "10.20.30.60",
      authMode: "none",
      tenantId: "home_lab",
      tlsMode: "none",
      credentials: {}
    });

    const noCsrf = await request(context.port, `/api/v2/logging/loki/${created.id}/query`, {
      method: "POST",
      origin: context.origin,
      cookie: authentication.cookie,
      body: validQuery(created.targetRevision)
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    const queried = await request(context.port, `/api/v2/logging/loki/${created.id}/query`, {
      method: "POST",
      ...authentication,
      body: validQuery(created.targetRevision, { direction: "BACKWARD" })
    });
    assert.equal(queried.status, 200, JSON.stringify(queried.json));
    assert.equal(queried.json.streams[0].entries[0].line, "ready");
    assert.deepEqual(context.queryCalls.at(-1), {
      service: context.store.snapshot().infrastructureServices[created.id],
      url: "http://loki-http.test:3100",
      address: "10.20.30.60",
      credentials: {},
      routeId: "queryRange",
      parameters: {
        query: "{job=\"helmsman\"}",
        start: "2026-09-18T00:00:00.000Z",
        end: "2026-09-18T00:30:00.000Z",
        direction: "backward",
        limit: 100
      }
    });
    assert.equal(
      Object.keys(context.controlPlane.credentialStore.publicSnapshot().credentials)
        .some((namespace) => namespace.startsWith(`infra-svc-${created.id}-`)),
      false
    );
  } finally {
    await stop(context);
  }
});

test("Loki basic and bearer credentials stay encrypted and survive destination-policy rebinding", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const basic = await createLoki(context, authentication, {
      type: "loki",
      displayName: "Secure Loki",
      url: "https://loki-basic.test:3100",
      enabled: true,
      monitoringEnabled: true,
      authMode: "basic",
      tenantId: "tenant-a",
      tlsMode: "system",
      credentials: { username: "helmsman", password: BASIC_PASSWORD }
    });
    assert.equal(basic.authMode, "basic");
    assert.equal(basic.tenantId, "tenant-a");
    assert.equal(basic.credentialConfigured, true);
    assert.deepEqual(basic.credentialFields.map(({ id }) => id), ["username", "password"]);
    assert.equal(JSON.stringify(basic).includes(BASIC_PASSWORD), false);

    const tested = await request(context.port, `/api/v2/infrastructure/services/${basic.id}/test`, {
      method: "POST",
      ...authentication,
      body: {}
    });
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    assert.deepEqual(context.testCalls.at(-1).credentials, {
      username: "helmsman",
      password: BASIC_PASSWORD
    });
    assert.equal(context.testCalls.at(-1).authMode, "basic");
    assert.equal(context.testCalls.at(-1).tenantId, "tenant-a");

    const policyUpdated = await request(context.port, "/api/v2/config", {
      method: "PUT",
      ...authentication,
      body: { allowedCidrs: ["10.20.0.0/16"], allowPublicHttps: false }
    });
    assert.equal(policyUpdated.status, 200, JSON.stringify(policyUpdated.json));
    const rebound = policyUpdated.json.infrastructureServices.find(({ id }) => id === basic.id);
    assert.equal(rebound.credentialConfigured, true);
    assert.notEqual(rebound.targetRevision, basic.targetRevision);
    const queried = await request(context.port, `/api/v2/logging/loki/${basic.id}/query`, {
      method: "POST",
      ...authentication,
      body: validQuery(rebound.targetRevision)
    });
    assert.equal(queried.status, 200, JSON.stringify(queried.json));
    assert.deepEqual(context.queryCalls.at(-1).credentials, {
      username: "helmsman",
      password: BASIC_PASSWORD
    });

    const bearer = await createLoki(context, authentication, {
      type: "loki",
      displayName: "Bearer Loki",
      url: "https://loki-bearer.test:3100",
      enabled: true,
      monitoringEnabled: true,
      authMode: "bearer",
      tenantId: null,
      tlsMode: "system",
      credentials: { token: BEARER_TOKEN }
    });
    const bearerQuery = await request(context.port, `/api/v2/logging/loki/${bearer.id}/query`, {
      method: "POST",
      ...authentication,
      body: validQuery(bearer.targetRevision)
    });
    assert.equal(bearerQuery.status, 200, JSON.stringify(bearerQuery.json));
    assert.deepEqual(context.queryCalls.at(-1).credentials, { token: BEARER_TOKEN });

    const config = await request(context.port, "/api/v2/config", authentication);
    assert.equal(JSON.stringify(config.json).includes(BASIC_PASSWORD), false);
    assert.equal(JSON.stringify(config.json).includes(BEARER_TOKEN), false);
    await assertPlaintextAbsent(context.root, BASIC_PASSWORD);
    await assertPlaintextAbsent(context.root, BEARER_TOKEN);
  } finally {
    await stop(context);
  }
});

test("Loki rejects insecure authentication and unbounded or stale query requests", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    for (const body of [
      {
        type: "loki",
        displayName: "Invalid bearer Loki",
        url: "https://loki-bearer.test:3100",
        authMode: "bearer",
        tenantId: null,
        tlsMode: "system",
        credentials: { token: "abc:def" }
      },
      {
        type: "loki",
        displayName: "Oversized username Loki",
        url: "https://loki-basic.test:3100",
        authMode: "basic",
        tenantId: null,
        tlsMode: "system",
        credentials: { username: "é".repeat(200), password: BASIC_PASSWORD }
      },
      {
        type: "loki",
        displayName: "Oversized password Loki",
        url: "https://loki-basic.test:3100",
        authMode: "basic",
        tenantId: null,
        tlsMode: "system",
        credentials: { username: "helmsman", password: "é".repeat(3_000) }
      }
    ]) {
      const invalidCredential = await request(context.port, "/api/v2/infrastructure/services", {
        method: "POST",
        ...authentication,
        body
      });
      assert.equal(invalidCredential.status, 400, JSON.stringify(invalidCredential.json));
      assert.equal(invalidCredential.json.code, "INVALID_CREDENTIAL");
    }
    for (const [authMode, credentials] of [
      ["basic", { username: "helmsman", password: BASIC_PASSWORD }],
      ["bearer", { token: BEARER_TOKEN }]
    ]) {
      const insecure = await request(context.port, "/api/v2/infrastructure/services", {
        method: "POST",
        ...authentication,
        body: {
          type: "loki",
          displayName: `Insecure ${authMode}`,
          url: "http://loki-http.test:3100",
          authMode,
          tenantId: null,
          tlsMode: "none",
          credentials
        }
      });
      assert.equal(insecure.status, 400);
      assert.equal(insecure.json.code, "HTTPS_REQUIRED");
    }

    const created = await createLoki(context, authentication, {
      type: "loki",
      displayName: "Bounded Loki",
      url: "http://loki-http.test:3100",
      authMode: "none",
      tenantId: null,
      tlsMode: "none"
    });
    const cases = [
      [validQuery(randomUUID()), 409, "TARGET_CHANGED"],
      [validQuery(created.targetRevision, { query: "x".repeat(4097) }), 400, "INVALID_LOKI_QUERY"],
      [validQuery(created.targetRevision, { end: "2026-09-19T00:00:00.001Z" }), 400, "INVALID_LOKI_RANGE"],
      [validQuery(created.targetRevision, { direction: "sideways" }), 400, "INVALID_LOKI_DIRECTION"],
      [validQuery(created.targetRevision, { limit: 501 }), 400, "INVALID_LOKI_LIMIT"],
      [validQuery(created.targetRevision, { start: "not-a-date" }), 400, "INVALID_LOKI_TIME"],
      [{ ...validQuery(created.targetRevision), upstreamUrl: "http://attacker.test" }, 400, "INVALID_REQUEST"]
    ];
    for (const [body, status, code] of cases) {
      const response = await request(context.port, `/api/v2/logging/loki/${created.id}/query`, {
        method: "POST",
        ...authentication,
        body
      });
      assert.equal(response.status, status, JSON.stringify(response.json));
      assert.equal(response.json.code, code);
    }
    assert.equal(context.queryCalls.length, 0);
  } finally {
    await stop(context);
  }
});
