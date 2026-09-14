import { normalizeProxmoxNodeName } from "./routes.mjs";

export const PROXMOX_PROBE_SCHEMA = 2;

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ITEMS = 5_000;
const MAX_REPORTS = 12;
const MAX_REPORT_SOURCE_CODE_POINTS = 96;
const MAX_REPORT_MESSAGE_CODE_POINTS = 600;
const MAX_COUNTER = 1_000_000_000;
const REPORT_REDACTION = "[REDACTED]";
const RECENT_TASK_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_HISTORY_NODES = 64;
const MAX_HISTORY_CONCURRENCY = 4;
const HISTORY_ROUTE_IDS = new Set(["tasks", "backups"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PROBE_PLAN = deepFreeze([
  {
    id: "identity",
    label: "API authorization",
    routeId: "permissions",
    importance: "core",
    // Permission maps can be large on clusters with many pools/resources, but
    // their contents are validated and discarded rather than returned.
    maxBytes: 2 * 1024 * 1024
  },
  {
    id: "version",
    label: "Proxmox version",
    routeId: "version",
    importance: "optional",
    maxBytes: 64 * 1024
  },
  {
    id: "environment",
    label: "Environment discovery",
    routeId: "clusterStatus",
    importance: "important",
    maxBytes: 512 * 1024
  },
  {
    id: "nodes",
    label: "Node availability",
    routeId: "nodes",
    importance: "critical",
    maxBytes: 512 * 1024
  },
  {
    id: "node-resources",
    label: "Node resources",
    routeId: "nodeResources",
    importance: "important",
    maxBytes: 1024 * 1024
  },
  {
    id: "guests",
    label: "Virtual guests",
    routeId: "guests",
    importance: "important",
    maxBytes: 2 * 1024 * 1024
  },
  {
    id: "storage",
    label: "Storage availability",
    routeId: "storage",
    importance: "important",
    maxBytes: 2 * 1024 * 1024
  },
  {
    id: "tasks",
    label: "Recent failed tasks",
    routeId: "tasks",
    importance: "important",
    maxBytes: 2 * 1024 * 1024
  },
  {
    id: "backups",
    label: "Backup freshness",
    routeId: "backups",
    importance: "important",
    maxBytes: 2 * 1024 * 1024
  }
]);

export const PROXMOX_PROBE_LIMITS = deepFreeze({
  maximumItems: MAX_ITEMS,
  maximumHistoryNodes: MAX_HISTORY_NODES,
  maximumHistoryConcurrency: MAX_HISTORY_CONCURRENCY,
  reportsPerCapability: MAX_REPORTS,
  reportSourceCodePoints: MAX_REPORT_SOURCE_CODE_POINTS,
  reportMessageCodePoints: MAX_REPORT_MESSAGE_CODE_POINTS
});

function boundedInteger(value, fallback = 0, minimum = 0, maximum = MAX_COUNTER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function boundedRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number));
}

function optionalInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function percentFromRatio(value) {
  const ratio = boundedRatio(value);
  return ratio === null ? null : Math.round(ratio * 1_000) / 10;
}

function own(value, key) {
  try {
    return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
      ? value[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value) {
  try {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function array(value) {
  try {
    return Array.isArray(value) ? value.slice(0, MAX_ITEMS) : null;
  } catch {
    return null;
  }
}

function wrapperData(body) {
  const envelope = record(body);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, "data")) {
    throw new TypeError("invalid Proxmox response");
  }
  return own(envelope, "data");
}

function safeVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return /^(?=.*\d)[vV]?[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/u.test(text) ? text : null;
}

function truncateCodePoints(value, maximum) {
  const points = Array.from(value);
  return points.length <= maximum
    ? value
    : `${points.slice(0, maximum - 1).join("")}\u2026`;
}

function redactOpaqueTokens(value) {
  return value.replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, (candidate) => {
    const core = candidate.replace(/={1,2}$/u, "");
    const unique = new Set(core.toLowerCase()).size;
    const hasSeparator = /[_+/-]/u.test(core);
    const mixedClasses = /[a-z]/u.test(core) && /[A-Z]/u.test(core)
      || /[A-Za-z]/u.test(core) && /\d/u.test(core);
    return unique >= 10 && (hasSeparator || mixedClasses) ? REPORT_REDACTION : candidate;
  });
}

function safeText(value, maximum) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  let text;
  try {
    text = String(value).slice(0, maximum * 8).normalize("NFKC");
  } catch {
    return "";
  }
  text = text
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu, `$1${REPORT_REDACTION}@`)
    .replace(/\b((?:authorization|proxy-authorization)\s*(?::|=)\s*)(?:pveapitoken|bearer|basic)\s+[^\s,;]+/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b((?:pveapitoken|bearer|basic)\s+)[A-Za-z0-9!@._~+=+/-]{8,}/giu, `$1${REPORT_REDACTION}`)
    .replace(/((?:["']?(?:api[-_ ]?key|access[-_ ]?token|token|password|passwd|pwd|secret|credential|auth|cookie|session(?:id)?)["']?)\s*(?::|=)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      `$1${REPORT_REDACTION}`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      REPORT_REDACTION);
  text = redactOpaqueTokens(text).replace(/\s+/gu, " ").trim();
  return truncateCodePoints(text, maximum);
}

function safeName(value, fallback = "Unknown") {
  return safeText(value, 64) || fallback;
}

function optionalName(value, maximum = 96) {
  return safeText(value, maximum) || null;
}

function safeInventoryStatus(value, allowed, fallback = "unknown") {
  const status = statusToken(value);
  return allowed.includes(status) ? status : fallback;
}

function isoFromSeconds(value) {
  const seconds = optionalInteger(value, 0, 4_102_444_800);
  return seconds === null || seconds === 0 ? null : new Date(seconds * 1_000).toISOString();
}

function report(severity, source, message) {
  const safeSource = safeText(source, MAX_REPORT_SOURCE_CODE_POINTS);
  const safeMessage = safeText(message, MAX_REPORT_MESSAGE_CODE_POINTS);
  return safeSource && safeMessage ? { severity, source: safeSource, message: safeMessage } : null;
}

function metrics(values) {
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    const normalized = boundedInteger(value, -1, 0, Number.MAX_SAFE_INTEGER);
    if (normalized >= 0) output[key] = normalized;
  }
  return output;
}

function statusToken(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9_.:-]/gu, "").slice(0, 80)
    : "";
}

