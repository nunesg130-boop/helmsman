import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRequestBinding,
  canonicalHost,
  canonicalOrigin,
  claimRequestBinding,
  CSRF_HEADER_NAME,
  expiredSessionCookie,
  isSecureApplicationOrigin,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  SessionAuthError,
  SessionAuthStore,
  sessionCookie
} from "../server/session-auth.mjs";

function request(headers = {}) {
  return { headers };
}

function cookieValue(setCookie) {
  const first = setCookie.split(";", 1)[0];
  return first.slice(first.indexOf("=") + 1);
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof SessionAuthError && error.code === code);
}

async function expectCodeAsync(callback, code) {
  await assert.rejects(callback, (error) => error instanceof SessionAuthError && error.code === code);
}

test("origin and Host helpers enforce a first-run-safe exact binding", () => {
  assert.equal(canonicalHost("Command.Example.Test:8443"), "command.example.test:8443");
  assert.equal(canonicalOrigin("https://command.example.test:8443"), "https://command.example.test:8443");
  assert.equal(isSecureApplicationOrigin("https://command.example.test"), true);
  assert.equal(isSecureApplicationOrigin("http://127.0.0.1:4180"), true);
  assert.equal(isSecureApplicationOrigin("http://command.local:4180"), false);
  assert.equal(isSecureApplicationOrigin("https://command.example.test/"), false);

  const local = request({
    host: "127.0.0.1:4180",
    origin: "http://127.0.0.1:4180"
  });
  assert.deepEqual(claimRequestBinding(local, "http://127.0.0.1:4180"), {
    host: "127.0.0.1:4180",
    origin: "http://127.0.0.1:4180"
  });
  expectCode(
    () => claimRequestBinding(local, "http://localhost:4180"),
    "SECURE_ORIGIN_REQUIRED"
  );
  expectCode(
    () => claimRequestBinding(request({ host: "10.44.0.12:4180", origin: "http://10.44.0.12:4180" }), "http://10.44.0.12:4180"),
    "SECURE_ORIGIN_REQUIRED"
  );
  expectCode(
    () => assertRequestBinding(
      request({ host: "command.example.test", origin: "https://evil.example.test" }),
      { host: "command.example.test", origin: "https://command.example.test" },
      { requireOrigin: true }
    ),
    "ORIGIN_REJECTED"
  );
});

test("cookie helpers are HttpOnly and Strict, adding Secure only for HTTPS", () => {
  const token = "a".repeat(43);
  const expiresAt = "2026-10-01T00:00:00.000Z";
  const now = Date.parse("2026-09-01T00:00:00.000Z");
  const local = sessionCookie(token, { origin: "http://127.0.0.1:4180", expiresAt, now });
  assert.match(local, /^JFC_SESSION=a{43}; Path=\/; Max-Age=2592000;/u);
  assert.match(local, /; HttpOnly; SameSite=Strict$/u);
  assert.doesNotMatch(local, /; Secure/u);

  const https = sessionCookie(token, { origin: "https://command.example.test", expiresAt, now });
  assert.match(https, /; HttpOnly; SameSite=Strict; Secure$/u);
  const cleared = expiredSessionCookie({ origin: "https://command.example.test" });
  assert.equal(
    cleared,
    "JFC_SESSION=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict; Secure"
  );

  assert.equal(readSessionCookie(`other=keep; ${SESSION_COOKIE_NAME}=${token}`), token);
  expectCode(() => readSessionCookie(`${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`), "AMBIGUOUS_SESSION_COOKIE");
  expectCode(() => readSessionCookie(`${SESSION_COOKIE_NAME}=not-a-token`), "SESSION_INVALID");
});

