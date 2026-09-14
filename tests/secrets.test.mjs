import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialStore } from "../server/secrets.mjs";

const INSTANCE_ID = "12345678-1234-4123-8123-123456789abc";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jellofin-secrets-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function valueFrom(store, service, field) {
  return store.useCredential(service, field, (value) => value.toString("utf8"));
}

function flipBase64url(value) {
  const replacement = value[0] === "A" ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}

test("auto-generates protected files and encrypts each value with a unique nonce", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID, now: () => 1_700_000_000_000 });
  assert.deepEqual(await store.initialize(), { schema: 1, revision: 0, credentials: {} });

  const secret = "same-secret-value-that-must-not-persist";
  const metadata = await store.setCredentials("radarr", { apiKey: secret, password: secret });
  assert.deepEqual(Object.keys(metadata), ["apiKey", "password"]);
  assert.equal(metadata.apiKey.configured, true);
  assert.equal(metadata.apiKey.revision, 1);

  const serialized = await readFile(path.join(directory, "credentials.json"), "utf8");
  const document = JSON.parse(serialized);
  assert.equal(serialized.includes(secret), false);
  assert.equal(document.credentials.radarr.apiKey.algorithm, "AES-256-GCM");
  assert.notEqual(document.credentials.radarr.apiKey.nonce, document.credentials.radarr.password.nonce);
  assert.notEqual(document.credentials.radarr.apiKey.ciphertext, document.credentials.radarr.password.ciphertext);
  assert.notEqual(document.integrity.nonce, document.credentials.radarr.apiKey.nonce);

  const publicState = store.publicSnapshot();
  const publicText = JSON.stringify(publicState);
  assert.equal(publicText.includes(secret), false);
  assert.equal(publicText.includes("ciphertext"), false);
  assert.equal(publicText.includes("nonce"), false);
  assert.equal(publicText.includes("tag"), false);
  assert.equal(await valueFrom(store, "radarr", "apiKey"), secret);

  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "credentials.key"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, "credentials.json"))).mode & 0o777, 0o600);
  }
});

test("persists encrypted credentials across restarts without exposing a read method", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await first.initialize();
  const written = await first.setCredential("jellyfin", "token", "persistent-token");
  assert.deepEqual(Object.keys(written), ["configured", "revision", "updatedAt"]);
  assert.equal(written.configured, true);
  await first.close();

  const second = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  const metadata = await second.initialize();
  assert.equal(metadata.credentials.jellyfin.token.configured, true);
  assert.equal(typeof second.getCredential, "undefined");
  assert.equal(await valueFrom(second, "jellyfin", "token"), "persistent-token");
});

test("serializes concurrent mutations and leaves no temporary persistence files", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await store.initialize();

  await Promise.all([
    store.setCredential("seerr", "apiKey", "seerr-key"),
    store.setCredential("sonarr", "apiKey", "sonarr-key"),
    store.setCredential("qbittorrent", "password", "qbit-password")
  ]);

  assert.equal(store.publicSnapshot().revision, 3);
  assert.equal(await valueFrom(store, "seerr", "apiKey"), "seerr-key");
  assert.equal(await valueFrom(store, "sonarr", "apiKey"), "sonarr-key");
  assert.equal(await valueFrom(store, "qbittorrent", "password"), "qbit-password");
  assert.deepEqual((await readdir(directory)).sort(), ["credentials.json", "credentials.key"]);
});

test("loads an explicitly configured key and never silently creates a missing one", async (t) => {
  const directory = await temporaryDirectory(t);
  const keyPath = path.join(directory, "operator-provided.key");
  await writeFile(keyPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o400 });

  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID, keyFilePath: keyPath });
  await store.initialize();
  await store.setCredential("prowlarr", "apiKey", "configured-key-secret");
  assert.equal(await valueFrom(store, "prowlarr", "apiKey"), "configured-key-secret");
  assert.equal((await readdir(directory)).includes("credentials.key"), false);

  const missingDirectory = await temporaryDirectory(t);
  const missingKeyPath = path.join(missingDirectory, "missing.key");
  const unavailable = new CredentialStore(missingDirectory, {
    instanceId: INSTANCE_ID,
    keyFilePath: missingKeyPath
  });
  await assert.rejects(unavailable.initialize(), (error) => {
    assert.equal(error.code, "CREDENTIAL_KEY_UNAVAILABLE");
    assert.equal(error.message.includes(missingKeyPath), false);
    return true;
  });
  assert.equal((await readdir(missingDirectory)).includes("credentials.key"), false);

  assert.throws(
    () => new CredentialStore(missingDirectory, { instanceId: INSTANCE_ID, keyFilePath: "relative.key" }),
    { code: "INVALID_KEY_PATH" }
  );
});

