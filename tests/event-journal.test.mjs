import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventJournal,
  EVENT_JOURNAL_SCHEMA
} from "../server/event-journal.mjs";

const START = Date.parse("2026-09-18T12:00:00.000Z");

function ids() {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}

function event(overrides = {}) {
  return {
    level: "info",
    category: "application",
    event: "application.started",
    outcome: "started",
    ...overrides
  };
}

async function temporaryDataDirectory(t, prefix = "helmsman-event-journal-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, "data");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dataDir };
}

async function segmentNames(dataDir) {
  return (await readdir(path.join(dataDir, "logs")))
    .filter((name) => /^helmsman-events-.*\.jsonl$/u.test(name))
    .sort();
}

test("persists only the fixed event schema and rejects arbitrary log content", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => journal.close());

  assert.throws(() => journal.record({
    ...event(),
    message: "password=must-never-be-persisted"
  }), /unsupported field: message/u);
  const credentialBearingUrl = "https://user" + ":secret@example.test";
  assert.throws(() => journal.record(event({ targetId: credentialBearingUrl })), /target id is invalid/u);
  assert.throws(() => journal.record(event({
    targetId: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signaturevalue"
  })), /resembles a credential/u);
  assert.throws(() => journal.record(event({ code: "token=secret" })), /code is invalid/u);
  assert.throws(() => journal.record(event({ service: 123 })), /service is invalid/u);
  assert.throws(() => journal.record(event({ httpStatus: 999 })), /HTTP status/u);
  assert.throws(() => journal.record(event({ outcome: "stopped" })), /outcome is not supported/u);
  for (const field of ["message", "password", "token", "authorization", "cookie", "upstreamBody", "incidentId", "correlationId"]) {
    assert.throws(() => journal.record({ ...event(), [field]: "secret" }), new RegExp(`unsupported field: ${field}`, "u"));
  }

  const stored = await journal.record(event({
    level: "warn",
    category: "health",
    event: "health.incident_opened",
    outcome: "failed",
    service: "radarr",
    capability: "health",
    code: "HEALTH_WARNING",
    httpStatus: 503,
    targetType: "incident",
    targetId: "incident-1"
  }));
  assert.match(stored.id, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(stored, {
    schema: EVENT_JOURNAL_SCHEMA,
    id: stored.id,
    at: "2026-09-18T12:00:00.000Z",
    level: "warn",
    category: "health",
    event: "health.incident_opened",
    outcome: "failed",
    service: "radarr",
    capability: "health",
    code: "HEALTH_WARNING",
    targetType: "incident",
    targetId: "incident-1",
    httpStatus: 503
  });

  const [segment] = await segmentNames(dataDir);
  const persisted = await readFile(path.join(dataDir, "logs", segment), "utf8");
  assert.equal(persisted.includes("must-never-be-persisted"), false);
  assert.equal(persisted.includes("password"), false);
  assert.equal(persisted.includes("https://"), false);
  assert.deepEqual(JSON.parse(persisted.trim()), stored);
});

