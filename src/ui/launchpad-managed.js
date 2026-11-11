// Resolves a Launchpad tile's `managed` link against the live inventory the
// browser already has. Pure, so Node tests can import it.
//
// Containers are matched by name, because a container gets a new id every
// time it is recreated (an image update, for example). Proxmox guests are
// matched by VMID, and their node is read live so a migration doesn't break
// the link. Actions offered here mirror the server's own rules; the server
// checks everything again before it acts.

const NOT_FOUND = Object.freeze({ found: false, state: "stale", label: "Linked service not found", actions: [], actionTarget: null });

const CONTAINER_ACTIONS = {
  start: { operation: "start", label: "Start", tone: "primary" },
  restart: { operation: "restart", label: "Restart", tone: "" },
  stop: { operation: "stop", label: "Stop", tone: "danger" }
};

const WORKLOAD_ACTIONS = {
  start: { operation: "start", label: "Start", tone: "primary" },
  reboot: { operation: "reboot", label: "Reboot", tone: "" },
  shutdown: { operation: "shutdown", label: "Shut down", tone: "danger" }
};

function containerState(container) {
  if (container.state === "running") return container.health === "unhealthy" ? "degraded" : "healthy";
  if (["exited", "created", "dead", "restarting", "removing"].includes(container.state)) return "down";
  if (container.state === "paused") return "degraded";
  return "stale";
}

function workloadState(workload) {
  if (workload.status === "running") return "healthy";
  if (workload.status === "stopped") return "down";
  if (["paused", "suspended"].includes(workload.status)) return "degraded";
  return "stale";
}

/**
 * @param managed the tile's normalized `managed` object (or undefined)
 * @param live `{ connections: [{ kind, id, state }], containers: [...], workloads: [...] }`
 * @returns `{ found, state, label, actions: [{ operation, label, tone }], actionTarget }`
 */
export function resolveManaged(managed, live = {}) {
  if (!managed || typeof managed !== "object") return NOT_FOUND;

  if (managed.kind === "container") {
    const container = (live.containers || []).find((candidate) => (
      candidate.serverId === managed.service
      && candidate.environmentId === managed.environment
      && candidate.name === managed.name
    ));
    if (!container) return NOT_FOUND;
    const actions = container.state === "running"
      ? [CONTAINER_ACTIONS.restart, CONTAINER_ACTIONS.stop]
      : ["created", "exited"].includes(container.state) ? [CONTAINER_ACTIONS.start] : [];
    return {
      found: true,
      state: containerState(container),
      label: `Container ${container.name} · ${container.state}`,
      actions,
      actionTarget: { containerKey: container.key, containerId: container.id }
    };
  }

  if (managed.kind === "workload") {
    const workload = (live.workloads || []).find((candidate) => (
      candidate.environmentId === managed.environment && candidate.vmid === managed.vmid
    ));
    if (!workload) return NOT_FOUND;
    const controllable = !workload.template && !workload.lock && ["qemu", "lxc"].includes(workload.type) && workload.node !== "Unassigned";
    const actions = !controllable
      ? []
      : workload.status === "stopped"
        ? [WORKLOAD_ACTIONS.start]
        : workload.status === "running" ? [WORKLOAD_ACTIONS.reboot, WORKLOAD_ACTIONS.shutdown] : [];
    return {
      found: true,
      state: workloadState(workload),
      label: `${workload.type === "qemu" ? "VM" : "LXC"} ${workload.vmid} on ${workload.node} · ${workload.status}`,
      actions,
      actionTarget: { workloadId: workload.id, node: workload.node, type: workload.type }
    };
  }

  const connection = (live.connections || []).find((candidate) => candidate.kind === managed.kind && candidate.id === managed.id);
  if (!connection) return NOT_FOUND;
  return { found: true, state: connection.state || "stale", label: connection.role || "Connected service", actions: [], actionTarget: null };
}