test("a wrong key fails closed without modifying the encrypted store", async (t) => {
  const directory = await temporaryDirectory(t);
  const keyPath = path.join(directory, "external.key");
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  const first = new CredentialStore(directory, { instanceId: INSTANCE_ID, keyFilePath: keyPath });
  await first.initialize();
  await first.setCredential("bazarr", "apiKey", "wrong-key-test-secret");
  await first.close();

  const before = await readFile(path.join(directory, "credentials.json"));
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
  const wrongKey = new CredentialStore(directory, { instanceId: INSTANCE_ID, keyFilePath: keyPath });
  await assert.rejects(wrongKey.initialize(), (error) => {
    assert.equal(error.code, "CREDENTIAL_STORE_AUTH_FAILED");
    assert.equal(error.message.includes("wrong-key-test-secret"), false);
    return true;
  });
  assert.deepEqual(await readFile(path.join(directory, "credentials.json")), before);
});

test("ciphertext, bound metadata, and record deletion tampering all fail closed", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await store.initialize();
  await store.setCredential("seerr", "apiKey", "tamper-test-secret");
  await store.close();

  const filePath = path.join(directory, "credentials.json");
  const original = await readFile(filePath, "utf8");
  const mutations = [
    (document) => {
      document.credentials.seerr.apiKey.ciphertext = flipBase64url(document.credentials.seerr.apiKey.ciphertext);
    },
    (document) => {
      document.credentials.seerr.apiKey.updatedAt = "2024-01-01T00:00:00.000Z";
    },
    (document) => {
      delete document.credentials.seerr.apiKey;
    },
    (document) => {
      document.credentials.radarr = document.credentials.seerr;
      delete document.credentials.seerr;
    },
    (document) => {
      document.unrecognized = true;
    },
    (document) => {
      document.credentials.empty = {};
    }
  ];

  for (const mutate of mutations) {
    const document = JSON.parse(original);
    mutate(document);
    await writeFile(filePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    const tampered = new CredentialStore(directory, { instanceId: INSTANCE_ID });
    await assert.rejects(tampered.initialize(), (error) => {
      assert.ok(["CREDENTIAL_STORE_AUTH_FAILED", "CREDENTIAL_STORE_MALFORMED"].includes(error.code));
      assert.equal(error.message.includes("tamper-test-secret"), false);
      return true;
    });
    await writeFile(filePath, original, { mode: 0o600 });
  }
});

test("consumer failures preserve typed transport codes and decrypted buffers are zeroized", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await store.initialize();
  const secret = "consumer-secret-not-for-errors";
  await store.setCredential("jellyfin", "token", secret);

  let borrowed;
  const transportFailure = Object.assign(new Error("safe internal transport failure"), {
    code: "UPSTREAM_TIMEOUT"
  });
  await assert.rejects(
    store.useCredential("jellyfin", "token", (value) => {
      borrowed = value;
      throw transportFailure;
    }),
    (error) => {
      assert.equal(error, transportFailure);
      assert.equal(error.code, "UPSTREAM_TIMEOUT");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
  assert.ok(borrowed.every((byte) => byte === 0));
});

test("replacement removes stale auth fields and deletion exposes metadata only", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await store.initialize();
  await store.setCredentials("qbittorrent", { username: "operator", password: "old-password" });
  await store.replaceServiceCredentials("qbittorrent", { apiKey: "qbt_1234567890123456789012345678" });

  assert.equal(store.hasCredential("qbittorrent", "username"), false);
  assert.equal(store.hasCredential("qbittorrent", "password"), false);
  assert.equal(store.hasCredential("qbittorrent", "apiKey"), true);
  await assert.rejects(valueFrom(store, "qbittorrent", "password"), { code: "CREDENTIAL_NOT_CONFIGURED" });

  const beforeMissingDelete = store.publicSnapshot().revision;
  assert.deepEqual(await store.removeCredential("qbittorrent", "password"), { removed: false });
  assert.equal(store.publicSnapshot().revision, beforeMissingDelete);
  assert.deepEqual(await store.removeServiceCredentials("qbittorrent"), { removed: true });
  assert.deepEqual(store.publicSnapshot().credentials, {});
});

test("credential namespace capacity allows 80-record policy staging with bounded headroom", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new CredentialStore(directory, { instanceId: INSTANCE_ID });
  await store.initialize();

  for (let index = 0; index < 96; index += 1) {
    await store.setCredential(`namespace-${String(index).padStart(2, "0")}`, "token", `secret-${index}`);
  }
  assert.equal(Object.keys(store.publicSnapshot().credentials).length, 96);

  await assert.rejects(
    store.setCredential("namespace-overflow", "token", "overflow-secret"),
    { code: "CREDENTIAL_STORE_MALFORMED" }
  );
  assert.equal(Object.keys(store.publicSnapshot().credentials).length, 96);
});
