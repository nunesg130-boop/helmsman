// Launchpad v2 edit operations. Each UI change is one small operation that
// is applied to the parsed yaml Document in place, so comments, key order
// and formatting the owner wrote by hand survive. Pure: no I/O, and no
// whole-document validation (the store validates after applying).

import { BREAKPOINTS, LAUNCHPAD_LIMITS } from "./launchpad-schema.mjs";
import { isMap, isScalar, isSeq } from "./yaml.mjs";

export class LaunchpadOpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LaunchpadOpError";
    this.code = code;
  }
}

const OP_KEYS = {
  addPage: ["page"],
  updatePage: ["pageId", "patch"],
  movePage: ["pageId", "index"],
  removePage: ["pageId"],
  addGroup: ["pageId", "group"],
  updateGroup: ["pageId", "groupId", "patch"],
  moveGroup: ["pageId", "groupId", "index"],
  removeGroup: ["pageId", "groupId"],
  addTile: ["pageId", "groupId", "tile"],
  updateTile: ["tileId", "patch"],
  moveTile: ["tileId", "toPageId", "toGroupId", "index"],
  setLayout: ["tileId", "breakpoint", "rect"],
  setLayouts: ["breakpoint", "rects"],
  resetBreakpoint: ["pageId", "breakpoint"],
  removeTile: ["tileId"],
  updateTheme: ["patch"]
};

const FIXED_KEYS = {
  page: ["id", "groups"],
  group: ["id", "tiles"],
  tile: ["id", "type", "layout"]
};

function invalid(message) {
  throw new LaunchpadOpError("INVALID_OP", message);
}

function notFound(message) {
  throw new LaunchpadOpError("NOT_FOUND", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireId(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 48) invalid(`${name} is missing.`);
  return value;
}

function requireIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) invalid("Use a position of 0 or more.");
  return value;
}

function requireRect(value) {
  if (!isPlainObject(value)) invalid("A tile position needs x, y, w and h.");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "h,w,x,y" || !["x", "y", "w", "h"].every((key) => Number.isInteger(value[key]))) {
    invalid("A tile position needs whole-number x, y, w and h.");
  }
  return { x: value.x, y: value.y, w: value.w, h: value.h };
}

function scalarValue(node) {
  return isScalar(node) ? node.value : undefined;
}

function idOf(node) {
  return isMap(node) ? scalarValue(node.get("id", true)) : undefined;
}

function ensureRoot(doc) {
  if (!isMap(doc.contents)) {
    if (doc.contents && !(isScalar(doc.contents) && (doc.contents.value === null || doc.contents.value === ""))) {
      invalid("launchpad.yaml must be a mapping before it can be edited.");
    }
    doc.contents = doc.createNode({ version: 2, pages: [] });
  }
  return doc.contents;
}

// Lists Helmsman adds entries to are written in block style, even when the
// owner wrote an empty list as `[]`, so added entries stay readable.
function ensureSeq(doc, map, key) {
  let seq = map.get(key, true);
  if (!isSeq(seq)) {
    seq = doc.createNode([]);
    map.set(key, seq);
  }
  seq.flow = false;
  return seq;
}

function pagesSeq(doc) {
  return ensureSeq(doc, ensureRoot(doc), "pages");
}

function findPage(doc, pageId) {
  const pages = pagesSeq(doc);
  const index = pages.items.findIndex((node) => idOf(node) === pageId);
  if (index < 0) notFound("That page no longer exists.");
  return { pages, index, page: pages.items[index] };
}

function findGroup(doc, pageId, groupId) {
  const { page } = findPage(doc, pageId);
  const groups = ensureSeq(doc, page, "groups");
  const index = groups.items.findIndex((node) => idOf(node) === groupId);
  if (index < 0) notFound("That group no longer exists.");
  return { groups, index, group: groups.items[index] };
}

function* allGroups(doc) {
  for (const page of pagesSeq(doc).items) {
    if (!isMap(page)) continue;
    const groups = page.get("groups", true);
    if (!isSeq(groups)) continue;
    for (const group of groups.items) if (isMap(group)) yield { page, group };
  }
}

function* allTiles(doc) {
  for (const { page, group } of allGroups(doc)) {
    const tiles = group.get("tiles", true);
    if (!isSeq(tiles)) continue;
    for (const [index, tile] of tiles.items.entries()) yield { page, group, tiles, index, tile };
  }
}

function findTile(doc, tileId) {
  for (const entry of allTiles(doc)) {
    if (idOf(entry.tile) === tileId) return entry;
  }
  return notFound("That tile no longer exists.");
}

