import { randomUUID } from "node:crypto";

export const HEALTH_STATES = Object.freeze([
  "healthy",
  "limited",
  "degraded",
  "down",
  "auth_required",
  "stale"
]);

export const CAPABILITY_IMPACTS = Object.freeze(["optional", "important", "critical"]);

const SNAPSHOT_VERSION = 1;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const FAILURE_STATES = new Set(["limited", "degraded", "down", "auth_required"]);
const AUTH_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTHENTICATION_REQUIRED",
  "CREDENTIALS_REJECTED",
  "FORBIDDEN",
  "TOKEN_EXPIRED",
  "UNAUTHORIZED"
]);
const STATE_PRIORITY = Object.freeze({
  healthy: 0,
  limited: 1,
  stale: 2,
  degraded: 3,
  auth_required: 4,
  down: 5
});
const BLOCKING_STATES = new Set(["stale", "degraded", "auth_required", "down"]);

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeIdentifier(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim().toLowerCase();
  if (!IDENTIFIER.test(normalized)) {
    throw new TypeError(`${label} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  return normalized;
}

function capabilityKey(service, capability) {
  return `${service}/${capability}`;
}

function normalizeReference(value, label = "Capability dependency") {
  if (typeof value === "string") {
    const separator = value.indexOf("/");
    if (separator < 1 || separator === value.length - 1 || value.indexOf("/", separator + 1) !== -1) {
      throw new TypeError(`${label} must use the service/capability form.`);
    }
    const service = normalizeIdentifier(value.slice(0, separator), `${label} service`);
    const capability = normalizeIdentifier(value.slice(separator + 1), `${label} name`);
    return { service, capability, key: capabilityKey(service, capability) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must name a service and capability.`);
  }
  const service = normalizeIdentifier(value.service, `${label} service`);
  const capability = normalizeIdentifier(value.capability, `${label} name`);
  return { service, capability, key: capabilityKey(service, capability) };
}

function normalizeImpact(value = "important") {
  if (!CAPABILITY_IMPACTS.includes(value)) {
    throw new TypeError(`Capability impact must be one of: ${CAPABILITY_IMPACTS.join(", ")}.`);
  }
  return value;
}

function normalizeCode(value) {
  if (value === undefined || value === null || value === "") return "CHECK_FAILED";
  const raw = String(value).trim();
  // Error messages, URLs, and opaque values do not belong in the incident
  // identity. Requiring a conventional symbolic error code is deliberately
  // stricter than attempting to redact arbitrary upstream text.
  if (!/^[a-z][a-z0-9_.-]{0,63}$/iu.test(raw)
    || /[a-z0-9]{20,}/iu.test(raw)) {
    return "CHECK_FAILED";
  }
  return raw.toUpperCase();
}

function normalizeHttpStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "string" && /^\d{3}$/u.test(value) ? Number(value) : value;
  return Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
}

function normalizeLatency(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), 86_400_000);
}

function normalizeDuration(value, fallback, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 31_536_000_000) {
    throw new TypeError(`${label} must be a positive integer no greater than one year.`);
  }
  return selected;
}

