import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

import {
  performMediaActionUpstreamRequest,
  performPortainerUpstreamRequest,
  performProxmoxUpstreamRequest,
  validProxmoxActionAcknowledgement
} from "../server/broker.mjs";
import {
  authorizeBridgeRoute,
  authorizeMediaAction,
  authorizePortainerContainerAction,
  authorizePortainerRoute,
  authorizeProxmoxRoute,
  authorizeProxmoxWorkloadAction
} from "../server/routes.mjs";

const CONTAINER_ID = "a".repeat(64);

test("fixed action authorizers construct only approved provider requests", () => {
  const start = authorizePortainerContainerAction("start", { endpointId: 12, containerId: CONTAINER_ID });
  assert.deepEqual({
    method: start.method,
    path: start.upstreamPathAndQuery,
    internalOnly: start.internalOnly
  }, {
    method: "POST",
    path: `/api/endpoints/12/docker/containers/${CONTAINER_ID}/start`,
    internalOnly: true
  });
  assert.equal(
    authorizePortainerContainerAction("restart", { endpointId: 12, containerId: CONTAINER_ID }).upstreamPathAndQuery,
    `/api/endpoints/12/docker/containers/${CONTAINER_ID}/restart?t=30`
  );
  assert.equal(
    authorizePortainerContainerAction("stop", { endpointId: 12, containerId: CONTAINER_ID }).upstreamPathAndQuery,
    `/api/endpoints/12/docker/containers/${CONTAINER_ID}/stop?t=30`
  );

  const qemu = authorizeProxmoxWorkloadAction("reboot", { node: "Main", type: "qemu", vmid: 101 });
  assert.equal(qemu.method, "POST");
  assert.equal(qemu.upstreamPathAndQuery, "/api2/json/nodes/Main/qemu/101/status/reboot");
  const lxc = authorizeProxmoxWorkloadAction("shutdown", { node: "Unitrend", type: "lxc", vmid: 104 });
  assert.equal(lxc.upstreamPathAndQuery, "/api2/json/nodes/Unitrend/lxc/104/status/shutdown");

  const retry = authorizeMediaAction("retryRequest", { service: "seerr", resourceId: 41 });
  assert.equal(retry.upstreamPathAndQuery, "/api/v1/request/41/retry");
  assert.equal(retry.body, "");
  const movie = authorizeMediaAction("searchMovie", { service: "radarr", resourceId: 22 });
  assert.equal(movie.upstreamPathAndQuery, "/api/v3/command");
  assert.deepEqual(JSON.parse(movie.body), { name: "MoviesSearch", movieIds: [22] });
  const series = authorizeMediaAction("searchSeries", { service: "sonarr", resourceId: 33 });
  assert.deepEqual(JSON.parse(series.body), { name: "SeriesSearch", seriesId: 33 });
});

test("Proxmox action acknowledgements require one bounded UPID and never need exposure", () => {
  assert.equal(validProxmoxActionAcknowledgement(
    Buffer.from('{"data":"UPID:Main:00000001:00000002:00000003:qmreboot:101:helmsman@pve:"}')
  ), true);
  for (const value of [
    Buffer.from(""),
    Buffer.from("not-json"),
    Buffer.from("{}"),
    Buffer.from('{"data":null}'),
    Buffer.from('{"data":"not-a-task"}'),
    Buffer.from(JSON.stringify({ data: `UPID:${"x".repeat(1025)}` }))
  ]) {
    assert.equal(validProxmoxActionAcknowledgement(value), false);
  }
});

