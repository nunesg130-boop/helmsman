import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

// Agent configuration: the local AI model server, Home Assistant
// notifications, when the agent runs, and the rules it may act on by itself.
// Kept in agent.json beside state.json.
//
// The file holds destinations Helmsman will contact, so it carries an HMAC
// from the credential store. A copied or edited file fails closed: the agent
// starts unconfigured and the next save replaces it. Secrets (an optional
// model-server API key and the Home Assistant token) are never in this file;
// they live in the encrypted credential store.

const FILE_NAME = "agent.json";
const FILE_VERSION = 1;
const INTEGRITY_DOMAIN = "agent-config";
const MAX_FILE_BYTES = 256 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EXACT_HOST_CIDR = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/32|[0-9a-f:]+\/128)$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const NOTIFY_SERVICE = /^[a-z0-9_]{1,64}$/u;
const INCIDENT_SERVICE = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const SINGLE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u;
// Response instructions may span lines, but carry no other control characters.
const INSTRUCTION_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]*$/u;
const URL_TEXT = /^[^\u0000- \u007f-\u009f\\]{1,2048}$/u;

export const AGENT_LIMITS = Object.freeze({
  rules: 20,
  contextTokens: { min: 2_048, max: 131_072, default: 4_096 },
  timeoutSeconds: { min: 10, max: 300, default: 120 },
  // Questions in chat per hour. Protects the model server from a runaway
  // script or a stolen session; raise it for a test or training-data run.
  questionsPerHour: { min: 10, max: 2_000, default: 60 },
  checkInHours: { min: 1, max: 24, default: 6 },
  ruleMinutes: { min: 1, max: 120, default: 5 },
  cooldownMinutes: { min: 10, max: 1_440, default: 60 },
  maxPerDay: { min: 1, max: 10, default: 3 },
  extraInstructions: 2_000,
  healthMinutes: { min: 1, max: 60, default: 3 },
  repeatCount: { min: 2, max: 10, default: 3 },
  repeatHours: { min: 1, max: 168, default: 24 },
  healthContainers: 64,
  stuckMinutes: { min: 10, max: 1_440, default: 60 },
  indexerTests: { min: 1, max: 5, default: 2 },
  indexerSpacingMinutes: { min: 5, max: 120, default: 15 },
  indexerTestsPerHour: 12,
  approvedHosts: 32
});

export const RULE_OPERATIONS = Object.freeze({
  container: Object.freeze(["restart", "start"]),
  guest: Object.freeze(["start", "reboot"])
});

export class AgentConfigError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AgentConfigError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message, code = "INVALID_AGENT_CONFIG") {
  throw new AgentConfigError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional, where) {
  if (!isPlainObject(value)) invalid(`${where} must be an object.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${where} has an unsupported field: ${key.slice(0, 40)}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${where} is missing ${key}.`);
  }
}

function integer(value, { min, max }, where) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${where} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function bool(value, where) {
  if (typeof value !== "boolean") invalid(`${where} must be true or false.`);
  return value;
}

function isoTimestamp(value, where) {
  if (typeof value !== "string" || value.length > 40 || new Date(Date.parse(value)).toISOString() !== value) {
    invalid(`${where} must be a timestamp.`);
  }
  return value;
}

function approvedHosts(value, where) {
  if (!Array.isArray(value) || value.length > AGENT_LIMITS.approvedHosts
    || value.some((entry) => typeof entry !== "string" || !EXACT_HOST_CIDR.test(entry))) {
    invalid(`${where} has invalid approved addresses.`);
  }
  return [...value];
}

export function validTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function defaultSettings() {
  return {
    enabled: false,
    triggers: { incidents: true, recoveries: true, digest: true, checkIn: true },
    digestTime: "07:30",
    timeZone: "UTC",
    checkInHours: AGENT_LIMITS.checkInHours.default,
    autonomy: false
  };
}

