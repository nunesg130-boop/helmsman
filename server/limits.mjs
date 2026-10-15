// Operator-adjustable capacity limits.
//
// Every value has a default equal to the limit Helmsman has always used, so an
// install that sets none of these variables behaves exactly as before. Each
// variable is bounded, and the combined total must fit the encrypted
// credential store, which reserves room for two copies of every connection's
// credentials during an atomic policy migration plus up to 64 browser
// sessions (see secrets.mjs MAX_SERVICES).
//
// Saved state is validated against the fixed STORED_LIMIT_CEILINGS below, not
// against the configured values, so lowering a limit never makes an existing
// /data volume fail to load. A lower limit only stops new records from being
// added until the count is back under it.

// Connections that hold credentials may total at most this many, which keeps
// two staged copies (112) plus 64 browser sessions (176) under the store's
// 192-namespace ceiling with 16 namespaces of recovery headroom.
export const CREDENTIAL_NAMESPACE_BUDGET = 56;

// Room reserved for media connections. The interface allows one connection per
// media service today; stored state may hold up to this many so that more than
// one instance of a service can be added later without another migration.
export const MEDIA_CONNECTION_RESERVE = 16;

const DEFINITIONS = Object.freeze({
  proxmoxEnvironments: {
    env: "HELMSMAN_MAX_PROXMOX_ENVIRONMENTS",
    default: 25,
    min: 1,
    max: 40,
    budget: false
  },
  proxmoxEndpoints: {
    env: "HELMSMAN_MAX_PROXMOX_ENDPOINTS",
    default: 25,
    min: 1,
    max: 40,
    budget: true
  },
  endpointsPerEnvironment: {
    env: "HELMSMAN_MAX_ENDPOINTS_PER_ENVIRONMENT",
    default: 4,
    min: 1,
    max: 8,
    budget: false
  },
  infrastructureServices: {
    env: "HELMSMAN_MAX_INFRASTRUCTURE_SERVICES",
    default: 8,
    min: 1,
    max: 24,
    budget: true
  },
  calendarPastDays: {
    env: "HELMSMAN_CALENDAR_PAST_DAYS",
    default: 1,
    min: 0,
    max: 14,
    budget: false
  },
  calendarFutureDays: {
    env: "HELMSMAN_CALENDAR_FUTURE_DAYS",
    default: 35,
    min: 7,
    max: 90,
    budget: false
  }
});

// The largest counts a stored state document may hold, whatever the current
// configuration says. These equal the variable ceilings above.
export const STORED_LIMIT_CEILINGS = Object.freeze({
  ...Object.fromEntries(Object.entries(DEFINITIONS).map(([key, definition]) => [key, definition.max])),
  mediaConnections: MEDIA_CONNECTION_RESERVE
});

export const DEFAULT_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([key, definition]) => [key, definition.default])
));

export class LimitConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LimitConfigurationError";
    this.code = "INVALID_LIMIT_CONFIGURATION";
  }
}

function parseValue(raw, definition) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return definition.default;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/u.test(text)) {
    throw new LimitConfigurationError(`${definition.env} must be a whole number from ${definition.min} to ${definition.max}.`);
  }
  const value = Number(text);
  if (value < definition.min || value > definition.max) {
    throw new LimitConfigurationError(`${definition.env} must be a whole number from ${definition.min} to ${definition.max}.`);
  }
  return value;
}

/**
 * Reads limits from an environment object (process.env by default). Throws
 * LimitConfigurationError with an operator-readable message when a value is
 * malformed, out of range, or the credential-bearing limits together exceed
 * the encrypted store's budget.
 */
export function resolveLimits(env = process.env) {
  const limits = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    limits[key] = parseValue(env?.[definition.env], definition);
  }
  const budgeted = Object.entries(DEFINITIONS).filter(([, definition]) => definition.budget);
  const total = budgeted.reduce((sum, [key]) => sum + limits[key], 0);
  const available = CREDENTIAL_NAMESPACE_BUDGET - MEDIA_CONNECTION_RESERVE;
  if (total > available) {
    const names = budgeted.map(([, definition]) => definition.env).join(" + ");
    throw new LimitConfigurationError(
      `${names} is ${total}; together they may be at most ${available}.`
    );
  }
  if (limits.endpointsPerEnvironment > limits.proxmoxEndpoints) {
    throw new LimitConfigurationError(
      "HELMSMAN_MAX_ENDPOINTS_PER_ENVIRONMENT cannot be larger than HELMSMAN_MAX_PROXMOX_ENDPOINTS."
    );
  }
  return Object.freeze(limits);
}

export const LIMIT_VARIABLES = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([key, definition]) => [key, definition.env])
));
