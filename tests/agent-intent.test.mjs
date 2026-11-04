import assert from "node:assert/strict";
import test from "node:test";

import { isFollowUp, mergeSeeds, namedServices, questionSeeds, workloadQueries, workloadQuery, withoutWorkloadNames } from "../server/agent-intent.mjs";
import { manualKeywords, manualMatches, parseActionCommand, runTool, shortenText } from "../server/agent-tools.mjs";
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
  assert.match(output, /^Nodes: alpha \(Proxmox Lab\) online, up 7d, cpu 3%, memory 50%, 2 guests \(1 VM, 1 LXC\), 1 running\./mu);
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
  assert.match(await runTool("list_workloads", { filter: "gluetun" }, context(lab())), /^container gluetun on Docker host local \(Portainer Docker host\): running, Up 2 days \(unhealthy\)$/u);
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
  // Stack, image and neighbour questions about a service are about its container.
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads }).map((item) => item.filter);
  assert.deepEqual(queries("which stack is sonarr in?"), ["sonarr"]);
  assert.deepEqual(queries("what image does sonarr use"), ["sonarr"]);
  assert.deepEqual(queries("what else runs on the same host as sonarr?"), ["sonarr", "beside sonarr"]);
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
  assert.match(await runTool("list_workloads", { filter: "docker" }, context(snapshot)), /^Note: 2 guests are named docker: VM 109 on node alpha, VM 201 on node beta\.$/mu);
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
    /highest first .*: 1\. haos \(VM 102\): 90%, 2\. Media-Box \(VM 100\): 75%, 3\. dns \(LXC 101\): 10%\. Not running, so no usage: old \(VM 112, beta\)/u);
  assert.match(await runTool("list_workloads", { filter: "cpu" }, context(snapshot)), /: 1\. haos \(VM 102\): 30%, 2\. Media-Box/u);
  const backups = await runTool("list_workloads", { filter: "backups" }, context(snapshot));
  assert.match(backups, /^These have a backup \(oldest first\): dns \(LXC 101, beta\): success 50d ago \(over a month old\), Media-Box \(VM 100, alpha\): success 5d ago \(recent: within the last week\)\.$/mu);
  assert.match(backups, /^These have no backup recorded at all: haos \(VM 102, beta\), old \(VM 112, beta\)\.$/mu);
  const beta = await runTool("list_workloads", { filter: "beta" }, context(snapshot));
  assert.match(beta, /^node beta /mu);
  assert.doesNotMatch(beta, /Media-Box|node alpha/u, "only what runs on that node");
  const query = (text) => workloadQuery(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(query("Which VM is using the most memory?"), { filter: "memory vms" }, "only VMs when the question says VM");
  assert.deepEqual(query("What's using the most memory?"), { filter: "memory" });
  assert.deepEqual(query("which LXC is busiest?"), { filter: "cpu lxcs" });
  assert.deepEqual(query("what's the least busy VM?"), { filter: "cpu vms" });
  assert.deepEqual(query("Which VMs have no backup?"), { filter: "backups vms" });
  const vmsOnly = await runTool("list_workloads", { filter: "cpu vms" }, context(snapshot));
  assert.match(vmsOnly, /^CPU use of each running VM, highest first/u);
  assert.doesNotMatch(vmsOnly, /dns \(LXC/u, "no LXCs in a VM ranking");
  const lxcBackups = await runTool("list_workloads", { filter: "backups lxcs" }, context(snapshot));
  assert.match(lxcBackups, /^Backups of 1 LXC: 1 has one, 0 have none\.$/mu);
  assert.doesNotMatch(lxcBackups, /Media-Box/u);
  assert.match(backups, /^Backups of 4 guests: 2 have one, 2 have none\.$/mu);
  assert.match(await runTool("list_workloads", { filter: "haos" }, context(snapshot)), /^vm 102 haos on node beta: .*, no backup recorded$/mu, "a guest without a backup says so");
  assert.deepEqual(query("which guests haven't been backed up recently?"), { filter: "backups" });
  assert.deepEqual(query("how much memory is haos using"), { filter: "haos" }, "a named guest gets its own line");
  assert.deepEqual(query("what's running on beta"), { filter: "beta" });
  assert.deepEqual(query("list everything on beta"), { filter: "beta" }, "a node by name, even without a workload word");
  assert.equal(questionSeeds("What runs on VM 109?").manual, true, "roles are in the manual");
});

test("a container total is given when containers are on several hosts", async () => {
  const snapshot = lab({ containers: 2 });
  snapshot.infrastructure.portainer[0].inventory.containers.push({ name: "grafana", state: "running", status: "Up", environmentName: "second" });
  assert.match(await runTool("list_workloads", { filter: "containers" }, context(snapshot)), /^Containers: 7 in total on 2 hosts, 6 running \(1 of them unhealthy\), 1 not running\.$/mu);
});