/**
 * Restarting unhealthy containers. Off until the owner turns it on. `scope`
 * "all" covers every container except `containers`; "only" covers just the
 * listed ones. After `repeatCount` unhealthy episodes within `repeatHours`
 * Helmsman stops restarting that container and tells the owner instead.
 */
export function defaultContainerHealth() {
  return {
    enabled: false,
    scope: "all",
    containers: [],
    minutes: AGENT_LIMITS.healthMinutes.default,
    repeatCount: AGENT_LIMITS.repeatCount.default,
    repeatHours: AGENT_LIMITS.repeatHours.default
  };
}

export function canonicalContainerHealth(value) {
  exactKeys(value, ["enabled", "scope", "containers", "minutes", "repeatCount", "repeatHours"], [], "Container health");
  if (!["all", "only"].includes(value.scope)) invalid("Container health must cover all containers or only listed ones.");
  if (!Array.isArray(value.containers) || value.containers.length > AGENT_LIMITS.healthContainers) {
    invalid(`List up to ${AGENT_LIMITS.healthContainers} containers.`);
  }
  const containers = [];
  for (const name of value.containers) {
    if (typeof name !== "string" || !CONTAINER_NAME.test(name)) invalid("Container names may use letters, digits, dots, dashes and underscores.");
    if (!containers.includes(name)) containers.push(name);
  }
  return {
    enabled: bool(value.enabled, "Container health enabled"),
    scope: value.scope,
    containers: containers.sort((left, right) => left.localeCompare(right)),
    minutes: integer(value.minutes, AGENT_LIMITS.healthMinutes, "The unhealthy wait"),
    repeatCount: integer(value.repeatCount, AGENT_LIMITS.repeatCount, "The repeat count"),
    repeatHours: integer(value.repeatHours, AGENT_LIMITS.repeatHours, "The repeat window")
  };
}

/**
 * Stuck downloads: Radarr or Sonarr queue items that stay failed, stalled or
 * blocked from importing. Off until the owner turns it on. Helmsman suggests
 * removing the item, blocklisting the release and searching again; with
 * `automatic` (and autonomy) it does that by itself for stalled and failed
 * downloads. Blocked imports always wait for approval.
 */
export function defaultDownloads() {
  return { enabled: false, minutes: AGENT_LIMITS.stuckMinutes.default, automatic: false };
}

export function canonicalDownloads(value) {
  exactKeys(value, ["enabled", "minutes", "automatic"], [], "Stuck downloads");
  return {
    enabled: bool(value.enabled, "Stuck downloads enabled"),
    minutes: integer(value.minutes, AGENT_LIMITS.stuckMinutes, "The stuck wait"),
    automatic: bool(value.automatic, "Automatic clean-up")
  };
}

/**
 * Indexers: whether the agent may test Prowlarr indexers, on its own when
 * one starts failing and when the owner asks in chat. A failing indexer is
 * tested up to `tests` times, `spacingMinutes` apart, before the owner is
 * notified. Testing changes nothing in Prowlarr.
 */
export function defaultIndexers() {
  return { enabled: false, tests: AGENT_LIMITS.indexerTests.default, spacingMinutes: AGENT_LIMITS.indexerSpacingMinutes.default };
}

export function canonicalIndexers(value) {
  exactKeys(value, ["enabled", "tests", "spacingMinutes"], [], "Indexers");
  return {
    enabled: bool(value.enabled, "Indexer testing enabled"),
    tests: integer(value.tests, AGENT_LIMITS.indexerTests, "The number of tests"),
    spacingMinutes: integer(value.spacingMinutes, AGENT_LIMITS.indexerSpacingMinutes, "The time between tests")
  };
}

/**
 * Conversations: whether full model exchanges are saved for review and
 * training data. Off by default. `reports` also saves the agent's own
 * reports (incidents, recoveries, summaries), not only chat answers.
 */
export function defaultConversations() {
  return { keep: false, reports: true };
}

export function canonicalConversations(value) {
  exactKeys(value, ["keep", "reports"], [], "Conversations");
  return {
    keep: bool(value.keep, "Keep conversations"),
    reports: bool(value.reports, "Keep reports")
  };
}

