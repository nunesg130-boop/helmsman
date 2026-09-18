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

import { authorizeLokiRoute } from "../server/loki.mjs";
import { performLokiUpstreamRequest } from "../server/loki-transport.mjs";
import { createSelfSignedTlsFixture } from "./helpers/self-signed-tls.mjs";

const execFileAsync = promisify(execFile);
const START = "1789750800000000000";
const END = "1789754400000000000";
const BASIC_USERNAME = "helmsman_reader";
const BASIC_PASSWORD = "loki-test-password";
const BEARER_TOKEN = "loki_test_token.123";
const {
  key: KEY,
  certificate: CERTIFICATE,
  fingerprint: FINGERPRINT
} = createSelfSignedTlsFixture();

async function fixtureServer(handler, protocol = "https:") {
  const server = protocol === "https:"
    ? https.createServer({ key: KEY, cert: CERTIFICATE }, handler)
    : http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    server,
    close: async () => {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
    resolution: {
      target: {
        url: `${protocol}//localhost:${port}`,
        protocol,
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

function transportOptions(resolution, route = authorizeLokiRoute("ready"), overrides = {}) {
  return {
    targetResolution: resolution,
    route,
    credentials: undefined,
    authMode: "none",
    tenantId: null,
    tlsMode: resolution.target.protocol === "https:" ? "pinned" : "none",
    certificateFingerprint: resolution.target.protocol === "https:" ? FINGERPRINT : null,
    limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 1_000 },
    version: "1.1.1",
    ...overrides
  };
}

test("Loki transport permits private HTTP only without credentials or TLS settings", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      encoding: request.headers["accept-encoding"],
      host: request.headers.host,
      userAgent: request.headers["user-agent"],
      connection: request.headers.connection
    });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ready");
  }, "http:");
  t.after(fixture.close);

  const result = await performLokiUpstreamRequest(transportOptions(fixture.resolution));
  assert.equal(result.status, 200);
  assert.equal(result.body.toString("utf8"), "ready");
  assert.deepEqual(requests, [{
    method: "GET",
    url: "/ready",
    authorization: undefined,
    accept: "application/json,text/plain",
    encoding: "identity",
    host: fixture.resolution.target.authority,
    userAgent: "Helmsman/1.1.1",
    connection: "close"
  }]);

  for (const overrides of [
    {
      authMode: "basic",
      credentials: { username: Buffer.from(BASIC_USERNAME), password: Buffer.from(BASIC_PASSWORD) }
    },
    { authMode: "bearer", credentials: { token: Buffer.from(BEARER_TOKEN) } },
    { tlsMode: "system" },
    { certificateFingerprint: FINGERPRINT }
  ]) {
    await assert.rejects(
      performLokiUpstreamRequest(transportOptions(fixture.resolution, undefined, overrides)),
      (error) => ["HTTPS_REQUIRED", "INVALID_TLS_MODE", "CERTIFICATE_FINGERPRINT_NOT_ALLOWED"].includes(error?.code)
    );
  }
  assert.equal(requests.length, 1, "an insecure authenticated request must fail before network dispatch");
});

