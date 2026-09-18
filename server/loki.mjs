export const LOKI_ROUTE_IDS = Object.freeze([
  "ready",
  "buildInfo",
  "labels",
  "labelValues",
  "queryRange"
]);

export const LOKI_QUERY_LIMITS = Object.freeze({
  maximumQueryCodePoints: 4_096,
  maximumRangeNanoseconds: 86_400_000_000_000n,
  maximumLines: 500,
  defaultLines: 200,
  maximumStreams: 100,
  maximumLabelsPerStream: 32,
  maximumLabelNameCodePoints: 128,
  maximumLabelValueCodePoints: 512,
  maximumLineCodePoints: 4_096
});

const FIXED_ROUTES = Object.freeze({
  ready: "/ready",
  buildInfo: "/loki/api/v1/status/buildinfo",
  labels: "/loki/api/v1/labels"
});
const QUERY_KEYS = new Set(["query", "start", "end", "direction", "limit"]);
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DECIMAL_TIMESTAMP = /^(?:0|[1-9][0-9]{0,29})$/u;
const REDACTION = "[REDACTED]";

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

function ownKeys(value) {
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

function codePointLength(value) {
  return Array.from(value).length;
}

function truncateCodePoints(value, maximum) {
  const points = Array.from(value);
  return points.length <= maximum
    ? value
    : `${points.slice(0, maximum - 1).join("")}\u2026`;
}

function invalidQuery(message) {
  throw new TypeError(message);
}

function timestampNanoseconds(value, fieldName) {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (DECIMAL_TIMESTAMP.test(candidate)) return candidate;
    const milliseconds = Date.parse(candidate);
    if (Number.isFinite(milliseconds)) return (BigInt(milliseconds) * 1_000_000n).toString();
  }
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (Number.isFinite(milliseconds)) return (BigInt(milliseconds) * 1_000_000n).toString();
  }
  invalidQuery(`Loki ${fieldName} must be an RFC 3339 timestamp or a nanosecond timestamp string.`);
}

function normalizedLimit(value) {
  if (value === undefined) return LOKI_QUERY_LIMITS.defaultLines;
  const number = typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > LOKI_QUERY_LIMITS.maximumLines) {
    invalidQuery(`Loki query limit must be an integer from 1 to ${LOKI_QUERY_LIMITS.maximumLines}.`);
  }
  return number;
}

/**
 * Normalize the only query shape Helmsman permits for Loki's read-only
 * query_range capability. Unknown fields are rejected instead of ignored so a
 * future caller cannot accidentally smuggle upstream parameters through it.
 */
export function normalizeLokiQueryInput(body) {
  const source = record(body);
  const keys = source ? ownKeys(source) : null;
  if (!source || !keys || keys.some((key) => !QUERY_KEYS.has(key))) {
    invalidQuery("The Loki query contains unsupported fields.");
  }

  const rawQuery = own(source, "query");
  if (typeof rawQuery !== "string") invalidQuery("A Loki query is required.");
  const query = rawQuery.trim();
  if (!query
    || codePointLength(query) > LOKI_QUERY_LIMITS.maximumQueryCodePoints
    || /[\p{Cc}\p{Cf}\p{Cs}]/gu.test(query)) {
    invalidQuery(`Loki query must contain 1 to ${LOKI_QUERY_LIMITS.maximumQueryCodePoints} visible characters.`);
  }

  const start = timestampNanoseconds(own(source, "start"), "start");
  const end = timestampNanoseconds(own(source, "end"), "end");
  const startNanoseconds = BigInt(start);
  const endNanoseconds = BigInt(end);
  if (endNanoseconds < startNanoseconds) invalidQuery("Loki query end must not be before start.");
  if (endNanoseconds - startNanoseconds > LOKI_QUERY_LIMITS.maximumRangeNanoseconds) {
    invalidQuery("Loki queries are limited to a 24-hour time range.");
  }

  const rawDirection = own(source, "direction");
  const direction = rawDirection === undefined ? "backward" : rawDirection;
  if (direction !== "backward" && direction !== "forward") {
    invalidQuery("Loki query direction must be backward or forward.");
  }

  return Object.freeze({
    query,
    start,
    end,
    direction,
    limit: normalizedLimit(own(source, "limit"))
  });
}

