import assert from "node:assert/strict";
import test from "node:test";
import { buildHistory } from "../server/agent-history.mjs";
import { CHANGE_LOG_QUESTION, manualChangeLog, manualKeywords, manualLinesFor, runTool } from "../server/agent-tools.mjs";
import { serviceVerdict } from "../server/agent.mjs";

const MANUAL = [
  "# Lab manual v2.8",
  "- Written 30 Oct 2026 from v2.7.2 (20 Oct) plus later changes.",
  "## Network",
  "- Internet: Spectrum 1 Gbps plan.",
  "## Change log",
  "- v2.7.2, 20 Oct 2026: switch removed.",
  "- v2.8, 30 Oct 2026: ollama LXC 114 and local AI.",
  "- v2.7, 16 Oct 2026: repairs."
].join("\n");

test("v1.18.0: what changed in the manual gets the newest change-log entries first", () => {
  assert.ok(CHANGE_LOG_QUESTION.test("what changed in the last manual update?"));
  assert.ok(CHANGE_LOG_QUESTION.test("what's in the change log?"));
  assert.ok(!CHANGE_LOG_QUESTION.test("what changes when pihole restarts? no wait, what port is pihole on"), "only questions about the manual's changes");
  assert.deepEqual(manualChangeLog(MANUAL, 2), [
    "[Change log] - v2.8, 30 Oct 2026: ollama LXC 114 and local AI.",
    "[Change log] - v2.7.2, 20 Oct 2026: switch removed."
  ], "highest version first, whatever order the manual lists them in");
  const question = "what changed in the last manual update?";
  const lines = manualLinesFor(MANUAL, question, manualKeywords(question));
  assert.equal(lines[0], "[Change log] - v2.8, 30 Oct 2026: ollama LXC 114 and local AI. (the newest change-log entry)");
  assert.equal(lines.filter((line) => line.includes("v2.8, 30 Oct")).length, 1, "not repeated by the word matches");
  assert.deepEqual(manualChangeLog("## Network\n- flat"), [], "no change log, nothing added");
  const plain = manualLinesFor(MANUAL, "what's my ISP?", manualKeywords("what's my ISP?"));
  assert.ok(!plain.some((line) => line.includes("newest change-log entry")), "other questions are unchanged");
});

const guest = (vmid, name, type, node, status = "running") => ({ id: `lab/${type}/${vmid}`, vmid, name, type, node, status, cpuCores: 2, memoryTotalBytes: 2 ** 31, memoryUsedBytes: 2 ** 30 });
const SNAPSHOT = {
  infrastructure: {
    environments: [{
      id: "lab", type: "proxmox", displayName: "Lab", nodes: [{ name: "norco", status: "online" }],
      workloads: [
        guest(151, "Kasm", "qemu", "norco"),
        guest(102, "haos", "qemu", "norco"),
        guest(112, "rhel", "qemu", "norco", "stopped"),
        guest(105, "caddy", "lxc", "norco"),
        guest(106, "pihole", "lxc", "norco")
      ]
    }],
    portainer: []
  }
};
const context = { snapshot: () => SNAPSHOT, timeZone: "UTC" };

test("v1.18.0: which VMs share a node lists only the VMs, which LXCs only the LXCs", async () => {
  const vms = await runTool("list_workloads", { filter: "beside vms kasm" }, context);
  assert.equal(vms, "Kasm (VM 151) shares node norco with 2 other VMs. Running (1): haos (VM 102). Not running (1): rhel (VM 112) stopped. The node's other 2 guests are LXCs, not asked about.");
  const lxcs = await runTool("list_workloads", { filter: "beside lxcs kasm" }, context);
  assert.match(lxcs, /^Kasm \(VM 151\) shares node norco with 2 other LXCs\. Running \(2\): caddy \(LXC 105\), pihole \(LXC 106\)\. None are stopped\. The node's other 2 guests are VMs/u);
  const all = await runTool("list_workloads", { filter: "beside kasm" }, context);
  assert.match(all, /shares node norco with 4 other guests/u, "without a kind, everything on the node");
});

test("v1.18.0: history gives every longest problem's times and says when a service stayed reachable", () => {
  const at = (iso) => new Date(iso).toISOString();
  const incident = (id, service, capability, start, end, code) => [
    { at: at(start), event: "health_incident", targetId: id, service, capability, code, level: "warn" },
    { at: at(end), event: "health_incident", targetId: id, service, capability, outcome: "recovered" }
  ];
  const text = buildHistory({
    from: Date.parse("2026-11-03T00:00:00Z"), to: Date.parse("2026-11-03T23:00:00Z"), label: "today",
    healthEvents: [
      ...incident("r1", "radarr", "health", "2026-11-03T14:18:00Z", "2026-11-03T21:26:00Z", "HEALTH_WARNING"),
      ...incident("r2", "radarr", "health", "2026-11-03T11:00:00Z", "2026-11-03T11:10:00Z", "HEALTH_WARNING"),
      ...incident("q1", "qbittorrent", "status", "2026-11-03T07:00:00Z", "2026-11-03T07:30:00Z", "TIMEOUT"),
      ...incident("q2", "qbittorrent", "health", "2026-11-03T08:00:00Z", "2026-11-03T08:05:00Z", "HEALTH_WARNING")
    ],
    monitored: ["radarr", "qbittorrent"],
    format: (iso) => iso.slice(11, 16)
  });
  const radarr = text.split("\n").find((line) => line.startsWith("- radarr: "));
  assert.equal(radarr, "- radarr: 2 problems, 7 h 18 min in total, longest single problem 7 h 8 min (14:18–21:26); it stayed reachable throughout, so these were warnings, not outages. 14:18–21:26 (health HEALTH_WARNING); 11:00–11:10 (health HEALTH_WARNING).",
    "the longest's times even when it is also the latest");
  const qbit = text.split("\n").find((line) => line.startsWith("- qbittorrent: "));
  assert.ok(!/stayed reachable/u.test(qbit), "a status problem means Helmsman could not reach it");

  assert.equal(serviceVerdict("Radarr", radarr.replace("- radarr", "- Radarr")),
    "Radarr had 2 problems in this period, 7 h 18 min in total; the longest lasted 7 h 8 min, 14:18–21:26. It stayed reachable throughout, so these were warnings, not outages.");
  assert.equal(serviceVerdict("qBittorrent", qbit.replace("- qbittorrent", "- qBittorrent")),
    "qBittorrent had 2 problems in this period, 35 min in total; the longest lasted 30 min, 07:00–07:30. So yes, it had problems (each is a time it was unhealthy or unreachable).");
  assert.equal(serviceVerdict("Sonarr", undefined), "Sonarr had no problems recorded in this period.");
});
