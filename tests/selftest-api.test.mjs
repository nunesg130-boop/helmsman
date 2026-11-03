import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgent } from "../server/agent.mjs";
import { CredentialStore } from "../server/secrets.mjs";
import { labSnapshot } from "./helpers/lab-fixture.mjs";

// The self-test routes under /api/v2/agent, driven through agent.handleApi
// with a real agent, a real runner and a fake model server. Session and
// CSRF checks belong to the control plane and are covered in
// tests/control-plane.test.mjs.

const INSTANCE_ID = "12345678-1234-4234-8234-123456789abc";
const PRIVATE_POLICY = { allowedCidrs: [], allowPublicHttps: false, revision: 1 };
const START = Date.parse("2026-10-30T12:00:00.000Z");
const STATUS_KEYS = ["asked", "categories", "done", "failed", "paused", "queued", "reason", "running", "stopping", "unaskedLeft", "unrated"];
const ITEM_KEYS = ["answer", "category", "changedFromBefore", "code", "conversationId", "correction", "failed", "question", "rating", "toolsUsed"];

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function harness(t, { hold = null } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-selftest-api-"));
  const credentialStore = new CredentialStore(dataDir, { instanceId: INSTANCE_ID });
  await credentialStore.initialize();
  const context = { now: START, current: labSnapshot(), modelCalls: [], hold };
  const send = async ({ targetResolution, path: requestPath, body }) => {
    if (targetResolution.target.hostname !== "ai.test") throw new Error(`unexpected host ${targetResolution.target.hostname}`);
    if (requestPath === "/v1/models") return { status: 200, json: { data: [{ id: "qwen2.5:3b" }] } };
    context.modelCalls.push(body);
    if (context.hold) await context.hold(context.modelCalls.length);
    return { status: 200, json: { choices: [{ message: { role: "assistant", content: `Answer ${context.modelCalls.length}.` } }] } };
  };
  const agent = await createAgent({
    dataDir,
    credentialStore,
    lookup: async () => [{ address: "10.1.0.20", family: 4 }],
    policy: () => PRIVATE_POLICY,
    snapshot: () => context.current,
    subscribe: () => () => {},
    performAction: async () => { throw new Error("the self-test must never run an action"); },
    send,
    clock: () => context.now,
    timers: { setInterval: () => null, clearInterval: () => {} }
  });
  t.after(async () => {
    await agent.stop();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });
  agent.start();
  return { agent, context, dataDir };
}

async function api(agent, method, pathname, body = undefined) {
  let sent = null;
  await agent.handleApi({ method }, null, new URL(`http://helmsman.test${pathname}`), {
    readJson: async () => body ?? {},
    sendJson: (_response, status, payload) => { sent = { status, payload }; }
  });
  return sent;
}

async function prepare(agent, { keep = true } = {}) {
  await api(agent, "PUT", "/api/v2/agent/ai", { url: "http://ai.test:11434/v1", model: "qwen2.5:3b", questionsPerHour: 2000 });
  if (keep) await api(agent, "PUT", "/api/v2/agent/conversations/settings", { keep: true, reports: false });
}

async function status(agent) {
  return (await api(agent, "GET", "/api/v2/agent/selftest")).payload;
}

async function settle(agent, until = (value) => !value.running) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const value = await status(agent);
    if (until(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The self-test did not settle.");
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting.");
}

async function filesIn(directory) {
  const out = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(directory, full)] = (await readFile(full)).toString("base64");
  }
  return out;
}

