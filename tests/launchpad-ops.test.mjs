import assert from "node:assert/strict";
import test from "node:test";

import { applyLaunchpadOp, LaunchpadOpError } from "../server/launchpad-ops.mjs";
import { validateLaunchpad } from "../server/launchpad-schema.mjs";
import { parseLaunchpadYaml, stringifyDocument } from "../server/yaml.mjs";

const FIXTURE = `# Owner's launchpad
version: 2
pages:
  # main page
  - id: home
    title: Home
    groups:
      # media group
      - id: media
        title: Media
        tiles:
          # the media server
          - id: jellyfin
            type: link
            title: Jellyfin
            url: https://jellyfin.example.net/
            icon: dashboard-icons:jellyfin
            layout:
              desktop: { x: 0, y: 0, w: 2, h: 1 } # top-left
              phone: { x: 0, y: 0, w: 2, h: 1 }
              tablet: { x: 0, y: 0, w: 2, h: 1 }
          # downloads
          - id: qbit
            type: link
            title: qBittorrent
            url: https://qbit.example.net/
            layout: { desktop: { x: 2, y: 0, w: 2, h: 1 }, phone: { x: 0, y: 1, w: 2, h: 1 } }
      # infra group
      - id: infra
        title: Infrastructure
        tiles: []
  # second page
  - id: lab
    title: Lab
    groups: []
`;

const COMMENTS = ["# Owner's launchpad", "# main page", "# media group", "# the media server", "# top-left", "# downloads", "# infra group", "# second page"];

function doc() {
  return parseLaunchpadYaml(FIXTURE);
}

function applied(op) {
  const document = doc();
  applyLaunchpadOp(document, op);
  const text = stringifyDocument(document);
  const { errors } = validateLaunchpad(parseLaunchpadYaml(text));
  assert.deepEqual(errors, [], `${op.op} keeps the document valid`);
  return text;
}

function rejects(op, code) {
  assert.throws(() => applyLaunchpadOp(doc(), op), (error) => error instanceof LaunchpadOpError && error.code === code);
}

const NEW_TILE = { id: "notes", type: "note", markdown: "hi", layout: { desktop: { x: 0, y: 1, w: 2, h: 1 } } };

test("comments survive every op", () => {
  const ops = [
    { op: "addPage", page: { id: "extra", title: "Extra", groups: [] } },
    { op: "updatePage", pageId: "home", patch: { title: "Start" } },
    { op: "movePage", pageId: "lab", index: 0 },
    { op: "addGroup", pageId: "lab", group: { id: "net", title: "Network", tiles: [] } },
    { op: "updateGroup", pageId: "home", groupId: "infra", patch: { collapsed: true } },
    { op: "moveGroup", pageId: "home", groupId: "infra", index: 0 },
    { op: "addTile", pageId: "home", groupId: "infra", tile: NEW_TILE },
    { op: "updateTile", tileId: "qbit", patch: { title: "Downloads" } },
    { op: "moveTile", tileId: "qbit", toPageId: "home", toGroupId: "infra", index: 0 },
    { op: "setLayout", tileId: "qbit", breakpoint: "desktop", rect: { x: 4, y: 0, w: 2, h: 2 } },
    { op: "setLayouts", breakpoint: "desktop", rects: { qbit: { x: 4, y: 0, w: 2, h: 1 } } },
    { op: "resetBreakpoint", pageId: "home", breakpoint: "phone" },
    { op: "updateTheme", patch: { tokens: { accent: "#123456" } } }
  ];
  for (const op of ops) {
    const text = applied(op);
    for (const comment of COMMENTS) assert.ok(text.includes(comment), `${op.op} lost "${comment}"`);
  }
  const removed = applied({ op: "removeTile", tileId: "qbit" });
  for (const comment of COMMENTS.filter((entry) => entry !== "# downloads")) assert.ok(removed.includes(comment), comment);
  const removedGroup = applied({ op: "removeGroup", pageId: "home", groupId: "infra" });
  assert.ok(removedGroup.includes("# the media server"));
  const removedPage = applied({ op: "removePage", pageId: "lab" });
  assert.ok(removedPage.includes("# main page"));
});

test("updateTile patch sets and deletes keys", () => {
  const text = applied({ op: "updateTile", tileId: "jellyfin", patch: { title: "X", icon: null } });
  assert.match(text, /title: X\n/u);
  assert.doesNotMatch(text, /dashboard-icons:jellyfin/u);
  rejects({ op: "updateTile", tileId: "jellyfin", patch: { id: "y" } }, "INVALID_OP");
  rejects({ op: "updateTile", tileId: "jellyfin", patch: { layout: {} } }, "INVALID_OP");
});

