import assert from "node:assert/strict";
import test from "node:test";

import { COLUMNS, effectiveRects, placeWithPushDown, pointerToCell, reflow } from "../src/ui/launchpad-grid.js";

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

function overlapping(rects) {
  const list = [...rects.values()];
  return list.some((a, i) => list.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
}

test("push-down resolves chained collisions and returns only what moved", () => {
  const rects = new Map([
    ["a", { x: 0, y: 0, w: 2, h: 1 }],
    ["b", { x: 0, y: 1, w: 2, h: 1 }],
    ["c", { x: 0, y: 2, w: 2, h: 1 }],
    ["far", { x: 6, y: 0, w: 2, h: 1 }],
    ["mover", { x: 8, y: 0, w: 2, h: 2 }]
  ]);
  const changed = placeWithPushDown(rects, "mover", { x: 0, y: 0, w: 2, h: 2 }, 12);
  const merged = new Map([...rects, ...changed]);
  assert.equal(overlapping(merged), false);
  assert.deepEqual(changed.get("mover"), { x: 0, y: 0, w: 2, h: 2 });
  assert.ok(changed.has("a") && changed.has("b") && changed.has("c"));
  assert.equal(changed.has("far"), false, "untouched tiles are not reported");
  assert.deepEqual(merged.get("a"), { x: 0, y: 2, w: 2, h: 1 });
});

test("push-down clamps the moved rect inside the columns", () => {
  const changed = placeWithPushDown(new Map([["t", { x: 0, y: 0, w: 2, h: 1 }]]), "t", { x: 11, y: 0, w: 3, h: 1 }, 12);
  assert.deepEqual(changed.get("t"), { x: 9, y: 0, w: 3, h: 1 });
  const wide = placeWithPushDown(new Map([["t", { x: 0, y: 0, w: 1, h: 1 }]]), "t", { x: 0, y: 0, w: 4, h: 9 }, 2);
  assert.deepEqual(wide.get("t"), { x: 0, y: 0, w: 2, h: 8 }, "width clamps to the columns and height to 8 rows");
});

test("pointerToCell maps a pointer to a grid cell", () => {
  const box = { left: 100, top: 50, width: 1210, height: 400 };
  // 12 columns, 10px gaps: each column is (1210 - 110) / 12 = 91.67px wide.
  assert.deepEqual(pointerToCell({ clientX: 100, clientY: 50 }, box, 12, 132, 10), { x: 0, y: 0 });
  assert.deepEqual(pointerToCell({ clientX: 100 + 2 * 101.67 + 5, clientY: 50 + 142 + 5 }, box, 12, 132, 10), { x: 2, y: 1 });
  assert.deepEqual(pointerToCell({ clientX: 5000, clientY: 0 }, box, 12, 132, 10), { x: 11, y: 0 });
});
