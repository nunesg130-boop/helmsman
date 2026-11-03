import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Self-test card is plain markup built in src/app-v5.js, which runs only
// in a browser. Like the other UI contracts, this reads the files as text and
// checks the wiring the card depends on.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [app, html, sw, css, dockerfile, dockerignore, containerContract] = await Promise.all([
  read("src/app-v5.js"),
  read("index.html"),
  read("sw.js"),
  read("src/ui/selftest.css").catch(() => ""),
  read("Dockerfile"),
  read(".dockerignore"),
  read("scripts/container-contract.mjs")
]);

// The source of one top-level function, up to the next top-level declaration.
function body(name) {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`, "u"));
  assert.notEqual(start, -1, `${name} is defined`);
  const rest = app.slice(start + 1);
  const end = rest.search(/\n(?:async function|function|const|let|document\.addEventListener|window\.addEventListener) /u);
  return end === -1 ? rest : rest.slice(0, end);
}

// The body of the delegated handler branch for one action.
function actionBranch(action) {
  const start = app.indexOf(`action === "${action}"`);
  assert.notEqual(start, -1, `${action} is handled`);
  return app.slice(start, app.indexOf("return;", start));
}

test("the card is rendered in Agent settings beside Training data", () => {
  const settings = body("renderAgentSettings");
  assert.match(settings, /\$\{renderAgentTrainingCard\(data\)\}\s*\$\{renderAgentSelfTestCard\(data\)\}/u);
  const card = body("renderAgentSelfTestCard");
  assert.match(card, /id="agent-selftest-card"/u);
  assert.match(card, /<h3>Self-test<\/h3>/u);
  assert.match(card, /glass-panel settings-card-v5 agent-selftest-card/u);
});

test("the card has the batch controls, filters and review buttons", () => {
  const card = body("renderAgentSelfTestCard");
  for (const label of ["Start batch", "Stop", "Continue", "Load more"]) assert.ok(card.includes(`${label}</button>`), `button ${label}`);
  for (const action of ["selftest-start", "selftest-stop", "selftest-continue", "selftest-more"]) {
    assert.ok(card.includes(`data-action="${action}"`), `control ${action}`);
  }
  assert.match(app, /const SELFTEST_FILTERS = Object\.freeze\(\[\s*\["unrated", "Unrated"\],\s*\["all", "All"\],\s*\["changed", "Changed"\],\s*\["failed", "Failed"\]\s*\]\)/u);
  assert.match(card, /data-action="selftest-filter" data-selftest-filter=/u);
  assert.match(card, /id="agent-selftest-category"/u);
  const item = body("renderSelfTestItem");
  assert.ok(item.includes("<span>Skip</span></button>"));
  assert.ok(item.includes('data-action="selftest-skip"'));
  // Good and Fix answer come from the existing rating renderer, without Bad.
  assert.match(item, /renderAnswerRating\(item\.conversationId, item\.answer, \{ bad: false, scope: "selftest"/u);
  const rating = body("renderAnswerRating");
  assert.match(rating, /button\("up", "Good", "check"\)/u);
  assert.match(rating, /bad \? button\("down", "Bad", "x"\) : ""/u);
  assert.ok(rating.includes('data-action="agent-edit-answer"'));
  assert.ok(rating.includes("Fix answer"));
});

test("questions, answers and everything else from the server are escaped", () => {
  const item = body("renderSelfTestItem");
  for (const field of ["item.question", "item.answer", "item.category", "item.code", "tool"]) {
    assert.ok(item.includes(`escapeHtml(${field}`), `${field} goes through escapeHtml`);
  }
  assert.doesNotMatch(item, /\$\{item\.(question|answer|category|code)\}/u);
  const card = body("renderAgentSelfTestCard");
  assert.doesNotMatch(card, /\$\{(selfTest\.)?(status\.)?reason\}/u);
  assert.match(card, /escapeHtml\(selfTestStatusText\(/u);
});

test("the card talks to the self-test routes through the shared api helper", () => {
  assert.match(body("loadSelfTest"), /api\("\/api\/v2\/agent\/selftest"\)/u);
  assert.match(body("loadSelfTestReview"), /api\(`\/api\/v2\/agent\/selftest\/review\?\$\{params\}`\)/u);
  const start = body("startSelfTest");
  assert.match(start, /api\("\/api\/v2\/agent\/selftest\/start", \{ method: "POST", body: \{ count \} \}\)/u);
  assert.match(start, /count < SELFTEST_MIN_COUNT \|\| count > SELFTEST_MAX_COUNT/u);
  assert.match(app, /const SELFTEST_DEFAULT_COUNT = 50;/u);
  assert.match(app, /const SELFTEST_MIN_COUNT = 1;/u);
  assert.match(app, /const SELFTEST_MAX_COUNT = 1000;/u);
  const card = body("renderAgentSelfTestCard");
  assert.match(card, /type="number" min="\$\{SELFTEST_MIN_COUNT\}" max="\$\{SELFTEST_MAX_COUNT\}"/u);
  assert.match(body("changeSelfTestRun"), /api\(`\/api\/v2\/agent\/selftest\/\$\{kind\}`, \{ method: "POST", body: \{\} \}\)/u);
  assert.match(actionBranch("selftest-stop"), /changeSelfTestRun\("stop"\)/u);
  assert.match(actionBranch("selftest-continue"), /changeSelfTestRun\("continue"\)/u);
  assert.match(actionBranch("selftest-start"), /startSelfTest\(/u);
  assert.match(app, /event\.target\.id === "agent-selftest-form"\) void startSelfTest\(/u);
});

test("each server error gets an explanation, and Keep off points at the setting", () => {
  const notices = body("selfTestNotice");
  for (const code of ["SELFTEST_KEEP_OFF", "SELFTEST_NO_INVENTORY", "SELFTEST_EXHAUSTED", "SELFTEST_RUNNING", "SELFTEST_BAD_COUNT", "SELFTEST_UNAVAILABLE"]) {
    assert.ok(notices.includes(code), code);
  }
  assert.ok(notices.includes("Turn on Keep conversations for training"));
  assert.ok(notices.includes("Helmsman has no inventory yet."));
  assert.match(body("startSelfTest"), /selfTestNotice\(error\)/u);
});

test("the status is polled every 3 seconds only while the card is open and a run is active", () => {
  assert.match(app, /const SELFTEST_POLL_MS = 3_000;/u);
  const sync = body("syncSelfTestPolling");
  assert.match(sync, /document\.getElementById\("agent-selftest-card"\)/u);
  assert.match(sync, /state\.agent\.selfTest\.status\?\.running/u);
  assert.match(sync, /clearTimeout\(selfTestPollTimer\)/u);
  assert.match(sync, /setTimeout\(pollSelfTest, SELFTEST_POLL_MS\)/u);
  const poll = body("pollSelfTest");
  assert.match(poll, /selfTestPollTimer = null/u);
  assert.match(poll, /syncSelfTestPolling\(\)/u);
  // Every page render re-checks, so leaving the card stops the timer.
  assert.match(body("renderPage"), /syncSelfTestPolling\(\);/u);
  assert.doesNotMatch(app, /setInterval\(pollSelfTest/u);
});

test("rating an unrated item reloads the review from the first page", () => {
  const rate = body("rateConversation");
  assert.match(rate, /state\.agent\.selfTest\.items\.find\(\(entry\) => entry\.conversationId === id\)/u);
  assert.match(rate, /state\.agent\.selfTest\.filter === "unrated"/u);
  assert.match(rate, /loadSelfTestReview\(\{ reset: true \}\)/u);
  const review = body("loadSelfTestReview");
  assert.match(review, /reset \? null : selfTest\.next/u);
  assert.match(actionBranch("selftest-skip"), /moveSelfTest\(1\)/u);
});

test("g, f, s, j and k work only on the card and never while typing", () => {
  const keys = body("handleSelfTestKey");
  assert.match(keys, /isTypingTarget\(event\.target\)/u);
  assert.match(keys, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/u);
  assert.match(keys, /document\.getElementById\("agent-selftest-card"\)/u);
  assert.match(keys, /has-overlay/u);
  for (const key of ["g", "f", "s", "j", "k"]) assert.match(keys, new RegExp(`(case|key ===) "${key}"`, "u"), `key ${key}`);
  assert.match(body("isTypingTarget"), /input, textarea, select, \[contenteditable='true'\], \[contenteditable=''\]/u);
  assert.match(app, /document\.addEventListener\("keydown", handleSelfTestKey\);/u);
});

test("selftest.css ships with the app like the other UI stylesheets", () => {
  assert.match(html, /<link rel="stylesheet" href="\.\/src\/ui\/network-map\.css" \/>\s*<link rel="stylesheet" href="\.\/src\/ui\/selftest\.css" \/>/u);
  assert.match(css, /\.agent-selftest-card\s*\{/u);
  assert.match(css, /\.agent-selftest-list > li\.is-current\s*\{/u);
  assert.match(dockerfile, /src\/ui\/network-map\.css src\/ui\/selftest\.css /u);
  assert.match(dockerignore, /^!src\/ui\/selftest\.css$/mu);
  assert.ok(containerContract.includes('"src/ui/selftest.css",'));
  assert.ok(containerContract.includes('"!src/ui/selftest.css",'));
  assert.ok(containerContract.includes("src/ui/network-map.css src/ui/selftest.css src/ui/agent-helper-3d.js ./src/ui/"));
  // The service worker deliberately caches nothing, so it has no asset list to extend.
  assert.doesNotMatch(sw, /caches\.open|addAll|\.css/u);
});

test("the questions left are labelled as an estimate", () => {
  const text = body("selfTestStatusText");
  assert.match(text, /`about \$\{selfTestCount\(status\.unaskedLeft\)\} new question/u);
  assert.doesNotMatch(text, /left to ask/u);
});

