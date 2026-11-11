import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLaunchpadDocumentStore, LaunchpadStoreError } from "../server/launchpad-store.mjs";

const FAST = { pollMs: 40, debounceMs: 10, initialRevision: 0 };
const ADD_HOME = { op: "addPage", page: { id: "home", title: "Home", groups: [] } };

const VALID = `# hand written
version: 2
pages:
  - id: lab # the lab
    title: Lab
    groups: []
`;

async function withStore(fn, setup) {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-launchpad-store-"));
  if (setup) await setup(root);
  const store = await createLaunchpadDocumentStore({ dataDir: root, ...FAST });
  try {
    await fn(store, root, path.join(root, "launchpad.yaml"));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  assert.fail("condition not reached in time");
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => error instanceof LaunchpadStoreError && error.code === code);
}

test("missing file is an empty launchpad at revision 0", () => withStore(async (store) => {
  const snapshot = store.snapshot();
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.error, null);
  assert.deepEqual(snapshot.model.pages, []);
}));

test("apply writes the file atomically, mode 0600, and bumps revision", () => withStore(async (store, root, file) => {
  const result = await store.apply(0, ADD_HOME);
  assert.equal(result.revision, 1);
  assert.equal(result.model.pages[0].id, "home");
  assert.match(await readFile(file, "utf8"), /id: home/u);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(store.snapshot().revision, 1);
}));

test("stale revision is LAUNCHPAD_CHANGED and writes nothing", () => withStore(async (store, root, file) => {
  await store.apply(0, ADD_HOME);
  const before = await readFile(file, "utf8");
  await rejectsWith(store.apply(0, { op: "addPage", page: { id: "other", title: "O", groups: [] } }), "LAUNCHPAD_CHANGED");
  assert.equal(await readFile(file, "utf8"), before);
}));

test("two tabs: the second save with the old revision is refused", () => withStore(async (store) => {
  const tabA = store.snapshot().revision;
  const tabB = store.snapshot().revision;
  await store.apply(tabA, ADD_HOME);
  await rejectsWith(store.apply(tabB, { op: "addPage", page: { id: "b", title: "B", groups: [] } }), "LAUNCHPAD_CHANGED");
  assert.deepEqual(store.snapshot().model.pages.map((page) => page.id), ["home"]);
}));

test("hand edit via writeFile is picked up", () => withStore(async (store, root, file) => {
  let changes = 0;
  store.onChange(() => { changes += 1; });
  await writeFile(file, VALID);
  await until(() => store.snapshot().model.pages[0]?.id === "lab");
  await sleep(150);
  assert.equal(changes, 1);
  assert.equal(store.snapshot().revision, 1);
}));

test("hand edit via write-temp-then-rename is picked up", () => withStore(async (store, root, file) => {
  await store.apply(0, ADD_HOME);
  const temp = path.join(root, ".launchpad.yaml.swp");
  await writeFile(temp, VALID);
  await rename(temp, file);
  await until(() => store.snapshot().model.pages[0]?.id === "lab");
  assert.equal(store.snapshot().revision, 2);
}));

test("invalid hand edit keeps the last good model and reports the line", () => withStore(async (store, root, file) => {
  await writeFile(file, VALID);
  await until(() => store.snapshot().model.pages[0]?.id === "lab");
  await writeFile(file, "version: 2\npages:\n  - id: Bad_Id\n    title: X\n");
  await until(() => store.snapshot().error !== null);
  const snapshot = store.snapshot();
  assert.equal(snapshot.model.pages[0].id, "lab");
  assert.equal(snapshot.error.line, 3);
  await rejectsWith(store.apply(snapshot.revision, ADD_HOME), "LAUNCHPAD_INVALID");
  await writeFile(file, VALID.replace("Lab", "Lab 2"));
  await until(() => store.snapshot().error === null);
  assert.equal(store.snapshot().model.pages[0].title, "Lab 2");
}));

test("emptied and deleted files become an empty launchpad without error", () => withStore(async (store, root, file) => {
  await store.apply(0, ADD_HOME);
  await writeFile(file, "");
  await until(() => store.snapshot().model.pages.length === 0);
  assert.equal(store.snapshot().error, null);
  await writeFile(file, VALID);
  await until(() => store.snapshot().model.pages.length === 1);
  await unlink(file);
  await until(() => store.snapshot().model.pages.length === 0);
  assert.equal(store.snapshot().error, null);
  const next = await store.apply(store.snapshot().revision, ADD_HOME);
  assert.equal(next.model.pages[0].id, "home");
}));

test("own writes do not fire a change", () => withStore(async (store) => {
  let changes = 0;
  store.onChange(() => { changes += 1; });
  await store.apply(0, ADD_HOME);
  await sleep(200);
  assert.equal(changes, 0, "apply() returns its own result; listeners hear only outside edits");
  assert.equal(store.snapshot().revision, 1);
}));

test("a UI save keeps hand-written comments", () => withStore(async (store, root, file) => {
  await writeFile(file, VALID);
  await until(() => store.snapshot().model.pages.length === 1);
  await store.apply(store.snapshot().revision, ADD_HOME);
  const text = await readFile(file, "utf8");
  assert.match(text, /# hand written/u);
  assert.match(text, /# the lab/u);
}));

test("a symlinked launchpad.yaml is refused", () => withStore(async (store) => {
  const snapshot = store.snapshot();
  assert.ok(snapshot.error);
  assert.deepEqual(snapshot.model.pages, []);
}, async (root) => {
  await writeFile(path.join(root, "elsewhere.yaml"), VALID);
  await symlink(path.join(root, "elsewhere.yaml"), path.join(root, "launchpad.yaml"));
}));

test("an oversized file is refused", () => withStore(async (store) => {
  assert.match(store.snapshot().error.message, /512/u);
}, async (root) => {
  await writeFile(path.join(root, "launchpad.yaml"), `version: 2\n# ${"x".repeat(512 * 1024)}\n`);
}));

test("an op that breaks the schema is LAUNCHPAD_SCHEMA and nothing is written", () => withStore(async (store, root, file) => {
  await store.apply(0, ADD_HOME);
  const before = await readFile(file, "utf8");
  await assert.rejects(store.apply(1, { op: "updatePage", pageId: "home", patch: { title: "" } }), (error) => (
    error.code === "LAUNCHPAD_SCHEMA" && Array.isArray(error.errors) && error.errors.length > 0
  ));
  assert.equal(await readFile(file, "utf8"), before);
  await rejectsWith(store.apply(1, { op: "removePage", pageId: "missing" }), "NOT_FOUND");
}));

test("revisions keep rising across restarts, so a stale tab or cached theme can't match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-launchpad-boot-"));
  try {
    const first = await createLaunchpadDocumentStore({ dataDir: root, pollMs: 40, debounceMs: 10 });
    const { revision } = await first.apply(first.snapshot().revision, ADD_HOME);
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createLaunchpadDocumentStore({ dataDir: root, pollMs: 40, debounceMs: 10 });
    assert.ok(second.snapshot().revision > revision, `${second.snapshot().revision} > ${revision}`);
    assert.ok(Number.isSafeInteger(second.snapshot().revision));
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
