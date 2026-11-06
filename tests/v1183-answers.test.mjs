import assert from "node:assert/strict";
import test from "node:test";
import { manualKeywords, manualLinesFor, placementVerdict, runTool } from "../server/agent-tools.mjs";
import { questionSeeds, workloadQueries } from "../server/agent-intent.mjs";
import { asksUntrackedBackup, startDates, untrackedTopics } from "../server/agent-untracked.mjs";

const GB = 1024 ** 3;
const guest = (vmid, name, type, node, { cores = 2, total = 4, used = 2, cpu = 1, up = 86_400 * 9, status = "running" } = {}) => ({
  id: `lab/${type}/${vmid}`, vmid, name, type, node, status, cpuCores: cores, cpuPercent: cpu,
  memoryTotalBytes: total * GB, memoryUsedBytes: used * GB, uptimeSeconds: up, backup: { status: "success", ageSeconds: 3600 * (vmid % 7 + 3) }
});
const container = (name, env, image, { stack = null, status = "Up 2 weeks" } = {}) => ({ name, environmentName: env, image, stack, state: "running", status, ports: [] });
const SNAPSHOT = {
  infrastructure: {
    environments: [{
      id: "lab", type: "proxmox", displayName: "Main",
      nodes: [{ name: "Main", status: "online", uptimeSeconds: 86_400 * 14 }, { name: "norco", status: "online", uptimeSeconds: 86_400 * 9 }],
      workloads: [
        guest(100, "Jelly-Arr", "qemu", "Main", { cores: 4, total: 12, used: 7.2, cpu: 4.3 }),
        guest(102, "haos-17.2", "qemu", "norco", { cores: 2, total: 4, used: 3.6, cpu: 1 }),
        guest(109, "docker", "qemu", "norco", { cores: 4, total: 7.9, used: 3.7, cpu: 0.7 }),
        guest(201, "docker", "qemu", "norco", { cores: 2, total: 7.9, used: 4.6, cpu: 3.4 }),
        guest(106, "pihole", "lxc", "norco", { cores: 1, total: 0.5, used: 0.04, cpu: 0.1 }),
        guest(114, "ollama", "lxc", "norco", { cores: 4, total: 8, used: 4.1, cpu: 47 }),
        guest(152, "frigate", "lxc", "norco", { cores: 6, total: 8, used: 2.2, cpu: 3.8 })
      ]
    }],
    portainer: [{
      displayName: "Portainer",
      inventory: { containers: [
        container("radarr", "Jelly-Arr", "lscr.io/linuxserver/radarr:latest", { stack: "arrstack" }),
        container("helmsman-helmsman-1", "Jelly-Arr", "ghcr.io/owner/helmsman:latest", { stack: "helmsman", status: "Up 4 hours (healthy)" }),
        container("paperless-db-1", "Main Docker", "docker.io/library/postgres:17", { stack: "paperless" }),
        container("paperless-webserver-1", "Main Docker", "ghcr.io/paperless-ngx/paperless-ngx:3.0.5", { stack: "paperless" }),
        container("grafana", "PVE-2", "grafana/grafana:13.1.3", { stack: "grafana" }),
        container("loki", "PVE-2", "grafana/loki:3.7.6", { stack: "loki" }),
        container("authentik-postgresql-1", "PVE-2", "postgres:16-alpine", { stack: "authentik" })
      ] }
    }]
  }
};
const context = { snapshot: () => SNAPSHOT, timeZone: "UTC" };
const keys = (question) => untrackedTopics(question, ["Jelly-Arr", "caddy", "Main", "norco", "docker"]).map((topic) => topic.key);
const queries = (question) => workloadQueries(SNAPSHOT, question, { workloadWords: questionSeeds(question).workloads });