test("Stop shows Stopping… until the poll sees the run halt", () => {
  const text = body("selfTestStatusText");
  assert.match(text, /status\.stopping/u);
  assert.match(text, /Stopping…/u);
  const card = body("renderAgentSelfTestCard");
  assert.match(card, /const stopping = Boolean\(status\?\.stopping\)/u);
  assert.match(card, /data-action="selftest-stop" \$\{running && !stopping && idle \? "" : "disabled"\}/u);
  assert.match(body("updateSelfTestInPlace"), /\["selftest-stop", running && !stopping && idle\]/u);
  // The stop answer says "stopping"; the review reloads when the poll sees the end.
  assert.doesNotMatch(body("changeSelfTestRun"), /if \(kind === "stop"\) void loadSelfTestReview/u);
});

test("g and a saved fix move past the answer before the rating is sent", () => {
  const keys = body("handleSelfTestKey");
  assert.match(keys, /rateConversation\(item\.conversationId, \{ rating: "up" \}, \{ advanceSelfTest: true \}\)/u);
  const rate = body("rateConversation");
  assert.match(rate, /async function rateConversation\(id, body, \{ advanceSelfTest = false \} = \{\}\)/u);
  // Moved synchronously, before the request, so a second press rates the next answer.
  assert.ok(rate.indexOf("advancePastSelfTestItem(id)") !== -1 && rate.indexOf("advancePastSelfTestItem(id)") < rate.indexOf("await api("), "advances before the request");
  const advance = body("advancePastSelfTestItem");
  assert.match(advance, /selfTest\.filter === "unrated"/u);
  assert.match(advance, /selfTest\.items\.splice\(position, 1\)/u);
  assert.match(advance, /selfTest\.index \+= 1/u);
  assert.match(app, /rateConversation\(event\.target\.dataset\.conversationId, \{ correction: correction \|\| null \}, \{ advanceSelfTest: state\.agent\.editingScope === "selftest" && Boolean\(correction\) \}\)/u);
});

