import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startDemo } from "../scripts/demo.mjs";

// Keeps `npm run demo` working: if an API or probe shape changes, the demo's
// fake services must change with it or this test fails.

function request(demo, pathname, method = "GET", payload = undefined, auth = null) {
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port: demo.port,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${demo.port}`,
        Origin: demo.origin,
        ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
        ...(auth?.csrf ? { "X-Helmsman-CSRF": auth.csrf } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(bytes.toString("utf8")); } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, json, bytes });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

test("the demo configures itself and every fake service reports healthy", { timeout: 60_000 }, async () => {
  const demo = await startDemo({ port: 0 });
  try {
    const rejected = await request(demo, "/api/v2/auth/jellyfin/login", "POST", {
      username: demo.username,
      password: "wrong",
      deviceName: "Demo test",
      origin: demo.origin
    });
    assert.equal(rejected.status, 401);

    const login = await request(demo, "/api/v2/auth/jellyfin/login", "POST", {
      username: demo.username,
      password: demo.password,
      deviceName: "Demo test",
      origin: demo.origin
    });
    assert.equal(login.status, 201, JSON.stringify(login.json));
    const auth = { cookie: String(login.headers["set-cookie"][0]).split(";", 1)[0], csrf: login.json.csrfToken };

    const snapshot = await request(demo, "/api/v2/operations/snapshot", "GET", undefined, auth);
    assert.equal(snapshot.status, 200);
    const services = snapshot.json.services;
    assert.deepEqual(
      services.map(({ id }) => id).sort(),
      ["bazarr", "jellyfin", "prowlarr", "qbittorrent", "radarr", "seerr", "sonarr"]
    );
    for (const service of services) {
      assert.equal(service.state, "healthy", `${service.id}: ${JSON.stringify(service.checks?.filter(({ ok }) => !ok))}`);
    }

    const media = snapshot.json.media;
    const stages = new Set(media.records.map(({ lifecycle }) => lifecycle?.stage));
    for (const stage of ["requested", "monitored", "downloading", "available"]) {
      assert.equal(stages.has(stage), true, `the demo shows a ${stage} title`);
    }
    assert.ok(media.requests.length > 0);
    assert.ok(media.activity.length > 0);
    assert.ok(media.calendar.length > 0);
    assert.ok(media.home.continueWatching.length > 0);

    const artwork = media.records.find(({ artworkUrl }) => artworkUrl);
    const image = await request(demo, artwork.artworkUrl, "GET", undefined, auth);
    assert.equal(image.status, 200);
    assert.match(String(image.headers["content-type"]), /^image\/png/u);

    assert.equal(snapshot.json.infrastructure.state, "healthy");
    assert.equal(snapshot.json.infrastructure.targetCount, 1);

    const manual = await request(demo, "/api/v2/manual", "GET", undefined, auth);
    assert.match(manual.json.manual.markdown, /^# Homelab manual/u);
    const map = await request(demo, "/api/v2/network-map", "GET", undefined, auth);
    assert.ok(map.json.networkMap.map.items.length > 5);
  } finally {
    await demo.stop();
  }
});

test("the demo agent explains an outage, proposes a fix, and notifies once", { timeout: 60_000 }, async () => {
  const demo = await startDemo({ port: 0, autonomy: false });
  try {
    const anonymous = await request(demo, "/api/v2/agent");
    assert.equal(anonymous.status, 401);
    const login = await request(demo, "/api/v2/auth/jellyfin/login", "POST", {
      username: demo.username,
      password: demo.password,
      deviceName: "Agent test",
      origin: demo.origin
    });
    const auth = { cookie: String(login.headers["set-cookie"][0]).split(";", 1)[0], csrf: login.json.csrfToken };
    const noCsrf = await request(demo, "/api/v2/agent/settings", "PUT", { autonomy: true }, { cookie: auth.cookie });
    assert.equal(noCsrf.status, 403);

    const before = demo.notifications.length;
    demo.breakService("sonarr");
    for (let index = 0; index < 3; index += 1) await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    await demo.broker.agent.idle();
    let agent = (await request(demo, "/api/v2/agent", "GET", undefined, auth)).json;
    const incident = agent.notes.find((note) => note.kind === "incident");
    assert.equal(incident.title, "Sonarr: down");
    assert.equal(incident.model, "demo-model");
    assert.deepEqual(incident.toolsUsed, ["list_workloads", "propose_action"]);
    assert.equal(agent.proposals.length, 1);
    assert.equal(agent.proposals[0].target, "container sonarr");
    assert.deepEqual(demo.notifications.slice(before).map(({ title }) => title), ["Sonarr: down"]);

    const approved = await request(demo, `/api/v2/agent/proposals/${agent.proposals[0].id}`, "POST", { decision: "approve" }, auth);
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    for (let index = 0; index < 2; index += 1) await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    await demo.broker.agent.idle();
    agent = (await request(demo, "/api/v2/agent", "GET", undefined, auth)).json;
    assert.equal(agent.notes[0].title, "Sonarr recovered");
    assert.deepEqual(demo.notifications.slice(before).map(({ title }) => title), ["Sonarr: down", "Sonarr recovered"]);

    const asked = await request(demo, "/api/v2/agent/ask", "POST", { question: "How is everything?" }, auth);
    assert.equal(asked.status, 200);
    assert.match(asked.json.answer, /Media: healthy/u);
  } finally {
    await demo.stop();
  }
});

test("Prowlarr indexers can be listed and tested without exposing their settings", { timeout: 60_000 }, async () => {
  const demo = await startDemo({ port: 0 });
  try {
    const login = await request(demo, "/api/v2/auth/jellyfin/login", "POST", { username: demo.username, password: demo.password, deviceName: "Prowlarr test", origin: demo.origin });
    const auth = { cookie: String(login.headers["set-cookie"][0]).split(";", 1)[0], csrf: login.json.csrfToken };
    assert.equal((await request(demo, "/api/v2/prowlarr/indexers")).status, 401);

    let listed = await request(demo, "/api/v2/prowlarr/indexers", "GET", undefined, auth);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.deepEqual(listed.json.indexers.map(({ name, failing }) => [name, failing]), [
      ["Example Private Tracker", false],
      ["Example Public Tracker", false],
      ["Example Usenet", false]
    ]);
    assert.deepEqual(listed.json.applications.map(({ name }) => name), ["Radarr", "Sonarr"]);
    assert.equal(listed.bytes.toString("utf8").includes(demo.demoIndexerSecret), false, "no indexer or app secret reaches the browser");

    demo.failIndexer("Example Public Tracker");
    await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    listed = await request(demo, "/api/v2/prowlarr/indexers", "GET", undefined, auth);
    const failing = listed.json.indexers[0];
    assert.equal(failing.name, "Example Public Tracker");
    assert.equal(failing.failing, true);
    const targetRevision = listed.json.targetRevision;

    const act = (body, session = auth) => request(demo, "/api/v2/actions/prowlarr", "POST", body, session);
    const failed = await act({ operation: "testIndexer", indexerId: failing.id, targetRevision });
    assert.equal(failed.status, 200, JSON.stringify(failed.json));
    assert.deepEqual(failed.json, { ok: true, operation: "testIndexer", indexerId: failing.id, passed: false, message: "Unable to connect to indexer: the site answered with a Cloudflare challenge" });
    const passed = await act({ operation: "testIndexer", indexerId: listed.json.indexers[1].id, targetRevision });
    assert.equal(passed.json.passed, true);

    const all = await act({ operation: "testAllIndexers", targetRevision });
    assert.deepEqual(all.json.results.map(({ ok }) => ok), [false, true, true]);
    assert.equal((await act({ operation: "syncApps", targetRevision })).json.ok, true);
    assert.deepEqual((await act({ operation: "testApps", targetRevision })).json.results.map(({ ok }) => ok), [true, true]);

    assert.equal((await act({ operation: "testIndexer", indexerId: failing.id, targetRevision }, { cookie: auth.cookie })).status, 403, "CSRF is required");
    assert.equal((await act({ operation: "testIndexer", indexerId: failing.id, targetRevision: "00000000-0000-4000-8000-000000000000" })).json.code, "TARGET_CHANGED");
    assert.equal((await act({ operation: "deleteIndexer", indexerId: failing.id, targetRevision })).status, 400);
    assert.equal((await act({ operation: "testAllIndexers", indexerId: failing.id, targetRevision })).status, 400);
    assert.equal((await act({ operation: "testIndexer", indexerId: 999, targetRevision })).json.code, "ACTION_TARGET_CHANGED");

    // The agent's entry point only tests.
    await assert.rejects(demo.broker.controlPlane.performAction("prowlarr", { operation: "syncApps", targetRevision }), { code: "INVALID_ACTION_TARGET" });
  } finally {
    await demo.stop();
  }
});

test("app files are cached by revalidation and compressed; API responses are not", { timeout: 60_000 }, async () => {
  const { gunzipSync } = await import("node:zlib");
  const { readFile } = await import("node:fs/promises");
  const demo = await startDemo({ port: 0 });
  const get = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: "127.0.0.1", port: demo.port, path: pathname, method: "GET", headers: { Host: `127.0.0.1:${demo.port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  try {
    const original = await readFile(new URL("../src/app-v5.js", import.meta.url));
    const compressed = await get("/src/app-v5.js", { "Accept-Encoding": "gzip, deflate, br" });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers["content-encoding"], "gzip");
    assert.equal(compressed.headers["cache-control"], "private, no-cache");
    assert.equal(compressed.headers.vary, "Accept-Encoding");
    assert.ok(compressed.bytes.length < original.length / 2, "compressed to well under half");
    assert.deepEqual(gunzipSync(compressed.bytes), original);
    assert.ok(compressed.headers["content-security-policy"], "security headers stay");

    const unchanged = await get("/src/app-v5.js", { "Accept-Encoding": "gzip", "If-None-Match": compressed.headers.etag });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.bytes.length, 0);

    const plain = await get("/src/app-v5.js");
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.notEqual(plain.headers.etag, compressed.headers.etag, "each encoding has its own ETag");
    assert.deepEqual(plain.bytes, original);
    assert.equal((await get("/src/app-v5.js", { "Accept-Encoding": "gzip;q=0" })).headers["content-encoding"], undefined, "gzip refused by q=0");

    const image = await get("/assets/helmsman-logo.png", { "Accept-Encoding": "gzip" });
    assert.equal(image.headers["content-encoding"], undefined, "images are not recompressed");
    assert.equal((await get("/assets/services/sonarr.svg", { "Accept-Encoding": "gzip" })).headers["cache-control"], "private, max-age=86400");

    const api = await get("/api/v2/status", { "Accept-Encoding": "gzip" });
    assert.match(api.headers["cache-control"], /no-store/u);
    assert.equal(api.headers["content-encoding"], undefined, "API responses, which can carry tokens, are never compressed");
  } finally {
    await demo.stop();
  }
});

