// Saved agent conversations, for reviewing answers and building training
// data for the owner's own model.
//
// Each record is one full exchange with the model: the system prompt, the
// conversation, every tool call and tool result, the final answer, the tool
// definitions the model was offered, the model name and timing. That is the
// exact shape fine-tuning needs. Free text is scrubbed of anything that looks
// like a secret before it is written (see log-redaction.mjs).
//
// The owner can rate an answer (up or down) and write the answer it should
// have given. The export keeps only good or corrected answers by default, so
// a bad answer is never trained in.
//
// Storage: one JSON Lines file per day under <dataDir>/agent-conversations,
// plus ratings.json. Kept for 90 days and at most 100 MB; oldest days go
// first. Off unless the owner turns it on.

import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { redactLogText } from "./log-redaction.mjs";

export const CONVERSATION_LIMITS = Object.freeze({
  retentionDays: 90,
  maximumBytes: 100 * 1024 * 1024,
  maximumRecordBytes: 96 * 1024,
  maximumRatings: 50_000,
  maximumCorrectionChars: 4_000,
  maximumList: 100,
  // Only list({ selfTest: "only" }) may return this many, so a whole
  // self-test batch can be reviewed.
  maximumSelfTestList: 2_000,
  maximumExport: 20_000
});

const DIRECTORY = "agent-conversations";
const RATINGS_FILE = "ratings.json";
const SEGMENT = /^conversations-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SOURCES = new Set(["question", "incident", "recovery", "digest", "checkIn", "note"]);
const ROLES = new Set(["system", "user", "assistant", "tool"]);
const DAY = 86_400_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scrub(text, max) {
  return redactLogText(typeof text === "string" ? text : "", max, { multiline: true });
}

// A message as fine-tuning expects it, scrubbed and bounded.
function cleanMessage(message) {
  if (!isPlainObject(message) || !ROLES.has(message.role)) return null;
  const clean = { role: message.role, content: scrub(message.content, message.role === "system" ? 12_000 : 8_000) };
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    clean.tool_calls = message.tool_calls.slice(0, 8).filter(isPlainObject).map((call, index) => ({
      id: typeof call.id === "string" ? call.id.slice(0, 64) : `call-${index + 1}`,
      type: "function",
      function: {
        name: typeof call.function?.name === "string" ? call.function.name.slice(0, 64) : "unknown",
        arguments: scrub(typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}), 2_000)
      }
    }));
  }
  if (message.role === "tool") clean.tool_call_id = typeof message.tool_call_id === "string" ? message.tool_call_id.slice(0, 64) : "call";
  return clean;
}

// The self-test marker: {id, category}, both non-empty strings capped at 64
// characters. Anything else is ignored.
function cleanSelfTest(value) {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.category !== "string") return null;
  const id = value.id.slice(0, 64);
  const category = value.category.slice(0, 64);
  return id && category ? { id, category } : null;
}

