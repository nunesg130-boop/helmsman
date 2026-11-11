// The only door into the vendored `yaml` package (server/vendor/yaml, v2.9.1,
// ISC). Other modules import from here so the parse options stay in one place.

import { LineCounter, parseDocument } from "./vendor/yaml/index.js";

export { isAlias, isMap, isPair, isScalar, isSeq, Scalar, YAMLMap, YAMLSeq } from "./vendor/yaml/index.js";

const lineCounters = new WeakMap();
const MAX_FLOW_DEPTH = 64;

// Flow collections nested thousands deep can exhaust the parser's stack or
// memory badly enough to abort the process, so they are refused before
// parsing. Brackets inside quoted strings and comments don't count.
function flowDepthProblem(text) {
  let depth = 0;
  let line = 1;
  let column = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    column += 1;
    if (character === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    // A quote opens a string only where YAML allows one to start, so an
    // apostrophe inside plain text ("don't") doesn't hide what follows.
    if ((character === '"' || character === "'") && (index === 0 || /[\s[{,:]/u.test(text[index - 1]))) {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(text[index - 1]))) {
      const end = text.indexOf("\n", index);
      if (end < 0) break;
      column += end - index - 1;
      index = end - 1;
    } else if (character === "[" || character === "{") {
      depth += 1;
      if (depth > MAX_FLOW_DEPTH) return { line, column };
    } else if ((character === "]" || character === "}") && depth > 0) {
      depth -= 1;
    }
  }
  return null;
}

/**
 * Parses launchpad YAML into a comment-preserving Document. Errors (with
 * line positions) are on `doc.errors`; nothing is thrown for bad input.
 */
export function parseLaunchpadYaml(text) {
  const source = String(text);
  const tooDeep = flowDepthProblem(source);
  if (tooDeep) {
    const doc = parseDocument("");
    doc.errors.push({
      message: `Lists and mappings are nested more than ${MAX_FLOW_DEPTH} levels deep.`,
      linePos: [{ line: tooDeep.line, col: tooDeep.column }]
    });
    lineCounters.set(doc, new LineCounter());
    return doc;
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
    maxAliasCount: 0,
    version: "1.2",
    lineCounter
  });
  lineCounters.set(doc, lineCounter);
  return doc;
}

/** One-based line and column of a source offset in a parsed document. */
export function positionOf(doc, offset) {
  const counter = lineCounters.get(doc);
  if (!counter || !Number.isInteger(offset)) return { line: 0, column: 0 };
  const { line, col } = counter.linePos(offset);
  return { line, column: col };
}

export function stringifyDocument(doc) {
  return doc.toString({ lineWidth: 0 });
}