test("survives restart and queries newest-first with bounded filters and cursors", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  let clock = START;
  const first = await createEventJournal({ dataDir, now: () => clock, idFactory: ids() });
  await first.record(event());
  clock += 1_000;
  await first.record(event({
    level: "warn",
    category: "health",
    event: "health.incident_opened",
    outcome: "failed",
    service: "radarr",
    capability: "queue",
    code: "HTTP_ERROR",
    httpStatus: 503
  }));
  clock += 1_000;
  await first.record(event({
    category: "action",
    event: "action.completed",
    outcome: "succeeded",
    service: "radarr",
    operation: "blocklistAndSearch",
    targetType: "movie",
    targetId: "17"
  }));
  await first.close();

  const [existingName] = await segmentNames(dataDir);
  await chmod(path.join(dataDir, "logs", existingName), 0o666);

  const reopened = await createEventJournal({ dataDir, now: () => clock, idFactory: ids() });
  t.after(() => reopened.close());
  assert.equal((await stat(path.join(dataDir, "logs", existingName))).mode & 0o777, 0o600);
  const pageOne = await reopened.query({ limit: 2 });
  assert.deepEqual(pageOne.entries.map(({ event: name }) => name), [
    "action.completed",
    "health.incident_opened"
  ]);
  assert.equal(typeof pageOne.nextCursor, "string");
  const pageTwo = await reopened.query({ limit: 2, cursor: pageOne.nextCursor });
  assert.deepEqual(pageTwo.entries.map(({ event: name }) => name), ["application.started"]);
  assert.equal(pageTwo.nextCursor, null);

  const warnings = await reopened.query({ level: "warn", category: "health", service: "radarr" });
  assert.deepEqual(warnings.entries.map(({ code }) => code), ["HTTP_ERROR"]);
  const searched = await reopened.query({ q: "blocklistandsearch" });
  assert.deepEqual(searched.entries.map(({ targetId }) => targetId), ["17"]);
  const ranged = await reopened.query({
    from: "2026-09-18T12:00:01.000Z",
    to: "2026-09-18T12:00:02.000Z"
  });
  assert.equal(ranged.entries.length, 2);

  await assert.rejects(reopened.query({ cursor: "not-a-valid-cursor" }), /cursor is invalid/u);
  await assert.rejects(reopened.query({ limit: 201 }), /query limit/u);
  await assert.rejects(reopened.query({ unexpected: true }), /unsupported field/u);
  await assert.rejects(reopened.query({
    from: "2026-09-18T12:00:02.000Z",
    to: "2026-09-18T12:00:01.000Z"
  }), /must not be after/u);
});

test("keeps append and cursor order stable when the clock rolls back across UTC midnight", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  let clock = Date.parse("2026-09-19T00:00:01.000Z");
  const journal = await createEventJournal({ dataDir, now: () => clock, idFactory: ids() });
  t.after(() => journal.close());
  await journal.record(event({
    category: "action",
    event: "action.completed",
    outcome: "succeeded",
    operation: "restart",
    targetType: "container",
    targetId: "first"
  }));
  clock = Date.parse("2026-09-18T23:59:59.000Z");
  await journal.record(event({
    category: "action",
    event: "action.completed",
    outcome: "succeeded",
    operation: "restart",
    targetType: "container",
    targetId: "second"
  }));

  assert.deepEqual(await segmentNames(dataDir), ["helmsman-events-2026-09-19-0000.jsonl"]);
  const firstPage = await journal.query({ limit: 1 });
  assert.deepEqual(firstPage.entries.map(({ targetId }) => targetId), ["second"]);
  assert.equal(typeof firstPage.nextCursor, "string");
  const secondPage = await journal.query({ limit: 1, cursor: firstPage.nextCursor });
  assert.deepEqual(secondPage.entries.map(({ targetId }) => targetId), ["first"]);
  assert.equal(secondPage.nextCursor, null);
});

test("serializes concurrent writes, applies private modes, and close drains queued records", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  const writes = Array.from({ length: 20 }, (_, index) => journal.record(event({
    event: "action.completed",
    category: "action",
    outcome: "succeeded",
    operation: "restart",
    targetType: "container",
    targetId: String(index)
  })));
  const closing = journal.close();
  const results = await Promise.all(writes);
  await closing;
  assert.equal(results.every(Boolean), true);
  assert.equal(journal.status().closed, true);
  assert.equal(journal.status().writable, false);
  assert.throws(() => journal.record(event()), /closed/u);

  const directoryMode = (await stat(path.join(dataDir, "logs"))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  const names = await segmentNames(dataDir);
  assert.ok(names.length >= 1);
  for (const name of names) {
    assert.equal((await stat(path.join(dataDir, "logs", name))).mode & 0o777, 0o600);
  }

  const reopened = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => reopened.close());
  const queried = await reopened.query({ limit: 20 });
  assert.deepEqual(
    queried.entries.map(({ targetId }) => targetId),
    Array.from({ length: 20 }, (_, index) => String(19 - index))
  );
});

