const MAX_ENVIRONMENTS = 500;
const MAX_CONTAINERS = 5_000;
const MAX_STACKS = 1_000;
const MAX_PORTS_PER_CONTAINER = 32;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;

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
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value, fallback = "", maximum = 180) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value).replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, maximum);
}

function integer(value, fallback = null, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number"
    && !(typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value.trim()))) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return fallback;
  return number;
}

function epochIso(value) {
  const seconds = integer(value, null, 1, 253_402_300_799);
  if (seconds === null) return null;
  const result = new Date(seconds * 1_000);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function existingIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? value : null;
}

function endpointPlatform(source) {
  const engine = text(own(source, "ContainerEngine"), "", 24).toLowerCase();
  if (engine === "docker") return { platform: "Docker", containerCapable: true };
  if (engine === "podman") return { platform: "Podman", containerCapable: true };
  const type = integer(own(source, "Type"), null, 1, 99);
  if ([1, 2, 4].includes(type)) return { platform: "Docker", containerCapable: true };
  if ([5, 6, 7].includes(type)) return { platform: "Kubernetes", containerCapable: false };
  if (type === 3) return { platform: "Azure", containerCapable: false };
  const platformType = text(own(source, "PlatformType"), "", 24).toLowerCase();
  if (platformType === "docker") return { platform: "Docker", containerCapable: true };
  if (platformType === "podman") return { platform: "Podman", containerCapable: true };
  if (platformType === "kubernetes") return { platform: "Kubernetes", containerCapable: false };
  const normalized = text(own(source, "platform"), "", 24).toLowerCase();
  if (normalized === "docker") return { platform: "Docker", containerCapable: own(source, "containerCapable") !== false };
  if (normalized === "podman") return { platform: "Podman", containerCapable: own(source, "containerCapable") !== false };
  if (normalized === "kubernetes") return { platform: "Kubernetes", containerCapable: false };
  if (normalized === "azure") return { platform: "Azure", containerCapable: false };
  return { platform: "Unknown", containerCapable: false };
}

function environmentState(value) {
  const normalized = text(value, "", 24).toLowerCase();
  if (["up", "down", "provisioning", "error", "unknown"].includes(normalized)) return normalized;
  const status = integer(value, null, 1, 4);
  if (status === 1) return "up";
  if (status === 2) return "down";
  if (status === 3) return "provisioning";
  if (status === 4) return "error";
  return "unknown";
}

export function portainerVersionFromStatus(value) {
  const source = record(value);
  if (!source) return null;
  const version = text(own(source, "Version") ?? own(source, "version"), "", 64);
  return /^[vV]?\d+(?:\.\d+){1,4}(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ? version : null;
}

export function portainerIdentityIsValid(value) {
  const source = record(value);
  if (!source) return false;
  const id = integer(own(source, "Id") ?? own(source, "ID") ?? own(source, "id"), null, 1);
  const username = text(own(source, "Username") ?? own(source, "username"), "", 80);
  return id !== null && Boolean(username);
}

export function environmentsFromPortainer(value) {
  if (!Array.isArray(value)) throw new TypeError("invalid Portainer environment response");
  const output = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_ENVIRONMENTS)) {
    const source = record(candidate);
    const id = integer(own(source, "Id") ?? own(source, "ID") ?? own(source, "id"), null, 1, 2_147_483_647);
    if (!source || id === null || seen.has(id)) continue;
    seen.add(id);
    const { platform, containerCapable } = endpointPlatform(source);
    output.push({
      id,
      name: text(own(source, "Name") ?? own(source, "name"), `Environment ${id}`, 96),
      state: environmentState(own(source, "Status") ?? own(source, "status") ?? own(source, "state")),
      platform,
      containerCapable,
      edge: Boolean(own(source, "EdgeID") ?? own(source, "edgeId") ?? own(source, "edge")),
      agentVersion: text(own(source, "AgentVersion") ?? own(source, "agentVersion"), "", 64) || null
    });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
}

function containerName(source, id) {
  const names = Array.isArray(own(source, "Names")) ? own(source, "Names") : [];
  const candidate = names.map((entry) => text(entry, "", 128).replace(/^\/+/, "")).find(Boolean);
  return candidate || text(own(source, "Name") ?? own(source, "name"), id.slice(0, 12), 128);
}

function containerState(source) {
  const state = text(own(source, "State") ?? own(source, "state"), "unknown", 32).toLowerCase();
  return ["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(state)
    ? state
    : "unknown";
}

function containerPorts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PORTS_PER_CONTAINER).flatMap((candidate) => {
    const source = record(candidate);
    const privatePort = integer(own(source, "PrivatePort"), null, 1, 65_535);
    const publicPort = integer(own(source, "PublicPort"), null, 1, 65_535);
    const protocol = text(own(source, "Type"), "tcp", 8).toLowerCase();
    if (!source || privatePort === null || !["tcp", "udp", "sctp"].includes(protocol)) return [];
    return [{ privatePort, publicPort, protocol }];
  });
}

function composeStackName(source) {
  const labels = record(own(source, "Labels"));
  return text(own(labels, "com.docker.compose.project"), "", 96) || null;
}