test("an exact name is that guest, a Portainer host gets its containers, and guests have one total", async () => {
  const snapshot = lab({ containers: 2 });
  const env = snapshot.infrastructure.environments[0];
  env.workloads.push(
    { vmid: 109, name: "docker", type: "qemu", node: "alpha", status: "running", cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, backup: { status: "success", ageSeconds: 86_400 } },
    { vmid: 201, name: "docker", type: "qemu", node: "alpha", status: "running", cpuPercent: 2, memoryUsedBytes: 1, memoryTotalBytes: 4 },
    { vmid: 110, name: "Jelly-Box", type: "qemu", node: "alpha", status: "running", cpuPercent: 5, memoryUsedBytes: 1, memoryTotalBytes: 2 }
  );
  const containers = snapshot.infrastructure.portainer[0].inventory.containers;
  containers.push(
    { name: "docker-socket-proxy", state: "exited", status: "Exited (0)", environmentName: "Main Docker" },
    { name: "aliasvault", state: "running", status: "Up", environmentName: "Main Docker" },
    { name: "navidrome", state: "running", status: "Up", environmentName: "Jelly-Box" }
  );
  const run = (filter) => runTool("list_workloads", { filter }, context(snapshot));
  const docker = await run("docker");
  assert.match(docker, /^Note: 2 guests are named docker: VM 109 on node alpha, VM 201 on node alpha\.$/mu);
  assert.doesNotMatch(docker, /^container docker-socket-proxy/mu, "not every container containing the word");
  assert.match(docker, /^Docker containers, in case those are meant: local \(Portainer Docker host\) 6, 5 running .*Main Docker \(Portainer Docker host\) 2, 1 running \(not running: docker-socket-proxy \(exited\)\)/mu);
  const host = await run("Main Docker");
  assert.match(host, /^Containers on Main Docker \(Portainer Docker host\): 2, 1 running; not running: docker-socket-proxy \(exited\)\. Running: aliasvault\.$/mu);
  const both = await run("Jelly-Box");
  assert.match(both, /^vm 110 Jelly-Box on node alpha: /mu, "the VM's own line");
  assert.match(both, /^Containers on Jelly-Box \(Portainer Docker host, VM 110 on node alpha\): 1, 1 running, none stopped or unhealthy\. Running: navidrome\.$/mu, "and the containers on it");
  assert.match(await run(""), /^Guests: 5 in total \(4 VMs, 1 LXC\), 4 running \(4 VMs, 0 LXCs\)\.$/mu);

  const query = (text) => workloadQuery(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(query("what containers run on Main Docker?"), { filter: "Main Docker" }, "the host, not the word main");
  assert.deepEqual(query("how many containers are on Jelly-Box?"), { filter: "Jelly-Box" });
  assert.deepEqual(workloadQuery(snapshot, "which host is paperless-db-1 on?", { namesOnly: true }), { filter: "paperless-db-1" });
  assert.deepEqual(workloadQuery(snapshot, "which host is sonarr on?", { namesOnly: true }), { filter: "sonarr" }, "a service's container too");
  assert.equal(workloadQuery(snapshot, "what's the IP of alpha?", { namesOnly: true }), null, "an address question gets no node list");
  assert.equal(withoutWorkloadNames(snapshot, "Jelly-Box status").includes("Jelly"), false, "a guest's name is not a nickname");
  assert.deepEqual(namedServices(snapshot, withoutWorkloadNames(snapshot, "how's Seerr on Jelly-Box?")), ["seerr"]);
  assert.equal(questionSeeds("what does semaphore do?").manual, true);
  assert.equal(questionSeeds("what is pihole for?").manual, true);
});

/** A cluster named like one of its nodes, as in "Main" with nodes Main and norco. */
function cluster() {
  const GB = 1024 ** 3;
  return {
    generatedAt: new Date(NOW).toISOString(),
    services: [{ id: "seerr", label: "Seerr", state: "healthy" }],
    infrastructure: {
      environments: [{
        id: "env-main",
        displayName: "Main",
        nodes: [
          { name: "Main", status: "online", uptimeSeconds: 8 * 86_400, cpuPercent: 2, cpuCores: 8, memoryUsedBytes: 20 * GB, memoryTotalBytes: 32 * GB },
          { name: "norco", status: "online", uptimeSeconds: 3 * 86_400, cpuPercent: 17, cpuCores: 12, memoryUsedBytes: 39 * GB, memoryTotalBytes: 63 * GB }
        ],
        workloads: [
          { vmid: 100, name: "Jelly-Arr", type: "qemu", node: "Main", status: "running", cpuPercent: 12, cpuCores: 4, memoryUsedBytes: 5.8 * GB, memoryTotalBytes: 8 * GB, uptimeSeconds: 8 * 86_400 },
          { vmid: 104, name: "seerr", type: "lxc", node: "Main", status: "running", cpuPercent: 0.1, cpuCores: 1, memoryUsedBytes: 0.6 * GB, memoryTotalBytes: 2 * GB },
          { vmid: 108, name: "wizarr", type: "lxc", node: "Main", status: "running", cpuPercent: 0, cpuCores: 1, memoryUsedBytes: 0.7 * GB, memoryTotalBytes: 2 * GB },
          { vmid: 102, name: "haos-17.2", type: "qemu", node: "norco", status: "running", cpuPercent: 1.4, cpuCores: 2, memoryUsedBytes: 3.7 * GB, memoryTotalBytes: 4 * GB },
          { vmid: 106, name: "pihole", type: "lxc", node: "norco", status: "running", cpuPercent: 0.1, cpuCores: 1, memoryUsedBytes: 0.1 * GB, memoryTotalBytes: 1 * GB, backup: { status: "success", ageSeconds: 58 * 86_400 } },
          { vmid: 109, name: "docker", type: "qemu", node: "norco", status: "running", cpuPercent: 1, cpuCores: 4, memoryUsedBytes: 3.3 * GB, memoryTotalBytes: 8 * GB, backup: { status: "success", ageSeconds: 58 * 86_400 } },
          { vmid: 112, name: "RHEL-10.0-1", type: "qemu", node: "norco", status: "stopped", cpuCores: 2, memoryTotalBytes: 4 * GB },
          { vmid: 114, name: "ollama", type: "lxc", node: "norco", status: "running", cpuPercent: 35, cpuCores: 4, memoryUsedBytes: 2 * GB, memoryTotalBytes: 16 * GB }
        ]
      }],
      services: [{ id: "portainer-1", displayName: "Portainer", type: "portainer", state: "healthy", checks: [] }],
      portainer: [{
        id: "p-1",
        displayName: "Portainer",
        inventory: {
          containers: [
            { name: "radarr", state: "running", status: "Up 7 days", environmentName: "Jelly-Arr", image: "lscr.io/linuxserver/radarr:latest", stack: "arr", ports: [{ privatePort: 7878, publicPort: 7878, protocol: "tcp" }] },
            { name: "suggestarr", state: "exited", status: "Exited (0) 7 weeks ago", environmentName: "Jelly-Arr", ports: [] },
            { name: "aliasvault", state: "running", status: "Up 2 days", environmentName: "Main Docker", ports: [{ privatePort: 80, publicPort: null, protocol: "tcp" }] }
          ]
        }
      }]
    }
  };
}

test("a cluster named like one of its nodes says which is which, and nodes count their guests", async () => {
  const snapshot = cluster();
  const all = await runTool("list_workloads", {}, context(snapshot));
  assert.match(all, /^Note: "Main" is the Proxmox cluster \(nodes Main, norco\) and also one of its nodes; a guest "on Main" means on node Main only\.$/mu);
  assert.match(all, /Main \(Proxmox Main\) online, up 8d, cpu 2% of 8 cores, memory 63% \(20 of 32 GB, 12 GB free\), 3 guests \(1 VM, 2 LXCs\), 3 running/u);
  assert.match(all, /^Both nodes together: memory 62% \(59 of 95 GB, 36 GB free\), 20 CPU cores\.$/mu, "cluster totals worked out by code");
  const main = await runTool("list_workloads", { filter: "main" }, context(snapshot));
  assert.match(main, /^Note: "Main" is the Proxmox cluster/u);
  assert.match(main, /^node Main \(Proxmox Main\): online, up 8d, cpu 2% of 8 cores, memory 63% \(20 of 32 GB, 12 GB free\), 3 guests \(1 VM, 2 LXCs\), 3 running$/mu);
  assert.match(main, /^Guests on node Main:\nvm 100 Jelly-Arr: running, cpu 12%, memory 73% \(5\.8 of 8 GB\), no backup$/mu, "each guest in short form under its node");
  assert.doesNotMatch(main, /haos|norco:/u, "only the node's own guests");
  assert.match(await runTool("list_workloads", { filter: "Jelly-Arr" }, context(snapshot)), /^vm 100 Jelly-Arr on node Main: running, cpu 12% of 4 cores, memory 73% \(5\.8 of 8 GB\), up 8d, no backup recorded$/mu, "a guest's own line has cores, sizes and uptime");
  assert.match(await runTool("list_workloads", { filter: "RHEL-10.0-1" }, context(snapshot)), /^vm 112 RHEL-10\.0-1 on node norco: stopped, 2 cores, 4 GB memory assigned, no backup recorded$/u);
});

test("a container's line has its image, stack, ports and the guest its Docker host runs on", async () => {
  const snapshot = cluster();
  assert.match(await runTool("list_workloads", { filter: "radarr" }, context(snapshot)),
    /^container radarr on Docker host Jelly-Arr \(Portainer\): running, Up 7 days; no Docker health check, so only that it is running is known; image lscr\.io\/linuxserver\/radarr:latest; stack arr; ports 7878->7878\/tcp; Docker host Jelly-Arr is VM 100 on node Main$/u);
  assert.match(await runTool("list_workloads", { filter: "aliasvault" }, context(snapshot)), /; ports 80\/tcp inside the container only, not published on the host$/u, "no guest named Main Docker, so no claim about where it runs");
  assert.match(await runTool("list_workloads", { filter: "suggestarr" }, context(snapshot)), /Exited \(0\) 7 weeks ago; no ports; Docker host Jelly-Arr is VM 100/u);
  const portainer = await runTool("service_status", { name: "portainer" }, context(snapshot));
  assert.match(portainer, /^Docker hosts it manages \(Portainer environments, not Proxmox nodes\): Jelly-Arr \(Portainer, VM 100 on node Main\) 2 containers, 1 running; Main Docker \(Portainer\) 1 containers, 1 running\.$/mu);
});

test("guests by number, several names at once, and rankings for one node", async () => {
  const snapshot = cluster();
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("Is VM 109 powered on?"), [{ filter: "109" }]);
  assert.deepEqual(queries("Show the names for guest IDs 100, 102, and 104."), [{ filter: "100" }, { filter: "102" }, { filter: "104" }]);
  assert.deepEqual(queries("vm 150 node?"), [{ filter: "vms" }], "an ID that isn't a guest is not looked up");
  assert.match(await runTool("list_workloads", { filter: "109" }, context(snapshot)), /^vm 109 docker \(a VM named docker, not a container\) on node norco: running/u);
  assert.match(await runTool("list_workloads", { filter: "999" }, context(snapshot)), /^There is no VM or LXC with ID 999\.$/u);
  assert.deepEqual(queries("Is seerr or wizarr using more CPU?"), [{ filter: "seerr" }, { filter: "wizarr" }], "both names, not only the first");
  assert.deepEqual(queries("Rank pihole, ollama, and haos-17.2 by current CPU usage."), [{ filter: "pihole" }, { filter: "ollama" }, { filter: "haos-17.2" }]);
  assert.deepEqual(queries("Rank VMs on norco by current CPU usage."), [{ filter: "cpu vms norco" }]);
  assert.deepEqual(queries("Show the newest backup for every guest on Main."), [{ filter: "backups main" }]);
  assert.deepEqual(queries("compare the current CPU load on Main and norco."), [{ filter: "main" }, { filter: "norco" }]);
  const ranked = await runTool("list_workloads", { filter: "cpu vms norco" }, context(snapshot));
  assert.match(ranked, /^The node itself: node norco \(Proxmox Main\): online, up 3d, cpu 17% of 12 cores, [^\n]+\nCPU use of each running VM on node norco, highest first \(percent of its own allowance\): 1\. haos-17\.2 \(VM 102\): 1\.4% of 2 cores, 2\. docker \(VM 109\): 1% of 4 cores\. Not running, so no usage: RHEL-10\.0-1 \(VM 112, norco\)\.$/u);
  assert.doesNotMatch(ranked, /Jelly-Arr|ollama/u);
  const mainBackups = await runTool("list_workloads", { filter: "backups main" }, context(snapshot));
  assert.match(mainBackups, /^Backups of 3 guests on node Main: 0 have one, 3 have none\.$/mu);
  assert.match(mainBackups, /^Note: "Main" is the Proxmox cluster/u);
});