export function emptyAgentConfig() {
  return { ai: null, notify: null, settings: defaultSettings(), rules: [] };
}

export function canonicalAiConfig(value) {
  if (value === null) return null;
  exactKeys(value, [
    "url", "targetRevision", "approvedHostCidrs", "model", "contextTokens",
    "timeoutSeconds", "authMode", "extraInstructions", "updatedAt"
  ], ["questionsPerHour"], "The AI connection");
  if (typeof value.url !== "string" || !URL_TEXT.test(value.url)) invalid("The AI connection URL is invalid.");
  if (typeof value.targetRevision !== "string" || !UUID.test(value.targetRevision)) invalid("The AI connection revision is invalid.");
  if (typeof value.model !== "string" || !MODEL_ID.test(value.model)) invalid("Choose a valid model name.");
  if (!["none", "bearer"].includes(value.authMode)) invalid("The AI connection authentication must be none or bearer.");
  if (typeof value.extraInstructions !== "string"
    || [...value.extraInstructions].length > AGENT_LIMITS.extraInstructions
    || !INSTRUCTION_TEXT.test(value.extraInstructions)) {
    invalid(`Response instructions must be ${AGENT_LIMITS.extraInstructions} characters or fewer.`);
  }
  return {
    url: value.url,
    targetRevision: value.targetRevision,
    approvedHostCidrs: approvedHosts(value.approvedHostCidrs, "The AI connection"),
    model: value.model,
    contextTokens: integer(value.contextTokens, AGENT_LIMITS.contextTokens, "The context size"),
    timeoutSeconds: integer(value.timeoutSeconds, AGENT_LIMITS.timeoutSeconds, "The model timeout"),
    questionsPerHour: value.questionsPerHour === undefined
      ? AGENT_LIMITS.questionsPerHour.default
      : integer(value.questionsPerHour, AGENT_LIMITS.questionsPerHour, "Questions per hour"),
    authMode: value.authMode,
    extraInstructions: value.extraInstructions,
    updatedAt: isoTimestamp(value.updatedAt, "The AI connection update time")
  };
}