export function containersFromPortainer(value, environment) {
  if (!Array.isArray(value)) throw new TypeError("invalid Portainer container response");
  const safeEnvironment = record(environment);
  const environmentId = integer(own(safeEnvironment, "id"), null, 1, 2_147_483_647);
  const environmentName = text(own(safeEnvironment, "name"), "", 96);
  if (environmentId === null || !environmentName) throw new TypeError("invalid Portainer environment identity");
  const output = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_CONTAINERS)) {
    const source = record(candidate);
    const id = text(own(source, "Id") ?? own(source, "ID") ?? own(source, "id"), "", 64).toLowerCase();
    if (!source || !CONTAINER_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const state = containerState(source);
    const status = text(own(source, "Status") ?? own(source, "status"), "", 180);
    const unhealthy = state === "dead"
      || state === "restarting"
      || (state === "running" && /\bunhealthy\b/iu.test(status));
    output.push({
      id,
      shortId: id.slice(0, 12),
      name: containerName(source, id),
      image: text(own(source, "Image") ?? own(source, "image"), "Unknown image", 220),
      imageId: text(own(source, "ImageID") ?? own(source, "ImageId"), "", 96) || null,
      environmentId,
      environmentName,
      state,
      status: status || state,
      health: unhealthy ? "unhealthy" : state === "running" ? "healthy" : "informational",
      stack: composeStackName(source),
      createdAt: epochIso(own(source, "Created") ?? own(source, "created")),
      ports: containerPorts(own(source, "Ports"))
    });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function stackState(value) {
  const normalized = text(value, "", 24).toLowerCase();
  if (["active", "inactive", "unknown"].includes(normalized)) return normalized;
  const status = integer(value, null, 1, 2);
  return status === 1 ? "active" : status === 2 ? "inactive" : "unknown";
}

export function stacksFromPortainer(value, environmentNames = new Map()) {
  if (!Array.isArray(value)) throw new TypeError("invalid Portainer stack response");
  const output = [];
  const seen = new Set();
  for (const candidate of value.slice(0, MAX_STACKS)) {
    const source = record(candidate);
    const id = integer(own(source, "Id") ?? own(source, "ID") ?? own(source, "id"), null, 1, 2_147_483_647);
    const endpointId = integer(own(source, "EndpointId") ?? own(source, "endpointId"), null, 1, 2_147_483_647);
    if (!source || id === null || seen.has(id)) continue;
    seen.add(id);
    output.push({
      id,
      name: text(own(source, "Name") ?? own(source, "name"), `Stack ${id}`, 128),
      state: stackState(own(source, "Status") ?? own(source, "status") ?? own(source, "state")),
      type: integer(own(source, "Type") ?? own(source, "type"), null, 1, 9),
      environmentId: endpointId,
      environmentName: endpointId === null ? null : environmentNames.get(endpointId) || `Environment ${endpointId}`,
      createdAt: existingIso(own(source, "createdAt")) || epochIso(own(source, "CreationDate") ?? own(source, "created")),
      updatedAt: existingIso(own(source, "updatedAt")) || epochIso(own(source, "UpdateDate") ?? own(source, "updated"))
    });
  }
  return output.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
}

export function normalizePortainerInventory(value) {
  const source = record(value) || {};
  const environments = environmentsFromPortainer(Array.isArray(own(source, "environments")) ? own(source, "environments") : []);
  const environmentById = new Map(environments.map((entry) => [entry.id, entry]));
  const containers = [];
  const rawContainers = Array.isArray(own(source, "containers")) ? own(source, "containers") : [];
  const grouped = new Map();
  for (const candidate of rawContainers.slice(0, MAX_CONTAINERS)) {
    const entry = record(candidate);
    const environmentId = integer(own(entry, "environmentId"), null, 1, 2_147_483_647);
    if (!entry || environmentId === null || !environmentById.has(environmentId)) continue;
    if (!grouped.has(environmentId)) grouped.set(environmentId, []);
    // Reconstruct the minimal Docker-shaped fields so the same strict parser
    // revalidates data crossing the monitor boundary.
    grouped.get(environmentId).push({
      Id: own(entry, "id"),
      Names: [own(entry, "name")],
      Image: own(entry, "image"),
      ImageID: own(entry, "imageId"),
      State: own(entry, "state"),
      Status: own(entry, "status"),
      Created: own(entry, "createdAt") ? Math.floor(Date.parse(own(entry, "createdAt")) / 1_000) : undefined,
      Labels: own(entry, "stack") ? { "com.docker.compose.project": own(entry, "stack") } : {},
      Ports: Array.isArray(own(entry, "ports")) ? own(entry, "ports").map((port) => ({
        PrivatePort: own(port, "privatePort"),
        PublicPort: own(port, "publicPort"),
        Type: own(port, "protocol")
      })) : []
    });
  }
  for (const [environmentId, entries] of grouped) {
    containers.push(...containersFromPortainer(entries, environmentById.get(environmentId)));
  }
  const names = new Map(environments.map((entry) => [entry.id, entry.name]));
  const stacks = stacksFromPortainer(Array.isArray(own(source, "stacks")) ? own(source, "stacks") : [], names);
  return { environments, containers, stacks };
}

export function portainerInventoryMetrics(value) {
  const inventory = normalizePortainerInventory(value);
  return {
    environmentTotal: inventory.environments.length,
    environmentOnline: inventory.environments.filter(({ state }) => state === "up").length,
    environmentOffline: inventory.environments.filter(({ state }) => ["down", "error"].includes(state)).length,
    containerTotal: inventory.containers.length,
    containerRunning: inventory.containers.filter(({ state }) => state === "running").length,
    containerStopped: inventory.containers.filter(({ state }) => ["exited", "created"].includes(state)).length,
    containerUnhealthy: inventory.containers.filter(({ health }) => health === "unhealthy").length,
    containerRestarting: inventory.containers.filter(({ state }) => state === "restarting").length,
    stackTotal: inventory.stacks.length
  };
}

export const PORTAINER_MODEL_LIMITS = Object.freeze({
  maximumEnvironments: MAX_ENVIRONMENTS,
  maximumContainers: MAX_CONTAINERS,
  maximumStacks: MAX_STACKS
});
