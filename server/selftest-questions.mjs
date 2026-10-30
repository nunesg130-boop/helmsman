// Self-test question generator. Pure: reads the inventory snapshot it is given
// and nothing else (no network, no disk). A seed fixes wording and order.
import { createHash } from "node:crypto";

import { containerHostNames, containerStackNames } from "./agent-tools.mjs";

export const CATEGORIES = Object.freeze(["guest-lookup", "ranking", "node", "containers", "neighbours", "backups", "history", "manual", "services", "follow-up", "unknowable"]);

const MAX_TEXT = 1000;
const MAX_NAME = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Small seeded generator: the same seed always walks the same sequence. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedNumber(seed) {
  if (Number.isFinite(Number(seed))) return Number(seed) >>> 0;
  return createHash("sha256").update(String(seed)).digest().readUInt32BE(0);
}

const clean = (name) => String(name).replace(CONTROL, " ").slice(0, MAX_NAME).trim();
const nonEmpty = (value) => typeof value === "string" && clean(value) !== "";

function fill(pattern, args) {
  return pattern.replace(/\{(\d)\}/gu, (_, index) => args[Number(index)] ?? "");
}

function finish(text) {
  return text.replace(CONTROL, " ").replace(/ {2,}/gu, " ").trim().slice(0, MAX_TEXT);
}

/** What the snapshot holds, reduced to the names and facts templates need. */
function facts(snapshot) {
  const environments = Array.isArray(snapshot?.infrastructure?.environments) ? snapshot.infrastructure.environments : [];
  const nodes = [];
  const guests = [];
  for (const environment of environments) {
    for (const node of environment?.nodes || []) if (nonEmpty(node?.name)) nodes.push(clean(node.name));
    for (const workload of environment?.workloads || []) {
      if (workload?.template || !nonEmpty(workload?.name)) continue;
      guests.push({
        name: clean(workload.name),
        kind: workload.type === "lxc" ? "LXC" : "VM",
        vmid: Number.isFinite(Number(workload.vmid)) ? Number(workload.vmid) : null
      });
    }
  }
  const counts = new Map();
  for (const guest of guests) counts.set(guest.name.toLowerCase(), (counts.get(guest.name.toLowerCase()) || 0) + 1);
  for (const guest of guests) {
    // Same-named guests can only be told apart by number.
    guest.ref = counts.get(guest.name.toLowerCase()) > 1 && guest.vmid !== null ? `${guest.name} ${guest.kind} ${guest.vmid}` : guest.name;
  }
  const containers = (snapshot?.infrastructure?.portainer || []).flatMap((server) => server?.inventory?.containers || [])
    .filter((container) => nonEmpty(container?.name))
    .map((container) => ({ name: clean(container.name), stack: nonEmpty(container.stack) ? clean(container.stack) : "" }));
  const services = (Array.isArray(snapshot?.services) ? snapshot.services : [])
    .map((service) => (nonEmpty(service?.label) ? service.label : service?.id)).filter(nonEmpty).map(clean);
  return {
    nodes: [...new Set(nodes)],
    guests,
    containers: [...new Map(containers.map((container) => [container.name.toLowerCase(), container])).values()],
    hosts: containerHostNames(snapshot).filter(nonEmpty).map(clean),
    stacks: containerStackNames(snapshot).filter(nonEmpty).map(clean),
    services: [...new Set(services)]
  };
}

