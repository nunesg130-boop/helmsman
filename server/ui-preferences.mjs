import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Dashboard layout choices kept by Helmsman itself, so every browser the
// owner signs in from sees the same: which Settings cards are folded shut.
//
// The store lives beside state.json in its own file so the security-critical
// broker state schema is untouched. It holds only card names; never
// credentials or anything from the monitored services.

const FILE_NAME = "ui-preferences.json";
const FILE_VERSION = 1;
const MAX_CARDS = 200;
const MAX_FILE_BYTES = 32 * 1024;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;

export const UI_PREFERENCE_LIMITS = Object.freeze({ cards: MAX_CARDS });

export function isCardId(value) {
  return typeof value === "string" && CARD_ID.test(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Dashboard preferences exceeded their size limit.");
  const temporary = path.join(dataDir, `.ui-preferences-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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

export async function createUiPreferenceStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The dashboard preference store requires an absolute data directory.");
  }
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const filePath = path.join(dataDir, FILE_NAME);
  // Only folded cards are kept; a card not listed is open.
  const collapsed = new Set();
  let writeChain = Promise.resolve();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const loaded = await readFileSafely(filePath);
  if (isPlainObject(loaded) && loaded.version === FILE_VERSION && Array.isArray(loaded.collapsedCards)) {
    for (const id of loaded.collapsedCards.slice(0, MAX_CARDS)) if (isCardId(id)) collapsed.add(id);
  }

  function persist() {
    const snapshot = { version: FILE_VERSION, collapsedCards: [...collapsed] };
    const operation = writeChain.catch(() => {}).then(async () => {
      await guard();
      await atomicWrite(dataDir, filePath, snapshot);
    });
    writeChain = operation.then(() => {}, () => {});
    return operation;
  }

  return {
    collapsedCards() {
      return [...collapsed].sort();
    },

    /** Folds or opens one card. Returns the folded cards after the change. */
    async setCard(id, isCollapsed) {
      if (!isCardId(id) || typeof isCollapsed !== "boolean") throw new TypeError("That card cannot be changed.");
      if (isCollapsed === collapsed.has(id)) return this.collapsedCards();
      if (isCollapsed && collapsed.size >= MAX_CARDS) {
        const error = new Error("Too many cards are folded. Open some before folding more.");
        error.code = "UI_PREFERENCE_LIMIT";
        throw error;
      }
      if (isCollapsed) collapsed.add(id);
      else collapsed.delete(id);
      await persist();
      return this.collapsedCards();
    }
  };
}