test("moveTile across groups keeps the tile's comment", () => {
  const text = applied({ op: "moveTile", tileId: "jellyfin", toPageId: "home", toGroupId: "infra", index: 0 });
  const infraAt = text.indexOf("id: infra");
  assert.ok(text.indexOf("# the media server") > infraAt, "comment moved with the tile");
  assert.ok(text.indexOf("id: jellyfin") > infraAt);
  assert.match(text, /\n {10}- id: jellyfin\n/u, "moving into an empty [] list keeps block style");
});

test("setLayouts writes several rects in one op", () => {
  const document = doc();
  applyLaunchpadOp(document, { op: "setLayouts", breakpoint: "desktop", rects: { jellyfin: { x: 0, y: 1, w: 2, h: 1 }, qbit: { x: 0, y: 0, w: 2, h: 1 } } });
  const { model } = validateLaunchpad(parseLaunchpadYaml(stringifyDocument(document)));
  const [jellyfin, qbit] = model.pages[0].groups[0].tiles;
  assert.deepEqual(jellyfin.layout.desktop, { x: 0, y: 1, w: 2, h: 1 });
  assert.deepEqual(qbit.layout.desktop, { x: 0, y: 0, w: 2, h: 1 });
});

test("resetBreakpoint removes phone only", () => {
  const { model } = validateLaunchpad(parseLaunchpadYaml(applied({ op: "resetBreakpoint", pageId: "home", breakpoint: "phone" })));
  const [jellyfin, qbit] = model.pages[0].groups[0].tiles;
  assert.equal(jellyfin.layout.phone, undefined);
  assert.equal(qbit.layout.phone, undefined);
  assert.deepEqual(jellyfin.layout.tablet, { x: 0, y: 0, w: 2, h: 1 });
  assert.deepEqual(jellyfin.layout.desktop, { x: 0, y: 0, w: 2, h: 1 });
  rejects({ op: "resetBreakpoint", pageId: "home", breakpoint: "desktop" }, "INVALID_OP");
});

test("unknown ids are NOT_FOUND", () => {
  rejects({ op: "updateTile", tileId: "nope", patch: { title: "x" } }, "NOT_FOUND");
  rejects({ op: "removeGroup", pageId: "home", groupId: "nope" }, "NOT_FOUND");
  rejects({ op: "movePage", pageId: "nope", index: 0 }, "NOT_FOUND");
});

test("malformed ops are INVALID_OP", () => {
  rejects({ op: "removeTile", tileId: "qbit", extra: 1 }, "INVALID_OP");
  rejects({ op: "explode" }, "INVALID_OP");
  rejects(null, "INVALID_OP");
  rejects({ op: "movePage", pageId: "home", index: -1 }, "INVALID_OP");
  rejects({ op: "setLayout", tileId: "qbit", breakpoint: "watch", rect: { x: 0, y: 0, w: 1, h: 1 } }, "INVALID_OP");
});

test("duplicate ids on add are INVALID_OP", () => {
  rejects({ op: "addTile", pageId: "home", groupId: "infra", tile: { ...NEW_TILE, id: "qbit" } }, "INVALID_OP");
  rejects({ op: "addPage", page: { id: "home", title: "Again", groups: [] } }, "INVALID_OP");
});

test("addTile beyond 500 is LIMIT", () => {
  let text = "version: 2\npages:\n  - id: p\n    title: P\n    groups:\n      - id: g\n        title: G\n        tiles:\n";
  for (let index = 0; index < 500; index += 1) text += `          - { id: t${index}, type: note, markdown: x }\n`;
  const document = parseLaunchpadYaml(text);
  assert.throws(() => applyLaunchpadOp(document, { op: "addTile", pageId: "p", groupId: "g", tile: NEW_TILE }),
    (error) => error.code === "LIMIT");
});

test("moving a tile to another group drops its tablet and phone rects, which belonged to the old grid", () => {
  const document = doc();
  applyLaunchpadOp(document, { op: "moveTile", tileId: "jellyfin", toPageId: "home", toGroupId: "infra", index: 0 });
  const { model } = validateLaunchpad(parseLaunchpadYaml(stringifyDocument(document)));
  const moved = model.pages[0].groups[1].tiles[0];
  assert.equal(moved.id, "jellyfin");
  assert.deepEqual(moved.layout.desktop, { x: 0, y: 0, w: 2, h: 1 });
  assert.equal(moved.layout.phone, undefined);
  assert.equal(moved.layout.tablet, undefined);
  // Reordering inside the same group keeps them.
  const same = doc();
  applyLaunchpadOp(same, { op: "moveTile", tileId: "jellyfin", toPageId: "home", toGroupId: "media", index: 1 });
  const kept = validateLaunchpad(parseLaunchpadYaml(stringifyDocument(same))).model.pages[0].groups[0].tiles[1];
  assert.deepEqual(kept.layout.phone, { x: 0, y: 0, w: 2, h: 1 });
});