test("pinned Loki TLS verifies the leaf before decoding credentials and emits bounded headers", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      tenant: request.headers["x-scope-orgid"]
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"success"}');
  });
  t.after(fixture.close);

  const queryRoute = authorizeLokiRoute("queryRange", "GET", {
    query: '{service_name="radarr"} |= "failed"',
    start: START,
    end: END,
    direction: "backward",
    limit: 50
  });
  const basic = await performLokiUpstreamRequest(transportOptions(fixture.resolution, queryRoute, {
    authMode: "basic",
    credentials: {
      username: Buffer.from(BASIC_USERNAME),
      password: Buffer.from(BASIC_PASSWORD)
    },
    tenantId: "homelab_1"
  }));
  assert.equal(basic.status, 200);
  assert.equal(
    requests[0].authorization,
    `Basic ${Buffer.from(`${BASIC_USERNAME}:${BASIC_PASSWORD}`, "utf8").toString("base64")}`
  );
  assert.equal(requests[0].tenant, "homelab_1");
  assert.equal(requests[0].url, queryRoute.upstreamPathAndQuery);

  const bearer = await performLokiUpstreamRequest(transportOptions(
    fixture.resolution,
    authorizeLokiRoute("labels"),
    { authMode: "bearer", credentials: { token: Buffer.from(BEARER_TOKEN) } }
  ));
  assert.equal(bearer.status, 200);
  assert.equal(requests[1].authorization, `Bearer ${BEARER_TOKEN}`);
  assert.equal(requests[1].tenant, undefined);

  let serializations = 0;
  const username = Buffer.from(BASIC_USERNAME);
  const password = Buffer.from(BASIC_PASSWORD);
  for (const credential of [username, password]) {
    credential.toString = (...arguments_) => {
      serializations += 1;
      return Buffer.prototype.toString.call(credential, ...arguments_);
    };
  }
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(fixture.resolution, authorizeLokiRoute("ready"), {
      authMode: "basic",
      credentials: { username, password },
      certificateFingerprint: "0".repeat(64)
    })),
    (error) => error?.code === "TLS_PIN_MISMATCH"
  );
  assert.equal(serializations, 0, "pin rejection must precede credential decoding");
  assert.equal(requests.length, 2, "pin rejection must precede authenticated HTTP dispatch");
});

