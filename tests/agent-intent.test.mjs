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
  assert.match(output, /^VMs: 100 Media-Box on alpha running\./mu);
  assert.match(output, /^LXCs: 101 dns on alpha stopped\./mu);
  assert.match(output, /Containers on Portainer Docker host: .*gluetun running unhealthy, sonarr running, paperless-db-1 running, paperless-webserver-1 exited\./u, "the last containers are included");
  assert.ok(output.length <= 1_400);
  // A kind gives just that kind; a name gives its full line.
  assert.match(await runTool("list_workloads", { filter: "lxcs" }, context(lab())), /^LXCs: 101 dns on alpha stopped\.$/u);
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
