import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchpadYaml, stringifyDocument } from "../server/yaml.mjs";

test("round-trips comments", () => {
  const doc = parseLaunchpadYaml("# top\na: 1 # one\nb: [x, y]\n");
  doc.setIn(["a"], 2);
  const out = stringifyDocument(doc);
  assert.match(out, /^# top\n/u);
  assert.match(out, /a: 2 # one\n/u);
  assert.match(out, /b: \[ x, y \]\n/u);
});

test("reports line numbers", () => {
  const doc = parseLaunchpadYaml("a: 1\nb: [\n");
  assert.ok(doc.errors.length > 0);
  const line = doc.errors[0].linePos?.[0]?.line;
  assert.ok(Number.isInteger(line) && line > 0, String(line));
});

test("rejects duplicate keys", () => {
  assert.ok(parseLaunchpadYaml("a: 1\na: 2\n").errors.length > 0);
});

test("deep flow nesting is refused before parsing, with a line", () => {
  const started = Date.now();
  const doc = parseLaunchpadYaml(`version: 2\npages: ${"[".repeat(50000)}${"]".repeat(50000)}\n`);
  assert.ok(Date.now() - started < 200, "refused without handing it to the parser");
  assert.equal(doc.errors.length, 1);
  assert.match(doc.errors[0].message, /nested more than 64/u);
  assert.equal(doc.errors[0].linePos[0].line, 2);
  // Brackets inside quotes and comments don't count.
  assert.equal(parseLaunchpadYaml(`a: "${"[".repeat(100)}" # ${"{".repeat(100)}\n`).errors.length, 0);
});

test("an apostrophe in plain text does not hide deep nesting", () => {
  const doc = parseLaunchpadYaml(`title: don't\npages: ${"[".repeat(100)}${"]".repeat(100)}\n`);
  assert.match(doc.errors[0]?.message || "", /nested more than 64/u);
});