function normalizeTimestamp(value, fallback) {
  const numeric = value === undefined
    ? fallback
    : value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : value;
  if (!Number.isFinite(numeric) || Math.abs(numeric) > 8_640_000_000_000_000) {
    throw new TypeError("checkedAt must be a valid date or timestamp.");
  }
  return Math.round(numeric);
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function stateForFailure({ impact, code, status, authRequired, state }) {
  if (state !== undefined) {
    if (!FAILURE_STATES.has(state)) {
      throw new TypeError("A failed result state must be limited, degraded, down, or auth_required.");
    }
    return state;
  }
  if (authRequired === true || status === 401 || status === 403 || AUTH_CODES.has(code)) {
    return "auth_required";
  }
  if (impact === "optional") return "limited";
  if (impact === "critical") return "down";
  return "degraded";
}

function safeSummary(service, capability, state, code, status) {
  const name = `${service} ${capability}`;
  if (state === "healthy") return `${name} is healthy.`;
  if (state === "stale") return `${name} has not reported recently.`;
  if (state === "auth_required") return `${name} requires authentication.`;
  return `${name} check reported ${code}${status === null ? "" : ` (${status})`}.`;
}

function sortByIdentity(left, right) {
  return `${left.service}/${left.capability}`.localeCompare(`${right.service}/${right.capability}`);
}

function worstState(states) {
  let selected = "healthy";
  for (const state of states) {
    if (STATE_PRIORITY[state] > STATE_PRIORITY[selected]) selected = state;
  }
  return selected;
}

/**
 * Tracks capability-level health and turns repeated failures into deduplicated
 * incidents. The engine intentionally stores only a strict, safe field set;
 * arbitrary upstream errors, response bodies, URLs, and credentials are never
 * copied into a snapshot.
 */
export class HealthIncidentEngine {
  #capabilities = new Map();
  #activeIncidents = new Map();
  #recentRecoveries = [];
  #recentTransitions = [];
  #dependencyState = new Map();
  #now;
  #idFactory;
  #failureThreshold;
  #defaultStaleAfterMs;
  #maxHistory;
  #onTransition;
  #onDependencyChange;

  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Health engine options must be an object.");
    }
    this.#now = typeof options.now === "function" ? options.now : Date.now;
    this.#idFactory = typeof options.idFactory === "function" ? options.idFactory : randomUUID;
    this.#failureThreshold = options.failureThreshold === undefined ? 2 : options.failureThreshold;
    if (!Number.isSafeInteger(this.#failureThreshold) || this.#failureThreshold < 1 || this.#failureThreshold > 20) {
      throw new TypeError("failureThreshold must be an integer from 1 through 20.");
    }
    this.#defaultStaleAfterMs = normalizeDuration(
      options.staleAfterMs,
      5 * 60_000,
      "staleAfterMs"
    );
    this.#maxHistory = options.maxHistory === undefined ? 100 : options.maxHistory;
    if (!Number.isSafeInteger(this.#maxHistory) || this.#maxHistory < 1 || this.#maxHistory > 10_000) {
      throw new TypeError("maxHistory must be an integer from 1 through 10000.");
    }
    this.#onTransition = typeof options.onTransition === "function" ? options.onTransition : null;
    this.#onDependencyChange = typeof options.onDependencyChange === "function"
      ? options.onDependencyChange
      : null;

    for (const definition of options.capabilities || []) this.registerCapability(definition);
    for (const dependency of options.dependencies || []) {
      const target = normalizeReference(dependency, "Dependency target");
      this.setDependencies(target, dependency.dependsOn || []);
    }
  }

  registerCapability(definition) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError("Capability definition must be an object.");
    }
    const service = normalizeIdentifier(definition.service, "Capability service");
    const capability = normalizeIdentifier(definition.capability, "Capability name");
    const key = capabilityKey(service, capability);
    const now = normalizeTimestamp(undefined, this.#now());
    const current = this.#capabilities.get(key);
    const dependsOn = definition.dependsOn === undefined
      ? current?.dependsOn || []
      : this.#normalizeDependencies(key, definition.dependsOn);
    const record = current || {
      service,
      capability,
      registeredAt: now,
      state: "stale",
      lastCheckedAt: null,
      latencyMs: null,
      code: null,
      status: null,
      consecutiveFailures: 0,
      pending: null,
      activeIncidentKey: null
    };
    record.impact = normalizeImpact(definition.impact ?? current?.impact ?? "important");
    record.staleAfterMs = normalizeDuration(
      definition.staleAfterMs,
      current?.staleAfterMs ?? this.#defaultStaleAfterMs,
      "Capability staleAfterMs"
    );
    record.dependsOn = dependsOn;
    this.#capabilities.set(key, record);
    this.#refreshDependencyHooks(now);
    return safeClone(this.#capabilityView(record));
  }

  setDependencies(targetValue, dependencyValues) {
    const target = normalizeReference(targetValue, "Dependency target");
    const record = this.#capabilities.get(target.key) || this.#registerReference(target);
    record.dependsOn = this.#normalizeDependencies(target.key, dependencyValues);
    this.#refreshDependencyHooks(normalizeTimestamp(undefined, this.#now()));
    return safeClone(this.#capabilityView(record));
  }

  retireService(serviceValue, at = this.#now()) {
    const service = normalizeIdentifier(serviceValue, "Retired service");
    const timestamp = normalizeTimestamp(at, this.#now());
    let retired = 0;
    for (const [key, record] of this.#capabilities) {
      if (record.service !== service) continue;
      if (record.activeIncidentKey) this.#resolve(record, timestamp, "retired");
      this.#capabilities.delete(key);
      this.#dependencyState.delete(key);
      retired += 1;
    }
    if (retired) this.#refreshDependencyHooks(timestamp);
    return retired;
  }

  recordResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TypeError("Capability result must be an object.");
    }
    if (typeof result.ok !== "boolean") throw new TypeError("Capability result ok must be a boolean.");
    const service = normalizeIdentifier(result.service, "Capability service");
    const capability = normalizeIdentifier(result.capability, "Capability name");
    const key = capabilityKey(service, capability);
    const checkedAt = normalizeTimestamp(result.checkedAt, this.#now());
    const record = this.#capabilities.get(key) || this.#registerReference({ service, capability, key }, checkedAt);
    if (result.impact !== undefined) record.impact = normalizeImpact(result.impact);
    if (result.staleAfterMs !== undefined) {
      record.staleAfterMs = normalizeDuration(result.staleAfterMs, record.staleAfterMs, "Capability staleAfterMs");
    }
    if (result.dependsOn !== undefined) record.dependsOn = this.#normalizeDependencies(key, result.dependsOn);
    record.lastCheckedAt = checkedAt;
    record.latencyMs = normalizeLatency(result.latencyMs);

    const transitionStart = this.#recentTransitions.at(-1)?.sequence || 0;
    if (result.ok) this.#recordSuccess(record, checkedAt);
    else this.#recordFailure(record, result, checkedAt);
    this.#refreshDependencyHooks(checkedAt);

    return safeClone({
      capability: this.#capabilityView(record),
      transitions: this.#recentTransitions.filter(({ sequence }) => sequence > transitionStart)
    });
  }

  observe(result) {
    return this.recordResult(result);
  }

  sweepStale(at = this.#now()) {
    const timestamp = normalizeTimestamp(at, this.#now());
    let changed = 0;
    for (const record of this.#capabilities.values()) {
      if (record.activeIncidentKey && record.state !== "stale") continue;
      const lastEvidence = record.lastCheckedAt ?? record.registeredAt;
      if (timestamp - lastEvidence < record.staleAfterMs || record.state === "stale" && record.activeIncidentKey) {
        continue;
      }
      record.pending = null;
      const failure = {
        key: this.#incidentKey(record.service, record.capability, "STALE", null),
        code: "STALE",
        status: null,
        state: "stale",
        impact: record.impact
      };
      this.#activate(record, failure, timestamp, 1, lastEvidence + record.staleAfterMs);
      changed += 1;
    }
    this.#refreshDependencyHooks(timestamp);
    return changed;
  }

  snapshot(options = {}) {
    const at = normalizeTimestamp(options.at, this.#now());
    if (options.applyStaleness !== false) this.sweepStale(at);
    const capabilities = [...this.#capabilities.values()].sort(sortByIdentity);
    const serviceGroups = new Map();
    for (const record of capabilities) {
      if (!serviceGroups.has(record.service)) serviceGroups.set(record.service, []);
      serviceGroups.get(record.service).push(record);
    }
    const services = [...serviceGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([id, records]) => {
        const views = records.map((record) => this.#capabilityView(record));
        const lastChecked = records.reduce(
          (latest, record) => Math.max(latest, record.lastCheckedAt ?? 0),
          0
        );
        return {
          id,
          state: worstState(views.map(({ state }) => state)),
          lastCheckedAt: lastChecked ? iso(lastChecked) : null,
          activeIncidentCount: views.filter(({ activeIncident }) => activeIncident).length,
          capabilities: views
        };
      }
    );
    const incidents = [...this.#activeIncidents.values()]
      .map((incident) => this.#incidentView(incident))
      .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
    const state = services.length ? worstState(services.map((service) => service.state)) : "stale";
    const affectedServiceCount = services.filter((service) => service.state !== "healthy").length;
    const dependencies = capabilities
      .filter(({ dependsOn }) => dependsOn.length)
      .map((record) => ({
        service: record.service,
        capability: record.capability,
        dependsOn: record.dependsOn.map((key) => this.#referenceView(key)),
        blockedBy: this.#blockedBy(record)
      }));

    return safeClone({
      version: SNAPSHOT_VERSION,
      generatedAt: iso(at),
      overall: {
        state,
        activeIncidentCount: incidents.length,
        affectedServiceCount
      },
      services,
      incidents,
      recentRecoveries: this.#recentRecoveries.toReversed(),
      recentTransitions: this.#recentTransitions.toReversed(),
      dependencies
    });
  }

  #registerReference(reference, at = normalizeTimestamp(undefined, this.#now())) {
    const record = {
      service: reference.service,
      capability: reference.capability,
      registeredAt: at,
      impact: "important",
      staleAfterMs: this.#defaultStaleAfterMs,
      dependsOn: [],
      state: "stale",
      lastCheckedAt: null,
      latencyMs: null,
      code: null,
      status: null,
      consecutiveFailures: 0,
      pending: null,
      activeIncidentKey: null
    };
    this.#capabilities.set(reference.key, record);
    return record;
  }

  #normalizeDependencies(targetKey, values) {
    if (!Array.isArray(values)) throw new TypeError("Capability dependencies must be an array.");
    const unique = new Set();
    for (const value of values) {
      const dependency = normalizeReference(value);
      if (dependency.key === targetKey) throw new TypeError("A capability cannot depend on itself.");
      unique.add(dependency.key);
    }
    return [...unique].sort();
  }

  #recordSuccess(record, checkedAt) {
    record.consecutiveFailures = 0;
    record.pending = null;
    record.state = "healthy";
    record.code = null;
    record.status = null;
    if (record.activeIncidentKey) this.#resolve(record, checkedAt, "recovered");
  }

  #recordFailure(record, result, checkedAt) {
    const code = normalizeCode(result.code);
    const status = normalizeHttpStatus(result.status ?? result.httpStatus);
    const state = stateForFailure({
      impact: record.impact,
      code,
      status,
      authRequired: result.authRequired,
      state: result.state
    });
    const key = this.#incidentKey(record.service, record.capability, code, status);
    const failure = { key, code, status, state, impact: record.impact };
    record.consecutiveFailures += 1;

    if (record.activeIncidentKey === key) {
      record.pending = null;
      this.#updateActive(record, failure, checkedAt);
      return;
    }

    if (record.pending?.key === key) {
      record.pending.count += 1;
      record.pending.lastSeen = checkedAt;
      record.pending.failure = failure;
    } else {
      record.pending = {
        key,
        count: 1,
        firstSeen: checkedAt,
        lastSeen: checkedAt,
        failure
      };
    }

    if (record.pending.count < this.#failureThreshold) return;
    const pending = record.pending;
    record.pending = null;
    this.#activate(record, failure, checkedAt, pending.count, pending.firstSeen);
  }

  #activate(record, failure, checkedAt, occurrences, firstSeen) {
    if (record.activeIncidentKey && record.activeIncidentKey !== failure.key) {
      this.#resolve(record, checkedAt, "superseded");
    }
    if (record.activeIncidentKey === failure.key) {
      this.#updateActive(record, failure, checkedAt);
      return;
    }

    const incident = {
      id: String(this.#idFactory()),
      key: failure.key,
      service: record.service,
      capability: record.capability,
      state: failure.state,
      impact: failure.impact,
      code: failure.code,
      status: failure.status,
      firstSeen,
      lastSeen: checkedAt,
      occurrenceCount: occurrences
    };
    this.#activeIncidents.set(failure.key, incident);
    record.activeIncidentKey = failure.key;
    record.state = failure.state;
    record.code = failure.code;
    record.status = failure.status;
    this.#emitTransition("opened", incident, checkedAt, null);
  }

  #updateActive(record, failure, checkedAt) {
    const incident = this.#activeIncidents.get(failure.key);
    if (!incident) {
      record.activeIncidentKey = null;
      this.#activate(record, failure, checkedAt, 1, checkedAt);
      return;
    }
    const previousState = incident.state;
    incident.lastSeen = checkedAt;
    incident.occurrenceCount += 1;
    incident.impact = failure.impact;
    incident.state = failure.state;
    record.state = failure.state;
    record.code = failure.code;
    record.status = failure.status;
    if (STATE_PRIORITY[failure.state] > STATE_PRIORITY[previousState]) {
      this.#emitTransition("escalated", incident, checkedAt, previousState);
    } else if (STATE_PRIORITY[failure.state] < STATE_PRIORITY[previousState]) {
      this.#emitTransition("deescalated", incident, checkedAt, previousState);
    }
  }

  #resolve(record, checkedAt, reason) {
    const incident = this.#activeIncidents.get(record.activeIncidentKey);
    record.activeIncidentKey = null;
    if (!incident) return;
    this.#activeIncidents.delete(incident.key);
    if (reason === "recovered") {
      const recovery = {
        id: incident.id,
        key: incident.key,
        service: incident.service,
        capability: incident.capability,
        state: "healthy",
        previousState: incident.state,
        impact: incident.impact,
        code: incident.code,
        status: incident.status,
        summary: safeSummary(incident.service, incident.capability, "healthy", null, null),
        firstSeen: iso(incident.firstSeen),
        lastSeen: iso(incident.lastSeen),
        recoveredAt: iso(checkedAt),
        occurrenceCount: incident.occurrenceCount
      };
      this.#recentRecoveries.push(recovery);
      this.#trim(this.#recentRecoveries);
    }
    this.#emitTransition(reason, incident, checkedAt, incident.state);
  }

  #incidentKey(service, capability, code, status) {
    return `${service}/${capability}/${code}/${status === null ? "-" : status}`;
  }

  #incidentView(incident) {
    const record = this.#capabilities.get(capabilityKey(incident.service, incident.capability));
    return {
      id: incident.id,
      key: incident.key,
      service: incident.service,
      capability: incident.capability,
      state: incident.state,
      impact: incident.impact,
      code: incident.code,
      status: incident.status,
      summary: safeSummary(
        incident.service,
        incident.capability,
        incident.state,
        incident.code,
        incident.status
      ),
      firstSeen: iso(incident.firstSeen),
      lastSeen: iso(incident.lastSeen),
      occurrenceCount: incident.occurrenceCount,
      blockedBy: record ? this.#blockedBy(record) : []
    };
  }

  #capabilityView(record) {
    const pending = record.pending;
    return {
      name: record.capability,
      state: record.state,
      impact: record.impact,
      lastCheckedAt: record.lastCheckedAt === null ? null : iso(record.lastCheckedAt),
      latencyMs: record.latencyMs,
      staleAfterMs: record.staleAfterMs,
      consecutiveFailures: record.consecutiveFailures,
      pendingFailure: pending
        ? {
            count: pending.count,
            threshold: this.#failureThreshold,
            code: pending.failure.code,
            status: pending.failure.status,
            firstSeen: iso(pending.firstSeen),
            lastSeen: iso(pending.lastSeen)
          }
        : null,
      code: record.code,
      status: record.status,
      activeIncident: record.activeIncidentKey !== null,
      dependsOn: record.dependsOn.map((key) => this.#referenceView(key)),
      blockedBy: this.#blockedBy(record)
    };
  }

  #referenceView(key) {
    const [service, capability] = key.split("/");
    return { service, capability };
  }

  #blockedBy(record) {
    return record.dependsOn.flatMap((key) => {
      const dependency = this.#capabilities.get(key);
      if (!dependency) {
        const reference = this.#referenceView(key);
        return [{ ...reference, state: "stale", missing: true }];
      }
      if (!BLOCKING_STATES.has(dependency.state)) return [];
      return [{
        service: dependency.service,
        capability: dependency.capability,
        state: dependency.state,
        missing: false
      }];
    });
  }

  #refreshDependencyHooks(at) {
    for (const record of this.#capabilities.values()) {
      if (!record.dependsOn.length) continue;
      const key = capabilityKey(record.service, record.capability);
      const blockedBy = this.#blockedBy(record);
      const fingerprint = JSON.stringify(blockedBy);
      if (this.#dependencyState.get(key) === fingerprint) continue;
      this.#dependencyState.set(key, fingerprint);
      if (!this.#onDependencyChange) continue;
      const event = safeClone({
        type: "dependency_changed",
        at: iso(at),
        service: record.service,
        capability: record.capability,
        blocked: blockedBy.length > 0,
        blockedBy
      });
      try {
        const returned = this.#onDependencyChange(event);
        if (returned && typeof returned.catch === "function") returned.catch(() => {});
      } catch {
        // Observability hooks must never break health processing.
      }
    }
  }

  #emitTransition(type, incident, at, previousState) {
    const event = {
      sequence: (this.#recentTransitions.at(-1)?.sequence || 0) + 1,
      type,
      at: iso(at),
      incidentId: incident.id,
      key: incident.key,
      service: incident.service,
      capability: incident.capability,
      state: type === "recovered" ? "healthy" : incident.state,
      previousState,
      impact: incident.impact,
      code: incident.code,
      status: incident.status,
      occurrenceCount: incident.occurrenceCount
    };
    this.#recentTransitions.push(event);
    this.#trim(this.#recentTransitions);
    if (!this.#onTransition) return;
    try {
      const returned = this.#onTransition(safeClone(event));
      if (returned && typeof returned.catch === "function") returned.catch(() => {});
    } catch {
      // Observability hooks must never break health processing.
    }
  }

  #trim(collection) {
    if (collection.length > this.#maxHistory) collection.splice(0, collection.length - this.#maxHistory);
  }
}

export function createHealthIncidentEngine(options) {
  return new HealthIncidentEngine(options);
}