test("backup answers count the ages and the nodes, and say what Helmsman can't see", async () => {
  const backups = await runTool("list_workloads", { filter: "backups" }, context(cluster()));
  assert.match(backups, /^Latest backup ages: 0 under 1 day old, 0 1 to 7 days old, 0 7 to 30 days old, 2 over 30 days old\.$/mu);
  assert.match(backups, /^By node: Main 0 of 3 have one, norco 2 of 5 have one\.$/mu);
  assert.match(backups, /^Helmsman sees only each guest's latest backup result and its age: not backup jobs, schedules/mu);
  const memory = await runTool("list_workloads", { filter: "memory" }, context(cluster()));
  assert.match(memory, /: 1\. haos-17\.2 \(VM 102\): 93% \(3\.7 of 4 GB\), 2\. Jelly-Arr/u, "sizes in GB beside the share");
});

test("two-word names and Home Assistant find their guests", () => {
  const snapshot = cluster();
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("how's pi hole doing?"), [{ filter: "pihole" }]);
  assert.deepEqual(queries("which node is pi-hole on?"), [{ filter: "pihole" }]);
  assert.deepEqual(queries("What node hosts home assistant?"), [{ filter: "haos-17.2" }]);
  assert.deepEqual(queries("Is Home Assistant OS a VM or an LXC?"), [{ filter: "haos-17.2" }]);
  assert.equal(questionSeeds("What's the QDevice for?").manual, true, "the QDevice is in the manual");
});

