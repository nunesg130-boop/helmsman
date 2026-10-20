import assert from "node:assert/strict";
import test from "node:test";

import { buildHistory, questionWindow, readWindow } from "../server/agent-history.mjs";
import { matchByName } from "../server/agent-tools.mjs";

const NOW = Date.parse("2026-10-20T20:40:00Z");
const HOUR = 3_600_000;

test("nicknames, prefixes and near-miss spellings find the right name", () => {
  const names = ["qbittorrent", "qbittorrent-vpn", "sonarr", "radarr", "jellyfin", "jellyseerr", "prowlarr", "home-automation", "gluetun"];
  const match = (typed) => matchByName(names, typed, (name) => name);
  assert.deepEqual(match("qbittorrent"), ["qbittorrent"], "the exact name wins");
  assert.deepEqual(match("qbit"), ["qbittorrent"], "a nickname prefers the exact app name");
  assert.deepEqual(match("QB"), ["qbittorrent"]);
  assert.deepEqual(match("sonar"), ["sonarr"]);
  assert.deepEqual(match("jelly"), ["jellyfin"]);
  assert.deepEqual(match("overseerr"), ["jellyseerr"]);
  assert.deepEqual(match("qbitorent"), ["qbittorrent"], "a typo");
  assert.deepEqual(match("sonnarr"), ["sonarr"]);
  assert.deepEqual(match("home auto"), ["home-automation"]);
  assert.deepEqual(match("vpn"), ["gluetun"]);
  assert.deepEqual(match("plex"), [], "nothing invented");
  assert.deepEqual(match("it"), []);
  assert.deepEqual(matchByName(["sonarr-4k", "sonarr-hd"], "sonar", (name) => name), ["sonarr-4k", "sonarr-hd"], "ambiguous matches are all returned");
});

test("questions about a period are recognised, others are not", () => {
  const window = (text) => questionWindow(text, NOW, "America/New_York");
  assert.deepEqual(window("How's the health been in the past 24 hours."), { from: NOW - 24 * HOUR, to: NOW, label: "the past 24 hours" });
  assert.equal(window("anything in the last 3 days?").from, NOW - 72 * HOUR);
  assert.equal(window("past week").label, "the past week");
  assert.equal(window("last 2 weeks").from, NOW - 14 * 24 * HOUR);
  assert.equal(window("last 90 days").from, NOW - 14 * 24 * HOUR, "capped at the journal's 14 days");
  assert.deepEqual(window("anything wrong today?"), { from: Date.parse("2026-10-20T04:00:00Z"), to: NOW, label: "today" });
  assert.deepEqual(window("how was yesterday"), { from: Date.parse("2026-10-19T04:00:00Z"), to: Date.parse("2026-10-20T04:00:00Z"), label: "yesterday" });
  assert.equal(window("any outages lately?").label, "the past 24 hours");
  assert.equal(window("restart qbit"), null);
  assert.equal(window("what is sonarr doing"), null);
});

test("history pairs incidents into episodes with durations, actions and restarts", () => {
  const text = buildHistory({
    from: NOW - 24 * HOUR,
    to: NOW,
    label: "the past 24 hours",
    format: (iso) => iso.slice(5, 16).replace("T", " "),
    nameOf: (id) => ({ radarr: "Radarr", sonarr: "Sonarr", jellyfin: "Jellyfin" }[id] || id),
    monitored: ["radarr", "sonarr", "jellyfin"],
    healthEvents: [
      { at: "2026-10-20T18:05:00.000Z", event: "health_incident", outcome: "changed", level: "error", service: "radarr", capability: "queue", code: "HTTP_503", targetId: "a" },
      { at: "2026-10-20T18:12:00.000Z", event: "health_incident", outcome: "recovered", service: "radarr", targetId: "a" },
      // Opened before the window, recovered inside it: counted from the window's start.
      { at: "2026-10-19T21:10:00.000Z", event: "health_incident", outcome: "recovered", service: "radarr", targetId: "z" },
      { at: "2026-10-20T19:00:00.000Z", event: "health_incident", outcome: "changed", level: "warn", service: "sonarr", capability: "health", targetId: "b" }
    ],
    openIncidents: [{ id: "b", service: "sonarr", capability: "health", firstSeen: "2026-10-20T19:00:00.000Z" }],
    actionEvents: [{ at: "2026-10-20T19:30:00.000Z", event: "agent_action", operation: "restart", service: "portainer", targetType: "container", targetId: "qbittorrent", outcome: "succeeded" }],
    appEvents: [{ at: "2026-10-20T10:00:00.000Z", event: "application.started" }]
  });
  assert.match(text, /^History for the past 24 hours/u);
  assert.match(text, /- Sonarr: 1 problem, 1 h 40 min in total, one still open\. 10-20 19:00 until now \(still open\) \(health\)\./u);
  assert.match(text, /- Radarr: 2 problems, 37 min in total\./u, "7 minutes plus 30 before the window's start");
  assert.match(text, /- No problems: Jellyfin\./u);
  assert.match(text, /- Actions taken: 1\. restart container qbittorrent at 10-20 19:30\./u);
  assert.match(text, /Helmsman itself started 1 time/u);
});

test("a quiet period says so instead of inventing anything", () => {
  const text = buildHistory({ from: NOW - HOUR, to: NOW, label: "the past hour", monitored: ["sonarr"] });
  assert.match(text, /No problems were recorded for any monitored service\./u);
  assert.match(text, /No actions were taken\./u);
});

test("history reads the journal page by page and leaves out debug entries", async () => {
  const pages = [
    { entries: [{ level: "debug", event: "check.completed" }, { level: "error", event: "health_incident" }], nextCursor: "next" },
    { entries: [{ level: "info", event: "health_incident" }], nextCursor: null }
  ];
  const queries = [];
  const entries = await readWindow(async (query) => { queries.push(query); return pages[queries.length - 1]; }, { from: NOW - HOUR, to: NOW, category: "health" });
  assert.deepEqual(entries.map(({ level }) => level), ["error", "info"]);
  assert.equal(queries[1].cursor, "next");
  assert.equal(queries[0].from, new Date(NOW - HOUR).toISOString());
});
