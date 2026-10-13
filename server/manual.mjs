import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

// Manual: the owner's own operations manual, written in Markdown and kept in
// the data volume beside state.json. Helmsman ships with no manual content;
// the page stays empty until the owner writes or pastes one in.
//
// The manual is plain owner-authored text. Helmsman never executes it and the
// dashboard renders it with an escaping Markdown subset, so it cannot carry
// markup or script into the page. It is not encrypted: the editor reminds the
// owner to keep passwords, keys and tokens out of it.

const FILE_NAME = "manual.json";
const FILE_VERSION = 1;
const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_FILE_BYTES = MAX_MARKDOWN_BYTES * 2 + 4096;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
// Tabs and line feeds are allowed; every other C0/C1 control and the Unicode
// line/paragraph separators are not.
const DISALLOWED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

export const MANUAL_LIMITS = Object.freeze({ markdownBytes: MAX_MARKDOWN_BYTES });

export class ManualError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Returns the stored form of owner Markdown, or null when it is not
 * acceptable. Line endings are normalized and trailing whitespace at the end
 * of the document is trimmed.
 */
export function canonicalManualMarkdown(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/\s+$/u, "");
  if (DISALLOWED.test(normalized)) return null;
  if (Buffer.byteLength(normalized, "utf8") > MAX_MARKDOWN_BYTES) return null;
  return normalized;
}

export function validManualRevision(value) {
  return value === null || (typeof value === "string" && REVISION.test(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : null;
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
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new ManualError("MANUAL_TOO_LARGE", "The manual exceeded its size limit.");
  const temporary = path.join(dataDir, `.manual-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
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

export async function createManualStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The manual store requires an absolute data directory.");
  }
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const filePath = path.join(dataDir, FILE_NAME);
  let current = { markdown: "", revision: null, updatedAt: null };
  let writeChain = Promise.resolve();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const loaded = await readFileSafely(filePath);
  if (isPlainObject(loaded)
    && loaded.version === FILE_VERSION
    && canonicalManualMarkdown(loaded.markdown) === loaded.markdown
    && typeof loaded.revision === "string"
    && REVISION.test(loaded.revision)
    && canonicalTimestamp(loaded.updatedAt) !== null) {
    current = { markdown: loaded.markdown, revision: loaded.revision, updatedAt: loaded.updatedAt };
  }

  return {
    get() {
      return { ...current };
    },

    /**
     * Saves new Markdown when `expectedRevision` matches the stored revision
     * (null when nothing has been saved yet), so two open editors cannot
     * silently overwrite each other.
     */
    async save(markdown, expectedRevision) {
      const canonical = canonicalManualMarkdown(markdown);
      if (canonical === null) {
        throw new ManualError("INVALID_MANUAL", "The manual must be text under 256 KiB without control characters.");
      }
      if (!validManualRevision(expectedRevision)) {
        throw new ManualError("INVALID_MANUAL", "The manual revision is not valid.");
      }
      const operation = writeChain.catch(() => {}).then(async () => {
        if (expectedRevision !== current.revision) {
          throw new ManualError("MANUAL_CONFLICT", "The manual changed since you opened it. Reload it and apply your edits again.");
        }
        const next = {
          markdown: canonical,
          revision: randomUUID(),
          updatedAt: new Date(Math.trunc(Number(clock()))).toISOString()
        };
        await guard();
        await atomicWrite(dataDir, filePath, { version: FILE_VERSION, ...next });
        current = next;
        return { ...next };
      });
      writeChain = operation.then(() => {}, () => {});
      return operation;
    }
  };
}
