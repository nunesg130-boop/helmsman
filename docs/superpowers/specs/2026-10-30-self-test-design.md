# Self-test: built-in automated questioning (Helmsman v1.17.0)

Status: draft for owner review. Date: 2026-10-30.

## Purpose

Helmsman asks its own agent a batch of questions generated from the owner's live lab, saves every answer as a conversation, and lets the owner rate or fix the answers in one review page. The rated answers are the training data for fine-tuning the local model. It replaces the browser-driven and script-driven question runs used for v1.16.x.

Agreed with the owner:
- **Purpose:** collect training data. There is no automatic pass/fail score.
- **Questions:** generated from the live inventory, not from an imported list.
- **When:** on demand, in batches the owner starts and can stop.

Non-goals: automatic grading, scheduled or idle-time runs, importing question lists, proposing or running actions, changing the training scripts, changing the existing chat or rating behavior.

## What already exists and is reused

- `ask()` in `server/agent.mjs` runs a question through `converse({ source: "question" })`, with history, in the job queue.
- `conversationStore` (`server/agent-conversations.mjs`) records conversations, and `rate(id, { rating, correction })` saves a thumb and a corrected answer.
- `exportTraining({ include: "rated" })` is "Download good and fixed". It stays the only export.
- The `questionsPerHour` setting and the `conversationsPolicy().keep` setting ("Keep conversations for training").

## Components

### 1. `server/selftest-questions.mjs` (generator)
Pure function `generateQuestions(snapshot, { seed, exclude })` returning `[{ id, category, text, followUp }]`.