function routeDenied(code, message, status) {
  return { allowed: false, code, message, status };
}

/**
 * Build one of Helmsman's fixed read-only Loki requests. This function accepts
 * capability identifiers, never caller-controlled paths.
 */
export function authorizeLokiRoute(routeIdValue, methodValue = "GET", parameters = {}) {
  const routeId = typeof routeIdValue === "string" ? routeIdValue : "";
  const source = record(parameters);
  let method;
  try {
    method = String(methodValue || "GET").toUpperCase();
  } catch {
    method = "";
  }
  if (method !== "GET") {
    return routeDenied(
      "METHOD_NOT_ALLOWED",
      "Loki access permits read-only GET requests only.",
      405
    );
  }
  if (!LOKI_ROUTE_IDS.includes(routeId)) {
    return routeDenied(
      "ROUTE_NOT_ALLOWED",
      "That Loki read-only capability is not allowed.",
      404
    );
  }

  let upstreamPathAndQuery;
  let labelName = null;
  let query = null;
  if (Object.hasOwn(FIXED_ROUTES, routeId)) {
    upstreamPathAndQuery = FIXED_ROUTES[routeId];
  } else if (routeId === "labelValues") {
    labelName = source ? own(source, "labelName") : undefined;
    if (typeof labelName !== "string" || !LABEL_NAME.test(labelName)) {
      return routeDenied(
        "ROUTE_NOT_ALLOWED",
        "The Loki label name is invalid.",
        404
      );
    }
    upstreamPathAndQuery = `/loki/api/v1/label/${encodeURIComponent(labelName)}/values`;
  } else {
    try {
      const candidate = source && record(own(source, "queryInput"))
        ? own(source, "queryInput")
        : source;
      query = normalizeLokiQueryInput(candidate);
    } catch {
      return routeDenied(
        "QUERY_NOT_ALLOWED",
        "The Loki range query is invalid or exceeds Helmsman's limits.",
        400
      );
    }
    const search = new URLSearchParams();
    search.set("query", query.query);
    search.set("start", query.start);
    search.set("end", query.end);
    search.set("direction", query.direction);
    search.set("limit", String(query.limit));
    upstreamPathAndQuery = `/loki/api/v1/query_range?${search.toString()}`;
  }

  const separator = upstreamPathAndQuery.indexOf("?");
  const upstreamPath = separator < 0
    ? upstreamPathAndQuery
    : upstreamPathAndQuery.slice(0, separator);
  return Object.freeze({
    allowed: true,
    service: "loki",
    routeId,
    ...(labelName === null ? {} : { labelName }),
    ...(query === null ? {} : query),
    method: "GET",
    upstreamPath,
    upstreamPathAndQuery,
    isArtwork: false,
    isLogin: false,
    internalOnly: true
  });
}