function rectNode(doc, rect) {
  const node = doc.createNode(rect);
  node.flow = true;
  return node;
}

function newNode(doc, value) {
  const node = doc.createNode(value);
  // Keep tile positions compact on one line, as people write them by hand.
  if (isMap(node)) {
    const layout = node.get("layout", true);
    if (isMap(layout)) for (const pair of layout.items) if (isMap(pair.value)) pair.value.flow = true;
  }
  return node;
}

function applyPatch(doc, node, patch, fixed) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) invalid("Say what to change.");
  for (const [key, value] of Object.entries(patch)) {
    if (fixed.includes(key)) invalid(`"${key}" cannot be changed this way.`);
    if (value === null) node.delete(key);
    else node.set(key, newNode(doc, value));
  }
}

// yaml attaches a comment written above a list's first item to the list
// itself. Hand it to the item before reordering, so the comment travels
// with the entry it describes.
function claimLeadingComment(seq) {
  const first = seq.items[0];
  if (first && seq.commentBefore && !first.commentBefore && typeof first === "object") {
    first.commentBefore = seq.commentBefore;
    seq.commentBefore = undefined;
  }
  return seq;
}

function moveWithin(seq, from, to) {
  claimLeadingComment(seq);
  const [item] = seq.items.splice(from, 1);
  seq.items.splice(Math.min(to, seq.items.length), 0, item);
}

function requireNewItem(value, kind) {
  if (!isPlainObject(value)) invalid(`Describe the new ${kind}.`);
  requireId(value.id, `The ${kind} id`);
  return value;
}

function ensureLayoutMap(doc, tile) {
  let layout = tile.get("layout", true);
  if (!isMap(layout)) {
    layout = doc.createNode({});
    tile.set("layout", layout);
  }
  return layout;
}

function requireBreakpoint(value) {
  if (!BREAKPOINTS.includes(value)) invalid("Choose desktop, tablet or phone.");
  return value;
}

/**
 * Applies one operation to `doc` in place. Throws LaunchpadOpError with code
 * INVALID_OP, NOT_FOUND or LIMIT; the document is unchanged when it throws
 * before any mutation, and the store discards it otherwise.
 */
