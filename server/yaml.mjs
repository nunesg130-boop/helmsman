// The only door into the vendored `yaml` package (server/vendor/yaml, v2.9.1,
// ISC). Other modules import from here so the parse options stay in one place.

import { LineCounter, parseDocument } from "./vendor/yaml/index.js";

export { isAlias, isMap, isPair, isScalar, isSeq, Scalar, YAMLMap, YAMLSeq } from "./vendor/yaml/index.js";

const lineCounters = new WeakMap();

/**
 * Parses launchpad YAML into a comment-preserving Document. Errors (with
 * line positions) are on `doc.errors`; nothing is thrown for bad input.
 */
export function parseLaunchpadYaml(text) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(String(text), {
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
