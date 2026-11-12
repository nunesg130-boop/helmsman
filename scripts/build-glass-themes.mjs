#!/usr/bin/env node
// Builds src/ui/theme-glass-dark.css and src/ui/theme-glass-light.css.
//
//   node scripts/build-glass-themes.mjs          # rewrite both files
//   node scripts/build-glass-themes.mjs --check  # fail if either is out of date
//
// Helmsman's stylesheets carry well over a thousand colours written straight
// into rules, so a theme cannot be a handful of custom properties. Instead of
// editing those stylesheets (the Default theme must stay exactly as it is),
// this script reads them and writes, for each glass theme, a copy of every
// colour, shadow and corner declaration under html[data-theme="..."], with
// the colours translated for that theme. Every such declaration is copied,
// changed or not, so rules keep the order and relative weight they have in
// the Default theme.
//
// The hand-written half lives in scripts/themes/ (glass-shared.css, then
// glass-dark.css or glass-light.css) and is placed after the generated
// rules, so it has the last word.
//
// Run this again after changing colours in any stylesheet listed in SOURCES.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  "styles.css",
  "src/ui/operations.css",
  "src/ui/control.css",
  "src/ui/logging.css",
  "src/ui/retro.css",
  "src/ui/obsidian-glass.css",
  "src/ui/network-map.css",
  "src/ui/selftest.css",
  "src/ui/launchpad.css"
];
const SHARED_SOURCE = "scripts/themes/glass-shared.css";
const sourceFor = (id) => `scripts/themes/${id}.css`;
const outputFor = (id) => `src/ui/theme-${id}.css`;

const TEXT_PROPS = new Set(["color", "fill", "stroke", "caret-color", "text-decoration-color", "-webkit-text-fill-color", "text-decoration", "accent-color", "scrollbar-color"]);
const BORDER_PROPS = /^(border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(-color)?|outline(-color)?|column-rule(-color)?)$/u;
const SHADOW_PROPS = new Set(["box-shadow", "text-shadow", "filter", "-webkit-filter"]);
const FILL_PROPS = new Set(["background", "background-color", "background-image"]);
const RADIUS_PROPS = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/u;

// Rules that paint over artwork (posters, backdrops, the helper) keep their
// dark scrims and white text in every theme.
const ARTWORK = /(media-overview-resume|hero-(shade|content|meta|progress|actions|art)|discover-copy|poster-(art|monogram|type|state|progress)|media-overview-poster|drawer-poster|agent-helper__(buddy|stage|canvas|float)|svg-sprite)/u;

function kindOf(property) {
  if (property.startsWith("--")) {
    if (/(text|ink|fg|muted|label)/u.test(property)) return "text";
    if (/(line|border|edge|rule|frame|ring)/u.test(property)) return "border";
    if (/(shadow|glow)/u.test(property)) return "shadow";
    return "fill";
  }
  if (TEXT_PROPS.has(property)) return "text";
  if (BORDER_PROPS.test(property)) return "border";
  if (SHADOW_PROPS.has(property)) return "shadow";
  if (FILL_PROPS.has(property)) return "fill";
  if (RADIUS_PROPS.test(property)) return "radius";
  return null;
}