test("rotates bounded segments and prunes the oldest files to the total-byte limit", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const journal = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    maximumEventBytes: 320,
    maximumSegmentBytes: 640,
    maximumBytes: 1_280
  });
  t.after(() => journal.close());
  for (let index = 0; index < 18; index += 1) {
    assert.ok(await journal.record(event({
      category: "action",
      event: "action.completed",
      outcome: "succeeded",
      operation: "restart",
      targetType: "container",
      targetId: String(index)
    })));
  }
  const names = await segmentNames(dataDir);
  assert.ok(names.length >= 1);
  assert.ok(names.length < 9, "old segments were not pruned");
  let total = 0;
  for (const name of names) {
    const size = (await stat(path.join(dataDir, "logs", name))).size;
    assert.ok(size <= 640);
    total += size;
  }
  assert.ok(total <= 1_280);
  assert.equal(journal.status().totalBytes, total);
  const latest = await journal.query({ limit: 18 });
  assert.equal(latest.entries[0].targetId, "17");
  assert.ok(latest.entries.length < 18);
});

test("prunes segments older than the configured retention window", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const first = await createEventJournal({ dataDir, now: () => START, idFactory: ids(), retentionDays: 1 });
  await first.record(event());
  await first.close();
  const [name] = await segmentNames(dataDir);
  const old = new Date(START - 2 * 24 * 60 * 60 * 1_000);
  await utimes(path.join(dataDir, "logs", name), old, old);

  const reopened = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    retentionDays: 1
  });
  t.after(() => reopened.close());
  assert.deepEqual(await segmentNames(dataDir), []);
  assert.equal((await reopened.query()).entries.length, 0);
  assert.equal(reopened.status().totalBytes, 0);
});

test("keeps valid records around a truncated final line and continues in a new segment", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const first = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  await first.record(event({ event: "application.ready", outcome: "succeeded" }));
  await first.close();
  const [damagedName] = await segmentNames(dataDir);
  await appendFile(path.join(dataDir, "logs", damagedName), "{\"schema\":1", "utf8");

  const reopened = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => reopened.close());
  assert.equal(reopened.status().state, "degraded");
  assert.ok(reopened.status().issueCodes.includes("LOG_SEGMENT_TRUNCATED"));
  assert.deepEqual((await reopened.query()).entries.map(({ event: name }) => name), ["application.ready"]);
  assert.ok(await reopened.record(event({ event: "application.recovered", outcome: "recovered" })));
  assert.equal((await segmentNames(dataDir)).length, 2);
  assert.deepEqual((await reopened.query()).entries.map(({ event: name }) => name), [
    "application.recovered",
    "application.ready"
  ]);
});

test("skips malformed complete records, reports degradation, and preserves valid history", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const first = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  await first.record(event({ event: "application.ready", outcome: "succeeded" }));
  await first.close();
  const [damagedName] = await segmentNames(dataDir);
  await appendFile(path.join(dataDir, "logs", damagedName), "{\"schema\":1}\n", "utf8");

  const reopened = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => reopened.close());
  assert.ok(reopened.status().issueCodes.includes("LOG_SEGMENT_MALFORMED"));
  assert.deepEqual((await reopened.query()).entries.map(({ event: name }) => name), ["application.ready"]);
  assert.ok(await reopened.record(event({ event: "application.recovered", outcome: "recovered" })));
  assert.equal((await segmentNames(dataDir)).length, 2);
});

test("requires stored timestamps and never appends behind a newer damaged segment", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const first = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  await first.record(event({ event: "application.ready", outcome: "succeeded" }));
  await first.close();

  const logsDir = path.join(dataDir, "logs");
  const missingTimestamp = {
    schema: EVENT_JOURNAL_SCHEMA,
    id: "00000000-0000-4000-8000-000000000099",
    level: "warn",
    category: "security",
    event: "security.invalid_record",
    outcome: "failed"
  };
  await writeFile(
    path.join(logsDir, "helmsman-events-2026-09-18-0001.jsonl"),
    `${JSON.stringify(missingTimestamp)}\n`,
    { mode: 0o600 }
  );

  const reopened = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => reopened.close());
  assert.ok(reopened.status().issueCodes.includes("LOG_SEGMENT_MALFORMED"));
  assert.deepEqual((await reopened.query()).entries.map(({ event: name }) => name), ["application.ready"]);
  assert.ok(await reopened.record(event({ event: "application.recovered", outcome: "recovered" })));
  assert.deepEqual(await segmentNames(dataDir), [
    "helmsman-events-2026-09-18-0000.jsonl",
    "helmsman-events-2026-09-18-0001.jsonl",
    "helmsman-events-2026-09-18-0002.jsonl"
  ]);
  assert.deepEqual((await reopened.query()).entries.map(({ event: name }) => name), [
    "application.recovered",
    "application.ready"
  ]);
});

