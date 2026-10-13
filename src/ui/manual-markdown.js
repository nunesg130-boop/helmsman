// Owner manual rendering and search.
//
// The manual is Markdown the owner wrote. This module renders a deliberate
// subset of it to HTML: headings, paragraphs, lists, tables, fenced code,
// block quotes (GitHub-style [!NOTE] alerts become callouts), rules, and the
// inline forms `code`, **bold**, *italic* and [links](https://...). Every
// piece of text is escaped before any markup is added, raw HTML in the source
// is shown as text, and links are limited to http(s) and in-page anchors, so
// the manual can never inject markup or script into Helmsman.
//
// The same pass builds a search index: one entry per heading, paragraph,
// list item, callout, code block and table row, each with an element id the
// page can scroll to.

const MAX_SECTIONS = 200;
const MAX_ENTRIES = 6000;

const STATE_WORDS = new Map([
  ...["healthy", "confirmed", "confirmed current", "resolved", "active", "running", "done", "complete", "completed",
    "validated", "enabled", "preserved", "restored", "writable", "controlled", "hardened", "current", "migrated"]
    .map((word) => [word, "healthy"]),
  ...["pending", "pending verification", "pending confirmation", "limited", "degraded", "high", "open", "reconfirm",
    "revalidate", "retest", "unverified", "unconfirmed", "unprotected", "in progress"]
    .map((word) => [word, "warning"]),
  ...["down", "critical", "failed", "not implemented", "blocked", "never available"]
    .map((word) => [word, "danger"]),
  ...["checking", "documented", "documented state", "repository release", "medium", "explained", "release", "completed migration"]
    .map((word) => [word, "info"]),
  ...["planned", "low", "rollback", "rollback copy", "source copy", "offline", "stopped", "retired", "legacy", "unknown"]
    .map((word) => [word, "neutral"])
]);

const ALERTS = Object.freeze({
  NOTE: { tone: "info", label: "Note" },
  TIP: { tone: "info", label: "Tip" },
  IMPORTANT: { tone: "accent", label: "Important" },
  WARNING: { tone: "warning", label: "Warning" },
  CAUTION: { tone: "danger", label: "Caution" }
});

export function escapeManualHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function manualSlug(value) {
  const slug = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return slug || "section";
}

/** Plain text of inline Markdown, used for search and for state matching. */
export function manualPlainText(value) {
  return String(value || "")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

export function manualStateTone(value) {
  const text = manualPlainText(value).toLowerCase().replace(/[.:]$/u, "");
  return STATE_WORDS.get(text) || null;
}

function safeHref(value) {
  const href = String(value || "").trim();
  if (/^#[a-z0-9-]{1,80}$/u.test(href)) return { href, external: false };
  try {
    const url = new URL(href);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return { href: url.href, external: true };
    }
  } catch {
    // Not an absolute URL; render the link text only.
  }
  return null;
}

function renderEmphasis(escaped) {
  return escaped
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, "<strong>$1</strong>")
    .replace(/__(?=\S)(.+?)(?<=\S)__/gu, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?=[^\w*]|$)/gu, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?=[^\w]|$)/gu, "$1<em>$2</em>");
}

function renderTextRun(text) {
  // Links first, on the raw text, so their targets are validated before
  // escaping; everything around and inside them is escaped.
  let output = "";
  let index = 0;
  const linkPattern = /\[([^\]\n]{1,300})\]\(([^)\s]{1,600})\)/gu;
  for (const match of text.matchAll(linkPattern)) {
    output += renderEmphasis(escapeManualHtml(text.slice(index, match.index)));
    const target = safeHref(match[2]);
    const label = renderEmphasis(escapeManualHtml(match[1]));
    output += target
      ? `<a href="${escapeManualHtml(target.href)}"${target.external ? " target=\"_blank\" rel=\"noopener noreferrer\"" : ""}>${label}</a>`
      : label;
    index = match.index + match[0].length;
  }
  return output + renderEmphasis(escapeManualHtml(text.slice(index)));
}

export function renderManualInline(value) {
  const text = String(value || "");
  let output = "";
  let index = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    output += renderTextRun(text.slice(index, match.index));
    output += `<code>${escapeManualHtml(match[1])}</code>`;
    index = match.index + match[0].length;
  }
  return output + renderTextRun(text.slice(index));
}

