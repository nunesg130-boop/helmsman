import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUiPreferenceStore, isCardId } from "../server/ui-preferences.mjs";

async function directory(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "helmsman-ui-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("folded cards are kept on disk and read back", async (t) => {
  const dataDir = await directory(t);
  const store = await createUiPreferenceStore({ dataDir });
  assert.deepEqual(store.collapsedCards(), []);
  assert.deepEqual(await store.setCard("agent-training-self-test", true), ["agent-training-self-test"]);
  await store.setCard("access-credential-encryption", true);
  await store.setCard("agent-training-self-test", false);
  const again = await createUiPreferenceStore({ dataDir });
  assert.deepEqual(again.collapsedCards(), ["access-credential-encryption"]);
  const saved = JSON.parse(await readFile(path.join(dataDir, "ui-preferences.json"), "utf8"));
  assert.deepEqual(saved, { version: 1, collapsedCards: ["access-credential-encryption"] });
});

test("bad card names and values are refused, and a damaged file starts empty", async (t) => {
  const dataDir = await directory(t);
  const store = await createUiPreferenceStore({ dataDir });
  for (const id of ["", "Upper", "-lead", "a".repeat(97), "has space", 5]) assert.equal(isCardId(id), false, String(id));
  await assert.rejects(store.setCard("ok-card", "yes"), TypeError);
  await assert.rejects(store.setCard("Bad", true), TypeError);
  await writeFile(path.join(dataDir, "ui-preferences.json"), "{not json");
  assert.deepEqual((await createUiPreferenceStore({ dataDir })).collapsedCards(), []);
  await writeFile(path.join(dataDir, "ui-preferences.json"), JSON.stringify({ version: 1, collapsedCards: ["fine", "Not Fine", 3] }));
  assert.deepEqual((await createUiPreferenceStore({ dataDir })).collapsedCards(), ["fine"]);
});

test("at most 200 cards can be folded", async (t) => {
  const store = await createUiPreferenceStore({ dataDir: await directory(t) });
  for (let index = 0; index < 200; index += 1) await store.setCard(`card-${index}`, true);
  await assert.rejects(store.setCard("one-more", true), { code: "UI_PREFERENCE_LIMIT" });
  assert.equal((await store.setCard("card-0", true)).length, 200, "folding one already folded is fine");
});
