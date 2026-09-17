import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function jellyfinPrincipal(overrides = {}) {
  return {
    provider: "jellyfin",
    serverId: "server-0123456789abcdef",
    userId: "user-0123456789abcdef",
    username: "Captain",
    deviceId: "22222222-2222-4222-8222-222222222222",
    jellyfinUrl: "https://jellyfin.example.test",
    targetRevision: "33333333-3333-4333-8333-333333333333",
    boundaryHash: "a".repeat(64),
    verifiedAt: "2026-09-12T12:00:00.000Z",
    ...overrides
  };
}

function jellyfinOwner(overrides = {}) {
  const principal = jellyfinPrincipal(overrides);
  return {
    provider: principal.provider,
    serverId: principal.serverId,
    userId: principal.userId,
    username: principal.username,
    jellyfinUrl: principal.jellyfinUrl,
    targetRevision: principal.targetRevision,
    boundaryHash: principal.boundaryHash
  };
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
    assert.equal(restarted.takePrunedSessions()[0]?.id, issued.session.id);
    assert.deepEqual(restarted.takePrunedSessions(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new browser sessions use a 30-day default lifetime and accept a bounded override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-thirty-days-"));
  const dataDir = path.join(root, "data");
  const clock = Date.parse("2026-09-12T12:00:00.000Z");
  const store = new SessionAuthStore(dataDir, { now: () => clock });
  try {
    await store.initialize();
    const issued = await store.issue({ name: "Long-lived browser", origin: "https://command.example.test" });
    assert.equal(issued.session.expiresAt, "2026-10-12T12:00:00.000Z");
    assert.match(issued.cookie, /; Max-Age=2592000;/u);
    const bootstrap = await store.issue({
      name: "Setup browser",
      origin: "https://command.example.test",
      ttlMs: 60 * 60 * 1_000
    });
    assert.equal(bootstrap.session.expiresAt, "2026-09-12T13:00:00.000Z");
    await assert.rejects(() => store.issue({
      name: "Unsafe lifetime",
      origin: "https://command.example.test",
      ttlMs: 366 * 24 * 60 * 60 * 1_000
    }), /session lifetime is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid v1 session state migrates to sealed-state shape without revoking existing sessions", async () => {
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
    delete legacy.owner;
    delete legacy.integrity;
    for (const record of Object.values(legacy.sessions)) delete record.principal;
    await writeFile(store.filePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const restarted = new SessionAuthStore(dataDir);
    assert.deepEqual(await restarted.initialize(), [issued.session]);
    assert.equal((await restarted.authenticateToken(token)).session.id, issued.session.id);
    assert.equal(restarted.accessKeyConfigured(), false);
    const migrated = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(migrated.version, 4);
    assert.equal(migrated.integrity, null);
    assert.equal(migrated.accessKeyHash, null);
    assert.equal(migrated.owner, null);
    assert.deepEqual(
      migrated.sessions,
      Object.fromEntries(Object.entries(legacy.sessions).map(([id, record]) => [
        id,
        { ...record, principal: null }
      ]))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid v2 access-key state migrates to sealed-state shape and remains available for owner enrollment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-v2-migration-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir);
  try {
    await store.initialize();
    const legacyKey = "a".repeat(43);
    const issued = await store.issue({ name: "Beta 2 browser", origin: "https://command.example.test" });
    const token = cookieValue(issued.cookie);
    const legacy = JSON.parse(await readFile(store.filePath, "utf8"));
    legacy.version = 2;
    legacy.accessKeyHash = createHash("sha256").update(legacyKey, "utf8").digest("hex");
    delete legacy.owner;
    delete legacy.integrity;
    for (const record of Object.values(legacy.sessions)) delete record.principal;
    await writeFile(store.filePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const restarted = new SessionAuthStore(dataDir);
    assert.equal((await restarted.initialize()).length, 1);
    assert.equal((await restarted.authenticateToken(token)).session.id, issued.session.id);
    assert.equal(restarted.accessKeyConfigured(), true);
    assert.equal(restarted.ownerConfigured(), false);
    const additional = await restarted.login({
      accessKey: legacyKey,
      name: "Migration browser",
      origin: "https://command.example.test"
    });
    assert.equal(additional.session.name, "Migration browser");

    const migrated = JSON.parse(await readFile(store.filePath, "utf8"));
    assert.equal(migrated.version, 4);
    assert.equal(migrated.integrity, null);
    assert.equal(migrated.owner, null);
    assert.match(migrated.accessKeyHash, /^[a-f0-9]{64}$/u);
    assert.equal(Object.values(migrated.sessions).every((record) => record.principal === null), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner enrollment atomically replaces legacy access with one bound Jellyfin session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-enrollment-"));
  const dataDir = path.join(root, "data");
  let clock = Date.parse("2026-09-12T12:00:00.000Z");
  let store = new SessionAuthStore(dataDir, { now: () => clock });
  const enrolledSessionId = "11111111-1111-4111-8111-111111111111";
  try {
    await store.initialize();
    const legacyKey = "b".repeat(43);
    const claimed = await store.issue({ name: "Legacy primary", origin: "https://command.example.test" });
    const legacyState = JSON.parse(await readFile(store.filePath, "utf8"));
    legacyState.version = 2;
    legacyState.accessKeyHash = createHash("sha256").update(legacyKey, "utf8").digest("hex");
    delete legacyState.owner;
    delete legacyState.integrity;
    for (const record of Object.values(legacyState.sessions)) delete record.principal;
    await writeFile(store.filePath, `${JSON.stringify(legacyState)}\n`, { encoding: "utf8", mode: 0o600 });
    store = new SessionAuthStore(dataDir, { now: () => clock });
    await store.initialize();
    const legacySecond = await store.login({
      accessKey: legacyKey,
      name: "Legacy second",
      origin: "https://command.example.test"
    });
    const claimedToken = cookieValue(claimed.cookie);
    const secondToken = cookieValue(legacySecond.cookie);

    const enrolled = await store.enrollOwnerAndIssue({
      owner: jellyfinOwner(),
      principal: jellyfinPrincipal(),
      sessionId: enrolledSessionId,
      name: "Captain's browser",
      origin: "https://command.example.test"
    });
    const enrolledToken = cookieValue(enrolled.cookie);
    assert.equal(enrolled.session.id, enrolledSessionId);
    assert.equal(enrolled.session.provider, "jellyfin");
    assert.deepEqual(enrolled.session.user, { provider: "jellyfin", name: "Captain" });
    assert.equal(enrolled.session.expiresAt, "2026-10-12T12:00:00.000Z");
    assert.equal(store.ownerConfigured(), true);
    assert.equal(store.accessKeyConfigured(), false);
    assert.deepEqual(store.owner(), {
      provider: "jellyfin",
      serverId: "server-0123456789abcdef",
      userId: "user-0123456789abcdef",
      username: "Captain",
      jellyfinUrl: "https://jellyfin.example.test",
      targetRevision: "33333333-3333-4333-8333-333333333333",
      boundaryHash: "a".repeat(64),
      enrolledAt: "2026-09-12T12:00:00.000Z"
    });
    assert.equal(store.ownerMatches(jellyfinPrincipal({ username: "A later display name" })), true);
    assert.equal(store.ownerMatches(jellyfinPrincipal({ userId: "somebody-else" })), false);
    assert.equal(store.list().length, 1);
    assert.equal(store.internalSessions().length, 1);
    assert.deepEqual(store.getInternalSession(enrolledSessionId)?.principal, jellyfinPrincipal());

    const publicJson = JSON.stringify(enrolled.session);
    assert.equal(publicJson.includes("server-0123456789abcdef"), false);
    assert.equal(publicJson.includes("user-0123456789abcdef"), false);
    assert.equal(publicJson.includes("22222222-2222-4222-8222-222222222222"), false);
    assert.equal(publicJson.includes("jellyfin.example.test"), false);
    assert.equal(publicJson.includes("verifiedAt"), false);
    const persisted = await readFile(store.filePath, "utf8");
    assert.equal(persisted.includes(enrolledToken), false);
    assert.equal(persisted.includes(legacyKey), false);

    await expectCodeAsync(() => store.authenticateToken(claimedToken), "SESSION_INVALID");
    await expectCodeAsync(() => store.authenticateToken(secondToken), "SESSION_INVALID");
    await expectCodeAsync(() => store.login({
      accessKey: legacyKey,
      name: "Legacy login",
      origin: "https://command.example.test"
    }), "ACCESS_KEY_NOT_CONFIGURED");
    assert.equal((await store.authenticateToken(enrolledToken)).session.id, enrolledSessionId);

    await expectCodeAsync(() => store.enrollOwnerAndIssue({
      owner: jellyfinOwner(),
      principal: jellyfinPrincipal({ deviceId: "33333333-3333-4333-8333-333333333333" }),
      name: "Duplicate enrollment",
      origin: "https://command.example.test"
    }), "OWNER_ALREADY_CONFIGURED");
    assert.equal(store.list().length, 1);
    await expectCodeAsync(() => store.issue({
      name: "Unbound session",
      origin: "https://command.example.test"
    }), "JELLYFIN_AUTH_REQUIRED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner login checks stable IDs, accepts a renamed owner, and records revalidation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-login-"));
  const dataDir = path.join(root, "data");
  let clock = Date.parse("2026-09-12T12:00:00.000Z");
  const store = new SessionAuthStore(dataDir, { now: () => clock });
  try {
    await store.initialize();
    await store.enrollOwnerAndIssue({
      owner: jellyfinOwner(),
      principal: jellyfinPrincipal(),
      sessionId: "11111111-1111-4111-8111-111111111111",
      name: "Enrollment browser",
      origin: "https://command.example.test"
    });

    await expectCodeAsync(() => store.loginOwner({
      principal: jellyfinPrincipal({
        userId: "user-that-is-not-the-owner",
        deviceId: "33333333-3333-4333-8333-333333333333"
      }),
      name: "Wrong Jellyfin user",
      origin: "https://command.example.test"
    }), "JELLYFIN_OWNER_MISMATCH");
    assert.equal(store.list().length, 1);

    const loginSessionId = "44444444-4444-4444-8444-444444444444";
    const loggedIn = await store.loginOwner({
      principal: jellyfinPrincipal({
        username: "Admiral",
        deviceId: "33333333-3333-4333-8333-333333333333"
      }),
      sessionId: loginSessionId,
      ttlMs: 2 * 60 * 60 * 1_000,
      name: "Laptop",
      origin: "https://command.example.test"
    });
    assert.equal(loggedIn.session.id, loginSessionId);
    assert.deepEqual(loggedIn.session.user, { provider: "jellyfin", name: "Admiral" });
    assert.equal(loggedIn.session.expiresAt, "2026-09-12T14:00:00.000Z");
    assert.equal(store.owner().username, "Admiral");
    await expectCodeAsync(() => store.loginOwner({
      principal: jellyfinPrincipal({
        username: "Admiral",
        deviceId: "55555555-5555-4555-8555-555555555555"
      }),
      sessionId: loginSessionId,
      name: "Conflicting ID",
      origin: "https://command.example.test"
    }), "SESSION_ID_CONFLICT");

    clock = Date.parse("2026-09-12T12:30:00.000Z");
    const verified = await store.markVerified(loginSessionId, {
      provider: "jellyfin",
      serverId: "server-0123456789abcdef",
      userId: "user-0123456789abcdef",
      username: "Commander"
    });
    assert.equal(verified.session.user.name, "Commander");
    assert.equal(verified.principal.verifiedAt, "2026-09-12T12:30:00.000Z");
    assert.equal(verified.owner.username, "Commander");
    assert.equal(store.getInternalSession(loginSessionId).principal.verifiedAt, "2026-09-12T12:30:00.000Z");
    assert.equal(store.list().find((session) => session.id === loginSessionId)?.user.name, "Commander");

    await expectCodeAsync(() => store.markVerified(
      "11111111-1111-4111-8111-111111111111",
      {
        provider: "jellyfin",
        serverId: "different-server",
        userId: "user-0123456789abcdef",
        username: "Commander"
      }
    ), "JELLYFIN_OWNER_MISMATCH");

    assert.equal(await store.clearAuthentication(), 2);
    assert.equal(store.ownerConfigured(), false);
    assert.equal(store.accessKeyConfigured(), false);
    assert.deepEqual(store.list(), []);
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

test("v3 state rejects leaked token fields and sessions bound to a different owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-v3-invalid-"));
  const dataDir = path.join(root, "data");
  const store = new SessionAuthStore(dataDir, { now: () => Date.parse("2026-09-12T12:00:00.000Z") });
  try {
    await store.initialize();
    const issued = await store.enrollOwnerAndIssue({
      owner: jellyfinOwner(),
      principal: jellyfinPrincipal(),
      name: "Owner browser",
      origin: "https://command.example.test"
    });
    const valid = JSON.parse(await readFile(store.filePath, "utf8"));

    const leaked = structuredClone(valid);
    leaked.sessions[issued.session.id].principal.accessToken = "plaintext-jellyfin-token";
    await writeFile(store.filePath, `${JSON.stringify(leaked)}\n`, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      () => new SessionAuthStore(dataDir).initialize(),
      /Malformed browser session state/u
    );

    const mismatched = structuredClone(valid);
    mismatched.owner.userId = "a-different-owner";
    await writeFile(store.filePath, `${JSON.stringify(mismatched)}\n`, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      () => new SessionAuthStore(dataDir).initialize(),
      /Malformed browser session state/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