test("the card refetches its status and answers each time it is shown", () => {
  const sync = body("syncSelfTestPolling");
  assert.match(sync, /selfTestCardMounted/u);
  assert.match(sync, /if \(mounted && !selfTestCardMounted\)/u);
  assert.match(sync, /void loadSelfTest\(\)/u);
  assert.match(sync, /void loadSelfTestReview\(\{ reset: true \}\)/u);
  assert.match(app, /let selfTestCardMounted = false;/u);
  // Settings panels are built even when hidden, so the card itself does not fetch.
  const card = body("renderAgentSelfTestCard");
  assert.doesNotMatch(card, /loadSelfTest\(/u);
  assert.doesNotMatch(card, /loadSelfTestReview\(/u);
  // A fetched running status starts the poll.
  assert.match(body("loadSelfTest"), /syncSelfTestPolling\(\)/u);
});

test("the short-batch toast compares the batch size, not what is still queued", () => {
  const start = body("startSelfTest");
  assert.match(start, /selfTestCount\(payload\?\.done\) \+ selfTestCount\(payload\?\.failed\) \+ selfTestCount\(payload\?\.queued\)/u);
  assert.match(start, /payload\?\.requested/u);
  assert.match(start, /batch < requested/u);
});

test("the notice is a polite status, not an alert announced on every redraw", () => {
  const card = body("renderAgentSelfTestCard");
  assert.match(card, /<div class="security-note" role="status">/u);
  assert.doesNotMatch(card, /role="alert"/u);
});
