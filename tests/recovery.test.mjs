import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CredentialStore } from "../server/secrets.mjs";
import { SessionAuthStore } from "../server/session-auth.mjs";
import { StateStore } from "../server/state.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_SECRET = "recovery-test-secret-must-never-be-printed";

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
  return sessions.claimAccess({
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
    assert.equal(resetSessions.version, 2);
    assert.equal(resetSessions.accessKeyHash, null);
    assert.deepEqual(resetSessions.sessions, {});
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.json")), credentialDocument);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.key")), credentialKey);

    const quarantined = await quarantineFiles(dataDir, "sessions.json.corrupt-");
    assert.equal(quarantined.length, 1);
    assert.deepEqual(await readFile(path.join(dataDir, quarantined[0])), malformedSessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotate-access-key revokes sessions and preserves claimed configuration and credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-recover-access-key-"));
  const dataDir = path.join(root, "data");
  try {
    const state = await createState(dataDir);
    const instanceId = state.snapshot().instanceId;
    const credentials = new CredentialStore(dataDir, { instanceId });
    await credentials.initialize();
    await credentials.setCredential("radarr", "apiKey", SERVICE_SECRET);
    const previous = await createSession(dataDir);
    const previousToken = previous.cookie.split(";", 1)[0].split("=", 2)[1];

    const originalState = await readFile(path.join(dataDir, "state.json"));
    const originalCredentials = await readFile(path.join(dataDir, "credentials.json"));
    const originalCredentialKey = await readFile(path.join(dataDir, "credentials.key"));
    const result = await runRecovery("rotate-access-key", dataDir);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    const matches = [...result.stdout.matchAll(/Helmsman access key: ([A-Za-z0-9_-]{43})/gu)];
    assert.equal(matches.length, 1);
    const replacementKey = matches[0][1];
    assert.doesNotMatch(result.stderr, new RegExp(replacementKey, "u"));
    assert.match(result.stdout, /All existing browser sessions were revoked/u);

    assert.deepEqual(await readFile(path.join(dataDir, "state.json")), originalState);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.json")), originalCredentials);
    assert.deepEqual(await readFile(path.join(dataDir, "credentials.key")), originalCredentialKey);
    const sessionDocument = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    assert.equal(sessionDocument.includes(replacementKey), false);
    assert.equal(sessionDocument.includes(previous.accessKey), false);
    assert.equal(sessionDocument.includes(previousToken), false);
    const persisted = JSON.parse(sessionDocument);
    assert.equal(persisted.version, 2);
    assert.match(persisted.accessKeyHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(persisted.sessions, {});

    const sessions = new SessionAuthStore(dataDir);
    await sessions.initialize();
    await assert.rejects(
      () => sessions.login({
        accessKey: previous.accessKey,
        name: "Old key",
        origin: "http://127.0.0.1:4180"
      }),
      { code: "ACCESS_KEY_INVALID" }
    );
    const replacement = await sessions.login({
      accessKey: replacementKey,
      name: "Replacement",
      origin: "http://127.0.0.1:4180"
    });
    assert.equal(replacement.session.name, "Replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotate-access-key refuses an unclaimed instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-recover-unclaimed-key-"));
  const dataDir = path.join(root, "data");
  try {
    const state = new StateStore(dataDir);
    await state.initialize();
    const result = await runRecovery("rotate-access-key", dataDir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires a claimed Helmsman instance/u);
    assert.doesNotMatch(result.stdout, /Helmsman access key:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset-credentials quarantines the local encrypted store and key without resetting access", async () => {
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
