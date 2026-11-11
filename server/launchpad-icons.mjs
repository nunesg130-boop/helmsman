// Launchpad tile icons. Helmsman's CSP only allows same-origin images, so
// icons are served by Helmsman itself:
//   dashboard-icons:<slug> and mdi:<slug> are fetched once from one fixed
//     CDN host (never a user-supplied URL), cached under /data/icons and
//     served from there;
//   upload:<hash>.<ext> are images the owner uploaded, typed by content.
// Every image is checked by its leading bytes, capped at 512 KB, and only
// ever rendered through <img>, which never runs script inside an SVG.

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const DASHBOARD_ICONS_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
export const MDI_BASE = "https://cdn.jsdelivr.net/npm/@mdi/svg@7.4.47/svg";
export const MAX_ICON_BYTES = 512 * 1024;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const UPLOAD = /^[a-f0-9]{16}\.(?:png|jpg|webp|svg)$/u;
const MISS_TTL_MS = 60 * 60 * 1000;
const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

export class LaunchpadIconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LaunchpadIconError";
    this.code = code;
  }
}

/** Returns png | jpg | webp | svg from the leading bytes, or null. */
export function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  const head = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/u, "").trimStart();
  if ((head.startsWith("<svg") || head.startsWith("<?xml")) && head.includes("<svg")) return "svg";
  return null;
}

async function readFileSafely(filePath) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch {
    return null;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_ICON_BYTES) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(directory, filePath, bytes) {
  const temporary = path.join(directory, `.icon-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.close();
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readCapped(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
  if (!response.body) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ICON_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function createLaunchpadIconStore(options = {}) {
  const dataDir = options.dataDir;
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new Error("The Launchpad icon store requires an absolute data directory.");
  }
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 8000;
  const guard = typeof options.guard === "function" ? options.guard : async () => {};
  const root = path.join(dataDir, "icons");
  const folders = {
    "dashboard-icons": path.join(root, "dashboard-icons"),
    mdi: path.join(root, "mdi"),
    upload: path.join(root, "uploads")
  };
  const misses = new Map();
  const inflight = new Map();

  await guard();
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true, mode: 0o700 });

  function candidates(source, slug) {
    if (source === "mdi") return [[`${MDI_BASE}/${slug}.svg`, "svg"]];
    return [[`${DASHBOARD_ICONS_BASE}/svg/${slug}.svg`, "svg"], [`${DASHBOARD_ICONS_BASE}/png/${slug}.png`, "png"]];
  }

  async function fromCache(source, slug) {
    for (const extension of ["svg", "png"]) {
      const bytes = await readFileSafely(path.join(folders[source], `${slug}.${extension}`));
      if (bytes && sniffImage(bytes) === extension) return { bytes, contentType: CONTENT_TYPES[extension] };
    }
    return null;
  }

  async function download(source, slug) {
    for (const [url, extension] of candidates(source, slug)) {
      let response;
      try {
        response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "image/*" } });
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const bytes = await readCapped(response).catch(() => null);
      if (!bytes || sniffImage(bytes) !== extension) continue;
      await guard();
      await atomicWrite(folders[source], path.join(folders[source], `${slug}.${extension}`), bytes);
      return { bytes, contentType: CONTENT_TYPES[extension] };
    }
    return null;
  }

  async function getRemote(source, slug) {
    const cached = await fromCache(source, slug);
    if (cached) return cached;
    const key = `${source}:${slug}`;
    const missedAt = misses.get(key);
    if (missedAt !== undefined && clock() - missedAt < MISS_TTL_MS) return null;
    if (!inflight.has(key)) {
      inflight.set(key, download(source, slug).finally(() => inflight.delete(key)));
    }
    const result = await inflight.get(key);
    if (result) misses.delete(key);
    else misses.set(key, clock());
    return result;
  }

  return {
    async get(ref) {
      if (typeof ref !== "string") return null;
      const separator = ref.indexOf(":");
      const source = ref.slice(0, separator);
      const name = ref.slice(separator + 1);
      if ((source === "dashboard-icons" || source === "mdi") && SLUG.test(name)) return getRemote(source, name);
      if (source === "upload" && UPLOAD.test(name)) {
        const bytes = await readFileSafely(path.join(folders.upload, name));
        const extension = name.slice(name.lastIndexOf(".") + 1);
        return bytes && sniffImage(bytes) === extension ? { bytes, contentType: CONTENT_TYPES[extension] } : null;
      }
      return null;
    },

    async saveUpload(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new LaunchpadIconError("ICON_TYPE", "Choose a PNG, JPEG, WebP or SVG image.");
      if (bytes.length > MAX_ICON_BYTES) throw new LaunchpadIconError("ICON_TOO_LARGE", "Icons can be at most 512 KB.");
      const extension = sniffImage(bytes);
      if (!extension) throw new LaunchpadIconError("ICON_TYPE", "Choose a PNG, JPEG, WebP or SVG image.");
      const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extension}`;
      await guard();
      await atomicWrite(folders.upload, path.join(folders.upload, name), bytes);
      return `upload:${name}`;
    }
  };
}
