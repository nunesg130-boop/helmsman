// What a question asks that Helmsman cannot see, worked out by code.
//
// The system prompt lists what Helmsman doesn't record, but a small model
// reads that once and then answers from whatever lookup is in front of it:
// asked "which backup storage holds Kasm's backups?" it named one; asked
// "has norco's memory climbed today?" it said "no" from the current reading.
// So each question that touches one of these gets one plain note, beside its
// lookups, naming exactly what is missing and what to give instead.

import { normalizeQuestion } from "./agent-intent.mjs";

const BACKUP = /\b(?:backups?|backed up|restore points?|vzdump)\b/u;
const GUEST_WORDS = /\b(?:vms?|lxcs?|guests?|containers?|nodes?|docker)\b/u;
const METRIC = /\b(?:cpu|memory|ram|load|usage|resources?|utili[sz]ation|consumption|pressure)\b/u;
const PAST = /\b(?:peaks?|maximum|average|avg|trends?|over time|spikes?|spiked|climb\w*|increas\w*|grew|grow\w*|rose|risen|chang\w*|drop(?:ped|s)?|doubled|since|yesterday|overnight|this (?:week|month|morning)|last (?:day|week|hour|night|month)|past (?:day|week|hour|month|\d+ (?:hours|days))|history|historical|previous sample)\b/u;
const START_EVENTS = /\b(?:re)?start(?:ed|s)?\b|\breboot\w*|\bboot(?:ed|s)?\b|\bstops?\b|\bstate (?:changes?|transitions?)|\btransitions?\b|\bchang\w* (?:its )?power state\b|\brecreat\w*|\bcame (?:back )?up\b/u;
const WHEN = /\b(?:when|last|latest|most recent(?:ly)?|history|how many|times|today|yesterday|this (?:week|month)|past|since|ever|before|during|counts?)\b/u;

/**
 * The things a question asks that Helmsman doesn't see, as short phrases,
 * each with what it can give instead. Empty when the question is answerable.
 */
export function untrackedTopics(text, names = []) {
  const question = normalizeQuestion(text).toLowerCase();
  // A guest, container or node named in the question counts as one of those words.
  const words = new Set(question.split(/[^a-z0-9._-]+/u));
  const namesThing = GUEST_WORDS.test(question) || names.some((name) => words.has(String(name || "").toLowerCase()));
  const topics = [];
  const add = (key, phrase) => { if (!topics.some((topic) => topic.key === key)) topics.push({ key, phrase }); };
  if (BACKUP.test(question)) {
    if (/\b(?:jobs?|schedul\w*|skipped|excluded|exclusions?|tonight|configured|included? in)\b/u.test(question)) {
      add("backup-jobs", "backup jobs and schedules, so which guests a job includes, excludes or skipped");
    }
    if (/\b(?:storage|stored|locations?|where (?:would|are|is|do)|kept|targets?|unavailable)\b/u.test(question)) {
      add("backup-storage", "where backups are stored or whether a backup storage is available (your manual's notes may say where they go)");
    }
    if (/\b(?:files?|cop(?:y|ies)|restore points?|how many (?:retained )?(?:backups|restore points|copies)|backups (?:are available|belong|exist)|only one|older (?:restore points?|guest names?|names?)|previous (?:run|backups?|inventory)|deleted|unknown|disappeared|under (?:an|another|a different)|named)\b/u.test(question)) {
      add("backup-files", "backup files, how many backups exist, or older restore points");
    }
    if (/\b(?:sizes?|bytes|protected|verif\w*|warnings?|tasks?|stuck|locks?|metadata|contain\w*|includes? (?:all|its)|disks?|mount points?|configuration|stopped for|remained running|while .{0,30}running|start time|completion time|exact time)\b/u.test(question)) {
      add("backup-details", "backup task details: sizes, warnings, verification, protection, locks, running tasks, what a backup contains, exact start or finish times, or whether a guest was stopped for it");
    }
  }
  if (/\b(?:restart (?:counts?|polic(?:y|ies))|oom|out of memory|exit codes?|recreat\w*)\b/u.test(question)) {
    add("container-restarts", "Docker restart counts, restart policies, OOM flags or when a container was recreated; a stopped container's exit code is shown in its status");
  }
  const imageTags = /\b(?:images?|tagged latest|latest tag)\b/u.test(question);
  if (/\b(?:start(?:s|ed)? (?:at|on) boot|autostart\w*|automatic(?:ally)? start\w*|automatic startup|onboot|descriptions?|network interfaces?|nics?|(?:more than one|multiple|extra|additional) (?:disks?|interfaces?)|disk layout|mount points?|bind mounts?)\b/u.test(question)
    || (!imageTags && /\btags?\b/u.test(question) && namesThing)) {
    add("guest-config", "guest settings such as start at boot, tags, descriptions, network interfaces, disks or mount points (your manual's notes may mention some)");
  }
  if (/\b(?:ip|ips|ipv4|ipv6|address(?:es)?)\b/u.test(question) && /\b(?:reported|report|inventory|have|has|got|any|no|without|missing|live|guest data)\b/u.test(question)) {
    add("guest-ips", "guest IP addresses: its live readings have none, so any address comes only from your manual");
  }
  if (METRIC.test(question) && PAST.test(question) && !/\b(?:right now|currently|at the moment)\b/u.test(question.replace(/\btoday\b/u, ""))) {
    add("metric-history", "CPU, memory or disk usage over time: it keeps only the current reading, so no peaks, averages, trends, spikes or earlier values");
  }
  if (/\b(?:disk|root|filesystem|file system|storage|drive) (?:usage|use|space)|disk space|root (?:fs|filesystem|disk)|filesystem|how full\b/u.test(question) && !BACKUP.test(question)) {
    add("disk-usage", "disk or filesystem usage of nodes, guests or containers");
  }
  if (START_EVENTS.test(question) && WHEN.test(question) && (namesThing || /\b(?:it|its)\b/u.test(question))
    && !/\b(?:most recent(?:ly)?|least recent(?:ly)?|longest|shortest) (?:re)?start/u.test(question)) {
    add("start-history", "a start, stop or restart history for guests, containers or nodes: it sees only each one's current state and uptime, the time since it last started");
  }
  if (/\b(?:quorum|qdevice|q-device|votes?|corosync)\b/u.test(question)) {
    add("quorum", "quorum, votes or the QDevice, which is not a monitored node (your manual's notes describe the cluster's votes)");
  }
  if (/\bversions?\b/u.test(question) && /\bnodes?\b|\b(?:same|each|both|per)\b/u.test(question) && namesThing) {
    add("node-version", "a Proxmox version per node: it reports one version for the whole Proxmox environment");
  }
  return topics;
}