test("Docker hosts, guests by name and number, and ordinary words that only look like names", async () => {
  const snapshot = cluster();
  snapshot.infrastructure.environments[0].workloads.push({ vmid: 201, name: "docker", type: "qemu", node: "norco", status: "running", cpuPercent: 3 });
  snapshot.infrastructure.portainer[0].inventory.containers.push(
    { name: "prowlarr", state: "running", status: "Up 7 days", environmentName: "Jelly-Arr", ports: [] },
    { name: "authentik-worker-1", state: "running", status: "Up 2 days", environmentName: "PVE-2", stack: "authentik", ports: [] },
    { name: "portainer_agent", state: "running", status: "Up 2 days", environmentName: "PVE-2", ports: [] }
  );
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  const where = (text) => workloadQueries(snapshot, text, { namesOnly: true });
  assert.deepEqual(queries("Does docker 201 have a backup?"), [{ filter: "201" }], "a name with its number is that guest");
  assert.deepEqual(queries("Which Docker host has prowlarr?"), [{ filter: "prowlarr" }], "Docker host is not the VM named docker");
  assert.deepEqual(where("Which Docker host contains authentik-worker-1?"), [{ filter: "authentik-worker-1" }]);
  assert.deepEqual(queries("Is prowlarr in Jelly-Arr or Main Docker?"), [{ filter: "prowlarr" }, { filter: "Main Docker" }, { filter: "Jelly-Arr" }], "the container and both hosts");
  assert.deepEqual(queries("list the Main Docker containers"), [{ filter: "Main Docker" }]);
  assert.deepEqual(queries("Which running LXC is doing the least work?"), [{ filter: "cpu lxcs" }], "work is not authentik-worker-1");
  assert.deepEqual(queries("Which VMs have a working guest agent?"), [{ filter: "vms" }], "agent is not portainer_agent");
  assert.deepEqual(queries("Which containers publish host ports?"), [{ filter: "containers ports" }]);
  assert.deepEqual(queries("Which containers use an image tagged latest?"), [{ filter: "containers images" }]);
  assert.deepEqual(queries("what Docker stacks are visible?"), [{ filter: "containers stacks" }]);
  assert.deepEqual(queries("Who is the largest RAM consumer among guests with no backup?"), [{ filter: "memory" }, { filter: "backups" }], "both measures it names");
  assert.deepEqual(queries("Where does ollama rank among LXCs for memory use?"), [{ filter: "ollama" }, { filter: "memory lxcs" }], "its line and the ranking");
  assert.deepEqual(queries("How much physical RAM is installed in Main?"), [{ filter: "main" }], "the node itself, not its guests' ranking");
  const ports = await runTool("list_workloads", { filter: "containers ports" }, context(snapshot));
  assert.match(ports, /^Docker host Jelly-Arr \(VM 100 on node Main\), 3 containers: radarr 7878->7878\/tcp; suggestarr no ports; prowlarr no ports\.$/mu);
  const stacks = await runTool("list_workloads", { filter: "containers stacks" }, context(snapshot));
  assert.match(stacks, /^Docker host PVE-2, 2 containers: stack authentik: authentik-worker-1; no stack: portainer_agent\.$/mu);
});

