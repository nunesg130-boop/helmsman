// What happened over a period, worked out by Helmsman's code from its own
// event journal, so the agent never has to guess at history.
//
// The journal records each health incident when it opens or changes and
// when it recovers, with the same incident id. Pairing those gives each
// problem's start, end and duration. Actions and Helmsman's own restarts
// come from the same journal. Everything here is plain facts; the model
// only puts them into words.

const MAX_WINDOW_HOURS = 14 * 24;
const HOUR = 60 * 60 * 1_000;

/**
 * The period a question asks about, or null when it does not ask about one.
 * Understands "past/last N hours|days|weeks", "past hour/day/week", "24h",
 * "today", "yesterday", "last night", "overnight", "this week", and loose
 * words such as "lately" or "history" (the past 24 hours).
 */
export function questionWindow(text, now = Date.now(), timeZone = undefined) {
  const question = String(text || "").toLowerCase();
  const clamp = (hours) => Math.min(MAX_WINDOW_HOURS, Math.max(1, hours));
  const window = (hours, label) => ({ from: now - clamp(hours) * HOUR, to: now, label });
  const numbered = /\b(?:past|last|previous|over the|in the)\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w)\b/u.exec(question)
    || /\b(\d{1,3})\s*(hours?|hrs?|h|days?|d)\b(?!\s*(?:from now|ago))/u.exec(question);
  if (numbered) {
    const count = Number(numbered[1]);
    const unit = numbered[2];
    if (/^m/u.test(unit)) return window(Math.max(1, Math.ceil(count / 60)), `the past ${count} minutes`);
    const hours = /^(?:w|wk)/u.test(unit) ? count * 24 * 7 : /^d/u.test(unit) ? count * 24 : count;
    const unitLabel = /^(?:w|wk)/u.test(unit) ? "week" : /^d/u.test(unit) ? "day" : "hour";
    return window(hours, `the past ${count} ${unitLabel}${count === 1 ? "" : "s"}`);
  }
  if (/\b(?:past|last|previous)\s+(?:hour)\b/u.test(question)) return window(1, "the past hour");
  if (/\b(?:past|last|previous)\s+(?:day)\b/u.test(question)) return window(24, "the past day");
  if (/\b(?:past|last|previous|this)\s+week\b/u.test(question)) return window(24 * 7, "the past week");
  if (/\b(?:last night|overnight)\b/u.test(question)) return window(14, "overnight");
  const midnight = localMidnight(now, timeZone);
  if (/\byesterday\b/u.test(question)) return { from: midnight - 24 * HOUR, to: midnight, label: "yesterday" };
  if (/\b(?:today|this morning|this afternoon|so far)\b/u.test(question)) return { from: midnight, to: now, label: "today" };
  if (/\b(?:lately|recently|history|historically|been doing|been going|been like|been running|how has|how have|how's .* been|any (?:issues|problems|outages|downtime)|outages?|downtime|uptime)\b/u.test(question)) {
    return window(24, "the past 24 hours");
  }
  return null;
}

// Midnight today in the owner's time zone, as a timestamp.
function localMidnight(now, timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
    const elapsed = ((Number(parts.hour) % 24) * 3_600 + Number(parts.minute) * 60 + Number(parts.second)) * 1_000;
    return now - elapsed - (now % 1_000);
  } catch {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
}