function taskSucceeded(entry) {
  const status = statusToken(own(entry, "status"));
  return status === "ok" || status === "success" || status === "successful";
}

function taskEndSeconds(entry) {
  return boundedInteger(own(entry, "endtime"), 0, 0, 4_102_444_800);
}

function completedTaskEntries(data, errorMessage) {
  const entries = array(data);
  if (!entries) throw new TypeError(errorMessage);
  const completed = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError(errorMessage);
    if (taskEndSeconds(entry) > 0) completed.push(entry);
  }
  return completed;
}

function recentCutoffSeconds(nowMilliseconds) {
  return Math.max(0, Math.floor(nowMilliseconds / 1000) - RECENT_TASK_WINDOW_SECONDS);
}

function permissionResult(data) {
  if (!record(data)) throw new TypeError("invalid permissions response");
  // Never expose the token's resource/privilege map in an operations snapshot.
  return { metrics: {}, reports: [] };
}

function versionResult(data) {
  const source = record(data);
  if (!source) throw new TypeError("invalid version response");
  const version = safeVersion(own(source, "version") ?? own(source, "release"));
  if (!version) throw new TypeError("invalid version response");
  return { metrics: {}, version, reports: [] };
}

function environmentResult(data) {
  const entries = array(data);
  if (!entries) throw new TypeError("invalid cluster status response");
  let cluster = null;
  const nodes = [];
  const seen = new Set();
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError("invalid cluster status entry");
    const type = statusToken(own(entry, "type"));
    if (type === "cluster" && !cluster) {
      const name = optionalName(own(entry, "name"), 80);
      cluster = {
        name,
        quorate: own(entry, "quorate") === 1 || own(entry, "quorate") === true,
        expectedVotes: optionalInteger(own(entry, "nodes"), 0, 10_000)
      };
      continue;
    }
    if (type !== "node") continue;
    const name = optionalName(own(entry, "name") ?? own(entry, "node"), 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    nodes.push({
      name,
      online: own(entry, "online") === 1 || own(entry, "online") === true,
      local: own(entry, "local") === 1 || own(entry, "local") === true,
      nodeId: optionalInteger(own(entry, "nodeid"), 0, 1_000_000)
    });
  }
  nodes.sort((left, right) => left.name.localeCompare(right.name));
  // A cluster name is its stable enrollment identity. Multiple visible nodes
  // without the named cluster record are useful evidence, but not enough to
  // authorize another endpoint as belonging to that environment.
  const kind = cluster?.name ? "cluster" : nodes.length === 1 ? "standalone" : "unknown";
  const environmentName = kind === "cluster"
    ? cluster.name
    : kind === "standalone" ? nodes[0].name : "Proxmox environment";
  const reports = [];
  if (kind === "cluster" && cluster && !cluster.quorate) {
    const item = report("error", `Cluster ${environmentName}`, "Proxmox reports that this cluster is not quorate.");
    if (item) reports.push(item);
  }
  return {
    metrics: {},
    reports,
    discovery: {
      kind,
      name: environmentName,
      clusterName: kind === "cluster" ? cluster.name : null,
      quorate: kind === "cluster" && cluster ? cluster.quorate : null,
      nodeNames: nodes.map(({ name }) => name),
      localNode: nodes.find(({ local }) => local)?.name || null,
      nodes
    },
    ...(reports.length ? { state: "degraded", code: "CLUSTER_NOT_QUORATE" } : {})
  };
}

function nodeAvailabilityResult(data) {
  const entries = array(data);
  if (!entries) throw new TypeError("invalid nodes response");
  if (!entries.length) {
    const item = report(
      "error",
      "Proxmox nodes",
      "The authenticated API returned no visible nodes. Review the token's audit permissions."
    );
    return {
      metrics: metrics({ nodeTotal: 0, nodeOnline: 0, nodeOffline: 0 }),
      reports: item ? [item] : [],
      state: "degraded",
      code: "NO_NODES_VISIBLE"
    };
  }
  let online = 0;
  let offline = 0;
  const reports = [];
  const nodes = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError("invalid node entry");
    const name = safeName(own(entry, "node"));
    const status = statusToken(own(entry, "status"));
    if (status === "online") online += 1;
    else {
      offline += 1;
      if (reports.length < MAX_REPORTS) {
        const item = report("error", `Node ${name}`, `Proxmox reports this node as ${status || "offline"}.`);
        if (item) reports.push(item);
      }
    }
    nodes.push({
      name,
      status: status === "online" ? "online" : status || "offline",
      uptimeSeconds: optionalInteger(own(entry, "uptime"), 0),
      cpuCores: optionalInteger(own(entry, "maxcpu"), 0, 65_536),
      memoryTotalBytes: optionalInteger(own(entry, "maxmem"), 0),
      rootDiskTotalBytes: optionalInteger(own(entry, "maxdisk"), 0),
      version: safeVersion(own(entry, "pveversion") ?? own(entry, "version"))
    });
  }
  nodes.sort((left, right) => left.name.localeCompare(right.name));
  return {
    metrics: metrics({ nodeTotal: entries.length, nodeOnline: online, nodeOffline: offline }),
    reports,
    inventory: { nodes },
    ...(offline ? { state: "degraded", code: "NODES_OFFLINE" } : {})
  };
}