test("v1.18.3: questions about what Helmsman can't see are named, answerable ones are not", () => {
  assert.deepEqual(keys("Which backup storage holds Kasm's backups?"), ["backup-storage"]);
  assert.deepEqual(keys("Were any guests skipped by the last backup job?"), ["backup-jobs"]);
  assert.deepEqual(keys("Is Kasm's latest backup marked protected?"), ["backup-details"]);
  assert.deepEqual(keys("Which guests have only one successful backup?"), ["backup-files"]);
  assert.deepEqual(keys("Which containers have an OOM-killed flag?"), ["container-restarts"]);
  assert.deepEqual(keys("list guests that have tags."), ["guest-config"]);
  assert.deepEqual(keys("Show VMs configured to start at boot."), ["guest-config"]);
  assert.deepEqual(keys("Which guests have no IP reported?"), ["guest-ips"]);
  assert.deepEqual(keys("Did norco's memory usage climb steadily over the last day?"), ["metric-history"]);
  assert.deepEqual(keys("When did Main last boot?"), ["start-history"]);
  assert.deepEqual(keys("Is quorum healthy with both nodes and the QDevice?"), ["quorum"]);
  assert.deepEqual(keys("Is norco on the same Proxmox version as Main?"), ["node-version"]);
  for (const answerable of ["Rank my VMs by CPU, highest first.", "How many guests have backups less than a day old?", "Which guests only have backups older than 30 days?",
    "Give me the three VMs with the lowest CPU use.", "Count guests by current power state.", "How many stopped LXCs are there cluster-wide?", "Which containers use an image tagged latest?"]) {
    assert.deepEqual(keys(answerable), [], answerable);
  }
  assert.ok(asksUntrackedBackup("is seerr included in a configured backup job?"), "no Yes/No backup verdict for a job question");
  assert.ok(!asksUntrackedBackup("Is caddy's backup recent?"));
});

test("v1.18.3: memory rankings give GB in use, unused memory and memory per core", async () => {
  const memory = await runTool("list_workloads", { filter: "memory" }, context);
  assert.match(memory, /\nBy memory in use in GB, most first \(for "most RAM used", "biggest consumer", "in GB"\): Jelly-Arr \(VM 100\) 7\.2 GB, docker \(VM 201\) 4\.6 GB,/u);
  assert.deepEqual(queries("which running VM has the most unused assigned RAM in GB?"), [{ filter: "unused vms" }]);
  assert.deepEqual(queries("Which LXC has the largest gap between RAM allocation and actual use?"), [{ filter: "unused lxcs" }]);
  const unused = await runTool("list_workloads", { filter: "unused vms" }, context);
  assert.match(unused, /most GB first: 1\. Jelly-Arr \(VM 100\): 4\.8 GB unused of 12 GB \(uses 7\.2 GB, 40% unused\), 2\. docker \(VM 109\): 4\.2 GB unused/u);
  assert.deepEqual(queries("Which guest has the highest memory usage per configured CPU core?"), [{ filter: "memorypercore" }]);
  assert.deepEqual(queries("Rank VMs by assigned RAM per vCPU."), [{ filter: "allocatedpercore vms" }]);
  assert.match(await runTool("list_workloads", { filter: "allocatedpercore vms" }, context), /most first: 1\. docker \(VM 201, norco\): 4\.0 GB per core \(7\.9 GB assigned, 2 cores\), 2\. Jelly-Arr \(VM 100, Main\): 3\.0 GB per core/u);
  assert.deepEqual(queries("what LXC has the highest CPU utilization per assigned core?"), [{ filter: "coresused lxcs" }]);
  assert.match(await runTool("list_workloads", { filter: "coresused lxcs" }, context), /In whole cores in use \(percent × cores\), most first: ollama \(LXC 114\) 1\.88, frigate \(LXC 152\) 0\.23/u);
  assert.deepEqual(queries("Which VM has the most assigned RAM, regardless of current use?"), [{ filter: "allocated vms" }], "use ruled out is not a usage question");
  assert.deepEqual(queries("Which of ollama and frigate has more memory assigned?").at(-1), { filter: "allocated" });
});

test("v1.18.3: whether two things share a host is worked out by code", () => {
  assert.equal(placementVerdict(SNAPSHOT, "Do grafana and loki share a Portainer environment?"), "Where these run, worked out by Helmsman: Yes: grafana and loki both run on Docker host PVE-2.");
  assert.match(placementVerdict(SNAPSHOT, "are paperless-db-1 and paperless-webserver-1 hosted together?"), /Yes: paperless-db-1 and paperless-webserver-1 both run on Docker host Main Docker\./u);
  assert.match(placementVerdict(SNAPSHOT, "Does Helmsman run on the same VM as the arr stack?"), /Yes: the helmsman stack and the arrstack stack both run on Docker host Jelly-Arr \(VM 100 Jelly-Arr on node Main\)\./u);
  assert.match(placementVerdict(SNAPSHOT, "Is radarr on the same host as grafana?"), /^Where these run, worked out by Helmsman: No: radarr runs on Docker host Jelly-Arr/u);
  assert.match(placementVerdict(SNAPSHOT, "Are pihole and ollama on the same node?"), /Yes: pihole \(LXC 106\) and ollama \(LXC 114\) are both on node norco, as separate guests\./u);
  assert.match(placementVerdict(SNAPSHOT, "does radarr run on the same machine as Jelly-Arr?"), /radarr runs inside Jelly-Arr \(VM 100\)/u);
  assert.equal(placementVerdict(SNAPSHOT, "Is docker on the same node as pihole?"), null, "a name two guests share is not guessed");
  assert.equal(placementVerdict(SNAPSHOT, "Is grafana healthy?"), null);
});

