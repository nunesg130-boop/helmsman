import assert from "node:assert/strict";
import test from "node:test";

import { isFollowUp, mergeSeeds, questionSeeds, workloadQuery } from "../server/agent-intent.mjs";
import { parseActionCommand, runTool } from "../server/agent-tools.mjs";
import { questionWindow } from "../server/agent-history.mjs";

const NOW = Date.parse("2026-10-28T23:00:00Z");

function lab({ containers = 40 } = {}) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    services: [{ id: "sonarr", label: "Sonarr", state: "healthy" }, { id: "seerr", label: "Seerr", state: "healthy" }],
    infrastructure: {
      environments: [{
        id: "env-1",
        displayName: "Lab",
        nodes: [{ name: "alpha", status: "online", uptimeSeconds: 7 * 86_400, cpuPercent: 3, memoryUsedBytes: 1, memoryTotalBytes: 2 }],
        workloads: [
          { vmid: 100, name: "Media-Box", type: "qemu", node: "alpha", status: "running" },
          { vmid: 101, name: "dns", type: "lxc", node: "alpha", status: "stopped" }
        ]
      }],
      portainer: [{
        id: "p-1",
        displayName: "Docker host",
        inventory: {
          containers: [
            ...Array.from({ length: containers }, (_, index) => ({ name: `app-${index}`, state: "running", status: "Up 2 days", environmentName: "local" })),
            { name: "gluetun", state: "running", status: "Up 2 days (unhealthy)", environmentName: "local" },
            { name: "sonarr", state: "running", status: "Up 2 days", environmentName: "local" },
            { name: "paperless-db-1", state: "running", status: "Up", environmentName: "local" },
            { name: "paperless-webserver-1", state: "exited", status: "Exited (1)", environmentName: "local" }
          ]
        }
      }]
    },
    media: {
      calendar: [
        { title: "Old Show", releaseAt: "2026-05-31T20:00:00Z" },
        { title: "Next Week Show", releaseAt: "2026-11-03T20:00:00Z" },
        { title: "Tomorrow Show", releaseAt: "2026-10-29T20:00:00Z" }
      ]
    }
  };
}

const context = (snapshot) => ({ snapshot: () => snapshot, now: () => NOW, timeZone: "UTC" });

test("a long inventory is summarised so the containers are never cut off", async () => {
  const output = await runTool("list_workloads", {}, context(lab()));
  assert.match(output, /^Nodes: alpha \(Proxmox Lab\) online, up 7d, cpu 3%, memory 50%\./mu);
  assert.match(output, /^VMs: 1 in total, 1 running\. Running: Media-Box \(100, alpha\)\.$/mu);
  assert.match(output, /^LXCs: 1 in total, 0 running; not running or locked: dns \(101, alpha\) \(stopped\)\.$/mu);
  assert.match(output, /^Containers on local \(Portainer Docker host\): 44, 43 running; not running: paperless-webserver-1 \(exited\); running but unhealthy: gluetun\.$/mu, "a broad question gets counts and the problems");
  assert.ok(output.length <= 1_400);
  // Asking for containers lists them, problems first, and says how many did not fit.
  const containers = await runTool("list_workloads", { filter: "containers" }, context(lab({ containers: 200 })));
  assert.match(containers, /^Containers on local \(Portainer Docker host\): \d+, \d+ running; not running: paperless-webserver-1 \(exited\); running but unhealthy: gluetun\. Running: .* …and \d+ more\.$/mu);
  assert.ok(containers.length <= 1_400, "fits without being shortened");
  assert.doesNotMatch(containers, /shortened|more lines not shown/u);
  // A kind gives just that kind; a name gives its full line.
  assert.match(await runTool("list_workloads", { filter: "lxcs" }, context(lab())), /^LXCs: 1 in total, 0 running; not running or locked: dns \(101, alpha\) \(stopped\)\.$/u);
  assert.match(await runTool("list_workloads", { filter: "gluetun" }, context(lab())), /^container gluetun \(Docker host\/local\): running, Up 2 days \(unhealthy\)$/u);
});

