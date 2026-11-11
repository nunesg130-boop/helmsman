// One-time import of the v1.18 Launchpad into launchpad.yaml.
//
// v1.18 listed every connected service automatically and kept optional
// external addresses in launchpad.json. v1.19 is manual-only, so on first
// start each service that page showed becomes an ordinary tile linked to its
// connection. launchpad.json is renamed, not deleted: renaming it back
// restores v1.18's addresses after a rollback, and the renamed file is the
// marker that the import ran.

import { constants as fsConstants } from "node:fs";
import { access, chmod, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { canonicalLaunchUrl, launchpadKey } from "./launchpad-schema.mjs";
import { LAUNCHPAD_FILE_NAME } from "./launchpad-store.mjs";

const LEGACY_FILE = "launchpad.json";
const MARKER_FILE = "launchpad.json.migrated";
const MAX_LEGACY_BYTES = 128 * 1024;
const TILES_PER_ROW = 6;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLegacyAddresses(filePath) {
  const addresses = new Map();
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch {
    return addresses;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_LEGACY_BYTES) return addresses;
    const parsed = JSON.parse((await handle.readFile()).toString("utf8"));
    for (const entry of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      const url = canonicalLaunchUrl(entry?.url);
      if (typeof entry?.key === "string" && url) addresses.set(entry.key, url);
    }
  } catch {
    // An unreadable legacy file just means no saved external addresses.
  } finally {
    await handle.close();
  }
  return addresses;
}

function slugify(name, used) {
  const base = String(name || "service").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "service";
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  used.add(candidate);
  return candidate;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function tilesYaml(entries, addresses, used) {
  const lines = [];
  let index = 0;
  for (const entry of entries) {
    const key = launchpadKey(entry.kind, entry.id);
    if (!key) continue;
    const url = addresses.get(key) || canonicalLaunchUrl(entry.url);
    if (!url) continue;
    const x = (index % TILES_PER_ROW) * 2;
    const y = Math.floor(index / TILES_PER_ROW);
    index += 1;
    lines.push(
      `          - id: ${slugify(entry.name, used)}`,
      "            type: link",
      `            title: ${yamlString(String(entry.name || entry.id).slice(0, 80))}`,
      `            url: ${yamlString(url)}`,
      `            managed: { kind: ${entry.kind}, id: ${entry.id} }`,
      `            layout: { desktop: { x: ${x}, y: ${y}, w: 2, h: 1 } }`
    );
  }
  return lines.length ? lines.join("\n") : "          []";
}

function buildYaml(connected, addresses) {
  const used = new Set();
  const media = connected.filter((entry) => entry.kind === "media");
  const infrastructure = connected.filter((entry) => entry.kind !== "media");
  const mediaTiles = tilesYaml(media, addresses, used);
  const infrastructureTiles = tilesYaml(infrastructure, addresses, used);
  return `# Helmsman Launchpad. Edit here or in Helmsman; both stay in sync.
# Format reference: docs/LAUNCHPAD-FORMAT.md
version: 2
pages:
  - id: home
    title: Home
    groups:
      - id: media
        title: Media
        tiles:${mediaTiles.trim() === "[]" ? " []" : `\n${mediaTiles}`}
      - id: infrastructure
        title: Infrastructure
        tiles:${infrastructureTiles.trim() === "[]" ? " []" : `\n${infrastructureTiles}`}
`;
}

async function atomicWrite(dataDir, filePath, text) {
  const temporary = path.join(dataDir, `.launchpad-migrate-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
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

/**
 * Imports the v1.18 Launchpad once. `connected` lists what the v1.18 page
 * showed, in its order: `{ kind, id, name, url }`.
 */
export async function migrateLegacyLaunchpad({ dataDir, connected = [] }) {
  const yamlPath = path.join(dataDir, LAUNCHPAD_FILE_NAME);
  const legacyPath = path.join(dataDir, LEGACY_FILE);
  const markerPath = path.join(dataDir, MARKER_FILE);
  if (await exists(yamlPath) || await exists(markerPath)) return "skipped";

  const addresses = await readLegacyAddresses(legacyPath);
  await atomicWrite(dataDir, yamlPath, buildYaml(Array.isArray(connected) ? connected : [], addresses));
  if (await exists(legacyPath)) {
    await rename(legacyPath, markerPath);
  } else {
    await atomicWrite(dataDir, markerPath, `${JSON.stringify({ version: 1, entries: [] })}\n`);
  }
  return "migrated";
}
