import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBroker } from "../server/broker.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { createEventJournal } from "../server/event-journal.mjs";
import { StateStore } from "../server/state.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function filesContain(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await filesContain(candidate, needle)) return true;
      continue;
    }
    if (entry.isFile() && (await readFile(candidate)).includes(Buffer.from(needle))) return true;
  }
  return false;
}

test("persistent Helmsman logs are authenticated, bounded, read-only, and exclude setup secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-logging-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const journal = await createEventJournal({ dataDir: root });
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    eventJournal: journal,
    lookup: async () => [{ address: "10.0.0.10", family: 4 }]
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
      }));
      response.statusCode = error instanceof ControlPlaneError ? error.status : 500;
      response.setHeader("Content-Type", "application/json");
      response.end(payload);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const anonymous = await request(port, "/api/v2/logs");
    assert.equal(anonymous.status, 401);

    const claim = await request(port, "/api/v2/setup/claim", {
      method: "POST",
      origin,
      body: {
        setupToken,
        deviceName: "Logging test browser",
        origin,
        allowedCidrs: [],
        allowPublicHttps: false
      }
    });
    assert.equal(claim.status, 201, JSON.stringify(claim.json));
    const authentication = {
      origin,
      cookie: claim.headers["set-cookie"][0].split(";", 1)[0],
      csrf: claim.json.csrfToken
    };

    await journal.record({
      level: "warn",
      category: "health",
      event: "health_incident",
      outcome: "changed",
      service: "radarr",
      capability: "health",
      code: "HEALTH_WARNING"
    });
    const logs = await request(port, "/api/v2/logs?limit=1&level=warn", authentication);
    assert.equal(logs.status, 200, JSON.stringify(logs.json));
    assert.match(logs.headers["cache-control"], /no-store/u);
    assert.equal(logs.json.entries.length, 1);
    assert.equal(logs.json.entries[0].service, "radarr");
    assert.equal(logs.json.storage.persistent, true);

    const unknown = await request(port, "/api/v2/logs?path=%2Fetc%2Fpasswd", authentication);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, "INVALID_LOG_QUERY");
    const repeated = await request(port, "/api/v2/logs?limit=1&limit=2", authentication);
    assert.equal(repeated.status, 400);
    const ingestion = await request(port, "/api/v2/logs", {
      method: "POST",
      ...authentication,
      body: { message: "browser supplied" }
    });
    assert.equal(ingestion.status, 405);

    await journal.close();
    assert.equal(await filesContain(path.join(root, "logs"), setupToken), false);
    assert.equal(await filesContain(path.join(root, "logs"), "browser supplied"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await controlPlane.close();
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker drain writes the terminal lifecycle event after producers stop and before journal close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-logging-drain-"));
  let broker;
  try {
    broker = await createBroker({
      dataDir: root,
      rootDir: PROJECT_ROOT,
      log: () => {}
    });
    await broker.recordEvent({
      level: "info",
      category: "application",
      event: "application.started",
      outcome: "started",
      service: "helmsman"
    });
    broker.beginShutdown();
    await broker.drain({
      finalEvent: {
        level: "info",
        category: "application",
        event: "application.stopped",
        outcome: "succeeded",
        service: "helmsman"
      }
    });
    const logs = await broker.eventJournal.query({ limit: 10 });
    assert.deepEqual(logs.entries.slice(0, 2).map(({ event, outcome }) => ({ event, outcome })), [
      { event: "application.stopped", outcome: "succeeded" },
      { event: "application.started", outcome: "started" }
    ]);
    assert.equal(logs.storage.closed, true);
    assert.equal(logs.storage.writable, false);
  } finally {
    broker?.beginShutdown();
    await broker?.drain().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
