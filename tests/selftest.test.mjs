import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationStore } from "../server/agent-conversations.mjs";
import { createSelfTest, SelfTestError } from "../server/selftest.mjs";
import { generateQuestions } from "../server/selftest-questions.mjs";
import { labSnapshot } from "./helpers/lab-fixture.mjs";

const SEED = 11;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function busy() {
  const error = new Error("The agent is busy. Try again in a moment.");
  error.status = 503;
  error.code = "AGENT_BUSY";
  return error;
}

function failure(code) {
  const error = new Error("The model server did not answer.");
  error.status = 502;
  error.code = code;
  return error;
}

/**
 * A fake of the agent's askSelfTest that saves each exchange in a real
 * conversation store, the way the agent does. `behave(call)` may return a
 * promise (to hold a question), throw, or return an answer string.
 */
function fakeAgent(conversations, behave = () => undefined) {
  const calls = [];
  async function askSelfTest(body) {
    assert.deepEqual(Object.keys(body).sort(), ["history", "question", "selfTest"]);
    assert.equal(typeof body.selfTest.id, "string");
    assert.ok(body.selfTest.id && body.selfTest.category, "a valid self-test marker");
    const call = { ...body, index: calls.length };
    calls.push(call);
    const outcome = await behave(call);
    const answer = typeof outcome === "string" ? outcome : `ANSWER-${body.selfTest.id}`;
    const conversationId = await conversations.record({
      source: "question",
      model: "qwen3:4b",
      messages: [
        { role: "system", content: "You are the Helmsman agent." },
        ...body.history,
        { role: "user", content: body.question },
        { role: "assistant", content: answer }
      ],
      selfTest: body.selfTest
    });
    return { answer, toolsUsed: [], conversationId };
  }
  return { askSelfTest, calls };
}

