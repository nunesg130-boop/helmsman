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
