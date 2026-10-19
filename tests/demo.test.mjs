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