test("node figures with node rankings, uptime and size rankings, container details per host, stacks and neighbours", async () => {
  const snapshot = cluster();
  snapshot.infrastructure.portainer[0].inventory.containers.push(
    { name: "sonarr", state: "running", status: "Up 7 days (healthy)", environmentName: "Jelly-Arr", image: "lscr.io/linuxserver/sonarr:latest", stack: "arr", ports: [{ privatePort: 8989, publicPort: 8989, protocol: "tcp" }] }
  );
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("Which VM has been up the longest?"), [{ filter: "uptime vms" }]);
  assert.deepEqual(queries("Which VM has the most cores?"), [{ filter: "cores vms" }], "cores given, not CPU use");
  assert.deepEqual(queries("How much RAM is assigned to each LXC?"), [{ filter: "allocated lxcs" }]);
  assert.deepEqual(queries("Which LXC uses the most RAM?"), [{ filter: "memory lxcs" }], "use stays use");
  assert.deepEqual(queries("What images are on Jelly-Arr?"), [{ filter: "containers images jelly-arr" }]);
  assert.deepEqual(queries("list stacks in Main Docker"), [{ filter: "containers stacks main docker" }]);
  assert.deepEqual(queries("What's in the arr stack?"), [{ filter: "stack arr" }]);
  assert.deepEqual(queries("which containers have no healthcheck?"), [{ filter: "containers health" }]);
  assert.deepEqual(queries("Which containers have been up longest?"), [{ filter: "containers uptime" }], "container uptime is not the guest ranking");
  assert.deepEqual(queries("What else runs on the same node as ollama?"), [{ filter: "ollama" }, { filter: "beside ollama" }]);
  assert.deepEqual(queries("what runs alongside radarr?"), [{ filter: "radarr" }, { filter: "beside radarr" }]);
  const tool = (filter) => runTool("list_workloads", { filter }, context(snapshot));
  assert.match(await tool("cpu main"), /^The node itself: node Main \(Proxmox Main\): online, up 8d, cpu 2% of 8 cores, memory 63% \(20 of 32 GB, 12 GB free\), 3 guests \(1 VM, 2 LXCs\), 3 running\nCPU use of each running VM and LXC on node Main/mu, "the node's own figures before its guests");
  assert.match(await tool("uptime vms"), /^How long each running VM has been up, longest first \(since its last start\): Jelly-Arr \(VM 100, Main\) up 8d, /u);
  assert.equal(await tool("cores vms"), "CPU cores assigned to each VM, most first (what each was given, not what it uses), 12 cores in total: Jelly-Arr (VM 100, Main) 4 cores, docker (VM 109, norco) 4 cores, haos-17.2 (VM 102, norco) 2 cores, RHEL-10.0-1 (VM 112, norco) 2 cores (stopped).");
  assert.equal(await tool("allocated lxcs"), "Memory assigned to each LXC, most first (what each was given, not what it uses), 21 GB in total: ollama (LXC 114, norco) 16 GB, seerr (LXC 104, Main) 2 GB, wizarr (LXC 108, Main) 2 GB, pihole (LXC 106, norco) 1 GB.");
  const images = await tool("containers images");
  assert.match(images, /^Image of each container, the latest-tag ones listed without the ":latest":\nDocker host Jelly-Arr \(VM 100 on node Main\), 3 containers: 2 on the latest tag: radarr lscr\.io\/linuxserver\/radarr, sonarr lscr\.io\/linuxserver\/sonarr; image unknown: suggestarr\.$/mu, "latest-tag ones apart, said in words");
  const jellyImages = await tool("containers images jelly-arr");
  assert.match(jellyImages, /radarr lscr\.io\/linuxserver\/radarr:latest/u, "one host: tags in full");
  assert.doesNotMatch(jellyImages, /Main Docker|aliasvault/u);
  assert.equal(await tool("stack arr"), "Compose stack arr on Docker host Jelly-Arr (VM 100 on node Main), 2 containers: radarr (running, Up 7 days, no health check; image lscr.io/linuxserver/radarr:latest; ports 7878->7878/tcp), sonarr (running, Up 7 days (healthy); image lscr.io/linuxserver/sonarr:latest; ports 8989->8989/tcp).");
  assert.match(await tool("containers health"), /^Docker host Jelly-Arr \(VM 100 on node Main\), 3 containers: no healthcheck 1: radarr; not running \(exited\) 1: suggestarr; healthy 1: sonarr\.$/mu);
});

