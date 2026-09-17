import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBroker } from "../server/broker.mjs";
import { CredentialStore } from "../server/secrets.mjs";
import { SessionAuthStore } from "../server/session-auth.mjs";
import { StateStore } from "../server/state.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_SECRET = "recovery-test-secret-must-never-be-printed";
const BROWSER_AUTH_STATE_NAMESPACE = "browser-auth-state";
const BROWSER_AUTH_STATE_FIELD = "schema";
const BROWSER_AUTH_STATE_VERSION = "4";

function runRecovery(command, dataDir, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      JELLOFIN_COMMAND_DATA_DIR: dataDir,
      ...extraEnvironment
    };
    if (!("JELLOFIN_COMMAND_MASTER_KEY_FILE" in extraEnvironment)) {
      delete environment.JELLOFIN_COMMAND_MASTER_KEY_FILE;
    }
    const child = spawn(process.execPath, ["server/index.mjs", command, "--confirm"], {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createState(dataDir) {
  const state = new StateStore(dataDir);
  await state.initialize();
  await state.mutate((next) => {
    next.claimed = true;
    next.claimedAt = "2026-09-13T00:00:00.000Z";
    next.policy = {
      allowedCidrs: ["192.168.50.12/32"],
      allowPublicHttps: false,
      revision: 2
    };
    next.connections.radarr = {
      url: "http://192.168.50.12:7878",
      targetRevision: randomUUID(),
      updatedAt: "2026-09-13T00:00:00.000Z",
      authMode: "apiKey",
      monitoringEnabled: true
    };
  });
  return state;
}

async function createSession(dataDir) {
  const sessions = new SessionAuthStore(dataDir);
  await sessions.initialize();
  return sessions.issue({
    name: "Recovery test browser",
    origin: "http://127.0.0.1:4180",
    host: "127.0.0.1:4180"
  });
}

async function quarantineFiles(dataDir, prefix) {
  return (await readdir(dataDir)).filter((name) => name.startsWith(prefix)).sort();
}

test("reset-access quarantines malformed sessions while preserving topology and credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-recover-sessions-"));
  const dataDir = path.join(root, "data");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);
    await createSession(dataDir);

    const credentialDocument = await readFile(path.join(dataDir, "credentials.json"));
    const credentialKey = await readFile(path.join(dataDir, "credentials.key"));
    const malformedSessions = Buffer.from("{this is not valid session JSON\n", "utf8");
    await writeFile(path.join(dataDir, "sessions.json"), malformedSessions, { mode: 0o600 });

    const result = await runRecovery("reset-access", dataDir);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /session state was quarantined and replaced/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SERVICE_SECRET, "u"));

    const resetState = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    const resetSessions = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.equal(resetState.claimed, false);
    assert.equal(resetState.instanceId, instanceId);
    assert.deepEqual(resetState.policy.allowedCidrs, ["192.168.50.12/32"]);
    assert.equal(resetState.connections.radarr.url, "http://192.168.50.12:7878");
    assert.equal(resetSessions.version, 4);
    assert.equal(resetSessions.accessKeyHash, null);
    assert.equal(resetSessions.owner, null);
    assert.deepEqual(resetSessions.sessions, {});
    assert.notDeepEqual(await readFile(path.join(dataDir, "credentials.json")), credentialDocument);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.key")), credentialKey);
    const preservedCredentials = new CredentialStore(dataDir, { instanceId });
    await preservedCredentials.initialize();
    assert.equal(
      await preservedCredentials.useCredential("radarr", "apiKey", (value) => value.toString("utf8")),
      SERVICE_SECRET
    );
    assert.equal(preservedCredentials.hasCredential("browser-auth-state", "schema"), true);
    await preservedCredentials.close();

    const quarantined = await quarantineFiles(dataDir, "sessions.json.corrupt-");
    assert.equal(quarantined.length, 1);
    assert.deepEqual(await readFile(path.join(dataDir, quarantined[0])), malformedSessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted reset-access cannot reopen legacy session migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-reset-marker-crash-"));
  const dataDir = path.join(root, "data");
  const loaderPath = path.join(root, "session-init-failure-loader.mjs");
  const replacementPath = path.join(root, "session-init-failure.mjs");
  const sentinelPath = path.join(root, "session-init-entered.txt");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const seededCredentials = new CredentialStore(dataDir, { instanceId });
    await seededCredentials.initialize();
    await seededCredentials.close();

    const legacyState = {
      version: 2,
      revision: 4,
      accessKeyHash: "a".repeat(64),
      sessions: {}
    };
    await writeFile(
      path.join(dataDir, "sessions.json"),
      `${JSON.stringify(legacyState)}\n`,
      { mode: 0o600 }
    );

    const realSessionModule = pathToFileURL(path.join(PROJECT_ROOT, "server/session-auth.mjs")).href;
    const replacementModule = pathToFileURL(replacementPath).href;
    await writeFile(replacementPath, [
      'import { writeFile } from "node:fs/promises";',
      `import { SessionAuthStore as RealSessionAuthStore } from ${JSON.stringify(`${realSessionModule}?reset-access-real`)};`,
      `export * from ${JSON.stringify(`${realSessionModule}?reset-access-real`)};`,
      "export class SessionAuthStore extends RealSessionAuthStore {",
      "  async initialize() {",
      "    await writeFile(process.env.HELMSMAN_TEST_SESSION_INIT_SENTINEL, \"entered\\n\", { flag: \"a\" });",
      "    throw new Error(\"simulated reset-access crash after marker commit\");",
      "  }",
      "}",
      ""
    ].join("\n"), { mode: 0o600 });
    await writeFile(loaderPath, [
      `const targetUrl = ${JSON.stringify(realSessionModule)};`,
      `const replacementUrl = ${JSON.stringify(replacementModule)};`,
      "export async function resolve(specifier, context, nextResolve) {",
      "  const resolved = await nextResolve(specifier, context);",
      "  if (resolved.url === targetUrl) return { url: replacementUrl, shortCircuit: true };",
      "  return resolved;",
      "}",
      ""
    ].join("\n"), { mode: 0o600 });

    const interrupted = await runRecovery("reset-access", dataDir, {
      NODE_OPTIONS: `--experimental-loader=${pathToFileURL(loaderPath).href}`,
      HELMSMAN_TEST_SESSION_INIT_SENTINEL: sentinelPath
    });
    assert.equal(interrupted.code, 1, interrupted.stdout);
    assert.match(interrupted.stderr, /simulated reset-access crash after marker commit/u);
    assert.match(await readFile(sentinelPath, "utf8"), /entered/u);

    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    assert.equal(
      await credentials.useCredential(
        BROWSER_AUTH_STATE_NAMESPACE,
        BROWSER_AUTH_STATE_FIELD,
        (value) => value.toString("utf8")
      ),
      BROWSER_AUTH_STATE_VERSION,
      "reset-access must persist its anti-downgrade marker before reading legacy session state"
    );
    await credentials.close();

    // Substitute legacy state after the interrupted recovery. Normal startup
    // must honor the marker left by the failed process and reject it locally.
    await writeFile(
      path.join(dataDir, "sessions.json"),
      `${JSON.stringify({ ...legacyState, revision: 5 })}\n`,
      { mode: 0o600 }
    );
    const upstreamCalls = [];
    await assert.rejects(
      createBroker({
        dataDir,
        rootDir: PROJECT_ROOT,
        dispatchUpstream: async (input) => {
          upstreamCalls.push(input);
          throw new Error("reset marker downgrade must fail before upstream dispatch");
        },
        log: () => {}
      }),
      /Legacy browser authorization state cannot replace sealed state/u
    );
    assert.equal(upstreamCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset-access clears the owner and encrypted browser tokens while preserving monitoring credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-reset-owner-auth-"));
  const dataDir = path.join(root, "data");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const browserNamespace = `browser-auth-${sessionId}`;
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);
    await credentials.setCredential(browserNamespace, "token", "jellyfin-browser-token");
    await credentials.close();

    const sessions = new SessionAuthStore(dataDir);
    await sessions.initialize();
    await sessions.enrollOwnerAndIssue({
      owner: {
        provider: "jellyfin",
        serverId: "server-0123456789abcdef",
        userId: "user-0123456789abcdef",
        username: "Captain",
        jellyfinUrl: "https://jellyfin.example.test",
        targetRevision: "33333333-3333-4333-8333-333333333333",
        boundaryHash: "a".repeat(64)
      },
      principal: {
        provider: "jellyfin",
        serverId: "server-0123456789abcdef",
        userId: "user-0123456789abcdef",
        username: "Captain",
        deviceId: "22222222-2222-4222-8222-222222222222",
        jellyfinUrl: "https://jellyfin.example.test",
        targetRevision: "33333333-3333-4333-8333-333333333333",
        boundaryHash: "a".repeat(64)
      },
      sessionId,
      name: "Owner browser",
      origin: "https://command.example.test"
    });

    const result = await runRecovery("reset-access", dataDir);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const resetSessions = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.equal(resetSessions.version, 4);
    assert.equal(resetSessions.owner, null);
    assert.equal(resetSessions.accessKeyHash, null);
    assert.deepEqual(resetSessions.sessions, {});

    const reopened = new CredentialStore(dataDir, { instanceId });
    const metadata = await reopened.initialize();
    assert.equal(metadata.credentials[browserNamespace], undefined);
    assert.equal(metadata.credentials.radarr.apiKey.configured, true);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the retired rotate-access-key command is rejected without changing persisted state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-recover-access-key-"));
  const dataDir = path.join(root, "data");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);
    await createSession(dataDir);

    const originalState = await readFile(path.join(dataDir, "state.json"));
    const originalCredentials = await readFile(path.join(dataDir, "credentials.json"));
    const originalCredentialKey = await readFile(path.join(dataDir, "credentials.key"));
    const originalSessions = await readFile(path.join(dataDir, "sessions.json"));
    const result = await runRecovery("rotate-access-key", dataDir);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/u);
    assert.doesNotMatch(result.stderr, /Helmsman access key:/u);

    assert.deepEqual(await readFile(path.join(dataDir, "state.json")), originalState);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.json")), originalCredentials);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.key")), originalCredentialKey);
    assert.deepEqual(await readFile(path.join(dataDir, "sessions.json")), originalSessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset-credentials quarantines the local encrypted store and key and requires reset-access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-recover-credentials-"));
  const dataDir = path.join(root, "data");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    await createSession(dataDir);
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);

    const originalState = await readFile(path.join(dataDir, "state.json"));
    const originalSessions = await readFile(path.join(dataDir, "sessions.json"));
    const originalCredentials = await readFile(path.join(dataDir, "credentials.json"));
    const originalKey = await readFile(path.join(dataDir, "credentials.key"));

    const result = await runRecovery("reset-credentials", dataDir);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /Encrypted credentials were quarantined/u);
    assert.match(result.stdout, /run reset-access --confirm/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(SERVICE_SECRET, "u"));
    assert.deepEqual(await readFile(path.join(dataDir, "state.json")), originalState);
    assert.deepEqual(await readFile(path.join(dataDir, "sessions.json")), originalSessions);
    assert.equal(await exists(path.join(dataDir, "credentials.json")), false);
    assert.equal(await exists(path.join(dataDir, "credentials.key")), false);

    const credentialBackups = await quarantineFiles(dataDir, "credentials.json.unrecoverable-");
    const keyBackups = await quarantineFiles(dataDir, "credentials.key.unrecoverable-");
    assert.equal(credentialBackups.length, 1);
    assert.equal(keyBackups.length, 1);
    assert.deepEqual(await readFile(path.join(dataDir, credentialBackups[0])), originalCredentials);
    assert.deepEqual(await readFile(path.join(dataDir, keyBackups[0])), originalKey);

    const replacement = new CredentialStore(dataDir, { instanceId });
    const metadata = await replacement.initialize();
    assert.deepEqual(metadata.credentials, {});
    assert.equal(replacement.hasCredential("radarr", "apiKey"), false);
    assert.notDeepEqual(await readFile(path.join(dataDir, "credentials.key")), originalKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sealed browser authorization fails closed after reset-credentials until reset-access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-recover-sealed-auth-"));
  const dataDir = path.join(root, "data");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const targetRevision = "22222222-2222-4222-8222-222222222222";
  let broker = null;
  try {
    const state = await createState(dataDir);
    await state.mutate((next) => {
      next.connections.jellyfin = {
        url: "http://192.168.50.12:8096",
        targetRevision,
        updatedAt: "2026-09-13T00:00:00.000Z",
        authMode: "token",
        monitoringEnabled: false
      };
    });
    const instanceId = state.snapshot().instanceId;
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    const sessions = new SessionAuthStore(dataDir, {
      stateIntegrityTag: (payload) => credentials.sessionStateIntegrityTag(payload),
      allowLegacyMigration: false
    });
    await sessions.initialize();
    await credentials.setCredential(
      BROWSER_AUTH_STATE_NAMESPACE,
      BROWSER_AUTH_STATE_FIELD,
      BROWSER_AUTH_STATE_VERSION
    );
    await sessions.enrollOwnerAndIssue({
      owner: {
        provider: "jellyfin",
        serverId: "server-0123456789abcdef",
        userId: "user-0123456789abcdef",
        username: "Captain",
        jellyfinUrl: "http://192.168.50.12:8096",
        targetRevision,
        boundaryHash: "a".repeat(64)
      },
      principal: {
        provider: "jellyfin",
        serverId: "server-0123456789abcdef",
        userId: "user-0123456789abcdef",
        username: "Captain",
        deviceId: sessionId,
        jellyfinUrl: "http://192.168.50.12:8096",
        targetRevision,
        boundaryHash: "a".repeat(64)
      },
      sessionId,
      name: "Production-sealed browser",
      origin: "https://command.example.test"
    });
    const sealedSessions = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.match(sealedSessions.integrity, /^[a-f0-9]{64}$/u);
    assert.equal(sealedSessions.owner.username, "Captain");
    assert.deepEqual(Object.keys(sealedSessions.sessions), [sessionId]);
    const originalKey = await readFile(path.join(dataDir, "credentials.key"));
    await credentials.close();

    const credentialsReset = await runRecovery("reset-credentials", dataDir);
    assert.equal(credentialsReset.code, 0, credentialsReset.stderr || credentialsReset.stdout);
    assert.match(credentialsReset.stdout, /run reset-access --confirm/u);

    await assert.rejects(
      createBroker({ dataDir, rootDir: PROJECT_ROOT, log: () => {} }),
      /browser authorization state .*authenticated/iu
    );
    assert.notDeepEqual(await readFile(path.join(dataDir, "credentials.key")), originalKey);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8")),
      sealedSessions
    );

    const accessReset = await runRecovery("reset-access", dataDir);
    assert.equal(accessReset.code, 0, accessReset.stderr || accessReset.stdout);
    assert.match(accessReset.stdout, /session state was quarantined and replaced/u);

    broker = await createBroker({ dataDir, rootDir: PROJECT_ROOT, log: () => {} });
    assert.equal(broker.store.snapshot().claimed, false);
    assert.match(broker.setupToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(broker.controlPlane.sessionStore.ownerConfigured(), false);
    assert.equal(broker.controlPlane.sessionStore.owner(), null);
    assert.deepEqual(broker.controlPlane.sessionStore.list(), []);
    assert.equal(
      broker.controlPlane.credentialStore.hasCredential(
        BROWSER_AUTH_STATE_NAMESPACE,
        BROWSER_AUTH_STATE_FIELD
      ),
      true
    );
  } finally {
    if (broker) {
      broker.beginShutdown();
      await broker.drain();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("reset-credentials never modifies an externally managed key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-recover-external-key-"));
  const dataDir = path.join(root, "data");
  const keyPath = path.join(root, "master-key.hex");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const originalKey = `${randomBytes(32).toString("hex")}\n`;
    await writeFile(keyPath, originalKey, { mode: 0o600 });
    const credentials = new CredentialStore(dataDir, { instanceId, keyFilePath: keyPath });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);

    const replacementKey = `${randomBytes(32).toString("hex")}\n`;
    await writeFile(keyPath, replacementKey, { mode: 0o600 });
    const result = await runRecovery("reset-credentials", dataDir, {
      JELLOFIN_COMMAND_MASTER_KEY_FILE: keyPath
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /externally managed master-key file was not modified/u);
    assert.equal(await readFile(keyPath, "utf8"), replacementKey);
    assert.equal(await exists(path.join(dataDir, "credentials.key")), false);
    assert.equal((await quarantineFiles(dataDir, "credentials.key.unrecoverable-")).length, 0);
    assert.equal((await quarantineFiles(dataDir, "credentials.json.unrecoverable-")).length, 1);

    const replacement = new CredentialStore(dataDir, { instanceId, keyFilePath: keyPath });
    assert.deepEqual((await replacement.initialize()).credentials, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
