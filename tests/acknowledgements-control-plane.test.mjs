import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAcknowledgementStore, reportFingerprint } from "../server/acknowledgements.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const rootFolder = {
  severity: "warning",
  source: "DownloadClientRootFolderCheck",
  message: "Download client qBittorrent places downloads in the root folder /data/media."
};
const REPORT_ID = reportFingerprint("radarr", "health", rootFolder);

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

function radarrSnapshot(acknowledged) {
  const report = { ...rootFolder, id: REPORT_ID };
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    overall: { state: acknowledged ? "healthy" : "limited" },
    services: [{
      id: "radarr",
      label: "Radarr",
      state: acknowledged ? "healthy" : "limited",
      checks: [{
        id: "health",
        state: acknowledged ? "healthy" : "limited",
        ...(acknowledged ? { acknowledgedReports: [report] } : { reports: [report] })
      }]
    }],
    infrastructure: { environments: [], services: [] }
  };
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-ack-api-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const acknowledgements = await createAcknowledgementStore({ dataDir: root });
  let refreshes = 0;
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    acknowledgements,
    lookup: async () => [{ address: "10.20.30.40", family: 4 }]
  });
  controlPlane.setMonitor({
    getSnapshot: () => radarrSnapshot(acknowledgements.has(REPORT_ID)),
    refresh: async () => radarrSnapshot(acknowledgements.has(REPORT_ID)),
    refreshAfterChange: async () => {
      refreshes += 1;
      return radarrSnapshot(acknowledgements.has(REPORT_ID));
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
  return {
    root,
    server,
    controlPlane,
    acknowledgements,
    port,
    origin: `http://127.0.0.1:${port}`,
    setupToken,
    refreshCount: () => refreshes
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
      deviceName: "Acknowledgement test browser",
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

test("ignoring and restoring a warning requires a session and CSRF, and only accepts live reports", async () => {
  const context = await start();
  try {
    const anonymous = await request(context.port, "/api/v2/acknowledgements", {
      method: "POST",
      origin: context.origin,
      body: { reportId: REPORT_ID }
    });
    assert.equal(anonymous.status, 401);

    const session = await claim(context);
    const withoutCsrf = await request(context.port, "/api/v2/acknowledgements", {
      method: "POST",
      origin: session.origin,
      cookie: session.cookie,
      body: { reportId: REPORT_ID }
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal(context.acknowledgements.has(REPORT_ID), false);

    const unknown = await request(context.port, "/api/v2/acknowledgements", {
      method: "POST",
      ...session,
      body: { reportId: "f".repeat(32) }
    });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.code, "REPORT_NOT_CURRENT");

    const malformed = await request(context.port, "/api/v2/acknowledgements", {
      method: "POST",
      ...session,
      body: { reportId: REPORT_ID, message: "attacker supplied text" }
    });
    assert.equal(malformed.status, 400);

    const ignored = await request(context.port, "/api/v2/acknowledgements", {
      method: "POST",
      ...session,
      body: { reportId: REPORT_ID }
    });
    assert.equal(ignored.status, 200, JSON.stringify(ignored.json));
    assert.equal(ignored.json.services[0].state, "healthy");
    assert.deepEqual(ignored.json.acknowledgements.map(({ id, label, message }) => ({ id, label, message })), [
      { id: REPORT_ID, label: "Radarr", message: rootFolder.message }
    ]);
    assert.equal(context.refreshCount(), 1);

    const snapshot = await request(context.port, "/api/v2/operations/snapshot", { cookie: session.cookie, origin: session.origin });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.acknowledgements.length, 1);

    const restoreWithoutCsrf = await request(context.port, `/api/v2/acknowledgements/${REPORT_ID}`, {
      method: "DELETE",
      origin: session.origin,
      cookie: session.cookie
    });
    assert.equal(restoreWithoutCsrf.status, 403);

    const restored = await request(context.port, `/api/v2/acknowledgements/${REPORT_ID}`, { method: "DELETE", ...session });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.services[0].state, "limited");
    assert.deepEqual(restored.json.acknowledgements, []);

    const missing = await request(context.port, `/api/v2/acknowledgements/${REPORT_ID}`, { method: "DELETE", ...session });
    assert.equal(missing.status, 404);
    const traversal = await request(context.port, "/api/v2/acknowledgements/..%2F..%2Fstate", { method: "DELETE", ...session });
    assert.equal(traversal.status, 404);
  } finally {
    await stop(context);
  }
});