test("v1.18.3: a guest's own manual row comes first, and hardware words find the hardware line", () => {
  const manual = [
    "## Backups", "- Nightly jobs back up all guests with the note {{guestname}}.",
    "## Identity", "- The Live Gateway's endpoint list must use norco (192.168.0.10), not Unitrend.",
    "## Guests on Main", "- Jelly-Arr: VM 100 on Main, 192.168.0.7. Runs Jellyfin (native) and the arr stack.",
    "## Hosts", "- norco hardware: Intel Core i5-11600, ASUS Z590 board, Norco RPC-450 4U case.", "- norco CPU governor is powersave."
  ].join("\n");
  const ip = "What IP do my notes list for Jelly-Arr?";
  assert.deepEqual(manualKeywords(ip), ["ip", "list", "jelly-arr"], "\"notes\" is about the asking");
  assert.match(manualLinesFor(manual, ip, manualKeywords(ip), 6, { subjects: ["Jelly-Arr"] })[0], /^\[Guests on Main\] - Jelly-Arr: VM 100 on Main, 192\.168\.0\.7/u);
  for (const question of ["What motherboard does norco use?", "What server chassis is norco running in?", "what's the CPU model in norco?"]) {
    assert.match(manualLinesFor(manual, question, manualKeywords(question), 6, { subjects: ["norco"] })[0], /norco hardware: Intel Core i5-11600/u, question);
  }
});

test("v1.18.3: container images, health and uptime are summed across hosts", async () => {
  const images = await runTool("list_workloads", { filter: "containers images" }, context);
  assert.match(images, /\nBy registry: docker\.io \(Docker Hub\) 4 \(paperless-db-1, grafana, loki, authentik-postgresql-1\); ghcr\.io 2 \(helmsman-helmsman-1, paperless-webserver-1\); lscr\.io 1 \(radarr\)\./u);
  assert.match(images, /\nSame image repository on more than one container: postgres: paperless-db-1 \(17\), authentik-postgresql-1 \(16-alpine\)\./u);
  assert.match(images, /\nDistinct images \(repository and tag\): 7, across 7 containers\./u);
  assert.match(await runTool("list_workloads", { filter: "containers uptime" }, context), /\nUp less than a day: helmsman-helmsman-1 \(Up 4 hours \(healthy\)\); every other running container has been up longer\./u);
  assert.match(await runTool("list_workloads", { filter: "containers health" }, context), /\nAcross all hosts: 7 running, of which 1 report healthy, 0 unhealthy and 6 have no health check; 0 not running\./u);
});

test("v1.18.3: start dates from uptime, backup oldest and newest, and both guests named docker", async () => {
  const now = Date.parse("2026-11-04T18:00:00Z");
  assert.equal(startDates(SNAPSHOT, "When did Main last boot?", now, "UTC"),
    "Last started, worked out by Helmsman from uptime (it can't tell a restart from a first start, and keeps no earlier starts): node Main about Oct 21.");
  assert.match(startDates(SNAPSHOT, "When did ollama last start?", now, "UTC"), /ollama \(LXC 114\) about Oct 26/u);
  const backups = await runTool("list_workloads", { filter: "backups" }, context);
  assert.match(backups, /\nLatest results: 7 succeeded, 0 did not, 0 have none\./u);
  assert.match(backups, /\nOldest latest backup: docker \(VM 201, norco\), 8h ago\. Newest: pihole \(LXC 106, norco\), 4h ago\./u);
  const docker = await runTool("list_workloads", { filter: "docker" }, context);
  assert.match(docker, /^Note: 2 separate guests share the exact name docker: VM 109 on node norco, VM 201 on node norco\. Only the guest ID tells them apart; without one, answer for each by its ID\./u);
});
