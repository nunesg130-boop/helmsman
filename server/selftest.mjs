import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { generateQuestions } from "./selftest-questions.mjs";

// Self-test runner: asks the agent generated questions about the owner's own
// lab, one at a time, so the owner can rate the answers for training.
//
// The queue and the ids already asked live in selftest.json beside
// state.json. The file holds questions and counts only: answers stay in the
// conversation store, linked by each conversation's `selfTest.id`, and the
// review list reads them from there. No credentials are ever written here.

const FILE_NAME = "selftest.json";
const FILE_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ASKED = 20_000;
const MAX_FAILURES = 1_000;
const MAX_COUNT = 500;
const DEFAULT_COUNT = 50;
const PAGE_SIZE = 25;
const FAILURES_IN_A_ROW = 3;
// The hourly question limit frees a slot as the oldest question ages out, so
// a busy agent is retried every minute rather than hammered.
const BUSY_WAIT_MS = 60_000;
// The conversation store caps a list at its own maximum; ask for everything.
const REVIEW_SCAN = 20_000;
const FILTERS = new Set(["unrated", "all", "changed", "failed"]);
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const CODE = /^[A-Z0-9_]{1,64}$/u;

export const SELFTEST_LIMITS = Object.freeze({ count: { min: 1, max: MAX_COUNT, default: DEFAULT_COUNT }, asked: MAX_ASKED, pageSize: PAGE_SIZE });

export class SelfTestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SelfTestError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? value : null;
}

const shortText = (value, max) => (typeof value === "string" && value && value.length <= max ? value : null);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function cleanQuestion(value) {
  if (!isPlainObject(value) || typeof value.id !== "string" || !ID.test(value.id)) return null;
  const category = shortText(value.category, 64);
  const text = shortText(value.text, 1000);
  if (!category || !text || typeof value.followUp !== "boolean") return null;
  return { id: value.id, category, text, followUp: value.followUp };
}

function cleanFailure(value) {
  const question = cleanQuestion({ ...(isPlainObject(value) ? value : {}), followUp: false });
  if (!question || typeof value.code !== "string" || !CODE.test(value.code)) return null;
  return { id: question.id, category: question.category, text: question.text, code: value.code, at: canonicalTimestamp(value.at) };
}

function cleanCounts(value) {
  const source = isPlainObject(value) ? value : {};
  const categories = {};
  if (isPlainObject(source.categories)) {
    for (const [name, entry] of Object.entries(source.categories)) {
      if (name.length > 64 || !isPlainObject(entry)) continue;
      categories[name] = { done: count(entry.done), failed: count(entry.failed) };
    }
  }
  return { done: count(source.done), failed: count(source.failed), categories };
}

function emptyState() {
  return {
    asked: [],
    queue: [],
    current: null,
    currentAt: null,
    previous: null,
    startedAt: null,
    counts: cleanCounts(null),
    failures: [],
    revision: null,
    updatedAt: null
  };
}

/** The loaded document in its trusted form, or null when it cannot be used. */
function cleanState(loaded) {
  if (!isPlainObject(loaded) || loaded.version !== FILE_VERSION) return null;
  if (!Array.isArray(loaded.asked) || !Array.isArray(loaded.queue)) return null;
  if (typeof loaded.revision !== "string" || !REVISION.test(loaded.revision)) return null;
  const queue = loaded.queue.map(cleanQuestion);
  if (queue.some((question) => !question)) return null;
  const asked = loaded.asked.filter((id) => typeof id === "string" && ID.test(id)).slice(-MAX_ASKED);
  const current = typeof loaded.current === "string" && queue[0]?.id === loaded.current ? loaded.current : null;
  const previous = isPlainObject(loaded.previous) && typeof loaded.previous.id === "string" && ID.test(loaded.previous.id)
    ? { id: loaded.previous.id, failed: loaded.previous.failed === true }
    : null;
  return {
    asked,
    queue,
    current,
    currentAt: current ? canonicalTimestamp(loaded.currentAt) : null,
    previous,
    startedAt: canonicalTimestamp(loaded.startedAt),
    counts: cleanCounts(loaded.counts),
    failures: (Array.isArray(loaded.failures) ? loaded.failures : []).map(cleanFailure).filter(Boolean).slice(-MAX_FAILURES),
    revision: loaded.revision,
    updatedAt: canonicalTimestamp(loaded.updatedAt)
  };
}