test("status, start, stop, continue and review answer for a signed-in owner", async (t) => {
  let gate = null;
  const { agent, context } = await harness(t, { hold: async () => { if (gate) await gate.promise; } });
  await prepare(agent);

  const idle = await api(agent, "GET", "/api/v2/agent/selftest");
  assert.equal(idle.status, 200);
  assert.deepEqual(Object.keys(idle.payload).sort(), STATUS_KEYS);
  assert.equal(idle.payload.running, false);
  assert.equal(idle.payload.queued, 0);
  assert.ok(idle.payload.unaskedLeft > 0, "the lab snapshot gives questions to ask");

  const started = await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 3 });
  assert.equal(started.status, 201);
  assert.equal(started.payload.requested, 3);
  assert.equal(started.payload.running, true);
  assert.ok(started.payload.queued >= 1 && started.payload.queued <= 3);
  let done = await settle(agent);
  assert.equal(done.done, 3);
  assert.equal(done.failed, 0);
  assert.equal(done.unrated, 3);
  assert.equal(context.modelCalls.length, 3);

  const review = await api(agent, "GET", "/api/v2/agent/selftest/review");
  assert.equal(review.status, 200);
  assert.deepEqual(Object.keys(review.payload).sort(), ["items", "next"]);
  assert.equal(review.payload.items.length, 3);
  assert.equal(review.payload.next, null);
  for (const item of review.payload.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
    assert.match(item.conversationId, /^[a-f0-9-]{36}$/u);
    assert.match(item.answer, /^Answer \d\.$/u);
  }

  // Stop answers at once; the question in flight finishes, then the batch
  // waits for Continue.
  gate = deferred();
  const second = await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 3 });
  assert.equal(second.status, 201);
  await waitFor(() => context.modelCalls.length === 4);
  const stopping = await api(agent, "POST", "/api/v2/agent/selftest/stop", {});
  assert.equal(stopping.status, 200);
  assert.deepEqual(Object.keys(stopping.payload).sort(), STATUS_KEYS);
  assert.equal(stopping.payload.running, true);
  assert.equal(stopping.payload.stopping, true);
  assert.equal((await status(agent)).stopping, true);
  gate.resolve();
  gate = null;
  const stopped = await settle(agent);
  assert.deepEqual(Object.keys(stopped).sort(), STATUS_KEYS);
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopping, false);
  assert.equal(stopped.paused, true);
  assert.equal(stopped.reason, "stopped");
  assert.equal(stopped.done, 1);
  assert.equal(stopped.queued, 2);

  const continued = await api(agent, "POST", "/api/v2/agent/selftest/continue", {});
  assert.equal(continued.status, 200);
  assert.equal(continued.payload.running, true);
  done = await settle(agent);
  assert.equal(done.done, 3);
  assert.equal(done.queued, 0);
  assert.equal(done.paused, false);
  assert.equal((await api(agent, "GET", "/api/v2/agent/selftest/review?filter=all")).payload.items.length, 6);

  // Stop and continue take an empty body only.
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/stop", { now: true }), { status: 400, code: "INVALID_REQUEST" });
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/continue", { count: 3 }), { status: 400, code: "INVALID_REQUEST" });
});

test("start rejects an unknown body key, a non-integer count and a count over 1000", async (t) => {
  const { agent, context } = await harness(t);
  await prepare(agent);
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/start", { count: 3, seed: 1 }), { status: 400, code: "INVALID_REQUEST" });
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/start", []), { status: 400, code: "INVALID_REQUEST" });
  for (const count of [1.5, "5", null, 0, 1001]) {
    await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/start", { count }), { status: 400, code: "SELFTEST_BAD_COUNT" }, String(count));
  }
  assert.equal((await status(agent)).running, false);
  assert.equal(context.modelCalls.length, 0);
});

test("start maps the runner's refusals to their status and code", async (t) => {
  const { agent, context } = await harness(t);
  await prepare(agent, { keep: false });
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/start", { count: 3 }), { status: 409, code: "SELFTEST_KEEP_OFF" });
  await api(agent, "PUT", "/api/v2/agent/conversations/settings", { keep: true, reports: false });
  context.current = null;
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/start", {}), { status: 409, code: "SELFTEST_NO_INVENTORY" });
});

test("the review route returns at most 25 items and a cursor", async (t) => {
  const { agent } = await harness(t);
  await prepare(agent);
  assert.equal((await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 30 })).status, 201);
  const done = await settle(agent);
  assert.equal(done.done, 30);

  const first = await api(agent, "GET", "/api/v2/agent/selftest/review");
  assert.equal(first.payload.items.length, 25);
  assert.equal(first.payload.next, "25");
  // A query string reaches the route (the control plane once answered 404 for one).
  const second = await api(agent, "GET", `/api/v2/agent/selftest/review?filter=unrated&cursor=${first.payload.next}`);
  assert.equal(second.status, 200);
  assert.equal(second.payload.items.length, 5);
  assert.equal(second.payload.next, null);
  const all = await api(agent, "GET", "/api/v2/agent/selftest/review?filter=all");
  assert.equal(all.status, 200);
  assert.equal(all.payload.items.length, 25);
  assert.equal(all.payload.next, "25");
  // An empty category means every category; a named one narrows the list.
  assert.equal((await api(agent, "GET", "/api/v2/agent/selftest/review?filter=all&category=")).payload.items.length, 25);
  const category = first.payload.items[0].category;
  const narrowed = (await api(agent, "GET", `/api/v2/agent/selftest/review?filter=all&category=${category}`)).payload.items;
  assert.ok(narrowed.length >= 1 && narrowed.every((item) => item.category === category));
  assert.deepEqual((await api(agent, "GET", "/api/v2/agent/selftest/review?filter=failed")).payload, { items: [], next: null });

  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest/review?filter=great"), { status: 400, code: "SELFTEST_BAD_REVIEW" });
  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest/review?cursor=-1"), { status: 400, code: "SELFTEST_BAD_REVIEW" });
  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest/review?limit=100"), { status: 400, code: "SELFTEST_BAD_REVIEW" });
  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest/review?filter=all&filter=failed"), { status: 400, code: "SELFTEST_BAD_REVIEW" });
  await assert.rejects(api(agent, "GET", `/api/v2/agent/selftest/review?category=${"x".repeat(65)}`), { status: 400, code: "SELFTEST_BAD_REVIEW" });
  // Other routes still refuse a query string.
  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest?filter=all"), { status: 404, code: "NOT_FOUND" });
  await assert.rejects(api(agent, "POST", "/api/v2/agent/selftest/review", {}), { status: 404, code: "NOT_FOUND" });
});