function redactLogText(value) {
  let text;
  try {
    text = String(value).normalize("NFKC");
  } catch {
    return "";
  }
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/</gu, "\u2039")
    .replace(/>/gu, "\u203a")
    .replace(/\b(Helmsman\s+setup\s+token\s*(?::|=|\bis\b)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      `$1${REDACTION}`)
    .replace(/\b((?:authorization|proxy-authorization)\s*(?::|=)\s*)(?:bearer|basic)\s+[^\s,;]+/giu,
      `$1${REDACTION}`)
    .replace(/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+/-]{4,}={0,2}/giu, `$1${REDACTION}`)
    .replace(/((?:["']?(?:x[-_ ]?api[-_ ]?key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|pwd|cookie|set-cookie)["']?)\s*(?::|=)\s*)(?:["'][^"']*["']|[^\s,;&}]+)/giu,
      `$1${REDACTION}`)
    .replace(/\s+/gu, " ")
    .trim();
}

function safeLabelValue(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const redacted = redactLogText(value);
  return redacted ? truncateCodePoints(redacted, LOKI_QUERY_LIMITS.maximumLabelValueCodePoints) : "";
}

function normalizedLabels(value) {
  const source = record(value);
  const keys = source ? ownKeys(source) : null;
  if (!source || !keys) return Object.freeze({});
  const labels = {};
  for (const key of keys) {
    if (Object.keys(labels).length >= LOKI_QUERY_LIMITS.maximumLabelsPerStream) break;
    if (!LABEL_NAME.test(key)
      || codePointLength(key) > LOKI_QUERY_LIMITS.maximumLabelNameCodePoints) continue;
    const labelValue = safeLabelValue(own(source, key));
    if (labelValue === null) continue;
    labels[key] = labelValue;
  }
  return Object.freeze(labels);
}

function normalizedTimestamp(value) {
  return typeof value === "string" && DECIMAL_TIMESTAMP.test(value) ? value : null;
}

/**
 * Reduce a Loki streams response to bounded, display-safe fields. Upstream
 * metadata and non-stream result types are deliberately discarded.
 */
export function normalizeLokiResponse(payload) {
  const source = record(payload);
  const data = record(own(source, "data"));
  const result = own(data, "result");
  if (!source
    || own(source, "status") !== "success"
    || !data
    || own(data, "resultType") !== "streams"
    || !Array.isArray(result)) {
    throw new TypeError("Invalid Loki streams response.");
  }

  const streams = [];
  let totalLines = 0;
  let truncated = result.length > LOKI_QUERY_LIMITS.maximumStreams;
  for (const rawStream of result.slice(0, LOKI_QUERY_LIMITS.maximumStreams)) {
    if (totalLines >= LOKI_QUERY_LIMITS.maximumLines) {
      truncated = true;
      break;
    }
    const stream = record(rawStream);
    const values = own(stream, "values");
    if (!stream || !Array.isArray(values)) continue;
    const normalizedValues = [];
    for (const rawEntry of values) {
      if (totalLines >= LOKI_QUERY_LIMITS.maximumLines) {
        truncated = true;
        break;
      }
      if (!Array.isArray(rawEntry) || rawEntry.length < 2) continue;
      const timestamp = normalizedTimestamp(rawEntry[0]);
      if (!timestamp || typeof rawEntry[1] !== "string") continue;
      const line = truncateCodePoints(
        redactLogText(rawEntry[1]),
        LOKI_QUERY_LIMITS.maximumLineCodePoints
      );
      normalizedValues.push(Object.freeze([timestamp, line]));
      totalLines += 1;
    }
    if (values.length > normalizedValues.length) truncated = true;
    if (!normalizedValues.length && values.length) continue;
    streams.push(Object.freeze({
      stream: normalizedLabels(own(stream, "stream")),
      values: Object.freeze(normalizedValues)
    }));
  }

  return Object.freeze({
    status: "success",
    data: Object.freeze({
      resultType: "streams",
      result: Object.freeze(streams)
    }),
    truncated
  });
}

function timestampIsoFromNanoseconds(value) {
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    if (!Number.isSafeInteger(milliseconds)) return null;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Normalize, globally order, and limit a Loki streams result. Loki groups
 * entries by stream, so flattening without this merge would not preserve the
 * requested chronological direction across multiple streams.
 */
export function normalizeLokiQueryResult(payload, options = {}) {
  const normalized = normalizeLokiResponse(payload);
  const direction = options.direction === undefined ? "backward" : options.direction;
  if (direction !== "backward" && direction !== "forward") {
    invalidQuery("Loki query direction must be backward or forward.");
  }
  const limit = normalizedLimit(options.limit);
  const entries = normalized.data.result.flatMap(({ stream, values }) => values.map(([timestampNs, line]) => ({
    timestampNs,
    timestamp: timestampIsoFromNanoseconds(timestampNs),
    line,
    labels: stream
  })));
  entries.sort((left, right) => {
    const first = BigInt(left.timestampNs);
    const second = BigInt(right.timestampNs);
    if (first === second) return 0;
    const ascending = first < second ? -1 : 1;
    return direction === "forward" ? ascending : -ascending;
  });
  const truncated = normalized.truncated || entries.length > limit;
  return Object.freeze({
    entries: Object.freeze(entries.slice(0, limit).map((entry) => Object.freeze(entry))),
    truncated
  });
}
