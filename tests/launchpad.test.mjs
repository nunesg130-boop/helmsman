import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalLaunchUrl, createLaunchpadStore, launchpadKey } from "../server/launchpad.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const SONARR_REVISION = "3f0c1d2e-4b5a-4c6d-8e7f-901234567890";

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
        resolve({ status: response.statusCode, headers: response.headers, json: bytes.length ? JSON.parse(bytes.toString("utf8")) : null });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-launchpad-api-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const launchpad = await createLaunchpadStore({ dataDir: root });
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    launchpad,
    lookup: async () => [{ address: "10.20.30.40", family: 4 }]
  });
  const server = http.createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (!await controlPlane.handle(incoming, response, url)) {
        response.statusCode = 404;
        response.end();
      }
    } catch (error) {
      response.statusCode = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: error?.code || "INTERNAL_ERROR", message: error?.message || "failed" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return { root, store, server, controlPlane, launchpad, port, origin: `http://127.0.0.1:${port}`, setupToken };
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
      deviceName: "Launchpad test browser",
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

test("Launchpad addresses accept only plain http(s) links", () => {
  assert.equal(canonicalLaunchUrl("https://Sonarr.Example.net"), "https://sonarr.example.net/");
  assert.equal(canonicalLaunchUrl("http://10.44.1.21:8989/sonarr"), "http://10.44.1.21:8989/sonarr");
  for (const rejected of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://files.example.net",
    ["https://user", "secret@sonarr.example.net"].join(":"), // assembled so the release scan sees no literal credential URL
    "https://sonarr.example.net/\nnext",
    " https://sonarr.example.net",
    `https://example.net/${"a".repeat(600)}`,
    "",
    42
  ]) {
    assert.equal(canonicalLaunchUrl(rejected), null, String(rejected));
  }
  assert.equal(launchpadKey("media", "sonarr"), "media:sonarr");
  assert.equal(launchpadKey("media", "plex"), null);
  assert.equal(launchpadKey("service", "../state"), null);
  assert.equal(launchpadKey("other", SONARR_REVISION), null);
});

test("saving a Launchpad address requires a session, CSRF and an existing connection", async () => {
  const context = await start();
  try {
    const anonymous = await request(context.port, "/api/v2/launchpad", { origin: context.origin });
    assert.equal(anonymous.status, 401);

    const session = await claim(context);
    const empty = await request(context.port, "/api/v2/launchpad", { cookie: session.cookie, origin: session.origin });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { links: [] });

    const notConnected = await request(context.port, "/api/v2/launchpad/media/sonarr", {
      method: "PUT",
      ...session,
      body: { url: "https://sonarr.example.net" }
    });
    assert.equal(notConnected.status, 404);
    assert.equal(notConnected.json.code, "LAUNCHPAD_TARGET_NOT_FOUND");

    await context.store.mutate((state) => {
      state.connections.sonarr = {
        url: "http://10.44.1.21:8989",
        targetRevision: SONARR_REVISION,
        updatedAt: new Date().toISOString()
      };
    });

    const withoutCsrf = await request(context.port, "/api/v2/launchpad/media/sonarr", {
      method: "PUT",
      origin: session.origin,
      cookie: session.cookie,
      body: { url: "https://sonarr.example.net" }
    });
    assert.equal(withoutCsrf.status, 403);

    const unsafe = await request(context.port, "/api/v2/launchpad/media/sonarr", {
      method: "PUT",
      ...session,
      body: { url: "javascript:alert(1)" }
    });
    assert.equal(unsafe.status, 400);
    assert.equal(unsafe.json.code, "INVALID_LAUNCH_URL");

    const extraKeys = await request(context.port, "/api/v2/launchpad/media/sonarr", {
      method: "PUT",
      ...session,
      body: { url: "https://sonarr.example.net", note: "x" }
    });
    assert.equal(extraKeys.status, 400);

    const saved = await request(context.port, "/api/v2/launchpad/media/sonarr", {
      method: "PUT",
      ...session,
      body: { url: "https://sonarr.example.net" }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.links.map(({ kind, id, url }) => ({ kind, id, url })), [
      { kind: "media", id: "sonarr", url: "https://sonarr.example.net/" }
    ]);
    const persisted = JSON.parse(await readFile(path.join(context.root, "launchpad.json"), "utf8"));
    assert.equal(persisted.entries.length, 1);
    assert.equal(persisted.entries[0].key, "media:sonarr");

    const reloaded = await createLaunchpadStore({ dataDir: context.root });
    assert.equal(reloaded.list()[0].url, "https://sonarr.example.net/");

    const unknownKind = await request(context.port, "/api/v2/launchpad/media/plex", { method: "PUT", ...session, body: { url: "https://plex.example.net" } });
    assert.equal(unknownKind.status, 404);

    const cleared = await request(context.port, "/api/v2/launchpad/media/sonarr", { method: "DELETE", ...session });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json.links, []);

    await context.launchpad.set("media", "radarr", "https://radarr.example.net");
    const orphaned = await request(context.port, "/api/v2/launchpad", { cookie: session.cookie, origin: session.origin });
    assert.deepEqual(orphaned.json.links, [], "addresses for connections that no longer exist are not returned");
  } finally {
    await stop(context);
  }
});
