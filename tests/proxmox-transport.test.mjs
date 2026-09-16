import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import { once } from "node:events";

import { performProxmoxUpstreamRequest } from "../server/broker.mjs";
import { authorizeProxmoxRoute, authorizeProxmoxWorkloadAction } from "../server/routes.mjs";
import { createSelfSignedTlsFixture } from "./helpers/self-signed-tls.mjs";

const {
  key: KEY,
  certificate: CERTIFICATE,
  fingerprint: FINGERPRINT
} = createSelfSignedTlsFixture();
const TOKEN_ID = "helmsman@pve!monitoring";
const TOKEN_SECRET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

function requestOptions(resolution, overrides = {}) {
  return {
    targetResolution: resolution,
    route: authorizeProxmoxRoute("version"),
    credentials: {
      tokenId: Buffer.from(TOKEN_ID),
      tokenSecret: Buffer.from(TOKEN_SECRET)
    },
    tlsMode: "pinned",
    certificateFingerprint: FINGERPRINT,
    limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 1_000 },
    ...overrides
  };
}

test("pinned TLS verifies the leaf before sending the Proxmox token", async (t) => {
  let requests = 0;
  let authorization = null;
  const fixture = await fixtureServer((request, response) => {
    requests += 1;
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":{"version":"9.1.7"}}');
  });
  t.after(fixture.close);

  const result = await performProxmoxUpstreamRequest(requestOptions(fixture.resolution));
  assert.equal(result.status, 200);
  assert.equal(result.body.toString("utf8"), '{"data":{"version":"9.1.7"}}');
  assert.equal(requests, 1);
  assert.equal(authorization, `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`);

  let credentialSerializations = 0;
  const tokenId = Buffer.from(TOKEN_ID);
  const tokenSecret = Buffer.from(TOKEN_SECRET);
  tokenId.toString = (...arguments_) => {
    credentialSerializations += 1;
    return Buffer.prototype.toString.call(tokenId, ...arguments_);
  };
  tokenSecret.toString = (...arguments_) => {
    credentialSerializations += 1;
    return Buffer.prototype.toString.call(tokenSecret, ...arguments_);
  };
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(fixture.resolution, {
      certificateFingerprint: "0".repeat(64),
      credentials: { tokenId, tokenSecret }
    })),
    (error) => error?.code === "TLS_PIN_MISMATCH"
  );
  assert.equal(requests, 1, "a pin mismatch must fail before an HTTP request carries the token");
  assert.equal(credentialSerializations, 0, "a pin mismatch must fail before credential serialization");
});

test("system trust rejects an untrusted Proxmox certificate with an actionable code", async (t) => {
  let requests = 0;
  const fixture = await fixtureServer((_request, response) => {
    requests += 1;
    response.end('{"data":{}}');
  });
  t.after(fixture.close);
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(fixture.resolution, {
      tlsMode: "system",
      certificateFingerprint: null
    })),
    (error) => error?.code === "TLS_CERTIFICATE_UNTRUSTED"
  );
  assert.equal(requests, 0);
});

test("Proxmox transport rejects redirects and oversized bodies", async (t) => {
  const redirect = await fixtureServer((_request, response) => {
    response.writeHead(302, { location: "https://example.invalid/steal" });
    response.end();
  });
  t.after(redirect.close);
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(redirect.resolution)),
    (error) => error?.code === "UPSTREAM_REDIRECT_REJECTED"
  );

  const oversized = await fixtureServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: "x".repeat(2_000) }));
  });
  t.after(oversized.close);
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(oversized.resolution, {
      limits: { maxApiResponseBytes: 128, upstreamTimeoutMs: 1_000 }
    })),
    (error) => error?.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );
});

test("Proxmox transport revalidates its fixed route instead of trusting a forged route object", async () => {
  const resolution = {
    target: {
      url: "https://127.0.0.1:8006",
      protocol: "https:",
      hostname: "127.0.0.1",
      port: 8006,
      basePath: "",
      authority: "127.0.0.1:8006"
    },
    pinned: { address: "127.0.0.1", family: 4 }
  };
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(resolution, {
      route: {
        ...authorizeProxmoxRoute("version"),
        upstreamPath: "/api2/json/access/ticket",
        upstreamPathAndQuery: "/api2/json/access/ticket"
      }
    })),
    (error) => error?.code === "ROUTE_NOT_ALLOWED"
  );
});

test("Proxmox transport reconstructs node-scoped task routes and rejects forged node parity", async (t) => {
  let requests = 0;
  let requestUrl = null;
  const fixture = await fixtureServer((request, response) => {
    requests += 1;
    requestUrl = request.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  t.after(fixture.close);

  const route = authorizeProxmoxRoute("tasks", "GET", { node: "pve-1" });
  const result = await performProxmoxUpstreamRequest(requestOptions(fixture.resolution, { route }));
  assert.equal(result.status, 200);
  assert.equal(requestUrl, "/api2/json/nodes/pve-1/tasks?source=archive&limit=100");
  assert.equal(requests, 1);

  for (const forged of [
    { ...route, node: "pve-2" },
    { ...route, upstreamPath: "/api2/json/access/ticket", upstreamPathAndQuery: "/api2/json/access/ticket" },
    { ...authorizeProxmoxRoute("version"), node: "pve-1" }
  ]) {
    await assert.rejects(
      performProxmoxUpstreamRequest(requestOptions(fixture.resolution, { route: forged })),
      (error) => error?.code === "ROUTE_NOT_ALLOWED"
    );
  }
  assert.equal(requests, 1, "forged dynamic routes must be rejected before a token-bearing request is sent");
});

test("Proxmox action transport sends the exact authenticated POST and returns a bounded acknowledgement", async (t) => {
  const requests = [];
  const fixture = await fixtureServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":"UPID:pve-a:00000001:00000002:00000003:qmreboot:2101:helmsman@pve:"}');
    });
  });
  t.after(fixture.close);
  const route = authorizeProxmoxWorkloadAction("reboot", { node: "pve-a", type: "qemu", vmid: 2101 });
  const result = await performProxmoxUpstreamRequest(requestOptions(fixture.resolution, { route }));
  assert.equal(result.status, 200);
  assert.ok(result.body.length < 1024);
  assert.deepEqual(requests, [{
    method: "POST",
    url: "/api2/json/nodes/pve-a/qemu/2101/status/reboot",
    authorization: `PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}`,
    body: ""
  }]);
});

test("Proxmox transport rejects a nonliteral or family-mismatched SSRF pin", async () => {
  const base = {
    target: {
      url: "https://proxmox.invalid:8006",
      protocol: "https:",
      hostname: "proxmox.invalid",
      port: 8006,
      basePath: "",
      authority: "proxmox.invalid:8006"
    }
  };
  for (const pinned of [
    { address: "rebinding.invalid", family: 4 },
    { address: "127.0.0.1", family: 6 }
  ]) {
    await assert.rejects(
      performProxmoxUpstreamRequest(requestOptions({ ...base, pinned })),
      (error) => error?.code === "INVALID_TARGET_RESOLUTION"
    );
  }
});

test("Proxmox transport times out bounded stalled responses", async (t) => {
  const fixture = await fixtureServer(() => {});
  t.after(fixture.close);
  await assert.rejects(
    performProxmoxUpstreamRequest(requestOptions(fixture.resolution, {
      limits: { maxApiResponseBytes: 1024, upstreamTimeoutMs: 50 }
    })),
    (error) => error?.code === "UPSTREAM_TIMEOUT"
  );
});
