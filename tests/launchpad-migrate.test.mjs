import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateLegacyLaunchpad } from "../server/launchpad-migrate.mjs";
import { validateLaunchpad } from "../server/launchpad-schema.mjs";
import { parseLaunchpadYaml } from "../server/yaml.mjs";

const PROXMOX = "3f0c1d2e-4b5a-4c6d-8e7f-901234567890";
const PORTAINER = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const CONNECTED = [
  { kind: "media", id: "sonarr", name: "Sonarr", url: "http://10.44.1.21:8989" },
  { kind: "media", id: "radarr", name: "Radarr", url: "http://10.44.1.22:7878" },
  { kind: "environment", id: PROXMOX, name: "Proxmox VE", url: "https://10.44.1.2:8006" },
  { kind: "service", id: PORTAINER, name: "Portainer", url: "https://10.44.1.3:9443" },
  { kind: "service", id: "5b2c3d4e-6f70-4b8c-9dae-1f2a3b4c5d6e", name: "Portainer", url: "https://10.44.1.4:9443" },
  { kind: "media", id: "bazarr", name: "Bazarr", url: "" }
];

async function withDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-launchpad-migrate-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function legacy(entries) {
  return `${JSON.stringify({ version: 1, entries })}\n`;
}

test("imports the v1.18 Launchpad as linked tiles", () => withDir(async (root) => {
  await writeFile(path.join(root, "launchpad.json"), legacy([
    { key: "media:sonarr", url: "https://sonarr.example.net/", updatedAt: "2026-11-01T00:00:00.000Z" }
  ]));
  assert.equal(await migrateLegacyLaunchpad({ dataDir: root, connected: CONNECTED }), "migrated");
  const { model, errors } = validateLaunchpad(parseLaunchpadYaml(await readFile(path.join(root, "launchpad.yaml"), "utf8")));
  assert.deepEqual(errors, []);
  const [media, infrastructure] = model.pages[0].groups;
  assert.equal(model.pages[0].id, "home");
  assert.deepEqual(media.tiles.map((tile) => [tile.id, tile.url]), [
    ["sonarr", "https://sonarr.example.net/"],
    ["radarr", "http://10.44.1.22:7878/"]
  ]);
  assert.deepEqual(media.tiles[0].managed, { kind: "media", id: "sonarr" });
  assert.deepEqual(media.tiles[1].layout.desktop, { x: 2, y: 0, w: 2, h: 1 });
  assert.deepEqual(infrastructure.tiles.map((tile) => tile.id), ["proxmox-ve", "portainer", "portainer-2"]);
  assert.deepEqual(infrastructure.tiles[0].managed, { kind: "environment", id: PROXMOX });
  assert.ok(await exists(path.join(root, "launchpad.json.migrated")));
  assert.equal(await exists(path.join(root, "launchpad.json")), false);
}));

test("runs at most once", () => withDir(async (root) => {
  assert.equal(await migrateLegacyLaunchpad({ dataDir: root, connected: CONNECTED }), "migrated");
  const first = await readFile(path.join(root, "launchpad.yaml"), "utf8");
  await writeFile(path.join(root, "launchpad.json.migrated"), legacy([]));
  await rm(path.join(root, "launchpad.yaml"));
  assert.equal(await migrateLegacyLaunchpad({ dataDir: root, connected: CONNECTED }), "skipped", "the marker stops a second import");
  assert.equal(await exists(path.join(root, "launchpad.yaml")), false);
  await writeFile(path.join(root, "launchpad.yaml"), first);
  await rm(path.join(root, "launchpad.json.migrated"));
  assert.equal(await migrateLegacyLaunchpad({ dataDir: root, connected: CONNECTED }), "skipped", "an existing launchpad.yaml wins");
  assert.equal(await readFile(path.join(root, "launchpad.yaml"), "utf8"), first);
}));

test("a fresh install with no connections still gets a valid file", () => withDir(async (root) => {
  assert.equal(await migrateLegacyLaunchpad({ dataDir: root, connected: [] }), "migrated");
  const { model, errors } = validateLaunchpad(parseLaunchpadYaml(await readFile(path.join(root, "launchpad.yaml"), "utf8")));
  assert.deepEqual(errors, []);
  assert.equal(model.pages.length, 1);
  assert.ok(await exists(path.join(root, "launchpad.json.migrated")), "a marker is left so deleting launchpad.yaml later does not re-import");
}));