test("Docker hosts matched to guests from the manual, ID ranges, neighbours of a host, and docker-named", async () => {
  const snapshot = cluster();
  snapshot.infrastructure.environments[0].workloads.push(
    { vmid: 201, name: "docker", type: "qemu", node: "norco", status: "running", cpuPercent: 3, cpuCores: 2 },
    { vmid: 152, name: "frigate", type: "lxc", node: "norco", status: "running", cpuPercent: 4 }
  );
  snapshot.infrastructure.portainer[0].inventory.containers.push(
    { name: "paperless-webserver-1", state: "running", status: "Up 2 days (healthy)", environmentName: "Main Docker", image: "ghcr.io/paperless-ngx/paperless-ngx:3.0.5", stack: "paperless", ports: [] },
    { name: "donetick", state: "running", status: "Up 2 days", environmentName: "Main Docker", image: "donetick/donetick", stack: "donetick", ports: [] },
    { name: "grafana", state: "running", status: "Up 2 days", environmentName: "PVE-2", image: "grafana/grafana:latest", stack: "grafana", ports: [] },
    { name: "loki", state: "running", status: "Up 2 days", environmentName: "PVE-2", image: "grafana/loki:3", stack: "loki", ports: [] }
  );
  const manual = [
    "| VMID | Name | Type | IP | Role |",
    "| 109 | docker | VM | 10.0.0.9 | Paperless, AliasVault, Donetick, Portainer agent |",
    "| 201 | docker | VM | 10.0.0.21 | Grafana, Loki, Portainer agent |",
    "Grafana dashboards live on the logging host."
  ].join("\n");
  const withManual = { ...context(snapshot), manual: () => manual };
  const aliasvault = await runTool("list_workloads", { filter: "aliasvault" }, withManual);
  assert.match(aliasvault, /; Docker host Main Docker is VM 109 docker on node norco, per your manual$/u, "Main Docker is the docker VM 109");
  const pve2 = await runTool("list_workloads", { filter: "PVE-2" }, withManual);
  assert.match(pve2, /Containers on PVE-2 \(Portainer, VM 201 docker on node norco, per your manual\)/u);
  assert.doesNotMatch(await runTool("list_workloads", { filter: "aliasvault" }, context(snapshot)), /per your manual/u, "no manual, no claim");

  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("List guests with IDs above 150."), [{ filter: "ids 151-999999999" }]);
  assert.deepEqual(queries("Which guests are in the 100 through 110 ID range?"), [{ filter: "ids 100-110" }]);
  assert.deepEqual(queries("Which LXCs are colocated with Jelly-Arr?"), [{ filter: "Jelly-Arr" }, { filter: "beside lxcs jelly-arr" }], "a host that is also a guest adds what else is on its node");
  assert.deepEqual(queries("What VMs share norco with haos-17.2?"), [{ filter: "haos-17.2" }, { filter: "beside vms haos-17.2" }]);
  assert.deepEqual(queries("What else shares the Docker host with radarr?"), [{ filter: "radarr" }, { filter: "beside radarr" }]);
  assert.deepEqual(queries("How many docker-named VMs are running?").slice(0, 1), [{ filter: "docker" }], "docker-named is the name docker");
  assert.deepEqual(queries("Which guest on Main is closest to its memory limit?"), [{ filter: "memory main" }], "closest to a limit is use, not size");

  const above = await runTool("list_workloads", { filter: "ids 151-999999999" }, context(snapshot));
  assert.equal(above, "2 guests with IDs above 150, in order: 152 frigate (LXC, norco, running), 201 docker (VM, norco, running).");
  const span = await runTool("list_workloads", { filter: "ids 100-108" }, context(snapshot));
  assert.match(span, /^5 guests with IDs from 100 to 108, in order: 100 Jelly-Arr .*, 102 haos-17\.2 .*, 104 seerr .*, 106 pihole .*, 108 wizarr /u);
});

test("neighbours leave out what was asked about and always list what is stopped", async () => {
  const snapshot = cluster();
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("What other guests run on the same node as docker VM 109?"), [{ filter: "109" }, { filter: "beside 109" }], "a guest by number gets its neighbours too");
  const tool = (filter) => runTool("list_workloads", { filter }, context(snapshot));
  const ollama = await tool("beside ollama");
  assert.match(ollama, /^ollama \(LXC 114\) shares node norco with \d+ other guests?\. Running \(\d+\): /u);
  assert.doesNotMatch(ollama.replace(/^ollama \(LXC 114\)/u, ""), /ollama/u, "not the guest itself");
  assert.match(ollama, /Not running \(1\): RHEL-10\.0-1 \(VM 112\) stopped\./u, "stopped guests are listed");
  const counts = /with (\d+) other guests?\. Running \((\d+)\): .*?(?: Not running \((\d+)\)|$)/u.exec(ollama);
  assert.equal(Number(counts[1]), Number(counts[2]) + Number(counts[3] || 0), "the count matches the names");
  const radarr = await tool("beside radarr");
  assert.match(radarr, /^radarr shares Docker host Jelly-Arr \(VM 100 on node Main\) with \d+ other containers?\./u);
  assert.match(radarr, /Not running \(1\): suggestarr \(exited\)\./u);
  assert.doesNotMatch(radarr.replace(/^radarr/u, ""), /radarr/u);
  assert.equal(await tool("beside nothing-here"), "Nothing is named nothing-here.");
});