function nodeResourcesResult(data) {
  const entries = array(data);
  if (!entries) throw new TypeError("invalid node resources response");
  let cpu = 0;
  let cpuSamples = 0;
  let memoryUsed = 0;
  let memoryTotal = 0;
  let diskUsed = 0;
  let diskTotal = 0;
  const reports = [];
  const nodes = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError("invalid node resource entry");
    const name = safeName(own(entry, "node"));
    const cpuRatio = boundedRatio(own(entry, "cpu"));
    const usedMemory = boundedInteger(own(entry, "mem"), 0, 0, Number.MAX_SAFE_INTEGER);
    const totalMemory = boundedInteger(own(entry, "maxmem"), 0, 0, Number.MAX_SAFE_INTEGER);
    const usedDisk = boundedInteger(own(entry, "disk"), 0, 0, Number.MAX_SAFE_INTEGER);
    const totalDisk = boundedInteger(own(entry, "maxdisk"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (cpuRatio !== null) {
      cpu += cpuRatio;
      cpuSamples += 1;
    }
    memoryUsed += usedMemory;
    memoryTotal += totalMemory;
    diskUsed += usedDisk;
    diskTotal += totalDisk;
    const memoryPercent = totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;
    const diskPercent = totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0;
    if (reports.length < MAX_REPORTS && memoryPercent >= 95) {
      const item = report("warning", `Node ${name}`, `Memory usage is ${memoryPercent}%.`);
      if (item) reports.push(item);
    }
    if (reports.length < MAX_REPORTS && diskPercent >= 95) {
      const item = report("warning", `Node ${name}`, `Local disk usage is ${diskPercent}%.`);
      if (item) reports.push(item);
    }
    nodes.push({
      name,
      status: safeInventoryStatus(own(entry, "status"), ["online", "offline"], "unknown"),
      cpuPercent: percentFromRatio(own(entry, "cpu")),
      cpuCores: optionalInteger(own(entry, "maxcpu"), 0, 65_536),
      memoryUsedBytes: usedMemory,
      memoryTotalBytes: totalMemory,
      rootDiskUsedBytes: usedDisk,
      rootDiskTotalBytes: totalDisk,
      uptimeSeconds: optionalInteger(own(entry, "uptime"), 0),
      version: safeVersion(own(entry, "pveversion") ?? own(entry, "version"))
    });
  }
  nodes.sort((left, right) => left.name.localeCompare(right.name));
  return {
    metrics: metrics({
      nodeCpuUsagePercent: cpuSamples ? Math.round((cpu / cpuSamples) * 100) : 0,
      nodeMemoryUsedBytes: memoryUsed,
      nodeMemoryTotalBytes: memoryTotal,
      nodeDiskUsedBytes: diskUsed,
      nodeDiskTotalBytes: diskTotal
    }),
    reports,
    inventory: { nodes },
    ...(reports.length ? { state: "limited", code: "RESOURCE_PRESSURE" } : {})
  };
}

function guestsResult(data) {
  const entries = array(data);
  if (!entries) throw new TypeError("invalid guests response");
  let running = 0;
  let stopped = 0;
  let virtualMachines = 0;
  let containers = 0;
  const workloads = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError("invalid guest entry");
    const type = statusToken(own(entry, "type"));
    if (type === "qemu") virtualMachines += 1;
    else if (type === "lxc") containers += 1;
    else continue;
    const status = statusToken(own(entry, "status"));
    if (status === "running") running += 1;
    else stopped += 1;
    const vmid = optionalInteger(own(entry, "vmid"), 1, 999_999_999);
    if (vmid === null) continue;
    const tags = typeof own(entry, "tags") === "string"
      ? own(entry, "tags").split(/[;,]/u).slice(0, 16).map((tag) => safeText(tag, 32)).filter(Boolean)
      : [];
    workloads.push({
      vmid,
      type,
      name: optionalName(own(entry, "name"), 96) || `${type === "qemu" ? "VM" : "LXC"} ${vmid}`,
      node: optionalName(own(entry, "node"), 64),
      status: safeInventoryStatus(status, ["running", "stopped", "paused", "suspended"], status === "running" ? "running" : "stopped"),
      template: own(entry, "template") === 1 || own(entry, "template") === true,
      cpuPercent: percentFromRatio(own(entry, "cpu")),
      cpuCores: optionalInteger(own(entry, "maxcpu"), 0, 65_536),
      memoryUsedBytes: optionalInteger(own(entry, "mem"), 0),
      memoryTotalBytes: optionalInteger(own(entry, "maxmem"), 0),
      diskUsedBytes: optionalInteger(own(entry, "disk"), 0),
      diskTotalBytes: optionalInteger(own(entry, "maxdisk"), 0),
      uptimeSeconds: optionalInteger(own(entry, "uptime"), 0),
      lock: optionalName(own(entry, "lock"), 32),
      tags
    });
  }
  workloads.sort((left, right) => left.vmid - right.vmid || left.type.localeCompare(right.type));
  return {
    metrics: metrics({
      guestTotal: entries.length,
      guestRunning: running,
      guestStopped: stopped,
      virtualMachineTotal: virtualMachines,
      containerTotal: containers
    }),
    reports: [],
    inventory: { workloads }
  };
}