test("stopping the agent stops a running self-test and writes nothing afterwards", async (t) => {
  const gate = deferred();
  const { agent, context, dataDir } = await harness(t, { hold: async (call) => { if (call === 2) await gate.promise; } });
  await prepare(agent);
  assert.equal((await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 5 })).status, 201);
  await waitFor(() => context.modelCalls.length === 2);

  // A model call still running does not hold up shutdown.
  let timer;
  const result = await Promise.race([
    agent.stop().then(() => "stopped"),
    new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 2_000); })
  ]);
  clearTimeout(timer);
  assert.equal(result, "stopped");
  const before = await filesIn(dataDir);
  assert.ok(Object.keys(before).includes("selftest.json"));

  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await filesIn(dataDir), before, "nothing is written after stop resolves");
  assert.equal(context.modelCalls.length, 2, "no further question is asked");
});

test("a running batch leaves room in the hourly limit for the owner's chat", async (t) => {
  const { agent, context } = await harness(t);
  await prepare(agent);
  await api(agent, "PUT", "/api/v2/agent/ai", { questionsPerHour: 10 });
  assert.equal((await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 20 })).status, 201);
  await waitFor(() => context.modelCalls.length === 5);
  // The runner is refused from here on and waits for a slot to free up.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(context.modelCalls.length, 5, "the batch stops at 5 of 10");
  const running = await status(agent);
  assert.equal(running.running, true);
  assert.equal(running.done, 5);
  assert.equal(running.failed, 0, "waiting for room is not a failure");
  const chat = await api(agent, "POST", "/api/v2/agent/ask", { question: "Is sonarr up?" });
  assert.equal(chat.status, 200);
  assert.match(chat.payload.answer, /^Answer \d+\.$/u);
});

test("the stop route answers promptly while a model call is held open", async (t) => {
  const gate = deferred();
  const { agent, context } = await harness(t, { hold: async (call) => { if (call === 1) await gate.promise; } });
  await prepare(agent);
  assert.equal((await api(agent, "POST", "/api/v2/agent/selftest/start", { count: 3 })).status, 201);
  await waitFor(() => context.modelCalls.length === 1);
  let timer;
  const result = await Promise.race([
    api(agent, "POST", "/api/v2/agent/selftest/stop", {}),
    new Promise((resolve) => { timer = setTimeout(() => resolve("hung"), 1_000); })
  ]);
  clearTimeout(timer);
  assert.notEqual(result, "hung", "stop does not wait for the model");
  assert.equal(result.payload.stopping, true);
  gate.resolve();
  const stopped = await settle(agent);
  assert.equal(stopped.reason, "stopped");
  assert.equal(stopped.done, 1);
  assert.equal(context.modelCalls.length, 1);
});

test("a self-test that cannot start logs why", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-selftest-api-"));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));
  // A symbolic link where the state file belongs is refused (O_NOFOLLOW).
  await symlink(path.join(dataDir, "elsewhere.json"), path.join(dataDir, "selftest.json"));
  const credentialStore = new CredentialStore(dataDir, { instanceId: INSTANCE_ID });
  await credentialStore.initialize();
  const logs = [];
  const agent = await createAgent({
    dataDir,
    credentialStore,
    lookup: async () => [{ address: "10.1.0.20", family: 4 }],
    policy: () => PRIVATE_POLICY,
    snapshot: () => labSnapshot(),
    subscribe: () => () => {},
    performAction: async () => { throw new Error("no action in this test"); },
    send: async () => { throw new Error("no model in this test"); },
    clock: () => START,
    log: (message) => logs.push(message),
    timers: { setInterval: () => null, clearInterval: () => {} }
  });
  t.after(() => agent.stop());
  await assert.rejects(api(agent, "GET", "/api/v2/agent/selftest"), { status: 503, code: "SELFTEST_UNAVAILABLE" });
  const line = logs.find((message) => /self-test/iu.test(message));
  assert.ok(line, "the failure is logged");
  assert.match(line, /ELOOP/u, line);
});