function renderCell(value) {
  const tone = manualStateTone(value);
  if (tone) return `<span class="manual-state is-${tone}"><i aria-hidden="true"></i>${escapeManualHtml(manualPlainText(value))}</span>`;
  // A leading state word followed by detail ("Pending · fsck not captured").
  const leading = String(value).match(/^\s*\*{0,2}([A-Za-z][A-Za-z ]{1,24}?)\*{0,2}\s*(?:—|–|-|·|:)\s+(.+)$/u);
  const leadingTone = leading ? manualStateTone(leading[1]) : null;
  if (leadingTone) {
    return `<span class="manual-state is-${leadingTone}"><i aria-hidden="true"></i>${escapeManualHtml(leading[1].trim())}</span> ${renderManualInline(leading[2])}`;
  }
  return renderManualInline(value);
}

function splitRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells = [];
  let current = "";
  let inCode = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "`") {
      inCode = !inCode;
      current += character;
    } else if (character === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/u;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]{0,20})\s*$/u;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u;

function isTableStart(lines, index) {
  return lines[index].includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]);
}

/**
 * Parses owner Markdown into sections. Content before the first level-two
 * heading is the introduction; a leading level-one heading is the title.
 */
export function parseManual(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  const usedIds = new Set();
  const uniqueId = (base) => {
    let id = base;
    let counter = 2;
    while (usedIds.has(id)) id = `${base}-${counter++}`;
    usedIds.add(id);
    return id;
  };

  const result = { title: "", intro: { id: "manual-intro", title: "", html: "", blocks: 0 }, sections: [], entries: [] };
  let section = result.intro;
  let blockCounter = 0;
  const parts = [];

  const addEntry = (entry) => {
    if (result.entries.length < MAX_ENTRIES && entry.text) result.entries.push(entry);
  };
  const flush = () => {
    section.html = parts.join("");
    parts.length = 0;
  };
  const blockId = () => `m-${section.id}-${++blockCounter}`;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const closer = fence[1][0];
      const isCloser = (candidate) => {
        const trimmed = candidate.trim();
        return trimmed.length >= fence[1].length && [...trimmed].every((character) => character === closer);
      };
      const body = [];
      index += 1;
      while (index < lines.length && !isCloser(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const id = blockId();
      const code = body.join("\n");
      parts.push(`<pre class="manual-code" id="${id}"><code>${escapeManualHtml(code)}</code></pre>`);
      addEntry({ id, sectionId: section.id, sectionTitle: section.title, kind: "code", text: code.replace(/\s+/gu, " ").trim() });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      index += 1;
      if (level === 1 && !result.title && !result.sections.length && !parts.length) {
        result.title = manualPlainText(text);
        continue;
      }
      if (level <= 2) {
        if (result.sections.length >= MAX_SECTIONS) {
          parts.push(`<h3>${renderManualInline(text)}</h3>`);
          continue;
        }
        flush();
        section = { id: uniqueId(`manual-${manualSlug(manualPlainText(text))}`), title: manualPlainText(text), html: "", subheadings: [] };
        result.sections.push(section);
        blockCounter = 0;
        addEntry({ id: section.id, sectionId: section.id, sectionTitle: section.title, kind: "section", text: section.title });
        continue;
      }
      const id = uniqueId(`${section.id}--${manualSlug(manualPlainText(text))}`);
      const tag = level === 3 ? "h3" : "h4";
      parts.push(`<${tag} id="${id}">${renderManualInline(text)}</${tag}>`);
      if (section.subheadings && level === 3) section.subheadings.push({ id, title: manualPlainText(text) });
      addEntry({ id, sectionId: section.id, sectionTitle: section.title, kind: "heading", text: manualPlainText(text) });
      continue;
    }

    if (RULE.test(line)) {
      parts.push("<hr />");
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = splitRow(lines[index]);
      const alignments = splitRow(lines[index + 1]).map((cell) => (
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : ""
      ));
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      const id = blockId();
      const width = header.length;
      const alignClass = (column) => (alignments[column] ? ` class="is-${alignments[column]}"` : "");
      const head = header.map((cell, column) => `<th scope="col"${alignClass(column)}>${renderManualInline(cell)}</th>`).join("");
      const body = rows.map((cells, rowIndex) => {
        const rowId = `${id}-r${rowIndex + 1}`;
        const padded = Array.from({ length: width }, (_, column) => cells[column] ?? "");
        addEntry({
          id: rowId,
          sectionId: section.id,
          sectionTitle: section.title,
          kind: "row",
          text: padded.map(manualPlainText).filter(Boolean).join(" · ")
        });
        return `<tr id="${rowId}">${padded.map((cell, column) => `<td${alignClass(column)}>${renderCell(cell)}</td>`).join("")}</tr>`;
      }).join("");
      parts.push(`<div class="manual-table" id="${id}" role="region" tabindex="0" aria-label="Table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    if (/^\s*>/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      const id = blockId();
      const alert = quote[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/u);
      let tone = "neutral";
      let label = "";
      if (alert) {
        tone = ALERTS[alert[1]].tone;
        label = alert[2] ? manualPlainText(alert[2]) : ALERTS[alert[1]].label;
        quote.shift();
      }
      const paragraphs = quote.join("\n").split(/\n\s*\n/u).map((paragraph) => paragraph.replace(/\n/gu, " ").trim()).filter(Boolean);
      parts.push(`<aside class="manual-callout is-${tone}" id="${id}">${label ? `<strong class="manual-callout__label">${escapeManualHtml(label)}</strong>` : ""}${paragraphs.map((paragraph) => `<p>${renderManualInline(paragraph)}</p>`).join("")}</aside>`);
      addEntry({ id, sectionId: section.id, sectionTitle: section.title, kind: "callout", text: [label, ...paragraphs.map(manualPlainText)].filter(Boolean).join(" · ") });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /\d/u.test(line.match(LIST_ITEM)[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM);
        if (item && /\d/u.test(item[2]) === ordered) {
          items.push(item[3]);
          index += 1;
        } else if (!item && items.length && /^\s{2,}\S/u.test(lines[index])) {
          items[items.length - 1] += ` ${lines[index].trim()}`;
          index += 1;
        } else {
          break;
        }
      }
      const id = blockId();
      const tag = ordered ? "ol" : "ul";
      parts.push(`<${tag} class="manual-list" id="${id}">${items.map((item, itemIndex) => {
        const itemId = `${id}-i${itemIndex + 1}`;
        const task = item.match(/^\[( |x|X)\]\s+(.*)$/u);
        addEntry({ id: itemId, sectionId: section.id, sectionTitle: section.title, kind: "item", text: manualPlainText(task ? task[2] : item) });
        if (task) {
          const done = task[1] !== " ";
          return `<li id="${itemId}" class="manual-task${done ? " is-done" : ""}"><span class="manual-task__box" aria-hidden="true"></span><span class="sr-only">${done ? "Done: " : "To do: "}</span>${renderManualInline(task[2])}</li>`;
        }
        return `<li id="${itemId}">${renderManualInline(item)}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length
      && lines[index].trim()
      && !HEADING.test(lines[index])
      && !FENCE.test(lines[index])
      && !LIST_ITEM.test(lines[index])
      && !/^\s*>/u.test(lines[index])
      && !RULE.test(lines[index])
      && !isTableStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const id = blockId();
    const text = paragraph.join(" ");
    parts.push(`<p id="${id}">${renderManualInline(text)}</p>`);
    addEntry({ id, sectionId: section.id, sectionTitle: section.title, kind: "text", text: manualPlainText(text) });
  }
  flush();
  return result;
}

function tokens(query) {
  return String(query || "").toLowerCase().split(/\s+/u).map((token) => token.trim()).filter(Boolean).slice(0, 8);
}

/**
 * Ranks manual entries for a query. Every query word must appear; headings,
 * whole-phrase matches and shorter entries rank higher. Returns at most
 * `limit` results, each with the matched range for highlighting.
 */
export function searchManualEntries(entries, query, limit = 8) {
  const words = tokens(query);
  if (!words.length) return [];
  const phrase = words.join(" ");
  const results = [];
  for (const entry of entries) {
    const haystack = entry.text.toLowerCase();
    const context = `${entry.sectionTitle} ${haystack}`.toLowerCase();
    if (!words.every((word) => context.includes(word))) continue;
    let score = 0;
    if (entry.kind === "section") score += 60;
    else if (entry.kind === "heading") score += 35;
    else if (entry.kind === "row") score += 12;
    if (haystack.includes(phrase)) score += 30;
    if (haystack.startsWith(phrase)) score += 10;
    score += words.filter((word) => haystack.includes(word)).length * 6;
    score -= Math.min(20, Math.floor(entry.text.length / 60));
    // Highlight the whole phrase when present, otherwise the first word found
    // in the entry text (a match may come only from the section title).
    const highlighted = haystack.includes(phrase) ? phrase : words.find((word) => haystack.includes(word)) || "";
    const position = highlighted ? haystack.indexOf(highlighted) : -1;
    results.push({ entry, score, matchStart: position, matchLength: highlighted.length });
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

/** A short excerpt around the match, split so the caller can escape each part. */
export function manualSnippet(text, start, length, radius = 48) {
  const value = String(text || "");
  if (start < 0) return { before: "", match: "", after: value.length > radius * 2 ? `${value.slice(0, radius * 2)}…` : value };
  const from = Math.max(0, start - radius);
  const to = Math.min(value.length, start + length + radius);
  return {
    before: `${from > 0 ? "…" : ""}${value.slice(from, start)}`,
    match: value.slice(start, start + length),
    after: `${value.slice(start + length, to)}${to < value.length ? "…" : ""}`
  };
}