function storageResult(data) {
  const entries = array(data);
  if (!entries) throw new TypeError("invalid storage response");
  let available = 0;
  let unavailable = 0;
  let usedBytes = 0;
  let totalBytes = 0;
  const reports = [];
  const storage = [];
  for (const raw of entries) {
    const entry = record(raw);
    if (!entry) throw new TypeError("invalid storage entry");
    const name = safeName(own(entry, "storage"));
    const node = safeName(own(entry, "node"), "cluster");
    const status = statusToken(own(entry, "status"));
    const total = boundedInteger(own(entry, "maxdisk"), 0, 0, Number.MAX_SAFE_INTEGER);
    const used = boundedInteger(own(entry, "disk"), 0, 0, Number.MAX_SAFE_INTEGER);
    usedBytes += used;
    totalBytes += total;
    if (["unknown", "offline", "inactive", "unavailable", "disabled"].includes(status)) {
      unavailable += 1;
      if (reports.length < MAX_REPORTS) {
        const item = report("error", `Storage ${name}`, `${node} reports this storage as ${status}.`);
        if (item) reports.push(item);
      }
    } else {
      available += 1;
      const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;
      if (usagePercent >= 90 && reports.length < MAX_REPORTS) {
        const item = report("warning", `Storage ${name}`, `${node} storage usage is ${usagePercent}%.`);
        if (item) reports.push(item);
      }
    }
    storage.push({
      name,
      node,
      status: status || "unknown",
      type: optionalName(own(entry, "plugintype") ?? own(entry, "type"), 40),
      shared: own(entry, "shared") === 1 || own(entry, "shared") === true,
      usedBytes: used,
      totalBytes: total,
      usagePercent: total > 0 ? Math.round((used / total) * 1_000) / 10 : null
    });
  }
  storage.sort((left, right) => left.node.localeCompare(right.node) || left.name.localeCompare(right.name));
  const hasError = reports.some(({ severity }) => severity === "error");
  return {
    metrics: metrics({
      storageTotal: entries.length,
      storageAvailable: available,
      storageUnavailable: unavailable,
      storageUsedBytes: usedBytes,
      storageTotalBytes: totalBytes,
      storageUsagePercent: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0
    }),
    reports,
    inventory: { storage },
    ...(hasError
      ? { state: "degraded", code: "STORAGE_UNAVAILABLE" }
      : reports.length
        ? { state: "limited", code: "STORAGE_PRESSURE" }
        : {})
  };
}

function tasksResult(data, nowMilliseconds) {
  const entries = completedTaskEntries(data, "invalid tasks response");
  const cutoff = recentCutoffSeconds(nowMilliseconds);
  const failed = entries.filter((entry) => {
    const source = record(entry);
    return source && taskEndSeconds(source) >= cutoff && !taskSucceeded(source);
  });
  const reports = [];
  for (const raw of failed.slice(0, MAX_REPORTS)) {
    const entry = record(raw);
    const taskType = safeName(own(entry, "type"), "task");
    const node = safeName(own(entry, "node"), "cluster");
    // Proxmox task status may contain an arbitrary command line. Preserve the
    // useful task type/node identifiers, but never relay that raw status text.
    const item = report("warning", `Task ${taskType}`, `${node}: Proxmox reported this task as failed.`);
    if (item) reports.push(item);
  }
  const activity = entries.slice(0, 100).map((entry, index) => {
    const endedAt = isoFromSeconds(own(entry, "endtime"));
    const taskType = safeName(own(entry, "type"), "task");
    const vmid = optionalInteger(own(entry, "id"), 1, 999_999_999);
    return {
      id: `${taskType}:${optionalName(own(entry, "node"), 64) || "cluster"}:${vmid || 0}:${endedAt || index}`,
      type: taskType,
      node: optionalName(own(entry, "node"), 64),
      vmid,
      status: taskSucceeded(entry) ? "success" : "failed",
      endedAt,
      ageSeconds: endedAt ? Math.max(0, Math.floor((nowMilliseconds - Date.parse(endedAt)) / 1_000)) : null
    };
  });
  return {
    metrics: metrics({ taskRecordsObserved: entries.length, failedTasks24h: failed.length }),
    reports,
    inventory: { activity },
    ...(failed.length ? { state: "limited", code: "RECENT_TASK_FAILURES" } : {})
  };
}

function backupsResult(data, nowMilliseconds) {
  // Treat the upstream typefilter as an optimization, not a trust boundary.
  // Older proxies and API shims have been observed to ignore query filters.
  const entries = completedTaskEntries(data, "invalid backup tasks response")
    .filter((entry) => statusToken(own(entry, "type")) === "vzdump");
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const cutoff = recentCutoffSeconds(nowMilliseconds);
  let latestSuccess = 0;
  let latestFailure = 0;
  let failures24h = 0;
  for (const raw of entries) {
    const entry = raw;
    const ended = taskEndSeconds(entry);
    if (taskSucceeded(entry)) latestSuccess = Math.max(latestSuccess, ended);
    else {
      latestFailure = Math.max(latestFailure, ended);
      if (ended >= cutoff) failures24h += 1;
    }
  }
  const reports = [];
  if (!entries.length) {
    const item = report(
      "notice",
      "Proxmox backups",
      "No completed backup tasks were returned in the latest backup-task window."
    );
    if (item) reports.push(item);
  } else if (latestFailure > latestSuccess) {
    const item = report("warning", "Proxmox backups", "The newest observed backup task did not complete successfully.");
    if (item) reports.push(item);
  }
  const backupMetrics = {
    backupTasksObserved: entries.length,
    backupFailures24h: failures24h,
    ...(latestSuccess ? { lastBackupSuccessAgeSeconds: Math.max(0, nowSeconds - latestSuccess) } : {}),
    ...(latestFailure ? { lastBackupFailureAgeSeconds: Math.max(0, nowSeconds - latestFailure) } : {})
  };
  const backups = entries.slice(0, 100).map((entry, index) => {
    const endedAt = isoFromSeconds(own(entry, "endtime"));
    const vmid = optionalInteger(own(entry, "id"), 1, 999_999_999);
    return {
      id: `vzdump:${optionalName(own(entry, "node"), 64) || "cluster"}:${vmid || 0}:${endedAt || index}`,
      type: "vzdump",
      node: optionalName(own(entry, "node"), 64),
      vmid,
      status: taskSucceeded(entry) ? "success" : "failed",
      endedAt,
      ageSeconds: endedAt ? Math.max(0, Math.floor((nowMilliseconds - Date.parse(endedAt)) / 1_000)) : null
    };
  });
  return {
    metrics: metrics(backupMetrics),
    reports,
    inventory: { backups },
    ...(latestFailure > latestSuccess
      ? { state: "limited", code: "LATEST_BACKUP_FAILED" }
      : {})
  };
}