async function setup(t, { behave, keep = true, snapshot = labSnapshot(), dataDir = null, conversations = null, realSleep = false } = {}) {
  const dir = dataDir || await mkdtemp(path.join(os.tmpdir(), "helmsman-selftest-"));
  if (!dataDir) t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-30T12:00:00Z");
  const clock = () => (now += 1000);
  let next = 0;
  const store = conversations || await createConversationStore({
    dataDir: dir,
    clock,
    idFactory: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`
  });
  const agent = fakeAgent(store, behave);
  const sleeps = [];
  const selfTest = await createSelfTest({
    dataDir: dir,
    askSelfTest: agent.askSelfTest,
    snapshot: () => snapshot,
    conversationStore: store,
    conversationsKept: () => keep,
    clock,
    seed: () => SEED,
    sleep: realSleep ? undefined : async (ms) => { sleeps.push(ms); }
  });
  return { selfTest, agent, store, dataDir: dir, sleeps };
}

const expected = (count, exclude = new Set()) => generateQuestions(labSnapshot(), { seed: SEED, count, exclude });

async function readState(dataDir) {
  return JSON.parse(await readFile(path.join(dataDir, "selftest.json"), "utf8"));
}

test("start asks count questions in order and records ids as asked", async (t) => {
  const { selfTest, agent, dataDir } = await setup(t);
  const status = await selfTest.start({ count: 12 });
  assert.equal(status.running, true);
  await selfTest.whenIdle();
  const questions = expected(12);
  assert.deepEqual(agent.calls.map((call) => call.question), questions.map((q) => q.text));
  assert.deepEqual(agent.calls.map((call) => call.selfTest), questions.map(({ id, category }) => ({ id, category })));
  const after = await selfTest.status();
  assert.equal(after.running, false);
  assert.equal(after.paused, false);
  assert.equal(after.queued, 0);
  assert.equal(after.done, 12);
  assert.equal(after.failed, 0);
  assert.equal(after.asked, 12);
  assert.equal(after.unrated, 12);
  const disk = await readState(dataDir);
  assert.deepEqual(disk.asked, questions.map((q) => q.id));
  assert.deepEqual(disk.queue, []);
  assert.equal(disk.current, null);
});

test("a follow-up is asked with the previous question and answer as history", async (t) => {
  const { selfTest, agent } = await setup(t);
  await selfTest.start({ count: 40 });
  await selfTest.whenIdle();
  const followIndex = agent.calls.findIndex((call, index) => index > 0 && expected(40)[index].followUp);
  assert.ok(followIndex > 0, "the batch holds a follow-up");
  const base = agent.calls[followIndex - 1];
  assert.deepEqual(agent.calls[followIndex].history, [
    { role: "user", content: base.question },
    { role: "assistant", content: `ANSWER-${base.selfTest.id}` }
  ]);
  for (const [index, call] of agent.calls.entries()) {
    if (!expected(40)[index].followUp) assert.deepEqual(call.history, []);
  }
});

test("stop finishes the question in flight and then halts", async (t) => {
  const hold = deferred();
  const { selfTest, agent } = await setup(t, { behave: (call) => (call.index === 2 ? hold.promise : undefined) });
  await selfTest.start({ count: 10 });
  while (agent.calls.length < 3) await new Promise((resolve) => setImmediate(resolve));
  const stopping = selfTest.stop();
  hold.resolve();
  const status = await stopping;
  assert.equal(agent.calls.length, 3, "nothing is asked after the question in flight");
  assert.equal(status.running, false);
  assert.equal(status.paused, true);
  assert.equal(status.reason, "stopped");
  assert.equal(status.done, 3);
  assert.equal(status.queued, 7, "the remaining questions are still queued");
});

test("a restart shows paused (restart) and continue re-asks the interrupted question once", async (t) => {
  const never = new Promise(() => {});
  const first = await setup(t, { behave: (call) => (call.index === 4 ? never : undefined) });
  await first.selfTest.start({ count: 10 });
  while (first.agent.calls.length < 5) await new Promise((resolve) => setImmediate(resolve));
  const interrupted = first.agent.calls[4].selfTest.id;

  // A new instance on the same data directory is what a restart looks like.
  const second = await setup(t, { dataDir: first.dataDir, conversations: first.store });
  const status = await second.selfTest.status();
  assert.equal(status.running, false);
  assert.equal(status.paused, true);
  assert.equal(status.reason, "restart");
  assert.equal(status.queued, 6);
  assert.equal(second.agent.calls.length, 0, "a restart does not resume by itself");

  await second.selfTest.continueRun();
  await second.selfTest.whenIdle();
  const ids = second.agent.calls.map((call) => call.selfTest.id);
  assert.equal(ids.filter((id) => id === interrupted).length, 1, "the interrupted question is asked once");
  assert.equal(ids[0], interrupted);
  assert.equal(ids.length, 6);
  const disk = await readState(first.dataDir);
  assert.deepEqual(disk.asked, expected(10).map((q) => q.id), "every id recorded once, in order");
  assert.equal((await second.selfTest.status()).done, 10);
});

test("continue after a restart does not ask again a question that was already answered", async (t) => {
  const first = await setup(t);
  await first.selfTest.start({ count: 6 });
  await first.selfTest.whenIdle();
  // Simulate a crash after the answer was saved but before the state was:
  // put the last question back as the one in flight.
  const disk = await readState(first.dataDir);
  const last = expected(6).at(-1);
  disk.asked = disk.asked.slice(0, -1);
  disk.queue = [last];
  disk.current = last.id;
  disk.currentAt = "2026-10-30T11:00:00.000Z";
  await writeFile(path.join(first.dataDir, "selftest.json"), `${JSON.stringify(disk)}\n`, { mode: 0o600 });

  const second = await setup(t, { dataDir: first.dataDir, conversations: first.store });
  assert.equal((await second.selfTest.status()).reason, "restart");
  await second.selfTest.continueRun();
  await second.selfTest.whenIdle();
  assert.equal(second.agent.calls.length, 0, "the saved answer is used, not asked again");
  assert.deepEqual((await readState(first.dataDir)).asked, expected(6).map((q) => q.id));
});

test("AGENT_BUSY waits and then carries on", async (t) => {
  let rejected = false;
  const { selfTest, agent, sleeps } = await setup(t, {
    behave: (call) => {
      if (call.index === 1 && !rejected) {
        rejected = true;
        throw busy();
      }
      return undefined;
    }
  });
  await selfTest.start({ count: 4 });
  await selfTest.whenIdle();
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0);
  const ids = agent.calls.map((call) => call.selfTest.id);
  assert.equal(ids.length, 5, "the busy question is tried again");
  assert.equal(ids[1], ids[2]);
  const status = await selfTest.status();
  assert.equal(status.done, 4);
  assert.equal(status.failed, 0);
  assert.equal(status.unrated, 4, "the question is answered exactly once");
});

test("three consecutive model failures stop the run with a reason", async (t) => {
  const { selfTest, agent } = await setup(t, { behave: () => { throw failure("MODEL_REQUEST_FAILED"); } });
  await selfTest.start({ count: 10 });
  await selfTest.whenIdle();
  assert.equal(agent.calls.length, 3);
  const status = await selfTest.status();
  assert.equal(status.running, false);
  assert.equal(status.paused, true);
  assert.match(status.reason, /model server/iu);
  assert.ok(status.failed >= 3);
  assert.ok(status.queued > 0);
});

test("AI_NOT_CONFIGURED stops the run without recording a failure", async (t) => {
  const { selfTest, agent } = await setup(t, { behave: () => { throw failure("AI_NOT_CONFIGURED"); } });
  await selfTest.start({ count: 5 });
  await selfTest.whenIdle();
  assert.equal(agent.calls.length, 1);
  const status = await selfTest.status();
  assert.equal(status.running, false);
  assert.match(status.reason, /model server/iu);
  assert.equal(status.failed, 0);
  assert.equal(status.queued, 5);
});

test("a single failed question is recorded as failed and the run continues", async (t) => {
  const questions = expected(8);
  const target = questions.findIndex((q, index) => !q.followUp && !questions[index + 1]?.followUp);
  const { selfTest, agent, dataDir } = await setup(t, {
    behave: (call) => {
      if (call.selfTest.id === questions[target].id) throw failure("MODEL_REQUEST_FAILED");
      return undefined;
    }
  });
  await selfTest.start({ count: 8 });
  await selfTest.whenIdle();
  assert.equal(agent.calls.length, 8);
  const status = await selfTest.status();
  assert.equal(status.done, 7);
  assert.equal(status.failed, 1);
  assert.equal(status.reason, null);
  const disk = await readState(dataDir);
  assert.ok(disk.asked.includes(questions[target].id), "a failed question is not asked again automatically");
  const review = await selfTest.review({ filter: "failed" });
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0].failed, true);
  assert.equal(review.items[0].question, questions[target].text);
  assert.equal(review.items[0].code, "MODEL_REQUEST_FAILED");
  assert.equal(review.items[0].answer, null);
});

test("start is refused with SELFTEST_KEEP_OFF when conversations are not kept", async (t) => {
  const { selfTest } = await setup(t, { keep: false });
  await assert.rejects(selfTest.start({ count: 5 }), (error) => error instanceof SelfTestError && error.status === 409 && error.code === "SELFTEST_KEEP_OFF");
});

test("start is refused with SELFTEST_NO_INVENTORY when the snapshot is empty", async (t) => {
  for (const snapshot of [null, {}]) {
    const { selfTest } = await setup(t, { snapshot });
    await assert.rejects(selfTest.start({ count: 5 }), (error) => error.status === 409 && error.code === "SELFTEST_NO_INVENTORY");
  }
});

test("start is refused with SELFTEST_BAD_COUNT for 0 and 501", async (t) => {
  const { selfTest, agent } = await setup(t);
  for (const count of [0, 501, 2.5, "10", -1]) {
    await assert.rejects(selfTest.start({ count }), (error) => error.status === 400 && error.code === "SELFTEST_BAD_COUNT");
  }
  assert.equal(agent.calls.length, 0);
});

test("start is refused with SELFTEST_RUNNING while running", async (t) => {
  const hold = deferred();
  const { selfTest } = await setup(t, { behave: () => hold.promise });
  await selfTest.start({ count: 3 });
  await assert.rejects(selfTest.start({ count: 3 }), (error) => error.status === 409 && error.code === "SELFTEST_RUNNING");
  await assert.rejects(selfTest.continueRun(), (error) => error.code === "SELFTEST_RUNNING");
  hold.resolve();
  await selfTest.whenIdle();
});

test("the second batch never repeats an asked question id", async (t) => {
  const { selfTest, agent } = await setup(t);
  await selfTest.start({ count: 30 });
  await selfTest.whenIdle();
  await selfTest.start({ count: 30 });
  await selfTest.whenIdle();
  const ids = agent.calls.map((call) => call.selfTest.id);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
});

test("asked ids are capped at 20,000, oldest dropped", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-selftest-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const old = Array.from({ length: 20_000 }, (_, index) => `q-old${String(index).padStart(7, "0")}`);
  await writeFile(path.join(dataDir, "selftest.json"), `${JSON.stringify({
    version: 1,
    asked: old,
    queue: [],
    current: null,
    counts: { done: 0, failed: 0, categories: {} },
    failures: [],
    revision: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-10-29T12:00:00.000Z"
  })}\n`, { mode: 0o600 });
  const { selfTest } = await setup(t, { dataDir });
  assert.equal((await selfTest.status()).asked, 20_000);
  await selfTest.start({ count: 5 });
  await selfTest.whenIdle();
  const disk = await readState(dataDir);
  assert.equal(disk.asked.length, 20_000);
  assert.deepEqual(disk.asked.slice(0, 2), [old[5], old[6]], "the oldest ids go first");
  assert.deepEqual(disk.asked.slice(-5), expected(5).map((q) => q.id));
  assert.equal((await selfTest.status()).asked, 20_000);
});

test("selftest.json is mode 0600 and holds no answers", async (t) => {
  const { selfTest, dataDir } = await setup(t, { behave: (call) => `SECRET-ANSWER-${call.index}` });
  await selfTest.start({ count: 6 });
  await selfTest.whenIdle();
  const file = path.join(dataDir, "selftest.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /SECRET-ANSWER/u);
  const disk = JSON.parse(text);
  assert.equal(disk.version, 1);
  assert.match(disk.revision, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  assert.ok(!Number.isNaN(Date.parse(disk.updatedAt)));
});

test("review lists unrated first, pages 25 at a time, and flags changedFromBefore when the same question id has a different earlier answer", async (t) => {
  const { selfTest, store } = await setup(t);
  const questions = expected(30);
  const repeated = questions.find((q) => !q.followUp);
  // An earlier answer to the same question id, from before the state was reset.
  await store.record({
    source: "question",
    model: "qwen3:4b",
    messages: [{ role: "user", content: repeated.text }, { role: "assistant", content: "An older, different answer." }],
    selfTest: { id: repeated.id, category: repeated.category }
  });
  await selfTest.start({ count: 30 });
  await selfTest.whenIdle();

  const all = await store.list({ selfTest: "only", limit: 100 });
  const rated = all.filter((item) => item.answer.startsWith("ANSWER-")).slice(0, 3);
  for (const item of rated) await store.rate(item.id, { rating: "up" });

  const page1 = await selfTest.review({});
  assert.equal(page1.items.length, 25);
  assert.equal(typeof page1.next, "string");
  for (const item of page1.items) {
    assert.equal(item.rating, null);
    assert.equal(item.failed, false);
    assert.deepEqual(Object.keys(item).sort(), ["answer", "category", "changedFromBefore", "code", "conversationId", "correction", "failed", "question", "rating", "toolsUsed"]);
  }
  const page2 = await selfTest.review({ cursor: page1.next });
  assert.equal(page2.items.length, 31 - 3 - 25, "the old answer is unrated too");
  assert.equal(page2.next, null);
  const seen = new Set([...page1.items, ...page2.items].map((item) => item.conversationId));
  assert.equal(seen.size, 28);

  const everything = [];
  let cursor = null;
  do {
    const page = await selfTest.review({ filter: "all", cursor });
    assert.ok(page.items.length <= 25);
    everything.push(...page.items);
    cursor = page.next;
  } while (cursor);
  assert.equal(everything.length, 31);
  const firstRated = everything.findIndex((item) => item.rating);
  assert.equal(firstRated, 28, "unrated answers come first");

  const changed = await selfTest.review({ filter: "changed" });
  assert.equal(changed.items.length, 1);
  assert.equal(changed.items[0].question, repeated.text);
  assert.equal(changed.items[0].answer, `ANSWER-${repeated.id}`);
  assert.equal(changed.items[0].changedFromBefore, true);

  const byCategory = await selfTest.review({ filter: "all", category: "node" });
  assert.ok(byCategory.items.every((item) => item.category === "node"));

  assert.equal((await selfTest.status()).unrated, 28);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("two starts in the same tick run one loop", async (t) => {
  const { selfTest, agent } = await setup(t);
  const results = await Promise.allSettled([selfTest.start({ count: 6 }), selfTest.start({ count: 6 })]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((result) => result.status === "rejected").reason;
  assert.equal(rejected.code, "SELFTEST_RUNNING");
  await selfTest.whenIdle();
  const ids = agent.calls.map((call) => call.selfTest.id);
  assert.deepEqual(ids, expected(6).map((q) => q.id), "each question asked once, in order");
  const status = await selfTest.status();
  assert.equal(status.done, 6);
  assert.equal(status.asked, 6);
});

test("start and continue in the same tick run one loop", async (t) => {
  const holds = new Map([[1, deferred()], [4, deferred()]]);
  const { selfTest, agent, dataDir } = await setup(t, { behave: (call) => holds.get(call.index)?.promise });
  await selfTest.start({ count: 8 });
  const pairs = [() => [selfTest.continueRun(), selfTest.start({ count: 8 })], () => [selfTest.continueRun(), selfTest.continueRun()]];
  for (const [round, index] of [1, 4].entries()) {
    while (agent.calls.length < index + 1) await tick();
    const stopping = selfTest.stop();
    holds.get(index).resolve();
    assert.ok((await stopping).queued > 0, "questions are left to continue");
    const results = await Promise.allSettled(pairs[round]());
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "SELFTEST_RUNNING").length, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  }
  await selfTest.whenIdle();
  const ids = agent.calls.map((call) => call.selfTest.id);
  assert.equal(new Set(ids).size, ids.length, "no question asked twice");
  const disk = await readState(dataDir);
  assert.equal(new Set(disk.asked).size, disk.asked.length);
  assert.equal(disk.asked.length, ids.length);
});

test("a write from something else stops the run with SELFTEST_CONFLICT and memory follows the file", async (t) => {
  const hold = deferred();
  const { selfTest, agent, dataDir } = await setup(t, { behave: (call) => (call.index === 2 ? hold.promise : undefined) });
  await selfTest.start({ count: 8 });
  while (agent.calls.length < 3) await tick();
  const theirs = {
    version: 1,
    asked: ["q-theirs000001"],
    queue: [],
    current: null,
    counts: { done: 0, failed: 0, categories: {} },
    failures: [],
    revision: "22222222-2222-4222-8222-222222222222",
    updatedAt: "2026-10-30T13:00:00.000Z"
  };
  await writeFile(path.join(dataDir, "selftest.json"), `${JSON.stringify(theirs)}\n`, { mode: 0o600 });
  hold.resolve();
  await selfTest.whenIdle();
  assert.equal(agent.calls.length, 3, "nothing more is asked");
  const status = await selfTest.status();
  assert.equal(status.running, false);
  assert.match(status.reason, /SELFTEST_CONFLICT/u);
  assert.equal(status.queued, 0, "memory holds what the file holds");
  assert.equal(status.asked, 1);
  assert.equal(status.done, 0);
  assert.deepEqual(await readState(dataDir), theirs, "the other writer's file is left alone");
});

test("a batch of more than 100 is reviewed and counted in full", async (t) => {
  const { selfTest } = await setup(t);
  await selfTest.start({ count: 500 });
  await selfTest.whenIdle();
  const total = expected(500).length;
  assert.ok(total > 100);
  const status = await selfTest.status();
  assert.equal(status.done, total);
  assert.equal(status.unrated, total);
  const items = [];
  let cursor = null;
  do {
    const page = await selfTest.review({ cursor });
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  assert.equal(items.length, total);
  assert.equal(new Set(items.map((item) => item.conversationId)).size, total);
});

test("status shows the unasked questions left and a short batch is visible", async (t) => {
  const { selfTest } = await setup(t);
  const all = expected(500).length;
  assert.equal((await selfTest.status()).unaskedLeft, generateQuestions(labSnapshot(), { seed: 1, count: 100_000 }).length);
  const small = await selfTest.start({ count: 10 });
  assert.equal(small.requested, 10);
  assert.equal(small.queued, 10);
  await selfTest.whenIdle();
  const left = generateQuestions(labSnapshot(), { seed: SEED, count: 100_000, exclude: new Set(expected(10).map((q) => q.id)) }).length;
  assert.ok(left > 0 && left < all);
  assert.equal((await selfTest.status()).unaskedLeft, left);
  const big = await selfTest.start({ count: 500 });
  assert.equal(big.requested, 500);
  assert.equal(big.queued, left, "the batch is shorter than asked for");
  await selfTest.whenIdle();
  // Questions whose text repeats one already used can still come with a new
  // id, so a later batch may hold a few more; unaskedLeft predicts each one.
  let predicted = (await selfTest.status()).unaskedLeft;
  for (let round = 0; predicted > 0; round += 1) {
    assert.ok(round < 10, "the questions run out");
    const next = await selfTest.start({ count: 500 });
    assert.equal(next.queued, predicted);
    await selfTest.whenIdle();
    predicted = (await selfTest.status()).unaskedLeft;
  }
  await assert.rejects(selfTest.start({ count: 5 }), (error) => error instanceof SelfTestError && error.status === 409 && error.code === "SELFTEST_EXHAUSTED");
  assert.equal((await selfTest.status()).unaskedLeft, 0);
});

test("unaskedLeft is 0 with no snapshot", async (t) => {
  const { selfTest } = await setup(t, { snapshot: null });
  assert.equal((await selfTest.status()).unaskedLeft, 0);
});

test("stop resolves promptly when AGENT_BUSY arrives after stop", async (t) => {
  const hold = deferred();
  const { selfTest, agent } = await setup(t, {
    realSleep: true,
    behave: async (call) => {
      if (call.index === 1) {
        await hold.promise;
        throw busy();
      }
      return undefined;
    }
  });
  await selfTest.start({ count: 5 });
  while (agent.calls.length < 2) await tick();
  const startedAt = Date.now();
  const stopping = selfTest.stop();
  hold.resolve();
  const status = await stopping;
  assert.ok(Date.now() - startedAt < 2000, "no busy wait after stop");
  assert.equal(status.running, false);
  assert.equal(status.reason, "stopped");
  assert.equal(agent.calls.length, 2);
});

test("stop during a busy wait resolves promptly and clears the timer", async (t) => {
  let rejected = false;
  const { selfTest, agent } = await setup(t, {
    realSleep: true,
    behave: (call) => {
      if (call.index === 1 && !rejected) {
        rejected = true;
        throw busy();
      }
      return undefined;
    }
  });
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  await selfTest.start({ count: 5 });
  while (agent.calls.length < 2) await tick();
  for (let index = 0; index < 20; index += 1) await tick();
  assert.equal(timers(), before + 1, "the busy wait holds one timer");
  const startedAt = Date.now();
  const status = await selfTest.stop();
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal(status.running, false);
  assert.equal(timers(), before, "the busy-wait timer is cleared");
});

test("a readable but unusable selftest.json is moved aside and the runner works", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-selftest-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const bad = { version: 1, asked: "nope", queue: [], revision: "33333333-3333-4333-8333-333333333333" };
  await writeFile(path.join(dataDir, "selftest.json"), `${JSON.stringify(bad)}\n`, { mode: 0o600 });
  const { selfTest, agent } = await setup(t, { dataDir });
  const status = await selfTest.status();
  assert.equal(status.asked, 0);
  assert.equal(status.reason, null);
  await access(path.join(dataDir, "selftest.json.bad"));
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "selftest.json.bad"), "utf8")), bad);
  await selfTest.start({ count: 3 });
  await selfTest.whenIdle();
  assert.equal(agent.calls.length, 3);
  assert.equal((await readState(dataDir)).asked.length, 3);
});