export function canonicalNotifyConfig(value) {
  if (value === null) return null;
  exactKeys(value, ["url", "targetRevision", "approvedHostCidrs", "service", "helmsmanUrl", "updatedAt"], [], "Notifications");
  if (typeof value.url !== "string" || !URL_TEXT.test(value.url)) invalid("The Home Assistant URL is invalid.");
  if (typeof value.targetRevision !== "string" || !UUID.test(value.targetRevision)) invalid("The notification revision is invalid.");
  if (typeof value.service !== "string" || !NOTIFY_SERVICE.test(value.service)) {
    invalid("The notify service must be the part after notify., such as mobile_app_pixel_8.");
  }
  if (value.helmsmanUrl !== null) {
    let parsed;
    try {
      parsed = new URL(value.helmsmanUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
      || value.helmsmanUrl.length > 512) {
      invalid("The Helmsman link must be an https:// address without a query.");
    }
  }
  return {
    url: value.url,
    targetRevision: value.targetRevision,
    approvedHostCidrs: approvedHosts(value.approvedHostCidrs, "Notifications"),
    service: value.service,
    helmsmanUrl: value.helmsmanUrl,
    updatedAt: isoTimestamp(value.updatedAt, "The notification update time")
  };
}

export function canonicalSettings(value) {
  exactKeys(value, ["enabled", "triggers", "digestTime", "timeZone", "checkInHours", "autonomy"], [], "Agent settings");
  exactKeys(value.triggers, ["incidents", "recoveries", "digest", "checkIn"], [], "Agent triggers");
  if (typeof value.digestTime !== "string" || !TIME_OF_DAY.test(value.digestTime)) {
    invalid("The digest time must look like 07:30.");
  }
  if (!validTimeZone(value.timeZone)) invalid("Choose a valid time zone, such as America/New_York.");
  return {
    enabled: bool(value.enabled, "Agent enabled"),
    triggers: {
      incidents: bool(value.triggers.incidents, "The incidents trigger"),
      recoveries: bool(value.triggers.recoveries, "The recoveries trigger"),
      digest: bool(value.triggers.digest, "The digest trigger"),
      checkIn: bool(value.triggers.checkIn, "The check-in trigger")
    },
    digestTime: value.digestTime,
    timeZone: value.timeZone,
    checkInHours: integer(value.checkInHours, AGENT_LIMITS.checkInHours, "The check-in interval"),
    autonomy: bool(value.autonomy, "Rules")
  };
}

export function canonicalRule(value, index) {
  const where = `Rule ${index + 1}`;
  exactKeys(value, ["id", "enabled", "when", "then", "cooldownMinutes", "maxPerDay"], [], where);
  if (typeof value.id !== "string" || !RULE_ID.test(value.id)) invalid(`${where} needs an id of lower-case letters, digits or hyphens.`);
  exactKeys(value.when, ["service", "minutes"], [], `${where} trigger`);
  if (typeof value.when.service !== "string" || !INCIDENT_SERVICE.test(value.when.service)) {
    invalid(`${where} must name the service whose incident triggers it.`);
  }
  const then = value.then;
  if (!isPlainObject(then)) invalid(`${where} needs an action.`);
  let action;
  if (then.kind === "container") {
    exactKeys(then, ["kind", "serviceId", "containerName", "operation"], [], `${where} action`);
    if (typeof then.serviceId !== "string" || !UUID.test(then.serviceId)) invalid(`${where} must name a Portainer connection.`);
    if (typeof then.containerName !== "string" || !CONTAINER_NAME.test(then.containerName)) invalid(`${where} needs a container name.`);
    if (!RULE_OPERATIONS.container.includes(then.operation)) invalid(`${where} may only start or restart a container.`);
    action = { kind: "container", serviceId: then.serviceId, containerName: then.containerName, operation: then.operation };
  } else if (then.kind === "guest") {
    exactKeys(then, ["kind", "environmentId", "vmid", "operation"], [], `${where} action`);
    if (typeof then.environmentId !== "string" || !UUID.test(then.environmentId)) invalid(`${where} must name a Proxmox environment.`);
    if (!RULE_OPERATIONS.guest.includes(then.operation)) invalid(`${where} may only start or reboot a guest.`);
    action = {
      kind: "guest",
      environmentId: then.environmentId,
      vmid: integer(then.vmid, { min: 1, max: 999_999_999 }, `${where} VMID`),
      operation: then.operation
    };
  } else {
    invalid(`${where} action must be a container or a guest.`);
  }
  return {
    id: value.id,
    enabled: bool(value.enabled, `${where} enabled`),
    when: { service: value.when.service, minutes: integer(value.when.minutes, AGENT_LIMITS.ruleMinutes, `${where} wait`) },
    then: action,
    cooldownMinutes: integer(value.cooldownMinutes, AGENT_LIMITS.cooldownMinutes, `${where} cooldown`),
    maxPerDay: integer(value.maxPerDay, AGENT_LIMITS.maxPerDay, `${where} daily limit`)
  };
}

export function canonicalRules(value) {
  if (!Array.isArray(value) || value.length > AGENT_LIMITS.rules) invalid(`Up to ${AGENT_LIMITS.rules} rules are allowed.`);
  const rules = value.map((rule, index) => canonicalRule(rule, index));
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) invalid(`Two rules use the id ${rule.id}.`);
    ids.add(rule.id);
  }
  return rules;
}

