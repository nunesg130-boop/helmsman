import assert from "node:assert/strict";
import test from "node:test";

import { parseFolderLines, uniqueId } from "../src/ui/launchpad-editor.js";

test("new ids are slugs that never collide", () => {
  assert.equal(uniqueId("My NAS!", new Set()), "my-nas");
  assert.equal(uniqueId("My NAS", new Set(["my-nas", "my-nas-2"])), "my-nas-3");
  assert.equal(uniqueId("!!!", new Set(), "tile"), "tile");
});

test("folder lines read as Title | address", () => {
  assert.deepEqual(parseFolderLines("ER605 | http://192.168.0.1\n\n  https://ax.example  \nNo bar"), [
    { title: "ER605", url: "http://192.168.0.1" },
    { title: "ax.example", url: "https://ax.example" },
    { title: "No bar", url: "No bar" }
  ]);
});
