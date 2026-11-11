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