test("v1.17.5: the lookups the 1.17.4 Self-test showed were missing", async () => {
  const snapshot = cluster();
  snapshot.infrastructure.portainer[0].inventory.containers.push(
    { name: "qbittorrent", state: "running", status: "Up 7 days", environmentName: "Jelly-Arr", stack: "arr", ports: [] },
    { name: "portainer", state: "running", status: "Up 7 days", environmentName: "Jelly-Arr", stack: null, ports: [{ privatePort: 9443, publicPort: 9443, protocol: "tcp" }] },
    { name: "paperless-db-1", state: "running", status: "Up 7 days", environmentName: "Main Docker", stack: "paperless", ports: [{ privatePort: 5432, protocol: "tcp" }] }
  );
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  const tool = (filter) => runTool("list_workloads", { filter }, context(snapshot));

  // A container named like a monitored service still gets its own line for "what host".
  assert.equal(questionSeeds("what host is qbittorrent on?").workloads, true);
  assert.deepEqual(queries("what host is qbittorrent on?"), [{ filter: "qbittorrent" }]);
  // A container's node is its Docker host's: the guests there.
  assert.deepEqual(queries("what other guests are on the same node as the radarr host?"), [{ filter: "radarr" }, { filter: "node of radarr" }]);
  assert.deepEqual(queries("what else runs on the same host as radarr?"), [{ filter: "radarr" }, { filter: "beside radarr" }], "the same host is the Docker host");
  const nodeOf = await tool("node of radarr");
  assert.match(nodeOf, /^radarr runs on Docker host Jelly-Arr, which is VM 100 Jelly-Arr on node Main\.\nJelly-Arr \(VM 100\) shares node Main with 2 other guests\. Running \(2\): seerr \(LXC 104\), wizarr \(LXC 108\)\./u);
  // Ports by number, published or only inside the container.
  assert.deepEqual(queries("what's using port 5432?"), [{ filter: "port 5432" }]);
  assert.deepEqual(workloadQueries(snapshot, "which containers publish port 9443?", { namesOnly: true }), [{ filter: "port 9443" }]);
  assert.match(await tool("port 5432"), /^No container publishes port 5432 on its Docker host\.\nListening on 5432 inside the container, not published: paperless-db-1 on Docker host Main Docker: 5432\/tcp inside the container only\./u);
  assert.match(await tool("port 9443"), /^Published on host port 9443: portainer on Docker host Jelly-Arr: 9443->9443\/tcp\./u);
  // Ranking by assigned cores, the most recent start, and the cluster's totals.
  assert.deepEqual(queries("rank the guests by cores, most first"), [{ filter: "cores" }]);
  assert.deepEqual(queries("which guest was restarted most recently?"), [{ filter: "uptime" }]);
  assert.deepEqual(queries("how much memory is free across the cluster?"), [{ filter: "nodes" }]);
  assert.deepEqual(queries("what's the total RAM in the cluster?"), [{ filter: "nodes" }]);
  assert.deepEqual(queries("how much RAM is assigned to the LXCs in total?"), [{ filter: "allocated lxcs" }], "assigned to guests stays the guests'");
  // A Docker host that is also a guest, asked about without container words, is the guest.
  assert.deepEqual(queries("how long has Jelly-Arr been up?"), [{ filter: "Jelly-Arr" }]);
  assert.deepEqual(queries("how long have the containers on Jelly-Arr been up?"), [{ filter: "containers uptime jelly-arr" }]);
  // No stack is said, so one isn't made up.
  assert.match(await tool("portainer"), /; not in a compose stack;/u);
  assert.doesNotMatch(await tool("suggestarr"), /compose stack/u, "unknown is not said as none");
  // Ties at either end are said in words.
  snapshot.infrastructure.environments[0].workloads.find((workload) => workload.name === "pihole").cpuPercent = 0;
  const lxcs = await tool("cpu lxcs");
  assert.match(lxcs, /\. 2 tie for lowest at 0%: wizarr \(LXC 108\), pihole \(LXC 106\)\.$/u);
  assert.doesNotMatch(lxcs, /tie for highest/u);
  // The most recent start, named at the end of the uptime ranking.
  snapshot.infrastructure.environments[0].workloads.find((workload) => workload.name === "ollama").uptimeSeconds = 3600;
  assert.match(await tool("uptime"), /Started or restarted most recently \(the shortest uptime\): ollama \(LXC 114, norco\), up 1h 0m; the next most recent has been up 8d 0h\./u);
});

test("v1.17.5: manual questions the Self-test showed were never searched", () => {
  for (const question of [
    "how many votes does the cluster have?", "what's the remote access path?", "what router do I use?",
    "what known issues are open?", "what's the public name for Seerr?", "what's the startup order for pihole and cloudflared?",
    "what's on the roadmap?", "how is Home Assistant reached?", "what runs on docker VM 201?", "what does docker VM 201 do?",
    "what is the Caddy config path?", "why was the switch removed?", "which VLANs are configured?", "what should I do after an NFS outage?"
  ]) assert.equal(questionSeeds(question).manual, true, question);
  assert.equal(questionSeeds("can the agent test indexers?").help, true);
  for (const question of ["is sonarr down?", "why is radarr down?", "how many containers are running?"]) assert.equal(questionSeeds(question).manual, false, question);
  assert.equal(questionWindow("what should I do after an NFS outage?", NOW, "UTC"), null, "a procedure, not the history of outages");
});