const PARSERS = Object.freeze({
  identity: permissionResult,
  version: versionResult,
  environment: environmentResult,
  nodes: nodeAvailabilityResult,
  "node-resources": nodeResourcesResult,
  guests: guestsResult,
  storage: storageResult,
  tasks: tasksResult,
  backups: backupsResult
});

function priority(state) {
  return ({ healthy: 0, limited: 1, stale: 2, degraded: 3, auth_required: 4, down: 5 })[state] ?? 2;
}

function worstState(checks) {
  let state = "healthy";
  for (const check of checks) if (priority(check.state) > priority(state)) state = check.state;
  return state;
}

function safeFailureCode(error) {
  const raw = own(error, "code");
  const candidate = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : "PROBE_FAILED";
}

function failedState(importance) {
  if (importance === "optional") return "limited";
  return importance === "critical" || importance === "core" ? "down" : "degraded";
}

function connectionState(checks) {
  const identity = checks.find(({ id }) => id === "identity");
  if (checks.some(({ state }) => state === "auth_required")) return "auth_required";
  if (identity?.ok) return "connected";
  return "down";
}

function mergeMetrics(checks) {
  return Object.assign({}, ...checks.map(({ metrics: value }) => value));
}

function mergeNodeInventory(parts, discovery, version) {
  const byName = new Map();
  const discoveryNodes = new Map((discovery?.nodes || []).map((node) => [node.name, node]));
  const merge = (source) => {
    if (!source?.name) return;
    const previous = byName.get(source.name) || {
      name: source.name,
      status: "unknown",
      cpuPercent: null,
      cpuCores: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      rootDiskUsedBytes: null,
      rootDiskTotalBytes: null,
      uptimeSeconds: null,
      version: null
    };
    const next = { ...previous };
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined && value !== "") next[key] = value;
    }
    byName.set(source.name, next);
  };
  for (const part of parts) {
    for (const node of part.inventory?.nodes || []) merge(node);
  }
  for (const node of discovery?.nodes || []) {
    merge({ name: node.name, status: node.online ? "online" : "offline", local: node.local, nodeId: node.nodeId });
  }
  const workloads = parts.flatMap((part) => part.inventory?.workloads || []);
  for (const workload of workloads) {
    if (!workload.node) continue;
    const node = byName.get(workload.node);
    if (!node) merge({ name: workload.node });
  }
  const nodes = [...byName.values()].map((node) => {
    const nodeWorkloads = workloads.filter((workload) => workload.node === node.name && !workload.template);
    const local = discoveryNodes.get(node.name)?.local === true || node.local === true;
    return {
      ...node,
      local,
      version: node.version || (local ? version : null),
      workloadCount: nodeWorkloads.length,
      runningWorkloadCount: nodeWorkloads.filter(({ status }) => status === "running").length,
      virtualMachineCount: nodeWorkloads.filter(({ type }) => type === "qemu").length,
      containerCount: nodeWorkloads.filter(({ type }) => type === "lxc").length
    };
  });
  nodes.sort((left, right) => left.name.localeCompare(right.name));
  return nodes.slice(0, MAX_ITEMS);
}

function mergeProxmoxInventory(parts, discovery, version) {
  const backups = parts.flatMap((part) => part.inventory?.backups || []);
  const latestBackupByVmid = new Map();
  for (const backup of backups) {
    if (backup.vmid === null) continue;
    const previous = latestBackupByVmid.get(backup.vmid);
    if (!previous || String(backup.endedAt || "") > String(previous.endedAt || "")) {
      latestBackupByVmid.set(backup.vmid, backup);
    }
  }
  const workloads = parts.flatMap((part) => part.inventory?.workloads || []).map((workload) => {
    const backup = latestBackupByVmid.get(workload.vmid);
    return {
      ...workload,
      id: `${workload.node || "unassigned"}:${workload.type}:${workload.vmid}`,
      backup: backup ? {
        status: backup.status,
        endedAt: backup.endedAt,
        ageSeconds: backup.ageSeconds
      } : null
    };
  }).slice(0, MAX_ITEMS);
  const storage = parts.flatMap((part) => part.inventory?.storage || []).map((entry) => ({
    ...entry,
    id: `${entry.node}:${entry.name}`
  })).slice(0, MAX_ITEMS);
  const activityById = new Map();
  for (const entry of parts.flatMap((part) => [
    ...(part.inventory?.activity || []),
    ...(part.inventory?.backups || [])
  ])) {
    if (!activityById.has(entry.id)) activityById.set(entry.id, entry);
  }
  const activity = [...activityById.values()]
    .sort((left, right) => String(right.endedAt || "").localeCompare(String(left.endedAt || "")))
    .slice(0, 100);
  return {
    nodes: mergeNodeInventory(parts, discovery, version),
    workloads,
    storage,
    activity
  };
}