export function canonicalAgentConfig(value) {
  // containerHealth is optional and only saved once the owner changes it,
  // so a configuration that never used it still loads in older versions.
  exactKeys(value, ["ai", "notify", "settings", "rules"], ["containerHealth", "downloads", "indexers", "conversations"], "The agent configuration");
  return {
    ai: canonicalAiConfig(value.ai),
    notify: canonicalNotifyConfig(value.notify),
    settings: canonicalSettings(value.settings),
    rules: canonicalRules(value.rules),
    ...(value.containerHealth === undefined ? {} : { containerHealth: canonicalContainerHealth(value.containerHealth) }),
    ...(value.downloads === undefined ? {} : { downloads: canonicalDownloads(value.downloads) }),
    ...(value.indexers === undefined ? {} : { indexers: canonicalIndexers(value.indexers) }),
    ...(value.conversations === undefined ? {} : { conversations: canonicalConversations(value.conversations) })
  };
}

function integrityPayload(document) {
  return Buffer.from(JSON.stringify({
    version: document.version,
    revision: document.revision,
    updatedAt: document.updatedAt,
    config: document.config
  }), "utf8");
}

async function readFileSafely(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return { value: null };
    const bytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(bytes, 0, metadata.size, 0);
    if (bytesRead !== metadata.size) return { value: null };
    return { value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { value: null };
  } finally {
    await handle.close();
  }
}

async function atomicWrite(dataDir, filePath, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new AgentConfigError("AGENT_CONFIG_TOO_LARGE", "The agent configuration is too large.");
  const temporary = path.join(dataDir, `.agent-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(temporary, flags, 0o600);
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Opens agent.json. `integrity(domain, payload)` is the credential store's
 * integrityTag. Returns { get(), update(mutator), loadProblem }.
 */
export async function createAgentConfigStore({ dataDir, integrity, clock = Date.now, guard = async () => {} }) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("The agent configuration needs an absolute data directory.");
  if (typeof integrity !== "function") throw new Error("The agent configuration needs an integrity function.");
  const filePath = path.join(dataDir, FILE_NAME);
  let current = { revision: null, updatedAt: null, config: emptyAgentConfig() };
  let loadProblem = null;
  let writeChain = Promise.resolve();

  await guard();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const loaded = await readFileSafely(filePath);
  if (!loaded.missing) {
    const document = loaded.value;
    try {
      if (!isPlainObject(document) || document.version !== FILE_VERSION
        || typeof document.revision !== "string" || !UUID.test(document.revision)
        || typeof document.tag !== "string" || !/^[a-f0-9]{64}$/u.test(document.tag)) {
        throw new AgentConfigError("AGENT_CONFIG_UNREADABLE", "agent.json is not a Helmsman agent configuration.");
      }
      if (integrity(INTEGRITY_DOMAIN, integrityPayload(document)) !== document.tag) {
        throw new AgentConfigError("AGENT_CONFIG_TAMPERED", "agent.json failed its integrity check.");
      }
      isoTimestamp(document.updatedAt, "The agent configuration update time");
      current = { revision: document.revision, updatedAt: document.updatedAt, config: canonicalAgentConfig(document.config) };
    } catch (error) {
      loadProblem = error?.code || "AGENT_CONFIG_UNREADABLE";
      current = { revision: null, updatedAt: null, config: emptyAgentConfig() };
    }
  }

  return {
    get loadProblem() {
      return loadProblem;
    },
    get() {
      return structuredClone(current);
    },
    /**
     * Applies `mutator(config)` to a copy, validates the result and saves it.
     * The mutator may be async and may throw to cancel.
     */
    update(mutator) {
      const operation = writeChain.catch(() => {}).then(async () => {
        const next = structuredClone(current.config);
        const result = await mutator(next);
        const config = canonicalAgentConfig(next);
        const document = {
          version: FILE_VERSION,
          revision: randomUUID(),
          updatedAt: new Date(Math.trunc(Number(clock()))).toISOString(),
          config
        };
        document.tag = integrity(INTEGRITY_DOMAIN, integrityPayload(document));
        await guard();
        await atomicWrite(dataDir, filePath, document);
        current = { revision: document.revision, updatedAt: document.updatedAt, config };
        loadProblem = null;
        return result;
      });
      writeChain = operation.then(() => {}, () => {});
      return operation;
    }
  };
}