// ------------------------------------------------------------- colours --

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function format([r, g, b], a) {
  const alpha = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000;
  if (alpha >= 1) return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const INK_HUE = 150;

/** One colour, translated for Glass Light. */
function lightColour(r, g, b, a, kind) {
  const [h, s, l] = rgbToHsl(r, g, b);
  // Very dark tinted colours (deep teal wells, near-black greens) are
  // surfaces, not accents: treat them as neutral so they turn light.
  const neutral = s < 0.2 || l < 0.07 || l > 0.96 || (l < 0.2 && kind !== "text") || (l < 0.12 && kind === "text");
  if (kind === "text") {
    if (neutral) {
      // Light text becomes dark ink; dark text (it sat on a bright fill)
      // becomes white, because bright fills turn deep in this theme.
      if (l > 0.2) return format(hslToRgb(INK_HUE, 0.16, clamp((1 - l) * 0.78 + 0.07, 0.07, 0.36)), a >= 1 ? 1 : clamp(a * 1.2 + 0.12, 0, 1));
      return format(hslToRgb(INK_HUE, 0.1, clamp(1 - l * 0.4, 0.9, 1)), a);
    }
    return format(hslToRgb(h, clamp(s, 0, 0.78), Math.min(l, h > 20 && h < 180 ? 0.22 : 0.31)), a >= 1 ? 1 : clamp(a * 1.15, 0, 1));
  }
  if (kind === "border") {
    if (neutral) {
      if (l > 0.5) return a < 1 ? format(hslToRgb(INK_HUE, 0.3, 0.16), clamp(a * 1.7, 0, 0.6)) : format(hslToRgb(INK_HUE, 0.12, clamp(1 - l + 0.12, 0.3, 0.8)), 1);
      return a < 1 ? format(hslToRgb(INK_HUE, 0.3, 0.16), clamp(a * 0.5, 0, 0.4)) : format(hslToRgb(INK_HUE, 0.1, clamp(1 - l * 1.4, 0.74, 0.9)), 1);
    }
    return format(hslToRgb(h, clamp(s, 0, 0.75), Math.min(l, 0.34)), a >= 1 ? 1 : clamp(a * 1.5, 0, 1));
  }
  if (kind === "shadow") {
    if (neutral) {
      if (l > 0.5) return format([255, 255, 255], clamp(a * 9, 0, 0.9));
      return format(hslToRgb(INK_HUE, 0.45, 0.14), a * 0.34);
    }
    return format(hslToRgb(h, clamp(s, 0, 0.7), Math.min(l, 0.36)), a * 0.75);
  }
  // Fills.
  if (neutral) {
    if (l < 0.55) {
      // Dark surfaces become frosted white. The darkest ones (the page) end
      // up brightest so nested panels read as lighter layers.
      const alpha = a < 0.3 ? a : clamp(a * 0.74, 0.3, 0.78);
      return format(hslToRgb(INK_HUE, 0.2, clamp(1 - l * 0.45, 0.93, 0.995)), alpha);
    }
    // White veils (hover and pressed washes) become ink veils.
    if (a < 0.9) return format(hslToRgb(INK_HUE, 0.35, 0.18), clamp(a * 1.15, 0, 0.5));
    return format(hslToRgb(INK_HUE, 0.14, clamp((1 - l) + 0.1, 0.1, 0.3)), a);
  }
  if (a < 0.6) return format(hslToRgb(h, clamp(s, 0, 0.7), Math.min(l, 0.38)), clamp(a * 1.25, 0, 0.6));
  return format(hslToRgb(h, clamp(s, 0, 0.72), Math.min(l, h > 90 && h < 180 ? 0.25 : 0.36)), a);
}

/**
 * One colour, translated for Glass Dark. Opaque dark fills turn translucent
 * so the glow shows through, and quiet greys lift slightly so they stay
 * readable on the lighter glass. Everything else is left as it is.
 */
function darkColour(r, g, b, a, kind) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (kind === "text" && s < 0.2 && l > 0.36 && l < 0.58 && a >= 1) return format(hslToRgb(h, s, 0.58), 1);
  if (kind === "fill" && (s < 0.25 || l < 0.07) && l < 0.16 && a > 0.5) {
    return format(hslToRgb(155, 0.1, clamp(l * 1.05, 0.03, 0.13)), a * 0.6);
  }
  return null;
}

const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1] };
const COLOUR = /#([0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])|rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)|(?<![\w#-])(white|black)(?![\w-])/gu;

function translateColours(value, kind, colour) {
  return value.replace(COLOUR, (match, hex, r, g, b, alpha, named) => {
    let parts;
    if (hex) {
      if (![3, 4, 6, 8].includes(hex.length)) return match;
      const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
      parts = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
      parts.push(full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1);
    } else if (named) {
      parts = NAMED[named];
    } else {
      const a = alpha === undefined ? 1 : alpha.endsWith("%") ? Number(alpha.slice(0, -1)) / 100 : Number(alpha);
      parts = [Number(r), Number(g), Number(b), a].map((v, i) => (i < 3 ? Math.round(v) : v));
    }
    return colour(parts[0], parts[1], parts[2], parts[3], kind) ?? match;
  });
}

function roundCorner(value) {
  return value.replace(/(?<![\w.-])(\d+(?:\.\d+)?)px/gu, (match, digits) => {
    const size = Number(digits);
    if (size < 6 || size > 20) return match;
    return `${size + (size < 12 ? 4 : 6)}px`;
  });
}

// --------------------------------------------------------------- parse --

function parseBlocks(css) {
  const nodes = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open === -1) break;
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = css.slice(open + 1, cursor - 1);
    if (prelude.startsWith("@")) {
      if (/^@(media|supports|container|layer)\b/u.test(prelude)) nodes.push({ at: prelude.replace(/\s+/gu, " "), children: parseBlocks(body) });
    } else if (prelude) {
      nodes.push({ selector: prelude.replace(/\s+/gu, " "), declarations: parseDeclarations(body) });
    }
    index = cursor;
  }
  return nodes;
}

