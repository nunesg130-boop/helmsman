import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBroker, createHttpServer } from "../server/broker.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const ARTWORK_TOKEN = "0123456789abcdef";
const ARTWORK_PATH = `/api/v2/media/artwork/${ARTWORK_TOKEN}`;
const SONARR_FALLBACK_TOKEN = "abcdefabcdefabcd";
const SONARR_FALLBACK_PATH = `/api/v2/media/artwork/${SONARR_FALLBACK_TOKEN}`;
const INTERNAL_RESOURCE = "private-jellyfin-item-id";
const INTERNAL_REVISION = "abcdef0123456789abcdef0123456789";
const TARGET_REVISION = "11111111-1111-4111-8111-111111111111";

function request(port, pathname, options = {}) {
  const body = options.body === undefined
    ? null
    : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(JSON.stringify(options.body), "utf8");
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
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {}),
        ...(options.headers || {})
      },
      agent: false
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const contentType = String(response.headers["content-type"] || "");
        let json = null;
        if (bytes.length && contentType.includes("application/json")) {
          try {
            json = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve({ status: response.statusCode, headers: response.headers, bytes, json });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function start(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-media-artwork-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const internalSnapshot = {
    version: 2,
    generatedAt: "2026-09-13T22:00:00.000Z",
    overall: { state: "healthy" },
    services: [],
    incidents: { open: [], recent: [] },
    media: {
      home: [{
        id: "movie:tmdb:550",
        title: "Fight Club",
        artworkUrl: ARTWORK_PATH
      }],
      artwork: {
        [ARTWORK_TOKEN]: {
          version: 4,
          sources: [{
            service: "jellyfin",
            kind: "primary",
            resource: INTERNAL_RESOURCE,
            revision: INTERNAL_REVISION,
            variant: "w342q85",
            targetRevision: TARGET_REVISION
          }]
        }
      }
    }
  };
  let artworkResult = {
    body: Buffer.from("valid-artwork-bytes"),
    contentType: "image/png"
  };
  const artworkCalls = [];
  const monitor = {
    getSnapshot: () => internalSnapshot,
    refresh: async () => internalSnapshot,
    requestRefresh() {}
  };
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    fetchMediaArtwork: async (descriptor, context) => {
      artworkCalls.push({ descriptor, requestMethod: context?.request?.method, signal: context?.signal });
      return typeof options.fetchMediaArtwork === "function"
        ? options.fetchMediaArtwork(descriptor, context)
        : artworkResult;
    }
  });
  controlPlane.setMonitor(monitor);

  const server = http.createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (await controlPlane.handle(incoming, response, url)) return;
      const payload = Buffer.from(JSON.stringify({ code: "NOT_FOUND", message: "Not found." }), "utf8");
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Content-Length", String(payload.length));
      response.end(incoming.method === "HEAD" ? undefined : payload);
    } catch (error) {
      const status = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      const payload = Buffer.from(JSON.stringify({
        code: error?.code || "INTERNAL_ERROR",
        message: error instanceof ControlPlaneError ? error.message : "Request failed."
      }), "utf8");
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Content-Length", String(payload.length));
      response.end(incoming.method === "HEAD" ? undefined : payload);
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
    internalSnapshot,
    artworkCalls,
    controlPlane,
    server,
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`,
    setArtworkResult(value) { artworkResult = value; }
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
      deviceName: "Artwork test browser",
      origin: context.origin,
      allowedCidrs: [],
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

test("media artwork endpoint requires a browser session and permits only GET or HEAD", async (t) => {
  const context = await start();
  t.after(() => stop(context));

  const anonymous = await request(context.port, ARTWORK_PATH);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, "SESSION_REQUIRED");
  assert.equal(context.artworkCalls.length, 0);

  const authentication = await claim(context);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const rejected = await request(context.port, ARTWORK_PATH, { method, ...authentication });
    assert.equal(rejected.status, 405, method);
    assert.equal(rejected.json.code, "METHOD_NOT_ALLOWED", method);
  }
  assert.equal(context.artworkCalls.length, 0, "rejected methods cannot invoke the artwork loader");

  const head = await request(context.port, ARTWORK_PATH, { method: "HEAD", cookie: authentication.cookie });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["content-length"], String(Buffer.byteLength("valid-artwork-bytes")));
  assert.equal(context.artworkCalls.at(-1).requestMethod, "HEAD");
});

test("media artwork endpoint rejects unknown, malformed, and query-bearing tokens", async (t) => {
  const context = await start();
  t.after(() => stop(context));
  const authentication = await claim(context);

  for (const [pathname, expectedCode] of [
    ["/api/v2/media/artwork/aaaaaaaaaaaaaaaa", "MEDIA_ARTWORK_NOT_FOUND"],
    ["/api/v2/media/artwork/abc", "MEDIA_ARTWORK_NOT_FOUND"],
    ["/api/v2/media/artwork/short", "NOT_FOUND"],
    [`${ARTWORK_PATH}?url=https%3A%2F%2Fevil.test`, "MEDIA_ARTWORK_NOT_FOUND"],
    ["/api/v2/media/artwork/0123456789ABCDEF", "NOT_FOUND"],
    ["/api/v2/media/artwork/0123456789abcdef/extra", "NOT_FOUND"]
  ]) {
    const response = await request(context.port, pathname, { cookie: authentication.cookie });
    assert.equal(response.status, 404, pathname);
    assert.equal(response.json.code, expectedCode, pathname);
  }
  assert.equal(context.artworkCalls.length, 0);
});

test("serves same-origin private artwork with stable ETag, conditional GET, and HEAD semantics", async (t) => {
  const context = await start();
  t.after(() => stop(context));
  const authentication = await claim(context);
  const body = Buffer.from("valid-artwork-bytes");
  const expectedEtag = `"${createHash("sha256").update(body).digest("base64url")}"`;

  const first = await request(context.port, ARTWORK_PATH, { cookie: authentication.cookie });
  assert.equal(first.status, 200);
  assert.deepEqual(first.bytes, body);
  assert.equal(first.headers["content-type"], "image/png");
  assert.equal(first.headers.etag, expectedEtag);
  assert.equal(first.headers["content-length"], String(body.length));
  assert.equal(first.headers["cache-control"], "private, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800");
  assert.equal(first.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(first.headers["x-content-type-options"], "nosniff");
  assert.equal(first.headers.pragma, undefined);
  assert.equal(first.headers.expires, undefined);
  assert.deepEqual(context.artworkCalls[0].descriptor, context.internalSnapshot.media.artwork[ARTWORK_TOKEN]);

  const notModified = await request(context.port, ARTWORK_PATH, {
    cookie: authentication.cookie,
    headers: { "If-None-Match": expectedEtag }
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.bytes.length, 0);
  assert.equal(notModified.headers.etag, expectedEtag);
  assert.equal(notModified.headers["cache-control"], "private, max-age=86400, stale-while-revalidate=604800, stale-if-error=604800");

  const head = await request(context.port, ARTWORK_PATH, {
    method: "HEAD",
    cookie: authentication.cookie
  });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers.etag, expectedEtag);
  assert.equal(head.headers["content-length"], String(body.length));

  context.setArtworkResult({ body, contentType: "IMAGE/JPEG; charset=binary", etag: "W/invalid" });
  const normalized = await request(context.port, ARTWORK_PATH, { cookie: authentication.cookie });
  assert.equal(normalized.status, 200);
  assert.equal(normalized.headers["content-type"], "image/jpeg");
  assert.equal(normalized.headers.etag, expectedEtag, "invalid upstream ETags are replaced with a stable body digest");
});

test("fails closed for missing, oversized, or unsupported artwork responses", async (t) => {
  const context = await start();
  t.after(() => stop(context));
  const authentication = await claim(context);

  const invalidResults = [
    null,
    { body: Buffer.alloc(0), contentType: "image/png" },
    { body: Buffer.from("html"), contentType: "text/html" },
    { body: Buffer.from("svg"), contentType: "image/svg+xml" },
    { body: Buffer.from("text masquerading as data"), contentType: "application/octet-stream" },
    { body: "not-a-buffer", contentType: "image/png" },
    { body: Buffer.alloc(4 * 1024 * 1024 + 1, 1), contentType: "image/jpeg" }
  ];
  for (const result of invalidResults) {
    context.setArtworkResult(result);
    const response = await request(context.port, ARTWORK_PATH, { cookie: authentication.cookie });
    assert.equal(response.status, 404);
    assert.equal(response.json.code, "MEDIA_ARTWORK_NOT_FOUND");
  }
});

test("aborting the browser socket cancels only that request's artwork wait", async (t) => {
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  let observedAbort;
  const didAbort = new Promise((resolve) => { observedAbort = resolve; });
  const context = await start({
    fetchMediaArtwork: async (_descriptor, { signal }) => {
      started(signal);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      observedAbort(signal.aborted);
      return null;
    }
  });
  t.after(() => stop(context));
  const authentication = await claim(context);
  const outgoing = http.request({
    hostname: "127.0.0.1",
    port: context.port,
    path: ARTWORK_PATH,
    method: "GET",
    headers: { Host: `127.0.0.1:${context.port}`, Cookie: authentication.cookie },
    agent: false
  });
  outgoing.on("error", () => {});
  outgoing.end();
  const signal = await didStart;
  assert.equal(signal.aborted, false);
  outgoing.destroy();
  assert.equal(await didAbort, true);
  assert.equal(context.artworkCalls.length, 1);
});

test("public operations snapshot and refresh strip the private artwork descriptor table", async (t) => {
  const context = await start();
  t.after(() => stop(context));
  const authentication = await claim(context);

  const snapshot = await request(context.port, "/api/v2/operations/snapshot", {
    cookie: authentication.cookie
  });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.media.home[0].artworkUrl, ARTWORK_PATH);
  assert.equal(Object.hasOwn(snapshot.json.media, "artwork"), false);
  assert.equal(JSON.stringify(snapshot.json).includes(INTERNAL_RESOURCE), false);
  assert.equal(Object.hasOwn(context.internalSnapshot.media, "artwork"), true, "public projection cannot mutate the monitor snapshot");

  const refreshed = await request(context.port, "/api/v2/operations/refresh", {
    method: "POST",
    body: {},
    ...authentication
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.media.home[0].artworkUrl, ARTWORK_PATH);
  assert.equal(Object.hasOwn(refreshed.json.media, "artwork"), false);
  assert.equal(JSON.stringify(refreshed.json).includes(INTERNAL_RESOURCE), false);
  assert.equal(context.artworkCalls.length, 0, "operations responses cannot resolve or expose artwork descriptors");
});

test("broker wiring retrieves artwork with bounded dispatch and never crosses a rotated target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-media-artwork-broker-"));
  const dataDir = path.join(root, "data");
  const credential = "dedicated-jellyfin-artwork-token";
  const upstreamBody = Buffer.from("broker-artwork-bytes");
  const upstreamCalls = [];
  let blockQueuedArtwork = false;
  let releaseBlockedArtwork;
  const blockedArtwork = new Promise((resolve) => { releaseBlockedArtwork = resolve; });
  let queuedArtworkStarted = 0;
  let resolveThreeQueuedStarts;
  const threeQueuedStarts = new Promise((resolve) => { resolveThreeQueuedStarts = resolve; });
  const broker = await createBroker({
    dataDir,
    lookup: async (hostname) => {
      assert.ok(["media.test", "replacement.test", "seerr.test"].includes(hostname));
      return [{ address: "10.20.30.40", family: 4 }];
    },
    dispatchUpstream: async (input) => {
      upstreamCalls.push(input);
      if (blockQueuedArtwork
        && input.route.isArtwork
        && input.route.upstreamPath.includes("queued-")) {
        queuedArtworkStarted += 1;
        if (queuedArtworkStarted === 3) resolveThreeQueuedStarts();
        await blockedArtwork;
      }
      if (input.route.service === "seerr" && input.route.upstreamPath === "/api/v1/tv/912") {
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ posterPath: "/vision_quest.jpg" })),
          contentType: "application/json",
          cookies: []
        };
      }
      if (input.route.service === "seerr" && input.route.upstreamPath.includes("vision_quest.jpg")) {
        return {
          status: 200,
          body: Buffer.from("seerr-fallback-artwork"),
          contentType: "image/jpeg",
          cookies: []
        };
      }
      return {
        status: 200,
        body: Buffer.from(upstreamBody),
        contentType: "image/png",
        cookies: []
      };
    },
    log() {}
  });
  const server = createHttpServer(broker.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    broker.beginShutdown();
    await new Promise((resolve) => server.close(resolve));
    await broker.drain();
    await rm(root, { recursive: true, force: true });
  });

  const claimed = await request(port, "/api/v2/setup/claim", {
    method: "POST",
    origin,
    body: {
      setupToken: broker.setupToken,
      deviceName: "Broker artwork browser",
      origin,
      allowedCidrs: [],
      allowPublicHttps: false
    }
  });
  assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
  const authentication = {
    origin,
    cookie: claimed.headers["set-cookie"][0].split(";", 1)[0],
    csrf: claimed.json.csrfToken
  };
  const saved = await request(port, "/api/v2/services/jellyfin", {
    method: "PUT",
    body: {
      url: "http://media.test:8096",
      authMode: "token",
      credential,
      monitoringEnabled: true
    },
    ...authentication
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));

  broker.controlPlane.setMonitor({
    getSnapshot: () => ({
      version: 2,
      media: {
        home: [{ id: "movie:tmdb:550", artworkUrl: ARTWORK_PATH }],
        artwork: {
          [ARTWORK_TOKEN]: {
            version: 4,
            sources: [{
              service: "jellyfin",
              kind: "primary",
              resource: INTERNAL_RESOURCE,
              revision: INTERNAL_REVISION,
              variant: "w342q85",
              targetRevision: saved.json.targetRevision
            }]
          }
        }
      }
    }),
    refresh: async () => ({ version: 2 }),
    requestRefresh() {}
  });

  const artwork = await request(port, ARTWORK_PATH, { cookie: authentication.cookie });
  assert.equal(artwork.status, 200, JSON.stringify(artwork.json));
  assert.deepEqual(artwork.bytes, upstreamBody);
  assert.equal(artwork.headers["content-type"], "image/png");
  const artworkUpstreamCalls = upstreamCalls.filter(({ route }) => route.isArtwork);
  assert.equal(artworkUpstreamCalls.length, 1);
  assert.equal(artworkUpstreamCalls[0].limits.upstreamTimeoutMs, 8_000);
  assert.equal(artworkUpstreamCalls[0].route.upstreamPath, `/Items/${INTERNAL_RESOURCE}/Images/Primary`);
  assert.equal(
    artworkUpstreamCalls[0].route.upstreamPathAndQuery,
    `/Items/${INTERNAL_RESOURCE}/Images/Primary?maxWidth=342&quality=85&tag=${INTERNAL_REVISION}`
  );
  assert.match(artworkUpstreamCalls[0].request.headers.authorization, /MediaBrowser/u);
  assert.match(artworkUpstreamCalls[0].request.headers.authorization, new RegExp(credential, "u"));
  assert.equal(JSON.stringify(artwork.json || {}).includes(credential), false);

  const seerrCredential = "dedicated-seerr-artwork-key";
  const savedSeerr = await request(port, "/api/v2/services/seerr", {
    method: "PUT",
    body: {
      url: "http://seerr.test:5055",
      authMode: "apiKey",
      credential: seerrCredential,
      monitoringEnabled: true
    },
    ...authentication
  });
  assert.equal(savedSeerr.status, 200, JSON.stringify(savedSeerr.json));
  broker.controlPlane.setMonitor({
    getSnapshot: () => ({
      version: 2,
      media: {
        artwork: {
          [SONARR_FALLBACK_TOKEN]: {
            version: 4,
            sources: [{
              service: "seerr",
              kind: "tv-poster",
              resource: "912",
              variant: "w342",
              targetRevision: savedSeerr.json.targetRevision
            }]
          }
        }
      }
    }),
    refresh: async () => ({ version: 2 }),
    requestRefresh() {}
  });
  const seerrArtwork = await request(port, SONARR_FALLBACK_PATH, { cookie: authentication.cookie });
  assert.equal(seerrArtwork.status, 200, JSON.stringify(seerrArtwork.json));
  assert.deepEqual(seerrArtwork.bytes, Buffer.from("seerr-fallback-artwork"));
  const seerrCalls = upstreamCalls.filter(({ route }) => route.service === "seerr");
  assert.deepEqual(seerrCalls.map(({ route }) => route.upstreamPath), [
    "/api/v1/tv/912",
    "/imageproxy/tmdb/t/p/w342/vision_quest.jpg"
  ]);
  assert.equal(seerrCalls[0].limits.maxApiResponseBytes, 512 * 1024);
  assert.equal(seerrCalls[0].request.headers["x-api-key"], seerrCredential, "the fixed detail lookup uses the configured Seerr credential");
  assert.equal(seerrCalls[1].request.headers["x-api-key"], undefined, "Seerr's public image proxy never receives the credential");

  const queuedTokens = ["1000000000000001", "1000000000000002", "1000000000000003", "1000000000000004"];
  broker.controlPlane.setMonitor({
    getSnapshot: () => ({
      version: 2,
      media: {
        artwork: Object.fromEntries(queuedTokens.map((token, index) => [token, {
          version: 4,
          sources: [{
            service: "jellyfin",
            kind: "primary",
            resource: `queued-${index + 1}`,
            revision: INTERNAL_REVISION,
            variant: "w342q85",
            targetRevision: saved.json.targetRevision
          }]
        }]))
      }
    }),
    refresh: async () => ({ version: 2 }),
    requestRefresh() {}
  });
  blockQueuedArtwork = true;
  const firstThree = queuedTokens.slice(0, 3).map((token) => request(
    port,
    `/api/v2/media/artwork/${token}`,
    { cookie: authentication.cookie }
  ));
  await threeQueuedStarts;
  const fourth = request(port, `/api/v2/media/artwork/${queuedTokens[3]}`, { cookie: authentication.cookie });
  await new Promise((resolve) => setImmediate(resolve));

  const replaced = await request(port, "/api/v2/services/jellyfin", {
    method: "PUT",
    body: {
      url: "http://replacement.test:8096",
      authMode: "token",
      credential,
      monitoringEnabled: false
    },
    ...authentication
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
  assert.notEqual(replaced.json.targetRevision, saved.json.targetRevision);
  releaseBlockedArtwork();
  const rotatedResults = await Promise.all([...firstThree, fourth]);
  assert.ok(rotatedResults.every(({ status }) => status === 404));
  const rotatedDispatches = upstreamCalls.filter(({ route }) => (
    route.isArtwork && route.upstreamPath.includes("queued-")
  ));
  assert.equal(rotatedDispatches.length, 3);
  assert.equal(
    rotatedDispatches.some(({ route }) => route.upstreamPath.includes("queued-4")),
    false,
    "queued stale resource identifiers must not be sent to a replacement target"
  );
});
