// In-depth logging on top of the event journal.
//
// Normal level: what Helmsman always logged (milestones), plus errors with
// their full message and stack, and a summary of each agent run.
// Debug level, switched on from Settings for a few hours at a time: also
// every health check, every request to a connected service with its timing,
// and each model and tool call the agent makes.
//
// Everything goes through the journal, which scrubs secrets from free text.
// Request and response bodies and headers are never logged.

import { describeErrorForLog, redactLogRoute, redactLogText } from "./log-redaction.mjs";

export const DIAGNOSTICS_LIMITS = Object.freeze({
  defaultDebugHours: 4,
  maximumDebugHours: 24,
  debugEventsPerMinute: 1_200,
  outputLines: 2_000,
  outputLineChars: 500
});

const SOURCE = /^[a-z][a-z0-9-]{0,31}$/u;
const SERVICE = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;
const CODE = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;

function pick(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function status(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

// ---------------------------------------------------------- server output --

// What Helmsman writes to stdout and stderr, kept in memory so the Logs page
// can show it. `docker logs` keeps the full history; this is the recent tail.
const output = [];
let outputSequence = 0;
let outputInstalled = false;

function scrubOutputLine(line) {
  // The one-time setup token is printed for the owner's terminal only.
  const withoutSetupToken = String(line).replace(/(setup token:\s*)\S+/giu, "$1[removed]");
  return redactLogText(withoutSetupToken, DIAGNOSTICS_LIMITS.outputLineChars);
}

export function captureOutputLine(stream, line, at = Date.now()) {
  const text = scrubOutputLine(line);
  if (!text) return;
  outputSequence += 1;
  output.push({ seq: outputSequence, at: new Date(at).toISOString(), stream: stream === "stderr" ? "stderr" : "stdout", text });
  if (output.length > DIAGNOSTICS_LIMITS.outputLines) output.splice(0, output.length - DIAGNOSTICS_LIMITS.outputLines);
}

/** The most recent output lines, oldest first, optionally after `afterSeq`. */
export function recentOutput({ limit = 500, afterSeq = 0 } = {}) {
  const bounded = Math.min(DIAGNOSTICS_LIMITS.outputLines, Math.max(1, Number.isSafeInteger(limit) ? limit : 500));
  const lines = output.filter((line) => line.seq > afterSeq);
  return { lines: lines.slice(-bounded), lastSeq: outputSequence, capturing: outputInstalled };
}

/**
 * Tees process stdout and stderr into the in-memory buffer. Called once by
 * the server entry point; tests and libraries never patch the process.
 */
export function installOutputCapture(processLike = process) {
  if (outputInstalled) return;
  outputInstalled = true;
  for (const stream of ["stdout", "stderr"]) {
    const target = processLike[stream];
    const original = target.write.bind(target);
    let partial = "";
    target.write = (chunk, ...rest) => {
      try {
        partial += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop().slice(-4_000);
        for (const line of lines) captureOutputLine(stream, line);
      } catch {
        // Capturing must never break the process's own output.
      }
      return original(chunk, ...rest);
    };
  }
}

export function resetOutputForTests() {
  output.length = 0;
  outputSequence = 0;
}

// ----------------------------------------------------------- diagnostics --

/**
 * `record(event)` writes one journal event. `clock()` returns milliseconds.
 */
export function createDiagnostics({ record, clock = Date.now } = {}) {
  let debugUntil = 0;
  let windowStartedAt = 0;
  let windowCount = 0;
  let dropped = 0;

  function debugEnabled() {
    return debugUntil > clock();
  }

  function settings() {
    const enabled = debugEnabled();
    return {
      level: enabled ? "debug" : "normal",
      debugUntil: enabled ? new Date(debugUntil).toISOString() : null,
      defaultHours: DIAGNOSTICS_LIMITS.defaultDebugHours,
      maximumHours: DIAGNOSTICS_LIMITS.maximumDebugHours
    };
  }

  function setDebug(enabled, hours = DIAGNOSTICS_LIMITS.defaultDebugHours) {
    const wasEnabled = debugEnabled();
    if (enabled) {
      const bounded = Math.min(DIAGNOSTICS_LIMITS.maximumDebugHours, Math.max(1, Math.round(hours)));
      debugUntil = clock() + bounded * 60 * 60 * 1_000;
    } else {
      debugUntil = 0;
    }
    safeRecord({
      level: "info",
      category: "configuration",
      event: "logging.level",
      outcome: "changed",
      service: "helmsman",
      source: "logging",
      message: enabled
        ? `Debug logging is on until ${new Date(debugUntil).toISOString()}.`
        : wasEnabled ? "Debug logging is off." : "Debug logging stays off."
    });
    return settings();
  }

  function safeRecord(event) {
    try {
      const pending = record(event);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch {
      // A malformed event is dropped rather than breaking the caller.
    }
  }

  // Debug events are capped per minute so a misbehaving loop cannot flood
  // the journal; the number dropped is logged once the minute is over.
  function allowDebug() {
    const now = clock();
    if (now - windowStartedAt >= 60_000) {
      if (dropped) {
        safeRecord({
          level: "warn",
          category: "application",
          event: "logging.dropped",
          outcome: "observed",
          service: "helmsman",
          source: "logging",
          message: `${dropped} debug entries were skipped in one minute to protect storage.`
        });
      }
      windowStartedAt = now;
      windowCount = 0;
      dropped = 0;
    }
    if (windowCount >= DIAGNOSTICS_LIMITS.debugEventsPerMinute) {
      dropped += 1;
      return false;
    }
    windowCount += 1;
    return true;
  }

  function debug(event) {
    if (!debugEnabled() || !allowDebug()) return;
    safeRecord({ ...event, level: "debug" });
  }

  /** One request to a connected service, logged at debug level. */
  function request({ kind, service, method, path, status: httpStatus, durationMs, error }) {
    if (!debugEnabled()) return;
    const described = error ? describeErrorForLog(error) : null;
    debug({
      category: "request",
      event: "request.upstream",
      outcome: error || (httpStatus && httpStatus >= 400) ? "failed" : "succeeded",
      service: pick(service, SERVICE),
      operation: typeof method === "string" && /^[A-Z]{3,7}$/u.test(method) ? method : undefined,
      route: redactLogRoute(path || ""),
      httpStatus: status(httpStatus ?? error?.status),
      code: pick(error?.code, CODE),
      durationMs,
      source: pick(kind, SOURCE),
      message: described
        ? `${method || "GET"} ${redactLogRoute(path || "") || "/"} failed after ${Math.round(durationMs || 0)} ms: ${described.message}`
        : `${method || "GET"} ${redactLogRoute(path || "") || "/"} → ${status(httpStatus) ?? "no status"} in ${Math.round(durationMs || 0)} ms`
    });
  }

  /** An unexpected error with its message and stack, at error level. */
  function error(source, caught, extra = {}) {
    const described = describeErrorForLog(caught);
    safeRecord({
      level: extra.level === "warn" ? "warn" : "error",
      category: extra.category || "application",
      event: extra.event || "error.unexpected",
      outcome: "failed",
      service: pick(extra.service, SERVICE) || "helmsman",
      capability: pick(extra.capability, CAPABILITY),
      code: pick(caught?.code, CODE) || pick(extra.code, CODE),
      httpStatus: status(caught?.status),
      route: extra.route ? redactLogRoute(extra.route) : undefined,
      source: pick(source, SOURCE),
      message: extra.message ? redactLogText(extra.message) : described.message,
      detail: described.detail
    });
  }

  function checkMessage(check) {
  const reports = Array.isArray(check?.reports) ? check.reports : [];
  const state = typeof check?.state === "string" ? check.state : check?.ok ? "healthy" : "failed";
  const first = reports.find((report) => typeof report?.message === "string");
  const label = typeof check?.label === "string" && check.label ? check.label : typeof check?.id === "string" ? check.id : "Check";
  const text = reports.length
    ? `${label}: ${state}; ${reports.length} reported by the service${first ? `: ${first.message}` : ""}`
    : `${label}: ${state}`;
  return redactLogText(text, 240) || undefined;
}

/** Every check from one monitoring cycle, at debug level. */
  function checks(snapshot) {
    if (!debugEnabled()) return;
    for (const service of Array.isArray(snapshot?.services) ? snapshot.services : []) {
      for (const check of Array.isArray(service?.checks) ? service.checks : []) {
        debug({
          category: "health",
          event: "check.completed",
          outcome: check?.ok ? "succeeded" : "failed",
          service: pick(service?.id, SERVICE),
          capability: pick(check?.id, CAPABILITY),
          code: pick(check?.code, CODE),
          httpStatus: status(check?.httpStatus),
          durationMs: Number.isFinite(check?.latencyMs) ? check.latencyMs : undefined,
          source: "monitor",
          message: checkMessage(check)
        });
      }
    }
  }

  return { debugEnabled, settings, setDebug, debug, request, error, checks, record: safeRecord };
}

/**
 * Wraps a dispatcher so each call is timed and logged at debug level.
 * Errors still propagate unchanged.
 */
export function tracedDispatcher(kind, dispatcher, diagnostics, clock = Date.now) {
  return async (input) => {
    if (!diagnostics.debugEnabled()) return dispatcher(input);
    const startedAt = clock();
    const route = input?.route || {};
    const details = {
      kind,
      service: route.service || kind,
      method: route.method || input?.request?.method || "GET",
      path: route.upstreamPath || route.upstreamPathAndQuery || route.path || ""
    };
    try {
      const result = await dispatcher(input);
      diagnostics.request({ ...details, status: result?.status ?? result?.statusCode, durationMs: clock() - startedAt });
      return result;
    } catch (caught) {
      diagnostics.request({ ...details, durationMs: clock() - startedAt, error: caught });
      throw caught;
    }
  };
}