function parseDeclarations(body) {
  const declarations = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i += 1) {
    const char = body[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if ((char === ";" && depth === 0) || i === body.length) {
      const text = body.slice(start, i).trim();
      start = i + 1;
      const colon = text.indexOf(":");
      if (colon < 1) continue;
      declarations.push({ property: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim().replace(/\s+/gu, " ") });
    }
  }
  return declarations;
}

function splitSelectors(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= selector.length; i += 1) {
    const char = selector[i];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if ((char === "," && depth === 0) || i === selector.length) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  return parts.filter(Boolean);
}

function scopeSelector(selector, theme) {
  const attribute = `[data-theme="${theme}"]`;
  return splitSelectors(selector).map((part) => {
    const root = /^(:root|html)(?![\w-])/u.exec(part);
    if (root) return `${root[1]}${attribute}${part.slice(root[1].length)}`;
    return `html${attribute} ${part}`;
  }).join(",");
}

// ---------------------------------------------------------------- emit --

const THEMES = [
  { id: "glass-dark", label: "Glass Dark", colour: darkColour, kinds: new Set(["text", "fill", "radius"]) },
  { id: "glass-light", label: "Glass Light", colour: lightColour, kinds: new Set(["text", "border", "shadow", "fill", "radius"]) }
];

function emit(nodes, theme, lines, indent = "") {
  for (const node of nodes) {
    if (node.at) {
      const inner = [];
      emit(node.children, theme, inner, `${indent} `);
      if (inner.length) lines.push(`${indent}${node.at}{`, ...inner, `${indent}}`);
      continue;
    }
    const artwork = ARTWORK.test(node.selector);
    const out = [];
    for (const { property, value } of node.declarations) {
      const kind = kindOf(property);
      if (!kind || !theme.kinds.has(kind)) continue;
      // Custom properties are only copied when their colours change;
      // anything else would repeat every token for no effect.
      let next = value;
      if (kind === "radius") next = roundCorner(value);
      else if (!artwork) next = translateColours(value, kind, theme.colour);
      if (property.startsWith("--") && next === value) continue;
      if (property === "filter" || property === "-webkit-filter" || property === "text-decoration") {
        if (next === value) continue;
      }
      out.push(`${property}:${next}`);
    }
    if (out.length) lines.push(`${indent}${scopeSelector(node.selector, theme.id)}{${out.join(";")}}`);
  }
}

function build(theme, parsed) {
  const lines = [
    "/*",
    ` * Helmsman theme: ${theme.label}.`,
    " *",
    " * GENERATED FILE. Do not edit. Change the hand-written rules in",
    ` * scripts/themes/glass-shared.css and scripts/themes/${theme.id}.css, or the`,
    " * colour translation in scripts/build-glass-themes.mjs, then run:",
    " *",
    " *   node scripts/build-glass-themes.mjs",
    " *",
    ` * Every rule is scoped to html[data-theme="${theme.id}"], and this file is`,
    " * only loaded while that theme is chosen.",
    " */",
    "",
    "/* ---- translated from the Default stylesheets ---- */"
  ];
  for (const nodes of parsed) emit(nodes, theme, lines);
  lines.push("", `/* ---- hand-written: ${SHARED_SOURCE} ---- */`, readFileSync(path.join(ROOT, SHARED_SOURCE), "utf8").trimEnd());
  lines.push("", `/* ---- hand-written: ${sourceFor(theme.id)} ---- */`, readFileSync(path.join(ROOT, sourceFor(theme.id)), "utf8").trimEnd(), "");
  return lines.join("\n");
}

const parsed = SOURCES.map((file) => parseBlocks(readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")));
const check = process.argv.includes("--check");
let stale = false;
for (const theme of THEMES) {
  const output = build(theme, parsed);
  const target = path.join(ROOT, outputFor(theme.id));
  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // Missing counts as out of date.
    }
    if (current !== output) {
      stale = true;
      console.error(`${outputFor(theme.id)} is out of date. Run: node scripts/build-glass-themes.mjs`);
    } else {
      console.log(`${outputFor(theme.id)} is up to date.`);
    }
  } else {
    writeFileSync(target, output);
    console.log(`Wrote ${outputFor(theme.id)} (${(Buffer.byteLength(output) / 1024).toFixed(0)} KB).`);
  }
}
if (stale) process.exit(1);
