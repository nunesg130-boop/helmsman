import assert from "node:assert/strict";
import test from "node:test";

import { manualKeywords, manualMatches } from "../server/agent-tools.mjs";

const MANUAL = [
  "# Homelab",
  "## Hosts",
  "| Host | Address | Role |",
  "| --- | --- | --- |",
  "| norco | 192.168.0.40 | Proxmox node |",
  "| main | 192.168.0.30 | Proxmox node |",
  "## Media pipeline",
  "The pipeline runs Sonarr and Radarr in Docker.",
  "## Proxmox",
  "Cluster quorum uses a QDevice."
].join("\n");

test("keywords drop filler words and keep host names and addresses", () => {
  assert.deepEqual(manualKeywords("What's the IP of the norco server?"), ["ip", "norco", "server"]);
  assert.deepEqual(manualKeywords("search_manual tool for norco ip"), ["norco", "ip"]);
  assert.deepEqual(manualKeywords("yes"), []);
  assert.deepEqual(manualKeywords("Is 192.168.0.40 up?"), ["192.168.0.40"]);
});

test("matches whole words, so ip does not match pipeline", () => {
  const hits = manualMatches(MANUAL, ["norco", "ip"]);
  assert.equal(hits[0], "[Hosts] | norco | 192.168.0.40 | Proxmox node |");
  assert.equal(hits.some((line) => line.includes("pipeline runs")), false);
});

test("longer words match the start of a word, and headings count a little", () => {
  const hits = manualMatches(MANUAL, ["proxmo"]);
  assert.ok(hits.includes("[Hosts] | norco | 192.168.0.40 | Proxmox node |"));
  assert.ok(hits.includes("[Proxmox] Cluster quorum uses a QDevice."), "a line under a matching heading is found");
  assert.deepEqual(manualMatches(MANUAL, []), []);
  assert.equal(manualMatches(MANUAL, ["---"]).length, 0, "table separator rows are skipped");
});

import { isApprovalMessage, parseActionCommand } from "../server/agent-tools.mjs";

const INVENTORY = {
  infrastructure: {
    portainer: [{
      id: "p1", displayName: "Docker", targetRevision: "r1",
      inventory: { containers: [
        { id: "c1", name: "qbittorrent", environmentId: 1, environmentName: "local", state: "running" },
        { id: "c2", name: "home-assistant", environmentId: 1, environmentName: "local", state: "running" }
      ] }
    }],
    environments: [{
      id: "e1", displayName: "Lab", targetRevision: "r2",
      workloads: [
        { vmid: 114, type: "lxc", name: "ollama", node: "pve", status: "running" },
        { vmid: 900, type: "qemu", name: "template", node: "pve", status: "stopped", template: true }
      ]
    }]
  }
};

test("commands match names loosely and map verbs to each target kind", () => {
  assert.equal(parseActionCommand("Restart qBittorrent", INVENTORY).target.containerName, "qbittorrent");
  assert.equal(parseActionCommand("please restart the Home Assistant container", INVENTORY).target.containerName, "home-assistant");
  assert.equal(parseActionCommand("reboot ollama", INVENTORY).operation, "reboot");
  assert.equal(parseActionCommand("restart lxc 114", INVENTORY).operation, "reboot");
  assert.equal(parseActionCommand("stop qbittorrent now!", INVENTORY).operation, "stop");
  assert.equal(parseActionCommand("power on ollama", INVENTORY).operation, "start");
  assert.match(parseActionCommand("start vm 900", INVENTORY).error, /couldn't find/u, "templates are not targets");
});

test("anything that isn't only a command is left for the model", () => {
  assert.equal(parseActionCommand("Should I restart qbittorrent?", INVENTORY), null);
  assert.equal(parseActionCommand("why did qbittorrent restart", INVENTORY), null);
  assert.equal(parseActionCommand("How is everything looking?", INVENTORY), null);
  assert.equal(parseActionCommand("Can you restart services?", INVENTORY), null);
  assert.equal(parseActionCommand("restart everything", INVENTORY), null);
  assert.equal(parseActionCommand("Can you restart qbittorrent?", INVENTORY).target.containerName, "qbittorrent", "a question that names a target is still a request");
});

test("only plain approvals count as approval messages", () => {
  for (const text of ["approved", "Approve", "yes", "go ahead!", "ok do it"]) assert.equal(isApprovalMessage(text), true, text);
  for (const text of ["yes, but why is it down?", "approve the sonarr restart later", "restart it"]) assert.equal(isApprovalMessage(text), false, text);
});

test("a rare word outranks a common one, and hyphens don't split names", () => {
  const manual = [
    "## 3.1 Network edge", "| Device | IP | Role |", "| ER605 | 192.168.0.1 | Router |",
    "## 3.8 QDevice", "| IP | 192.168.0.11 |",
    "## 5.2 norco guests", "| VMID | Name | Type | IP | Role |", "| 106 | pihole | LXC | 192.168.0.106 | DNS + Unbound |",
    "## Appendix A", "| 192.168.0.106 | Pi-hole | norco LXC 106 |"
  ].join("\n");
  const hits = manualMatches(manual, ["ip", "pihole"]);
  assert.match(hits[0], /pihole \| LXC \| 192\.168\.0\.106/u, "Pi-hole's row first, not a table header");
  assert.ok(hits.slice(0, 2).some((hit) => /Pi-hole/u.test(hit)), "Pi-hole spelled with a hyphen still matches");
});