export function applyLaunchpadOp(doc, op) {
  if (!isPlainObject(op) || typeof op.op !== "string" || !Object.hasOwn(OP_KEYS, op.op)) {
    invalid("That launchpad change is not recognized.");
  }
  const expected = ["op", ...OP_KEYS[op.op]].sort().join(",");
  if (Object.keys(op).sort().join(",") !== expected) invalid("That launchpad change has unexpected fields.");

  switch (op.op) {
    case "addPage": {
      const page = requireNewItem(op.page, "page");
      const pages = pagesSeq(doc);
      if (pages.items.length >= LAUNCHPAD_LIMITS.pages) throw new LaunchpadOpError("LIMIT", `A launchpad holds at most ${LAUNCHPAD_LIMITS.pages} pages.`);
      if (pages.items.some((node) => idOf(node) === page.id)) invalid("A page with that id already exists.");
      pages.items.push(newNode(doc, { groups: [], ...page }));
      return;
    }
    case "updatePage": {
      const { page } = findPage(doc, requireId(op.pageId, "The page id"));
      applyPatch(doc, page, op.patch, FIXED_KEYS.page);
      return;
    }
    case "movePage": {
      const { pages, index } = findPage(doc, requireId(op.pageId, "The page id"));
      moveWithin(pages, index, requireIndex(op.index));
      return;
    }
    case "removePage": {
      const { pages, index } = findPage(doc, requireId(op.pageId, "The page id"));
      claimLeadingComment(pages).items.splice(index, 1);
      return;
    }
    case "addGroup": {
      const group = requireNewItem(op.group, "group");
      const { page } = findPage(doc, requireId(op.pageId, "The page id"));
      if ([...allGroups(doc)].length >= LAUNCHPAD_LIMITS.groups) throw new LaunchpadOpError("LIMIT", `A launchpad holds at most ${LAUNCHPAD_LIMITS.groups} groups.`);
      const groups = ensureSeq(doc, page, "groups");
      if (groups.items.some((node) => idOf(node) === group.id)) invalid("A group with that id already exists on this page.");
      groups.items.push(newNode(doc, { tiles: [], ...group }));
      return;
    }
    case "updateGroup": {
      const { group } = findGroup(doc, requireId(op.pageId, "The page id"), requireId(op.groupId, "The group id"));
      applyPatch(doc, group, op.patch, FIXED_KEYS.group);
      return;
    }
    case "moveGroup": {
      const { groups, index } = findGroup(doc, requireId(op.pageId, "The page id"), requireId(op.groupId, "The group id"));
      moveWithin(groups, index, requireIndex(op.index));
      return;
    }
    case "removeGroup": {
      const { groups, index } = findGroup(doc, requireId(op.pageId, "The page id"), requireId(op.groupId, "The group id"));
      claimLeadingComment(groups).items.splice(index, 1);
      return;
    }
    case "addTile": {
      const tile = requireNewItem(op.tile, "tile");
      const { group } = findGroup(doc, requireId(op.pageId, "The page id"), requireId(op.groupId, "The group id"));
      const existing = [...allTiles(doc)];
      if (existing.length >= LAUNCHPAD_LIMITS.tiles) throw new LaunchpadOpError("LIMIT", `A launchpad holds at most ${LAUNCHPAD_LIMITS.tiles} tiles.`);
      if (existing.some((entry) => idOf(entry.tile) === tile.id)) invalid("A tile with that id already exists.");
      ensureSeq(doc, group, "tiles").items.push(newNode(doc, tile));
      return;
    }
    case "updateTile": {
      const { tile } = findTile(doc, requireId(op.tileId, "The tile id"));
      applyPatch(doc, tile, op.patch, FIXED_KEYS.tile);
      return;
    }
    case "moveTile": {
      const index = requireIndex(op.index);
      const { group } = findGroup(doc, requireId(op.toPageId, "The page id"), requireId(op.toGroupId, "The group id"));
      const source = findTile(doc, requireId(op.tileId, "The tile id"));
      claimLeadingComment(source.tiles).items.splice(source.index, 1);
      const target = claimLeadingComment(ensureSeq(doc, group, "tiles"));
      target.items.splice(Math.min(index, target.items.length), 0, source.tile);
      return;
    }
    case "setLayout": {
      const breakpoint = requireBreakpoint(op.breakpoint);
      const rect = requireRect(op.rect);
      const { tile } = findTile(doc, requireId(op.tileId, "The tile id"));
      ensureLayoutMap(doc, tile).set(breakpoint, rectNode(doc, rect));
      return;
    }
    case "setLayouts": {
      const breakpoint = requireBreakpoint(op.breakpoint);
      if (!isPlainObject(op.rects) || Object.keys(op.rects).length === 0) invalid("Say which tiles moved.");
      const entries = Object.entries(op.rects).map(([tileId, rect]) => [findTile(doc, requireId(tileId, "The tile id")).tile, requireRect(rect)]);
      for (const [tile, rect] of entries) ensureLayoutMap(doc, tile).set(breakpoint, rectNode(doc, rect));
      return;
    }
    case "resetBreakpoint": {
      const breakpoint = requireBreakpoint(op.breakpoint);
      if (breakpoint === "desktop") invalid("The desktop layout cannot be reset.");
      const { page } = findPage(doc, requireId(op.pageId, "The page id"));
      for (const entry of allTiles(doc)) {
        if (entry.page !== page) continue;
        const layout = entry.tile.get("layout", true);
        if (isMap(layout)) layout.delete(breakpoint);
      }
      return;
    }
    case "removeTile": {
      const { tiles, index } = findTile(doc, requireId(op.tileId, "The tile id"));
      claimLeadingComment(tiles).items.splice(index, 1);
      return;
    }
    case "updateTheme": {
      if (!isPlainObject(op.patch) || Object.keys(op.patch).length === 0) invalid("Say what to change.");
      const root = ensureRoot(doc);
      let theme = root.get("theme", true);
      if (!isMap(theme)) {
        theme = doc.createNode({});
        root.set("theme", theme);
      }
      for (const [key, value] of Object.entries(op.patch)) {
        if (key === "tokens" && isPlainObject(value)) {
          let tokens = theme.get("tokens", true);
          if (!isMap(tokens)) {
            tokens = doc.createNode({});
            tokens.flow = true;
            theme.set("tokens", tokens);
          }
          for (const [token, tokenValue] of Object.entries(value)) {
            if (tokenValue === null) tokens.delete(token);
            else tokens.set(token, tokenValue);
          }
        } else if (value === null) {
          theme.delete(key);
        } else {
          theme.set(key, newNode(doc, value));
        }
      }
      return;
    }
    default:
      invalid("That launchpad change is not recognized.");
  }
}
