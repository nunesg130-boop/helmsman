import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBroker, createHttpServer } from "../server/broker.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_POLICY = Object.freeze({
  allowedCidrs: ["10.0.0.0/8"],
  allowPublicHttps: false
});
const SERVICE_SECRET = "control-plane-test-credential-do-not-store-plaintext";

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
    csrf: response.json.csrfToken,
    accessKey: response.json.accessKey
  };
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
  const names = await readdir(directory);
  for (const name of names) {
    const filePath = path.join(directory, name);
    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (error?.code === "EISDIR") continue;
      throw error;
    }
    for (const forbidden of forbiddenValues) {
      assert.equal(
        bytes.includes(Buffer.from(forbidden, "utf8")),
        false,
        `${name} persisted a forbidden plaintext value`
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
      ["/assets/services/seerr.jpg", "image/jpeg"]
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
  let context;
  let authentication;

  try {
    context = await startBroker(dataDir, logs);

    await suite.test("public status describes setup without exposing the setup token", async () => {
      const status = await getRequest(context, "/api/v2/status");
      assert.equal(status.status, 200);
      assert.equal(status.json.version, context.broker.version);
      assert.equal(status.json.setupRequired, true);
      assert.equal(status.json.accessKeyConfigured, false);
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

    await suite.test("claim returns the access key once and issues an HttpOnly Strict cookie", async () => {
      authentication = await claim(context);
      const setCookie = authentication.response.headers["set-cookie"][0];
      const token = cookieToken(authentication.cookie);

      assert.match(authentication.cookie, /^JFC_SESSION=[A-Za-z0-9_-]{43}$/u);
      assert.match(setCookie, /; Max-Age=31536000;/u);
      assert.match(setCookie, /; HttpOnly; SameSite=Strict$/u);
      assert.doesNotMatch(setCookie, /; Secure(?:;|$)/u, "localhost HTTP cookies must remain usable");
      assert.match(authentication.csrf, /^[A-Za-z0-9_-]{43}$/u);
      assert.match(authentication.accessKey, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(Object.hasOwn(authentication.response.json, "deviceToken"), false);
      assert.equal(Object.hasOwn(authentication.response.json, "token"), false);
      assert.equal(Object.hasOwn(authentication.response.json, "sessionToken"), false);
      assert.equal(JSON.stringify(authentication.response.json).includes(token), false);

      const sessionsState = await readFile(path.join(dataDir, "sessions.json"), "utf8");
      assert.equal(sessionsState.includes(authentication.accessKey), false);
      assert.equal(JSON.parse(sessionsState).version, 2);
      assert.match(JSON.parse(sessionsState).accessKeyHash, /^[a-f0-9]{64}$/u);

      const publicStatus = await getRequest(context, "/api/v2/status");
      assert.equal(publicStatus.json.setupRequired, false);
      assert.equal(publicStatus.json.accessKeyConfigured, true);
      assert.equal(publicStatus.json.authenticated, false);
      const privateStatus = await getRequest(context, "/api/v2/status", { cookie: authentication.cookie });
      assert.equal(privateStatus.json.authenticated, true);
      assert.equal(privateStatus.json.csrfToken, authentication.csrf);
    });

    await suite.test("the reusable key signs in new browsers and rotation revokes every prior session", async () => {
      const initial = authentication;
      const rejected = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: "z".repeat(43),
        deviceName: "Rejected browser",
        origin: context.origin
      });
      assert.equal(rejected.status, 401);
      assert.equal(rejected.json.code, "ACCESS_KEY_INVALID");

      const mismatchedOrigin = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: initial.accessKey,
        deviceName: "Wrong origin",
        origin: `http://localhost:${context.port}`
      });
      assert.equal(mismatchedOrigin.status, 400);
      assert.equal(mismatchedOrigin.json.code, "SECURE_ORIGIN_REQUIRED");

      const signedIn = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: initial.accessKey,
        deviceName: "Second browser",
        origin: context.origin
      });
      assert.equal(signedIn.status, 201, JSON.stringify(signedIn.json));
      assert.equal(Object.hasOwn(signedIn.json, "accessKey"), false);
      assert.match(signedIn.headers["set-cookie"][0], /; Max-Age=31536000;/u);
      const second = {
        cookie: cookiePair(signedIn),
        csrf: signedIn.json.csrfToken
      };

      const missingCsrf = await jsonRequest(context, "/api/v2/access/rotate", "POST", {}, {
        cookie: second.cookie
      });
      assert.equal(missingCsrf.status, 403);
      assert.equal(missingCsrf.json.code, "CSRF_TOKEN_REQUIRED");

      const rotated = await jsonRequest(context, "/api/v2/access/rotate", "POST", {}, second);
      assert.equal(rotated.status, 200, JSON.stringify(rotated.json));
      assert.match(rotated.json.accessKey, /^[A-Za-z0-9_-]{43}$/u);
      assert.notEqual(rotated.json.accessKey, initial.accessKey);
      const rotatedCookie = cookiePair(rotated);

      for (const cookie of [initial.cookie, second.cookie]) {
        const revoked = await getRequest(context, "/api/v2/config", { cookie });
        assert.equal(revoked.status, 401);
        assert.equal(revoked.json.code, "SESSION_INVALID");
      }
      const oldKey = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: initial.accessKey,
        deviceName: "Old key browser",
        origin: context.origin
      });
      assert.equal(oldKey.status, 401);
      assert.equal(oldKey.json.code, "ACCESS_KEY_INVALID");

      const persisted = await readFile(path.join(dataDir, "sessions.json"), "utf8");
      assert.equal(persisted.includes(initial.accessKey), false);
      assert.equal(persisted.includes(rotated.json.accessKey), false);
      assert.equal(logs.join("\n").includes(initial.accessKey), false);
      assert.equal(logs.join("\n").includes(rotated.json.accessKey), false);

      authentication = {
        response: rotated,
        cookie: rotatedCookie,
        csrf: rotated.json.csrfToken,
        accessKey: rotated.json.accessKey
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
        sessionToken,
        authentication.csrf,
        context.broker.setupToken
      ]);
      const serializedLogs = logs.join("\n");
      assert.equal(serializedLogs.includes(SERVICE_SECRET), false);
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

      const revoked = await getRequest(context, "/api/v2/config", { cookie: authentication.cookie });
      assert.equal(revoked.status, 401);
      assert.equal(revoked.json.code, "SESSION_INVALID");
    });
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("access-key login is unavailable before setup and has a bounded failure budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-access-login-limit-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const beforeSetup = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: "x".repeat(43),
      deviceName: "Before setup",
      origin: context.origin
    });
    assert.equal(beforeSetup.status, 409);
    assert.equal(beforeSetup.json.code, "SETUP_REQUIRED");

    const authentication = await claim(context);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejected = await jsonRequest(context, "/api/v2/access/login", "POST", {
        accessKey: "x".repeat(43),
        deviceName: `Rejected ${attempt}`,
        origin: context.origin
      });
      assert.equal(rejected.status, 401, `attempt ${attempt + 1}`);
      assert.equal(rejected.json.code, "ACCESS_KEY_INVALID");
    }
    const limited = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: "x".repeat(43),
      deviceName: "Rate limited",
      origin: context.origin
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.code, "ACCESS_LOGIN_RATE_LIMITED");

    const valid = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: authentication.accessKey,
      deviceName: "Valid browser behind shared proxy",
      origin: context.origin
    });
    assert.equal(valid.status, 201, JSON.stringify(valid.json));
    const resetBudget = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: "x".repeat(43),
      deviceName: "First rejected after success",
      origin: context.origin
    });
    assert.equal(resetBudget.status, 401);
    assert.equal(resetBudget.json.code, "ACCESS_KEY_INVALID");
  } finally {
    await stopBroker(context).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid setup claim reconciles orphaned access state from an interrupted prior claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-interrupted-claim-"));
  const dataDir = path.join(root, "data");
  let context;
  try {
    context = await startBroker(dataDir, []);
    const orphanedKey = await context.broker.controlPlane.sessionStore.rotateAccessKey();
    const orphanedSession = await context.broker.controlPlane.sessionStore.issue({
      name: "Interrupted claim",
      origin: context.origin
    });
    const orphanedCookie = cookiePair({ headers: { "set-cookie": [orphanedSession.cookie] } });
    assert.equal(context.broker.store.snapshot().claimed, false);

    const recovered = await claim(context, "Recovered claim");
    assert.notEqual(recovered.accessKey, orphanedKey);
    assert.equal(context.broker.store.snapshot().claimed, true);
    const staleSession = await getRequest(context, "/api/v2/config", { cookie: orphanedCookie });
    assert.equal(staleSession.status, 401);
    assert.equal(staleSession.json.code, "SESSION_INVALID");
    const currentSession = await getRequest(context, "/api/v2/config", { cookie: recovered.cookie });
    assert.equal(currentSession.status, 200);

    const persisted = await readFile(path.join(dataDir, "sessions.json"), "utf8");
    assert.equal(persisted.includes(orphanedKey), false);
    assert.equal(persisted.includes(recovered.accessKey), false);
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
    assert.equal(resetSessions.version, 2);
    assert.equal(resetSessions.accessKeyHash, null);
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
    const pairedResponse = await jsonRequest(context, "/api/v2/access/login", "POST", {
      accessKey: authentication.accessKey,
      deviceName: "Second browser",
      origin: context.origin
    });
    assert.equal(pairedResponse.status, 201, JSON.stringify(pairedResponse.json));
    const pairedAuthentication = {
      cookie: cookiePair(pairedResponse),
      csrf: pairedResponse.json.csrfToken
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