async function readFileSafely(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function atomicWrite(dataDir, filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new SelfTestError(500, "SELFTEST_STATE_TOO_LARGE", "The self-test state exceeded its size limit.");
  const temporary = path.join(dataDir, `.selftest-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error) {
  return typeof error?.code === "string" && CODE.test(error.code) ? error.code : "MODEL_REQUEST_FAILED";
}

/**
 * dataDir: absolute path. askSelfTest({ question, history, selfTest }): the
 * agent's read-only ask path. snapshot: the monitor snapshot, or a function
 * returning it. conversationStore: list({ selfTest: "only" }) for review.
 * conversationsKept(): whether "Keep conversations for training" is on.
 * sleep(ms): waits while the agent is busy (injectable for tests).
 */
export async function createSelfTest(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The self-test requires an absolute data directory.");
  }
  if (typeof options.askSelfTest !== "function") throw new Error("The self-test requires askSelfTest.");
  const askSelfTest = options.askSelfTest;
  const readSnapshot = typeof options.snapshot === "function" ? options.snapshot : () => options.snapshot;
  const conversationStore = options.conversationStore;
  const conversationsKept = typeof options.conversationsKept === "function" ? options.conversationsKept : () => false;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const seed = typeof options.seed === "function" ? options.seed : () => Date.now();
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const filePath = path.join(dataDir, FILE_NAME);
  const now = () => new Date(Math.trunc(Number(clock()))).toISOString();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let state = cleanState(await readFileSafely(filePath)) || emptyState();

  let running = false;
  let stopping = false;
  let loop = null;
  let wake = null;
  // A run left with questions queued by an earlier process waits for Continue.
  let reason = state.queue.length ? "restart" : null;
  // Set when the question in flight may already have been answered before a restart.
  let checkInterrupted = Boolean(state.current);
  // The last answered exchange, for a follow-up's history.
  let lastExchange = null;

  /**
   * Writes the state when the file on disk still has the revision this
   * process last read or wrote, so nothing else's write is overwritten.
   */
  async function persist() {
    const expectedRevision = state.revision;
    await guard();
    const onDisk = await readFileSafely(filePath);
    const diskRevision = isPlainObject(onDisk) && typeof onDisk.revision === "string" ? onDisk.revision : null;
    if (diskRevision !== expectedRevision) {
      throw new SelfTestError(409, "SELFTEST_CONFLICT", "The self-test state changed on disk.");
    }
    const next = { ...state, revision: randomUUID(), updatedAt: now() };
    await atomicWrite(dataDir, filePath, {
      version: FILE_VERSION,
      asked: next.asked,
      queue: next.queue,
      current: next.current,
      currentAt: next.currentAt,
      previous: next.previous,
      startedAt: next.startedAt,
      counts: next.counts,
      failures: next.failures,
      revision: next.revision,
      updatedAt: next.updatedAt
    });
    state = next;
  }

  async function selfTestConversations() {
    if (!conversationStore || typeof conversationStore.list !== "function") return [];
    const items = await conversationStore.list({ selfTest: "only", limit: REVIEW_SCAN });
    return items.filter((item) => item?.selfTest?.id);
  }

  function categoryCounts(category) {
    const entry = state.counts.categories[category] || { done: 0, failed: 0 };
    state.counts.categories[category] = entry;
    return entry;
  }

  function addAsked(id) {
    state.asked.push(id);
    if (state.asked.length > MAX_ASKED) state.asked.splice(0, state.asked.length - MAX_ASKED);
  }

  async function markDone(question, answer) {
    state.queue.shift();
    addAsked(question.id);
    state.counts.done += 1;
    categoryCounts(question.category).done += 1;
    state.previous = { id: question.id, failed: false };
    state.current = null;
    state.currentAt = null;
    lastExchange = { id: question.id, question: question.text, answer };
    await persist();
  }

  async function markFailed(question, code) {
    state.queue.shift();
    addAsked(question.id);
    state.counts.failed += 1;
    categoryCounts(question.category).failed += 1;
    state.failures.push({ id: question.id, category: question.category, text: question.text, code, at: now() });
    if (state.failures.length > MAX_FAILURES) state.failures.splice(0, state.failures.length - MAX_FAILURES);
    state.previous = { id: question.id, failed: true };
    state.current = null;
    state.currentAt = null;
    lastExchange = null;
    await persist();
  }

  /** The base question and its answer, as the history a follow-up is asked with. */
  async function followUpHistory() {
    const previousId = state.previous?.id;
    if (!previousId) return [];
    let exchange = lastExchange?.id === previousId ? lastExchange : null;
    if (!exchange) {
      const saved = (await selfTestConversations()).find((item) => item.selfTest.id === previousId);
      if (saved) exchange = { question: saved.question, answer: saved.answer };
    }
    if (!exchange?.question || !exchange?.answer) return [];
    return [{ role: "user", content: exchange.question }, { role: "assistant", content: exchange.answer }];
  }

  /** A conversation saved for the interrupted question after it was sent, if any. */
  async function savedAfterInterruption(question) {
    const since = state.currentAt ? Date.parse(state.currentAt) : Number.NaN;
    if (!Number.isFinite(since)) return null;
    return (await selfTestConversations()).find((item) => item.selfTest.id === question.id && Date.parse(item.at) >= since) || null;
  }

  async function pause(milliseconds) {
    await Promise.race([Promise.resolve().then(() => sleep(milliseconds)), new Promise((resolve) => { wake = resolve; })]);
    wake = null;
  }

  async function step(failuresInRow) {
    const question = state.queue[0];
    if (!conversationsKept()) {
      reason = "Keep conversations for training is off, so there would be nothing to review. Turn it on under Settings → Agent, then press Continue.";
      return { stop: true };
    }
    if (checkInterrupted) {
      checkInterrupted = false;
      const saved = state.current === question.id ? await savedAfterInterruption(question) : null;
      if (saved) {
        await markDone(question, saved.answer);
        return { failuresInRow: 0 };
      }
    }
    let history = [];
    if (question.followUp) {
      if (state.previous?.failed) {
        // A follow-up means nothing without its base question's answer.
        await markFailed(question, "SELFTEST_BASE_FAILED");
        return { failuresInRow };
      }
      history = await followUpHistory();
    }
    if (state.current !== question.id) {
      state.current = question.id;
      state.currentAt = now();
      await persist();
    }
    let result;
    try {
      result = await askSelfTest({ question: question.text, history, selfTest: { id: question.id, category: question.category } });
    } catch (error) {
      const code = errorCode(error);
      if (code === "AGENT_BUSY") {
        await pause(BUSY_WAIT_MS);
        return { failuresInRow };
      }
      if (code === "AI_NOT_CONFIGURED") {
        reason = "No model server is connected. Connect one under Settings → Agent → Model server, then press Continue.";
        return { stop: true };
      }
      await markFailed(question, code);
      if (failuresInRow + 1 >= FAILURES_IN_A_ROW) {
        reason = `The model server failed ${FAILURES_IN_A_ROW} questions in a row (${code}). Check it under Settings → Agent → Model server, then press Continue.`;
        return { stop: true };
      }
      return { failuresInRow: failuresInRow + 1 };
    }
    if (!result?.conversationId || typeof result.answer !== "string") {
      // Nothing was saved to review (no answer, or keeping was turned off).
      await markFailed(question, "SELFTEST_NOT_SAVED");
      return { failuresInRow };
    }
    await markDone(question, result.answer);
    return { failuresInRow: 0 };
  }

  async function runLoop() {
    let failuresInRow = 0;
    try {
      while (!stopping && state.queue.length) {
        const outcome = await step(failuresInRow);
        if (outcome.stop) return;
        failuresInRow = outcome.failuresInRow;
      }
      if (stopping && state.queue.length) reason = "stopped";
    } catch (error) {
      reason = `The self-test could not save its progress (${errorCode(error)}).`;
    } finally {
      running = false;
      stopping = false;
      loop = null;
    }
  }

  function begin() {
    running = true;
    stopping = false;
    reason = null;
    loop = runLoop();
  }

  function requireIdle() {
    if (running) throw new SelfTestError(409, "SELFTEST_RUNNING", "A self-test batch is already running.");
  }

  function requireKept() {
    if (!conversationsKept()) {
      throw new SelfTestError(409, "SELFTEST_KEEP_OFF", "Turn on \"Keep conversations for training\" first, or there will be nothing to review.");
    }
  }

  async function status() {
    const conversations = await selfTestConversations().catch(() => []);
    const categories = {};
    for (const [name, entry] of Object.entries(state.counts.categories)) categories[name] = { queued: 0, done: entry.done, failed: entry.failed };
    for (const question of state.queue) {
      categories[question.category] ||= { queued: 0, done: 0, failed: 0 };
      categories[question.category].queued += 1;
    }
    return {
      running,
      paused: !running && state.queue.length > 0,
      reason,
      queued: state.queue.length,
      done: state.counts.done,
      failed: state.counts.failed,
      unrated: conversations.filter((item) => !item.rating && !item.correction).length,
      categories,
      asked: state.asked.length
    };
  }

  return {
    /** Starts a new batch of `count` questions (1 to 500, default 50). */
    async start({ count: wanted = DEFAULT_COUNT } = {}) {
      if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > MAX_COUNT) {
        throw new SelfTestError(400, "SELFTEST_BAD_COUNT", `Choose between 1 and ${MAX_COUNT} questions.`);
      }
      requireIdle();
      requireKept();
      const snapshot = readSnapshot();
      if (!snapshot || generateQuestions(snapshot, { seed: 1, count: 1 }).length === 0) {
        throw new SelfTestError(409, "SELFTEST_NO_INVENTORY", "Helmsman has no inventory yet.");
      }
      const questions = generateQuestions(snapshot, { seed: seed(), count: wanted, exclude: new Set(state.asked) });
      if (!questions.length) {
        throw new SelfTestError(409, "SELFTEST_NO_INVENTORY", "Every question Helmsman can make from the inventory has been asked.");
      }
      // Starting replaces whatever was left of an earlier batch; those
      // questions were never asked, so a later batch can still pick them.
      state.queue = questions;
      state.current = null;
      state.currentAt = null;
      state.previous = null;
      state.startedAt = now();
      state.counts = cleanCounts(null);
      checkInterrupted = false;
      lastExchange = null;
      await persist();
      begin();
      return status();
    },

    /** Finishes the question in flight, then halts. Resolves once halted. */
    async stop() {
      if (running) {
        stopping = true;
        wake?.();
        await loop;
      }
      return status();
    },

    /** Carries on with the questions still queued (after a stop or a restart). */
    async continueRun() {
      requireIdle();
      if (!state.queue.length) return status();
      requireKept();
      begin();
      return status();
    },

    status,

    /** Resolves when no batch is running. */
    whenIdle() {
      return loop || Promise.resolve();
    },

    /**
     * Answers to rate, 25 per page. `filter`: "unrated" (default), "all"
     * (unrated first, then rated, then failed), "changed" (the same question
     * once answered differently) or "failed". `cursor` is the `next` value
     * of the previous page.
     */
    async review({ filter = "unrated", category = null, cursor = null } = {}) {
      if (!FILTERS.has(filter)) throw new SelfTestError(400, "SELFTEST_BAD_REVIEW", "Choose unrated, all, changed or failed.");
      if (cursor !== null && cursor !== undefined && (typeof cursor !== "string" || !/^[0-9]{1,6}$/u.test(cursor))) {
        throw new SelfTestError(400, "SELFTEST_BAD_REVIEW", "That page is not valid.");
      }
      const offset = cursor ? Number(cursor) : 0;
      const conversations = await selfTestConversations();
      // Newest first, so every later entry with the same id is an earlier answer.
      const answers = conversations.map((item, index) => ({
        conversationId: item.id,
        question: item.question,
        answer: item.answer,
        toolsUsed: Array.isArray(item.toolsUsed) ? item.toolsUsed : [],
        category: item.selfTest.category,
        rating: item.rating || null,
        correction: item.correction || null,
        changedFromBefore: conversations.slice(index + 1).some((older) => older.selfTest.id === item.selfTest.id && older.answer.trim() !== item.answer.trim()),
        failed: false,
        code: null
      }));
      const failures = [...state.failures].reverse().map((failure) => ({
        conversationId: null,
        question: failure.text,
        answer: null,
        toolsUsed: [],
        category: failure.category,
        rating: null,
        correction: null,
        changedFromBefore: false,
        failed: true,
        code: failure.code
      }));
      const unrated = answers.filter((item) => !item.rating && !item.correction);
      let items = {
        unrated: () => unrated,
        all: () => [...unrated, ...answers.filter((item) => item.rating || item.correction), ...failures],
        changed: () => answers.filter((item) => item.changedFromBefore),
        failed: () => failures
      }[filter]();
      if (typeof category === "string" && category) items = items.filter((item) => item.category === category);
      const page = items.slice(offset, offset + PAGE_SIZE);
      return { items: page, next: offset + PAGE_SIZE < items.length ? String(offset + PAGE_SIZE) : null };
    }
  };
}
