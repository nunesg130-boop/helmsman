import assert from "node:assert/strict";
import test from "node:test";

import { COLUMNS, effectiveRects, reflow } from "../src/ui/launchpad-grid.js";

function tile(id, desktop, extra = {}) {
  return { id, layout: { ...(desktop ? { desktop } : {}), ...extra } };
}

function plain(map) {
  return Object.fromEntries([...map].map(([id, rect]) => [id, rect]));
}

test("columns match the server schema", () => {
  assert.deepEqual(COLUMNS, { desktop: 12, tablet: 6, phone: 2 });
});

test("reflow to phone stacks tiles in desktop reading order", () => {
  const tiles = [
    tile("c", { x: 8, y: 0, w: 4, h: 1 }),
    tile("a", { x: 0, y: 0, w: 4, h: 1 }),
    tile("b", { x: 4, y: 0, w: 4, h: 1 })
  ];
  assert.deepEqual(plain(reflow(tiles, "phone")), {
    a: { x: 0, y: 0, w: 2, h: 1 },
    b: { x: 0, y: 1, w: 2, h: 1 },
    c: { x: 0, y: 2, w: 2, h: 1 }
  });
});

test("reflow to tablet keeps reading order and never back-fills", () => {
  const tiles = [tile("a", { x: 0, y: 0, w: 2, h: 1 }), tile("b", { x: 2, y: 0, w: 2, h: 2 }), tile("c", { x: 4, y: 0, w: 4, h: 1 })];
  assert.deepEqual(plain(reflow(tiles, "tablet")), {
    a: { x: 0, y: 0, w: 2, h: 1 },
    b: { x: 2, y: 0, w: 2, h: 2 },
    c: { x: 0, y: 2, w: 4, h: 1 }
  });
});

test("effectiveRects uses desktop rects as written", () => {
  const tiles = [tile("a", { x: 3, y: 2, w: 2, h: 1 })];
  assert.deepEqual(plain(effectiveRects(tiles, "desktop")), { a: { x: 3, y: 2, w: 2, h: 1 } });
});

test("effectiveRects prefers a breakpoint's own rects once any tile has one", () => {
  const tiles = [
    tile("a", { x: 0, y: 0, w: 2, h: 1 }, { phone: { x: 0, y: 3, w: 1, h: 1 } }),
    tile("b", { x: 2, y: 0, w: 2, h: 1 })
  ];
  const rects = plain(effectiveRects(tiles, "phone"));
  assert.deepEqual(rects.a, { x: 0, y: 3, w: 1, h: 1 });
  assert.deepEqual(rects.b, { x: 0, y: 0, w: 2, h: 1 }, "a tile without a phone rect fills the first free space");
});

test("tiles without coordinates take the first free space", () => {
  const tiles = [tile("free"), tile("a", { x: 0, y: 0, w: 12, h: 1 })];
  assert.deepEqual(plain(effectiveRects(tiles, "desktop")), {
    a: { x: 0, y: 0, w: 12, h: 1 },
    free: { x: 0, y: 1, w: 2, h: 1 }
  });
});
