import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConversationStore } from "../server/agent-conversations.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const DAY = 86_400_000;

async function store(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-conversations-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-28T12:00:00Z");
  let next = 0;
  const conversations = await createConversationStore({
    dataDir,
    clock: () => now,
    idFactory: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    ...options
  });
  return { conversations, dataDir, advance: (ms) => { now += ms; } };
}

const exchange = (question, answer) => [
  { role: "system", content: "You are the Helmsman agent." },
  { role: "user", content: question },
  { role: "assistant", content: "", tool_calls: [{ id: "seed-overview", type: "function", function: { name: "overview", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "seed-overview", content: `Media: healthy. token=${KEY}` },
  { role: "assistant", content: answer }
];

test("full exchanges are saved scrubbed and listed newest first", async (t) => {
  const { conversations, dataDir } = await store(t);
  const first = await conversations.record({ source: "question", model: "qwen3:4b", messages: exchange("Is sonarr up?", "Yes."), tools: [{ type: "function", function: { name: "overview" } }], durationMs: 812 });
  const second = await conversations.record({ source: "incident", model: "qwen3:4b", messages: exchange("Sonarr is down. Explain.", "Its container stopped.") });
  const items = await conversations.list();
  assert.deepEqual(items.map(({ id }) => id), [second, first]);
  assert.equal(items[1].question, "Is sonarr up?");
  assert.equal(items[1].answer, "Yes.");
  assert.deepEqual(items[1].toolsUsed, ["overview"]);
  assert.deepEqual((await conversations.list({ source: "question" })).map(({ id }) => id), [first]);
  assert.deepEqual((await conversations.list({ source: "reports" })).map(({ id }) => id), [second]);
  const saved = await conversations.find(first);
  assert.equal(saved.messages[3].content, "Media: healthy. token=[removed]", "secrets are scrubbed before saving");
  assert.equal(saved.durationMs, 812);
  const files = await readdir(path.join(dataDir, "agent-conversations"));
  assert.deepEqual(files, ["conversations-2026-10-28.jsonl"]);
  assert.equal((await stat(path.join(dataDir, "agent-conversations", files[0]))).mode & 0o777, 0o600);
});

test("an exchange without a final answer is not saved", async (t) => {
  const { conversations } = await store(t);
  assert.equal(await conversations.record({ source: "question", messages: exchange("hi", "").slice(0, 4) }), null);
  assert.equal(await conversations.record({ source: "bogus", messages: exchange("hi", "ok") }), null);
  assert.equal((await conversations.list()).length, 0);
});

test("ratings and corrections decide what the training export contains", async (t) => {
  const { conversations } = await store(t);
  const good = await conversations.record({ source: "question", model: "m", messages: exchange("q1", "good answer"), tools: [{ type: "function", function: { name: "overview" } }] });
  const bad = await conversations.record({ source: "question", model: "m", messages: exchange("q2", "bad answer") });
  const fixed = await conversations.record({ source: "question", model: "m", messages: exchange("q3", "wrong answer") });
  const unrated = await conversations.record({ source: "question", model: "m", messages: exchange("q4", "unrated answer") });
  await conversations.rate(good, { rating: "up" });
  await conversations.rate(bad, { rating: "down" });
  const corrected = await conversations.rate(fixed, { rating: "down", correction: `The right answer, without password=${KEY}` });
  assert.equal(corrected.correction, "The right answer, without password=[removed]");

  const rated = await conversations.exportTraining({ include: "rated" });
  const lines = rated.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rated.count, 2);
  assert.deepEqual(lines.map((line) => line.messages.at(-1).content), ["good answer", "The right answer, without password=[removed]"]);
  assert.deepEqual(lines[0].tools, [{ type: "function", function: { name: "overview" } }]);

  const all = await conversations.exportTraining({ include: "all" });
  assert.deepEqual(all.text.trim().split("\n").map((line) => JSON.parse(line).messages.at(-1).content), ["good answer", "The right answer, without password=[removed]", "unrated answer"], "rated-down answers never export");

  await conversations.rate(fixed, { correction: null, rating: null });
  assert.equal((await conversations.list()).find(({ id }) => id === fixed).correction, null);
  assert.equal(await conversations.rate("00000000-0000-4000-8000-999999999999", { rating: "up" }), null);
  const status = await conversations.status();
  assert.deepEqual([status.conversations, status.ratedUp, status.ratedDown, status.corrected], [4, 1, 1, 0]);
  assert.ok(unrated);
});

test("old days are removed after the retention period, and everything can be deleted", async (t) => {
  const { conversations, advance } = await store(t, { limits: { retentionDays: 2 } });
  const old = await conversations.record({ source: "question", messages: exchange("old", "old answer") });
  await conversations.rate(old, { rating: "up" });
  advance(3 * DAY + 2 * 60 * 60 * 1_000);
  await conversations.record({ source: "question", messages: exchange("new", "new answer") });
  assert.deepEqual((await conversations.list()).map(({ answer }) => answer), ["new answer"]);
  assert.equal((await conversations.status()).ratedUp, 0, "ratings for removed days go too");
  await conversations.clear();
  assert.equal((await conversations.list()).length, 0);
  assert.equal((await conversations.status()).conversations, 0);
});
