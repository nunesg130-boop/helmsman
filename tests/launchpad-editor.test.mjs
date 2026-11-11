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

import { createLaunchpadEditor } from "../src/ui/launchpad-editor.js";

function tile(id, x = 0) {
  return { id, type: "link", title: id, url: `https://${id}.example/`, open: "newTab", visibility: "owner", style: { background: "glass", hideLabel: false }, layout: { desktop: { x, y: 0, w: 2, h: 1 } } };
}

function harness(apiBehaviour) {
  const model = {
    version: 2,
    theme: { tokens: {}, css: "" },
    pages: [{ id: "home", title: "Home", visibility: "owner", groups: [
      { id: "g1", title: "G1", collapsed: false, visibility: "owner", tiles: [tile("t1")] },
      { id: "g2", title: "G2", collapsed: false, visibility: "owner", tiles: [tile("t2")] }
    ] }]
  };
  const view = { model, revision: 1, activePageId: "home", breakpoint: "desktop", editing: true };
  const calls = [];
  const toasts = [];
  const editor = createLaunchpadEditor({
    view,
    api: async (path, options) => {
      calls.push(options.body);
      return apiBehaviour(options.body, calls.length);
    },
    toast: (message) => toasts.push(message),
    escapeHtml: (value) => String(value),
    icon: () => "",
    live: () => ({}),
    root: () => null,
    render: () => {},
    applyLayout: () => {},
    adopt: (result) => {
      view.revision = result.revision;
      if (result.model) view.model = result.model;
    },
    reload: async () => {
      view.revision = 50;
    }
  });
  return { editor, view, calls, toasts };
}

function click(dataset) {
  const control = { dataset };
  return { target: { closest: (selector) => (selector === "[data-lp-edit]" ? control : null) }, preventDefault() {} };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("after a 409, changes queued against the old revision are dropped, not applied to the newer file", async () => {
  const { editor, view, calls, toasts } = harness((body, count) => {
    if (count === 1) throw Object.assign(new Error("changed"), { code: "LAUNCHPAD_CHANGED" });
    return { revision: body.revision + 1, model: view.model };
  });
  editor.handleClick(click({ lpEdit: "breakpoint", value: "tablet" }));
  editor.handleClick(click({ lpEdit: "customize" })); // one setLayouts per group: two ops
  await settle();
  assert.equal(calls.length, 1, "the second queued op was dropped after the conflict");
  assert.equal(view.revision, 50, "the newer file was loaded");
  assert.ok(toasts.some((message) => /changed elsewhere/u.test(message)));
  // Changes made after the reload go through.
  editor.handleClick(click({ lpEdit: "reset-breakpoint" }));
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].revision, 50);
});

test("leaving edit mode saves text still waiting for its debounce", async () => {
  const { editor, calls } = harness((body) => ({ revision: body.revision + 1 }));
  editor.handleClick({
    target: { closest: (selector) => (selector === ".lp-tile" ? { dataset: { id: "t1" } } : null) },
    preventDefault() {}
  });
  editor.handleInput({
    target: { dataset: { lpField: "title" }, value: "Renamed", tagName: "INPUT", type: "text", matches: () => false, closest: () => null }
  });
  editor.exit();
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].op, { op: "updateTile", tileId: "t1", patch: { title: "Renamed" } });
});