- Reads names, IDs, nodes, Docker hosts, containers, stacks, services and backup states from the same normalized snapshot the agent tools read. No new data source.
- Templates are grouped by category: `guest-lookup`, `ranking` (memory, CPU, size, uptime, backups), `node`, `containers` (ports, images, stacks, health, host), `neighbours` (same node or host as X), `backups`, `history`, `manual`, `services`, `follow-up`, and `unknowable` (things Helmsman does not hold, such as snapshots, storage capacity or a NAS, where the right answer is that it can't tell).
- Several wordings per template, chosen by a seeded random generator, so a seed always yields the same questions.
- Each question has a stable `id` (hash of the template, its arguments and the wording). Questions already asked (`exclude`) are skipped, so repeated batches do not repeat. When the lab changes, new names yield new IDs.
- A follow-up template emits a pair: the base question, then the short follow-up (`followUp: true`), which is asked with the previous question and answer as history.
- Questions are at most 1,000 characters (the existing limit) and use plain text only.
- The generator never reads from or writes to the network or disk.

### 2. `server/selftest.mjs` (runner and state)
`createSelfTest({ ask, snapshot, conversationStore, dataDir, clock, guard })` with `start({ count })`, `stop()`, `status()`, `review({ filter, cursor })`.

- **State file** `/data/selftest.json` (mode 0600, atomic write, revision checked like `manual.json`): `{ version, asked: [ids], queue: [questions], current, startedAt, counts }`. Holds no credentials. Capped at 20,000 asked IDs; the oldest are dropped first.
- **Run.** `start` generates `count` questions (1 to 500, default 50), stores them as the queue, and processes them one at a time. Each question goes through the agent's existing `ask` path with `source: "question"` and a `selfTest: { id, category }` marker, so its conversation can be filtered in the review page and does not appear in the chat's "Recent questions" list.
- **Priority.** The runner submits to the existing job queue at the back. A real chat question uses the existing `front: true` and is never delayed by more than the one question in flight.
- **Limits.** It counts against `questionsPerHour` like any question. On `AGENT_BUSY` it waits until the hour rolls and carries on. It stops on `AI_NOT_CONFIGURED` or when the model server is unreachable for three questions in a row, and says why.
- **Stop and restart.** `stop` finishes the question in flight, then halts. After a Helmsman restart a run does not resume by itself: the state shows "paused (restart)" and the owner presses Continue.
- **Read-only.** The runner passes `allowProposals: false`. It never creates, approves or runs an action.
- **Needs training capture.** If "Keep conversations for training" is off, `start` is refused with a message saying to turn it on, since there would be nothing to review.

### 3. API (all owner-session, CSRF-protected, same as the other `/api/v2/agent` routes)
- `GET /api/v2/agent/selftest` returns status: `{ running, paused, reason, queued, done, failed, unrated, categories }`.
- `POST /api/v2/agent/selftest/start` with `{ count }`.
- `POST /api/v2/agent/selftest/stop`.
- `POST /api/v2/agent/selftest/continue`.
- `GET /api/v2/agent/selftest/review?filter=unrated|all|changed&category=&cursor=` returns up to 25 items: `{ conversationId, question, answer, toolsUsed, category, rating, correction, changedFromBefore }`.
- Rating uses the existing `POST /api/v2/agent/conversations/{id}/rating`. No new rating route.

`changedFromBefore` is true when the same question ID was asked in an earlier batch and the answer text differs.

### 4. Review page (Settings → Agent → Self-test)
- A Start batch control (count), Stop/Continue, and a one-line status ("32 of 50 done, 2 failed, 31 unrated").
- The review list: question, answer, lookups used, then **Good**, **Fix answer** and **Skip**. Good and Fix call the existing rating route. Keyboard shortcuts: `g` good, `f` fix, `s` skip, `j`/`k` next and previous.
- Filters: unrated (default), all, changed since last time, by category.
- Answers are shown as escaped plain text, like every other agent text in the UI.

### 5. Conversation store change
`record()` accepts an optional `selfTest: { id, category }` and stores it on the conversation. `list()` gains an `excludeSelfTest` option used by the chat's recent list. The export format is unchanged, so `prepare_data.py` keeps working.

## Data flow

generate (inventory snapshot) → queue in `/data/selftest.json` → `ask` (job queue, read-only) → conversation saved with `selfTest` marker → review page lists unrated → owner rates or fixes → "Download good and fixed" exports them.

## Errors and edge cases

- No snapshot yet (monitor not run): `start` refused, "Helmsman has no inventory yet."
- A batch larger than what the templates can produce without repeating: the batch is shorter, and the status says how many unasked questions are left.
- A question the agent fails on: recorded as failed with the error code, shown in the review list under "failed", and not retried automatically.
- Two Helmsman instances on one `/data` are already prevented by the broker lock; the self-test relies on that.
- Disk growth: conversations are already pruned by the existing 90-day keep and size limits; the state file is capped as above.

## Security and privacy

- Questions are built from inventory names the owner already holds in Helmsman. Nothing leaves the host except to the configured model server, as with any chat question.
- No secrets in `selftest.json`. Review text is escaped. New routes require the owner session, CSRF and the existing origin binding.
- The runner cannot call action tools (`allowProposals: false` is enforced in the runner and covered by a test).

## Testing

- Generator: fixed seed returns identical questions; `exclude` removes asked IDs; every category emits at least one question for a fixture cluster (reusing the `cluster()` fixture in `tests/agent-intent.test.mjs`); follow-ups come directly after their base; no question exceeds 1,000 characters; the "unknowable" set never mentions a name that is not in the inventory.
- Runner: processes in order; chat question jumps ahead; `stop` halts after the question in flight; restart yields "paused"; `AGENT_BUSY` waits and resumes; three consecutive model failures stop the run; actions are never proposed; `start` refused when conversation keeping is off or there is no snapshot.
- API: authentication, CSRF and origin required; count bounds; review filters and paging; `changedFromBefore`.
- Store: `selfTest` marker round trip; `excludeSelfTest`; export output unchanged for existing conversations.
- UI: contract test for the Self-test page strings and keyboard handlers, in the style of the existing UI contract tests.
- Full `npm test` stays green, and the container, publisher, bootstrap and public-release contracts are updated for 1.17.0.

## Release

v1.17.0: README section, `docs/LOCAL-AI.md` gains a short "Collecting training data with Self-test" section, version bump in all version files, one PR.

## Open questions

None blocking. Defaults chosen: batch size 50, maximum 500, review page size 25, asked-ID cap 20,000.
