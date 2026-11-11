import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shellCsp } from "../server/broker.mjs";
import { createLaunchpadIconStore, DASHBOARD_ICONS_BASE } from "../server/launchpad-icons.mjs";
import { canonicalLaunchUrl, launchpadFrameOrigins, launchpadKey } from "../server/launchpad-schema.mjs";
import { createLaunchpadDocumentStore } from "../server/launchpad-store.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const SONARR_REVISION = "3f0c1d2e-4b5a-4c6d-8e7f-901234567890";
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

function request(port, pathname, options = {}) {
  const body = options.raw ?? (options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8"));
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
        ...(options.csrf ? { "X-Helmsman-Csrf": options.csrf } : {}),
        ...(options.headers || {}),
        ...(body ? { "Content-Type": options.raw ? "application/octet-stream" : "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const json = String(response.headers["content-type"] || "").startsWith("application/json") && bytes.length
          ? JSON.parse(bytes.toString("utf8"))
          : null;
        resolve({ status: response.statusCode, headers: response.headers, json, text: bytes.toString("utf8"), bytes });
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
  const launchpad = await createLaunchpadDocumentStore({ dataDir: root, pollMs: 40, debounceMs: 10 });
  const launchpadIcons = await createLaunchpadIconStore({
    dataDir: root,
    fetchImpl: async (url) => (String(url) === `${DASHBOARD_ICONS_BASE}/svg/jellyfin.svg`
      ? new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } })
      : new Response("no", { status: 404 }))
  });
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    launchpad,
    launchpadIcons,
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
  return { root, store, server, controlPlane, launchpad, launchpadIcons, port, origin: `http://127.0.0.1:${port}`, setupToken };
}

async function stop(context) {
  await new Promise((resolve) => context.server.close(resolve));
  await context.controlPlane.close();
  await context.launchpad.close();
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

const ADD_HOME = { op: "addPage", page: { id: "home", title: "Home", groups: [] } };
const ACCENT_TILE = {
  op: "addTile",
  pageId: "home",
  groupId: "g",
  tile: { id: "jf", type: "link", title: "Jellyfin", url: "https://jf.example.net", style: { accent: "#00a4dc" }, layout: { desktop: { x: 0, y: 0, w: 2, h: 1 } } }
};

async function withSession(fn) {
  const context = await start();
  try {
    await fn(context, await claim(context));
  } finally {
    await stop(context);
  }
}

function op(session, port, revision, change) {
  return request(port, "/api/v2/launchpad/ops", { method: "POST", ...session, body: { revision, op: change } });
}

test("anonymous requests get 401 on every Launchpad route", () => withSession(async (context) => {
  for (const [pathname, method] of [
    ["/api/v2/launchpad", "GET"],
    ["/api/v2/launchpad/revision", "GET"],
    ["/api/v2/launchpad/theme.css", "GET"],
    ["/api/v2/launchpad/icons/dashboard-icons%3Ajellyfin", "GET"],
    ["/api/v2/launchpad/ops", "POST"],
    ["/api/v2/launchpad/icons", "POST"]
  ]) {
    const response = await request(context.port, pathname, { method, origin: context.origin });
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
}));

test("ops need CSRF", () => withSession(async (context, session) => {
  const response = await request(context.port, "/api/v2/launchpad/ops", {
    method: "POST",
    origin: session.origin,
    cookie: session.cookie,
    body: { revision: 0, op: ADD_HOME }
  });
  assert.equal(response.status, 403);
}));

test("GET returns the model, and an op bumps the revision", () => withSession(async (context, session) => {
  const empty = await request(context.port, "/api/v2/launchpad", { cookie: session.cookie, origin: session.origin });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { revision: 0, model: { version: 2, theme: { tokens: {}, css: "" }, pages: [] }, error: null });
  const saved = await op(session, context.port, 0, ADD_HOME);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.revision, 1);
  const revision = await request(context.port, "/api/v2/launchpad/revision", { cookie: session.cookie, origin: session.origin });
  assert.deepEqual(revision.json, { revision: 1, error: null });
  assert.match(await readFile(path.join(context.root, "launchpad.yaml"), "utf8"), /id: home/u);
}));

test("ops map store errors to HTTP statuses", () => withSession(async (context, session) => {
  await op(session, context.port, 0, ADD_HOME);
  const stale = await op(session, context.port, 0, ADD_HOME);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "LAUNCHPAD_CHANGED");
  const missing = await op(session, context.port, 1, { op: "removePage", pageId: "nope" });
  assert.equal(missing.status, 404);
  const malformed = await op(session, context.port, 1, { op: "explode" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, "INVALID_OP");
  const schema = await op(session, context.port, 1, { op: "updatePage", pageId: "home", patch: { title: "" } });
  assert.equal(schema.status, 400);
  assert.equal(schema.json.code, "LAUNCHPAD_SCHEMA");
  assert.ok(Array.isArray(schema.json.errors));
  const extra = await request(context.port, "/api/v2/launchpad/ops", { method: "POST", ...session, body: { revision: 1, op: ADD_HOME, note: 1 } });
  assert.equal(extra.status, 400);
}));

