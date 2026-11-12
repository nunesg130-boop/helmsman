import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_UI_THEME, UI_THEMES, createUiPreferenceStore, isCardId, isUiTheme } from "../server/ui-preferences.mjs";

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

test("the theme defaults to Default, is kept on disk and read back", async (t) => {
  const dataDir = await directory(t);
  const store = await createUiPreferenceStore({ dataDir });
  assert.equal(store.theme(), DEFAULT_UI_THEME);
  assert.equal(await store.setTheme("glass-dark"), "glass-dark");
  assert.equal((await createUiPreferenceStore({ dataDir })).theme(), "glass-dark");
  const saved = JSON.parse(await readFile(path.join(dataDir, "ui-preferences.json"), "utf8"));
  assert.deepEqual(saved, { version: 1, collapsedCards: [], theme: "glass-dark" });
  await store.setTheme("default");
  const cleared = JSON.parse(await readFile(path.join(dataDir, "ui-preferences.json"), "utf8"));
  assert.deepEqual(cleared, { version: 1, collapsedCards: [] }, "Default is the absence of a theme");
});

test("unknown themes are refused and an unknown saved theme falls back to Default", async (t) => {
  const dataDir = await directory(t);
  const store = await createUiPreferenceStore({ dataDir });
  for (const id of ["", "Glass-Dark", "neon", "glass-dark ", 3, null]) {
    assert.equal(isUiTheme(id), false, String(id));
    await assert.rejects(store.setTheme(id), TypeError);
  }
  assert.equal(store.theme(), DEFAULT_UI_THEME);
  await writeFile(path.join(dataDir, "ui-preferences.json"), JSON.stringify({ version: 1, collapsedCards: [], theme: "\"><script>" }));
  assert.equal((await createUiPreferenceStore({ dataDir })).theme(), DEFAULT_UI_THEME);
});

test("every theme has a stylesheet, and the generated ones are up to date", async () => {
  const root = new URL("../", import.meta.url);
  assert.deepEqual(UI_THEMES.map(({ id }) => id), ["default", "glass-dark", "glass-light"]);
  for (const { id } of UI_THEMES) {
    if (id === DEFAULT_UI_THEME) continue;
    const css = await readFile(new URL(`src/ui/theme-${id}.css`, root), "utf8");
    assert.match(css, new RegExp(`html\\[data-theme="${id}"\\]`, "u"));
    // A theme may never restyle the page unless it is the chosen one.
    const unscoped = [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
      .map((match) => match[1].replace(/\s+/gu, " ").trim())
      .filter((prelude) => !prelude.startsWith("@") && !/^(from|to|\d+%)$/u.test(prelude)
        && !/data-(theme|glass-motion|glass-lens)/u.test(prelude) && !/^\.glass-(sheen|lens-defs)/u.test(prelude));
    assert.deepEqual(unscoped, [], `${id} has rules that are not scoped to the theme`);
  }
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [new URL("scripts/build-glass-themes.mjs", root).pathname, "--check"], { stdio: "pipe" });
});

test("the Default stylesheets carry no theme rules", async () => {
  const root = new URL("../", import.meta.url);
  for (const file of ["styles.css", "src/ui/obsidian-glass.css", "src/ui/retro.css", "src/ui/operations.css", "src/ui/control.css", "src/ui/launchpad.css"]) {
    assert.doesNotMatch(await readFile(new URL(file, root), "utf8"), /data-theme/u, file);
  }
});