test("reports success once an event is durable even if post-write maintenance degrades", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  let guardCalls = 0;
  const journal = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    guard: async () => {
      guardCalls += 1;
      if (guardCalls === 4) throw new Error("post-write maintenance unavailable");
    }
  });
  t.after(() => journal.close());
  const stored = await journal.record(event());
  assert.ok(stored);
  assert.equal(guardCalls, 4);
  assert.equal(journal.status().state, "degraded");
  assert.equal(journal.status().writable, true);
  assert.ok(journal.status().issueCodes.includes("LOG_RETENTION_FAILED"));
  assert.equal((await journal.query()).entries.length, 1);
});

test("accounts for oversized named segments and prunes them from the total-byte budget", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const logsDir = path.join(dataDir, "logs");
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const oversizedName = "helmsman-events-2026-09-18-0000.jsonl";
  await writeFile(path.join(logsDir, oversizedName), "x".repeat(400), { mode: 0o600 });

  const journal = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    maximumEventBytes: 256,
    maximumSegmentBytes: 256,
    maximumBytes: 512
  });
  t.after(() => journal.close());
  assert.ok(journal.status().issueCodes.includes("LOG_SEGMENT_OVERSIZE"));
  assert.equal(journal.status().totalBytes, 400);
  assert.ok(await journal.record(event()));
  assert.equal((await segmentNames(dataDir)).includes(oversizedName), false);
  assert.ok(journal.status().totalBytes <= 512);
  assert.equal((await journal.query()).entries.length, 1);
});

test("fails closed when the log directory exceeds its entry bound", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const logsDir = path.join(dataDir, "logs");
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const names = Array.from({ length: 4_097 }, (_, index) => `noise-${String(index).padStart(4, "0")}`);
  for (let offset = 0; offset < names.length; offset += 128) {
    await Promise.all(names.slice(offset, offset + 128).map((name) => (
      writeFile(path.join(logsDir, name), "", { mode: 0o600 })
    )));
  }

  const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  t.after(() => journal.close());
  assert.equal(journal.status().state, "degraded");
  assert.equal(journal.status().writable, false);
  assert.ok(journal.status().issueCodes.includes("LOG_DIRECTORY_ENTRY_LIMIT"));
  assert.equal(await journal.record(event()), null);
});

