import { createHash } from "node:crypto";

import { CATEGORIES } from "./selftest-questions.mjs";

// Self-test question files: a list of the owner's own questions, run as a
// batch instead of generated ones. Two formats (docs/SELF-TEST-QUESTIONS.md):
//
//   CSV, with a header row naming a "question" and a "category" column:
//     question,category
//     is caddy's backup recent?,backups
//
//   JSON, an object grouping questions by category:
//     { "backups": ["is caddy's backup recent?"], "ranking": ["..."] }
//
// Every question needs one of the Self-test categories. In "follow-up",
// questions come in pairs: the first is asked, then the second with the
// first and its answer as the conversation before it.
//
// Checking never runs anything. Errors stop the whole file; warnings
// (blank questions and exact repeats, which are skipped, and questions that
// differ from another only in capitals, spaces or punctuation, which are
// kept) are shown so the owner can start anyway.

export const UPLOAD_MAX_QUESTIONS = 1000;
export const UPLOAD_MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 1000;
const MAX_LISTED = 50;
const FOLLOW_UP = "follow-up";
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/gu;

export class UploadError extends Error {
  constructor(message, report = null) {
    super(message);
    this.name = "UploadError";
    this.report = report;
  }
}

/** "f-…": the same key for questions that differ only in capitals, spaces or punctuation. */
function looseKey(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hash(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Splits CSV text into records, each with the line it starts on. Quoted fields may hold commas, quotes ("") and line breaks. */
function csvRecords(text) {
  const records = [];
  let field = "";
  let fields = [];
  let quoted = false;
  let line = 1;
  let start = 1;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === "\"" && field === "" && !afterQuote) {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
      afterQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      fields.push(field);
      records.push({ line: start, fields });
      field = "";
      fields = [];
      afterQuote = false;
      line += 1;
      start = line;
    } else if (afterQuote) {
      throw new UploadError(`Line ${start}: text after a closing quote. Put the whole field in quotes, and write a quote inside it as "".`);
    } else {
      field += char;
    }
  }
  if (quoted) throw new UploadError(`Line ${start}: a quote is opened and never closed.`);
  if (field !== "" || fields.length) {
    fields.push(field);
    records.push({ line: start, fields });
  }
  return records;
}

/** Entries from a CSV file: { where, category, text }. */
function csvEntries(text, problems) {
  const records = csvRecords(text);
  const header = records.shift();
  if (!header) throw new UploadError("The file is empty.");
  const names = header.fields.map((name) => name.trim().toLowerCase());
  const questionAt = names.indexOf("question");
  const categoryAt = names.indexOf("category");
  if (questionAt < 0 || categoryAt < 0) {
    throw new UploadError("The first line must name the columns, including \"question\" and \"category\" (for example: question,category).");
  }
  if (names.filter((name) => name === "question").length > 1 || names.filter((name) => name === "category").length > 1) {
    throw new UploadError("The first line names the \"question\" or \"category\" column twice.");
  }
  const extra = names.filter((name, index) => index !== questionAt && index !== categoryAt && name);
  if (extra.length) problems.warnings.push(`Columns other than question and category are ignored: ${extra.slice(0, 5).join(", ")}.`);
  const entries = [];
  for (const record of records) {
    // A line with nothing on it at all is not a question; skip it quietly.
    if (record.fields.every((value) => value.trim() === "")) continue;
    entries.push({
      order: record.line,
      where: `Line ${record.line}`,
      category: String(record.fields[categoryAt] ?? "").trim(),
      text: String(record.fields[questionAt] ?? "")
    });
  }
  return entries;
}