/* Wordings: terse, lowercase, typo-light and full-sentence, as the owner asks. {0}/{1} are names. */
const W = {
  guestNode: ["which node is {0} on?", "what node hosts {0}", "where does {0} run in proxmox?", "Which node is {0} running on?"],
  guestId: ["what's the vmid of {0}?", "which guest id does {0} have", "What is the VM ID for {0}?"],
  guestRunning: ["is {0} running?", "is {0} up right now", "Is {0} currently running or stopped?"],
  guestMemory: ["how much memory does {0} have?", "how much ram is {0} using", "What is {0}'s memory usage?"],
  guestKind: ["is {0} a vm or an lxc?", "is {0} a container or a vm", "What type of guest is {0}?"],
  rankMemory: ["which guest uses the most memory?", "rank guests by memory usage", "Which guest has the least free memory?"],
  rankCpu: ["which guest has the highest cpu?", "rank the guests by cpu usage", "Which VM is using the most CPU right now?"],
  rankUptime: ["which guest has been up the longest?", "rank guests by uptime", "Which guest restarted most recently?"],
  rankSize: ["which guest has the most memory assigned?", "rank guests by size", "Which guest has the most cores?"],
  rankBackup: ["which guest has the oldest backup?", "rank guests by backup age", "Which guest's latest backup is the oldest?"],
  rankNode: ["which guest on {0} uses the most memory?", "what's the busiest guest on {0}", "Which guest on {0} has the highest CPU?"],
  nodeFree: ["how much memory is free on {0}?", "how much ram is left on node {0}", "How much free memory does {0} have?"],
  nodeCount: ["how many guests are on {0}?", "what guests run on {0}", "List the guests on node {0}."],
  nodeOnline: ["is {0} online?", "is node {0} up", "Is the {0} node online right now?"],
  nodeUptime: ["how long has {0} been up?", "what's the uptime of {0}", "What is node {0}'s uptime?"],
  nodeCores: ["how many cores does {0} have?", "how many cpu cores on node {0}", "How many CPU cores does {0} have?"],
  containerPort: ["what port does {0} use?", "which ports is the {0} container publishing", "What port is {0} listening on?"],
  containerImage: ["which image is {0} running?", "what image does the {0} container use", "What Docker image is {0} using?"],
  containerStack: ["which stack is {0} in?", "what compose stack does {0} belong to", "Which stack does the {0} container belong to?"],
  containerState: ["is {0} healthy?", "is the {0} container running", "Is {0} running or stopped?"],
  containerHost: ["which docker host is {0} on?", "what host runs the {0} container", "Where is the {0} container running?"],
  hostList: ["what containers run on {0}?", "list the containers on {0}", "Which containers are running on {0}?"],
  stackList: ["which containers are in the {0} stack?", "what's in the {0} stack", "List the containers in the {0} stack."],
  containersStopped: ["which containers are stopped?", "any containers not running", "Which containers are stopped or unhealthy?"],
  neighbourGuest: ["what else is on the same node as {0}?", "which guests share a node with {0}", "What other guests run on the same node as {0}?"],
  neighbourContainer: ["what else runs on the same host as {0}?", "which containers share a docker host with {0}", "What other containers run on the same Docker host as {0}?"],
  backupLast: ["when was {0} last backed up?", "last backup for {0}?", "When did {0} last get backed up?"],
  backupHas: ["does {0} have a backup?", "is {0} backed up", "Is there a backup for {0}?"],
  backupRecent: ["is {0}'s backup recent?", "was {0} backed up this week", "Does {0} have a backup from the last week?"],
  backupNone: ["which guests have no backup?", "what isnt backed up", "Which guests have no backup listed?"],
  historyWeek: ["did anything go down in the last week?", "any incidents this week", "Were there any outages in the past week?"],
  historyService: ["when did {0} last go down?", "has {0} had any outages", "When was {0}'s most recent failure?"],
  historyRecent: ["any incidents recently?", "what went wrong lately", "What was the most recent incident?"],
  manualService: ["what is {0} for?", "what do my notes say about {0}", "What does the manual say about {0}?"],
  manualGuest: ["what do my notes say about {0}?", "what is {0} used for", "What do my notes associate with {0}?"],
  serviceUp: ["is {0} up?", "how's {0} doing", "Is {0} healthy right now?"],
  serviceBad: ["which services are unhealthy?", "is anything down", "Are any services down right now?"],
  followNode: ["which node is {0} on?", "what node hosts {0}"],
  followBackup: ["when was {0} last backed up?", "last backup for {0}?"],
  followPort: ["what port does {0} use?", "which port is {0} on"],
  followService: ["is {0} up?", "how's {0} doing"],
  followShort: ["and {0}?", "what about {0}?", "how about {0}"]
};

const UNKNOWABLE = [
  "do I have any snapshots on my guests?",
  "how many snapshots are older than a month?",
  "how much free storage capacity is left on the nas?",
  "what's the total capacity of my nas?",
  "does my network have ipv6 enabled?",
  "which ipv6 addresses are in use here?",
  "what mount points do my guests have?",
  "where is the nas mounted?",
  "what was the cpu peak last night?",
  "what was the peak cpu usage this week?"
];