async function demoLogin(demo) {
  const login = await request(demo, "/api/v2/auth/jellyfin/login", "POST", { username: demo.username, password: demo.password, deviceName: "Demo test", origin: demo.origin });
  assert.equal(login.status, 201);
  return { cookie: String(login.headers["set-cookie"][0]).split(";", 1)[0], csrf: login.json.csrfToken };
}

test("Radarr and Sonarr indexers can be listed and tested without exposing their keys", { timeout: 60_000 }, async () => {
  const demo = await startDemo({ port: 0 });
  try {
    const auth = await demoLogin(demo);
    demo.failIndexer("Example Public Tracker");
    await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    for (const service of ["radarr", "sonarr"]) {
      const listed = await request(demo, `/api/v2/${service}/indexers`, "GET", undefined, auth);
      assert.equal(listed.status, 200, JSON.stringify(listed.json));
      assert.equal(listed.bytes.toString("utf8").includes(demo.demoIndexerSecret), false, "no indexer key reaches the browser");
      assert.deepEqual(listed.json.indexers.map(({ name, failing }) => [name, failing]), [
        ["Example Public Tracker (Prowlarr)", true],
        ["Example Private Tracker (Prowlarr)", false],
        ["Example Usenet (Prowlarr)", false]
      ]);
      const targetRevision = listed.json.targetRevision;
      const single = await request(demo, "/api/v2/actions/arr-indexers", "POST", { service, operation: "testIndexer", indexerId: 1, targetRevision }, auth);
      assert.equal(single.status, 200, JSON.stringify(single.json));
      assert.equal(single.json.passed, false);
      assert.match(single.json.message, /Unable to connect to indexer/u);
      const all = await request(demo, "/api/v2/actions/arr-indexers", "POST", { service, operation: "testAllIndexers", targetRevision }, auth);
      assert.deepEqual(all.json.results.map(({ id, ok }) => [id, ok]), [[1, false], [2, true], [3, true]]);
      const forged = await request(demo, "/api/v2/actions/arr-indexers", "POST", { service, operation: "testAllIndexers", targetRevision }, { cookie: auth.cookie });
      assert.equal(forged.status, 403, "CSRF is required");
    }
    const wrong = await request(demo, "/api/v2/actions/arr-indexers", "POST", { service: "prowlarr", operation: "testAllIndexers", targetRevision: "00000000-0000-4000-8000-000000000000" }, auth);
    assert.equal(wrong.status, 400);
    assert.equal((await request(demo, "/api/v2/bazarr/indexers", "GET", undefined, auth)).status, 404);
  } finally {
    await demo.stop();
  }
});

