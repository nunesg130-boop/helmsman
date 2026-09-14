import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const LOCK_NAME = ".broker.lock";
const HEARTBEAT_MS = 2_000;
const STALE_AFTER_MS = 15_000;
const MAX_LOCK_BYTES = 512;

async function inspectLock(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    // A crash can happen after O_EXCL creation but before the nonce write.
    // Treat an empty/partial regular file as a lease candidate: it remains
    // fail-closed while fresh and becomes reclaimable after the stale window.
    if (!metadata.isFile() || metadata.size > MAX_LOCK_BYTES) {
      throw new Error("The broker data directory contains an unsafe lock path.");
    }
    return metadata;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function lockContents(lockPath) {
  try {
    return await readFile(lockPath, { encoding: "utf8" });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function quarantineStaleLock(dataDir, lockPath, observed) {
  const current = await inspectLock(lockPath);
  if (!current || current.dev !== observed.dev || current.ino !== observed.ino) return false;
  if (Date.now() - current.mtimeMs <= STALE_AFTER_MS) return false;
  const quarantine = path.join(dataDir, `.broker-stale-${randomBytes(8).toString("hex")}.lock`);
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await unlink(quarantine).catch(() => {});
  return true;
}

export async function acquireDataDirLock(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});
  const lockPath = path.join(dataDir, LOCK_NAME);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    try {
      const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW || 0);
      handle = await open(lockPath, flags, 0o600);
      const nonce = randomBytes(32).toString("base64url");
      const serialized = `${JSON.stringify({ nonce })}\n`;
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await chmod(lockPath, 0o600);
      const identity = await handle.stat();
      let released = false;
      let lost = false;
      let lostHandler = null;

      const sameIdentity = async () => {
        const current = await inspectLock(lockPath);
        if (!current || current.dev !== identity.dev || current.ino !== identity.ino) return false;
        return (await lockContents(lockPath)) === serialized;
      };
      let timer;
      const markLost = () => {
        if (lost || released) return;
        lost = true;
        clearInterval(timer);
        lostHandler?.();
      };
      const heartbeat = async () => {
        if (released || lost) return;
        try {
          if (!await sameIdentity()) {
            markLost();
            return;
          }
          const now = new Date();
          await handle.utimes(now, now);
        } catch {
          markLost();
        }
      };
      timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
      timer.unref?.();

      return {
        onLost(callback) {
          lostHandler = typeof callback === "function" ? callback : null;
          if (lost) lostHandler?.();
        },
        async assertHeld() {
          if (released || lost || !await sameIdentity()) {
            markLost();
            throw new Error("The broker data-directory lock was lost.");
          }
        },
        async release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          const owned = !lost && await sameIdentity().catch(() => false);
          await handle.close();
          if (owned) {
            await unlink(lockPath).catch((error) => {
              if (error?.code !== "ENOENT") throw error;
            });
          }
        }
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const observed = await inspectLock(lockPath);
      if (!observed) continue;
      if (Date.now() - observed.mtimeMs <= STALE_AFTER_MS) {
        throw new Error("The broker data directory is already in use. Stop the running broker first.");
      }
      if (!await quarantineStaleLock(dataDir, lockPath, observed)) continue;
    }
  }
  throw new Error("The broker data directory lock could not be acquired safely.");
}
