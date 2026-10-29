// What a question to the agent is about, worked out by code, so the right
// facts are looked up for the model before it answers.
//
// Small local models rarely call tools by themselves and tend to repeat
// whatever background they are given. So each question gets only the
// lookups it needs: the owner's manual for addresses and procedures, never
// for "is X up" or "why is X down"; indexer, container and queue lists when
// the question is about those; one service's own status when it names one.

import { containerHostNames, matchByName, NAME_ALIASES, workloadNames } from "./agent-tools.mjs";

export { HELMSMAN_HELP } from "./agent-help.mjs";

const MANUAL = /\b(?:ip|ips|address(?:es)?|subnet|gateway|dns|vlan|mac|hostname|ports?|where (?:is|are|does|do|did|can)|how (?:do|to|should|can|did) i|how do you|procedure|runbook|notes?|manual|documented|docs|steps|which hosts?|serial|model number|password policy|backup(?:s)? (?:stored|go|location)|hardware|specs?|layout|topology|wiring|cabling|vlans?|motherboard|what (?:cpu|gpu)|which (?:cpu|gpu)|drives?|disks?|what (?:runs|is running|is) on (?:vm|lxc|ct)|used for|purpose of|role of|what does \S+(?: \S+)? do|what (?:is|'s) \S+(?: \S+)? for|qdevice|quorum|corosync)\b/u;
const HELP = /\b(?:helmsman|helmy|training|conversations?|rate|rating|fix answer|debug|logs?|logging|export|refresh|approve|approval|connections?|settings|holding alerts|alerts held)\b/u;
const INDEXERS = /\b(?:indexers?|trackers?)\b/u;
const WORKLOADS = /\b(?:containers?|vms?|virtual machines?|lxcs?|guests?|nodes?|stopped|running|vpn|gluetun|memory|ram|cpu|busiest|busy|uptime|been up|online|what'?s on|running on|docker|backed up|backups?|last backup)\b/u;
const MEDIA = /\b(?:download(?:ing|s|ed)?|queue|stuck|stalled|imports?|imported|requests?|requested|upcoming|coming out|comes? out|releases?|episodes?|premieres?|air(?:s|ing)?|subtitles?|eta|finish(?:ed)?|added recently)\b/u;

/**
 * Two-word spellings of one name made into one word, so they can be matched:
 * "pi hole" is pihole, "home assistant" is homeassistant.
 */
export function normalizeQuestion(text) {
  return String(text || "")
    .replace(/\bpi[\s-]+hole\b/giu, "pihole")
    .replace(/\bhome[\s-]+assistant(?:[\s-]+os)?\b/giu, "homeassistant");
}

/** Which lookups a question needs. */
export function questionSeeds(text) {
  const question = normalizeQuestion(text).toLowerCase();
  return {
    manual: MANUAL.test(question),
    help: HELP.test(question) && /\b(?:how|where|what|can|turn|download|which)\b/u.test(question),
    indexers: INDEXERS.test(question),
    workloads: WORKLOADS.test(question),
    media: MEDIA.test(question)
  };
}

const STOP = new Set(("a an and any are as at be been can could did do does for from get go has have how i in is it its me my of on or "
  + "our please the their them then there this to up was we what whats when where which who why will with would you your "
  + "ok okay check status running working healthy down up broken good fine doing look looks right now today still again "
  + "about all every everything anything thing things server servers service services container containers vm vms lxc lxcs "
  + "guest guests node nodes client clients app apps reachable connected online offline restart restarted reboot rebooted").split(" "));

/**
 * Ids of the monitored services a question names, by name, nickname or a
 * near-miss spelling ("sonar", "qbitorent"), at most `limit`. A Proxmox
 * environment is also named by its nodes. Ordinary short words never count
 * as a name ("see" is not Seerr); nicknames such as "qb" or "pve" do.
 */
export function namedServices(snapshot, text, limit = 2) {
  const items = [
    ...(snapshot?.services || []).map((service) => ({ id: service.id, names: [service.id, service.label] })),
    ...(snapshot?.infrastructure?.environments || []).map((item) => ({
      id: item.id,
      names: [item.displayName, "proxmox", ...(item.nodes || []).map((node) => node?.name)]
    })),
    ...(snapshot?.infrastructure?.services || []).map((item) => ({ id: item.id, names: [item.displayName, item.type] }))
  ];
  const pairs = items.flatMap((item) => item.names.filter((name) => typeof name === "string" && name).map((name) => ({ id: item.id, name })));
  const found = [];
  const words = normalizeQuestion(text).toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word && !STOP.has(word));
  for (const word of words) {
    if (word.length < 4 && NAME_ALIASES[word] === undefined) continue;
    const matched = matchByName(pairs, word, (pair) => pair.name);
    // "port" is not Portainer, unless something is named exactly that.
    if (COMMON_WORDS.has(word) && !matched.some((pair) => pair.name.toLowerCase().replace(/[^a-z0-9]/gu, "") === word)) continue;
    const ids = [...new Set(matched.map((pair) => pair.id))];
    if (ids.length === 1 && !found.includes(ids[0])) found.push(ids[0]);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * Nicknames in a question that name something other than a monitored
 * service, such as "vpn" for a gluetun container, as plain hints.
 */
export function nicknameHints(text) {
  const hints = [];
  for (const word of String(text || "").toLowerCase().split(/[^a-z0-9]+/u)) {
    const target = NAME_ALIASES[word];
    if (target && target !== word && !hints.some((hint) => hint.word === word)) hints.push({ word, target });
  }
  return hints.slice(0, 3);
}

const KIND_WORDS = [
  [/\b(?:containers?|docker|portainer)\b/u, "containers"],
  [/\b(?:vms?|virtual machines?)\b/u, "vms"],
  [/\b(?:lxcs?)\b/u, "lxcs"],
  [/\b(?:nodes?)\b/u, "nodes"]
];

/**
 * Guest IDs a question names: "VM 109", "LXC 110", "guest 151", "CT 105",
 * "guest IDs 100, 102 and 104", or a name with its number ("docker 201").
 * Only numbers that are real guests.
 */
export function guestIds(snapshot, text) {
  const guests = (snapshot?.infrastructure?.environments || []).flatMap((environment) => (environment.workloads || []).filter((workload) => !workload.template));
  const known = new Set(guests.map((workload) => String(workload.vmid)));
  const question = String(text || "").toLowerCase();
  const ids = [];
  const add = (id) => { if (known.has(id) && !ids.includes(id)) ids.push(id); };
  const pattern = /\b(?:vms?|lxcs?|cts?|guests?|guest ids?|ids?|vmids?)\s*#?\s*(\d{2,9}(?:\s*(?:,|&|and|or)\s*(?:and\s+|or\s+)?\d{2,9})*)/gu;
  for (const match of question.matchAll(pattern)) for (const id of match[1].match(/\d+/gu)) add(id);
  // "docker 201", "caddy 105": a guest's own name right before its number.
  for (const match of question.matchAll(/([a-z0-9][a-z0-9._-]*)(?:\s+(?:vm|lxc|ct))?\s+#?(\d{2,9})\b/gu)) {
    if (guests.some((workload) => String(workload.vmid) === match[2] && String(workload.name || "").toLowerCase() === match[1])) add(match[2]);
  }
  return ids;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Ordinary words that start or nearly spell a container name ("work" in
// authentik-worker-1, "agent" in portainer_agent, "port" in portainer):
// they count only when they are the whole name.
const COMMON_WORDS = new Set(("agent agents auth base broker data form forms handle handler host hosts load port ports post proxy "
  + "server site socket tech test web work worker working").split(" "));

// Nicknames that are as good as the name: "home assistant" for haos-17.2.
const NICKNAME_WORDS = new Set(["homeassistant", "hass", "haos"]);

// "Docker" followed by one of these is about containers or their hosts, not
// a VM named docker: "which Docker host has gluetun".
const DOCKER_PHRASE = /\bdocker\s+(?:hosts?|environments?|inventory|workloads?|containers?|stacks?|compose|images?|services?|networks?|volumes?|endpoints?|connections?|side)\b/u;

/** What the question's words name, in order: guests, containers, nodes; exact names apart from near ones. */
function namedInQuestion(snapshot, question, { workloadWords, namesOnly }) {
  const names = workloadNames(snapshot);
  const loose = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/gu, "");
  const nodes = new Set((snapshot?.infrastructure?.environments || []).flatMap((environment) => (environment.nodes || []).map((node) => String(node?.name || "").toLowerCase())).filter(Boolean));
  // Everything answered by its own status: media services, Proxmox and
  // Portainer themselves, by name, type or nickname ("jelly", "portainer").
  const services = new Set([
    ...(snapshot?.services || []).flatMap((service) => [service.id, service.label]),
    ...(snapshot?.infrastructure?.environments || []).flatMap((item) => [item.displayName, "proxmox"]),
    ...(snapshot?.infrastructure?.services || []).flatMap((item) => [item.displayName, item.type])
  ].filter((name) => typeof name === "string" && name).map((name) => name.toLowerCase()));
  const words = question.split(/[^a-z0-9._-]+/u).map((word) => word.replace(/^[._-]+|[._-]+$/gu, "")).filter((word) => word && !STOP.has(word));
  const candidates = [...words, ...nicknameHints(question).map(({ target }) => target)];
  const found = [];
  for (const word of candidates) {
    if (word.length < 4 && NAME_ALIASES[word] === undefined) continue;
    // A node by its exact name ("list everything on Main", "is norco busy")
    // is that node and its guests, even when it also names the Proxmox
    // environment. Not for address questions, which the manual answers.
    if (nodes.has(word)) {
      if (!namesOnly && !found.some((item) => item.node === word)) found.push({ node: word });
      continue;
    }
    // "Which host is radarr on": the container's line says, even though
    // Radarr also has a status of its own.
    const asService = services.has(word) || services.has(NAME_ALIASES[word]);
    if (!workloadWords && !namesOnly && asService) continue;
    // "docker containers" means containers, even with a VM named docker.
    if (word === "docker" && (/\bcontainers?\b/u.test(question) || DOCKER_PHRASE.test(question))) continue;
    const matches = [...new Set(matchByName(names, word, (name) => name))].filter((name) => !nodes.has(name.toLowerCase()));
    if (!matches.length) continue;
    // Several that share the word ("paperless-db-1", "paperless-webserver-1"):
    // show them all by filtering on the word itself.
    if (matches.length > 1 && !matches.every((name) => name.toLowerCase().includes(word))) continue;
    const name = matches.length === 1 ? matches[0] : word;
    if (services.has(name.toLowerCase()) && !workloadWords && !namesOnly) continue;
    const exact = matches.some((match) => loose(match) === loose(word) || loose(match) === loose(NAME_ALIASES[word])) || NICKNAME_WORDS.has(word);
    if (!exact && COMMON_WORDS.has(word)) continue;
    if (!found.some((item) => item.name && item.name.toLowerCase() === name.toLowerCase())) found.push({ name, exact });
  }
  return found;
}

const MEASURES = [
  ["backups", /\b(?:backed up|last backup|backups?)\b/u],
  ["memory", /\b(?:memory|ram|gb)\b/u],
  ["cpu", /\b(?:cpu|vcpus?|cores?|busiest|busy|busier|load|active|activity|idle|quiet(?:est)?|least work|doing the least)\b/u]
];

/** The measures a question asks to rank by, in the order it names them, with "vms"/"lxcs" when it says only one kind. */
function measuresIn(question) {
  const vms = /\b(?:vms?|virtual machines?)\b/u.test(question);
  const lxcs = /\blxcs?\b/u.test(question);
  const only = vms && !lxcs ? " vms" : lxcs && !vms ? " lxcs" : "";
  // About nodes alone ("is norco busy", "node cpu"), not guests: the node's lines answer it.
  const nodesOnly = /\bnodes?\b/u.test(question) && !/\b(?:guests?|vms?|lxcs?)\b/u.test(question);
  return MEASURES
    .filter(([metric, pattern]) => pattern.test(question)
      && !(metric === "backups" && /\b(?:stored|where|location|kept)\b/u.test(question))
      && !(metric !== "backups" && nodesOnly))
    .map(([metric, pattern]) => ({ filter: `${metric}${only}`, at: question.search(pattern) }))
    .sort((left, right) => left.at - right.at)
    .map(({ filter }) => filter);
}

// Questions about a whole container's details, answered for every container
// in short form: "which containers publish ports", "images tagged latest".
const CONTAINER_DETAILS = [
  ["ports", /\b(?:ports?|published|publish(?:es|ing)?|expos(?:e|es|ed|ing))\b/u],
  ["images", /\b(?:images?|tags?|tagged|ghcr|linuxserver|registry|repository|repositories)\b/u],
  ["stacks", /\b(?:stacks?|compose)\b/u],
  ["uptime", /\b(?:uptime|up for|been up|started|recreated|created|restarted)\b/u]
];

/**
 * Whether a question needs the VM, LXC and container list, and how to narrow
 * it: one workload's full details when the question names one ("is gluetun
 * running", or "vpn" for gluetun), one kind when it names a kind ("which
 * containers are stopped"), otherwise everything in compact form. Returns
 * null when the question is not about workloads. A name that is also a
 * monitored service ("is sonarr up") is left to that service's own status
 * unless the question asks about its container or VM.
 */
export function workloadQuery(snapshot, text, options = {}) {
  return workloadQueries(snapshot, text, options)[0] || null;
}

/**
 * The same, but every thing a question names, up to four: "is seerr or
 * wizarr using more CPU" gets both lines, where one lookup answered only
 * for the first name and the model said the second wasn't there.
 */
export function workloadQueries(snapshot, text, { workloadWords = false, namesOnly = false } = {}) {
  const question = normalizeQuestion(text).toLowerCase();
  // Portainer hosts named in full ("Main Docker", "PVE-2", "Jelly-Arr"):
  // their containers, before any single word of one ("main") is read as a node.
  let rest = question;
  const hosts = [];
  for (const name of containerHostNames(snapshot).sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(name.toLowerCase())}(?=$|[^a-z0-9])`, "u");
    if (pattern.test(rest)) {
      hosts.push(name);
      rest = rest.replace(pattern, "$1 ");
    }
  }
  // "VM 109", "guest IDs 100, 102 and 104", "docker 201": those guests by number.
  const ids = guestIds(snapshot, question);
  const named = namedInQuestion(snapshot, rest, { workloadWords, namesOnly });
  const nodes = named.filter((item) => item.node).map((item) => item.node);
  // A near match ("handle" for palmetto-tech-form-handler) is dropped when
  // the question also names something exactly or by number.
  const sure = ids.length || named.some((item) => item.name && item.exact);
  // A name already covered by the IDs ("docker VM 201") isn't looked up again for both dockers.
  const idNames = new Set((snapshot?.infrastructure?.environments || []).flatMap((environment) => (environment.workloads || []))
    .filter((workload) => ids.includes(String(workload.vmid))).map((workload) => String(workload.name || "").toLowerCase()));
  const things = named.filter((item) => item.name && (item.exact || !sure) && !idNames.has(item.name.toLowerCase())).map((item) => item.name);
  if (hosts.length && !namesOnly && !ids.length && !things.length) return hosts.slice(0, 2).map((filter) => ({ filter }));
  // "Rank the VMs on norco by CPU", "backups on Main": the ranking for that
  // node only, sorted by code, not that node's lines in inventory order.
  // "How much RAM is installed in Main" is about the node itself.
  const measures = workloadWords && !namesOnly ? measuresIn(question) : [];
  const aboutNode = /\b(?:installed|physical|hardware|capacity|chassis|motherboard|node'?s? (?:cpu|memory|ram|load))\b/u.test(question);
  if (measures.length && nodes.length === 1 && !things.length && !ids.length && !hosts.length && !aboutNode) {
    return measures.slice(0, 2).map((measure) => ({ filter: `${measure} ${nodes[0]}` }));
  }
  const hostFilters = namesOnly ? [] : hosts.filter((host) => !things.some((thing) => thing.toLowerCase() === host.toLowerCase()));
  const filters = [...ids, ...things, ...hostFilters];
  if (filters.length) {
    // "Where does ollama rank for memory": its line and the ranking.
    const ranking = /\b(?:rank(?:s|ed|ing)?|top|highest|lowest|most|least|busiest|order|sit|outrank)\b/u.test(question.replace(/\bmost recent(?:ly)?\b/gu, ""));
    return [...filters.slice(0, 4), ...(ranking && filters.length === 1 ? measures.slice(0, 1) : [])].map((filter) => ({ filter }));
  }
  if (nodes.length) return nodes.slice(0, 2).map((filter) => ({ filter }));
  if (!workloadWords || namesOnly) return [];
  // "Which VM uses the most memory", "what hasn't been backed up": every
  // guest ranked by that number, only VMs or only LXCs when the question
  // says so; two measures when it names two ("most RAM among those with no
  // backup"). Where backups are stored is a manual question.
  if (measures.length) return measures.slice(0, 2).map((filter) => ({ filter }));
  // Container details asked for every container: ports, images, stacks, uptime.
  const containers = /\b(?:containers?|docker|portainer)\b/u.test(question);
  const detail = containers ? CONTAINER_DETAILS.find(([, pattern]) => pattern.test(question)) : null;
  if (detail) return [{ filter: `containers ${detail[0]}` }];
  for (const [pattern, kind] of KIND_WORDS) if (pattern.test(question)) return [{ filter: kind }];
  return [{ filter: "" }];
}

/** Whether a lookup names one thing ("seerr", "109") rather than a kind or a ranking. */
export function namesSomething(query) {
  const filter = String(query?.filter || "").toLowerCase();
  return Boolean(filter) && !/^(?:containers?|vms|lxcs|nodes|memory|cpu|backups)\b/u.test(filter);
}

/**
 * The question with multi-part guest and host names taken out
 * ("Jelly-Arr status" becomes " status"), for finding the services it names:
 * "jelly" inside "Jelly-Arr" is the VM, not a nickname for Jellyfin.
 */
export function withoutWorkloadNames(snapshot, text) {
  let question = String(text || "");
  // Not node names: "pve-1" names its Proxmox environment.
  const nodes = new Set((snapshot?.infrastructure?.environments || []).flatMap((environment) => (environment.nodes || []).map((node) => node?.name)));
  const names = [...workloadNames(snapshot), ...containerHostNames(snapshot)]
    .filter((name) => !nodes.has(name) && /[^A-Za-z0-9]/u.test(name))
    .sort((left, right) => right.length - left.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    question = question.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "giu"), "$1 ");
  }
  return question;
}

/**
 * A short reply that continues the previous question: "and main?", "what
 * about radarr?", "is it healthy?", "which was the longest?". Thanks and
 * acknowledgements are not.
 */
export function isFollowUp(text) {
  const question = String(text || "").trim().toLowerCase();
  if (!question || /^(?:ok(?:ay)?|thanks?|thank you|ty|cool|great|nice|never ?mind|nvm|got it|lol)\b/u.test(question)) return false;
  const words = question.split(/\s+/u).length;
  return /^(?:and|also|what about|how about|same for|is it|are they|which|why|when|how long|is that)\b/u.test(question) || words <= 4;
}

/** Two sets of lookups combined. */
export function mergeSeeds(left, right) {
  if (!right) return left;
  return Object.fromEntries(Object.keys(left).map((key) => [key, Boolean(left[key] || right[key])]));
}
