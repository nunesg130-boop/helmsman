// Owns /data/launchpad.yaml, the single source of truth for the Launchpad.
//
// The UI changes the file one small operation at a time (launchpad-ops.mjs),
// applied to the parsed Document so hand-written comments survive. The owner
// may also edit the file by hand at any time: a directory watcher plus a
// stat poll (bind mounts do not always deliver events) picks the change up.
// Every distinct file content gets a new revision; a UI save naming an older
// revision is refused, so a hand edit is never silently overwritten. When the
// file on disk is invalid, the last good model keeps being served and edits
// are refused until the file is fixed.

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, watch } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { applyLaunchpadOp, LaunchpadOpError } from "./launchpad-ops.mjs";
import { emptyLaunchpadModel, LAUNCHPAD_LIMITS, validateLaunchpad } from "./launchpad-schema.mjs";
import { parseLaunchpadYaml, stringifyDocument } from "./yaml.mjs";

export const LAUNCHPAD_FILE_NAME = "launchpad.yaml";
const MAX_FILE_BYTES = LAUNCHPAD_LIMITS.fileBytes;

export class LaunchpadStoreError extends Error {
  constructor(code, message, errors) {
    super(message);
    this.name = "LaunchpadStoreError";
    this.code = code;
    if (errors) this.errors = errors;
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

class FileProblem extends Error {}

async function readLaunchpadFile(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    if (error?.code === "ELOOP" || error?.code === "EMLINK") {
      throw new FileProblem("launchpad.yaml must be a regular file, not a link.");
    }
    throw new FileProblem(`launchpad.yaml could not be read (${error?.code || "error"}).`);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new FileProblem("launchpad.yaml must be a regular file.");
    if (metadata.size > MAX_FILE_BYTES) {
      throw new FileProblem(`launchpad.yaml is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    }
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function atomicWrite(dataDir, filePath, text) {
  const temporary = path.join(dataDir, `.launchpad-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, 0o600);
  try {
    await handle.writeFile(text, { encoding: "utf8" });
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

function firstError(errors) {
  const [error] = errors;
  const where = error.path ? ` (${error.path})` : "";
  return Object.freeze({ message: `${error.message}${where}`, line: error.line, column: error.column });
}

export async function createLaunchpadDocumentStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The Launchpad store requires an absolute data directory.");
  }
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 2000;
  const debounceMs = Number.isInteger(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : 300;
  const filePath = path.join(dataDir, LAUNCHPAD_FILE_NAME);
  const listeners = new Set();

  let revision = 0;
  let model = emptyLaunchpadModel();
  let error = null;
  let goodDoc = parseLaunchpadYaml("");
  let lastHash = null;
  let fingerprint = null;
  let chain = Promise.resolve();
  let debounceTimer = null;
  let closed = false;

  function serialize(task) {
    const run = chain.catch(() => {}).then(task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function currentFingerprint() {
    try {
      const metadata = await lstat(filePath);
      return `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.isSymbolicLink()}`;
    } catch {
      return "missing";
    }
  }

  // Reads the file and, when its content differs from what was last seen,
  // adopts it as a new revision. Returns true when something changed.
  async function reload({ initial = false } = {}) {
    fingerprint = await currentFingerprint();
    let text;
    let problem = null;
    try {
      text = await readLaunchpadFile(filePath);
    } catch (caught) {
      if (!(caught instanceof FileProblem)) throw caught;
      problem = caught.message;
    }
    const hash = problem ? `problem:${problem}` : sha256(text);
    if (hash === lastHash) return false;
    lastHash = hash;
    if (problem) {
      error = Object.freeze({ message: problem, line: 0, column: 0 });
    } else {
      const doc = parseLaunchpadYaml(text);
      const result = validateLaunchpad(doc);
      if (result.errors.length) {
        error = firstError(result.errors);
      } else {
        error = null;
        model = result.model;
        goodDoc = doc;
      }
    }
    if (!initial) revision += 1;
    return true;
  }

  function snapshot() {
    return { revision, model, error };
  }

  function notify() {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      serialize(async () => {
        if (!closed && await reload()) notify();
      }).catch(() => {});
    }, debounceMs);
  }

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await reload({ initial: true });

  // Watching the directory, not the file, survives editors that save by
  // writing a temporary file and renaming it over launchpad.yaml.
  let watcher = null;
  try {
    watcher = watch(dataDir, { persistent: false }, (_event, name) => {
      if (!name || String(name) === LAUNCHPAD_FILE_NAME) schedule();
    });
    watcher.on("error", () => {});
  } catch {
    watcher = null;
  }
  const poll = setInterval(async () => {
    if (closed) return;
    if (await currentFingerprint() !== fingerprint) schedule();
  }, pollMs);
  poll.unref?.();

  return {
    snapshot,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reloadNow() {
      return serialize(async () => {
        if (await reload()) notify();
      });
    },

    apply(expectedRevision, op) {
      return serialize(async () => {
        // Catch a hand edit the watcher has not reported yet, so it is
        // never overwritten by a save made against the older content.
        if (await reload()) notify();
        if (expectedRevision !== revision) {
          throw new LaunchpadStoreError("LAUNCHPAD_CHANGED", "launchpad.yaml changed since this page loaded it. Reload and try again.");
        }
        if (error) {
          throw new LaunchpadStoreError("LAUNCHPAD_INVALID", "launchpad.yaml has an error. Fix the file before editing in Helmsman.");
        }
        const doc = goodDoc.clone();
        try {
          applyLaunchpadOp(doc, op);
        } catch (caught) {
          if (caught instanceof LaunchpadOpError) throw new LaunchpadStoreError(caught.code, caught.message);
          throw caught;
        }
        const text = stringifyDocument(doc);
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
          throw new LaunchpadStoreError("LIMIT", `launchpad.yaml would be larger than ${MAX_FILE_BYTES / 1024} KB.`);
        }
        const reparsed = parseLaunchpadYaml(text);
        const result = validateLaunchpad(reparsed);
        if (result.errors.length) {
          throw new LaunchpadStoreError("LAUNCHPAD_SCHEMA", firstError(result.errors).message, result.errors);
        }
        await guard();
        await atomicWrite(dataDir, filePath, text);
        lastHash = sha256(text);
        fingerprint = await currentFingerprint();
        goodDoc = reparsed;
        model = result.model;
        revision += 1;
        return { revision, model };
      });
    },

    async close() {
      closed = true;
      clearTimeout(debounceTimer);
      clearInterval(poll);
      watcher?.close();
      await chain.catch(() => {});
    }
  };
}