test("v1.17.6: follow-ups that point back are read with the question before them", () => {
  assert.equal(isFollowUp("what was its longest problem?"), true);
  assert.equal(isFollowUp("are any others tied with it?"), true);
  assert.equal(isFollowUp("which containers on Jelly-Arr have published ports and images?"), true, "starts with which");
  assert.equal(isFollowUp("how much memory does the docker VM on norco use right now"), false, "a full new question");
  const snapshot = cluster();
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: true });
  assert.deepEqual(queries("what host is radarr on?\nand which other guests share that node?"), [{ filter: "radarr" }, { filter: "node of radarr" }]);
  assert.deepEqual(queries("how much memory is free on norco?\nand across the whole cluster?"), [{ filter: "nodes" }]);
});

test("v1.17.7: long results cut at lines, a native service's host from the manual, exact most-recent start", async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `- line ${index} ${"x".repeat(60)}`).join("\n");
  const cut = shortenText(lines, 700);
  assert.ok(cut.length <= 700);
  assert.match(cut, /\n… \(\d+ more lines not shown, to fit\)$/u, "whole lines, and says how many are left out");
  assert.doesNotMatch(cut.split("\n").at(-2), /x{1,59}$(?<!x{60})/u, "no line cut in the middle");
  const list = `Ranking: ${Array.from({ length: 60 }, (_, index) => `guest-${index} (LXC ${100 + index}) 1 core`).join(", ")}.`;
  assert.match(shortenText(list, 400), /1 core, … \(the rest not shown, to fit\)$|1 core … \(the rest not shown, to fit\)$/u, "a one-line list is cut after a whole item");

  const snapshot = cluster();
  const manual = "## Guests on Main\n- Jelly-Arr: VM 100 on Main, 10.0.0.7. Runs Jellyfin (native), the arr stack and Helmsman.\n- seerr: LXC 104 on Main. Login uses the Jellyfin username.";
  const withManual = { ...context(snapshot), manual: () => manual };
  const node = await runTool("list_workloads", { filter: "service node jellyfin" }, withManual);
  assert.match(node, /^jellyfin runs on Jelly-Arr \(VM 100 on node Main\), per your manual\.\nJelly-Arr \(VM 100\) shares node Main with 2 other guests\./u, "seerr's line names Jellyfin but doesn't run it");
  assert.match(node, /\nContainers on Jelly-Arr \(Portainer, VM 100 on node Main\): 2, 1 running/u);
  const host = await runTool("list_workloads", { filter: "service host jellyfin" }, withManual);
  assert.match(host, /^jellyfin runs on Jelly-Arr \(VM 100 on node Main\), per your manual\. What else runs on Jelly-Arr itself is its Docker containers/u);
  assert.match(host, /\nContainers on Jelly-Arr \(Portainer, VM 100 on node Main\): 2, 1 running/u);
  assert.doesNotMatch(host, /shares node/u, "the same host is the machine, not the node's other guests");
  assert.equal(await runTool("list_workloads", { filter: "service host jellyfin" }, context(snapshot)), "Where jellyfin runs is not in the manual or the inventory.");

  const guests = snapshot.infrastructure.environments[0].workloads;
  for (const guest of guests) guest.uptimeSeconds = 7 * 86_400 + 5 * 3_600;
  guests.find((guest) => guest.name === "pihole").uptimeSeconds = 7 * 86_400 + 2 * 3_600;
  assert.match(await runTool("list_workloads", { filter: "uptime" }, context(snapshot)), /Started or restarted most recently \(the shortest uptime\): pihole \(LXC 106, norco\), up 7d 2h; the next most recent has been up 7d 5h\. Longest running: /u, "all read 7d, but one started three hours later");
  guests.find((guest) => guest.name === "pihole").uptimeSeconds = 7 * 86_400 + 5 * 3_600 - 600;
  guests.find((guest) => guest.name === "Jelly-Arr").uptimeSeconds = 12 * 86_400;
  assert.match(await runTool("list_workloads", { filter: "uptime" }, context(snapshot)), /Started or restarted most recently, within the same hour of each other \(about 7d 4h ago\): /u);
});

test("v1.17.7: manual search finds the ISP and the change log", () => {
  assert.deepEqual(manualKeywords("what's my ISP?"), ["isp", "internet"]);
  const manual = "## Network\n- Internet: Spectrum 1 Gbps plan.\n## Change log\n- v2.8, 30 Oct 2026: ollama added.";
  assert.equal(manualMatches(manual, manualKeywords("what's my ISP?"))[0], "[Network] - Internet: Spectrum 1 Gbps plan.");
  assert.ok(manualMatches(manual, manualKeywords("what changed in the last manual update?")).includes("[Change log] - v2.8, 30 Oct 2026: ollama added."));
});

test("v1.17.8: VMs and LXCs asked about together get both", async () => {
  const snapshot = cluster();
  const queries = (text) => workloadQueries(snapshot, text, { workloadWords: questionSeeds(text).workloads });
  assert.deepEqual(queries("are any VMs or LXCs stopped?"), [{ filter: "guests" }]);
  assert.deepEqual(queries("which guests are stopped?"), [{ filter: "guests" }]);
  assert.deepEqual(queries("which VMs are stopped?"), [{ filter: "vms" }]);
  assert.deepEqual(queries("Which VMs have a working guest agent?"), [{ filter: "vms" }], "guest agent is not guests");
  const both = await runTool("list_workloads", { filter: "guests" }, context(snapshot));
  assert.match(both, /^VMs: 4 in total, 3 running; not running or locked: RHEL-10\.0-1 \(112, norco\) \(stopped\)\./mu);
  assert.match(both, /^LXCs: 4 in total, 4 running\./mu);
  assert.doesNotMatch(both, /Containers|Nodes:/u, "only the guests");
});