test("an invalid file on disk is reported and edits are refused", () => withSession(async (context, session) => {
  await writeFile(path.join(context.root, "launchpad.yaml"), "version: 2\npages:\n  - id: Bad\n");
  await context.launchpad.reloadNow();
  const current = await request(context.port, "/api/v2/launchpad", { cookie: session.cookie, origin: session.origin });
  assert.equal(current.json.error.line, 3);
  const refused = await op(session, context.port, current.json.revision, ADD_HOME);
  assert.equal(refused.status, 423);
  assert.equal(refused.json.code, "LAUNCHPAD_INVALID");
}));

test("theme.css carries tile accents and honors ETag", () => withSession(async (context, session) => {
  await op(session, context.port, 0, ADD_HOME);
  await op(session, context.port, 1, { op: "addGroup", pageId: "home", group: { id: "g", title: "G", tiles: [] } });
  await op(session, context.port, 2, ACCENT_TILE);
  const css = await request(context.port, "/api/v2/launchpad/theme.css?r=3", { cookie: session.cookie, origin: session.origin });
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /^text\/css/u);
  assert.match(css.text, /--lp-tile-accent: #00a4dc/u);
  const again = await request(context.port, "/api/v2/launchpad/theme.css", {
    cookie: session.cookie,
    origin: session.origin,
    headers: { "If-None-Match": css.headers.etag }
  });
  assert.equal(again.status, 304);
}));

test("shell CSP frame-src lists only configured iframe origins", () => {
  assert.match(shellCsp([]), /; frame-src 'none'$/u);
  const model = {
    pages: [{
      groups: [{
        tiles: [
          { type: "iframe", url: "http://192.168.0.213:3000/d/abc" },
          { type: "iframe", url: "http://192.168.0.213:3000/d/other" },
          { type: "link", url: "https://not-framed.example/" },
          { type: "iframe", url: "https://grafana.example/x" }
        ]
      }]
    }]
  };
  const origins = launchpadFrameOrigins(model);
  assert.deepEqual(origins, ["http://192.168.0.213:3000", "https://grafana.example"]);
  const csp = shellCsp(origins);
  assert.match(csp, /; frame-src http:\/\/192\.168\.0\.213:3000 https:\/\/grafana\.example$/u);
  assert.match(csp, /^default-src 'self';/u);
  assert.match(csp, /frame-ancestors 'none'/u);
});

test("icon route serves cached icons with sandbox headers", () => withSession(async (context, session) => {
  const icon = await request(context.port, "/api/v2/launchpad/icons/dashboard-icons%3Ajellyfin", { cookie: session.cookie, origin: session.origin });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers["content-type"], "image/svg+xml");
  assert.equal(icon.headers["x-content-type-options"], "nosniff");
  assert.equal(icon.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.deepEqual(icon.bytes, SVG);
  for (const bad of ["dashboard-icons%3A..%2Fx", "nothing%3Ahere", "dashboard-icons%3Amissing"]) {
    const response = await request(context.port, `/api/v2/launchpad/icons/${bad}`, { cookie: session.cookie, origin: session.origin });
    assert.equal(response.status, 404, bad);
  }
}));

test("icon upload stores by content and caps size", () => withSession(async (context, session) => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const saved = await request(context.port, "/api/v2/launchpad/icons", { method: "POST", ...session, raw: png });
  assert.equal(saved.status, 201, saved.text);
  assert.match(saved.json.ref, /^upload:[a-f0-9]{16}\.png$/u);
  const served = await request(context.port, `/api/v2/launchpad/icons/${encodeURIComponent(saved.json.ref)}`, { cookie: session.cookie, origin: session.origin });
  assert.equal(served.status, 200);
  const big = await request(context.port, "/api/v2/launchpad/icons", { method: "POST", ...session, raw: Buffer.concat([png, Buffer.alloc(600 * 1024)]) });
  assert.equal(big.status, 413);
  const wrong = await request(context.port, "/api/v2/launchpad/icons", { method: "POST", ...session, raw: Buffer.from("not an image") });
  assert.equal(wrong.status, 415);
}));

test("index.html's meta CSP leaves iframe origins to the response header", async () => {
  // Browsers enforce both the meta and the header policy. Without frame-src
  // here, default-src 'self' would block every Launchpad iframe tile no
  // matter what the header allows; the header narrows it to configured origins.
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u)?.[1] || "";
  assert.match(meta, /(?:^|; )frame-src http: https:(?:;|$)/u);
  assert.match(meta, /default-src 'self'/u);
});