function historyNodeSelection(parts) {
  const candidates = [];
  for (const part of parts) {
    if (part.id === "nodes") {
      for (const node of part.inventory?.nodes || []) candidates.push(node?.name);
    }
    for (const node of part.discovery?.nodeNames || []) candidates.push(node);
  }
  const seenCandidates = new Set();
  const nodes = [];
  let invalidNodes = 0;
  for (const candidate of candidates.slice(0, MAX_ITEMS * 2)) {
    const raw = typeof candidate === "string" ? candidate : "";
    const identity = raw || `invalid-${invalidNodes}`;
    if (seenCandidates.has(identity)) continue;
    seenCandidates.add(identity);
    const node = normalizeProxmoxNodeName(raw);
    if (!node) {
      invalidNodes += 1;
      continue;
    }
    nodes.push(node);
  }
  nodes.sort((left, right) => left.localeCompare(right));
  const selected = nodes.slice(0, MAX_HISTORY_NODES);
  const cappedNodes = Math.max(0, nodes.length - selected.length);
  const omittedNodes = invalidNodes + cappedNodes;
  return {
    nodes: selected,
    invalidNodes,
    cappedNodes,
    omittedNodes,
    totalNodes: selected.length + omittedNodes
  };
}

function taskKeyPart(value, maximum = 160) {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return "";
  return value.slice(0, maximum);
}

function taskEntryKey(entry) {
  const upid = taskKeyPart(own(entry, "upid"), 512);
  if (upid) return `upid:${upid}`;
  return [
    "task",
    taskKeyPart(own(entry, "node")),
    taskKeyPart(own(entry, "type")),
    taskKeyPart(own(entry, "id")),
    taskKeyPart(own(entry, "starttime")),
    taskKeyPart(own(entry, "endtime"))
  ].join("\u0000");
}

async function requestNodeHistory(transport, plan, node, options) {
  if (options.signal?.aborted) return { ok: false, code: "CHECK_CANCELLED", status: null, node };
  try {
    const response = await transport(plan.routeId, {
      method: "GET",
      responseType: "json",
      maxBytes: plan.maxBytes,
      timeoutMs: plan.timeoutMs,
      signal: options.signal,
      checkId: plan.id,
      node
    });
    const status = boundedInteger(response?.status, 0, 0, 599);
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        code: status === 401 || status === 403 ? "AUTH_REQUIRED" : "HTTP_ERROR",
        status: status || null,
        node
      };
    }
    try {
      const entries = array(wrapperData(response?.body));
      if (!entries || entries.some((entry) => !record(entry))) throw new TypeError("invalid task history response");
      return { ok: true, entries };
    } catch {
      return { ok: false, code: "INVALID_RESPONSE", status: null, node };
    }
  } catch (error) {
    return { ok: false, code: safeFailureCode(error), status: null, node };
  }
}

async function collectNodeHistory(transport, plan, parts, options) {
  const selection = historyNodeSelection(parts);
  const concurrency = boundedInteger(
    options.historyConcurrency,
    1,
    1,
    MAX_HISTORY_CONCURRENCY
  );
  const rows = [];
  const seen = new Set();
  const failures = [];
  let successfulNodes = 0;
  // Process one bounded batch at a time so a hostile endpoint cannot make us
  // retain every node's maximum response simultaneously.
  for (let offset = 0; offset < selection.nodes.length; offset += concurrency) {
    const nodes = selection.nodes.slice(offset, offset + concurrency);
    const results = await Promise.all(nodes.map((node) => requestNodeHistory(transport, plan, node, options)));
    for (const result of results) {
      if (!result.ok) {
        failures.push({ code: result.code, status: result.status, node: result.node });
        continue;
      }
      successfulNodes += 1;
      for (const entry of result.entries) {
        if (rows.length >= MAX_ITEMS) break;
        const key = taskEntryKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(entry);
      }
    }
  }
  return {
    rows,
    failures,
    successfulNodes,
    failedNodes: failures.length,
    invalidNodes: selection.invalidNodes,
    cappedNodes: selection.cappedNodes,
    omittedNodes: selection.omittedNodes,
    totalNodes: selection.totalNodes
  };
}

function fixedProbeFailureMessage(plan, failureCode, status) {
  const history = HISTORY_ROUTE_IDS.has(plan.routeId);
  if (status === 401) {
    return "Proxmox rejected the API token (HTTP 401). Verify the token ID and secret.";
  }
  if (status === 403) {
    return "Proxmox denied this read-only capability (HTTP 403). Grant propagated Sys.Audit permissions for the environment.";
  }
  if (failureCode === "TLS_PIN_MISMATCH") {
    return "The Proxmox certificate no longer matches the approved fingerprint. Verify the endpoint certificate before approving a new pin.";
  }
  if (failureCode === "TLS_CERTIFICATE_UNTRUSTED" || failureCode === "TLS_CERTIFICATE_INVALID" || failureCode === "TLS_ERROR") {
    return "TLS validation failed for the Proxmox endpoint. Verify its hostname, certificate validity, and configured trust mode.";
  }
  if (["TIMEOUT", "PROBE_TIMEOUT", "UPSTREAM_TIMEOUT", "ETIMEDOUT"].includes(failureCode)) {
    return "The Proxmox endpoint did not respond before the read-only check timed out. Verify node reachability and load.";
  }
  if ([
    "UNREACHABLE",
    "UPSTREAM_UNREACHABLE",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "DNS_FAILED",
    "NETWORK_ERROR"
  ].includes(failureCode)) {
    return "The Proxmox endpoint could not be reached. Verify its address, port, DNS, firewall, and service state.";
  }
  if (failureCode === "INVALID_RESPONSE" || failureCode === "UPSTREAM_CONTENT_REJECTED" || failureCode === "UPSTREAM_REDIRECT_REJECTED") {
    return "Proxmox returned an unexpected API response. Verify API compatibility and any reverse-proxy base path.";
  }
  if (failureCode === "UPSTREAM_RESPONSE_TOO_LARGE" || failureCode === "RESPONSE_TOO_LARGE" || status === 413) {
    return "The Proxmox response exceeded Helmsman's safety limit. Review the size of this inventory capability.";
  }
  if (failureCode === "CHECK_CANCELLED" || failureCode === "PROBE_CANCELLED" || failureCode === "ABORT_ERR") {
    return "The Proxmox check was interrupted. Run the connection test again or wait for the next monitoring cycle.";
  }
  if (status === 400) {
    return history
      ? "Proxmox rejected the node-scoped task-history request (HTTP 400). Verify Proxmox API compatibility and the configured base URL."
      : "Proxmox rejected this read-only API request (HTTP 400). Verify API compatibility and the configured base URL.";
  }
  if (status === 404) {
    return "The expected Proxmox API route was not found (HTTP 404). Verify the configured base URL and Proxmox version.";
  }
  if (status === 429) {
    return "Proxmox rate-limited this read-only check (HTTP 429). Helmsman will retry during the next monitoring cycle.";
  }
  if (status !== null && status >= 500) {
    return `Proxmox returned a server error (HTTP ${status}). Review the Proxmox service logs for this capability.`;
  }
  if (status !== null) {
    return `Proxmox rejected this read-only capability (HTTP ${status}). Verify API compatibility and propagated audit permissions.`;
  }
  return "The Proxmox read-only capability could not be completed. Verify endpoint reachability, API compatibility, and audit permissions.";
}