function dayOf(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/**
 * dataDir: absolute path. clock(): milliseconds. guard(): resolves when it is
 * safe to write (the data-directory lock).
 */
export async function createConversationStore({ dataDir, clock = Date.now, guard = async () => {}, idFactory = randomUUID, limits = {} }) {
  const bounds = { ...CONVERSATION_LIMITS, ...limits };
  const directory = path.join(dataDir, DIRECTORY);
  const ratingsPath = path.join(directory, RATINGS_FILE);
  let ratings = new Map();
  let writeChain = Promise.resolve();
  let lastPruneAt = 0;

  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
  }

  async function loadRatings() {
    try {
      const handle = await open(ratingsPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        const text = await handle.readFile("utf8");
        const parsed = JSON.parse(text);
        ratings = new Map(Object.entries(isPlainObject(parsed) ? parsed : {})
          .filter(([id, entry]) => UUID.test(id) && isPlainObject(entry))
          .slice(-bounds.maximumRatings));
      } finally {
        await handle.close();
      }
    } catch {
      ratings = new Map();
    }
  }

  async function saveRatings() {
    await ensureDirectory();
    const temporary = path.join(directory, `.ratings-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(Object.fromEntries(ratings))}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, ratingsPath);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function segments() {
    let names = [];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names.filter((candidate) => SEGMENT.test(candidate)).sort()) {
      try {
        const metadata = await stat(path.join(directory, name));
        if (metadata.isFile()) found.push({ name, day: SEGMENT.exec(name)[1], bytes: metadata.size });
      } catch {
        // A file removed while listing is skipped.
      }
    }
    return found;
  }

  async function readSegment(name) {
    let text = "";
    try {
      const handle = await open(path.join(directory, name), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    const records = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (isPlainObject(record) && UUID.test(record.id) && Array.isArray(record.messages)) records.push(record);
      } catch {
        // A damaged line is skipped; the rest of the day stays readable.
      }
    }
    return records;
  }

  // Oldest days go first once they are past the retention or the size cap.
  async function prune() {
    const now = clock();
    if (now - lastPruneAt < 60 * 60 * 1_000) return;
    lastPruneAt = now;
    const list = await segments();
    const cutoff = dayOf(now - bounds.retentionDays * DAY);
    let total = list.reduce((sum, { bytes }) => sum + bytes, 0);
    const removed = new Set();
    for (const segment of list) {
      if (segment.day >= cutoff && total <= bounds.maximumBytes) break;
      // Read the day before deleting it, so its ratings go with it.
      for (const record of await readSegment(segment.name).catch(() => [])) removed.add(record.id);
      await unlink(path.join(directory, segment.name)).catch(() => {});
      total -= segment.bytes;
    }
    if (removed.size) {
      for (const id of removed) ratings.delete(id);
      await saveRatings().catch(() => {});
    }
  }

  function serialized(task) {
    const next = writeChain.catch(() => {}).then(task);
    writeChain = next.catch(() => {});
    return next;
  }

  /**
   * Saves one exchange. `messages` ends with the model's final answer.
   * Returns the new conversation id, or null when nothing was saved.
   */
  function record({ source, model, messages, tools = [], durationMs = null, service = null, selfTest = undefined }) {
    return serialized(async () => {
      if (!SOURCES.has(source) || !Array.isArray(messages)) return null;
      const clean = messages.map(cleanMessage).filter(Boolean);
      if (clean.length < 2 || clean.at(-1).role !== "assistant" || !clean.at(-1).content) return null;
      const id = String(idFactory());
      const at = clock();
      const marker = cleanSelfTest(selfTest);
      const entry = {
        id,
        at: new Date(at).toISOString(),
        source,
        ...(marker ? { selfTest: marker } : {}),
        ...(typeof service === "string" && service ? { service: service.slice(0, 96) } : {}),
        model: typeof model === "string" ? model.slice(0, 128) : null,
        durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
        tools: Array.isArray(tools) ? tools.slice(0, 32) : [],
        messages: clean
      };
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > bounds.maximumRecordBytes) return null;
      await guard();
      await ensureDirectory();
      const file = path.join(directory, `conversations-${dayOf(at)}.jsonl`);
      const handle = await open(file, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
      try {
        await handle.writeFile(line, "utf8");
      } finally {
        await handle.close();
      }
      await prune().catch(() => {});
      return id;
    });
  }

  function summary(entry) {
    const lastUser = [...entry.messages].reverse().find((message) => message.role === "user");
    const answer = entry.messages.at(-1)?.content || "";
    const rating = ratings.get(entry.id) || null;
    return {
      id: entry.id,
      at: entry.at,
      source: entry.source,
      service: entry.service || null,
      model: entry.model,
      durationMs: entry.durationMs,
      selfTest: cleanSelfTest(entry.selfTest),
      question: lastUser?.content || "",
      answer,
      toolsUsed: [...new Set(entry.messages.flatMap((message) => (message.tool_calls || []).map((call) => call.function.name)))],
      rating: rating?.rating || null,
      correction: rating?.correction || null
    };
  }

  /** The newest conversations first, as summaries. */
  async function list({ limit = 50, source = null, selfTest = undefined } = {}) {
    const ceiling = selfTest === "only" ? bounds.maximumSelfTestList : bounds.maximumList;
    const wanted = Math.min(ceiling, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
    const results = [];
    for (const segment of (await segments()).reverse()) {
      const records = (await readSegment(segment.name)).reverse();
      for (const entry of records) {
        if (source === "question" ? entry.source !== "question" : source === "reports" ? entry.source === "question" : false) continue;
        if (selfTest === "exclude" ? entry.selfTest : selfTest === "only" ? !entry.selfTest : false) continue;
        results.push(summary(entry));
        if (results.length >= wanted) return results;
      }
    }
    return results;
  }

  async function find(id) {
    for (const segment of (await segments()).reverse()) {
      const entry = (await readSegment(segment.name)).find((candidate) => candidate.id === id);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * Rates one answer: rating "up", "down" or null, and optionally the answer
   * it should have given (null removes a correction).
   */
  function rate(id, { rating = undefined, correction = undefined } = {}) {
    return serialized(async () => {
      if (!UUID.test(String(id))) return null;
      const entry = await find(id);
      if (!entry) return null;
      const current = ratings.get(id) || {};
      const next = { ...current };
      if (rating !== undefined) {
        if (rating === null) delete next.rating;
        else if (rating === "up" || rating === "down") next.rating = rating;
      }
      if (correction !== undefined) {
        const text = correction === null ? "" : scrub(correction, bounds.maximumCorrectionChars);
        if (text) {
          next.correction = text;
          next.rating = next.rating || "up";
        } else delete next.correction;
      }
      next.ratedAt = new Date(clock()).toISOString();
      if (!next.rating && !next.correction) ratings.delete(id);
      else ratings.set(id, next);
      while (ratings.size > bounds.maximumRatings) ratings.delete(ratings.keys().next().value);
      await guard();
      await saveRatings();
      return summary(entry);
    });
  }

  /**
   * Training data as JSON Lines, one {"messages", "tools"} per line, oldest
   * first. "rated": only answers rated up or corrected. "all": everything
   * except answers rated down without a correction. A correction replaces
   * the model's answer.
   */
  async function exportTraining({ include = "rated" } = {}) {
    const lines = [];
    let count = 0;
    for (const segment of await segments()) {
      for (const entry of await readSegment(segment.name)) {
        const rating = ratings.get(entry.id);
        const keep = rating?.correction
          || rating?.rating === "up"
          || (include === "all" && rating?.rating !== "down");
        if (!keep) continue;
        const messages = entry.messages.map((message) => ({ ...message }));
        if (rating?.correction) messages[messages.length - 1] = { role: "assistant", content: rating.correction };
        lines.push(JSON.stringify({ messages, tools: entry.tools }));
        count += 1;
        if (count >= bounds.maximumExport) return { text: `${lines.join("\n")}\n`, count };
      }
    }
    return { text: lines.length ? `${lines.join("\n")}\n` : "", count };
  }

  /** Counts for Settings. */
  async function status() {
    const list = await segments();
    let conversations = 0;
    for (const segment of list) conversations += (await readSegment(segment.name)).length;
    const values = [...ratings.values()];
    return {
      conversations,
      bytes: list.reduce((sum, { bytes }) => sum + bytes, 0),
      oldest: list[0]?.day || null,
      ratedUp: values.filter((entry) => entry.rating === "up" && !entry.correction).length,
      ratedDown: values.filter((entry) => entry.rating === "down" && !entry.correction).length,
      corrected: values.filter((entry) => entry.correction).length,
      retentionDays: bounds.retentionDays,
      maximumBytes: bounds.maximumBytes
    };
  }

  /** Deletes every saved conversation and rating. */
  function clear() {
    return serialized(async () => {
      await guard();
      for (const segment of await segments()) await unlink(path.join(directory, segment.name)).catch(() => {});
      ratings = new Map();
      await unlink(ratingsPath).catch(() => {});
    });
  }

  await loadRatings();
  return { record, list, find, rate, exportTraining, status, clear };
}