test("action authorizers reject short IDs, invalid tuples, and path-like values", () => {
  for (const candidate of [
    authorizePortainerContainerAction("restart", { endpointId: 1, containerId: "a".repeat(12) }),
    authorizePortainerContainerAction("remove", { endpointId: 1, containerId: CONTAINER_ID }),
    authorizePortainerContainerAction("start", { endpointId: "1/containers", containerId: CONTAINER_ID }),
    authorizeProxmoxWorkloadAction("stop", { node: "Main", type: "qemu", vmid: 101 }),
    authorizeProxmoxWorkloadAction("reboot", { node: "../Main", type: "qemu", vmid: 101 }),
    authorizeProxmoxWorkloadAction("reboot", { node: "Main", type: "storage", vmid: 101 }),
    authorizeMediaAction("searchMovie", { service: "sonarr", resourceId: 22 }),
    authorizeMediaAction("retryRequest", { service: "seerr", resourceId: "1/2" })
  ]) {
    assert.equal(candidate.allowed, false);
  }

  assert.equal(authorizeBridgeRoute(
    "seerr",
    "POST",
    "/bridge/seerr/api/v1/request/41/retry"
  ).allowed, false, "write actions must not widen the browser bridge");
  assert.equal(authorizePortainerRoute("containers", "POST", { endpointId: 1 }).allowed, false);
  assert.equal(authorizeProxmoxRoute("guests", "POST").allowed, false);
});

test("action transports reconstruct their route and reject forged parity before credentials or network", async () => {
  const portainer = authorizePortainerContainerAction("restart", { endpointId: 1, containerId: CONTAINER_ID });
  await assert.rejects(
    performPortainerUpstreamRequest({
      targetResolution: null,
      route: { ...portainer, upstreamPathAndQuery: "/api/users" },
      credentials: { accessToken: Buffer.from("must-not-be-decoded") },
      tlsMode: "system",
      limits: {}
    }),
    (error) => error?.code === "ROUTE_NOT_ALLOWED"
  );

  const proxmox = authorizeProxmoxWorkloadAction("reboot", { node: "Main", type: "qemu", vmid: 101 });
  await assert.rejects(
    performProxmoxUpstreamRequest({
      targetResolution: null,
      route: { ...proxmox, vmid: 102 },
      credentials: {
        tokenId: Buffer.from("must-not-be-decoded"),
        tokenSecret: Buffer.from("must-not-be-decoded")
      },
      tlsMode: "system",
      limits: {}
    }),
    (error) => error?.code === "ROUTE_NOT_ALLOWED"
  );

  const media = authorizeMediaAction("searchMovie", { service: "radarr", resourceId: 22 });
  await assert.rejects(
    performMediaActionUpstreamRequest({
      targetResolution: null,
      route: { ...media, body: JSON.stringify({ name: "MoviesSearch", movieIds: [23] }) },
      credentialHeaders: { "x-api-key": "must-not-be-sent" },
      targetRevision: "11111111-1111-4111-8111-111111111111",
      limits: {}
    }),
    (error) => error?.code === "ROUTE_NOT_ALLOWED"
  );
});

test("media action transport emits only its fixed path and command body", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        apiKey: request.headers["x-api-key"],
        contentType: request.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(request.url === "/api/v3/command" ? 201 : 200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const targetResolution = {
    target: {
      url: `http://127.0.0.1:${port}`,
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
      basePath: "",
      authority: `127.0.0.1:${port}`
    },
    pinned: { address: "127.0.0.1", family: 4 }
  };
  const limits = { maxApiResponseBytes: 4096, maxImageResponseBytes: 4096, upstreamTimeoutMs: 1000 };
  await performMediaActionUpstreamRequest({
    targetResolution,
    route: authorizeMediaAction("searchMovie", { service: "radarr", resourceId: 22 }),
    credentialHeaders: { "x-api-key": "radarr-test-key" },
    targetRevision: "11111111-1111-4111-8111-111111111111",
    limits
  });
  await performMediaActionUpstreamRequest({
    targetResolution,
    route: authorizeMediaAction("retryRequest", { service: "seerr", resourceId: 41 }),
    credentialHeaders: { "x-api-key": "seerr-test-key" },
    targetRevision: "22222222-2222-4222-8222-222222222222",
    limits
  });
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/api/v3/command",
      apiKey: "radarr-test-key",
      contentType: "application/json",
      body: JSON.stringify({ name: "MoviesSearch", movieIds: [22] })
    },
    {
      method: "POST",
      url: "/api/v1/request/41/retry",
      apiKey: "seerr-test-key",
      contentType: undefined,
      body: ""
    }
  ]);
});
