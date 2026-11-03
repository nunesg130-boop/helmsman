import assert from "node:assert/strict";
import test from "node:test";

import { checkQuestionFile, UPLOAD_MAX_QUESTIONS } from "../server/selftest-upload.mjs";

const csv = (rows) => `question,category\n${rows.join("\n")}\n`;

test("a CSV file becomes questions in file order, quotes and all", () => {
  const report = checkQuestionFile({ name: "Questions.CSV", text: csv(["is caddy up?,guest-lookup", "\"which, if any, are stopped?\",containers", "\"the \"\"main\"\" node?\",node"]) });
  assert.deepEqual(report.errors, []);
  assert.equal(report.format, "csv");
  assert.deepEqual(report.questions.map((question) => [question.category, question.text, question.followUp]), [
    ["guest-lookup", "is caddy up?", false],
    ["containers", "which, if any, are stopped?", false],
    ["node", "the \"main\" node?", false]
  ]);
  assert.ok(report.questions.every((question) => /^u-[a-f0-9]{24}$/u.test(question.id) && /^f-[a-f0-9]{12}$/u.test(question.fact)));
});

test("columns may come in any order, and other columns are ignored with a warning", () => {
  const report = checkQuestionFile({ name: "q.csv", text: "notes,Category,Question\nx,backups,is caddy backed up?\n" });
  assert.deepEqual(report.questions.map((question) => question.text), ["is caddy backed up?"]);
  assert.match(report.warnings[0], /Columns other than question and category are ignored: notes/u);
});

test("a JSON file groups questions by category", () => {
  const report = checkQuestionFile({ name: "q.json", text: JSON.stringify({ backups: ["is caddy's backup recent?"], ranking: ["rank guests by memory"] }) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.questions.map((question) => [question.category, question.text]), [["backups", "is caddy's backup recent?"], ["ranking", "rank guests by memory"]]);
});

test("only .csv and .json files are taken", () => {
  for (const name of ["q.txt", "q", "q.csv.txt", ""]) {
    assert.deepEqual(checkQuestionFile({ name, text: csv(["a?,node"]) }).errors, ["Choose a .csv or .json file."], name);
  }
});

test("unknown or missing categories stop the whole file, naming the line", () => {
  const report = checkQuestionFile({ name: "q.csv", text: csv(["is caddy up?,guest-lookup", "how about ports?,ports", "no category?,"]) });
  assert.equal(report.total, 0);
  assert.deepEqual(report.questions, []);
  assert.match(report.errors[0], /^Line 3: "ports" is not a Self-test category\. Use one of: guest-lookup, /u);
  assert.match(report.errors[1], /^Line 4: no category\./u);
  const json = checkQuestionFile({ name: "q.json", text: JSON.stringify({ ports: ["what port?"], backups: "not a list", node: [3] }) });
  assert.deepEqual(json.errors.map((error) => error.split(":")[0]), ["\"backups\"", "\"node\" item 1", "\"ports\" item 1"]);
});

test("a malformed file says what is wrong", () => {
  assert.match(checkQuestionFile({ name: "q.csv", text: "category\nnode\n" }).errors[0], /must name the columns, including "question" and "category"/u);
  assert.match(checkQuestionFile({ name: "q.csv", text: "question,category\n\"open quote,node\n" }).errors[0], /^Line 2: a quote is opened and never closed/u);
  assert.match(checkQuestionFile({ name: "q.json", text: "{\"node\": [" }).errors[0], /^The file is not valid JSON/u);
  assert.match(checkQuestionFile({ name: "q.json", text: "[\"is caddy up?\"]" }).errors[0], /one JSON object with categories as keys/u);
  assert.deepEqual(checkQuestionFile({ name: "q.csv", text: "  \n" }).errors, ["The file is empty."]);
  assert.deepEqual(checkQuestionFile({ name: "q.csv", text: "question,category\n" }).errors, ["The file has no questions to ask."]);
});

test("blanks and exact repeats are skipped, near repeats kept, each with a warning", () => {
  const report = checkQuestionFile({ name: "q.csv", text: csv(["is caddy up?,guest-lookup", ",node", "is caddy up?,guest-lookup", "Is Caddy up,guest-lookup", "", "rank by cpu,ranking"]) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.questions.map((question) => question.text), ["is caddy up?", "Is Caddy up", "rank by cpu"]);
  assert.deepEqual(report.counts, { read: 5, blank: 1, repeated: 1, similar: 1 });
  assert.deepEqual(report.warnings, [
    "Line 3: blank question, skipped.",
    "Line 4: the same as Line 2, skipped.",
    "Line 5: possibly the same as Line 2 (differs only in capitals, spaces or punctuation), kept."
  ]);
  // Listed in file order, even when a blank comes after a repeat.
  const late = checkQuestionFile({ name: "q.csv", text: csv(["a?,node", "a?,node", ",node"]) });
  assert.deepEqual(late.warnings, ["Line 3: the same as Line 2, skipped.", "Line 4: blank question, skipped."]);
});

test("follow-up questions go in pairs, the second asked after the first", () => {
  const report = checkQuestionFile({ name: "q.json", text: JSON.stringify({ "follow-up": ["which node is caddy on?", "what about pihole?"], node: ["is norco busy?"] }) });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.questions.map((question) => [question.text, question.followUp]), [["is norco busy?", false], ["which node is caddy on?", false], ["what about pihole?", true]]);
  assert.notEqual(report.questions[1].id, report.questions[2].id);
  assert.match(checkQuestionFile({ name: "q.json", text: JSON.stringify({ "follow-up": ["a?", "b?", "c?"] }) }).errors[0], /"follow-up" has 3 questions\. They go in pairs/u);
  assert.match(checkQuestionFile({ name: "q.json", text: JSON.stringify({ "follow-up": ["a?"] }) }).errors[0], /"follow-up" has 1 question\. They go in pairs/u);
  assert.match(checkQuestionFile({ name: "q.csv", text: csv(["a?,follow-up", ",follow-up"]) }).errors[0], /^Line 3: blank question in a "follow-up" pair/u);
  // A repeated pair is skipped whole.
  const repeated = checkQuestionFile({ name: "q.csv", text: csv(["a?,follow-up", "b?,follow-up", "a?,follow-up", "b?,follow-up"]) });
  assert.equal(repeated.total, 2);
  assert.equal(repeated.counts.repeated, 2);
});

test("more than the batch limit, or an over-long question, stops the file", () => {
  const rows = Array.from({ length: UPLOAD_MAX_QUESTIONS + 1 }, (_, index) => `question ${index}?,node`);
  assert.match(checkQuestionFile({ name: "q.csv", text: csv(rows) }).errors.at(-1), /has 1001 questions .* the most a batch can hold is 1000/u);
  assert.equal(checkQuestionFile({ name: "q.csv", text: csv(rows.slice(0, UPLOAD_MAX_QUESTIONS)) }).total, UPLOAD_MAX_QUESTIONS);
  assert.match(checkQuestionFile({ name: "q.csv", text: csv([`${"x".repeat(1001)},node`]) }).errors[0], /longer than 1000 characters/u);
  assert.deepEqual(checkQuestionFile({ name: "q.csv", text: `question,category\n${"x".repeat(1024 * 1024)}` }).errors, ["The file is larger than 1 MB."]);
});

test("long error lists are cut at fifty with a count of the rest", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `q${index}?,nope`);
  const { errors } = checkQuestionFile({ name: "q.csv", text: csv(rows) });
  assert.equal(errors.length, 51);
  assert.equal(errors.at(-1), "…and 10 more.");
});