function probeFailureReport(plan, failureCode, status) {
  return report(
    ["core", "critical"].includes(plan.importance) ? "error" : "warning",
    plan.label,
    fixedProbeFailureMessage(plan, failureCode, status)
  );
}

function nodeHistoryFailureReport(plan, failure) {
  const node = normalizeProxmoxNodeName(failure?.node);
  if (!node) return null;
  const query = plan.id === "backups"
    ? "source=archive&typefilter=vzdump&limit=100"
    : "source=archive&limit=100";
  const operation = `GET /api2/json/nodes/${node}/tasks?${query}`;
  return report(
    "warning",
    `${plan.label} · Node ${node}`,
    `${operation} failed. ${fixedProbeFailureMessage(plan, failure.code, failure.status)}`
  );
}

function representativeHistoryFailure(failures) {
  const priority = (failure) => {
    if (failure.status === 401 || failure.status === 403) return 0;
    if (failure.status === 400 || failure.status === 404) return 1;
    if (failure.status === 429) return 2;
    if (failure.status !== null && failure.status >= 500) return 3;
    if (failure.code === "INVALID_RESPONSE") return 4;
    return 5;
  };
  return [...failures].sort((left, right) => priority(left) - priority(right))[0] || null;
}

function historyCoverageReport(plan, collection) {
  const subject = plan.id === "backups" ? "Backup history" : "Recent task history";
  const unavailableNodes = collection.failedNodes + collection.omittedNodes;
  let message;
  if (!collection.totalNodes) {
    message = `${subject} could not be collected because no validated Proxmox node name was available. Verify node visibility and propagated Sys.Audit permissions.`;
  } else if (!collection.successfulNodes) {
    message = `${subject} could not be collected from any of ${collection.totalNodes} discovered nodes.`;
  } else {
    message = `${subject} is incomplete: ${unavailableNodes} of ${collection.totalNodes} discovered nodes could not be queried. Available history is still shown.`;
  }
  if (collection.cappedNodes) {
    message = `${message} The environment exceeded Helmsman's bounded ${MAX_HISTORY_NODES}-node history limit; review remaining nodes directly in Proxmox.`;
  } else if (collection.invalidNodes) {
    message = `${message} Proxmox returned a node identifier that Helmsman could not route safely; review the environment's node configuration.`;
  }
  return report("warning", plan.label, message);
}

function historyFailureReports(plan, collection) {
  return [
    historyCoverageReport(plan, collection),
    ...collection.failures.map((failure) => nodeHistoryFailureReport(plan, failure))
  ].filter(Boolean).slice(0, MAX_REPORTS);
}

export function buildProxmoxProbePlan(options = {}) {
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const plans = options.scope === "endpoint"
    ? PROBE_PLAN.filter(({ id }) => ["identity", "version", "environment"].includes(id))
    : PROBE_PLAN;
  return plans.map((entry) => Object.freeze({ ...entry, method: "GET", timeoutMs }));
}

