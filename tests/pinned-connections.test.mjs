// Pinned TLS requests must travel over the connection whose certificate was
// checked, and that connection must close when the exchange is over.
//
// Node ignores `createConnection` while an agent is set, and `agent: false`
// creates a fresh agent per request. Helmsman once set both, so every pinned
// Portainer, Proxmox and Loki request opened a second, unpinned connection
// for the actual request and left the verified one open for the life of the
// process: about 14 leaked TLS sockets a minute for one Portainer server,
// and the container's memory grew until it was killed.

import assert from "node:assert/strict";
import { once } from "node:events";
import https from "node:https";
import test from "node:test";

import { performPortainerUpstreamRequest, performProxmoxUpstreamRequest } from "../server/broker.mjs";
import { authorizeLokiRoute } from "../server/loki.mjs";
import { performLokiUpstreamRequest } from "../server/loki-transport.mjs";
import { authorizePortainerRoute, authorizeProxmoxRoute } from "../server/routes.mjs";
import { createSelfSignedTlsFixture } from "./helpers/self-signed-tls.mjs";

const { key: KEY, certificate: CERTIFICATE, fingerprint: FINGERPRINT } = createSelfSignedTlsFixture();
const REQUESTS = 5;

async function countingServer(body) {
  const connections = { opened: 0, open: 0 };
  const server = https.createServer({ key: KEY, cert: CERTIFICATE }, (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  server.on("secureConnection", (socket) => {
    connections.opened += 1;
    connections.open += 1;
    socket.once("close", () => { connections.open -= 1; });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    connections,
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
    resolution: {
      target: { url: `https://localhost:${port}`, protocol: "https:", hostname: "localhost", port, basePath: "", authority: `localhost:${port}` },
      pinned: { address: "127.0.0.1", family: 4 },
      addresses: [{ address: "127.0.0.1", family: 4 }]
    }
  };
}

function openClientSockets(port) {
  return process._getActiveHandles().filter((handle) => handle?.constructor?.name === "TLSSocket" && handle.remotePort === port && !handle.destroyed).length;
}

async function settle(fixture) {
  for (let attempt = 0; attempt < 50 && (fixture.connections.open || openClientSockets(fixture.port)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const transports = {
  Portainer: {
    body: JSON.stringify({ Username: "helmsman" }),
    send: (resolution) => performPortainerUpstreamRequest({
      targetResolution: resolution,
      route: authorizePortainerRoute("identity"),
      credentials: { accessToken: Buffer.from("ptr_pinned-connection-test") },
      targetRevision: "11111111-1111-4111-8111-111111111111",
      tlsMode: "pinned",
      certificateFingerprint: FINGERPRINT,
      limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 2_000 }
    })
  },
  Proxmox: {
    body: JSON.stringify({ data: { version: "9.0.6", release: "9.0", repoid: "abcdef12" } }),
    send: (resolution) => performProxmoxUpstreamRequest({
      targetResolution: resolution,
      route: authorizeProxmoxRoute("version"),
      credentials: { tokenId: Buffer.from("helmsman@pve!monitoring"), tokenSecret: Buffer.from("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") },
      tlsMode: "pinned",
      certificateFingerprint: FINGERPRINT,
      limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 2_000 }
    })
  },
  Loki: {
    body: "ready",
    send: (resolution) => performLokiUpstreamRequest({
      targetResolution: resolution,
      route: authorizeLokiRoute("ready"),
      credentials: undefined,
      authMode: "none",
      tenantId: null,
      tlsMode: "pinned",
      certificateFingerprint: FINGERPRINT,
      limits: { maxApiResponseBytes: 64 * 1024, upstreamTimeoutMs: 2_000 },
      version: "1.2.0"
    })
  }
};

for (const [name, transport] of Object.entries(transports)) {
  test(`pinned ${name} requests use the verified connection and close it`, async (t) => {
    const fixture = await countingServer(transport.body);
    t.after(fixture.close);
    for (let index = 0; index < REQUESTS; index += 1) {
      const result = await transport.send(fixture.resolution);
      assert.equal(result.status, 200);
    }
    await settle(fixture);
    assert.equal(fixture.connections.opened, REQUESTS, `${name}: one TLS connection per request, the pinned one`);
    assert.equal(fixture.connections.open, 0, `${name}: the server sees every connection closed`);
    assert.equal(openClientSockets(fixture.port), 0, `${name}: no client TLS sockets are left open`);
  });
}