/** The note itself, or "" when the question asks nothing Helmsman can't see. */
export function untrackedNote(text, names = [], { skip = [] } = {}) {
  const topics = untrackedTopics(text, names).filter((topic) => !skip.includes(topic.key));
  if (!topics.length) return "";
  return `What this question asks that Helmsman cannot see, worked out by Helmsman: ${topics.map((topic) => topic.phrase).join("; ")}. `
    + "Say that plainly first (\"Helmsman doesn't see …\"), then give what the lookups do show that bears on the question. "
    + "Never answer \"none\", \"no\" or \"yes\" about these as if you had checked.";
}

/** Whether a backup question asks about something beyond each guest's latest result and age. */
export function asksUntrackedBackup(text, names = []) {
  return untrackedTopics(text, names).some((topic) => topic.key.startsWith("backup-"));
}

/**
 * "When did Main last boot?", "when did semaphore last start?": the date
 * each named node or guest last started, worked out from its uptime. Models
 * said "Helmsman doesn't track that" with "up 14d" in front of them, or
 * subtracted 14 days wrong.
 */
export function startDates(snapshot, text, now, timeZone) {
  const question = String(text || "").toLowerCase();
  const said = (name) => {
    const lower = String(name || "").toLowerCase();
    return lower.length >= 3 && new RegExp(`(^|[^a-z0-9])${lower.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^a-z0-9])`, "u").test(question);
  };
  const date = (seconds) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(now - seconds * 1000));
  const items = [];
  for (const environment of snapshot?.infrastructure?.environments || []) {
    for (const node of environment.nodes || []) {
      if (said(node.name) && Number.isFinite(node.uptimeSeconds) && node.uptimeSeconds > 0) items.push(`node ${node.name} about ${date(node.uptimeSeconds)}`);
    }
    for (const guest of environment.workloads || []) {
      if (guest.template || !said(guest.name)) continue;
      const label = `${guest.name} (${guest.type === "lxc" ? "LXC" : "VM"} ${guest.vmid})`;
      if (guest.status === "running" && Number.isFinite(guest.uptimeSeconds) && guest.uptimeSeconds > 0) items.push(`${label} about ${date(guest.uptimeSeconds)}`);
      else if (guest.status !== "running") items.push(`${label} is ${guest.status}, so it has no current start`);
    }
  }
  return items.length ? `Last started, worked out by Helmsman from uptime (it can't tell a restart from a first start, and keeps no earlier starts): ${items.slice(0, 6).join("; ")}.` : "";
}
