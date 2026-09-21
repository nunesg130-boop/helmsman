import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBroker, createHttpServer } from "../server/broker.mjs";
import { createControlPlane } from "../server/control-plane.mjs";
import { connectionAuthorizationBoundaryHash } from "../server/network.mjs";
import { CredentialStore } from "../server/secrets.mjs";
import { SessionAuthError } from "../server/session-auth.mjs";
import { StateStore } from "../server/state.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_POLICY = Object.freeze({
  allowedCidrs: ["10.0.0.0/8"],
  allowPublicHttps: false
});
const SERVICE_SECRET = "control-plane-test-credential-do-not-store-plaintext";
const OWNER_USERNAME = "helmsman-owner";
const OWNER_PASSWORD = "helmsman-owner-password-must-not-persist";
const OWNER_TOKEN = "helmsman-owner-token-must-remain-encrypted";
const OWNER_SERVER_ID = "jellyfin-server-1";
const OWNER_USER_ID = "jellyfin-owner-user-1";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request(port, pathname, options = {}) {
  const body = options.body === undefined
    ? null
    : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(String(options.body), "utf8");
  const headers = {
    Host: `127.0.0.1:${port}`,
    ...(options.headers || {})
  };
  if (body && headers["Content-Length"] === undefined && headers["content-length"] === undefined) {
    headers["Content-Length"] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers,
      agent: false
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const contentType = String(response.headers["content-type"] || "");
        let json = null;
        if (bytes.length && contentType.includes("application/json")) {
          try {
            json = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve({ status: response.statusCode, headers: response.headers, bytes, json });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

function jsonRequest(context, pathname, method, payload, options = {}) {
  return request(context.port, pathname, {
    method,
    headers: {
      Origin: options.origin ?? context.origin,
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.csrf ? { "X-Jellofin-Csrf": options.csrf } : {}),
      ...(options.headers || {})
    },
    body: JSON.stringify(payload)
  });
}

function getRequest(context, pathname, options = {}) {
  return request(context.port, pathname, {
    headers: {
      ...(options.origin ? { Origin: options.origin } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers || {})
    }
  });
}

function cookiePair(response) {
  const raw = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"];
  assert.equal(typeof raw, "string", "response did not issue a session cookie");
  return raw.split(";", 1)[0];
}

function cookieToken(cookie) {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function browserTokenConfigured(context, sessionId) {
  const namespace = `browser-auth-${sessionId}`;
  const fields = context.broker.controlPlane.credentialStore
    .publicSnapshot().credentials?.[namespace] || {};
  return Object.entries(fields).some(([field, metadata]) => (
    /^token_[a-f0-9]{56}$/u.test(field) && metadata?.configured === true
  ));
}

function monitoringCredentialNamespace(service, connection, policy) {
  const binding = JSON.stringify({
    url: connection.url,
    targetRevision: connection.targetRevision,
    authMode: connection.authMode,
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(connection.approvedHostCidrs || [])].sort()
  });
  const targetDigest = createHash("sha256")
    .update(binding, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-b3-${targetDigest}`;
}

function policyBoundMonitoringCredentialNamespaceV2(service, connection, policy) {
  const binding = JSON.stringify({
    url: connection.url,
    authMode: connection.authMode,
    allowedCidrs: [...(policy.allowedCidrs || [])].sort(),
    allowPublicHttps: policy.allowPublicHttps === true,
    approvedHostCidrs: [...(connection.approvedHostCidrs || [])].sort()
  });
  const targetDigest = createHash("sha256")
    .update(binding, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-b2-${targetDigest}`;
}

function legacyMonitoringCredentialNamespace(service, connection) {
  const targetDigest = createHash("sha256")
    .update(connection.url, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `${service}-${targetDigest}`;
}

async function startBroker(dataDir, logs, options = {}) {
  const defaultLookup = async (hostname) => {
    if (hostname === "media.test") return [{ address: "10.20.30.40", family: 4 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  const broker = await createBroker({
    dataDir,
    rootDir: PROJECT_ROOT,
    lookup: options.lookup || defaultLookup,
    dispatchUpstream: options.dispatchUpstream || (async () => ({
      status: 200,
      body: Buffer.from('{"ok":true}', "utf8"),
      contentType: "application/json",
      cookies: []
    })),
    ...(options.broker || {}),
    log: (message) => logs.push(String(message))
  });
  const server = createHttpServer(broker.handler);
  const port = await listen(server);
  return {
    broker,
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    logs
  };
}

function radarrProbeBody(route, secretMarker) {
  if (route.upstreamPath === "/api/v3/system/status") {
    return { version: "6.3.0.10514", appName: "Radarr", startupPath: secretMarker };
  }
  if (route.upstreamPath === "/api/v3/health") {
    return [];
  }
  if (route.upstreamPath === "/api/v3/queue") {
    return { totalRecords: 0, records: [], upstreamSecret: secretMarker };
  }
  if (route.upstreamPath === "/api/v3/movie" || route.upstreamPath === "/api/v3/calendar") {
    return [];
  }
  throw new Error("unexpected draft connection-test route");
}

async function stopBroker(context) {
  if (!context) return;
  context.broker.beginShutdown();
  await close(context.server);
  await context.broker.drain();
}

async function claim(context, deviceName = "Control-plane browser", policy = PRIVATE_POLICY) {
  const response = await jsonRequest(context, "/api/v2/setup/claim", "POST", {
    setupToken: context.broker.setupToken,
    deviceName,
    origin: context.origin,
    ...policy
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return {
    response,
    cookie: cookiePair(response),
    csrf: response.json.csrfToken
  };
}

function jellyfinUser({
  serverId = OWNER_SERVER_ID,
  userId = OWNER_USER_ID,
  username = OWNER_USERNAME,
  administrator = true,
  disabled = false
} = {}) {
  return {
    ServerId: serverId,
    User: {
      Id: userId,
      Name: username,
      Policy: {
        IsAdministrator: administrator,
        IsDisabled: disabled
      }
    }
  };
}

async function saveJellyfin(context, authentication, credential = "jellyfin-monitoring-token") {
  return jsonRequest(context, "/api/v2/services/jellyfin", "PUT", {
    url: "http://media.test:8096",
    authMode: "token",
    credential,
    clearCredential: false,
    monitoringEnabled: false
  }, authentication);
}

async function enrollJellyfinOwner(context, authentication, options = {}) {
  return jsonRequest(context, "/api/v2/auth/jellyfin/enroll", "POST", {
    username: options.username ?? OWNER_USERNAME,
    password: options.password ?? OWNER_PASSWORD,
    deviceName: options.deviceName ?? "Owner browser",
    origin: context.origin
  }, authentication);
}

async function loginJellyfinOwner(context, options = {}) {
  return jsonRequest(context, "/api/v2/auth/jellyfin/login", "POST", {
    username: options.username ?? OWNER_USERNAME,
    password: options.password ?? OWNER_PASSWORD,
    deviceName: options.deviceName ?? "Signed-in browser",
    origin: context.origin
  });
}

async function createPersistedJellyfinOwner(dataDir) {
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected owner-state setup route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context, "Integrity setup browser");
    const saved = await saveJellyfin(context, bootstrap, "integrity-monitor-token");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap, {
      deviceName: "Integrity owner browser"
    });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    return {
      cookie: cookiePair(enrollment),
      sessionId: enrollment.json.session.id
    };
  } finally {
    await stopBroker(context).catch(() => {});
  }
}

async function saveRadarr(context, authentication, credential = SERVICE_SECRET) {
  return jsonRequest(context, "/api/v2/services/radarr", "PUT", {
    url: "http://media.test:7878",
    authMode: "apiKey",
    credential,
    clearCredential: false,
    monitoringEnabled: true
  }, authentication);
}

function runResetAccess(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/index.mjs", "reset-access", "--confirm"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        JELLOFIN_COMMAND_DATA_DIR: dataDir
      },
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

async function assertFilesDoNotContain(directory, forbiddenValues) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertFilesDoNotContain(filePath, forbiddenValues);
      continue;
    }
    if (!entry.isFile()) continue;
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      // Atomic persistence may rename a private temporary file between the
      // directory listing and this read. A vanished file contains nothing to
      // inspect; every stable file is still checked below.
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const forbidden of forbiddenValues) {
      assert.equal(
        bytes.includes(Buffer.from(forbidden, "utf8")),
        false,
        `${filePath} persisted a forbidden plaintext value`
      );
    }
  }
}

test("local service images support cacheable GET, HEAD, and conditional requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-service-assets-"));
  const dataDir = path.join(root, "data");
  let context;

  try {
    context = await startBroker(dataDir, []);
    const assets = [
      ["/assets/services/prowlarr.png", "image/png"],
      ["/assets/services/jellyfin.svg", "image/svg+xml; charset=utf-8"],
      ["/assets/services/seerr.svg", "image/svg+xml; charset=utf-8"],
      ["/assets/services/radarr.svg", "image/svg+xml; charset=utf-8"],
      ["/assets/services/sonarr.svg", "image/svg+xml; charset=utf-8"]
    ];

    for (const [pathname, contentType] of assets) {
      const fetched = await request(context.port, pathname);
      assert.equal(fetched.status, 200, pathname);
      assert.equal(fetched.headers["content-type"], contentType, pathname);
      assert.equal(fetched.headers["x-content-type-options"], "nosniff", pathname);
      assert.equal(fetched.headers["cache-control"], "private, max-age=86400", pathname);
      assert.match(fetched.headers.etag, /^"[A-Za-z0-9_-]{43}"$/u, pathname);
      assert.ok(fetched.bytes.length > 0, pathname);

      const head = await request(context.port, pathname, { method: "HEAD" });
      assert.equal(head.status, 200, pathname);
      assert.equal(head.headers["content-type"], contentType, pathname);
      assert.equal(head.headers["x-content-type-options"], "nosniff", pathname);
      assert.equal(head.headers["cache-control"], "private, max-age=86400", pathname);
      assert.equal(head.headers.etag, fetched.headers.etag, pathname);
      assert.equal(Number(head.headers["content-length"]), fetched.bytes.length, pathname);
      assert.equal(head.bytes.length, 0, pathname);

      for (const method of ["GET", "HEAD"]) {
        const notModified = await request(context.port, pathname, {
          method,
          headers: { "If-None-Match": fetched.headers.etag }
        });
        assert.equal(notModified.status, 304, `${method} ${pathname}`);
        assert.equal(notModified.headers["content-type"], contentType, `${method} ${pathname}`);
        assert.equal(notModified.headers["x-content-type-options"], "nosniff", `${method} ${pathname}`);
        assert.equal(notModified.headers["cache-control"], "private, max-age=86400", `${method} ${pathname}`);
        assert.equal(notModified.headers.etag, fetched.headers.etag, `${method} ${pathname}`);
        assert.equal(notModified.bytes.length, 0, `${method} ${pathname}`);
      }
    }
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 control plane keeps browser and service secrets out of public and persistent state", async (suite) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-control-plane-"));
  const dataDir = path.join(root, "data");
  const logs = [];
  const loginCalls = [];
  const logoutCalls = [];
  let context;
  let authentication;

  try {
    context = await startBroker(dataDir, logs, {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          const payload = JSON.parse(input.body.toString("utf8"));
          loginCalls.push({
            authorization: String(input.request.headers.authorization || ""),
            body: input.body,
            payload
          });
          assert.deepEqual(payload, { Username: OWNER_USERNAME, Pw: OWNER_PASSWORD });
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: OWNER_TOKEN,
              ...jellyfinUser()
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Users/Me") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify(jellyfinUser().User), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          logoutCalls.push(String(input.request.headers.authorization || ""));
          return {
            status: 204,
            body: Buffer.alloc(0),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected owner-auth route ${input.route.upstreamPath}`);
      }
    });

    await suite.test("public status describes setup without exposing the setup token", async () => {
      const status = await getRequest(context, "/api/v2/status");
      assert.equal(status.status, 200);
      assert.equal(status.json.version, context.broker.version);
      assert.equal(status.json.setupRequired, true);
      assert.deepEqual(status.json.authentication, {
        provider: null,
        configured: false,
        ownerName: null,
        legacyAccessKeyAvailable: false
      });
      assert.equal(Object.hasOwn(status.json, "accessKeyConfigured"), false);
      assert.equal(status.json.authenticated, false);
      assert.equal(status.json.session, null);
      assert.equal(status.json.csrfToken, null);
      assert.equal(status.json.storage.credentialsEncrypted, true);
      assert.equal(JSON.stringify(status.json).includes(context.broker.setupToken), false);
    });

    await suite.test("legacy browser-credential, pairing, and bridge surfaces are not exposed", async () => {
      const paths = [
        "/api/v1/status",
        "/api/v1/setup/claim",
        "/api/v1/config",
        "/api/v1/connections/radarr",
        "/bridge/radarr/api/v3/system/status",
        "/api/v2/session/invite",
        "/api/v2/session/pair"
      ];
      for (const pathname of paths) {
        const response = await getRequest(context, pathname);
        assert.equal(response.status, 404, pathname);
        assert.equal(response.json?.code, "NOT_FOUND", pathname);
      }
      for (const pathname of [
        "/bridge/jellyfin/Users/AuthenticateByName",
        "/bridge/seerr/api/v1/auth/local"
      ]) {
        const response = await request(context.port, pathname, {
          method: "POST",
          headers: {
            Origin: context.origin,
            "Content-Type": "application/json",
            Authorization: "MediaBrowser Token=must-not-forward",
            "X-Api-Key": "must-not-forward"
          },
          body: "{}"
        });
        assert.equal(response.status, 404, pathname);
        assert.equal(response.json?.code, "NOT_FOUND", pathname);
      }
    });

    await suite.test("claim issues a one-hour bootstrap session without creating a reusable key", async () => {
      authentication = await claim(context);
      const setCookie = authentication.response.headers["set-cookie"][0];
      const token = cookieToken(authentication.cookie);

      assert.match(authentication.cookie, /^JFC_SESSION=[A-Za-z0-9_-]{43}$/u);
      assert.match(setCookie, /; Max-Age=3600;/u);
      assert.match(setCookie, /; HttpOnly; SameSite=Strict$/u);
      assert.doesNotMatch(setCookie, /; Secure(?:;|$)/u, "localhost HTTP cookies must remain usable");
      assert.match(authentication.csrf, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(Object.hasOwn(authentication.response.json, "accessKey"), false);
      assert.equal(Object.hasOwn(authentication.response.json, "deviceToken"), false);
      assert.equal(Object.hasOwn(authentication.response.json, "token"), false);
      assert.equal(Object.hasOwn(authentication.response.json, "sessionToken"), false);
      assert.equal(JSON.stringify(authentication.response.json).includes(token), false);
      assert.deepEqual(authentication.response.json.authentication, {
        provider: null,
        configured: false,
        ownerName: null,
        legacyAccessKeyAvailable: false
      });

      const sessionsState = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
      assert.equal(sessionsState.version, 4);
      assert.match(sessionsState.integrity, /^[a-f0-9]{64}$/u);
      assert.equal(sessionsState.accessKeyHash, null);
      assert.equal(sessionsState.owner, null);
      assert.equal(Object.values(sessionsState.sessions).length, 1);
      assert.equal(Object.values(sessionsState.sessions)[0].principal, null);

      const publicStatus = await getRequest(context, "/api/v2/status");
      assert.equal(publicStatus.json.setupRequired, false);
      assert.equal(publicStatus.json.authentication.configured, false);
      assert.equal(publicStatus.json.authentication.legacyAccessKeyAvailable, false);
      assert.equal(publicStatus.json.authenticated, false);
      const privateStatus = await getRequest(context, "/api/v2/status", { cookie: authentication.cookie });
      assert.equal(privateStatus.json.authenticated, true);
      assert.equal(privateStatus.json.csrfToken, authentication.csrf);
    });

    await suite.test("owner enrollment replaces every bootstrap session with one encrypted Jellyfin session", async () => {
      const bootstrap = authentication;
      const missingCsrf = await enrollJellyfinOwner(context, { cookie: bootstrap.cookie });
      assert.equal(missingCsrf.status, 403);
      assert.equal(missingCsrf.json.code, "CSRF_TOKEN_REQUIRED");

      const savedJellyfin = await saveJellyfin(context, bootstrap);
      assert.equal(savedJellyfin.status, 200, JSON.stringify(savedJellyfin.json));

      const additionalBootstrap = await context.broker.controlPlane.sessionStore.issue({
        name: "Second bootstrap browser",
        origin: context.origin,
        host: `127.0.0.1:${context.port}`
      });
      const additionalBootstrapCookie = cookiePair({
        headers: { "set-cookie": [additionalBootstrap.cookie] }
      });
      const unavailableLegacyLogin = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: "x".repeat(43),
        deviceName: "Unavailable legacy browser",
        origin: context.origin
      });
      assert.equal(unavailableLegacyLogin.status, 404);
      assert.equal(unavailableLegacyLogin.json.code, "ACCESS_KEY_UNAVAILABLE");

      const enrolled = await enrollJellyfinOwner(context, bootstrap);
      assert.equal(enrolled.status, 201, JSON.stringify(enrolled.json));
      assert.match(enrolled.headers["set-cookie"][0], /; Max-Age=2592000;/u);
      assert.equal(Object.hasOwn(enrolled.json, "accessKey"), false);
      assert.deepEqual(enrolled.json.authentication, {
        provider: "jellyfin",
        configured: true,
        ownerName: OWNER_USERNAME,
        legacyAccessKeyAvailable: false
      });
      assert.equal(enrolled.json.session.provider, "jellyfin");
      assert.deepEqual(enrolled.json.session.user, { provider: "jellyfin", name: OWNER_USERNAME });
      assert.equal(JSON.stringify(enrolled.json).includes(OWNER_SERVER_ID), false);
      assert.equal(JSON.stringify(enrolled.json).includes(OWNER_USER_ID), false);
      assert.equal(JSON.stringify(enrolled.json).includes(OWNER_TOKEN), false);
      assert.equal(JSON.stringify(enrolled.json).includes(OWNER_PASSWORD), false);

      assert.equal(loginCalls.length, 1);
      assert.deepEqual(loginCalls[0].payload, { Username: OWNER_USERNAME, Pw: OWNER_PASSWORD });
      assert.match(loginCalls[0].authorization, /^MediaBrowser /u);
      assert.match(loginCalls[0].authorization, /DeviceId="[a-f0-9-]{36}"/u);
      assert.doesNotMatch(loginCalls[0].authorization, /(?:Token|token)=/u);
      assert.ok(loginCalls[0].body.every((byte) => byte === 0), "the owner login body was not zeroed");

      for (const cookie of [bootstrap.cookie, additionalBootstrapCookie]) {
        const revoked = await getRequest(context, "/api/v2/config", { cookie });
        assert.equal(revoked.status, 401);
        assert.equal(revoked.json.code, "SESSION_INVALID");
      }

      const persistedText = await readFile(path.join(dataDir, "sessions.json"), "utf8");
      const persisted = JSON.parse(persistedText);
      assert.equal(persisted.version, 4);
      assert.match(persisted.integrity, /^[a-f0-9]{64}$/u);
      assert.equal(persisted.accessKeyHash, null);
      assert.deepEqual(persisted.owner, {
        provider: "jellyfin",
        serverId: OWNER_SERVER_ID,
        userId: OWNER_USER_ID,
        username: OWNER_USERNAME,
        jellyfinUrl: persisted.owner.jellyfinUrl,
        targetRevision: persisted.owner.targetRevision,
        boundaryHash: persisted.owner.boundaryHash,
        enrolledAt: persisted.owner.enrolledAt
      });
      assert.equal(Object.keys(persisted.sessions).length, 1);
      const ownerSession = Object.values(persisted.sessions)[0];
      assert.equal(ownerSession.principal.serverId, OWNER_SERVER_ID);
      assert.equal(ownerSession.principal.userId, OWNER_USER_ID);
      assert.equal(persistedText.includes(OWNER_TOKEN), false);
      assert.equal(persistedText.includes(OWNER_PASSWORD), false);
      assert.equal(logs.join("\n").includes(OWNER_TOKEN), false);
      assert.equal(logs.join("\n").includes(OWNER_PASSWORD), false);

      const browserNamespaces = Object.keys(
        context.broker.controlPlane.credentialStore.publicSnapshot().credentials
      ).filter((namespace) => /^browser-auth-[a-f0-9-]{36}$/u.test(namespace));
      assert.deepEqual(browserNamespaces, [`browser-auth-${ownerSession.id}`]);
      assert.equal(
        browserTokenConfigured(context, ownerSession.id),
        true
      );
      await assertFilesDoNotContain(dataDir, [
        OWNER_PASSWORD,
        OWNER_TOKEN,
        cookieToken(bootstrap.cookie),
        cookieToken(additionalBootstrapCookie)
      ]);

      const legacyLogin = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: "x".repeat(43),
        deviceName: "Legacy login after enrollment",
        origin: context.origin
      });
      assert.equal(legacyLogin.status, 404);
      assert.equal(legacyLogin.json.code, "ACCESS_KEY_UNAVAILABLE");
      const rotateRemoved = await jsonRequest(context, "/api/v2/access/rotate", "POST", {}, {
        cookie: cookiePair(enrolled),
        csrf: enrolled.json.csrfToken
      });
      assert.equal(rotateRemoved.status, 404);
      assert.equal(rotateRemoved.json.code, "NOT_FOUND");

      authentication = {
        response: enrolled,
        cookie: cookiePair(enrolled),
        csrf: enrolled.json.csrfToken
      };
    });

    await suite.test("configuration and service mutations require the bound session and CSRF token", async () => {
      const missingCsrf = await jsonRequest(context, "/api/v2/config", "PUT", PRIVATE_POLICY, {
        cookie: authentication.cookie
      });
      assert.equal(missingCsrf.status, 403);
      assert.equal(missingCsrf.json.code, "CSRF_TOKEN_REQUIRED");

      const invalidCsrf = await jsonRequest(context, "/api/v2/config", "PUT", PRIVATE_POLICY, {
        cookie: authentication.cookie,
        csrf: "x".repeat(43)
      });
      assert.equal(invalidCsrf.status, 403);
      assert.equal(invalidCsrf.json.code, "CSRF_TOKEN_INVALID");

      const savedPolicy = await jsonRequest(context, "/api/v2/config", "PUT", PRIVATE_POLICY, authentication);
      assert.equal(savedPolicy.status, 200, JSON.stringify(savedPolicy.json));
      assert.deepEqual(savedPolicy.json.policy.allowedCidrs, PRIVATE_POLICY.allowedCidrs);

      const savedService = await saveRadarr(context, authentication);
      assert.equal(savedService.status, 200, JSON.stringify(savedService.json));
      assert.equal(savedService.json.id, "radarr");
      assert.equal(savedService.json.url, "http://media.test:7878");
      assert.equal(savedService.json.configured, true);
      assert.equal(savedService.json.credentialConfigured, true);
      assert.match(savedService.json.credentialUpdatedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(JSON.stringify(savedService.json).includes(SERVICE_SECRET), false);
    });

    await suite.test("service credentials are write-only metadata and absent from every persistence surface and log", async () => {
      const metadata = await getRequest(context, "/api/v2/services/radarr", {
        cookie: authentication.cookie
      });
      assert.equal(metadata.status, 200);
      assert.equal(metadata.json.credentialConfigured, true);
      assert.equal(Object.hasOwn(metadata.json, "credential"), false);
      assert.equal(Object.hasOwn(metadata.json, "apiKey"), false);

      const config = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
      assert.equal(config.status, 200);
      const radarr = config.json.services.find(({ id }) => id === "radarr");
      assert.equal(radarr.credentialConfigured, true);
      assert.equal(Object.hasOwn(radarr, "credential"), false);
      assert.equal(Object.hasOwn(radarr, "apiKey"), false);

      const sessionToken = cookieToken(authentication.cookie);
      await assertFilesDoNotContain(dataDir, [
        SERVICE_SECRET,
        OWNER_PASSWORD,
        OWNER_TOKEN,
        sessionToken,
        authentication.csrf,
        context.broker.setupToken
      ]);
      const serializedLogs = logs.join("\n");
      assert.equal(serializedLogs.includes(SERVICE_SECRET), false);
      assert.equal(serializedLogs.includes(OWNER_PASSWORD), false);
      assert.equal(serializedLogs.includes(OWNER_TOKEN), false);
      assert.equal(serializedLogs.includes(sessionToken), false);
      assert.equal(serializedLogs.includes(authentication.csrf), false);
    });

    await suite.test("session binding rejects changed Host, changed Origin, and missing credentials", async () => {
      const missingSession = await getRequest(context, "/api/v2/config");
      assert.equal(missingSession.status, 401);
      assert.equal(missingSession.json.code, "SESSION_REQUIRED");

      const changedHost = await getRequest(context, "/api/v2/config", {
        cookie: authentication.cookie,
        headers: { Host: `localhost:${context.port}` }
      });
      assert.equal(changedHost.status, 403);
      assert.equal(changedHost.json.code, "ORIGIN_REJECTED");

      const changedOrigin = await jsonRequest(context, "/api/v2/config", "PUT", PRIVATE_POLICY, {
        cookie: authentication.cookie,
        csrf: authentication.csrf,
        origin: `http://localhost:${context.port}`
      });
      assert.equal(changedOrigin.status, 403);
      assert.equal(changedOrigin.json.code, "ORIGIN_REJECTED");
    });

    await suite.test("logout expires and revokes the current session", async () => {
      const sessionId = authentication.response.json.session.id;
      const browserNamespace = `browser-auth-${sessionId}`;
      assert.equal(browserTokenConfigured(context, sessionId), true);
      const logout = await request(context.port, "/api/v2/session", {
        method: "DELETE",
        headers: {
          Origin: context.origin,
          Cookie: authentication.cookie,
          "X-Jellofin-Csrf": authentication.csrf
        }
      });
      assert.equal(logout.status, 204);
      const expired = logout.headers["set-cookie"][0];
      assert.match(expired, /^JFC_SESSION=; Path=\/; Max-Age=0;/u);
      assert.match(expired, /; HttpOnly; SameSite=Strict$/u);
      assert.equal(logoutCalls.length, 1);
      assert.match(logoutCalls[0], new RegExp(`Token="${OWNER_TOKEN}"`, "u"));
      assert.match(logoutCalls[0], /DeviceId="[a-f0-9-]{36}"/u);
      assert.equal(browserTokenConfigured(context, sessionId), false);

      const revoked = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
      assert.equal(revoked.status, 401);
      assert.equal(revoked.json.code, "SESSION_INVALID");
      const status = await getRequest(context, "/api/v2/status");
      assert.deepEqual(status.json.authentication, {
        provider: "jellyfin",
        configured: true,
        ownerName: null,
        legacyAccessKeyAvailable: false
      });
    });
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("owner enrollment cannot commit after its authorizing bootstrap session is revoked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-enrollment-race-"));
  const dataDir = path.join(root, "data");
  let context;
  let releaseLogin = () => {};
  let reportLoginStarted;
  const loginStarted = new Promise((resolve) => { reportLoginStarted = resolve; });
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  let candidateSessionId = null;
  let logoutCount = 0;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          const authorization = String(input.request.headers.authorization || "");
          candidateSessionId = /DeviceId="([a-f0-9-]{36})"/u.exec(authorization)?.[1] || null;
          reportLoginStarted();
          await loginGate;
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          logoutCount += 1;
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected enrollment-race route ${input.route.upstreamPath}`);
      }
    });
    const browserA = await claim(context, "Enrollment browser A");
    assert.equal((await saveJellyfin(context, browserA, "enrollment-race-monitor-token")).status, 200);

    const browserB = await context.broker.controlPlane.sessionStore.issue({
      name: "Enrollment browser B",
      origin: context.origin,
      host: `127.0.0.1:${context.port}`
    });
    const browserBCookie = cookiePair({ headers: { "set-cookie": [browserB.cookie] } });
    const pendingEnrollment = enrollJellyfinOwner(context, browserA, {
      deviceName: "Revoked enrollment browser"
    });
    await loginStarted;

    const revoked = await request(
      context.port,
      `/api/v2/sessions/${browserA.response.json.session.id}`,
      {
        method: "DELETE",
        headers: {
          Origin: context.origin,
          Cookie: browserBCookie,
          "X-Jellofin-Csrf": browserB.csrfToken
        }
      }
    );
    assert.equal(revoked.status, 204, JSON.stringify(revoked.json));
    releaseLogin();

    const rejected = await pendingEnrollment;
    assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, "SESSION_INVALID");
    assert.equal(context.broker.controlPlane.sessionStore.ownerConfigured(), false);
    assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(candidateSessionId), null);
    assert.equal(browserTokenConfigured(context, candidateSessionId), false);
    assert.equal(
      context.broker.controlPlane.sessionStore.getInternalSession(browserA.response.json.session.id),
      null
    );
    assert.notEqual(
      context.broker.controlPlane.sessionStore.getInternalSession(browserB.session.id),
      null
    );
    assert.ok(
      context.broker.controlPlane.sessionStore.internalSessions().every((session) => session.principal === null),
      "the rejected enrollment must not create an owner-authenticated session"
    );
    assert.equal(logoutCount, 1, "the rejected upstream token must be revoked");
  } finally {
    releaseLogin();
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a migrated beta.2 access key can enroll the owner once and is then permanently disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-access-migration-"));
  const dataDir = path.join(root, "data");
  const legacyAccessKey = "L".repeat(43);
  let context;
  try {
    context = await startBroker(dataDir, []);
    await claim(context, "Beta bootstrap");
    await context.broker.controlPlane.credentialStore.removeServiceCredentials("browser-auth-state");
    await stopBroker(context);
    context = null;

    const sessionsPath = path.join(dataDir, "sessions.json");
    const current = JSON.parse(await readFile(sessionsPath, "utf8"));
    const beta2State = {
      version: 2,
      revision: current.revision,
      accessKeyHash: createHash("sha256").update(legacyAccessKey, "utf8").digest("hex"),
      sessions: {}
    };
    await writeFile(sessionsPath, `${JSON.stringify(beta2State)}\n`, { mode: 0o600 });

    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected migration route ${input.route.upstreamPath}`);
      }
    });
    const migratedState = JSON.parse(await readFile(sessionsPath, "utf8"));
    assert.equal(migratedState.version, 4);
    assert.match(migratedState.integrity, /^[a-f0-9]{64}$/u);
    assert.equal(migratedState.owner, null);
    assert.match(migratedState.accessKeyHash, /^[a-f0-9]{64}$/u);

    const status = await getRequest(context, "/api/v2/status");
    assert.equal(status.json.setupRequired, false);
    assert.deepEqual(status.json.authentication, {
      provider: null,
      configured: false,
      ownerName: null,
      legacyAccessKeyAvailable: true
    });
    const rejected = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: "x".repeat(43),
      deviceName: "Rejected migration browser",
      origin: context.origin
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.json.code, "ACCESS_KEY_INVALID");

    const legacyLogin = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: legacyAccessKey,
      deviceName: "Migrated beta browser",
      origin: context.origin
    });
    assert.equal(legacyLogin.status, 201, JSON.stringify(legacyLogin.json));
    assert.equal(Object.hasOwn(legacyLogin.json, "accessKey"), false);
    const legacyAuthentication = {
      cookie: cookiePair(legacyLogin),
      csrf: legacyLogin.json.csrfToken
    };
    const saved = await saveJellyfin(context, legacyAuthentication, "migration-monitor-token");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const enrolled = await enrollJellyfinOwner(context, legacyAuthentication, {
      deviceName: "Migrated owner"
    });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.json));
    assert.equal(enrolled.json.authentication.legacyAccessKeyAvailable, false);

    const revokedLegacySession = await getRequest(context, "/api/v2/config", {
      cookie: legacyAuthentication.cookie
    });
    assert.equal(revokedLegacySession.status, 401);
    assert.equal(revokedLegacySession.json.code, "SESSION_INVALID");
    const disabledKey = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: legacyAccessKey,
      deviceName: "Legacy retry",
      origin: context.origin
    });
    assert.equal(disabledKey.status, 404);
    assert.equal(disabledKey.json.code, "ACCESS_KEY_UNAVAILABLE");

    const enrolledStateText = await readFile(sessionsPath, "utf8");
    const enrolledState = JSON.parse(enrolledStateText);
    assert.equal(enrolledState.version, 4);
    assert.match(enrolledState.integrity, /^[a-f0-9]{64}$/u);
    assert.equal(enrolledState.accessKeyHash, null);
    assert.equal(enrolledState.owner.serverId, OWNER_SERVER_ID);
    assert.equal(enrolledState.owner.userId, OWNER_USER_ID);
    assert.equal(Object.keys(enrolledState.sessions).length, 1);
    assert.equal(enrolledStateText.includes(legacyAccessKey), false);
    await assertFilesDoNotContain(dataDir, [legacyAccessKey, OWNER_PASSWORD, OWNER_TOKEN]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin owner login is unavailable before enrollment and has a bounded failure budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-login-limit-"));
  const dataDir = path.join(root, "data");
  let upstreamAttempts = 0;
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          const payload = JSON.parse(input.body.toString("utf8"));
          upstreamAttempts += 1;
          if (payload.Username === OWNER_USERNAME && payload.Pw === OWNER_PASSWORD) {
            return {
              status: 200,
              body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
              contentType: "application/json",
              cookies: []
            };
          }
          return {
            status: 401,
            body: Buffer.from('{"message":"invalid"}', "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected owner-login route ${input.route.upstreamPath}`);
      }
    });
    const beforeSetup = await jsonRequest(context, "/api/v2/auth/jellyfin/login", "POST", {
      username: OWNER_USERNAME,
      password: OWNER_PASSWORD,
      deviceName: "Before setup",
      origin: context.origin
    });
    assert.equal(beforeSetup.status, 409);
    assert.equal(beforeSetup.json.code, "SETUP_REQUIRED");

    const bootstrap = await claim(context);
    const beforeEnrollment = await loginJellyfinOwner(context);
    assert.equal(beforeEnrollment.status, 409);
    assert.equal(beforeEnrollment.json.code, "OWNER_NOT_CONFIGURED");
    const saved = await saveJellyfin(context, bootstrap);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap);
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const attemptsAfterEnrollment = upstreamAttempts;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejected = await jsonRequest(context, "/api/v2/auth/jellyfin/login", "POST", {
        username: "owner-with-wrong-password",
        password: `wrong-password-${attempt}`,
        deviceName: `Rejected ${attempt}`,
        origin: context.origin
      });
      assert.equal(rejected.status, 401, `attempt ${attempt + 1}`);
      assert.equal(rejected.json.code, "JELLYFIN_AUTH_REJECTED");
    }
    const limited = await jsonRequest(context, "/api/v2/auth/jellyfin/login", "POST", {
      username: "another-name-cannot-evade-ip-budget",
      password: "wrong-password-rate-limited",
      deviceName: "Rate limited",
      origin: context.origin
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, "JELLYFIN_LOGIN_RATE_LIMITED");
    assert.equal(upstreamAttempts - attemptsAfterEnrollment, 10);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin sign-in accepts only the exact enabled administrator and revocation erases its token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-identity-"));
  const dataDir = path.join(root, "data");
  const loginCalls = [];
  const issuedTokens = [];
  const logoutCalls = [];
  let ownerLoginCount = 0;
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        const upstreamPath = input.route.upstreamPath;
        if (upstreamPath === "/Users/AuthenticateByName") {
          const payload = JSON.parse(input.body.toString("utf8"));
          loginCalls.push({
            payload,
            authorization: String(input.request.headers.authorization || ""),
            body: input.body
          });
          if (payload.Username === OWNER_USERNAME && payload.Pw === OWNER_PASSWORD) {
            ownerLoginCount += 1;
            const token = `${OWNER_TOKEN}-${ownerLoginCount}`;
            issuedTokens.push(token);
            return {
              status: 200,
              body: Buffer.from(JSON.stringify({ AccessToken: token, ...jellyfinUser() }), "utf8"),
              contentType: "application/json",
              cookies: []
            };
          }
          const identities = {
            "regular-user": {
              token: "regular-user-token-must-not-persist",
              identity: jellyfinUser({ username: "regular-user", userId: "regular-user-id", administrator: false })
            },
            "disabled-admin": {
              token: "disabled-admin-token-must-not-persist",
              identity: jellyfinUser({ username: "disabled-admin", userId: "disabled-admin-id", disabled: true })
            },
            "different-admin": {
              token: "different-admin-token-must-not-persist",
              identity: jellyfinUser({ username: "different-admin", userId: "different-admin-id" })
            }
          };
          const match = payload.Pw === "valid-test-password" ? identities[payload.Username] : null;
          if (!match) {
            return {
              status: 401,
              body: Buffer.from('{"message":"invalid"}', "utf8"),
              contentType: "application/json",
              cookies: []
            };
          }
          issuedTokens.push(match.token);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: match.token, ...match.identity }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (upstreamPath === "/Sessions/Logout") {
          logoutCalls.push(String(input.request.headers.authorization || ""));
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected owner-identity route ${upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    const saved = await saveJellyfin(context, bootstrap, "owner-identity-monitor-token");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Enrolled owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const enrolledAuthentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };

    const rejectedCases = [
      { username: OWNER_USERNAME, password: "incorrect-password", deviceName: "Wrong password" },
      { username: "regular-user", password: "valid-test-password", deviceName: "Regular user" },
      { username: "disabled-admin", password: "valid-test-password", deviceName: "Disabled admin" },
      { username: "different-admin", password: "valid-test-password", deviceName: "Different admin" }
    ];
    for (const rejectedCase of rejectedCases) {
      const rejected = await loginJellyfinOwner(context, rejectedCase);
      assert.equal(rejected.status, 401, `${rejectedCase.username}: ${JSON.stringify(rejected.json)}`);
      assert.equal(rejected.json.code, "JELLYFIN_AUTH_REJECTED");
      assert.equal(JSON.stringify(rejected.json).includes(rejectedCase.username), false);
    }
    assert.equal(logoutCalls.length, 3, "each accepted non-owner token must be invalidated upstream");
    for (const token of issuedTokens.slice(1)) {
      assert.ok(logoutCalls.some((authorization) => authorization.includes(`Token="${token}"`)), token);
    }

    const signedIn = await loginJellyfinOwner(context, { deviceName: "Second owner browser" });
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.json));
    assert.match(signedIn.headers["set-cookie"][0], /; Max-Age=2592000;/u);
    assert.deepEqual(signedIn.json.session.user, { provider: "jellyfin", name: OWNER_USERNAME });
    assert.equal(JSON.stringify(signedIn.json).includes(OWNER_SERVER_ID), false);
    assert.equal(JSON.stringify(signedIn.json).includes(OWNER_USER_ID), false);
    const signedInAuthentication = {
      cookie: cookiePair(signedIn),
      csrf: signedIn.json.csrfToken
    };

    const sessions = await getRequest(context, "/api/v2/sessions", {
      cookie: enrolledAuthentication.cookie
    });
    assert.equal(sessions.status, 200, JSON.stringify(sessions.json));
    assert.equal(sessions.json.sessions.length, 2);
    assert.ok(sessions.json.sessions.every((session) => (
      session.provider === "jellyfin"
      && session.user.provider === "jellyfin"
      && session.user.name === OWNER_USERNAME
      && !Object.hasOwn(session, "serverId")
      && !Object.hasOwn(session, "userId")
    )));

    const signedInSessionId = signedIn.json.session.id;
    const signedInNamespace = `browser-auth-${signedInSessionId}`;
    assert.equal(browserTokenConfigured(context, signedInSessionId), true);
    const revoked = await request(context.port, `/api/v2/sessions/${signedInSessionId}`, {
      method: "DELETE",
      headers: {
        Origin: context.origin,
        Cookie: enrolledAuthentication.cookie,
        "X-Jellofin-Csrf": enrolledAuthentication.csrf
      }
    });
    assert.equal(revoked.status, 204);
    assert.equal(browserTokenConfigured(context, signedInSessionId), false);
    assert.ok(logoutCalls.some((authorization) => authorization.includes(`Token="${issuedTokens.at(-1)}"`)));
    const rejectedRevokedSession = await getRequest(context, "/api/v2/config", {
      cookie: signedInAuthentication.cookie
    });
    assert.equal(rejectedRevokedSession.status, 401);
    assert.equal(rejectedRevokedSession.json.code, "SESSION_INVALID");
    const ownerStillActive = await getRequest(context, "/api/v2/config", {
      cookie: enrolledAuthentication.cookie
    });
    assert.equal(ownerStillActive.status, 200);

    for (const call of loginCalls) {
      assert.match(call.authorization, /^MediaBrowser /u);
      assert.match(call.authorization, /DeviceId="[a-f0-9-]{36}"/u);
      assert.doesNotMatch(call.authorization, /(?:Token|token)=/u);
      assert.ok(call.body.every((byte) => byte === 0), `${call.payload.Username} login body was not zeroed`);
    }
    await assertFilesDoNotContain(dataDir, [
      OWNER_PASSWORD,
      "incorrect-password",
      "valid-test-password",
      ...issuedTokens
    ]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin owner sessions revalidate before writes and revoke locally when Jellyfin rejects the token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-revalidation-"));
  const dataDir = path.join(root, "data");
  const validationCalls = [];
  const logoutCalls = [];
  let validationRejected = false;
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        const upstreamPath = input.route.upstreamPath;
        if (upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (upstreamPath === "/Users/Me") {
          validationCalls.push(String(input.request.headers.authorization || ""));
          if (validationRejected) {
            return {
              status: 401,
              body: Buffer.from('{"message":"revoked"}', "utf8"),
              contentType: "application/json",
              cookies: []
            };
          }
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              ...jellyfinUser().User,
              ServerId: OWNER_SERVER_ID
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (upstreamPath === "/Sessions/Logout") {
          logoutCalls.push(String(input.request.headers.authorization || ""));
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected owner-revalidation route ${upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    const saved = await saveJellyfin(context, bootstrap, "revalidation-monitor-token");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Revalidated owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const authentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };
    const sessionId = enrollment.json.session.id;
    const namespace = `browser-auth-${sessionId}`;
    const identity = {
      provider: "jellyfin",
      serverId: OWNER_SERVER_ID,
      userId: OWNER_USER_ID,
      username: OWNER_USERNAME
    };

    await context.broker.controlPlane.sessionStore.markVerified(
      sessionId,
      identity,
      new Date(Date.now() - 3 * 60 * 1_000).toISOString()
    );
    const write = await jsonRequest(context, "/api/v2/config", "PUT", PRIVATE_POLICY, authentication);
    assert.equal(write.status, 200, JSON.stringify(write.json));
    assert.equal(validationCalls.length, 1);
    assert.match(validationCalls[0], new RegExp(`Token="${OWNER_TOKEN}"`, "u"));
    assert.match(validationCalls[0], /DeviceId="[a-f0-9-]{36}"/u);
    assert.equal(browserTokenConfigured(context, sessionId), true);

    await context.broker.controlPlane.sessionStore.markVerified(
      sessionId,
      identity,
      new Date(Date.now() - 13 * 60 * 60 * 1_000).toISOString()
    );
    validationRejected = true;
    const rejected = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, "JELLYFIN_AUTH_REJECTED");
    assert.equal(validationCalls.length, 2);
    assert.equal(browserTokenConfigured(context, sessionId), false);
    assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);
    assert.ok(logoutCalls.some((authorization) => authorization.includes(`Token="${OWNER_TOKEN}"`)));

    const staleCookie = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
    assert.equal(staleCookie.status, 401);
    assert.equal(staleCookie.json.code, "SESSION_INVALID");
    const status = await getRequest(context, "/api/v2/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.authenticated, false);
    assert.deepEqual(status.json.authentication, {
      provider: "jellyfin",
      configured: true,
      ownerName: null,
      legacyAccessKeyAvailable: false
    });
    await assertFilesDoNotContain(dataDir, [OWNER_PASSWORD, OWNER_TOKEN]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("an authorized network-policy boundary change revokes every Jellyfin browser session locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-policy-reset-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        upstreamCalls.push({
          path: input.route.upstreamPath,
          authorization: String(input.request.headers.authorization || "")
        });
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected policy-reset route ${input.route.upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "policy-reset-monitor-token")).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Policy owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const second = await loginJellyfinOwner(context, { deviceName: "Second policy browser" });
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const authentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };
    const browserSessions = [
      { id: enrollment.json.session.id, cookie: authentication.cookie },
      { id: second.json.session.id, cookie: cookiePair(second) }
    ];
    assert.ok(browserSessions.every(({ id }) => browserTokenConfigured(context, id)));
    const before = context.broker.store.snapshot();
    const beforeBoundary = connectionAuthorizationBoundaryHash(before.connections.jellyfin, before.policy);
    const ownerBeforeChange = context.broker.controlPlane.sessionStore.owner();
    assert.equal(ownerBeforeChange.boundaryHash, beforeBoundary);
    const upstreamCountBeforeChange = upstreamCalls.length;

    const changed = await jsonRequest(context, "/api/v2/config", "PUT", {
      allowedCidrs: ["10.20.0.0/16"],
      allowPublicHttps: false
    }, authentication);
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.browserAuthenticationReset, true);
    const expiredCookie = Array.isArray(changed.headers["set-cookie"])
      ? changed.headers["set-cookie"][0]
      : changed.headers["set-cookie"];
    assert.match(expiredCookie, /^JFC_SESSION=; Path=\/; Max-Age=0;/u);
    assert.match(expiredCookie, /; HttpOnly; SameSite=Strict$/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstreamCalls.length, upstreamCountBeforeChange, "local boundary reset must not contact Jellyfin");

    const after = context.broker.store.snapshot();
    assert.notEqual(
      connectionAuthorizationBoundaryHash(after.connections.jellyfin, after.policy),
      beforeBoundary
    );
    for (const { id, cookie } of browserSessions) {
      assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(id), null);
      assert.equal(browserTokenConfigured(context, id), false);
      const stale = await getRequest(context, "/api/v2/config", { cookie });
      assert.equal(stale.status, 401, JSON.stringify(stale.json));
      assert.equal(stale.json.code, "SESSION_INVALID");
    }
    const browserNamespaces = Object.keys(
      context.broker.controlPlane.credentialStore.publicSnapshot().credentials || {}
    ).filter((namespace) => /^browser-auth-[a-f0-9-]{36}$/u.test(namespace));
    assert.deepEqual(browserNamespaces, []);
    assert.equal(
      upstreamCalls.some(({ path: upstreamPath }) => upstreamPath === "/Sessions/Logout"),
      false,
      "old browser tokens must not be sent to any target after the boundary changes"
    );

    const reboundOwner = context.broker.controlPlane.sessionStore.owner();
    assert.deepEqual(
      {
        provider: reboundOwner.provider,
        serverId: reboundOwner.serverId,
        userId: reboundOwner.userId,
        username: reboundOwner.username,
        enrolledAt: reboundOwner.enrolledAt
      },
      {
        provider: ownerBeforeChange.provider,
        serverId: ownerBeforeChange.serverId,
        userId: ownerBeforeChange.userId,
        username: ownerBeforeChange.username,
        enrolledAt: ownerBeforeChange.enrolledAt
      },
      "an authorized boundary change must preserve the sealed owner account"
    );
    assert.deepEqual(
      {
        jellyfinUrl: reboundOwner.jellyfinUrl,
        targetRevision: reboundOwner.targetRevision,
        boundaryHash: reboundOwner.boundaryHash
      },
      {
        jellyfinUrl: after.connections.jellyfin.url,
        targetRevision: after.connections.jellyfin.targetRevision,
        boundaryHash: connectionAuthorizationBoundaryHash(after.connections.jellyfin, after.policy)
      },
      "the sealed owner must move to the newly authorized boundary"
    );
    assert.notEqual(reboundOwner.boundaryHash, ownerBeforeChange.boundaryHash);

    const freshLogin = await loginJellyfinOwner(context, {
      deviceName: "Fresh browser after policy change"
    });
    assert.equal(freshLogin.status, 201, JSON.stringify(freshLogin.json));
    const freshSession = context.broker.controlPlane.sessionStore
      .getInternalSession(freshLogin.json.session.id);
    assert.equal(freshSession.principal.boundaryHash, reboundOwner.boundaryHash);
    assert.equal(freshSession.principal.targetRevision, reboundOwner.targetRevision);
    assert.equal(browserTokenConfigured(context, freshLogin.json.session.id), true);
    assert.equal(upstreamCalls.at(-1).path, "/Users/AuthenticateByName");
    assert.equal(upstreamCalls.at(-1).authorization.includes(OWNER_TOKEN), false);

    const persisted = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.deepEqual(persisted.owner, reboundOwner);
    assert.deepEqual(Object.keys(persisted.sessions), [freshLogin.json.session.id]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a post-commit session-revocation failure preserves the new policy and staged monitoring credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-policy-revoke-failure-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  const monitoringToken = "policy-failure-monitoring-token";
  let context;
  let originalRebindAndRevoke;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        upstreamCalls.push({
          path: input.route.upstreamPath,
          authorization: String(input.request.headers.authorization || "")
        });
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected policy-revocation-failure route ${input.route.upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, monitoringToken)).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Policy failure owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const authentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };
    const sessionId = enrollment.json.session.id;
    const before = context.broker.store.snapshot();
    const beforeBoundary = connectionAuthorizationBoundaryHash(before.connections.jellyfin, before.policy);
    const beforeNamespace = monitoringCredentialNamespace("jellyfin", before.connections.jellyfin, before.policy);
    assert.equal(
      context.broker.controlPlane.credentialStore
        .publicSnapshot().credentials?.[beforeNamespace]?.token?.configured,
      true
    );
    const upstreamCountBeforeChange = upstreamCalls.length;

    const sessionStore = context.broker.controlPlane.sessionStore;
    originalRebindAndRevoke = sessionStore.rebindOwnerAndRevokeAll;
    let revokeAllCalls = 0;
    let committedAtFailure = null;
    let stagedCredentialConfiguredAtFailure = false;
    sessionStore.rebindOwnerAndRevokeAll = async () => {
      revokeAllCalls += 1;
      committedAtFailure = context.broker.store.snapshot();
      const committedNamespace = monitoringCredentialNamespace(
        "jellyfin",
        committedAtFailure.connections.jellyfin,
        committedAtFailure.policy
      );
      stagedCredentialConfiguredAtFailure = context.broker.controlPlane.credentialStore
        .publicSnapshot().credentials?.[committedNamespace]?.token?.configured === true;
      throw new Error("injected session persistence failure after policy commit");
    };

    const changed = await jsonRequest(context, "/api/v2/config", "PUT", {
      allowedCidrs: ["10.20.0.0/16"],
      allowPublicHttps: false
    }, authentication);
    sessionStore.rebindOwnerAndRevokeAll = originalRebindAndRevoke;
    originalRebindAndRevoke = null;

    assert.equal(changed.status, 500, JSON.stringify(changed.json));
    assert.equal(changed.json.code, "INTERNAL_ERROR");
    assert.equal(revokeAllCalls, 1);
    assert.deepEqual(committedAtFailure.policy.allowedCidrs, ["10.20.0.0/16"]);
    assert.equal(stagedCredentialConfiguredAtFailure, true);

    const after = context.broker.store.snapshot();
    const afterBoundary = connectionAuthorizationBoundaryHash(after.connections.jellyfin, after.policy);
    const afterNamespace = monitoringCredentialNamespace("jellyfin", after.connections.jellyfin, after.policy);
    assert.notEqual(afterBoundary, beforeBoundary);
    assert.notEqual(afterNamespace, beforeNamespace);
    assert.deepEqual(after.policy.allowedCidrs, ["10.20.0.0/16"]);
    assert.equal(
      context.broker.controlPlane.credentialStore
        .publicSnapshot().credentials?.[afterNamespace]?.token?.configured,
      true,
      "the monitoring credential staged for the committed policy must not be rolled back"
    );
    assert.notEqual(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);
    assert.equal(browserTokenConfigured(context, sessionId), true);
    assert.deepEqual(upstreamCalls.slice(upstreamCountBeforeChange), []);
    assert.equal(
      upstreamCalls.some(({ authorization }) => authorization.includes(OWNER_TOKEN)),
      false,
      "the old owner token must never be sent upstream during the failed boundary transition"
    );
  } finally {
    if (context && originalRebindAndRevoke) {
      context.broker.controlPlane.sessionStore.rebindOwnerAndRevokeAll = originalRebindAndRevoke;
    }
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a Jellyfin monitoring auth-mode revision revokes the current browser session locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-service-reset-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  const monitoringUsername = "monitoring-user";
  const monitoringPassword = "monitoring-password-must-not-persist";
  const monitoringToken = "replacement-monitoring-token";
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        const authorization = String(input.request.headers.authorization || "");
        upstreamCalls.push({ path: input.route.upstreamPath, authorization });
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          const payload = JSON.parse(input.body.toString("utf8"));
          const monitoringLogin = payload.Username === monitoringUsername;
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: monitoringLogin ? monitoringToken : OWNER_TOKEN,
              ...(monitoringLogin
                ? { User: { Id: "monitoring-user-id", Name: monitoringUsername } }
                : jellyfinUser())
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected service-reset route ${input.route.upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    const originalConnection = await saveJellyfin(context, bootstrap, "original-monitoring-token");
    assert.equal(originalConnection.status, 200, JSON.stringify(originalConnection.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Service-change owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const authentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };
    const sessionId = enrollment.json.session.id;
    assert.equal(browserTokenConfigured(context, sessionId), true);
    const upstreamCountBeforeChange = upstreamCalls.length;

    const changed = await jsonRequest(context, "/api/v2/services/jellyfin", "PUT", {
      url: "http://media.test:8096",
      authMode: "login",
      login: { username: monitoringUsername, password: monitoringPassword },
      monitoringEnabled: false
    }, authentication);
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.notEqual(changed.json.targetRevision, originalConnection.json.targetRevision);
    assert.equal(changed.json.browserAuthenticationReset, true);
    const expiredCookie = Array.isArray(changed.headers["set-cookie"])
      ? changed.headers["set-cookie"][0]
      : changed.headers["set-cookie"];
    assert.match(expiredCookie, /^JFC_SESSION=; Path=\/; Max-Age=0;/u);
    assert.match(expiredCookie, /; HttpOnly; SameSite=Strict$/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);
    assert.equal(browserTokenConfigured(context, sessionId), false);
    assert.deepEqual(
      Object.keys(context.broker.controlPlane.credentialStore.publicSnapshot().credentials || {})
        .filter((namespace) => /^browser-auth-[a-f0-9-]{36}$/u.test(namespace)),
      []
    );

    const callsDuringChange = upstreamCalls.slice(upstreamCountBeforeChange);
    assert.deepEqual(callsDuringChange.map(({ path: upstreamPath }) => upstreamPath), [
      "/Users/AuthenticateByName"
    ]);
    assert.ok(callsDuringChange.every(({ authorization }) => !authorization.includes(OWNER_TOKEN)));
    assert.equal(
      callsDuringChange.some(({ path: upstreamPath }) => upstreamPath === "/Sessions/Logout"),
      false,
      "the prior browser token must be discarded locally, not logged out against the new revision"
    );
    const stale = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
    assert.equal(stale.status, 401, JSON.stringify(stale.json));
    assert.equal(stale.json.code, "SESSION_INVALID");
    await assertFilesDoNotContain(dataDir, [OWNER_TOKEN, monitoringPassword, monitoringToken]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a post-commit session-revocation failure preserves the new Jellyfin auth revision and credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-service-revoke-failure-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  const monitoringUsername = "failure-monitoring-user";
  const monitoringPassword = "failure-monitoring-password-must-not-persist";
  const monitoringToken = "failure-replacement-monitoring-token";
  let context;
  let originalRebindAndRevoke;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        const authorization = String(input.request.headers.authorization || "");
        upstreamCalls.push({ path: input.route.upstreamPath, authorization });
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          const payload = JSON.parse(input.body.toString("utf8"));
          const monitoringLogin = payload.Username === monitoringUsername;
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: monitoringLogin ? monitoringToken : OWNER_TOKEN,
              ...(monitoringLogin
                ? { User: { Id: "failure-monitoring-user-id", Name: monitoringUsername } }
                : jellyfinUser())
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected service-revocation-failure route ${input.route.upstreamPath}`);
      }
    });

    const bootstrap = await claim(context);
    const originalConnection = await saveJellyfin(context, bootstrap, "original-failure-monitoring-token");
    assert.equal(originalConnection.status, 200, JSON.stringify(originalConnection.json));
    const enrollment = await enrollJellyfinOwner(context, bootstrap, { deviceName: "Service failure owner" });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const authentication = {
      cookie: cookiePair(enrollment),
      csrf: enrollment.json.csrfToken
    };
    const sessionId = enrollment.json.session.id;
    const upstreamCountBeforeChange = upstreamCalls.length;

    const sessionStore = context.broker.controlPlane.sessionStore;
    originalRebindAndRevoke = sessionStore.rebindOwnerAndRevokeAll;
    let revokeAllCalls = 0;
    let committedAtFailure = null;
    let stagedCredentialConfiguredAtFailure = false;
    sessionStore.rebindOwnerAndRevokeAll = async () => {
      revokeAllCalls += 1;
      committedAtFailure = context.broker.store.snapshot();
      const committedNamespace = monitoringCredentialNamespace(
        "jellyfin",
        committedAtFailure.connections.jellyfin,
        committedAtFailure.policy
      );
      stagedCredentialConfiguredAtFailure = context.broker.controlPlane.credentialStore
        .publicSnapshot().credentials?.[committedNamespace]?.token?.configured === true;
      throw new Error("injected session persistence failure after Jellyfin auth commit");
    };

    const changed = await jsonRequest(context, "/api/v2/services/jellyfin", "PUT", {
      url: "http://media.test:8096",
      authMode: "login",
      login: { username: monitoringUsername, password: monitoringPassword },
      monitoringEnabled: false
    }, authentication);
    sessionStore.rebindOwnerAndRevokeAll = originalRebindAndRevoke;
    originalRebindAndRevoke = null;

    assert.equal(changed.status, 500, JSON.stringify(changed.json));
    assert.equal(changed.json.code, "INTERNAL_ERROR");
    assert.equal(revokeAllCalls, 1);
    assert.equal(committedAtFailure.connections.jellyfin.authMode, "login");
    assert.notEqual(
      committedAtFailure.connections.jellyfin.targetRevision,
      originalConnection.json.targetRevision
    );
    assert.equal(stagedCredentialConfiguredAtFailure, true);

    const after = context.broker.store.snapshot();
    const afterNamespace = monitoringCredentialNamespace("jellyfin", after.connections.jellyfin, after.policy);
    assert.equal(after.connections.jellyfin.authMode, "login");
    assert.notEqual(after.connections.jellyfin.targetRevision, originalConnection.json.targetRevision);
    assert.equal(
      context.broker.controlPlane.credentialStore
        .publicSnapshot().credentials?.[afterNamespace]?.token?.configured,
      true,
      "the monitoring credential staged for the committed auth revision must not be rolled back"
    );
    assert.notEqual(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);
    assert.equal(browserTokenConfigured(context, sessionId), true);

    const callsDuringChange = upstreamCalls.slice(upstreamCountBeforeChange);
    assert.deepEqual(callsDuringChange.map(({ path: upstreamPath }) => upstreamPath), [
      "/Users/AuthenticateByName"
    ]);
    assert.ok(callsDuringChange.every(({ authorization }) => !authorization.includes(OWNER_TOKEN)));
    assert.equal(
      callsDuringChange.some(({ path: upstreamPath }) => upstreamPath === "/Sessions/Logout"),
      false,
      "the old owner token must never be sent upstream after the auth revision commits"
    );
    await assertFilesDoNotContain(dataDir, [OWNER_TOKEN, monitoringPassword, monitoringToken]);
  } finally {
    if (context && originalRebindAndRevoke) {
      context.broker.controlPlane.sessionStore.rebindOwnerAndRevokeAll = originalRebindAndRevoke;
    }
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("startup removes an orphaned Jellyfin token without sending it to an unbound target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-orphan-cleanup-"));
  const dataDir = path.join(root, "data");
  const logoutCalls = [];
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          logoutCalls.push(String(input.request.headers.authorization || ""));
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected orphan-cleanup route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "orphan-monitor-token")).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap);
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const sessionId = enrollment.json.session.id;
    const namespace = `browser-auth-${sessionId}`;
    assert.equal(
      context.broker.controlPlane.sessionStore.getInternalSession(sessionId).principal.deviceId,
      sessionId
    );
    assert.equal(await context.broker.controlPlane.sessionStore.revoke(sessionId), true);
    assert.equal(browserTokenConfigured(context, sessionId), true);

    await stopBroker(context);
    context = null;
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        throw new Error(`orphan cleanup must remain local, not call ${input.route.upstreamPath}`);
      }
    });
    assert.equal(logoutCalls.length, 0);
    assert.equal(browserTokenConfigured(context, sessionId), false);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("startup revokes a Jellyfin browser session whose encrypted token is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-tokenless-cleanup-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected tokenless-cleanup route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "tokenless-monitor-token")).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap);
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const sessionId = enrollment.json.session.id;
    const cookie = cookiePair(enrollment);
    const namespace = `browser-auth-${sessionId}`;
    await context.broker.controlPlane.credentialStore.removeServiceCredentials(namespace);
    assert.notEqual(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);

    await stopBroker(context);
    context = null;
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        throw new Error(`startup must revoke tokenless sessions locally, not call ${input.route.upstreamPath}`);
      }
    });
    assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(sessionId), null);
    const rejected = await getRequest(context, "/api/v2/config", { cookie });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, "SESSION_INVALID");
    const status = await getRequest(context, "/api/v2/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.authenticated, false);
    assert.deepEqual(status.json.authentication, {
      provider: "jellyfin",
      configured: true,
      ownerName: null,
      legacyAccessKeyAvailable: false
    });
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("offline Jellyfin destination tampering fails startup before an encrypted browser token can be used", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-boundary-tamper-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        upstreamCalls.push(input);
        throw new Error(`unexpected boundary-tamper route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "tamper-monitor-token")).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap);
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const sessionId = enrollment.json.session.id;
    assert.equal(browserTokenConfigured(context, sessionId), true);
    await stopBroker(context);
    context = null;

    const statePath = path.join(dataDir, "state.json");
    const sessionsPath = path.join(dataDir, "sessions.json");
    const tamperedState = JSON.parse(await readFile(statePath, "utf8"));
    tamperedState.connections.jellyfin = {
      ...tamperedState.connections.jellyfin,
      url: "http://attacker.test:8096",
      targetRevision: "88888888-8888-4888-8888-888888888888",
      approvedHostCidrs: ["10.66.66.66/32"]
    };
    const tamperedSessions = JSON.parse(await readFile(sessionsPath, "utf8"));
    const tamperedPrincipal = tamperedSessions.sessions[sessionId].principal;
    tamperedPrincipal.jellyfinUrl = tamperedState.connections.jellyfin.url;
    tamperedPrincipal.targetRevision = tamperedState.connections.jellyfin.targetRevision;
    tamperedPrincipal.boundaryHash = connectionAuthorizationBoundaryHash(
      tamperedState.connections.jellyfin,
      tamperedState.policy
    );
    await writeFile(statePath, `${JSON.stringify(tamperedState)}\n`, { mode: 0o600 });
    await writeFile(sessionsPath, `${JSON.stringify(tamperedSessions)}\n`, { mode: 0o600 });

    await assert.rejects(() => startBroker(dataDir, [], {
      lookup: async (hostname) => {
        if (hostname === "attacker.test") return [{ address: "10.66.66.66", family: 4 }];
        if (hostname === "media.test") return [{ address: "10.20.30.40", family: 4 }];
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      },
      dispatchUpstream: async (input) => {
        upstreamCalls.push(input);
        throw new Error("a tampered browser token must never reach an upstream target");
      }
    }), /(?:browser authorization state could not be authenticated|Malformed browser session state)/u);
    assert.equal(upstreamCalls.length, 0);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a state-only Jellyfin destination rewrite cannot send fresh owner credentials to the substituted target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-state-only-boundary-tamper-"));
  const dataDir = path.join(root, "data");
  const attackerCalls = [];
  const attackerToken = "attacker-issued-owner-token-must-not-persist";
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: OWNER_TOKEN, ...jellyfinUser() }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected owner setup route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "state-tamper-monitor-token")).status, 200);
    const enrollment = await enrollJellyfinOwner(context, bootstrap, {
      deviceName: "Owner before state tampering"
    });
    assert.equal(enrollment.status, 201, JSON.stringify(enrollment.json));
    const originalSessionId = enrollment.json.session.id;
    const sealedOwner = context.broker.controlPlane.sessionStore.owner();
    const originalState = context.broker.store.snapshot();
    assert.deepEqual(
      {
        jellyfinUrl: sealedOwner.jellyfinUrl,
        targetRevision: sealedOwner.targetRevision,
        boundaryHash: sealedOwner.boundaryHash
      },
      {
        jellyfinUrl: originalState.connections.jellyfin.url,
        targetRevision: originalState.connections.jellyfin.targetRevision,
        boundaryHash: connectionAuthorizationBoundaryHash(
          originalState.connections.jellyfin,
          originalState.policy
        )
      }
    );
    await stopBroker(context);
    context = null;

    const statePath = path.join(dataDir, "state.json");
    const sessionsPath = path.join(dataDir, "sessions.json");
    const sealedSessionsText = await readFile(sessionsPath, "utf8");
    const tamperedState = JSON.parse(await readFile(statePath, "utf8"));
    tamperedState.connections.jellyfin = {
      ...tamperedState.connections.jellyfin,
      url: "http://attacker.test:8096",
      targetRevision: "77777777-7777-4777-8777-777777777777",
      approvedHostCidrs: ["10.66.66.66/32"]
    };
    await writeFile(statePath, `${JSON.stringify(tamperedState)}\n`, { mode: 0o600 });
    assert.equal(
      await readFile(sessionsPath, "utf8"),
      sealedSessionsText,
      "the attack fixture must alter state.json only, leaving the sealed owner record untouched"
    );

    context = await startBroker(dataDir, [], {
      lookup: async (hostname) => {
        if (hostname === "attacker.test") return [{ address: "10.66.66.66", family: 4 }];
        if (hostname === "media.test") return [{ address: "10.20.30.40", family: 4 }];
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      },
      dispatchUpstream: async (input) => {
        const payload = input.route.upstreamPath === "/Users/AuthenticateByName"
          ? JSON.parse(input.body.toString("utf8"))
          : null;
        attackerCalls.push({ path: input.route.upstreamPath, payload });
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: attackerToken,
              ...jellyfinUser()
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected substituted-target route ${input.route.upstreamPath}`);
      }
    });

    assert.deepEqual(context.broker.controlPlane.sessionStore.owner(), sealedOwner);
    assert.equal(context.broker.controlPlane.sessionStore.getInternalSession(originalSessionId), null);
    assert.equal(browserTokenConfigured(context, originalSessionId), false);
    assert.deepEqual(attackerCalls, [], "startup reconciliation must not contact the substituted target");

    const rejected = await loginJellyfinOwner(context, {
      deviceName: "Fresh browser after offline rewrite"
    });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, "JELLYFIN_AUTH_REJECTED");
    assert.equal(JSON.stringify(rejected.json).includes("attacker.test"), false);
    assert.deepEqual(
      attackerCalls,
      [],
      "the sealed boundary must reject before transmitting the submitted username or password"
    );
    assert.deepEqual(context.broker.controlPlane.sessionStore.owner(), sealedOwner);
    assert.deepEqual(context.broker.controlPlane.sessionStore.internalSessions(), []);
    assert.deepEqual(
      Object.keys(context.broker.controlPlane.credentialStore.publicSnapshot().credentials || {})
        .filter((namespace) => /^browser-auth-[a-f0-9-]{36}$/u.test(namespace)),
      [],
      "the rejected login must not commit an encrypted browser token"
    );

    const persisted = JSON.parse(await readFile(sessionsPath, "utf8"));
    assert.deepEqual(persisted.owner, sealedOwner);
    assert.deepEqual(persisted.sessions, {});
    await assertFilesDoNotContain(dataDir, [OWNER_PASSWORD, OWNER_TOKEN, attackerToken]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("sealed owner state rejects an offline downgrade to an attacker-chosen unbound session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-integrity-downgrade-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  let context;
  try {
    const { sessionId } = await createPersistedJellyfinOwner(dataDir);
    const sessionsPath = path.join(dataDir, "sessions.json");
    const tampered = JSON.parse(await readFile(sessionsPath, "utf8"));
    assert.equal(tampered.version, 4);
    assert.match(tampered.integrity, /^[a-f0-9]{64}$/u);

    const attackerCookie = "A".repeat(43);
    const record = tampered.sessions[sessionId];
    tampered.owner = null;
    record.name = "Attacker-selected browser";
    record.origin = "https://attacker.example.test";
    record.host = "attacker.example.test";
    record.tokenHash = createHash("sha256").update(attackerCookie, "utf8").digest("hex");
    record.createdAt = "2026-09-16T00:00:00.000Z";
    record.expiresAt = "2099-09-16T00:00:00.000Z";
    record.principal = null;
    await writeFile(sessionsPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    await assert.rejects(() => startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        upstreamCalls.push(input);
        throw new Error("an integrity downgrade must fail before any upstream dispatch");
      }
    }), /browser authorization state could not be authenticated/u);
    assert.equal(upstreamCalls.length, 0);
    context = null;
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("rewriting sealed owner identifiers cannot authorize an attacker Jellyfin administrator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-integrity-identity-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  let context;
  try {
    const { sessionId } = await createPersistedJellyfinOwner(dataDir);
    const sessionsPath = path.join(dataDir, "sessions.json");
    const tampered = JSON.parse(await readFile(sessionsPath, "utf8"));
    const attackerServerId = "attacker-jellyfin-server";
    const attackerUserId = "attacker-administrator-user";
    tampered.owner.serverId = attackerServerId;
    tampered.owner.userId = attackerUserId;
    tampered.owner.username = "attacker-admin";
    tampered.sessions[sessionId].principal.serverId = attackerServerId;
    tampered.sessions[sessionId].principal.userId = attackerUserId;
    tampered.sessions[sessionId].principal.username = "attacker-admin";
    await writeFile(sessionsPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    await assert.rejects(() => startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        upstreamCalls.push(input);
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: "attacker-admin-token",
              ...jellyfinUser({
                serverId: attackerServerId,
                userId: attackerUserId,
                username: "attacker-admin"
              })
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error("a rewritten owner identity must never be usable");
      }
    }), /browser authorization state could not be authenticated/u);
    assert.equal(upstreamCalls.length, 0);
    context = null;
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a freshly recreated credential store cannot authenticate substituted legacy session state", async (suite) => {
  for (const legacyVersion of [2, 3]) {
    await suite.test(`v${legacyVersion}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `helmsman-owner-fresh-key-v${legacyVersion}-`));
      const dataDir = path.join(root, "data");
      const upstreamCalls = [];
      let context;
      try {
        context = await startBroker(dataDir, []);
        await claim(context, `Fresh-key v${legacyVersion} browser`);
        await stopBroker(context);
        context = null;

        await rm(path.join(dataDir, "credentials.json"), { force: true });
        await rm(path.join(dataDir, "credentials.key"), { force: true });
        const legacy = legacyVersion === 2
          ? {
              version: 2,
              revision: 7,
              accessKeyHash: createHash("sha256").update("Z".repeat(43), "utf8").digest("hex"),
              sessions: {}
            }
          : {
              version: 3,
              revision: 7,
              accessKeyHash: null,
              owner: {
                provider: "jellyfin",
                serverId: "substituted-server",
                userId: "substituted-owner",
                username: "substituted-admin",
                enrolledAt: "2026-09-16T00:00:00.000Z"
              },
              sessions: {}
            };
        await writeFile(path.join(dataDir, "sessions.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

        await assert.rejects(() => startBroker(dataDir, [], {
          dispatchUpstream: async (input) => {
            upstreamCalls.push(input);
            throw new Error("legacy substitution must fail before upstream dispatch");
          }
        }), /(?:Legacy browser authorization state cannot replace sealed state|Unsupported or malformed session state)/u);
        assert.equal(upstreamCalls.length, 0);
      } finally {
        await stopBroker(context).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a crash after the anti-downgrade marker cannot reopen legacy session migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-session-marker-crash-"));
  const dataDir = path.join(root, "data");
  const upstreamCalls = [];
  let context = null;
  let migrationCredentials = null;
  try {
    const stateStore = new StateStore(dataDir);
    const initialState = await stateStore.initialize();

    // Model an existing beta installation: the encrypted credential store
    // predates the schema marker and the browser authorization file is v2.
    const seededCredentials = new CredentialStore(dataDir, {
      instanceId: initialState.instanceId
    });
    await seededCredentials.initialize();
    await seededCredentials.close();
    const substitutedLegacyState = {
      version: 2,
      revision: 11,
      accessKeyHash: createHash("sha256").update("M".repeat(43), "utf8").digest("hex"),
      sessions: {}
    };
    await writeFile(
      path.join(dataDir, "sessions.json"),
      `${JSON.stringify(substitutedLegacyState)}\n`,
      { mode: 0o600 }
    );

    migrationCredentials = new CredentialStore(dataDir, {
      instanceId: initialState.instanceId
    });
    let markerPresentWhenSessionMigrationBegan = false;
    const simulatedCrash = new Error("simulated crash before legacy session conversion");
    await assert.rejects(
      createControlPlane({
        stateStore,
        dataDir,
        credentialStore: migrationCredentials,
        sessionStore: {
          async initialize() {
            markerPresentWhenSessionMigrationBegan = migrationCredentials.hasCredential(
              "browser-auth-state",
              "schema"
            );
            throw simulatedCrash;
          }
        },
        log: () => {}
      }),
      simulatedCrash
    );
    assert.equal(
      markerPresentWhenSessionMigrationBegan,
      true,
      "the durable anti-downgrade marker must precede legacy session conversion"
    );
    assert.equal(
      await migrationCredentials.useCredential(
        "browser-auth-state",
        "schema",
        (value) => value.toString("utf8")
      ),
      "4"
    );
    await migrationCredentials.close();
    migrationCredentials = null;

    // Represent an attacker restoring or substituting v2 state after the
    // interrupted migration. The next process must honor the persisted marker
    // and reject the downgrade before it can contact any upstream service.
    await writeFile(
      path.join(dataDir, "sessions.json"),
      `${JSON.stringify({ ...substitutedLegacyState, revision: 12 })}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(
      startBroker(dataDir, [], {
        dispatchUpstream: async (input) => {
          upstreamCalls.push(input);
          throw new Error("marker-protected downgrade must fail before upstream dispatch");
        }
      }),
      /Legacy browser authorization state cannot replace sealed state/u
    );
    assert.equal(upstreamCalls.length, 0);
  } finally {
    await migrationCredentials?.close().catch(() => {});
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup cannot revoke a browser token while its session commit is in flight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-owner-staging-race-"));
  const dataDir = path.join(root, "data");
  let loginCount = 0;
  let context;
  let releaseCommit = () => {};
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath === "/Users/AuthenticateByName") {
          loginCount += 1;
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({
              AccessToken: loginCount === 1 ? OWNER_TOKEN : "second-owner-browser-token",
              ...jellyfinUser()
            }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (input.route.upstreamPath === "/Sessions/Logout") {
          return { status: 204, body: Buffer.alloc(0), contentType: "application/json", cookies: [] };
        }
        throw new Error(`unexpected staging-race route ${input.route.upstreamPath}`);
      }
    });
    const bootstrap = await claim(context);
    assert.equal((await saveJellyfin(context, bootstrap, "staging-race-monitor-token")).status, 200);
    assert.equal((await enrollJellyfinOwner(context, bootstrap)).status, 201);

    const sessions = context.broker.controlPlane.sessionStore;
    const originalLoginOwner = sessions.loginOwner.bind(sessions);
    const originalAuthenticateRequest = sessions.authenticateRequest.bind(sessions);
    let reportStaged;
    let reportCleanupTriggered;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    const staged = new Promise((resolve) => { reportStaged = resolve; });
    const cleanupTriggered = new Promise((resolve) => { reportCleanupTriggered = resolve; });
    sessions.loginOwner = async (options) => {
      reportStaged(options.preparedSession.sessionId);
      await commitGate;
      return originalLoginOwner(options);
    };
    sessions.authenticateRequest = async () => {
      reportCleanupTriggered();
      throw new SessionAuthError(401, "SESSION_EXPIRED", "The browser session expired.");
    };

    const pendingLogin = loginJellyfinOwner(context, { deviceName: "Staged browser" });
    const sessionId = await staged;
    const namespace = `browser-auth-${sessionId}`;
    assert.equal(browserTokenConfigured(context, sessionId), true);
    assert.equal(sessions.getInternalSession(sessionId), null);

    const pendingCleanup = getRequest(context, "/api/v2/status");
    await cleanupTriggered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browserTokenConfigured(context, sessionId), true);
    releaseCommit();

    const signedIn = await pendingLogin;
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.json));
    assert.equal(signedIn.json.session.id, sessionId);
    const status = await pendingCleanup;
    assert.equal(status.status, 200);
    assert.equal(status.json.authenticated, false);
    assert.notEqual(sessions.getInternalSession(sessionId), null);
    assert.equal(browserTokenConfigured(context, sessionId), true);
    sessions.loginOwner = originalLoginOwner;
    sessions.authenticateRequest = originalAuthenticateRequest;
  } finally {
    // Never leave the request holding the serialized mutation queue if an
    // assertion fails before the test's deliberate release point.
    releaseCommit();
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid setup claim reconciles orphaned authentication state from an interrupted prior claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-interrupted-claim-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const orphanedSession = await context.broker.controlPlane.sessionStore.issue({
      name: "Interrupted claim",
      origin: context.origin
    });
    const orphanedCookie = cookiePair({ headers: { "set-cookie": [orphanedSession.cookie] } });
    assert.equal(context.broker.store.snapshot().claimed, false);

    const recovered = await claim(context, "Recovered claim");
    assert.equal(Object.hasOwn(recovered.response.json, "accessKey"), false);
    assert.equal(context.broker.store.snapshot().claimed, true);
    const staleSession = await getRequest(context, "/api/v2/config", { cookie: orphanedCookie });
    assert.equal(staleSession.status, 401);
    assert.equal(staleSession.json.code, "SESSION_INVALID");
    const currentSession = await getRequest(context, "/api/v2/config", { cookie: recovered.cookie });
    assert.equal(currentSession.status, 200);

    const persistedText = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.version, 4);
    assert.equal(persisted.accessKeyHash, null);
    assert.equal(persisted.owner, null);
    assert.equal(Object.keys(persisted.sessions).length, 1);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("draft service tests are authenticated, read-only, bounded, pinned, and fully sanitized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-draft-test-"));
  const dataDir = path.join(root, "data");
  const logs = [];
  const draftSecret = "draft-connection-secret-never-persist";
  const savedSecret = "saved-connection-secret-never-return";
  const upstreamSecret = "raw-upstream-field-never-return";
  const calls = [];
  let context;
  try {
    context = await startBroker(dataDir, logs, {
      dispatchUpstream: async (input) => {
        calls.push(input);
        assert.equal(input.request.method, "GET");
        assert.equal(input.body.length, 0);
        assert.equal(input.targetResolution.target.url, "http://media.test:7878");
        assert.equal(input.targetResolution.pinned.address, "10.20.30.40");
        assert.equal(input.request.headers["x-api-key"] === draftSecret
          || input.request.headers["x-api-key"] === savedSecret, true);
        const expectedLimit = input.route.upstreamPath === "/api/v3/system/status"
          ? 64 * 1024
          : input.route.upstreamPath === "/api/v3/health"
            ? 256 * 1024
            : input.route.upstreamPath === "/api/v3/movie"
              ? 4 * 1024 * 1024
              : 2 * 1024 * 1024;
        assert.equal(input.limits.maxApiResponseBytes, expectedLimit);
        return {
          status: 200,
          body: Buffer.from(JSON.stringify(radarrProbeBody(input.route, upstreamSecret)), "utf8"),
          contentType: "application/json",
          cookies: []
        };
      }
    });
    const authentication = await claim(context);
    const initialState = context.broker.store.snapshot();
    const initialCredentials = context.broker.controlPlane.credentialStore.publicSnapshot();

    const noSession = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: draftSecret
    }, { csrf: authentication.csrf });
    assert.equal(noSession.status, 401);
    assert.equal(noSession.json.code, "SESSION_REQUIRED");

    const noCsrf = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: draftSecret
    }, { cookie: authentication.cookie });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    const wrongOrigin = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: draftSecret
    }, {
      cookie: authentication.cookie,
      csrf: authentication.csrf,
      origin: `http://localhost:${context.port}`
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.json.code, "ORIGIN_REJECTED");
    assert.equal(calls.length, 0);

    const tested = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878/",
      authMode: "apiKey",
      credential: draftSecret
    }, authentication);
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    assert.equal(tested.json.service, "radarr");
    assert.equal(tested.json.state, "healthy");
    assert.equal(tested.json.connectionState, "connected");
    assert.equal(tested.json.version, "6.3.0.10514");
    assert.deepEqual(tested.json.checks.map(({ id, state }) => ({ id, state })), [
      { id: "status", state: "healthy" },
      { id: "health", state: "healthy" },
      { id: "queue", state: "healthy" },
      { id: "catalog", state: "healthy" },
      { id: "calendar", state: "healthy" }
    ]);
    const serialized = JSON.stringify(tested.json);
    for (const forbidden of [draftSecret, upstreamSecret, "media.test", "body", "path", "startupPath"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(tested.headers["cache-control"], "private, no-store, max-age=0");
    assert.equal(calls.length, 5);
    assert.deepEqual(context.broker.store.snapshot().connections, initialState.connections);
    assert.deepEqual(context.broker.controlPlane.credentialStore.publicSnapshot(), initialCredentials);
    await assertFilesDoNotContain(dataDir, [draftSecret, upstreamSecret]);
    assert.equal(logs.join("\n").includes(draftSecret), false);
    assert.equal(logs.join("\n").includes(upstreamSecret), false);

    const blankForNewTarget = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7879",
      authMode: "apiKey",
      credential: ""
    }, authentication);
    assert.equal(blankForNewTarget.status, 400);
    assert.equal(blankForNewTarget.json.code, "CREDENTIAL_REQUIRED_FOR_TEST");
    assert.equal(calls.length, 5);

    const policyBlocked = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://192.168.1.2:7878",
      authMode: "apiKey",
      credential: draftSecret
    }, authentication);
    assert.equal(policyBlocked.status, 403);
    assert.equal(policyBlocked.json.code, "TARGET_NOT_ALLOWED");
    assert.equal(JSON.stringify(policyBlocked.json).includes(draftSecret), false);
    assert.equal(calls.length, 5);

    const saved = await saveRadarr(context, authentication, savedSecret);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const testedWithSavedCredential = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: ""
    }, authentication);
    assert.equal(testedWithSavedCredential.status, 200, JSON.stringify(testedWithSavedCredential.json));
    assert.equal(testedWithSavedCredential.json.state, "healthy");
    assert.equal(JSON.stringify(testedWithSavedCredential.json).includes(savedSecret), false);
    assert.ok(calls.some(({ request: upstreamRequest }) => upstreamRequest.headers["x-api-key"] === savedSecret));
    await assertFilesDoNotContain(dataDir, [draftSecret, savedSecret, upstreamSecret]);

    const savedState = context.broker.store.snapshot();
    const differentTargetWithoutCredential = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7879",
      authMode: "apiKey"
    }, authentication);
    assert.equal(differentTargetWithoutCredential.status, 400);
    assert.equal(differentTargetWithoutCredential.json.code, "CREDENTIAL_REQUIRED_FOR_TEST");
    assert.deepEqual(context.broker.store.snapshot(), savedState);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("service credentials are bound to their exact target and rotate with target changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-target-bound-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const saved = await saveRadarr(context, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const originalRevision = saved.json.targetRevision;
    const inFlightConnection = context.broker.store.snapshot().connections.radarr;

    const rejected = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7879",
      authMode: "apiKey",
      monitoringEnabled: true
    }, authentication);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, "CREDENTIAL_REQUIRED_FOR_NEW_TARGET");
    const unchanged = await getRequest(context, "/api/v2/services/radarr", {
      cookie: authentication.cookie
    });
    assert.equal(unchanged.json.url, "http://media.test:7878");
    assert.equal(unchanged.json.targetRevision, originalRevision);
    assert.equal(unchanged.json.credentialConfigured, true);

    const rotatedSecret = "rotated-control-plane-credential";
    const rotated = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7879",
      authMode: "apiKey",
      credential: rotatedSecret,
      monitoringEnabled: false
    }, authentication);
    assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
    assert.equal(rotated.json.url, "http://media.test:7879");
    assert.notEqual(rotated.json.targetRevision, originalRevision);
    assert.equal(rotated.json.credentialConfigured, true);
    assert.equal(rotated.json.monitoringEnabled, false);
    let suppliedAfterRotation = false;
    await assert.rejects(
      context.broker.controlPlane.useServiceCredential("radarr", inFlightConnection, async () => {
        suppliedAfterRotation = true;
      }),
      { code: "TARGET_CHANGED" }
    );
    assert.equal(suppliedAfterRotation, false);
    await assertFilesDoNotContain(dataDir, [SERVICE_SECRET, rotatedSecret]);

    await stopBroker(context);
    context = null;

    // Simulate offline tampering with the non-secret state while the external
    // encryption key remains unavailable to the attacker.
    const statePath = path.join(dataDir, "state.json");
    const tamperedState = JSON.parse(await readFile(statePath, "utf8"));
    tamperedState.connections.radarr.url = "http://media.test:7880";
    await writeFile(statePath, `${JSON.stringify(tamperedState)}\n`, { mode: 0o600 });

    context = await startBroker(dataDir, []);
    const metadata = context.broker.controlPlane.publicConfiguration()
      .services.find(({ id }) => id === "radarr");
    assert.equal(metadata.url, "http://media.test:7880");
    assert.equal(metadata.credentialConfigured, false);
    const tamperedConnection = context.broker.store.snapshot().connections.radarr;
    await assert.rejects(
      context.broker.controlPlane.useServiceCredential("radarr", tamperedConnection, async () => {
        throw new Error("credential must never be supplied for a tampered target");
      }),
      { code: "CREDENTIAL_NOT_CONFIGURED" }
    );
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a paused media probe cannot dispatch across a committed network-policy boundary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-media-policy-race-"));
  const dataDir = path.join(root, "data");
  const dispatches = [];
  let gateArmed = false;
  let gateConsumed = false;
  let enterGate;
  let releaseGate;
  const gateEntered = new Promise((resolve) => { enterGate = resolve; });
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let context;
  try {
    context = await startBroker(dataDir, [], {
      lookup: async (hostname) => {
        assert.equal(hostname, "media.test");
        if (gateArmed && !gateConsumed) {
          gateConsumed = true;
          enterGate();
          await gate;
        }
        return [{ address: "10.20.30.40", family: 4 }];
      },
      dispatchUpstream: async (input) => {
        dispatches.push({
          targetRevision: input.targetRevision,
          address: input.targetResolution.pinned.address,
          credential: input.request.headers["x-api-key"]
        });
        return {
          status: 200,
          body: Buffer.from(JSON.stringify(radarrProbeBody(input.route, "redacted")), "utf8"),
          contentType: "application/json",
          cookies: []
        };
      }
    });
    const authentication = await claim(context);
    const saved = await saveRadarr(context, authentication, "policy-race-secret");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    // Drain the startup/save refreshes so the gate below belongs to the cycle
    // that deliberately captures the old policy and connection.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settled = await jsonRequest(context, "/api/v2/operations/refresh", "POST", {}, authentication);
      assert.equal(settled.status, 200, JSON.stringify(settled.json));
    }
    dispatches.length = 0;
    const before = context.broker.store.snapshot();
    const oldRevision = before.connections.radarr.targetRevision;

    gateArmed = true;
    const staleRefresh = jsonRequest(
      context,
      "/api/v2/operations/refresh",
      "POST",
      {},
      authentication
    );
    await gateEntered;

    const changed = await jsonRequest(context, "/api/v2/config", "PUT", {
      allowedCidrs: ["10.20.0.0/16"],
      allowPublicHttps: false
    }, authentication);
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    const after = context.broker.store.snapshot();
    assert.notEqual(after.connections.radarr.targetRevision, oldRevision);
    assert.deepEqual(after.policy.allowedCidrs, ["10.20.0.0/16"]);

    releaseGate();
    const staleResult = await staleRefresh;
    assert.equal(staleResult.status, 200, JSON.stringify(staleResult.json));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      dispatches.some(({ targetRevision }) => targetRevision === oldRevision),
      false,
      "the request pinned under the prior policy must fail before upstream dispatch"
    );
  } finally {
    releaseGate?.();
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed optional-service credential deletion cannot resurrect the secret after re-adding the same target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-service-delete-binding-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const saved = await saveRadarr(context, authentication, "credential-that-must-not-resurrect");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    const stateBeforeDelete = context.broker.store.snapshot();
    const oldConnection = stateBeforeDelete.connections.radarr;
    const oldNamespace = monitoringCredentialNamespace("radarr", oldConnection, stateBeforeDelete.policy);
    const credentialStore = context.broker.controlPlane.credentialStore;
    assert.equal(
      credentialStore.publicSnapshot().credentials?.[oldNamespace]?.apiKey?.configured,
      true
    );

    const removeCredential = credentialStore.removeServiceCredentials.bind(credentialStore);
    let injectedFailure = false;
    credentialStore.removeServiceCredentials = async (namespace) => {
      if (!injectedFailure && namespace === oldNamespace) {
        injectedFailure = true;
        throw new Error("injected optional-service credential deletion failure");
      }
      return removeCredential(namespace);
    };
    let deleted;
    try {
      deleted = await jsonRequest(context, "/api/v2/services/radarr", "DELETE", {}, authentication);
    } finally {
      credentialStore.removeServiceCredentials = removeCredential;
    }
    assert.equal(deleted.status, 500, JSON.stringify(deleted.json));
    assert.equal(deleted.json.code, "INTERNAL_ERROR");
    assert.equal(injectedFailure, true);
    assert.equal(context.broker.store.snapshot().connections.radarr, undefined);
    assert.equal(
      credentialStore.publicSnapshot().credentials?.[oldNamespace]?.apiKey?.configured,
      true,
      "the injected failure must leave the old encrypted record behind"
    );

    const readded = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: oldConnection.url,
      authMode: "apiKey",
      monitoringEnabled: false
    }, authentication);
    assert.equal(readded.status, 200, JSON.stringify(readded.json));
    assert.equal(readded.json.credentialConfigured, false);
    assert.notEqual(readded.json.targetRevision, oldConnection.targetRevision);

    const readdedState = context.broker.store.snapshot();
    const readdedConnection = readdedState.connections.radarr;
    const readdedNamespace = monitoringCredentialNamespace("radarr", readdedConnection, readdedState.policy);
    assert.notEqual(readdedNamespace, oldNamespace);
    assert.equal(credentialStore.publicSnapshot().credentials?.[readdedNamespace], undefined);
    assert.equal(
      credentialStore.publicSnapshot().credentials?.[oldNamespace]?.apiKey?.configured,
      true,
      "the stale record remains present only to prove the new revision cannot select it"
    );

    let leaked = false;
    await assert.rejects(
      context.broker.controlPlane.useServiceCredential("radarr", readdedConnection, async () => {
        leaked = true;
      }),
      { code: "CREDENTIAL_NOT_CONFIGURED" }
    );
    assert.equal(leaked, false);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing an optional-service credential rotates its revision before deletion and stays cleared after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-service-clear-binding-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const saved = await saveRadarr(context, authentication, "credential-that-must-stay-cleared");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    const before = context.broker.store.snapshot();
    const oldConnection = before.connections.radarr;
    const oldNamespace = monitoringCredentialNamespace("radarr", oldConnection, before.policy);
    const credentialStore = context.broker.controlPlane.credentialStore;
    assert.equal(credentialStore.publicSnapshot().credentials?.[oldNamespace]?.apiKey?.configured, true);

    const removeCredential = credentialStore.removeServiceCredentials.bind(credentialStore);
    let injectedFailure = false;
    credentialStore.removeServiceCredentials = async (namespace) => {
      if (!injectedFailure && namespace === oldNamespace) {
        injectedFailure = true;
        throw new Error("injected optional-service clear failure");
      }
      return removeCredential(namespace);
    };
    let cleared;
    try {
      cleared = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
        url: oldConnection.url,
        authMode: oldConnection.authMode,
        clearCredential: true,
        monitoringEnabled: oldConnection.monitoringEnabled
      }, authentication);
    } finally {
      credentialStore.removeServiceCredentials = removeCredential;
    }

    assert.equal(cleared.status, 500, JSON.stringify(cleared.json));
    assert.equal(cleared.json.code, "INTERNAL_ERROR");
    assert.equal(injectedFailure, true);
    const afterFailure = context.broker.store.snapshot();
    const clearedConnection = afterFailure.connections.radarr;
    assert.notEqual(clearedConnection.targetRevision, oldConnection.targetRevision);
    const clearedNamespace = monitoringCredentialNamespace("radarr", clearedConnection, afterFailure.policy);
    assert.notEqual(clearedNamespace, oldNamespace);
    assert.equal(credentialStore.publicSnapshot().credentials?.[clearedNamespace], undefined);
    assert.equal(
      credentialStore.publicSnapshot().credentials?.[oldNamespace]?.apiKey?.configured,
      true,
      "the injected failure must leave the old encrypted record behind for the binding check"
    );

    let suppliedBeforeRestart = false;
    await assert.rejects(
      context.broker.controlPlane.useServiceCredential("radarr", clearedConnection, async () => {
        suppliedBeforeRestart = true;
      }),
      { code: "CREDENTIAL_NOT_CONFIGURED" }
    );
    assert.equal(suppliedBeforeRestart, false);

    await stopBroker(context);
    context = null;
    context = await startBroker(dataDir, []);

    const restartedState = context.broker.store.snapshot();
    const restartedConnection = restartedState.connections.radarr;
    assert.equal(restartedConnection.targetRevision, clearedConnection.targetRevision);
    const metadata = context.broker.controlPlane.publicConfiguration()
      .services.find(({ id }) => id === "radarr");
    assert.equal(metadata.credentialConfigured, false);
    assert.equal(
      context.broker.controlPlane.credentialStore.publicSnapshot().credentials?.[oldNamespace],
      undefined,
      "startup cleanup must remove the orphaned pre-clear record"
    );

    let suppliedAfterRestart = false;
    await assert.rejects(
      context.broker.controlPlane.useServiceCredential("radarr", restartedConnection, async () => {
        suppliedAfterRestart = true;
      }),
      { code: "CREDENTIAL_NOT_CONFIGURED" }
    );
    assert.equal(suppliedAfterRestart, false);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("startup migrates a b2 policy-bound credential to b3 and prefers it over a stale URL-only record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-service-b3-migration-"));
  const dataDir = path.join(root, "data");
  const legacySecret = "stale-url-only-credential";
  const policyBoundSecret = "current-b2-policy-bound-credential";
  const logs = [];
  let context;
  try {
    context = await startBroker(dataDir, logs);
    const authentication = await claim(context);
    const saved = await saveRadarr(context, authentication, "temporary-b3-seed-credential");
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    const state = context.broker.store.snapshot();
    const connection = state.connections.radarr;
    const b3Namespace = monitoringCredentialNamespace("radarr", connection, state.policy);
    const b2Namespace = policyBoundMonitoringCredentialNamespaceV2("radarr", connection, state.policy);
    const legacyNamespace = legacyMonitoringCredentialNamespace("radarr", connection);
    assert.notEqual(b3Namespace, b2Namespace);
    assert.notEqual(b2Namespace, legacyNamespace);

    const credentialStore = context.broker.controlPlane.credentialStore;
    await credentialStore.replaceServiceCredentials(legacyNamespace, { apiKey: legacySecret });
    await credentialStore.replaceServiceCredentials(b2Namespace, { apiKey: policyBoundSecret });
    await credentialStore.removeServiceCredentials(b3Namespace);
    const staged = credentialStore.publicSnapshot().credentials;
    assert.equal(staged?.[legacyNamespace]?.apiKey?.configured, true);
    assert.equal(staged?.[b2Namespace]?.apiKey?.configured, true);
    assert.equal(staged?.[b3Namespace], undefined);

    await stopBroker(context);
    context = null;
    context = await startBroker(dataDir, logs);

    const migrated = context.broker.controlPlane.credentialStore.publicSnapshot().credentials;
    assert.equal(migrated?.[legacyNamespace], undefined);
    assert.equal(migrated?.[b2Namespace], undefined);
    assert.equal(migrated?.[b3Namespace]?.apiKey?.configured, true);
    assert.ok(logs.includes("Credential destination bindings upgraded."));

    let suppliedCredential = null;
    await context.broker.controlPlane.useServiceCredential(
      "radarr",
      context.broker.store.snapshot().connections.radarr,
      async (credential) => {
        suppliedCredential = credential.toString("utf8");
      }
    );
    assert.equal(suppliedCredential, policyBoundSecret);
    assert.notEqual(suppliedCredential, legacySecret);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("reset-access revokes sessions while preserving targets and encrypted credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jellofin-control-reset-"));
  const dataDir = path.join(root, "data");
  const logs = [];
  let context;

  try {
    context = await startBroker(dataDir, logs);
    const originalInstanceId = context.broker.store.snapshot().instanceId;
    const original = await claim(context, "Before reset");
    const saved = await saveRadarr(context, original);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const originalCookie = original.cookie;

    await stopBroker(context);
    context = null;

    const reset = await runResetAccess(dataDir);
    assert.equal(reset.code, 0, reset.stderr || reset.stdout);
    assert.match(reset.stdout, /Saved services and encrypted credentials were preserved/u);

    const resetState = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    const resetSessions = JSON.parse(await readFile(path.join(dataDir, "sessions.json"), "utf8"));
    assert.equal(resetState.claimed, false);
    assert.equal(resetState.setupTokenHash, null);
    assert.equal(resetState.instanceId, originalInstanceId);
    assert.equal(resetState.connections.radarr.url, "http://media.test:7878");
    assert.equal(resetSessions.version, 4);
    assert.equal(resetSessions.accessKeyHash, null);
    assert.equal(resetSessions.owner, null);
    assert.deepEqual(resetSessions.sessions, {});
    await assertFilesDoNotContain(dataDir, [SERVICE_SECRET, cookieToken(originalCookie)]);

    context = await startBroker(dataDir, logs);
    assert.match(context.broker.setupToken, /^[A-Za-z0-9_-]{43}$/u);
    const status = await getRequest(context, "/api/v2/status");
    assert.equal(status.json.setupRequired, true);

    const revoked = await getRequest(context, "/api/v2/config", { cookie: originalCookie });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.json.code, "SESSION_INVALID");

    const replacement = await claim(context, "After reset");
    const metadata = await getRequest(context, "/api/v2/services/radarr", {
      cookie: replacement.cookie
    });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.json.configured, true);
    assert.equal(metadata.json.url, "http://media.test:7878");
    assert.equal(metadata.json.credentialConfigured, true);
    assert.equal(Object.hasOwn(metadata.json, "credential"), false);
    assert.equal(Object.hasOwn(metadata.json, "apiKey"), false);
    assert.equal(JSON.stringify(metadata.json).includes(SERVICE_SECRET), false);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin and Seerr publish token-or-login choices and cannot be saved unauthenticated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-required-service-auth-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const config = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
    assert.equal(config.status, 200, JSON.stringify(config.json));

    const jellyfin = config.json.services.find(({ id }) => id === "jellyfin");
    const seerr = config.json.services.find(({ id }) => id === "seerr");
    assert.deepEqual(jellyfin.authOptions.map(({ id, input }) => ({ id, input })), [
      { id: "token", input: "secret" },
      { id: "login", input: "login" }
    ]);
    assert.deepEqual(seerr.authOptions.map(({ id, input }) => ({ id, input })), [
      { id: "apiKey", input: "secret" },
      { id: "login", input: "login" }
    ]);
    assert.equal(seerr.authOptions.find(({ id }) => id === "login").identityLabel, "Seerr account email");
    for (const service of [jellyfin, seerr]) {
      assert.equal(Object.hasOwn(service, "credential"), false);
      assert.equal(Object.hasOwn(service, "login"), false);
      assert.ok(service.authOptions.every((option) => !Object.hasOwn(option, "value")));
    }

    for (const [service, authMode, url] of [
      ["jellyfin", "token", "http://media.test:8096"],
      ["seerr", "apiKey", "http://media.test:5055"]
    ]) {
      const missing = await jsonRequest(context, `/api/v2/services/${service}`, "PUT", {
        url,
        authMode,
        monitoringEnabled: false
      }, authentication);
      assert.equal(missing.status, 400, JSON.stringify(missing.json));
      assert.equal(missing.json.code, "CREDENTIAL_REQUIRED");
      assert.equal(context.broker.store.snapshot().connections[service], undefined);
    }

    const invalidCases = [
      ["jellyfin", {
        url: "http://media.test:8096",
        authMode: "login",
        credential: "wrong-field",
        monitoringEnabled: false
      }, "INVALID_REQUEST"],
      ["jellyfin", {
        url: "http://media.test:8096",
        authMode: "token",
        login: { username: "user", password: "wrong-fields" },
        monitoringEnabled: false
      }, "INVALID_REQUEST"],
      ["seerr", {
        url: "http://media.test:5055",
        authMode: "login",
        login: { username: "local@example.test", password: "secret", extra: true },
        monitoringEnabled: false
      }, "INVALID_REQUEST"],
      ["seerr", {
        url: "http://media.test:5055",
        authMode: "login",
        login: { username: "local@example.test" },
        monitoringEnabled: false
      }, "INVALID_LOGIN"],
      ["seerr", {
        url: "http://media.test:5055",
        authMode: "none",
        monitoringEnabled: false
      }, "AUTH_MODE_NOT_SUPPORTED"],
      ["jellyfin", {
        url: "http://media.test:8096",
        authMode: "token",
        clearCredential: true,
        monitoringEnabled: false
      }, "CREDENTIAL_REQUIRED"]
    ];
    for (const [service, payload, code] of invalidCases) {
      const invalid = await jsonRequest(context, `/api/v2/services/${service}`, "PUT", payload, authentication);
      assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
      assert.equal(invalid.json.code, code);
      assert.equal(context.broker.store.snapshot().connections[service], undefined);
    }
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin one-time login stores only its derived token and zeroes transient request bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-jellyfin-login-"));
  const dataDir = path.join(root, "data");
  const logs = [];
  const username = "helmsman-jellyfin-user";
  const password = "jellyfin-password-must-be-discarded";
  const token = "jellyfin-derived-token-must-remain-encrypted";
  const calls = [];
  let loginBody;
  let context;
  try {
    context = await startBroker(dataDir, logs, {
      dispatchUpstream: async (input) => {
        calls.push(input);
        const { upstreamPath } = input.route;
        if (upstreamPath === "/Users/AuthenticateByName") {
          loginBody = input.body;
          assert.equal(input.request.method, "POST");
          assert.equal(input.request.headers["x-api-key"], undefined);
          assert.equal(input.request.headers.cookie, undefined);
          const authorization = String(input.request.headers.authorization || "");
          assert.match(authorization, /^MediaBrowser /u);
          assert.doesNotMatch(authorization, /(?:Token|token)=/u);
          assert.deepEqual(JSON.parse(loginBody.toString("utf8")), { Username: username, Pw: password });
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ AccessToken: token, User: { Id: "user-1" } }), "utf8"),
            contentType: "application/json",
            loginSession: null,
            cookies: []
          };
        }
        if (upstreamPath === "/System/Info/Public") {
          assert.equal(input.request.headers.authorization, undefined);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ Version: "10.11.8" }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (upstreamPath === "/System/Info") {
          assert.match(String(input.request.headers.authorization || ""), new RegExp(`Token="${token}"`, "u"));
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ Id: "server-1", Version: "10.11.8" }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected Jellyfin route ${upstreamPath}`);
      }
    });
    const authentication = await claim(context);
    const saved = await jsonRequest(context, "/api/v2/services/jellyfin", "PUT", {
      url: "http://media.test:8096",
      authMode: "login",
      login: { username, password },
      monitoringEnabled: false
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.authMode, "login");
    assert.equal(saved.json.credentialConfigured, true);
    for (const forbidden of [username, password, token]) {
      assert.equal(JSON.stringify(saved.json).includes(forbidden), false);
      assert.equal(logs.join("\n").includes(forbidden), false);
    }
    assert.ok(Buffer.isBuffer(loginBody));
    assert.ok(loginBody.every((byte) => byte === 0), "the transient Jellyfin login body was not zeroed");

    const connection = context.broker.store.snapshot().connections.jellyfin;
    await context.broker.controlPlane.useServiceCredential("jellyfin", connection, async (credential) => {
      assert.equal(credential.toString("utf8"), token);
    });
    const tested = await jsonRequest(context, "/api/v2/services/jellyfin/test", "POST", {
      url: "http://media.test:8096",
      authMode: "login"
    }, authentication);
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    assert.equal(tested.json.connectionState, "connected");
    assert.equal(calls.filter(({ route }) => route.upstreamPath === "/Users/AuthenticateByName").length, 1);
    await assertFilesDoNotContain(dataDir, [username, password, token]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Seerr local login stores only a strict session wrapper and probes with connect.sid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-seerr-login-"));
  const dataDir = path.join(root, "data");
  const logs = [];
  const email = "helmsman-local@example.test";
  const password = "seerr-password-must-be-discarded";
  const session = "s%3Astrict-seerr-session.signature";
  const calls = [];
  let loginBody;
  let context;
  try {
    context = await startBroker(dataDir, logs, {
      dispatchUpstream: async (input) => {
        calls.push(input);
        const { upstreamPath } = input.route;
        if (upstreamPath === "/api/v1/auth/local") {
          loginBody = input.body;
          assert.equal(input.request.method, "POST");
          assert.equal(input.request.headers["x-api-key"], undefined);
          assert.equal(input.request.headers.cookie, undefined);
          assert.deepEqual(JSON.parse(loginBody.toString("utf8")), { email, password });
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ id: 12, email }), "utf8"),
            contentType: "application/json",
            loginSession: { name: "connect.sid", value: session },
            cookies: []
          };
        }
        if (upstreamPath === "/api/v1/status") {
          assert.equal(input.request.headers.cookie, undefined);
          assert.equal(input.request.headers["x-api-key"], undefined);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ version: "2.7.3" }), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (["/api/v1/auth/me", "/api/v1/request/count"].includes(upstreamPath)) {
          const brokerCookie = String(input.request.headers.cookie || "");
          assert.match(brokerCookie, /^JFC_SEERR_[a-f0-9]{32}=[A-Za-z0-9_-]+$/u);
          const wrapped = brokerCookie.slice(brokerCookie.indexOf("=") + 1);
          assert.equal(Buffer.from(wrapped, "base64url").toString("utf8"), `connect.sid\0${session}`);
          assert.equal(input.request.headers["x-api-key"], undefined);
          assert.equal(input.request.headers.authorization, undefined);
          const body = upstreamPath.endsWith("/count")
            ? { total: 1, pending: 0 }
            : { id: 12, email };
          return {
            status: 200,
            body: Buffer.from(JSON.stringify(body), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected Seerr route ${upstreamPath}`);
      }
    });
    const authentication = await claim(context);
    const saved = await jsonRequest(context, "/api/v2/services/seerr", "PUT", {
      url: "http://media.test:5055",
      authMode: "login",
      login: { username: email, password },
      monitoringEnabled: false
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.authMode, "login");
    assert.equal(saved.json.credentialConfigured, true);
    assert.ok(Buffer.isBuffer(loginBody));
    assert.ok(loginBody.every((byte) => byte === 0), "the transient Seerr login body was not zeroed");

    const connection = context.broker.store.snapshot().connections.seerr;
    await context.broker.controlPlane.useServiceCredential("seerr", connection, async (credential) => {
      const wrapped = credential.toString("utf8");
      assert.doesNotMatch(wrapped, /connect\.sid|strict-seerr-session/u);
      assert.equal(Buffer.from(wrapped, "base64url").toString("utf8"), `connect.sid\0${session}`);
    });

    const tested = await jsonRequest(context, "/api/v2/services/seerr/test", "POST", {
      url: "http://media.test:5055",
      authMode: "login"
    }, authentication);
    assert.equal(tested.status, 200, JSON.stringify(tested.json));
    assert.equal(tested.json.connectionState, "connected");
    assert.equal(calls.some(({ route }) => route.upstreamPath.includes("checkUpdateAvailable")), false);
    for (const forbidden of [email, password, session]) {
      assert.equal(JSON.stringify(saved.json).includes(forbidden), false);
      assert.equal(JSON.stringify(tested.json).includes(forbidden), false);
      assert.equal(logs.join("\n").includes(forbidden), false);
    }
    await assertFilesDoNotContain(dataDir, [email, password, session]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("saved Seerr monitoring enriches request metadata through typed authenticated detail routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-seerr-monitor-enrichment-"));
  const dataDir = path.join(root, "data");
  const apiKey = "seerr-enrichment-key-must-stay-server-side";
  const calls = [];
  const requestFeed = {
    pageInfo: { pages: 1, pageSize: 2, results: 2, page: 1 },
    results: [
      {
        id: 701,
        status: 1,
        createdAt: "2026-09-14T10:00:00.000Z",
        media: { id: 1701, mediaType: "movie", tmdbId: 550, status: 2 }
      },
      {
        id: 702,
        status: 2,
        createdAt: "2026-09-14T10:01:00.000Z",
        seasons: [{ seasonNumber: 1 }],
        media: {
          id: 1702,
          mediaType: "tv",
          tmdbId: 1399,
          status: 3,
          seasons: [{ seasonNumber: 1, status: 3 }]
        }
      }
    ]
  };
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        const upstreamPath = input.route.upstreamPath;
        calls.push({
          upstreamPath,
          upstreamPathAndQuery: input.route.upstreamPathAndQuery,
          targetRevision: input.targetRevision,
          headers: { ...input.request.headers }
        });
        let body;
        if (upstreamPath === "/api/v1/status") body = { version: "2.7.3" };
        else if (upstreamPath === "/api/v1/auth/me") body = { id: 12, email: "operator@example.test" };
        else if (upstreamPath === "/api/v1/request/count") {
          body = { total: 2, pending: 1, approved: 1, processing: 1, available: 0 };
        } else if (upstreamPath === "/api/v1/request") body = requestFeed;
        else if (upstreamPath === "/api/v1/discover/trending") body = { page: 1, totalPages: 1, totalResults: 0, results: [] };
        else if (upstreamPath === "/api/v1/movie/550") {
          body = {
            id: 550,
            title: "Fight Club",
            releaseDate: "1999-10-15",
            posterPath: "/fight-club.jpg"
          };
        } else if (upstreamPath === "/api/v1/tv/1399") {
          body = {
            id: 1399,
            name: "Game of Thrones",
            firstAirDate: "2011-04-17",
            posterPath: "/game-of-thrones.jpg"
          };
        } else {
          throw new Error(`unexpected Seerr route ${input.route.upstreamPathAndQuery}`);
        }
        return {
          status: 200,
          body: Buffer.from(JSON.stringify(body), "utf8"),
          contentType: "application/json",
          cookies: []
        };
      }
    });
    const authentication = await claim(context, "Seerr enrichment browser");
    const saved = await jsonRequest(context, "/api/v2/services/seerr", "PUT", {
      url: "http://media.test:5055",
      authMode: "apiKey",
      credential: apiKey,
      monitoringEnabled: true
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    let refreshed = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      refreshed = await jsonRequest(context, "/api/v2/operations/refresh", "POST", {}, authentication);
      if (refreshed.json?.services?.some(({ id }) => id === "seerr")) break;
    }
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    const service = refreshed.json.services.find(({ id }) => id === "seerr");
    assert.ok(service, JSON.stringify(refreshed.json));

    const monitoringCalls = calls.filter(({ targetRevision }) => targetRevision === saved.json.targetRevision);
    const metadataCalls = monitoringCalls.filter(({ upstreamPath }) => (
      /^\/api\/v1\/(?:movie|tv)\/[0-9]+$/u.test(upstreamPath)
    ));
    assert.deepEqual(
      metadataCalls.map(({ upstreamPathAndQuery }) => upstreamPathAndQuery).sort(),
      ["/api/v1/movie/550", "/api/v1/tv/1399"]
    );
    assert.ok(metadataCalls.every(({ headers }) => headers["x-api-key"] === apiKey));
    assert.ok(metadataCalls.every(({ headers }) => headers.cookie === undefined && headers.authorization === undefined));
    assert.equal(monitoringCalls.some(({ upstreamPath }) => upstreamPath === "/api/v1/search"), false);

    assert.deepEqual(service.checks.map(({ id }) => id), [
      "status",
      "identity",
      "requestcounts",
      "requests",
      "trending"
    ]);
    assert.equal(service.checks.some(({ id }) => id === "requestMetadata"), false);
    assert.equal(service.state, "healthy");
    assert.equal(refreshed.json.incidents.open.some(({ capability }) => capability === "requestMetadata"), false);

    const requests = refreshed.json.media.requests;
    assert.deepEqual(requests.map(({ title, year }) => ({ title, year })), [
      { title: "Fight Club", year: 1999 },
      { title: "Game of Thrones", year: 2011 }
    ]);
    assert.ok(requests.every(({ artworkUrl }) => /^\/api\/v2\/media\/artwork\/[a-f0-9]{32}$/u.test(artworkUrl)));
    assert.equal(JSON.stringify(refreshed.json).includes(apiKey), false);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Seerr login exchanges never replace a working API key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-seerr-login-failure-"));
  const dataDir = path.join(root, "data");
  const apiKey = "working-seerr-key-that-must-survive";
  const password = "rejected-password-must-be-discarded";
  let failure = "rejected";
  const loginBodies = [];
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        if (input.route.upstreamPath !== "/api/v1/auth/local") {
          throw new Error(`unexpected Seerr route ${input.route.upstreamPath}`);
        }
        loginBodies.push(input.body);
        if (failure === "rejected") {
          return {
            status: 401,
            body: Buffer.from('{"message":"invalid"}', "utf8"),
            contentType: "application/json",
            loginSession: null,
            cookies: []
          };
        }
        if (failure === "missing") {
          return {
            status: 200,
            body: Buffer.from('{"id":12}', "utf8"),
            contentType: "application/json",
            loginSession: null,
            cookies: []
          };
        }
        return {
          status: 200,
          body: Buffer.from('{"id":12}', "utf8"),
          contentType: "application/json",
          loginSession: { name: "SID", value: "wrong-service-session" },
          cookies: []
        };
      }
    });
    const authentication = await claim(context);
    const saved = await jsonRequest(context, "/api/v2/services/seerr", "PUT", {
      url: "http://media.test:5055",
      authMode: "apiKey",
      credential: apiKey,
      monitoringEnabled: false
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const original = context.broker.store.snapshot().connections.seerr;

    for (failure of ["rejected", "missing", "invalid"]) {
      const attempted = await jsonRequest(context, "/api/v2/services/seerr", "PUT", {
        url: "http://media.test:5055",
        authMode: "login",
        login: { username: "local@example.test", password },
        monitoringEnabled: false
      }, authentication);
      assert.ok(attempted.status >= 400, `${failure}: ${JSON.stringify(attempted.json)}`);
      assert.equal(JSON.stringify(attempted.json).includes(password), false);
      assert.deepEqual(context.broker.store.snapshot().connections.seerr, original);
      await context.broker.controlPlane.useServiceCredential("seerr", original, async (credential) => {
        assert.equal(credential.toString("utf8"), apiKey);
      });
    }
    assert.equal(loginBodies.length, 3);
    assert.ok(loginBodies.every((body) => body.every((byte) => byte === 0)));
    await assertFilesDoNotContain(dataDir, [password]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Jellyfin and Seerr require fresh authentication when URL or auth mode changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-service-auth-rotation-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const jellyfin = await jsonRequest(context, "/api/v2/services/jellyfin", "PUT", {
      url: "http://media.test:8096",
      authMode: "token",
      credential: "initial-jellyfin-token",
      monitoringEnabled: false
    }, authentication);
    assert.equal(jellyfin.status, 200, JSON.stringify(jellyfin.json));
    const seerr = await jsonRequest(context, "/api/v2/services/seerr", "PUT", {
      url: "http://media.test:5055",
      authMode: "apiKey",
      credential: "initial-seerr-key",
      monitoringEnabled: false
    }, authentication);
    assert.equal(seerr.status, 200, JSON.stringify(seerr.json));

    for (const [service, payload] of [
      ["jellyfin", { url: "http://media.test:8097", authMode: "token", monitoringEnabled: false }],
      ["jellyfin", { url: "http://media.test:8096", authMode: "login", monitoringEnabled: false }],
      ["seerr", { url: "http://media.test:5056", authMode: "apiKey", monitoringEnabled: false }],
      ["seerr", { url: "http://media.test:5055", authMode: "login", monitoringEnabled: false }]
    ]) {
      const rejected = await jsonRequest(context, `/api/v2/services/${service}`, "PUT", payload, authentication);
      assert.equal(rejected.status, 409, `${service}: ${JSON.stringify(rejected.json)}`);
      assert.equal(rejected.json.code, "CREDENTIAL_REQUIRED_FOR_NEW_TARGET");
    }
    assert.equal(context.broker.store.snapshot().connections.jellyfin.url, "http://media.test:8096");
    assert.equal(context.broker.store.snapshot().connections.jellyfin.authMode, "token");
    assert.equal(context.broker.store.snapshot().connections.seerr.url, "http://media.test:5055");
    assert.equal(context.broker.store.snapshot().connections.seerr.authMode, "apiKey");
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("service login attempts are rate limited across browser sessions per service", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-login-rate-limit-"));
  const dataDir = path.join(root, "data");
  let upstreamAttempts = 0;
  let context;
  try {
    context = await startBroker(dataDir, [], {
      dispatchUpstream: async (input) => {
        assert.equal(input.route.upstreamPath, "/Users/AuthenticateByName");
        upstreamAttempts += 1;
        return {
          status: 401,
          body: Buffer.from('{"message":"invalid"}', "utf8"),
          contentType: "application/json",
          loginSession: null,
          cookies: []
        };
      }
    });
    const authentication = await claim(context);
    const paired = await context.broker.controlPlane.sessionStore.issue({
      name: "Second bootstrap browser",
      origin: context.origin,
      host: `127.0.0.1:${context.port}`
    });
    const pairedAuthentication = {
      cookie: cookiePair({ headers: { "set-cookie": [paired.cookie] } }),
      csrf: paired.csrfToken
    };

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const rejected = await jsonRequest(context, "/api/v2/services/jellyfin/test", "POST", {
        url: "http://media.test:8096",
        authMode: "login",
        login: { username: "user", password: `wrong-password-${attempt}` }
      }, authentication);
      assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
      assert.equal(rejected.json.code, "SERVICE_LOGIN_REJECTED");
    }
    const finalAllowed = await jsonRequest(context, "/api/v2/services/jellyfin/test", "POST", {
      url: "http://media.test:8096",
      authMode: "login",
      login: { username: "user", password: "wrong-password-from-second-browser" }
    }, pairedAuthentication);
    assert.equal(finalAllowed.status, 401, JSON.stringify(finalAllowed.json));
    assert.equal(finalAllowed.json.code, "SERVICE_LOGIN_REJECTED");

    const limited = await jsonRequest(context, "/api/v2/services/jellyfin/test", "POST", {
      url: "http://media.test:8096",
      authMode: "login",
      login: { username: "user", password: "one-attempt-too-many" }
    }, pairedAuthentication);
    assert.equal(limited.status, 429, JSON.stringify(limited.json));
    assert.equal(limited.json.code, "LOGIN_RATE_LIMITED");
    assert.equal(upstreamAttempts, 10);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("clearing manual CIDRs preserves exact private host pins for configured services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-policy-pin-migration-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const authentication = await claim(context);
    const saved = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: SERVICE_SECRET,
      clearCredential: false,
      monitoringEnabled: false
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(
      context.broker.store.snapshot().connections.radarr.approvedHostCidrs,
      [],
      "manual CIDRs, not redundant exact pins, are the saved authorization boundary"
    );

    const cleared = await jsonRequest(context, "/api/v2/config", "PUT", {
      allowedCidrs: [],
      allowPublicHttps: false
    }, authentication);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.deepEqual(cleared.json.policy.allowedCidrs, []);
    assert.deepEqual(
      context.broker.store.snapshot().connections.radarr.approvedHostCidrs,
      ["10.20.30.40/32"]
    );
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("saved credentials fail closed on DNS drift until a fresh credential re-enrolls the address", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-credential-dns-drift-"));
  const dataDir = path.join(root, "data");
  const replacementSecret = "replacement-secret-for-reviewed-address";
  const upstreamCalls = [];
  let resolvedAddress = "10.20.30.40";
  let context;
  try {
    context = await startBroker(dataDir, [], {
      lookup: async (hostname) => {
        assert.equal(hostname, "media.test");
        return [{ address: resolvedAddress, family: 4 }];
      },
      dispatchUpstream: async (input) => {
        upstreamCalls.push({
          address: input.targetResolution.pinned.address,
          credential: input.request.headers["x-api-key"]
        });
        return {
          status: 200,
          body: Buffer.from(JSON.stringify(radarrProbeBody(input.route, "redacted")), "utf8"),
          contentType: "application/json",
          cookies: []
        };
      }
    });
    const authentication = await claim(context, "DNS drift browser", {
      allowedCidrs: [],
      allowPublicHttps: false
    });
    const saved = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: SERVICE_SECRET,
      clearCredential: false,
      monitoringEnabled: false
    }, authentication);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(
      context.broker.store.snapshot().connections.radarr.approvedHostCidrs,
      ["10.20.30.40/32"]
    );
    const beforeDrift = context.broker.store.snapshot();

    resolvedAddress = "10.20.30.41";
    const blankTest = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: ""
    }, authentication);
    assert.equal(blankTest.status, 403, JSON.stringify(blankTest.json));
    assert.equal(blankTest.json.code, "TARGET_ADDRESS_CHANGED");
    assert.equal(upstreamCalls.length, 0, "saved credential must not reach the drifted address during Test");

    const blankSave = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      monitoringEnabled: false
    }, authentication);
    assert.equal(blankSave.status, 403, JSON.stringify(blankSave.json));
    assert.equal(blankSave.json.code, "TARGET_ADDRESS_CHANGED");
    assert.deepEqual(context.broker.store.snapshot(), beforeDrift);
    assert.equal(upstreamCalls.length, 0, "blank Save must not replay the saved credential or re-enroll DNS");

    const reviewedSave = await jsonRequest(context, "/api/v2/services/radarr", "PUT", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: replacementSecret,
      monitoringEnabled: false
    }, authentication);
    assert.equal(reviewedSave.status, 200, JSON.stringify(reviewedSave.json));
    assert.deepEqual(
      context.broker.store.snapshot().connections.radarr.approvedHostCidrs,
      ["10.20.30.41/32"]
    );
    assert.notEqual(reviewedSave.json.targetRevision, saved.json.targetRevision);

    const testAfterReview = await jsonRequest(context, "/api/v2/services/radarr/test", "POST", {
      url: "http://media.test:7878",
      authMode: "apiKey",
      credential: ""
    }, authentication);
    assert.equal(testAfterReview.status, 200, JSON.stringify(testAfterReview.json));
    assert.equal(testAfterReview.json.state, "healthy");
    assert.equal(upstreamCalls.length, 5);
    assert.ok(upstreamCalls.every(({ address }) => address === "10.20.30.41"));
    assert.ok(upstreamCalls.every(({ credential }) => credential === replacementSecret));
    await assertFilesDoNotContain(dataDir, [SERVICE_SECRET, replacementSecret]);
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("offline network-authorization edits cannot unlock an existing encrypted credential", async (suite) => {
  for (const scenario of ["approved host pin", "network policy"]) {
    await suite.test(scenario, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-credential-policy-tamper-"));
      const dataDir = path.join(root, "data");
      let context;
      try {
        context = await startBroker(dataDir, []);
        const authentication = await claim(context, "Policy binding browser", {
          allowedCidrs: [],
          allowPublicHttps: false
        });
        const saved = await saveRadarr(context, authentication);
        assert.equal(saved.status, 200, JSON.stringify(saved.json));
        await stopBroker(context);
        context = null;

        const statePath = path.join(dataDir, "state.json");
        const tamperedState = JSON.parse(await readFile(statePath, "utf8"));
        if (scenario === "approved host pin") {
          tamperedState.connections.radarr.approvedHostCidrs = ["10.20.30.41/32"];
        } else {
          tamperedState.policy.allowedCidrs = ["10.0.0.0/8"];
          tamperedState.policy.revision += 1;
        }
        await writeFile(statePath, `${JSON.stringify(tamperedState)}\n`, { mode: 0o600 });

        let supplied = false;
        context = await startBroker(dataDir, []);
        const connection = context.broker.store.snapshot().connections.radarr;
        const metadata = context.broker.controlPlane.publicConfiguration()
          .services.find(({ id }) => id === "radarr");
        assert.equal(metadata.credentialConfigured, false);
        await assert.rejects(
          context.broker.controlPlane.useServiceCredential("radarr", connection, async () => {
            supplied = true;
          }),
          { code: "CREDENTIAL_NOT_CONFIGURED" }
        );
        assert.equal(supplied, false);
      } finally {
        await stopBroker(context).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
