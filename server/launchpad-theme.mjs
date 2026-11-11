// Builds the Launchpad's same-origin stylesheet (GET /api/v2/launchpad/theme.css).
// Helmsman's CSP allows only `style-src 'self'`, so theme tokens, per-tile
// accents and the owner's custom CSS are served as one generated file
// rather than injected inline. Custom CSS may style anything but may not
// pull in remote resources: off-site url() and @import are removed so a
// stylesheet cannot load third-party content or leak data through requests.

const DENSITY = new Set(["compact", "comfortable", "spacious"]);

// CSS escapes: "\" then 1-6 hex digits and optional whitespace, or "\" and
// any other character. Returns [decoded character, characters consumed].
function readEscape(css, index) {
  const hex = /^[0-9a-fA-F]{1,6}/u.exec(css.slice(index + 1, index + 7));
  if (hex) {
    let length = 1 + hex[0].length;
    if (/\s/u.test(css[index + length] || "")) length += 1;
    const codePoint = Number.parseInt(hex[0], 16);
    const character = codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "�";
    return [character, length];
  }
  if (index + 1 >= css.length || css[index + 1] === "\n") return ["", 1];
  return [css[index + 1], 2];
}

// Splits CSS into characters (outside strings, with escapes decoded and
// comments dropped) and whole string tokens (kept as written, with their
// decoded value for checking). Checks then run on decoded text, so an
// escaped or double-escaped "url(" or "@import" can't slip past.
function lex(css) {
  const items = [];
  for (let index = 0; index < css.length;) {
    const character = css[index];
    if (character === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      items.push({ char: " " });
    } else if (character === '"' || character === "'") {
      let raw = character;
      let value = "";
      let cursor = index + 1;
      while (cursor < css.length && css[cursor] !== character && css[cursor] !== "\n") {
        if (css[cursor] === "\\") {
          const [decoded, length] = readEscape(css, cursor);
          raw += css.slice(cursor, cursor + length);
          value += decoded;
          cursor += length;
        } else {
          raw += css[cursor];
          value += css[cursor];
          cursor += 1;
        }
      }
      raw += character;
      index = cursor + 1;
      items.push({ string: raw, value });
    } else if (character === "\\") {
      const [decoded, length] = readEscape(css, index);
      index += length;
      // A decoded backslash would let the browser decode a second layer.
      if (!decoded || decoded === "\\") continue;
      items.push({ char: decoded, escaped: !/[A-Za-z0-9_-]|[^\x00-\x7f]/u.test(decoded) });
    } else {
      items.push({ char: character });
      index += 1;
    }
  }
  return items;
}

function allowedUrl(value) {
  const target = value.trim();
  if (/^data:/iu.test(target)) return true;
  if (target.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(target);
}

function wordAt(items, index, length = 16) {
  let word = "";
  for (let cursor = index; cursor < items.length && word.length < length && items[cursor].char !== undefined; cursor += 1) {
    word += items[cursor].char;
  }
  return word.toLowerCase();
}

function emit(item) {
  if (item.string !== undefined) return item.string.replace(/</gu, "\\3c ");
  if (item.char === "<") return "\\3c ";
  return item.escaped ? `\\${item.char}` : item.char;
}

export function sanitizeCustomCss(input) {
  const items = lex(String(input || ""));
  let output = "";
  for (let index = 0; index < items.length;) {
    const word = items[index].char !== undefined ? wordAt(items, index) : "";
    if (word.startsWith("@import")) {
      // Drop the whole rule, strings included, up to its semicolon.
      while (index < items.length && items[index].char !== ";") index += 1;
      index += 1;
      continue;
    }
    const neutral = /^(?:-webkit-image-set|image-set|expression)\s*\(/u.exec(word);
    if (neutral) {
      // image-set() takes bare URL strings, and expression() is script.
      output += "invalid(";
      index += neutral[0].length;
      continue;
    }
    if (word.startsWith("url(")) {
      let cursor = index + 4;
      while (cursor < items.length && /\s/u.test(items[cursor].char || "")) cursor += 1;
      let target = "";
      if (items[cursor]?.string !== undefined) {
        target = items[cursor].value;
        cursor += 1;
        while (cursor < items.length && /\s/u.test(items[cursor].char || "")) cursor += 1;
      } else {
        while (cursor < items.length && items[cursor].char !== undefined && items[cursor].char !== ")") {
          target += items[cursor].char;
          cursor += 1;
        }
      }
      const end = items[cursor]?.char === ")" ? cursor + 1 : cursor;
      output += allowedUrl(target) ? items.slice(index, end).map(emit).join("") : "none";
      index = end;
      continue;
    }
    output += emit(items[index]);
    index += 1;
  }
  return output;
}

/** Returns the full stylesheet for a validated launchpad model. */
export function buildLaunchpadCss(model) {
  const tokens = model?.theme?.tokens || {};
  const rules = ["/* Generated by Helmsman from launchpad.yaml. */"];
  const rootProperties = [];
  if (tokens.accent) rootProperties.push(`--lp-accent: ${tokens.accent};`);
  if (Number.isInteger(tokens.radius)) rootProperties.push(`--lp-radius: ${tokens.radius}px;`);
  if (rootProperties.length) rules.push(`.lp-root { ${rootProperties.join(" ")} }`);
  if (DENSITY.has(tokens.density)) rules.push(`/* density: ${tokens.density} (applied as data-density by the page) */`);

  // Ids are validated slugs and colors validated hex, so they need no escaping.
  for (const page of model?.pages || []) {
    for (const group of page.groups || []) {
      for (const tile of group.tiles || []) {
        if (tile.style?.accent) rules.push(`.lp-tile[data-id="${tile.id}"] { --lp-tile-accent: ${tile.style.accent}; }`);
      }
    }
  }

  const custom = sanitizeCustomCss(model?.theme?.css || "");
  if (custom.trim()) rules.push("/* Owner custom CSS */", custom);
  return `${rules.join("\n")}\n`;
}
