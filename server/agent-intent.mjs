// What a question to the agent is about, worked out by code, so the right
// facts are looked up for the model before it answers.
//
// Small local models rarely call tools by themselves and tend to repeat
// whatever background they are given. So each question gets only the
// lookups it needs: the owner's manual for addresses and procedures, never
// for "is X up" or "why is X down"; indexer, container and queue lists when
// the question is about those; one service's own status when it names one.

import { matchByName, NAME_ALIASES } from "./agent-tools.mjs";

export { HELMSMAN_HELP } from "./agent-help.mjs";

const MANUAL = /\b(?:ip|ips|address(?:es)?|subnet|gateway|dns|vlan|mac|hostname|ports?|where (?:is|are|does|do|did|can)|how (?:do|to|should|can|did) i|how do you|procedure|runbook|notes?|manual|documented|docs|steps|which hosts?|serial|model number|password policy|backup(?:s)? (?:stored|go|location))\b/u;
const HELP = /\b(?:helmsman|helmy|training|conversations?|rate|rating|fix answer|debug|logs?|logging|export|refresh|approve|approval|connections?|settings|holding alerts|alerts held)\b/u;
const INDEXERS = /\b(?:indexers?|trackers?)\b/u;
const WORKLOADS = /\b(?:containers?|vms?|virtual machines?|lxcs?|guests?|nodes?|stopped|running|vpn|gluetun|memory|ram|cpu|busiest|uptime|been up|what'?s on|running on|docker)\b/u;
const MEDIA = /\b(?:download(?:ing|s|ed)?|queue|stuck|stalled|imports?|imported|requests?|requested|upcoming|coming out|releases?|subtitles?|eta|finish(?:ed)?|added recently)\b/u;

/** Which lookups a question needs. */
export function questionSeeds(text) {
  const question = String(text || "").toLowerCase();
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
  const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word && !STOP.has(word));
  for (const word of words) {
    if (word.length < 4 && NAME_ALIASES[word] === undefined) continue;
    const ids = [...new Set(matchByName(pairs, word, (pair) => pair.name).map((pair) => pair.id))];
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