/** Every possible question as a unit: one question, or a base plus its follow-up. */
function units(snapshot, rng) {
  const { nodes, guests, containers, hosts, stacks, services } = facts(snapshot);
  const out = [];
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const make = (template, category, pattern, ...args) => {
    const wording = pick(W[pattern] || [pattern]);
    const text = finish(fill(wording, args));
    return {
      id: `q-${createHash("sha256").update(JSON.stringify([template, args, wording])).digest("hex").slice(0, 12)}`,
      category,
      text
    };
  };
  const single = (question) => out.push([{ ...question, followUp: false }]);
  const pair = (base, follow) => out.push([{ ...base, followUp: false }, { ...follow, followUp: true }]);

  for (const guest of guests) {
    single(make("guestNode", "guest-lookup", "guestNode", guest.ref));
    single(make("guestId", "guest-lookup", "guestId", guest.ref));
    single(make("guestRunning", "guest-lookup", "guestRunning", guest.ref));
    single(make("guestMemory", "guest-lookup", "guestMemory", guest.ref));
    single(make("guestKind", "guest-lookup", "guestKind", guest.ref));
    single(make("neighbourGuest", "neighbours", "neighbourGuest", guest.ref));
    single(make("backupLast", "backups", "backupLast", guest.ref));
    single(make("backupHas", "backups", "backupHas", guest.ref));
    single(make("backupRecent", "backups", "backupRecent", guest.ref));
    single(make("manualGuest", "manual", "manualGuest", guest.ref));
  }
  if (guests.length) {
    for (const key of ["rankMemory", "rankCpu", "rankUptime", "rankSize", "rankBackup"]) single(make(key, "ranking", key));
    single(make("backupNone", "backups", "backupNone"));
  }
  for (const node of nodes) {
    single(make("nodeFree", "node", "nodeFree", node));
    single(make("nodeCount", "node", "nodeCount", node));
    single(make("nodeOnline", "node", "nodeOnline", node));
    single(make("nodeUptime", "node", "nodeUptime", node));
    single(make("nodeCores", "node", "nodeCores", node));
    if (guests.length) single(make("rankNode", "ranking", "rankNode", node));
  }
  for (const container of containers) {
    single(make("containerPort", "containers", "containerPort", container.name));
    single(make("containerImage", "containers", "containerImage", container.name));
    single(make("containerState", "containers", "containerState", container.name));
    single(make("containerHost", "containers", "containerHost", container.name));
    single(make("neighbourContainer", "neighbours", "neighbourContainer", container.name));
    if (container.stack) single(make("containerStack", "containers", "containerStack", container.name));
  }
  if (containers.length) single(make("containersStopped", "containers", "containersStopped"));
  for (const host of hosts) single(make("hostList", "containers", "hostList", host));
  for (const stack of stacks) single(make("stackList", "containers", "stackList", stack));
  if (services.length || guests.length) {
    single(make("historyWeek", "history", "historyWeek"));
    single(make("historyRecent", "history", "historyRecent"));
  }
  for (const service of services) {
    single(make("historyService", "history", "historyService", service));
    single(make("manualService", "manual", "manualService", service));
    single(make("serviceUp", "services", "serviceUp", service));
  }
  if (services.length) single(make("serviceBad", "services", "serviceBad"));

  // Follow-ups: the next entity of the same kind, asked with the previous answer as history.
  const followPairs = (list, key, followKey, label) => list.forEach((item, index) => {
    const other = list[(index + 1) % list.length];
    if (list.length < 2 || other === item) return;
    pair(make(key, "follow-up", followKey, label(item)), make(`${key}+follow`, "follow-up", "followShort", label(other)));
  });
  followPairs(guests, "followNode", "followNode", (guest) => guest.ref);
  followPairs(guests, "followBackup", "followBackup", (guest) => guest.ref);
  followPairs(containers, "followPort", "followPort", (container) => container.name);
  followPairs(services, "followService", "followService", (service) => service);

  // Things Helmsman does not hold. Never mention an inventory name, so a
  // wording that happens to contain one is dropped.
  const names = [...nodes, ...guests.map((guest) => guest.name), ...containers.map((container) => container.name), ...hosts, ...stacks, ...services]
    .map((name) => name.toLowerCase()).filter((name) => name.length >= 2);
  if (out.length) {
    for (const text of UNKNOWABLE) {
      const lower = text.toLowerCase();
      if (names.some((name) => lower.includes(name))) continue;
      const wording = text;
      out.push([{ id: `q-${createHash("sha256").update(JSON.stringify(["unknowable", [], wording])).digest("hex").slice(0, 12)}`, category: "unknowable", text: finish(text), followUp: false }]);
    }
  }
  return out;
}

/**
 * Questions for the owner's lab, in a seed-determined order. A follow-up comes
 * straight after its base question and both count toward `count`. Ids are
 * stable per template, arguments and wording; ids in `exclude` are skipped.
 */
export function generateQuestions(snapshot, { seed = 1, count = 50, exclude = new Set() } = {}) {
  const rng = mulberry32(seedNumber(seed));
  const all = units(snapshot || {}, rng);
  for (let i = all.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  const limit = Math.max(0, Math.floor(Number(count)) || 0);
  const seenIds = new Set();
  const seenText = new Set();
  const result = [];
  for (const unit of all) {
    if (result.length >= limit) break;
    if (result.length + unit.length > limit) continue;
    // A follow-up means nothing without its base, so the pair goes together or not at all.
    if (unit.some((question) => skip.has(question.id) || seenIds.has(question.id) || seenText.has(question.text) || !question.text)) continue;
    for (const question of unit) {
      seenIds.add(question.id);
      seenText.add(question.text);
      result.push(question);
    }
  }
  return result;
}