test("refuses unsafe logging paths and never follows segment symlinks or nonregular collisions", async (t) => {
  await t.test("logging-directory symlink", async (subtest) => {
    const { root, dataDir } = await temporaryDataDirectory(subtest, "helmsman-logdir-symlink-");
    const outside = path.join(root, "outside");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(outside, "helmsman-events-2026-09-18-0000.jsonl"),
      `${JSON.stringify({
        schema: 1,
        id: "00000000-0000-4000-8000-000000000099",
        at: "2026-09-18T12:00:00.000Z",
        level: "info",
        category: "security",
        event: "outside.injected",
        outcome: "succeeded"
      })}\n`,
      { mode: 0o600 }
    );
    await symlink(outside, path.join(dataDir, "logs"));
    const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
    subtest.after(() => journal.close());
    assert.equal(journal.status().writable, false);
    assert.ok(journal.status().issueCodes.includes("LOG_DIRECTORY_UNSAFE"));
    assert.equal(await journal.record(event()), null);
    assert.deepEqual((await journal.query()).entries, []);
    assert.deepEqual(await readdir(outside), ["helmsman-events-2026-09-18-0000.jsonl"]);
  });

  await t.test("segment symlink and directory collision", async (subtest) => {
    const { root, dataDir } = await temporaryDataDirectory(subtest, "helmsman-segment-symlink-");
    const logsDir = path.join(dataDir, "logs");
    const outside = path.join(root, "outside.txt");
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await writeFile(outside, "sentinel\n", { mode: 0o600 });
    await symlink(outside, path.join(logsDir, "helmsman-events-2026-09-18-0000.jsonl"));
    await mkdir(path.join(logsDir, "helmsman-events-2026-09-18-0001.jsonl"));
    const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
    subtest.after(() => journal.close());
    assert.ok(journal.status().issueCodes.includes("LOG_SEGMENT_UNSAFE"));
    assert.ok(await journal.record(event()));
    assert.equal(await readFile(outside, "utf8"), "sentinel\n");
    assert.ok((await segmentNames(dataDir)).includes("helmsman-events-2026-09-18-0002.jsonl"));
  });

  await t.test("hard-linked segment", async (subtest) => {
    const { root, dataDir } = await temporaryDataDirectory(subtest, "helmsman-segment-hardlink-");
    const logsDir = path.join(dataDir, "logs");
    const outside = path.join(root, "outside.jsonl");
    const outsideContents = `${JSON.stringify({
      schema: EVENT_JOURNAL_SCHEMA,
      id: "00000000-0000-4000-8000-000000000099",
      at: "2026-09-18T12:00:00.000Z",
      level: "info",
      category: "security",
      event: "outside.injected",
      outcome: "succeeded"
    })}\n`;
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    await writeFile(outside, outsideContents, { mode: 0o600 });
    await link(outside, path.join(logsDir, "helmsman-events-2026-09-18-0000.jsonl"));

    const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
    subtest.after(() => journal.close());
    assert.ok(journal.status().issueCodes.includes("LOG_SEGMENT_UNSAFE"));
    assert.deepEqual((await journal.query()).entries, []);
    assert.ok(await journal.record(event()));
    assert.equal(await readFile(outside, "utf8"), outsideContents);
    assert.ok((await segmentNames(dataDir)).includes("helmsman-events-2026-09-18-0001.jsonl"));
  });
});

test("isolates guard and write failures while exposing a bounded degraded status", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  let guardCalls = 0;
  const journal = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    guard: async () => {
      guardCalls += 1;
      if (guardCalls > 2) throw new Error("sensitive guard detail must not escape");
    }
  });
  t.after(() => journal.close());
  assert.equal(await journal.record(event()), null);
  const status = journal.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.writable, false);
  assert.deepEqual(status.issueCodes, ["LOG_WRITE_FAILED"]);
  assert.equal(JSON.stringify(status).includes("sensitive guard detail"), false);
});

test("isolates an active-segment I/O replacement without leaking or rejecting close", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const journal = await createEventJournal({ dataDir, now: () => START, idFactory: ids() });
  await journal.record(event({ event: "application.ready", outcome: "succeeded" }));
  const [name] = await segmentNames(dataDir);
  const segmentPath = path.join(dataDir, "logs", name);
  const original = await readFile(segmentPath);
  const replacementPath = path.join(dataDir, "logs", "replacement.tmp");
  await writeFile(replacementPath, original, { mode: 0o600 });
  await rename(replacementPath, segmentPath);

  assert.equal(await journal.record(event({ event: "application.changed", outcome: "changed" })), null);
  const status = journal.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.writable, false);
  assert.ok(status.issueCodes.includes("LOG_WRITE_FAILED"));
  assert.equal(JSON.stringify(status).includes(segmentPath), false);
  await journal.close();
  assert.equal(journal.status().closed, true);
});

test("enforces the event byte bound before touching persistent storage", async (t) => {
  const { dataDir } = await temporaryDataDirectory(t);
  const journal = await createEventJournal({
    dataDir,
    now: () => START,
    idFactory: ids(),
    maximumEventBytes: 256,
    maximumSegmentBytes: 512,
    maximumBytes: 1_024
  });
  t.after(() => journal.close());
  assert.throws(() => journal.record(event({
    service: "s".repeat(96),
    capability: "c".repeat(96),
    operation: "o".repeat(96),
    targetType: "t".repeat(96),
    targetId: "i".repeat(128)
  })), /size limit/u);
  assert.deepEqual(await segmentNames(dataDir), []);
});
