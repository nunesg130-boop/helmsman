// Launchpad grid math. Pure, so Node tests can import it.
//
// Desktop has 12 columns, tablet 6, phone 2 (kept in step with
// server/launchpad-schema.mjs). A breakpoint without its own rects reflows
// from the desktop layout in reading order. Tiles with no rect for the
// breakpoint take the first free space, never back-filling before earlier
// tiles, the same way CSS grid's auto-placement works.

export const COLUMNS = Object.freeze({ desktop: 12, tablet: 6, phone: 2 });
const DEFAULT_SIZE = Object.freeze({ w: 2, h: 1 });

function clampRect(rect, columns) {
  const w = Math.max(1, Math.min(columns, rect.w));
  const x = Math.max(0, Math.min(columns - w, rect.x));
  return { x, y: Math.max(0, rect.y), w, h: Math.max(1, rect.h) };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function readingOrder(tiles) {
  return tiles
    .map((tile, index) => ({ tile, index, desktop: tile.layout?.desktop }))
    .sort((left, right) => {
      if (left.desktop && right.desktop) {
        return left.desktop.y - right.desktop.y || left.desktop.x - right.desktop.x || left.index - right.index;
      }
      if (left.desktop) return -1;
      if (right.desktop) return 1;
      return left.index - right.index;
    })
    .map(({ tile }) => tile);
}

// Places `size` at the first free spot at or after the cursor, reading
// left to right, top to bottom.
function autoPlace(size, columns, placed, cursor) {
  const w = Math.min(columns, size.w);
  for (let y = cursor.y; y < cursor.y + 10_000; y += 1) {
    for (let x = y === cursor.y ? cursor.x : 0; x + w <= columns; x += 1) {
      const candidate = { x, y, w, h: size.h };
      if (!placed.some((rect) => overlaps(rect, candidate))) return candidate;
    }
  }
  return { x: 0, y: cursor.y, w, h: size.h };
}

function pack(tiles, columns, fixed) {
  const result = new Map();
  const placed = [];
  for (const [id, rect] of fixed) {
    result.set(id, rect);
    placed.push(rect);
  }
  let cursor = { x: 0, y: 0 };
  for (const tile of tiles) {
    if (result.has(tile.id)) continue;
    const source = tile.layout?.desktop || DEFAULT_SIZE;
    const rect = autoPlace({ w: source.w, h: source.h }, columns, placed, cursor);
    result.set(tile.id, rect);
    placed.push(rect);
    cursor = { x: rect.x + rect.w, y: rect.y };
  }
  return result;
}

/** Reflows a group's tiles to a breakpoint from their desktop layout. */
export function reflow(tiles, breakpoint) {
  return pack(readingOrder(tiles), COLUMNS[breakpoint] || COLUMNS.desktop, new Map());
}

/**
 * The rects to draw a group with at `breakpoint`: the breakpoint's own rects
 * once any tile has one (desktop always does), otherwise a reflow. Tiles
 * missing a rect take the first free space.
 */
export function effectiveRects(tiles, breakpoint) {
  const columns = COLUMNS[breakpoint] || COLUMNS.desktop;
  const own = tiles.filter((tile) => tile.layout?.[breakpoint]);
  if (breakpoint !== "desktop" && own.length === 0) return reflow(tiles, breakpoint);
  const fixed = new Map(own.map((tile) => [tile.id, clampRect(tile.layout[breakpoint], columns)]));
  return pack(readingOrder(tiles), columns, fixed);
}

/** Whether a breakpoint follows desktop (no tile in the group has its own rect). */
export function followsDesktop(tiles, breakpoint) {
  return breakpoint !== "desktop" && !tiles.some((tile) => tile.layout?.[breakpoint]);
}

/** Picks the breakpoint for a launchpad that is `width` CSS pixels wide. */
export function breakpointForWidth(width) {
  if (width >= 1100) return "desktop";
  if (width >= 640) return "tablet";
  return "phone";
}
