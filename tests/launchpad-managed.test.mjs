import assert from "node:assert/strict";
import test from "node:test";

import { resolveManaged } from "../src/ui/launchpad-managed.js";

const PORTAINER = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROXMOX = "3f0c1d2e-4b5a-4c6d-8e7f-901234567890";
const OLD_ID = "a".repeat(64);
const NEW_ID = "b".repeat(64);

function container(id, state = "running", health = "healthy", name = "sonarr") {
  return { key: `${PORTAINER}:12:${id}`, id, name, serverId: PORTAINER, environmentId: 12, state, health };
}

function workload(node, status = "running", extra = {}) {
  return { id: `${PROXMOX}:${node}:lxc:109`, environmentId: PROXMOX, vmid: 109, node, type: "lxc", status, template: false, lock: "", name: "docker", ...extra };
}

const CONTAINER_LINK = { kind: "container", service: PORTAINER, environment: 12, name: "sonarr" };
const WORKLOAD_LINK = { kind: "workload", environment: PROXMOX, vmid: 109 };

test("container resolves by name after it is recreated", () => {
  const before = resolveManaged(CONTAINER_LINK, { containers: [container(OLD_ID)] });
  assert.equal(before.found, true);
  assert.equal(before.actionTarget.containerId, OLD_ID);
  const after = resolveManaged(CONTAINER_LINK, { containers: [container(NEW_ID)] });
  assert.equal(after.found, true);
  assert.equal(after.actionTarget.containerId, NEW_ID);
  assert.equal(after.actionTarget.containerKey, `${PORTAINER}:12:${NEW_ID}`);
  assert.deepEqual(after.actions.map((action) => action.operation), ["restart", "stop"]);
  assert.equal(after.state, "healthy");
});

test("an exited container offers start only and reads as down", () => {
  const result = resolveManaged(CONTAINER_LINK, { containers: [container(OLD_ID, "exited", "informational")] });
  assert.deepEqual(result.actions.map((action) => action.operation), ["start"]);
  assert.equal(result.state, "down");
});

test("a running but unhealthy container reads as degraded", () => {
  assert.equal(resolveManaged(CONTAINER_LINK, { containers: [container(OLD_ID, "running", "unhealthy")] }).state, "degraded");
});

test("a container in another environment or server does not match", () => {
  const elsewhere = { ...container(OLD_ID), environmentId: 13 };
  assert.equal(resolveManaged(CONTAINER_LINK, { containers: [elsewhere] }).found, false);
});

test("a workload follows a node migration", () => {
  const before = resolveManaged(WORKLOAD_LINK, { workloads: [workload("pve-a")] });
  const after = resolveManaged(WORKLOAD_LINK, { workloads: [workload("pve-b")] });
  assert.equal(before.actionTarget.workloadId, `${PROXMOX}:pve-a:lxc:109`);
  assert.equal(after.actionTarget.workloadId, `${PROXMOX}:pve-b:lxc:109`);
  assert.deepEqual(after.actions.map((action) => action.operation), ["reboot", "shutdown"]);
  assert.deepEqual(resolveManaged(WORKLOAD_LINK, { workloads: [workload("pve-a", "stopped")] }).actions.map((action) => action.operation), ["start"]);
});

test("templates and locked guests have no actions", () => {
  assert.deepEqual(resolveManaged(WORKLOAD_LINK, { workloads: [workload("pve-a", "running", { template: true })] }).actions, []);
  assert.deepEqual(resolveManaged(WORKLOAD_LINK, { workloads: [workload("pve-a", "running", { lock: "backup" })] }).actions, []);
});

test("connection kinds show health and have no actions", () => {
  const result = resolveManaged({ kind: "media", id: "sonarr" }, { connections: [{ kind: "media", id: "sonarr", state: "degraded" }] });
  assert.equal(result.found, true);
  assert.equal(result.state, "degraded");
  assert.deepEqual(result.actions, []);
  assert.equal(result.actionTarget, null);
});

test("a missing target is not found", () => {
  for (const managed of [CONTAINER_LINK, WORKLOAD_LINK, { kind: "service", id: PORTAINER }]) {
    const result = resolveManaged(managed, {});
    assert.equal(result.found, false);
    assert.deepEqual(result.actions, []);
  }
  assert.equal(resolveManaged(undefined, {}).found, false);
});