function minutes(milliseconds) {
  const total = Math.max(1, Math.round(milliseconds / 60_000));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Total time covered by a set of intervals, overlaps counted once.
function unionLength(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total;
}

/**
 * Builds the summary. `healthEvents` and `actionEvents` are journal entries
 * (any order); `appEvents` are application.started/stopped entries;
 * `openIncidents` are the incidents open right now; `nameOf(serviceId)` gives
 * a display name; `format(iso)` a local time.
 */
export function buildHistory({ from, to, label: windowLabel, healthEvents = [], actionEvents = [], appEvents = [], openIncidents = [], monitored = [], nameOf = (id) => id, format = (iso) => iso, oldestEventAt = null }) {
  const incidents = new Map();
  for (const event of [...healthEvents].sort((left, right) => String(left.at).localeCompare(String(right.at)))) {
    if (event?.event !== "health_incident" || !event.targetId) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const incident = incidents.get(event.targetId) || { id: event.targetId, service: event.service, capability: event.capability, start: null, end: null, codes: new Set(), worst: "warn" };
    if (event.outcome === "recovered") incident.end = at;
    else {
      incident.start ??= at;
      if (event.level === "error") incident.worst = "error";
    }
    if (event.code) incident.codes.add(event.code);
    incidents.set(event.targetId, incident);
  }
  for (const open of openIncidents) {
    const id = open?.id;
    if (!id) continue;
    const incident = incidents.get(id) || { id, service: open.service, capability: open.capability, start: null, end: null, codes: new Set(), worst: "warn" };
    const first = open.firstSeen ?? open.openedAt ?? open.firstSeenAt;
    incident.start ??= (typeof first === "number" ? first : Date.parse(first || "")) || from;
    incident.end = null;
    incident.open = true;
    incidents.set(id, incident);
  }

  const byService = new Map();
  for (const incident of incidents.values()) {
    // Recovered with no opening in the window: it started before the window.
    const start = Math.max(from, incident.start ?? from);
    const end = Math.min(to, incident.end ?? to);
    if (end < from || start > to) continue;
    const entry = byService.get(incident.service) || { service: incident.service, episodes: [] };
    entry.episodes.push({ ...incident, start, end, ongoing: incident.end === null || incident.open === true });
    byService.set(incident.service, entry);
  }

  const lines = [`History for ${windowLabel} (${format(new Date(from).toISOString())} to ${format(new Date(to).toISOString())}), from Helmsman's own records:`];
  const services = [...byService.values()].map((entry) => ({
    ...entry,
    total: unionLength(entry.episodes.map(({ start, end }) => [start, end])),
    episodes: entry.episodes.sort((left, right) => right.start - left.start)
  })).sort((left, right) => right.total - left.total);
  if (!services.length) lines.push("- No problems were recorded for any monitored service.");
  for (const entry of services.slice(0, 8)) {
    const count = entry.episodes.length;
    const ongoing = entry.episodes.some(({ ongoing }) => ongoing);
    const latest = entry.episodes.slice(0, 3).map((episode) => {
      const what = [episode.capability, [...episode.codes][0]].filter(Boolean).join(" ");
      return `${format(new Date(episode.start).toISOString())}${episode.ongoing ? " until now (still open)" : `–${format(new Date(episode.end).toISOString()).replace(/^.*?, /u, "")}`}${what ? ` (${what})` : ""}`;
    });
    lines.push(`- ${nameOf(entry.service)}: ${count} problem${count === 1 ? "" : "s"}, ${minutes(entry.total)} in total${ongoing ? ", one still open" : ""}. ${count > 3 ? "Latest: " : ""}${latest.join("; ")}.`);
  }
  if (services.length > 8) lines.push(`- ${services.length - 8} more services also had problems.`);
  const quiet = monitored.filter((id) => !byService.has(id)).map(nameOf);
  if (services.length && quiet.length) lines.push(`- No problems: ${quiet.slice(0, 12).join(", ")}.`);

  const actions = actionEvents
    .filter((event) => Date.parse(event.at) >= from && Date.parse(event.at) <= to)
    .sort((left, right) => String(right.at).localeCompare(String(left.at)));
  if (actions.length) {
    const shown = actions.slice(0, 4).map((event) => `${String(event.operation || event.event || "action").replace(/[-_]/gu, " ")} ${event.targetType === "container" || event.targetType === "guest" ? "" : `${nameOf(event.service || "")} `}${event.targetId && event.targetId !== "all" && event.targetType !== "indexers" ? `${event.targetType || ""} ${event.targetId}`.trim() : ""}`.replace(/\s+/gu, " ").trim() + ` at ${format(event.at)}${event.outcome === "failed" ? " (failed)" : ""}`);
    lines.push(`- Actions taken: ${actions.length}. ${shown.join("; ")}.`);
  } else lines.push("- No actions were taken.");

  const restarts = appEvents.filter((event) => event.event === "application.started" && Date.parse(event.at) >= from && Date.parse(event.at) <= to);
  if (restarts.length) lines.push(`- Helmsman itself started ${restarts.length} time${restarts.length === 1 ? "" : "s"} (latest ${format(restarts.at(-1)?.at || restarts[0].at)}); it was not watching while it was stopped.`);
  if (oldestEventAt && Date.parse(oldestEventAt) > from + HOUR) lines.push(`- Records only go back to ${format(oldestEventAt)}, so the start of this period is not covered.`);
  return lines.join("\n");
}

/** Reads the journal for a window, page by page, within fixed bounds. */
export async function readWindow(events, { from, to, category, maxPages = 10 }) {
  const entries = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await events({ category, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 200, ...(cursor ? { cursor } : {}) });
    for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
      if (entry?.level !== "debug") entries.push(entry);
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return entries;
}
