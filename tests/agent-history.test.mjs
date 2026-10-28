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
  assert.match(text, /- Radarr: 2 problems, 37 min in total, longest 30 min\./u, "7 minutes plus 30 before the window's start");
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

test("restart and lost-connection questions are history questions; requests and capability questions are not", async () => {
  const { isRestartQuestion } = await import("../server/agent-history.mjs");
  for (const text of ["Did norco restart or lose connection?", "Did my server reboot?", "Why were alerts held?", "Is a node unreachable?", "Is norco back?", "When did the node come back?", "Why did main go offline?", "Did proxmox lose contact?", "was that a blip"]) {
    assert.equal(isRestartQuestion(text), true, text);
    assert.equal(questionWindow(text, NOW, "America/New_York")?.label, "the past 24 hours", text);
  }
  for (const text of ["restart qbit", "Can you restart services?", "Will you restart things without asking?", "Is sonarr up?", "How's my wifi?"]) {
    assert.equal(isRestartQuestion(text), false, text);
  }
});

test("overnight means last night in the owner's time zone, not the last 14 hours", () => {
  // 16:40 in New York: last night is 22:00 the evening before until 08:00.
  const afternoon = questionWindow("What happened overnight?", NOW, "America/New_York");
  assert.deepEqual(afternoon, { from: Date.parse("2026-10-20T02:00:00Z"), to: Date.parse("2026-10-20T12:00:00Z"), label: "overnight (22:00 to 08:00)" });
  // Asked at 06:00, it runs until now.
  const early = Date.parse("2026-10-20T10:00:00Z");
  assert.equal(questionWindow("anything last night?", early, "America/New_York").to, early);
});

test("an incident with no recorded end is counted only to its last record, never to a later restart", () => {
  const text = buildHistory({
    from: NOW - 7 * 24 * HOUR,
    to: NOW,
    label: "the past week",
    format: (iso) => iso.slice(5, 16).replace("T", " "),
    nameOf: (id) => ({ portainer: "Portainer", "proxmox-main": "Proxmox Main", main: "Proxmox Main" }[id] || id),
    monitored: ["main", "portainer"],
    healthEvents: [
      // Opened, then Helmsman restarted and the incident never recorded a recovery.
      { at: "2026-10-14T21:00:00.000Z", event: "health_incident", outcome: "changed", service: "portainer", capability: "containers", targetId: "p1" },
      { at: "2026-10-20T19:38:00.000Z", event: "health_incident", outcome: "changed", service: "proxmox-main", capability: "nodes", code: "NODES_OFFLINE", targetId: "m1" },
      { at: "2026-10-20T19:43:00.000Z", event: "health_incident", outcome: "recovered", service: "proxmox-main", targetId: "m1" },
      { at: "2026-10-20T19:38:00.000Z", event: "node_contact", outcome: "changed", service: "helmsman", message: "Helmsman lost contact with norco; whether it restarted or only lost its network connection is not known yet." },
      { at: "2026-10-20T19:43:00.000Z", event: "node_contact", outcome: "recovered", service: "helmsman", message: "Helmsman lost contact with norco at 19:38 for about 5 minutes, but it never went down." }
    ],
    appEvents: [{ at: "2026-10-14T22:00:00.000Z", event: "application.started" }],
    restartNow: null
  });
  assert.match(text, /- Portainer: 1 problem, 1 min in total\. .*\(no recovery recorded; last seen then\)/u);
  assert.doesNotMatch(text, /still open/u);
  assert.match(text, /- Proxmox Main: 1 problem, 5 min in total/u);
  assert.doesNotMatch(text, /No problems: .*Proxmox Main/u, "a service with problems is never also listed as quiet");
  assert.match(text, /- Node contact at 10-20 19:43: Helmsman lost contact with norco at 19:38 for about 5 minutes, but it never went down\./u);
  assert.match(text, /- Right now no node is restarting or out of contact, and no alerts are held\./u);
});

test("a problem that recovered after the window ends is not called still open", () => {
  const text = buildHistory({
    from: NOW - 24 * HOUR,
    to: NOW - 4 * HOUR,
    label: "yesterday",
    format: (iso) => iso.slice(5, 16).replace("T", " "),
    nameOf: (id) => id,
    healthEvents: [
      { at: "2026-10-20T14:00:00.000Z", event: "health_incident", outcome: "changed", service: "prowlarr", targetId: "x" },
      { at: "2026-10-20T19:00:00.000Z", event: "health_incident", outcome: "recovered", service: "prowlarr", targetId: "x" }
    ],
    restartNow: { kind: "unreachable", nodes: ["norco"], since: "2026-10-20T20:30:00.000Z", holding: true }
  });
  assert.match(text, /- prowlarr: 1 problem, 2 h 40 min in total\./u);
  assert.doesNotMatch(text, /still open/u);
  assert.match(text, /Right now: Helmsman has lost contact with norco since 10-20 20:30, and alerts are held until it settles\./u);
});

test("a superseded or retired incident ends where it was replaced, and an unrecorded node outage says so", () => {
  const text = buildHistory({
    from: NOW - 7 * 24 * HOUR,
    to: NOW,
    label: "the past week",
    format: (iso) => iso.slice(5, 16).replace("T", " "),
    nameOf: (id) => ({ "proxmox-main": "Proxmox Main" }[id] || id),
    healthEvents: [
      { at: "2026-10-18T18:00:00.000Z", event: "health_incident", outcome: "changed", operation: "opened", service: "proxmox-main", capability: "tasks", code: "TASK_HISTORY_PARTIAL", targetId: "t1" },
      { at: "2026-10-18T18:30:00.000Z", event: "health_incident", outcome: "changed", operation: "superseded", service: "proxmox-main", capability: "tasks", targetId: "t1" },
      { at: "2026-10-19T09:00:00.000Z", event: "health_incident", outcome: "changed", operation: "opened", service: "proxmox-main", capability: "nodes", code: "NODES_OFFLINE", targetId: "n1" },
      { at: "2026-10-19T09:05:00.000Z", event: "health_incident", outcome: "recovered", operation: "recovered", service: "proxmox-main", targetId: "n1" }
    ],
    appEvents: [{ at: "2026-10-20T19:00:00.000Z", event: "application.started" }]
  });
  assert.match(text, /- Proxmox Main: 2 problems, 35 min in total, longest 30 min\./u, "superseded after 30 minutes, not stretched to the restart two days later");
  assert.match(text, /Proxmox Main reported a node offline at 10-19 09:00 for 5 min; whether it restarted or only lost its connection was not recorded for that time\./u);
});