/** Entries from a JSON file grouped by category. */
function jsonEntries(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UploadError(`The file is not valid JSON (${String(error?.message || "parse error").slice(0, 120)}).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UploadError("The file must be one JSON object with categories as keys, for example {\"backups\": [\"is caddy's backup recent?\"]}.");
  }
  const entries = [];
  const errors = [];
  for (const [category, list] of Object.entries(value)) {
    if (!Array.isArray(list)) {
      errors.push(`"${category.slice(0, 40)}": must be a list of questions in [ ].`);
      continue;
    }
    list.forEach((item, index) => {
      if (typeof item !== "string") {
        errors.push(`"${category.slice(0, 40)}" item ${index + 1}: must be text in quotes.`);
        return;
      }
      entries.push({ order: entries.length, where: `"${category.slice(0, 40)}" item ${index + 1}`, category, text: item });
    });
  }
  return { entries, errors };
}

function listed(items) {
  return items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `…and ${items.length - MAX_LISTED} more.`] : items;
}

/**
 * Checks a question file. `name` decides the format (.csv or .json).
 * Returns { format, questions, total, errors, warnings, counts }; when
 * `errors` is not empty, `questions` is empty and nothing may run.
 */
export function checkQuestionFile({ name, text } = {}) {
  const errors = [];
  const problems = { warnings: [] };
  // Warnings are listed in file order, whichever check found them.
  const report = (format, questions, counts) => ({
    format,
    questions: errors.length ? [] : questions,
    total: errors.length ? 0 : questions.length,
    errors: listed(errors),
    warnings: listed(problems.warnings.map((item, index) => (typeof item === "string" ? [-1, index, item] : [item[0], index, item[1]]))
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]).map((item) => item[2])),
    counts
  });
  const emptyCounts = { read: 0, blank: 0, repeated: 0, similar: 0 };
  const fileName = typeof name === "string" ? name.trim() : "";
  const format = /\.csv$/iu.test(fileName) ? "csv" : /\.json$/iu.test(fileName) ? "json" : null;
  if (!format) {
    errors.push("Choose a .csv or .json file.");
    return report(null, [], emptyCounts);
  }
  if (typeof text !== "string" || !text.trim()) {
    errors.push("The file is empty.");
    return report(format, [], emptyCounts);
  }
  if (Buffer.byteLength(text, "utf8") > UPLOAD_MAX_BYTES) {
    errors.push("The file is larger than 1 MB.");
    return report(format, [], emptyCounts);
  }
  const source = text.replace(/^\uFEFF/u, "");
  let entries;
  try {
    if (format === "csv") {
      entries = csvEntries(source, problems);
    } else {
      const parsed = jsonEntries(source);
      entries = parsed.entries;
      errors.push(...parsed.errors);
    }
  } catch (error) {
    if (!(error instanceof UploadError)) throw error;
    errors.push(error.message);
    return report(format, [], emptyCounts);
  }

  const counts = { read: entries.length, blank: 0, repeated: 0, similar: 0 };
  const known = new Set(CATEGORIES);
  const kept = [];
  const followUps = [];
  for (const entry of entries) {
    const text = entry.text.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
    if (!entry.category) {
      errors.push(`${entry.where}: no category. Use one of: ${CATEGORIES.join(", ")}.`);
      continue;
    }
    if (!known.has(entry.category)) {
      errors.push(`${entry.where}: "${entry.category.slice(0, 40)}" is not a Self-test category. Use one of: ${CATEGORIES.join(", ")}.`);
      continue;
    }
    if (text.length > MAX_TEXT) {
      errors.push(`${entry.where}: the question is longer than ${MAX_TEXT} characters.`);
      continue;
    }
    const item = { order: entry.order, where: entry.where, category: entry.category, text };
    if (entry.category === FOLLOW_UP) followUps.push(item);
    else if (!text) {
      counts.blank += 1;
      problems.warnings.push([entry.order, `${entry.where}: blank question, skipped.`]);
    } else kept.push([item]);
  }
  // Follow-ups in pairs: first question, then the one asked after it.
  if (followUps.length % 2 === 1) {
    errors.push(`"${FOLLOW_UP}" has ${followUps.length === 1 ? "1 question" : `${followUps.length} questions`}. They go in pairs (a question, then the one asked after it), so the count must be even.`);
  } else {
    for (let index = 0; index < followUps.length; index += 2) {
      const pair = [followUps[index], followUps[index + 1]];
      const blank = pair.find((item) => !item.text);
      if (blank) {
        errors.push(`${blank.where}: blank question in a "${FOLLOW_UP}" pair. Both questions of a pair are needed.`);
        continue;
      }
      kept.push(pair);
    }
  }

  // Exact repeats are skipped; near repeats are kept but pointed out.
  const exact = new Map();
  const loose = new Map();
  const units = [];
  for (const unit of kept) {
    const exactKey = unit.map((item) => item.text).join("\n");
    const looseUnit = unit.map((item) => looseKey(item.text)).join("\n");
    const first = unit[0];
    if (exact.has(exactKey)) {
      counts.repeated += unit.length;
      problems.warnings.push([first.order, `${first.where}: the same as ${exact.get(exactKey)}, skipped.`]);
      continue;
    }
    exact.set(exactKey, first.where);
    if (loose.has(looseUnit)) {
      counts.similar += unit.length;
      problems.warnings.push([first.order, `${first.where}: possibly the same as ${loose.get(looseUnit)} (differs only in capitals, spaces or punctuation), kept.`]);
    } else loose.set(looseUnit, first.where);
    units.push(unit);
  }

  const questions = [];
  for (const unit of units) {
    unit.forEach((item, index) => {
      const key = unit.slice(0, index + 1).map((part) => looseKey(part.text)).join("\n");
      questions.push({
        id: `u-${hash(`${item.category}\n${unit.slice(0, index + 1).map((part) => part.text).join("\n")}`, 24)}`,
        fact: `f-${hash(`upload\n${item.category}\n${key}`, 12)}`,
        category: item.category,
        text: item.text,
        followUp: index > 0
      });
    });
  }
  if (!questions.length && !errors.length) errors.push("The file has no questions to ask.");
  if (questions.length > UPLOAD_MAX_QUESTIONS) {
    errors.push(`The file has ${questions.length} questions after skipping blanks and repeats; the most a batch can hold is ${UPLOAD_MAX_QUESTIONS}.`);
  }
  return report(format, questions, counts);
}
