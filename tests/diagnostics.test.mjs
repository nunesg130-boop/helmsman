import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeErrorForLog, redactLogRoute, redactLogText } from "../server/log-redaction.mjs";
import { captureOutputLine, createDiagnostics, DIAGNOSTICS_LIMITS, recentOutput, resetOutputForTests, tracedDispatcher } from "../server/diagnostics.mjs";
import { createEventJournal } from "../server/event-journal.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
// Built by joining strings so the repository holds no credential-bearing URL.
const AT = (user, password) => `${user}:${password}@`;

test("free text is scrubbed of keys, passwords, tokens and credentials in links", () => {
  const cases = [
    [`GET http://${AT("admin", "hunter2")}10.0.0.5:8989/api/v3/queue?apikey=${KEY}&page=1 failed`, "GET http://[removed]@10.0.0.5:8989/api/v3/queue?… failed"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I8PlFUP0THsR8U", "Authorization: [removed] [removed]"],
    ['{"apiKey":"abc123def456ghi789jkl012","name":"Sonarr"}', '{"apiKey":[removed],"name":"Sonarr"}'],
    ["password=hunter2 token: s3cr3tvalue user=gabriel", "password=[removed] token: [removed] user=gabriel"],
    [`X-Api-Key ${KEY} rejected`, "X-Api-Key [removed] rejected"]
  ];
  for (const [input, expected] of cases) assert.equal(redactLogText(input), expected);
  // Identifiers and file paths stay readable.
  const kept = "target 822da0d5-0320-4a8c-a663-2abc7bc197c9 at /app/server/infrastructure-service-control-plane.mjs:123:45";
  assert.equal(redactLogText(kept), kept);
  assert.equal(redactLogText("line one\nline\u0007 two"), "line one line two");
  assert.equal(redactLogText("x".repeat(400), 50).length, 50);
  assert.equal(redactLogRoute(`/api/v3/queue?apikey=${KEY}`), "/api/v3/queue");
  assert.equal(redactLogRoute(`/emby/Items/${KEY}/Images`), "/emby/Items/[removed]/Images");
  assert.equal(redactLogRoute("not a path"), "");
  const error = Object.assign(new Error(`connect failed for http://10.0.0.5/?token=${KEY}`), { code: "ECONNREFUSED" });
  const described = describeErrorForLog(error);
  assert.equal(described.message, "connect failed for http://10.0.0.5/?…");
  assert.match(described.detail, /\[ECONNREFUSED\]\nat /u);
  assert.equal(described.detail.includes(KEY), false);
});

test("debug entries are recorded only while debug logging is on, and it turns itself off", () => {
  let now = Date.parse("2026-10-20T12:00:00Z");
  const events = [];
  const diagnostics = createDiagnostics({ record: (event) => events.push(event), clock: () => now });
  diagnostics.debug({ category: "health", event: "check.completed", outcome: "succeeded" });
  assert.equal(events.length, 0);
  assert.deepEqual(diagnostics.settings(), { level: "normal", debugUntil: null, defaultHours: 4, maximumHours: 24 });
  const on = diagnostics.setDebug(true, 2);
  assert.equal(on.level, "debug");
  assert.equal(on.debugUntil, "2026-10-20T14:00:00.000Z");
  assert.equal(events.at(-1).event, "logging.level");
  diagnostics.debug({ category: "health", event: "check.completed", outcome: "succeeded" });
  assert.equal(events.at(-1).level, "debug");
  diagnostics.setDebug(true, 99);
  assert.equal(diagnostics.settings().debugUntil, new Date(now + 24 * 3_600_000).toISOString(), "capped at 24 hours");
  now += 25 * 3_600_000;
  assert.equal(diagnostics.debugEnabled(), false);
  const before = events.length;
  diagnostics.debug({ category: "health", event: "check.completed", outcome: "succeeded" });
  assert.equal(events.length, before);
});

test("debug entries are capped per minute and the skipped count is logged", () => {
  let now = 1_000_000;
  const events = [];
  const diagnostics = createDiagnostics({ record: (event) => events.push(event), clock: () => now });
  diagnostics.setDebug(true, 1);
  events.length = 0;
  for (let index = 0; index < DIAGNOSTICS_LIMITS.debugEventsPerMinute + 25; index += 1) {
    diagnostics.debug({ category: "request", event: "request.upstream", outcome: "succeeded" });
  }
  assert.equal(events.length, DIAGNOSTICS_LIMITS.debugEventsPerMinute);
  now += 61_000;
  diagnostics.debug({ category: "request", event: "request.upstream", outcome: "succeeded" });
  const dropped = events.find((event) => event.event === "logging.dropped");
  assert.match(dropped.message, /^25 debug entries were skipped/u);
});

test("traced dispatchers time each request and pass results and errors through", async () => {
  let now = 0;
  const events = [];
  const diagnostics = createDiagnostics({ record: (event) => events.push(event), clock: () => now });
  const ok = tracedDispatcher("media", async () => { now += 42; return { status: 200, body: "x" }; }, diagnostics, () => now);
  const input = { route: { service: "sonarr", method: "GET", upstreamPath: "/api/v3/queue", upstreamPathAndQuery: `/api/v3/queue?apikey=${KEY}` } };
  assert.deepEqual(await ok(input), { status: 200, body: "x" });
  assert.equal(events.length, 0, "nothing is logged at the normal level");
  diagnostics.setDebug(true, 1);
  events.length = 0;
  await ok(input);
  assert.equal(events[0].category, "request");
  assert.equal(events[0].service, "sonarr");
  assert.equal(events[0].route, "/api/v3/queue");
  assert.equal(events[0].durationMs, 42);
  assert.equal(events[0].httpStatus, 200);
  assert.equal(events[0].message, "GET /api/v3/queue → 200 in 42 ms");
  const failing = tracedDispatcher("media", async () => { throw Object.assign(new Error("socket hang up"), { code: "UPSTREAM_UNAVAILABLE", status: 502 }); }, diagnostics, () => now);
  await assert.rejects(failing(input), /socket hang up/u);
  assert.equal(events[1].outcome, "failed");
  assert.equal(events[1].code, "UPSTREAM_UNAVAILABLE");
  assert.match(events[1].message, /failed after 0 ms: socket hang up/u);
});

test("errors are logged with message and stack at the normal level", () => {
  const events = [];
  const diagnostics = createDiagnostics({ record: (event) => events.push(event) });
  diagnostics.error("broker", new TypeError(`bad value password=${KEY}`), { event: "request.failed", route: "/api/v2/x?token=y" });
  assert.equal(events[0].level, "error");
  assert.equal(events[0].route, "/api/v2/x");
  assert.equal(events[0].message, "bad value password=[removed]");
  assert.match(events[0].detail, /^TypeError: bad value password=\[removed\]\nat /u);
});

test("server output keeps a scrubbed recent tail without the setup token", () => {
  resetOutputForTests();
  captureOutputLine("stdout", "Helmsman setup token: Zk3mQ9vX2pL8wR4tY6uB1nC7");
  captureOutputLine("stderr", `request failed for http://${AT("user", "pw")}host/api?apikey=${KEY}`);
  const { lines, lastSeq } = recentOutput();
  assert.equal(lastSeq, 2);
  assert.deepEqual(lines.map(({ stream, text }) => [stream, text]), [
    ["stdout", "Helmsman setup token: [removed]"],
    ["stderr", "request failed for http://[removed]@host/api?…"]
  ]);
  assert.deepEqual(recentOutput({ afterSeq: 1 }).lines.map(({ seq }) => seq), [2]);
  for (let index = 0; index < DIAGNOSTICS_LIMITS.outputLines + 10; index += 1) captureOutputLine("stdout", `line ${index}`);
  assert.equal(recentOutput({ limit: 5_000 }).lines.length, DIAGNOSTICS_LIMITS.outputLines);
  resetOutputForTests();
});

test("the journal stores scrubbed message, detail, route, duration and source", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-diagnostics-"));
  try {
    const journal = await createEventJournal({ dataDir });
    await journal.record({
      level: "debug",
      category: "request",
      event: "request.upstream",
      outcome: "succeeded",
      service: "sonarr",
      source: "media",
      route: `/api/v3/queue?apikey=${KEY}`,
      durationMs: 41.6,
      message: `GET with token=${KEY}`,
      detail: `line one\nhttp://${AT("a", "b")}host/x?key=${KEY}`
    });
    await journal.record({ level: "info", category: "agent", event: "agent.run", outcome: "observed" });
    const { entries } = await journal.query({ q: "queue" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].route, "/api/v3/queue");
    assert.equal(entries[0].durationMs, 42);
    assert.equal(entries[0].message, "GET with token=[removed]");
    assert.equal(entries[0].detail, "line one\nhttp://[removed]@host/x?…");
    assert.equal(JSON.stringify(entries).includes(KEY), false);
    assert.throws(() => journal.record({ level: "info", category: "nope", event: "x", outcome: "observed" }), /category/u);
    assert.throws(() => journal.record({ level: "info", category: "agent", event: "x", outcome: "observed", durationMs: -1 }), /duration/u);
    assert.throws(() => journal.record({ level: "info", category: "agent", event: "x", outcome: "observed", source: "Bad Source" }), /source/u);
    await journal.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
