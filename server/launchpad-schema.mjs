// Launchpad v2 schema: validates a parsed launchpad.yaml Document and turns
// it into a plain, frozen model. Pure: no I/O. Every error carries the YAML
// path and the one-based line/column of the node it concerns, so a hand
// edit can be fixed from the message alone.

import { isAlias, isMap, isScalar, isSeq, positionOf } from "./yaml.mjs";

const MAX_URL_LENGTH = 500;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MEDIA_SERVICE_IDS = new Set(["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "bazarr", "qbittorrent"]);
const KINDS = new Set(["media", "environment", "service"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const ICON = /^(?:(?:dashboard-icons|mdi):[a-z0-9][a-z0-9-]{0,63}|upload:[a-f0-9]{16}\.(?:png|jpg|webp|svg))$/u;
const EMOJI_ICON = /^emoji:[^\u0000-\u001f\u007f-\u009f\s]{1,16}$/u;

export const COLUMNS = Object.freeze({ desktop: 12, tablet: 6, phone: 2 });
export const BREAKPOINTS = Object.freeze(["desktop", "tablet", "phone"]);
export const TILE_TYPES = Object.freeze(["link", "folder", "note", "search", "iframe"]);
export const LAUNCHPAD_LIMITS = Object.freeze({
  pages: 20,
  groups: 50,
  tiles: 500,
  folderLinks: 24,
  noteBytes: 4096,
  cssBytes: 32 * 1024,
  fileBytes: 512 * 1024,
  maxTileHeight: 8,
  maxRow: 999,
  titleLength: 80,
  urlLength: MAX_URL_LENGTH
});

export function launchpadKey(kind, id) {
  if (!KINDS.has(kind) || typeof id !== "string") return null;
  if (kind === "media" ? !MEDIA_SERVICE_IDS.has(id) : !UUID.test(id)) return null;
  return `${kind}:${id}`;
}

/**
 * Returns the canonical form of a browser-facing http(s) address, or null when
 * the value is not one. Rejects embedded credentials, control characters and
 * anything other than http: or https:.
 */
export function canonicalLaunchUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH || CONTROL.test(value)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    return null;
  }
  const href = parsed.href;
  return href.length <= MAX_URL_LENGTH ? href : null;
}

/** Validates a search tile's engine: the literal "tiles" or an https template with one {query}. */
export function canonicalSearchEngine(value) {
  if (value === "tiles") return "tiles";
  if (typeof value !== "string" || value.split("{query}").length !== 2) return null;
  const probe = canonicalLaunchUrl(value.replace("{query}", "q"));
  if (!probe || !probe.startsWith("https:")) return null;
  return value.length <= MAX_URL_LENGTH ? value : null;
}

export function emptyLaunchpadModel() {
  return deepFreeze({ version: 2, theme: { tokens: {}, css: "" }, pages: [] });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function joinPath(base, key) {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/**
 * Validates a launchpad Document. Returns `{ model, errors }`; `model` is
 * null whenever there is at least one error.
 */
export function validateLaunchpad(doc) {
  const errors = [];

  function report(node, path, message) {
    const { line, column } = positionOf(doc, node?.range?.[0]);
    errors.push({ message, path, line, column });
  }

  for (const error of doc.errors || []) {
    const position = error.linePos?.[0] || { line: 0, col: 0 };
    errors.push({ message: String(error.message).split("\n")[0], path: "", line: position.line, column: position.col });
  }
  if (errors.length) return { model: null, errors };

  // Anchors and aliases are refused outright: they make hand-written files
  // hard to read and an alias chain can expand to an enormous document.
  (function scan(node) {
    if (!node || typeof node !== "object") return;
    if (isAlias(node) || node.anchor) {
      report(node, "", "YAML anchors and aliases are not supported in launchpad.yaml.");
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        scan(pair.key);
        scan(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) scan(item);
    }
  })(doc.contents);
  if (errors.length) return { model: null, errors };

  if (doc.contents === null || doc.contents === undefined
    || (isScalar(doc.contents) && (doc.contents.value === null || doc.contents.value === ""))) {
    return { model: emptyLaunchpadModel(), errors: [] };
  }

  const counts = { groups: 0, tiles: 0 };
  const tileIds = new Set();

  // Reads a map against a table of per-key readers. Unknown keys and
  // missing required keys become errors; the result holds only read keys.
  function readMap(node, path, readers, { required = [], reserved = [] } = {}) {
    if (!isMap(node)) {
      report(node, path, `${path || "The file"} must be a mapping of keys to values.`);
      return null;
    }
    const result = {};
    const seen = new Set();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key.value : null;
      const keyPath = joinPath(path, String(key));
      if (typeof key !== "string") {
        report(pair.key, path, "Keys must be plain text.");
        continue;
      }
      seen.add(key);
      if (reserved.includes(key)) {
        report(pair.key, keyPath, `"${key}" is reserved for a later Helmsman release and cannot be used yet.`);
        continue;
      }
      const reader = readers[key];
      if (!reader) {
        report(pair.key, keyPath, `Unknown key "${key}".`);
        continue;
      }
      const value = reader(pair.value, keyPath);
      if (value !== undefined) result[key] = value;
    }
    for (const key of required) {
      if (!seen.has(key)) report(node, joinPath(path, key), `"${key}" is required.`);
    }
    return result;
  }

  function scalar(node) {
    return isScalar(node) ? node.value : undefined;
  }

  function text(maxLength, { optional = false } = {}) {
    return (node, path) => {
      const value = scalar(node);
      if (optional && (value === null || value === undefined)) return undefined;
      if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
        report(node, path, `Enter text of 1 to ${maxLength} characters.`);
        return undefined;
      }
      return value;
    };
  }

  function slug(node, path) {
    const value = scalar(node);
    if (typeof value !== "string" || !SLUG.test(value)) {
      report(node, path, "Use an id of lowercase letters, digits and dashes (up to 48), starting with a letter or digit.");
      return undefined;
    }
    return value;
  }

  function boolean(node, path) {
    const value = scalar(node);
    if (typeof value !== "boolean") {
      report(node, path, "Use true or false.");
      return undefined;
    }
    return value;
  }

  function integer(min, max) {
    return (node, path) => {
      const value = scalar(node);
      if (!Number.isInteger(value) || value < min || value > max) {
        report(node, path, `Use a whole number from ${min} to ${max}.`);
        return undefined;
      }
      return value;
    };
  }

  function oneOf(values) {
    return (node, path) => {
      const value = scalar(node);
      if (!values.includes(value)) {
        report(node, path, `Use one of: ${values.join(", ")}.`);
        return undefined;
      }
      return value;
    };
  }

  function url(node, path) {
    const value = canonicalLaunchUrl(scalar(node));
    if (!value) report(node, path, "Enter an http or https address without a user name or password.");
    return value ?? undefined;
  }

  function color(node, path) {
    const value = scalar(node);
    if (typeof value !== "string" || !COLOR.test(value)) {
      report(node, path, "Use a color like #7c5cff or #abc.");
      return undefined;
    }
    return value.toLowerCase();
  }

  function icon(node, path) {
    const value = scalar(node);
    if (typeof value !== "string" || !(ICON.test(value) || EMOJI_ICON.test(value))) {
      report(node, path, "Use dashboard-icons:<name>, mdi:<name>, emoji:<emoji> or an uploaded icon.");
      return undefined;
    }
    return value;
  }

  const visibility = oneOf(["owner"]);

  function rect(columns) {
    return (node, path) => {
      const value = readMap(node, path, {
        x: integer(0, columns - 1),
        y: integer(0, LAUNCHPAD_LIMITS.maxRow),
        w: integer(1, columns),
        h: integer(1, LAUNCHPAD_LIMITS.maxTileHeight)
      }, { required: ["x", "y", "w", "h"] });
      if (!value || Object.keys(value).length !== 4) return undefined;
      if (value.x + value.w > columns) {
        report(node, path, `The tile does not fit: x + w must be at most ${columns} columns.`);
        return undefined;
      }
      return value;
    };
  }

  function layout(node, path) {
    return readMap(node, path, {
      desktop: rect(COLUMNS.desktop),
      tablet: rect(COLUMNS.tablet),
      phone: rect(COLUMNS.phone)
    }) ?? undefined;
  }

  function style(node, path) {
    const value = readMap(node, path, {
      accent: color,
      background: oneOf(["glass", "solid", "none"]),
      hideLabel: boolean
    });
    return value ?? undefined;
  }

  function managed(node, path) {
    const kind = isMap(node) ? scalar(node.get("kind", true)) : undefined;
    const kindReader = oneOf(["media", "environment", "service", "container", "workload"]);
    if (kindReader(isMap(node) ? node.get("kind", true) : node, joinPath(path, "kind")) === undefined) return undefined;
    if (kind === "container") {
      const value = readMap(node, path, {
        kind: () => "container",
        service: uuid,
        environment: integer(0, 2_147_483_647),
        name: (child, childPath) => {
          const name = scalar(child);
          if (typeof name !== "string" || !CONTAINER_NAME.test(name)) {
            report(child, childPath, "Use the container's name as Portainer shows it.");
            return undefined;
          }
          return name;
        }
      }, { required: ["service", "environment", "name"] });
      return value && Object.keys(value).length === 4 ? value : undefined;
    }
    if (kind === "workload") {
      const value = readMap(node, path, {
        kind: () => "workload",
        environment: uuid,
        vmid: integer(1, 999_999_999)
      }, { required: ["environment", "vmid"] });
      return value && Object.keys(value).length === 3 ? value : undefined;
    }
    const value = readMap(node, path, {
      kind: () => kind,
      id: (child, childPath) => {
        const id = scalar(child);
        if (!launchpadKey(kind, id)) {
          report(child, childPath, kind === "media"
            ? `Use one of: ${[...MEDIA_SERVICE_IDS].join(", ")}.`
            : "Use the connection's id from Helmsman.");
          return undefined;
        }
        return id;
      }
    }, { required: ["id"] });
    return value && Object.keys(value).length === 2 ? value : undefined;
  }

  function uuid(node, path) {
    const value = scalar(node);
    if (typeof value !== "string" || !UUID.test(value)) {
      report(node, path, "Use the connection's id from Helmsman.");
      return undefined;
    }
    return value;
  }

  function folderLinks(node, path) {
    if (!isSeq(node)) {
      report(node, path, "List the folder's links.");
      return undefined;
    }
    if (node.items.length > LAUNCHPAD_LIMITS.folderLinks) {
      report(node, path, `A folder holds at most ${LAUNCHPAD_LIMITS.folderLinks} links.`);
      return undefined;
    }
    return node.items.map((item, index) => readMap(item, joinPath(path, index), {
      title: text(LAUNCHPAD_LIMITS.titleLength),
      url
    }, { required: ["title", "url"] })).filter(Boolean);
  }

  function markdown(node, path) {
    const value = scalar(node);
    if (typeof value !== "string" || Buffer.byteLength(value) > LAUNCHPAD_LIMITS.noteBytes) {
      report(node, path, `A note holds at most ${LAUNCHPAD_LIMITS.noteBytes} bytes of Markdown.`);
      return undefined;
    }
    return value;
  }

  function engine(node, path) {
    const value = canonicalSearchEngine(scalar(node));
    if (!value) report(node, path, "Use tiles, or an https search address containing {query} exactly once.");
    return value ?? undefined;
  }

  const COMMON = {
    id: slug,
    type: oneOf(TILE_TYPES),
    title: text(LAUNCHPAD_LIMITS.titleLength),
    icon,
    style,
    visibility,
    layout
  };
  const BY_TYPE = {
    link: { url, open: oneOf(["newTab", "sameTab"]), managed },
    folder: { links: folderLinks },
    note: { markdown },
    search: { engine },
    iframe: { url }
  };
    // Notes, search boxes and embeds read fine without a label, so only links
  // and folders must be titled. A tile without a layout is placed after the
  // laid-out tiles of its group, so hand-written files can skip coordinates.
  const REQUIRED_BY_TYPE = {
    link: ["title", "url"],
    folder: ["title", "links"],
    note: ["markdown"],
    search: ["engine"],
    iframe: ["url"]
  };

  function tile(node, path) {
    const type = isMap(node) ? scalar(node.get("type", true)) : undefined;
    const typeReaders = BY_TYPE[type] || {};
    const value = readMap(node, path, { ...COMMON, ...typeReaders }, {
      required: ["id", "type", ...(REQUIRED_BY_TYPE[type] || [])],
      reserved: ["widget"]
    });
    if (!value) return null;
    if (value.id) {
      if (tileIds.has(value.id)) report(node, joinPath(path, "id"), `Tile id "${value.id}" is used twice; ids must be unique.`);
      tileIds.add(value.id);
    }
    const result = {
      layout: {},
      ...value,
      visibility: value.visibility ?? "owner",
      style: { background: "glass", hideLabel: false, ...(value.style || {}) }
    };
    if (type === "link") result.open = value.open ?? "newTab";
    return result;
  }

  function list(node, path, itemReader, limit, limitMessage) {
    if (!isSeq(node)) {
      report(node, path, `${path} must be a list.`);
      return undefined;
    }
    if (limit !== null && node.items.length > limit) report(node, path, limitMessage);
    return node.items.map((item, index) => itemReader(item, joinPath(path, index))).filter(Boolean);
  }

  function group(node, path) {
    counts.groups += 1;
    const value = readMap(node, path, {
      id: slug,
      title: text(LAUNCHPAD_LIMITS.titleLength),
      collapsed: boolean,
      visibility,
      tiles: (child, childPath) => list(child, childPath, (item, itemPath) => {
        counts.tiles += 1;
        return tile(item, itemPath);
      }, null, "")
    }, { required: ["id", "title"] });
    if (!value) return null;
    return { ...value, collapsed: value.collapsed ?? false, visibility: value.visibility ?? "owner", tiles: value.tiles ?? [] };
  }

  function page(node, path) {
    const value = readMap(node, path, {
      id: slug,
      title: text(LAUNCHPAD_LIMITS.titleLength),
      icon,
      visibility,
      groups: (child, childPath) => {
        const groups = list(child, childPath, group, null, "");
        const ids = new Set();
        for (const [index, entry] of (groups || []).entries()) {
          if (ids.has(entry.id)) report(child.items[index], joinPath(joinPath(childPath, index), "id"), `Group id "${entry.id}" is used twice on this page; ids must be unique.`);
          ids.add(entry.id);
        }
        return groups;
      }
    }, { required: ["id", "title"] });
    if (!value) return null;
    return { ...value, visibility: value.visibility ?? "owner", groups: value.groups ?? [] };
  }

  function theme(node, path) {
    return readMap(node, path, {
      tokens: (child, childPath) => readMap(child, childPath, {
        accent: color,
        radius: integer(0, 32),
        density: oneOf(["compact", "comfortable", "spacious"])
      }) ?? undefined,
      css: (child, childPath) => {
        const value = scalar(child);
        if (typeof value !== "string" || Buffer.byteLength(value) > LAUNCHPAD_LIMITS.cssBytes) {
          report(child, childPath, `Custom CSS holds at most ${LAUNCHPAD_LIMITS.cssBytes} bytes.`);
          return undefined;
        }
        return value;
      }
    }) ?? undefined;
  }

  const root = readMap(doc.contents, "", {
    version: (node, path) => {
      if (scalar(node) !== 2) report(node, path, "Use version: 2.");
      return 2;
    },
    theme,
    pages: (node, path) => {
      const pages = list(node, path, page, LAUNCHPAD_LIMITS.pages, `A launchpad holds at most ${LAUNCHPAD_LIMITS.pages} pages.`);
      const ids = new Set();
      for (const [index, entry] of (pages || []).entries()) {
        if (ids.has(entry.id)) report(node.items[index], joinPath(joinPath(path, index), "id"), `Page id "${entry.id}" is used twice; ids must be unique.`);
        ids.add(entry.id);
      }
      return pages;
    }
  });

  if (counts.groups > LAUNCHPAD_LIMITS.groups) report(doc.contents, "pages", `A launchpad holds at most ${LAUNCHPAD_LIMITS.groups} groups.`);
  if (counts.tiles > LAUNCHPAD_LIMITS.tiles) report(doc.contents, "pages", `A launchpad holds at most ${LAUNCHPAD_LIMITS.tiles} tiles.`);

  if (errors.length || !root) return { model: null, errors };
  return {
    model: deepFreeze({
      version: 2,
      theme: { tokens: root.theme?.tokens ?? {}, css: root.theme?.css ?? "" },
      pages: root.pages ?? []
    }),
    errors: []
  };
}

/** Distinct origins of the model's iframe tiles, in file order, for the shell's CSP frame-src. */
export function launchpadFrameOrigins(model) {
  const origins = [];
  for (const page of model?.pages || []) {
    for (const group of page.groups || []) {
      for (const tile of group.tiles || []) {
        if (tile.type !== "iframe") continue;
        const url = canonicalLaunchUrl(tile.url);
        if (!url) continue;
        const { origin } = new URL(url);
        if (!origins.includes(origin)) origins.push(origin);
      }
    }
  }
  return origins;
}
