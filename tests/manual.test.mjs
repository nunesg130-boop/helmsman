import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalManualMarkdown, createManualStore, MANUAL_LIMITS } from "../server/manual.mjs";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";


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
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-manual-api-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const manual = await createManualStore({ dataDir: root });
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    manual,
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
  return { root, store, server, controlPlane, manual, port, origin: `http://127.0.0.1:${port}`, setupToken };
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
      deviceName: "Manual test browser",
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

test("manual Markdown is normalized and bounded", () => {
  assert.equal(canonicalManualMarkdown("# Title\r\n\r\nBody\t text  \n\n"), "# Title\n\nBody\t text");
  assert.equal(canonicalManualMarkdown(""), "");
  assert.equal(canonicalManualMarkdown("bad\u0000byte"), null);
  assert.equal(canonicalManualMarkdown("line\u2028separator"), null);
  assert.equal(canonicalManualMarkdown("x".repeat(MANUAL_LIMITS.markdownBytes + 1)), null);
  assert.equal(canonicalManualMarkdown(42), null);
});

test("saving the manual requires a session, CSRF and the current revision", async () => {
  const context = await start();
  try {
    const anonymous = await request(context.port, "/api/v2/manual", { origin: context.origin });
    assert.equal(anonymous.status, 401);

    const session = await claim(context);
    const empty = await request(context.port, "/api/v2/manual", { cookie: session.cookie, origin: session.origin });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { manual: { markdown: "", revision: null, updatedAt: null } });

    const withoutCsrf = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      origin: session.origin,
      cookie: session.cookie,
      body: { markdown: "# Manual", revision: null }
    });
    assert.equal(withoutCsrf.status, 403);

    const extraKeys = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown: "# Manual", revision: null, title: "x" }
    });
    assert.equal(extraKeys.status, 400);

    const invalid = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown: "bad\u0000", revision: null }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_MANUAL");

    const markdown = `# Manual\n\n${"Row | 192.168.0.7 | Jelly-Arr\n".repeat(3000)}`;
    assert.ok(Buffer.byteLength(markdown) > 64 * 1024, "the manual body may exceed the default JSON limit");
    const saved = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown, revision: null }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.match(saved.json.manual.revision, /^[a-f0-9-]{36}$/u);
    assert.equal(saved.json.manual.markdown, markdown.trimEnd());

    const stale = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown: "# Older edit", revision: null }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "MANUAL_CONFLICT");

    const updated = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown: "# Manual v2", revision: saved.json.manual.revision }
    });
    assert.equal(updated.status, 200);
    assert.notEqual(updated.json.manual.revision, saved.json.manual.revision);

    const persisted = JSON.parse(await readFile(path.join(context.root, "manual.json"), "utf8"));
    assert.equal(persisted.markdown, "# Manual v2");
    const reloaded = await createManualStore({ dataDir: context.root });
    assert.equal(reloaded.get().revision, updated.json.manual.revision);

    const tooLarge = await request(context.port, "/api/v2/manual", {
      method: "PUT",
      ...session,
      body: { markdown: "x".repeat(MANUAL_LIMITS.markdownBytes + 1), revision: updated.json.manual.revision }
    });
    assert.equal(tooLarge.status, 400);

    const query = await request(context.port, "/api/v2/manual?x=1", { cookie: session.cookie, origin: session.origin });
    assert.equal(query.status, 404);
    const deleted = await request(context.port, "/api/v2/manual", { method: "DELETE", ...session });
    assert.equal(deleted.status, 405);
  } finally {
    await stop(context);
  }
});

test("a corrupt manual file loads as an empty manual", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-manual-corrupt-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(root, "manual.json"), "{not json");
    const store = await createManualStore({ dataDir: root });
    assert.deepEqual(store.get(), { markdown: "", revision: null, updatedAt: null });
    const saved = await store.save("# Fresh", null);
    assert.equal(saved.markdown, "# Fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
