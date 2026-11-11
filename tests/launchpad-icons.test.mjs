import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLaunchpadIconStore, DASHBOARD_ICONS_BASE, MDI_BASE } from "../server/launchpad-icons.mjs";

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, "error", "redirects are never followed");
    const route = routes[String(url)];
    if (!route) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(route.body, { status: 200, headers: { "content-type": route.type } });
  };
  return { fetchImpl, calls };
}

async function withIcons(routes, fn, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-launchpad-icons-"));
  const fake = fakeFetch(routes);
  let now = 1_000_000;
  const store = await createLaunchpadIconStore({ dataDir: root, fetchImpl: fake.fetchImpl, clock: () => now, ...extra });
  try {
    await fn(store, fake.calls, (ms) => { now += ms; });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dashboard-icons come only from the fixed host and are cached", () => withIcons({
  [`${DASHBOARD_ICONS_BASE}/svg/jellyfin.svg`]: { body: SVG, type: "image/svg+xml" }
}, async (store, calls) => {
  const first = await store.get("dashboard-icons:jellyfin");
  assert.equal(first.contentType, "image/svg+xml");
  assert.deepEqual(first.bytes, SVG);
  const second = await store.get("dashboard-icons:jellyfin");
  assert.deepEqual(second.bytes, SVG);
  assert.deepEqual(calls, [`${DASHBOARD_ICONS_BASE}/svg/jellyfin.svg`]);
  assert.ok(DASHBOARD_ICONS_BASE.startsWith("https://cdn.jsdelivr.net/"));
}));

test("mdi icons come from the same host at a pinned version", () => withIcons({
  [`${MDI_BASE}/home.svg`]: { body: SVG, type: "image/svg+xml" }
}, async (store, calls) => {
  assert.ok(await store.get("mdi:home"));
  assert.deepEqual(calls, [`${MDI_BASE}/home.svg`]);
  assert.match(MDI_BASE, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mdi\/svg@7\.4\.47\/svg$/u);
}));

test("bad names never fetch", () => withIcons({}, async (store, calls) => {
  for (const ref of ["dashboard-icons:../x", "dashboard-icons:A", "mdi:", "http://x", "upload:../../etc/passwd", "emoji:🎬"]) {
    assert.equal(await store.get(ref), null, ref);
  }
  assert.deepEqual(calls, []);
}));

test("svg 404 falls back to png", () => withIcons({
  [`${DASHBOARD_ICONS_BASE}/png/sonarr.png`]: { body: PNG, type: "image/png" }
}, async (store) => {
  assert.equal((await store.get("dashboard-icons:sonarr")).contentType, "image/png");
}));

test("oversized or non-image responses are refused", () => withIcons({
  [`${DASHBOARD_ICONS_BASE}/svg/big.svg`]: { body: Buffer.concat([SVG, Buffer.alloc(600 * 1024, 0x20)]), type: "image/svg+xml" },
  [`${DASHBOARD_ICONS_BASE}/svg/page.svg`]: { body: Buffer.from("<html><script>x</script></html>"), type: "text/html" }
}, async (store) => {
  assert.equal(await store.get("dashboard-icons:big"), null);
  assert.equal(await store.get("dashboard-icons:page"), null);
}));

test("a miss is cached for an hour", () => withIcons({}, async (store, calls, advance) => {
  assert.equal(await store.get("dashboard-icons:nothing"), null);
  assert.equal(await store.get("dashboard-icons:nothing"), null);
  assert.equal(calls.length, 2, "svg then png, once");
  advance(61 * 60 * 1000);
  await store.get("dashboard-icons:nothing");
  assert.equal(calls.length, 4);
}));

test("uploads are typed by content and capped", () => withIcons({}, async (store) => {
  const ref = await store.saveUpload(PNG);
  assert.match(ref, /^upload:[a-f0-9]{16}\.png$/u);
  assert.equal((await store.get(ref)).contentType, "image/png");
  assert.match(await store.saveUpload(SVG), /\.svg$/u);
  await assert.rejects(store.saveUpload(Buffer.concat([PNG, Buffer.alloc(600 * 1024)])), (error) => error.code === "ICON_TOO_LARGE");
  await assert.rejects(store.saveUpload(Buffer.from("MZ\x90\x00 not an image")), (error) => error.code === "ICON_TYPE");
}));