export async function probeProxmox(transport, options = {}) {
  if (typeof transport !== "function") throw new TypeError("A Proxmox probe transport is required.");
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const startedAt = Number(clock());
  if (!Number.isFinite(startedAt)) throw new TypeError("The Proxmox probe clock returned an invalid time.");
  const checkedAt = typeof options.checkedAt === "string" && Number.isFinite(Date.parse(options.checkedAt))
    ? new Date(options.checkedAt).toISOString()
    : new Date(startedAt).toISOString();
  const checks = [];
  const parsedParts = [];
  let version = null;

  for (const plan of buildProxmoxProbePlan(options)) {
    const requestStartedAt = Number(clock());
    try {
      if (HISTORY_ROUTE_IDS.has(plan.routeId)) {
        const collection = await collectNodeHistory(transport, plan, parsedParts, options);
        const requestCompletedAt = Number(clock());
        const latencyMs = boundedInteger(requestCompletedAt - requestStartedAt, 0, 0, 120_000);
        const missingNodes = collection.failedNodes + collection.omittedNodes;
        if (!collection.successfulNodes) {
          const representative = representativeHistoryFailure(collection.failures);
          const reports = historyFailureReports(plan, collection);
          checks.push({
            id: plan.id,
            label: plan.label,
            ok: false,
            state: failedState(plan.importance),
            importance: plan.importance,
            code: plan.id === "backups" ? "BACKUP_HISTORY_UNAVAILABLE" : "TASK_HISTORY_UNAVAILABLE",
            httpStatus: representative?.status || null,
            latencyMs,
            metrics: {},
            ...(reports.length ? { reports } : {})
          });
          continue;
        }
        let result;
        try {
          result = PARSERS[plan.id](collection.rows, requestCompletedAt);
        } catch {
          const item = probeFailureReport(plan, "INVALID_RESPONSE", null);
          checks.push({
            id: plan.id,
            label: plan.label,
            ok: false,
            state: failedState(plan.importance),
            importance: plan.importance,
            code: "INVALID_RESPONSE",
            httpStatus: null,
            latencyMs,
            metrics: {},
            ...(item ? { reports: [item] } : {})
          });
          continue;
        }
        if (missingNodes) {
          const coverageReports = historyFailureReports(plan, collection);
          result = {
            ...result,
            state: priority(result.state || "healthy") > priority("limited") ? result.state : "limited",
            code: plan.id === "backups" ? "BACKUP_HISTORY_PARTIAL" : "TASK_HISTORY_PARTIAL",
            reports: [...coverageReports, ...(result.reports || [])].slice(0, MAX_REPORTS)
          };
        }
        parsedParts.push({ id: plan.id, ...result });
        const state = result.state || "healthy";
        checks.push({
          id: plan.id,
          label: plan.label,
          ok: state === "healthy",
          state,
          importance: plan.importance,
          code: result.code || null,
          httpStatus: null,
          latencyMs,
          metrics: result.metrics,
          ...(result.reports.length ? { reports: result.reports } : {})
        });
        continue;
      }
      const response = await transport(plan.routeId, {
        method: "GET",
        responseType: "json",
        maxBytes: plan.maxBytes,
        timeoutMs: plan.timeoutMs,
        signal: options.signal,
        checkId: plan.id
      });
      const requestCompletedAt = Number(clock());
      const latencyMs = boundedInteger(requestCompletedAt - requestStartedAt, 0, 0, 120_000);
      const status = boundedInteger(response?.status, 0, 0, 599);
      if (status === 401 || status === 403) {
        const item = probeFailureReport(plan, "AUTH_REQUIRED", status);
        checks.push({
          id: plan.id,
          label: plan.label,
          ok: false,
          state: "auth_required",
          importance: plan.importance,
          code: "AUTH_REQUIRED",
          httpStatus: status,
          latencyMs,
          metrics: {},
          ...(item ? { reports: [item] } : {})
        });
        // A rejected credential is target-wide. Avoid repeating it against
        // every capability and potentially triggering upstream auth controls.
        break;
      }
      if (status < 200 || status >= 300) {
        const item = probeFailureReport(plan, "HTTP_ERROR", status || null);
        checks.push({
          id: plan.id,
          label: plan.label,
          ok: false,
          state: failedState(plan.importance),
          importance: plan.importance,
          code: "HTTP_ERROR",
          httpStatus: status || null,
          latencyMs,
          metrics: {},
          ...(item ? { reports: [item] } : {})
        });
        continue;
      }
      let result;
      try {
        result = PARSERS[plan.id](wrapperData(response?.body), requestCompletedAt);
      } catch {
        const item = probeFailureReport(plan, "INVALID_RESPONSE", null);
        checks.push({
          id: plan.id,
          label: plan.label,
          ok: false,
          state: failedState(plan.importance),
          importance: plan.importance,
          code: "INVALID_RESPONSE",
          httpStatus: null,
          latencyMs,
          metrics: {},
          ...(item ? { reports: [item] } : {})
        });
        continue;
      }
      if (result.version) version = result.version;
      parsedParts.push({ id: plan.id, ...result });
      const state = result.state || "healthy";
      checks.push({
        id: plan.id,
        label: plan.label,
        ok: state === "healthy",
        state,
        importance: plan.importance,
        code: result.code || null,
        httpStatus: null,
        latencyMs,
        metrics: result.metrics,
        ...(result.reports.length ? { reports: result.reports } : {})
      });
    } catch (error) {
      const requestCompletedAt = Number(clock());
      const failureCode = safeFailureCode(error);
      const item = probeFailureReport(plan, failureCode, null);
      checks.push({
        id: plan.id,
        label: plan.label,
        ok: false,
        state: failedState(plan.importance),
        importance: plan.importance,
        code: failureCode,
        httpStatus: null,
        latencyMs: boundedInteger(requestCompletedAt - requestStartedAt, 0, 0, 120_000),
        metrics: {},
        ...(item ? { reports: [item] } : {})
      });
      if (plan.id === "identity") break;
    }
  }

  const completedAt = Number(clock());
  const state = worstState(checks);
  const reports = checks.flatMap((check) => check.reports || []).slice(0, MAX_REPORTS);
  const discovery = parsedParts.find(({ discovery: value }) => value)?.discovery || null;
  const inventory = mergeProxmoxInventory(parsedParts, discovery, version);
  const hasInventory = inventory.nodes.length
    || inventory.workloads.length
    || inventory.storage.length
    || inventory.activity.length;
  return {
    schema: PROXMOX_PROBE_SCHEMA,
    type: "proxmox",
    state,
    connectionState: connectionState(checks),
    checkedAt,
    latencyMs: boundedInteger(completedAt - startedAt, 0, 0, 120_000),
    version,
    checks,
    metrics: mergeMetrics(checks),
    ...(discovery ? { discovery } : {}),
    ...(hasInventory ? { inventory } : {}),
    ...(reports.length ? { reports } : {})
  };
}

export function probeProxmoxEndpoint(transport, options = {}) {
  return probeProxmox(transport, { ...options, scope: "endpoint" });
}
