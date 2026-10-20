// Scrubs secrets from free text before it is logged: error messages, stack
// traces, server output and request routes. Helmsman never logs request or
// response bodies or headers; this is the second line of defence for text
// that might quote a URL, a header or a key by accident.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu;
const CONTROL_WITH_NEWLINES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const SECRET_NAMES = "api[_-]?key|apikey|x-api-key|x-emby-token|x-plex-token|token|access[_-]?token|refresh[_-]?token|auth|authorization|passkey|password|passwd|pass|secret|client[_-]?secret|cookie|set-cookie|session|sid|signature|sig|key";

const PATTERNS = [
  // Credentials inside URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[removed]@"],
  // Query strings and fragments carry keys for many services.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#][^\s"'<>)]*/giu, "$1?…"],
  // Authorization schemes.
  [/\b(Bearer|Basic|Token|Digest|MediaBrowser|Emby)\s+[A-Za-z0-9._~+/=,:"-]{6,}/gu, "$1 [removed]"],
  // name=value and name: value pairs for secret-looking names, including JSON.
  [new RegExp(`(["']?\\b(?:${SECRET_NAMES})\\b["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}]+)`, "giu"), "$1[removed]"],
  // JWT-shaped values.
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[removed]"]
];

// Long random-looking tokens (letters and digits mixed) look like keys.
// UUIDs are identifiers and stay, as do long words such as file names.
function looksLikeKey(token) {
  if (UUID.test(token)) return false;
  const digits = token.replace(/[^0-9]/gu, "").length;
  const letters = token.replace(/[^A-Za-z]/gu, "").length;
  return digits >= 3 && letters >= 3;
}

function removeLongTokens(text) {
  return text.replace(/[A-Za-z0-9_+=-]{24,}/gu, (token) => (looksLikeKey(token) ? "[removed]" : token));
}

/**
 * Returns `value` as safe log text: control characters removed (newlines kept
 * when `multiline`), secrets replaced with "[removed]", and at most `max`
 * characters long.
 */
export function redactLogText(value, max = 300, { multiline = false } = {}) {
  if (value === undefined || value === null) return "";
  let text = String(value).slice(0, Math.max(max * 4, 2_000));
  text = multiline
    ? text.replace(/\r\n?/gu, "\n").replace(CONTROL, " ").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n")
    : text.replace(CONTROL_WITH_NEWLINES, " ").replace(/\s+/gu, " ");
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  text = removeLongTokens(text).trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * A request path for the log: no query string or fragment, no long tokens,
 * at most 200 characters. Returns "" for anything that is not a path.
 */
export function redactLogRoute(value) {
  if (typeof value !== "string") return "";
  const path = value.split(/[?#]/u, 1)[0];
  if (!path.startsWith("/")) return "";
  const cleaned = removeLongTokens(path.replace(/[^A-Za-z0-9._~/{}:@!$'()*+,;=%-]/gu, ""));
  return cleaned.slice(0, 200);
}

/** An error as `{ message, detail }`: the message and a trimmed stack. */
export function describeErrorForLog(error) {
  const message = redactLogText(error?.message ?? error ?? "Unknown error", 300) || "Unknown error";
  const stack = typeof error?.stack === "string" ? error.stack : "";
  // Keep the first frames; drop Node's own internals.
  const frames = stack.split("\n").slice(1).map((line) => line.trim()).filter((line) => line.startsWith("at ") && !line.includes("node:internal")).slice(0, 12);
  const name = typeof error?.name === "string" && error.name !== "Error" ? `${error.name}: ` : "";
  const code = typeof error?.code === "string" ? ` [${error.code}]` : "";
  const detail = redactLogText([`${name}${message}${code}`, ...frames].join("\n"), 2_000, { multiline: true });
  return { message, detail };
}