test("debug logging records checks and requests, can be downloaded, and turns off", { timeout: 60_000 }, async () => {
  const demo = await startDemo({ port: 0 });
  try {
    const auth = await demoLogin(demo);
    assert.equal((await request(demo, "/api/v2/logs/settings", "GET", undefined, auth)).json.level, "normal");
    assert.equal((await request(demo, "/api/v2/logs/settings", "PUT", { debug: true }, { cookie: auth.cookie })).status, 403);
    assert.equal((await request(demo, "/api/v2/logs/settings", "PUT", { debug: true, hours: 0 }, auth)).status, 400);
    const on = await request(demo, "/api/v2/logs/settings", "PUT", { debug: true, hours: 2 }, auth);
    assert.equal(on.json.level, "debug");
    await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    const requests = await request(demo, "/api/v2/logs?category=request&limit=200", "GET", undefined, auth);
    assert.ok(requests.json.entries.length > 10, "service requests are logged");
    assert.ok(requests.json.entries.every(({ level, route }) => level === "debug" && route.startsWith("/")));
    const checks = await request(demo, "/api/v2/logs?category=health&level=debug", "GET", undefined, auth);
    assert.ok(checks.json.entries.some(({ event }) => event === "check.completed"));
    const exported = await request(demo, "/api/v2/logs/export?level=debug", "GET", undefined, auth);
    assert.equal(exported.status, 200);
    assert.match(exported.headers["content-disposition"], /^attachment; filename="helmsman-logs-\d{8}-\d{4}\.jsonl"$/u);
    const lines = exported.bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(lines.length > 10 && lines.every(({ level }) => level === "debug"));
    assert.equal((await request(demo, "/api/v2/logs/export?limit=5", "GET", undefined, auth)).status, 400);
    assert.equal((await request(demo, "/api/v2/logs/export")).status, 401, "sign-in required");
    const output = await request(demo, "/api/v2/logs/output", "GET", undefined, auth);
    assert.equal(output.status, 200);
    assert.ok(Array.isArray(output.json.lines));
    const off = await request(demo, "/api/v2/logs/settings", "PUT", { debug: false }, auth);
    assert.equal(off.json.level, "normal");
    const countBefore = (await request(demo, "/api/v2/logs?category=request&limit=200", "GET", undefined, auth)).json.entries.length;
    await request(demo, "/api/v2/operations/refresh", "POST", {}, auth);
    assert.equal((await request(demo, "/api/v2/logs?category=request&limit=200", "GET", undefined, auth)).json.entries.length, countBefore, "nothing more at the normal level");
  } finally {
    await demo.stop();
  }
});
