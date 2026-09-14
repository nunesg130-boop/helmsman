import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createBroker,
  createHttpServer,
  performPortainerUpstreamRequest
} from "../server/broker.mjs";
import { authorizePortainerRoute } from "../server/routes.mjs";
import { createSelfSignedTlsFixture } from "./helpers/self-signed-tls.mjs";

const execFileAsync = promisify(execFile);

const {
  key: KEY,
  certificate: CERTIFICATE,
  fingerprint: FINGERPRINT
} = createSelfSignedTlsFixture();
const ACCESS_TOKEN = "ptr_portainer-transport-test-token";

async function fixtureServer(handler) {
  const server = https.createServer({ key: KEY, cert: CERTIFICATE }, handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
    resolution: {
      target: {
        url: `https://localhost:${port}`,
        protocol: "https:",
        hostname: "localhost",
        port,
        basePath: "",
        authority: `localhost:${port}`
      },
      pinned: { address: "127.0.0.1", family: 4 },
      addresses: [{ address: "127.0.0.1", family: 4 }]
    }
  };
}

function transportOptions(resolution, routeId = "identity", overrides = {}) {
  return {
    targetResolution: resolution,
    route: authorizePortainerRoute(routeId),
    credentials: { accessToken: Buffer.from(ACCESS_TOKEN) },
    targetRevision: "11111111-1111-4111-8111-111111111111",
    tlsMode: "pinned",
    certificateFingerprint: FINGERPRINT,
    limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 1_000 },
    ...overrides
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function jsonRequest(port, pathname, options = {}) {
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

test("pinned TLS validates the Portainer leaf before sending or decoding an access token", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    requests.push({ url: request.url, accessToken: request.headers["x-api-key"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/api/users/me"
      ? '{"Id":1,"Username":"helmsman"}'
      : '{"Version":"3.0.0"}');
  });
  t.after(fixture.close);

  const publicResult = await performPortainerUpstreamRequest(transportOptions(
    fixture.resolution,
    "systemStatus",
    { credentials: undefined }
  ));
  assert.equal(publicResult.status, 200);
  assert.equal(requests[0].url, "/api/system/status");
  assert.equal(requests[0].accessToken, undefined, "the public status capability must never carry X-API-Key");

  const protectedResult = await performPortainerUpstreamRequest(transportOptions(fixture.resolution));
  assert.equal(protectedResult.status, 200);
  assert.equal(requests[1].url, "/api/users/me");
  assert.equal(requests[1].accessToken, ACCESS_TOKEN);

  let credentialSerializations = 0;
  const accessToken = Buffer.from(ACCESS_TOKEN);
  accessToken.toString = (...arguments_) => {
    credentialSerializations += 1;
    return Buffer.prototype.toString.call(accessToken, ...arguments_);
  };
  await assert.rejects(
    performPortainerUpstreamRequest(transportOptions(fixture.resolution, "identity", {
      certificateFingerprint: "0".repeat(64),
      credentials: { accessToken }
    })),
    (error) => error?.code === "TLS_PIN_MISMATCH"
  );
  assert.equal(requests.length, 2, "a pin mismatch must fail before an HTTP request carries the token");
  assert.equal(credentialSerializations, 0, "a pin mismatch must fail before access-token decoding");
});

test("system trust emits X-API-Key only for credential-required Portainer routes", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    requests.push({ url: request.url, accessToken: request.headers["x-api-key"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(fixture.close);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "helmsman-portainer-ca-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const certificatePath = path.join(temporary, "portainer-test-ca.pem");
  await writeFile(certificatePath, CERTIFICATE, { mode: 0o600 });

  const brokerModule = new URL("../server/broker.mjs", import.meta.url).href;
  const routesModule = new URL("../server/routes.mjs", import.meta.url).href;
  const child = `
    import { performPortainerUpstreamRequest } from ${JSON.stringify(brokerModule)};
    import { authorizePortainerRoute } from ${JSON.stringify(routesModule)};
    const targetResolution = JSON.parse(process.env.PORTAINER_TEST_RESOLUTION);
    const credentials = { accessToken: Buffer.from(process.env.PORTAINER_TEST_TOKEN, "utf8") };
    for (const routeId of ["systemStatus", "identity"]) {
      await performPortainerUpstreamRequest({
        targetResolution,
        route: authorizePortainerRoute(routeId),
        credentials,
        tlsMode: "system",
        certificateFingerprint: null,
        limits: { maxApiResponseBytes: 4096, upstreamTimeoutMs: 1000 }
      });
    }
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", child], {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certificatePath,
      NODE_NO_WARNINGS: "1",
      PORTAINER_TEST_RESOLUTION: JSON.stringify(fixture.resolution),
      PORTAINER_TEST_TOKEN: ACCESS_TOKEN
    },
    timeout: 5_000
  });

  assert.deepEqual(requests, [
    { url: "/api/system/status", accessToken: undefined },
    { url: "/api/users/me", accessToken: ACCESS_TOKEN }
  ]);
});

test("Portainer transport reconstructs dynamic routes and rejects forged parity", async (t) => {
  let requestUrl = null;
  let requests = 0;
  const fixture = await fixtureServer((request, response) => {
    requests += 1;
    requestUrl = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  t.after(fixture.close);
  const route = authorizePortainerRoute("containers", "GET", { endpointId: 42 });
  const result = await performPortainerUpstreamRequest(transportOptions(fixture.resolution, "identity", { route }));
  assert.equal(result.status, 200);
  assert.equal(requestUrl, "/api/endpoints/42/docker/containers/json?all=true");
  assert.equal(requests, 1);

  const environmentRoute = authorizePortainerRoute("environments", "GET", { start: 101 });
  for (const forged of [
    { ...route, endpointId: 43 },
    { ...route, upstreamPath: "/api/users", upstreamPathAndQuery: "/api/users" },
    { ...authorizePortainerRoute("identity"), endpointId: 42 },
    { ...environmentRoute, start: 201 },
    { ...environmentRoute, upstreamPathAndQuery: "/api/endpoints?start=101&limit=1000" }
  ]) {
    await assert.rejects(
      performPortainerUpstreamRequest(transportOptions(fixture.resolution, "identity", { route: forged })),
      (error) => error?.code === "ROUTE_NOT_ALLOWED"
    );
  }
  assert.equal(requests, 1, "forged dynamic routes must fail before a token-bearing request is sent");
});

test("Portainer transport rejects redirects, oversized bodies, and stalled responses", async (t) => {
  const redirect = await fixtureServer((_request, response) => {
    response.writeHead(302, { location: "https://example.invalid/steal" });
    response.end();
  });
  t.after(redirect.close);
  await assert.rejects(
    performPortainerUpstreamRequest(transportOptions(redirect.resolution)),
    (error) => error?.code === "UPSTREAM_REDIRECT_REJECTED"
  );

  const oversized = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: "x".repeat(2_000) }));
  });
  t.after(oversized.close);
  await assert.rejects(
    performPortainerUpstreamRequest(transportOptions(oversized.resolution, "identity", {
      limits: { maxApiResponseBytes: 128, upstreamTimeoutMs: 1_000 }
    })),
    (error) => error?.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );

  const stalled = await fixtureServer(() => {});
  t.after(stalled.close);
  await assert.rejects(
    performPortainerUpstreamRequest(transportOptions(stalled.resolution, "identity", {
      limits: { maxApiResponseBytes: 1_024, upstreamTimeoutMs: 50 }
    })),
    (error) => error?.code === "UPSTREAM_TIMEOUT"
  );
});

test("Portainer transport rejects nonliteral and family-mismatched SSRF pins", async () => {
  const base = {
    target: {
      url: "https://portainer.invalid:9443",
      protocol: "https:",
      hostname: "portainer.invalid",
      port: 9443,
      basePath: "",
      authority: "portainer.invalid:9443"
    }
  };
  for (const pinned of [
    { address: "rebinding.invalid", family: 4 },
    { address: "127.0.0.1", family: 6 },
    { address: "::1", family: 4 }
  ]) {
    await assert.rejects(
      performPortainerUpstreamRequest(transportOptions({ ...base, pinned })),
      (error) => error?.code === "INVALID_TARGET_RESOLUTION"
    );
  }
});

test("createBroker routes Portainer draft tests and saved monitoring through dispatchPortainer", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-portainer-broker-"));
  const calls = [];
  const broker = await createBroker({
    dataDir,
    monitorIntervalMs: 60_000,
    lookup: async (hostname) => {
      assert.equal(hostname, "portainer.test");
      return [{ address: "10.20.30.60", family: 4 }];
    },
    dispatchPortainer: async ({ targetResolution, route, credentials, targetRevision, tlsMode }) => {
      calls.push({
        routeId: route.routeId,
        endpointId: route.endpointId ?? null,
        start: route.start ?? null,
        targetRevision,
        tlsMode,
        address: targetResolution.pinned.address,
        accessToken: credentials.accessToken.toString("utf8")
      });
      const bodies = {
        systemStatus: { Version: "3.0.0" },
        identity: { Id: 1, Username: "helmsman" },
        environments: [{ Id: 1, Name: "Main Docker", Status: 1, ContainerEngine: "Docker" }],
        stacks: [],
        containers: []
      };
      return {
        status: 200,
        body: Buffer.from(JSON.stringify(bodies[route.routeId]), "utf8"),
        contentType: "application/json"
      };
    }
  });
  const server = createHttpServer(broker.handler);
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    broker.beginShutdown();
    await close(server);
    await broker.drain();
    await rm(dataDir, { recursive: true, force: true });
  });

  const claimed = await jsonRequest(port, "/api/v2/setup/claim", {
    method: "POST",
    origin,
    body: {
      setupToken: broker.setupToken,
      deviceName: "Portainer broker test browser",
      origin,
      allowedCidrs: ["10.0.0.0/8"],
      allowPublicHttps: false
    }
  });
  assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
  const authentication = {
    origin,
    cookie: claimed.headers["set-cookie"][0].split(";", 1)[0],
    csrf: claimed.json.csrfToken
  };
  const serviceForm = {
    type: "portainer",
    displayName: "Lab Portainer",
    url: "https://portainer.test:9443",
    enabled: true,
    monitoringEnabled: true,
    tlsMode: "system",
    certificateFingerprint: null,
    credentials: { accessToken: ACCESS_TOKEN }
  };

  const draft = await jsonRequest(port, "/api/v2/infrastructure/services/test", {
    method: "POST",
    ...authentication,
    body: serviceForm
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.equal(draft.json.state, "healthy");
  const draftRevision = calls[0].targetRevision;
  assert.deepEqual(calls.filter(({ targetRevision }) => targetRevision === draftRevision).map(({ routeId }) => routeId), [
    "systemStatus",
    "identity",
    "environments",
    "stacks",
    "containers"
  ]);

  const created = await jsonRequest(port, "/api/v2/infrastructure/services", {
    method: "POST",
    ...authentication,
    body: serviceForm
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.credentialConfigured, true);

  let refreshed = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    refreshed = await jsonRequest(port, "/api/v2/operations/refresh", {
      method: "POST",
      ...authentication,
      body: {}
    });
    if (refreshed.json?.infrastructure?.services?.length) break;
  }
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.equal(refreshed.json.infrastructure.services.length, 1);
  assert.equal(refreshed.json.infrastructure.services[0].id, created.json.id);
  assert.equal(refreshed.json.infrastructure.services[0].state, "healthy");
  assert.equal(refreshed.json.services.some(({ id }) => id === "portainer"), false);

  const monitoringCalls = calls.filter(({ targetRevision }) => targetRevision === created.json.targetRevision);
  assert.deepEqual([...new Set(monitoringCalls.map(({ routeId }) => routeId))], [
    "systemStatus",
    "identity",
    "environments",
    "stacks",
    "containers"
  ]);
  assert.ok(monitoringCalls.every(({ address }) => address === "10.20.30.60"));
  assert.ok(monitoringCalls.every(({ tlsMode }) => tlsMode === "system"));
  assert.ok(monitoringCalls.every(({ accessToken }) => accessToken === ACCESS_TOKEN));
  assert.equal(JSON.stringify(refreshed.json).includes(ACCESS_TOKEN), false);
});