test("system-trusted Loki HTTPS sends basic and bearer credentials only after TLS succeeds", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      tenant: request.headers["x-scope-orgid"]
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(fixture.close);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "helmsman-loki-ca-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const certificatePath = path.join(temporary, "loki-test-ca.pem");
  await writeFile(certificatePath, CERTIFICATE, { mode: 0o600 });

  const transportModule = new URL("../server/loki-transport.mjs", import.meta.url).href;
  const lokiModule = new URL("../server/loki.mjs", import.meta.url).href;
  const child = `
    import { performLokiUpstreamRequest } from ${JSON.stringify(transportModule)};
    import { authorizeLokiRoute } from ${JSON.stringify(lokiModule)};
    const targetResolution = JSON.parse(process.env.LOKI_TEST_RESOLUTION);
    const common = {
      targetResolution,
      tlsMode: "system",
      certificateFingerprint: null,
      limits: { maxApiResponseBytes: 4096, upstreamTimeoutMs: 1000 }
    };
    await performLokiUpstreamRequest({
      ...common,
      route: authorizeLokiRoute("ready"),
      authMode: "basic",
      tenantId: "tenant-a",
      credentials: {
        username: Buffer.from(process.env.LOKI_TEST_USERNAME, "utf8"),
        password: Buffer.from(process.env.LOKI_TEST_PASSWORD, "utf8")
      }
    });
    await performLokiUpstreamRequest({
      ...common,
      route: authorizeLokiRoute("labels"),
      authMode: "bearer",
      tenantId: null,
      credentials: { token: Buffer.from(process.env.LOKI_TEST_TOKEN, "utf8") }
    });
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", child], {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certificatePath,
      NODE_NO_WARNINGS: "1",
      LOKI_TEST_RESOLUTION: JSON.stringify(fixture.resolution),
      LOKI_TEST_USERNAME: BASIC_USERNAME,
      LOKI_TEST_PASSWORD: BASIC_PASSWORD,
      LOKI_TEST_TOKEN: BEARER_TOKEN
    },
    timeout: 5_000
  });

  assert.deepEqual(requests, [
    {
      url: "/ready",
      authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${BASIC_PASSWORD}`).toString("base64")}`,
      tenant: "tenant-a"
    },
    { url: "/loki/api/v1/labels", authorization: `Bearer ${BEARER_TOKEN}`, tenant: undefined }
  ]);
});

test("Loki transport reconstructs dynamic routes and rejects forged route parity", async (t) => {
  let requests = 0;
  const fixture = await fixtureServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"success","data":[]}');
  });
  t.after(fixture.close);
  const route = authorizeLokiRoute("labelValues", "GET", { labelName: "service_name" });
  await performLokiUpstreamRequest(transportOptions(fixture.resolution, route));
  assert.equal(requests, 1);

  const queryRoute = authorizeLokiRoute("queryRange", "GET", {
    query: '{job="helmsman"}',
    start: START,
    end: END
  });
  for (const forged of [
    { ...route, labelName: "job" },
    { ...route, upstreamPathAndQuery: "/loki/api/v1/labels" },
    { ...route, method: "POST" },
    { ...route, routeId: "ready" },
    { ...route, internalOnly: false },
    { ...authorizeLokiRoute("ready"), query: "{job=\"attacker\"}" },
    { ...queryRoute, query: '{job="attacker"}' },
    { ...queryRoute, upstreamPathAndQuery: `${queryRoute.upstreamPathAndQuery}&limit=500` }
  ]) {
    await assert.rejects(
      performLokiUpstreamRequest(transportOptions(fixture.resolution, forged)),
      (error) => error?.code === "ROUTE_NOT_ALLOWED"
    );
  }
  assert.equal(requests, 1, "forged Loki routes must fail before network dispatch");
});

test("Loki transport rejects redirects, oversized, compressed, HTML, and stalled responses", async (t) => {
  const redirect = await fixtureServer((_request, response) => {
    response.writeHead(302, { location: "https://example.invalid/steal" });
    response.end();
  });
  t.after(redirect.close);
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(redirect.resolution)),
    (error) => error?.code === "UPSTREAM_REDIRECT_REJECTED"
  );

  const oversized = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: "x".repeat(2_000) }));
  });
  t.after(oversized.close);
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(oversized.resolution, undefined, {
      limits: { maxApiResponseBytes: 128, upstreamTimeoutMs: 1_000 }
    })),
    (error) => error?.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );

  const compressed = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end("not-compressed-on-purpose");
  });
  t.after(compressed.close);
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(compressed.resolution)),
    (error) => error?.code === "UPSTREAM_CONTENT_REJECTED"
  );

  const html = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("<!doctype html><title>reverse proxy login</title>");
  });
  t.after(html.close);
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(html.resolution)),
    (error) => error?.code === "UPSTREAM_CONTENT_REJECTED"
  );

  const stalled = await fixtureServer(() => {});
  t.after(stalled.close);
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(stalled.resolution, undefined, {
      limits: { maxApiResponseBytes: 1_024, upstreamTimeoutMs: 50 }
    })),
    (error) => error?.code === "UPSTREAM_TIMEOUT"
  );
});

test("Loki transport validates pins, tenant headers, credentials, and sanitized failures", async (t) => {
  const fixture = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ready");
  }, "http:");
  t.after(fixture.close);
  const base = fixture.resolution.target;
  for (const pinned of [
    { address: "rebinding.invalid", family: 4 },
    { address: "127.0.0.1", family: 6 },
    { address: "::1", family: 4 }
  ]) {
    await assert.rejects(
      performLokiUpstreamRequest(transportOptions({ ...fixture.resolution, pinned })),
      (error) => error?.code === "INVALID_TARGET_RESOLUTION"
    );
  }
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions({
      ...fixture.resolution,
      target: { ...base, authority: "localhost\r\nX-Evil: yes" }
    })),
    (error) => error?.code === "INVALID_TARGET_RESOLUTION"
  );

  for (const tenantId of ["tenant|other", " space", "tenant/value", "x".repeat(151)]) {
    await assert.rejects(
      performLokiUpstreamRequest(transportOptions(fixture.resolution, undefined, { tenantId })),
      (error) => error?.code === "INVALID_TENANT_ID" && !error.message.includes(tenantId)
    );
  }

  const secret = "do-not-reflect-this-secret";
  await assert.rejects(
    performLokiUpstreamRequest(transportOptions(fixture.resolution, undefined, {
      authMode: "bearer",
      tlsMode: "system",
      credentials: { token: Buffer.from(secret) }
    })),
    (error) => !String(error?.message).includes(secret)
  );
});