test("opaque sessions persist only hashes and authenticate with Origin plus CSRF", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-session-auth-"));
  const dataDir = path.join(root, "data");
  let clock = Date.parse("2026-09-12T12:00:00.000Z");
  const store = new SessionAuthStore(dataDir, { now: () => clock, ttlMs: 60_000 });
  try {
    assert.deepEqual(await store.initialize(), []);
    const issued = await store.issue({
      name: "Primary browser",
      origin: "https://command.example.test"
    });
    assert.equal(issued.session.name, "Primary browser");
    assert.equal(issued.session.origin, "https://command.example.test");
    assert.equal(issued.session.expiresAt, "2026-09-12T12:01:00.000Z");
    assert.match(issued.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.match(issued.cookie, /; HttpOnly; SameSite=Strict; Secure$/u);

    const token = cookieValue(issued.cookie);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
    const serialized = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(issued.csrfToken), false);
    assert.equal(serialized.includes("Primary browser"), true);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dataDir, "sessions.json"))).mode & 0o777, 0o600);

    const browserRequest = request({
      host: "command.example.test",
      origin: "https://command.example.test",
      cookie: `${SESSION_COOKIE_NAME}=${token}; authentik_session=untouched`,
      [CSRF_HEADER_NAME]: issued.csrfToken
    });
    const authenticated = await store.authenticateRequest(browserRequest, { requireCsrf: true });
    assert.deepEqual(authenticated.session, issued.session);
    assert.equal(authenticated.csrfToken, issued.csrfToken);

    await expectCodeAsync(
      () => store.authenticateRequest(request({
        host: "command.example.test",
        origin: "https://command.example.test",
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: "b".repeat(43)
      }), { requireCsrf: true }),
      "CSRF_TOKEN_INVALID"
    );
    await expectCodeAsync(
      () => store.authenticateRequest(request({
        host: "command.example.test",
        origin: "https://evil.example.test",
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
        [CSRF_HEADER_NAME]: issued.csrfToken
      }), { requireCsrf: true }),
      "ORIGIN_REJECTED"
    );
    await expectCodeAsync(
      () => store.authenticateRequest(request({
        host: "127.0.0.1:4180",
        cookie: `${SESSION_COOKIE_NAME}=${token}`
      })),
      "ORIGIN_REJECTED"
    );

    const restarted = new SessionAuthStore(dataDir, { now: () => clock, ttlMs: 60_000 });
    await restarted.initialize();
    assert.deepEqual((await restarted.authenticateToken(token)).session, issued.session);

    clock += 60_001;
    await expectCodeAsync(() => restarted.authenticateToken(token), "SESSION_EXPIRED");
    assert.deepEqual(restarted.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new browser sessions use the one-year default lifetime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-one-year-"));
  const dataDir = path.join(root, "data");
  const clock = Date.parse("2026-09-12T12:00:00.000Z");
  const store = new SessionAuthStore(dataDir, { now: () => clock });
  try {
    await store.initialize();
    const issued = await store.issue({ name: "Long-lived browser", origin: "https://command.example.test" });
    assert.equal(issued.session.expiresAt, "2027-09-12T12:00:00.000Z");
    assert.match(issued.cookie, /; Max-Age=31536000;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid v1 session state migrates to v2 without revoking existing sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-v1-migration-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    const issued = await store.issue({ name: "Beta 8 browser", origin: "https://command.example.test" });
    const token = cookieValue(issued.cookie);
    const legacy = JSON.parse(await readFile(store.filePath, "utf8"));
    legacy.version = 1;
    delete legacy.accessKeyHash;
    await writeFile(store.filePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const restarted = new SessionAuthStore(dataDir);
    assert.deepEqual(await restarted.initialize(), [issued.session]);
    assert.equal((await restarted.authenticateToken(token)).session.id, issued.session.id);
    assert.equal(restarted.accessKeyConfigured(), false);
    const migrated = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.accessKeyHash, null);
    assert.deepEqual(migrated.sessions, legacy.sessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("access keys are hashed, reusable for login, and atomically rotated with sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-access-key-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    assert.equal(store.accessKeyConfigured(), false);
    await expectCodeAsync(
      () => store.login({
        accessKey: "x".repeat(43),
        name: "Unavailable",
        origin: "https://command.example.test"
      }),
      "ACCESS_KEY_NOT_CONFIGURED"
    );

    const claimed = await store.claimAccess({ name: "Primary", origin: "https://command.example.test" });
    assert.match(claimed.accessKey, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(store.accessKeyConfigured(), true);
    const claimedToken = cookieValue(claimed.cookie);
    const persistedAfterClaim = await readFile(store.filePath, "utf8");
    assert.equal(persistedAfterClaim.includes(claimed.accessKey), false);
    assert.equal(persistedAfterClaim.includes(claimedToken), false);
    assert.match(JSON.parse(persistedAfterClaim).accessKeyHash, /^[a-f0-9]{64}$/u);

    await expectCodeAsync(
      () => store.login({
        accessKey: "y".repeat(43),
        name: "Wrong key",
        origin: "https://command.example.test"
      }),
      "ACCESS_KEY_INVALID"
    );
    const second = await store.login({
      accessKey: claimed.accessKey,
      name: "Second browser",
      origin: "https://command.example.test"
    });
    const secondToken = cookieValue(second.cookie);
    assert.notEqual(secondToken, claimedToken);
    assert.equal(store.list().length, 2);

    const rotated = await store.rotateAccessKeyAndIssue({
      name: "Primary after rotation",
      origin: "https://command.example.test",
      currentSessionId: second.session.id
    });
    assert.notEqual(rotated.accessKey, claimed.accessKey);
    assert.equal(store.list().length, 1);
    await expectCodeAsync(() => store.authenticateToken(claimedToken), "SESSION_INVALID");
    await expectCodeAsync(() => store.authenticateToken(secondToken), "SESSION_INVALID");
    await expectCodeAsync(
      () => store.login({
        accessKey: claimed.accessKey,
        name: "Old key",
        origin: "https://command.example.test"
      }),
      "ACCESS_KEY_INVALID"
    );
    const replacement = await store.login({
      accessKey: rotated.accessKey,
      name: "Replacement browser",
      origin: "https://command.example.test"
    });
    assert.equal((await store.authenticateToken(cookieValue(replacement.cookie))).session.name, "Replacement browser");

    assert.equal(await store.clearAccess(), 2);
    assert.equal(store.accessKeyConfigured(), false);
    assert.deepEqual(store.list(), []);
    const cleared = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(cleared.accessKeyHash, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued access-key login and rotation cannot preserve a session minted by an old key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-access-key-race-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    const claimed = await store.claimAccess({ name: "Primary", origin: "https://command.example.test" });

    const loginBeforeRotation = store.login({
      accessKey: claimed.accessKey,
      name: "Queued before rotation",
      origin: "https://command.example.test"
    });
    const firstRotation = store.rotateAccessKey();
    const [issuedBeforeRotation, firstReplacementKey] = await Promise.all([loginBeforeRotation, firstRotation]);
    await expectCodeAsync(
      () => store.authenticateToken(cookieValue(issuedBeforeRotation.cookie)),
      "SESSION_INVALID"
    );
    assert.deepEqual(store.list(), []);

    const secondRotation = store.rotateAccessKey();
    const staleLogin = store.login({
      accessKey: firstReplacementKey,
      name: "Queued after rotation",
      origin: "https://command.example.test"
    });
    const staleLoginRejected = expectCodeAsync(() => staleLogin, "ACCESS_KEY_INVALID");
    const secondReplacementKey = await secondRotation;
    await staleLoginRejected;
    const current = await store.login({
      accessKey: secondReplacementKey,
      name: "Current key",
      origin: "https://command.example.test"
    });
    assert.equal((await store.authenticateToken(cookieValue(current.cookie))).session.name, "Current key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only one concurrent authenticated access-key rotation can succeed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-concurrent-key-rotation-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    const claimed = await store.claimAccess({ name: "Primary", origin: "https://command.example.test" });
    const options = {
      name: claimed.session.name,
      origin: claimed.session.origin,
      currentSessionId: claimed.session.id
    };
    const winnerPromise = store.rotateAccessKeyAndIssue(options);
    const loserPromise = store.rotateAccessKeyAndIssue(options);
    const loserRejected = expectCodeAsync(() => loserPromise, "SESSION_INVALID");
    const winner = await winnerPromise;
    await loserRejected;
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, winner.session.id);
    const login = await store.login({
      accessKey: winner.accessKey,
      name: "Winner key browser",
      origin: "https://command.example.test"
    });
    assert.equal(login.session.name, "Winner key browser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sessions are individually revocable and access reset can revoke all", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-session-revoke-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    const first = await store.issue({ name: "Desktop", origin: "http://127.0.0.1:4180" });
    const second = await store.issue({ name: "Laptop", origin: "https://command.example.test" });
    const firstToken = cookieValue(first.cookie);
    const secondToken = cookieValue(second.cookie);
    assert.equal(store.list().length, 2);

    assert.equal(await store.revoke(first.session.id), true);
    assert.equal(await store.revoke(first.session.id), false);
    await expectCodeAsync(() => store.authenticateToken(firstToken), "SESSION_INVALID");
    assert.equal((await store.authenticateToken(secondToken)).session.id, second.session.id);

    assert.equal(await store.revokeToken(secondToken), true);
    await expectCodeAsync(() => store.authenticateToken(secondToken), "SESSION_INVALID");

    await store.issue({ name: "One", origin: "http://localhost:4180" });
    await store.issue({ name: "Two", origin: "http://localhost:4180" });
    assert.equal(await store.revokeAll(), 2);
    assert.deepEqual(store.list(), []);
    assert.match(store.expiredCookie("http://localhost:4180"), /HttpOnly; SameSite=Strict$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session state validation fails closed on plaintext or malformed records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-session-invalid-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    await writeFile(store.filePath, JSON.stringify({
      version: 1,
      revision: 1,
      sessions: {
        "not-a-uuid": {
          token: "plaintext",
          origin: "https://command.example.test"
        }
      }
    }), { encoding: "utf8" });
    const restarted = new SessionAuthStore(dataDir);
    await assert.rejects(() => restarted.initialize(), /Malformed browser session state/u);

    await writeFile(store.filePath, JSON.stringify({
      version: 2,
      revision: 2,
      accessKeyHash: "plaintext-access-key",
      sessions: {}
    }), { encoding: "utf8" });
    const invalidKeyState = new SessionAuthStore(dataDir);
    await assert.rejects(() => invalidKeyState.initialize(), /Unsupported or malformed session state/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