test("the workload list is narrowed to what a question names", () => {
  const snapshot = lab({ containers: 3 });
  const query = (text) => workloadQuery(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(query("is gluetun running"), { filter: "gluetun" });
  assert.deepEqual(query("is the vpn container running"), { filter: "gluetun" }, "a nickname finds the container");
  assert.deepEqual(query("is the paperless container running"), { filter: "paperless" }, "several that share the word");
  assert.deepEqual(query("which containers are stopped?"), { filter: "containers" });
  assert.deepEqual(query("List my VMs"), { filter: "vms" });
  assert.deepEqual(query("what's running on alpha"), { filter: "alpha" });
  assert.equal(query("Is sonarr up?"), null, "a monitored service gets its own status instead");
  assert.deepEqual(query("Is the sonarr container running?"), { filter: "sonarr" });
  assert.equal(query("How is everything looking?"), null);
});

test("short follow-ups continue the previous question; thanks do not", () => {
  for (const text of ["and main?", "what about radarr?", "is it healthy?", "which was the longest?", "why?", "and yesterday?"]) assert.equal(isFollowUp(text), true, text);
  for (const text of ["ok thanks", "Thanks!", "never mind", "How is everything looking right now overall?"]) assert.equal(isFollowUp(text), false, text);
  assert.deepEqual(mergeSeeds({ manual: false, media: true }, { manual: true, media: false }), { manual: true, media: true });
  assert.equal(questionSeeds("what hardware is norco").manual, true);
  assert.equal(questionSeeds("what's my network layout").manual, true);
  assert.equal(questionSeeds("what's the CPU temperature").manual, false);
  assert.equal(questionSeeds("when does the next episode come out?").media, true);
});

test("upcoming releases are only those still ahead, soonest first", async () => {
  const output = await runTool("media_queue", {}, context(lab()));
  assert.match(output, /Upcoming releases \(release dates, not downloads\):\n- Tomorrow Show .*\n- Next Week Show/u);
  assert.doesNotMatch(output, /Old Show/u);
});

test("the weekend means the most recent Saturday and Sunday", () => {
  // Wednesday 2026-10-28: the weekend was Saturday 24 to Monday 26 October.
  assert.deepEqual(questionWindow("how did things go over the weekend?", NOW, "UTC"), { from: Date.parse("2026-10-24T00:00:00Z"), to: Date.parse("2026-10-26T00:00:00Z"), label: "the weekend" });
  assert.equal(questionWindow("when was the last problem?", NOW, "UTC").label, "the past week");
});

test("an app nickname never becomes a VM reboot by a loose match", () => {
  const snapshot = lab({ containers: 0 });
  snapshot.infrastructure.environments[0].workloads.push({ vmid: 102, name: "Jelly-Arr", type: "qemu", node: "alpha", status: "running" });
  const result = parseActionCommand("restart jelly", snapshot);
  assert.match(result.error, /There's no container, VM or LXC called jellyfin\. Did you mean VM 102 \(Jelly-Arr\)\?/u);
  assert.equal(parseActionCommand("restart the torrent client", { infrastructure: { portainer: [{ id: "p", inventory: { containers: [{ name: "qbittorrent" }] } }] } }).target.label, "container qbittorrent");
});

test("containers are grouped per host, and same-named guests are both shown", async () => {
  const snapshot = lab({ containers: 2 });
  snapshot.infrastructure.portainer[0].inventory.containers.push({ name: "grafana", state: "running", status: "Up", environmentName: "second" });
  snapshot.infrastructure.environments[0].workloads.push(
    { vmid: 109, name: "docker", type: "qemu", node: "alpha", status: "running" },
    { vmid: 201, name: "docker", type: "qemu", node: "beta", status: "running" }
  );
  const all = await runTool("list_workloads", {}, context(snapshot));
  assert.match(all, /^Containers on local \(Portainer Docker host\): 6, 5 running; /mu);
  assert.match(all, /^Containers on second \(Portainer Docker host\): 1, 1 running, none stopped or unhealthy\.$/mu);
  assert.match(await runTool("list_workloads", { filter: "docker" }, context(snapshot)), /^Note: 2 guests are named docker: VM 109 on alpha, VM 201 on beta\.$/mu);
});

test("Proxmox, Portainer and nicknamed services get their own status, not a workload list", () => {
  const snapshot = lab({ containers: 2 });
  snapshot.services.push({ id: "jellyfin", label: "Jellyfin", state: "healthy" });
  snapshot.infrastructure.services = [{ id: "portainer-1", displayName: "Docker host", type: "portainer" }];
  snapshot.infrastructure.portainer[0].inventory.containers.push({ name: "portainer_agent", state: "running", status: "Up", environmentName: "local" });
  snapshot.infrastructure.environments[0].workloads.push({ vmid: 102, name: "Jelly-Arr", type: "qemu", node: "alpha", status: "running" });
  const query = (text) => workloadQuery(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.equal(query("is portainer healthy?"), null);
  assert.equal(query("is jelly ok?"), null);
  snapshot.infrastructure.environments[0].workloads.push({ vmid: 109, name: "docker", type: "qemu", node: "alpha", status: "running" });
  assert.deepEqual(query("is the docker vm up?"), { filter: "docker" });
  assert.deepEqual(query("which docker containers are stopped?"), { filter: "containers" });
  assert.deepEqual(query("is the portainer_agent container running?"), { filter: "portainer_agent" });
});

test("guests ranked by memory, CPU or backup age, and a node's own guests", async () => {
  const snapshot = lab({ containers: 2 });
  const env = snapshot.infrastructure.environments[0];
  env.nodes.push({ name: "beta", status: "online", uptimeSeconds: 3600, cpuPercent: 9, memoryUsedBytes: 1, memoryTotalBytes: 4 });
  env.workloads = [
    { vmid: 100, name: "Media-Box", type: "qemu", node: "alpha", status: "running", cpuPercent: 4, memoryUsedBytes: 3, memoryTotalBytes: 4, backup: { status: "success", ageSeconds: 5 * 86_400 } },
    { vmid: 102, name: "haos", type: "qemu", node: "beta", status: "running", cpuPercent: 30, memoryUsedBytes: 9, memoryTotalBytes: 10 },
    { vmid: 101, name: "dns", type: "lxc", node: "beta", status: "running", cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 10, backup: { status: "success", ageSeconds: 50 * 86_400 } },
    { vmid: 112, name: "old", type: "qemu", node: "beta", status: "stopped" }
  ];
  assert.match(await runTool("list_workloads", { filter: "memory" }, context(snapshot)),
    /highest first .*: haos \(VM 102, beta\): 90%, Media-Box \(VM 100, alpha\): 75%, dns \(LXC 101, beta\): 10%\. Not running, so no usage: old \(VM 112, beta\)/u);
  assert.match(await runTool("list_workloads", { filter: "cpu" }, context(snapshot)), /: haos \(VM 102, beta\): 30%, Media-Box/u);
  const backups = await runTool("list_workloads", { filter: "backups" }, context(snapshot));
  assert.match(backups, /^These have a backup \(oldest first\): dns \(LXC 101, beta\): success 50d ago, Media-Box \(VM 100, alpha\): success 5d ago\.$/mu);
  assert.match(backups, /^These have no backup recorded at all: haos \(VM 102, beta\), old \(VM 112, beta\)\.$/mu);
  const beta = await runTool("list_workloads", { filter: "beta" }, context(snapshot));
  assert.match(beta, /^node beta /mu);
  assert.doesNotMatch(beta, /Media-Box|node alpha/u, "only what runs on that node");
  const query = (text) => workloadQuery(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(query("Which VM is using the most memory?"), { filter: "memory" });
  assert.deepEqual(query("which guests haven't been backed up recently?"), { filter: "backups" });
  assert.deepEqual(query("how much memory is haos using"), { filter: "haos" }, "a named guest gets its own line");
  assert.deepEqual(query("what's running on beta"), { filter: "beta" });
  assert.equal(questionSeeds("What runs on VM 109?").manual, true, "roles are in the manual");
});

test("a container total is given when containers are on several hosts", async () => {
  const snapshot = lab({ containers: 2 });
  snapshot.infrastructure.portainer[0].inventory.containers.push({ name: "grafana", state: "running", status: "Up", environmentName: "second" });
  assert.match(await runTool("list_workloads", { filter: "containers" }, context(snapshot)), /^Containers: 7 in total on 2 hosts, 6 running \(1 of them unhealthy\), 1 not running\.$/mu);
});
