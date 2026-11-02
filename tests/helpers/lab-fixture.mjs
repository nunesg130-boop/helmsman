// A small, realistic lab snapshot shared by tests. Pure data, no I/O.
const NOW = Date.parse("2026-10-28T23:00:00Z");
const GB = 1024 ** 3;

/** The snapshot shape the agent reads, with two guests that share the name "docker" (VM 109 and VM 201). */
export function labSnapshot() {
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
          { vmid: 201, name: "docker", type: "qemu", node: "Main", status: "running", cpuPercent: 3, cpuCores: 2, memoryUsedBytes: 1.2 * GB, memoryTotalBytes: 4 * GB, backup: { status: "success", ageSeconds: 2 * 86_400 } },
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
