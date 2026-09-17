import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
  const body = options.body === undefined ? null : Buffer.from(String(options.body), "utf8");
  const headers = { Host: `127.0.0.1:${port}`, ...(options.headers || {}) };
  if (body) headers["Content-Length"] = String(body.length);
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
        let json = null;
        if (bytes.length && String(response.headers["content-type"] || "").includes("application/json")) {
          json = JSON.parse(bytes.toString("utf8"));
        }
        resolve({ status: response.statusCode, headers: response.headers, json });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

function jsonRequest(context, pathname, payload, authentication = {}) {
  return request(context.port, pathname, {
    method: "POST",
    headers: {
      Origin: context.origin,
      "Content-Type": "application/json",
      ...(authentication.cookie ? { Cookie: authentication.cookie } : {}),
      ...(authentication.csrf ? { "X-Jellofin-Csrf": authentication.csrf } : {})
    },
    body: JSON.stringify(payload)
  });
}

function cookiePair(response) {
  const raw = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"];
  assert.equal(typeof raw, "string", "response did not issue a session cookie");
  return raw.split(";", 1)[0];
}

function jellyfinIdentity({ administrator = true, disabled = false } = {}) {
  return {
    ServerId: "server-1",
    Id: "user-1",
    Name: "Owner",
    Policy: { IsAdministrator: administrator, IsDisabled: disabled }
  };
}

test("browser auth uses fixed Jellyfin capabilities, stable identity, and zeroed credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-browser-auth-"));
  const dataDir = path.join(root, "data");
  const loginResponses = [];
  const loginBodies = [];
  const validationHeaders = [];
  const logoutHeaders = [];
  const logoutTargets = [];
  let validationIdentity = jellyfinIdentity();
  let context = null;
  const realDateNow = Date.now;
  try {
    const broker = await createBroker({
      dataDir,
      rootDir: PROJECT_ROOT,
      lookup: async (hostname) => {
        if (hostname === "media.test") return [{ address: "10.20.30.40", family: 4 }];
        if (hostname === "replacement.test") return [{ address: "10.99.0.5", family: 4 }];
        throw new Error(`unexpected hostname ${hostname}`);
      },
      dispatchUpstream: async (input) => {
        const pathName = input.route.upstreamPath;
        if (pathName === "/Users/AuthenticateByName") {
          loginBodies.push(input.body);
          const response = loginResponses.shift();
          assert.ok(response, "unexpected Jellyfin login exchange");
          assert.match(String(input.request.headers.authorization || ""), /^MediaBrowser /u);
          assert.doesNotMatch(String(input.request.headers.authorization || ""), /Token=/u);
          response.onStart?.();
          if (response.waitFor) await response.waitFor;
          return {
            status: response.status || 200,
            body: Buffer.from(JSON.stringify(response.body || {}), "utf8"),
            contentType: "application/json",
            loginSession: null,
            cookies: []
          };
        }
        if (pathName === "/Users/Me") {
          validationHeaders.push(String(input.request.headers.authorization || ""));
          return {
            status: 200,
            body: Buffer.from(JSON.stringify(validationIdentity), "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (pathName === "/Sessions/Logout") {
          logoutHeaders.push(String(input.request.headers.authorization || ""));
          logoutTargets.push(input.targetResolution.target.url);
          return {
            status: 204,
            body: Buffer.alloc(0),
            contentType: "application/json",
            cookies: []
          };
        }
        if (pathName === "/System/Info/Public") {
          return {
            status: 200,
            body: Buffer.from('{"Version":"10.11.8"}', "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        if (pathName === "/System/Info") {
          return {
            status: 200,
            body: Buffer.from('{"Id":"server-1","Version":"10.11.8"}', "utf8"),
            contentType: "application/json",
            cookies: []
          };
        }
        throw new Error(`unexpected Jellyfin route ${pathName}`);
      },
      log: () => {}
    });
    const server = createHttpServer(broker.handler);
    const port = await listen(server);
    context = { broker, server, port, origin: `http://127.0.0.1:${port}` };

    const claimed = await jsonRequest(context, "/api/v2/setup/claim", {
      setupToken: broker.setupToken,
      deviceName: "Bootstrap browser",
      origin: context.origin,
      ...PRIVATE_POLICY
    });
    assert.equal(claimed.status, 201, JSON.stringify(claimed.json));
    const bootstrap = { cookie: cookiePair(claimed), csrf: claimed.json.csrfToken };

    const saved = await request(port, "/api/v2/services/jellyfin", {
      method: "PUT",
      headers: {
        Origin: context.origin,
        "Content-Type": "application/json",
        Cookie: bootstrap.cookie,
        "X-Jellofin-Csrf": bootstrap.csrf
      },
      body: JSON.stringify({
        url: "http://media.test:8096",
        authMode: "token",
        credential: "monitoring-token",
        clearCredential: false,
        monitoringEnabled: false
      })
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));

    loginResponses.push({
      body: {
        AccessToken: "browser-token-one",
        ServerId: "server-1",
        User: jellyfinIdentity()
      }
    });
    const enrolled = await jsonRequest(context, "/api/v2/auth/jellyfin/enroll", {
      username: "Owner",
      password: "owner-password-one",
      deviceName: "Enrollment browser",
      origin: context.origin
    }, bootstrap);
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.json));
    assert.equal(enrolled.json.authentication.provider, "jellyfin");
    assert.equal(enrolled.json.authentication.ownerName, "Owner");
    assert.doesNotMatch(JSON.stringify(enrolled.json), /server-1|user-1|browser-token-one/u);
    const ownerSession = { cookie: cookiePair(enrolled), csrf: enrolled.json.csrfToken };

    let releasePolicyRace;
    let reportPolicyRaceStarted;
    const policyRaceWait = new Promise((resolve) => { releasePolicyRace = resolve; });
    const policyRaceStarted = new Promise((resolve) => { reportPolicyRaceStarted = resolve; });
    loginResponses.push({
      body: {
        AccessToken: "obsolete-boundary-token",
        ServerId: "server-1",
        User: jellyfinIdentity()
      },
      onStart: reportPolicyRaceStarted,
      waitFor: policyRaceWait
    });
    const racingLogin = jsonRequest(context, "/api/v2/auth/jellyfin/login", {
      username: "Owner",
      password: "owner-password-during-policy-change",
      deviceName: "Racing browser",
      origin: context.origin
    });
    await policyRaceStarted;
    await broker.store.mutate((next) => {
      next.policy = {
        ...next.policy,
        allowedCidrs: ["10.20.30.40/32"],
        revision: next.policy.revision + 1
      };
    });
    releasePolicyRace();
    const boundaryRejected = await racingLogin;
    assert.equal(boundaryRejected.status, 503, JSON.stringify(boundaryRejected.json));
    assert.equal(boundaryRejected.json.code, "JELLYFIN_AUTH_UNAVAILABLE");
    assert.ok(logoutHeaders.some((value) => value.includes('Token="obsolete-boundary-token"')));
    await broker.store.mutate((next) => {
      next.policy = {
        ...next.policy,
        allowedCidrs: [...PRIVATE_POLICY.allowedCidrs],
        revision: next.policy.revision + 1
      };
    });

    const originalConnection = structuredClone(broker.store.snapshot().connections.jellyfin);
    const originalLoginOwner = broker.controlPlane.sessionStore.loginOwner
      .bind(broker.controlPlane.sessionStore);
    broker.controlPlane.sessionStore.loginOwner = async () => {
      await broker.store.mutate((next) => {
        next.connections.jellyfin = {
          ...next.connections.jellyfin,
          url: "http://replacement.test:8096",
          targetRevision: "99999999-9999-4999-8999-999999999999",
          approvedHostCidrs: ["10.99.0.5/32"]
        };
      });
      throw new Error("forced session commit failure after target replacement");
    };
    loginResponses.push({
      body: {
        AccessToken: "old-target-cleanup-token",
        ServerId: "server-1",
        User: jellyfinIdentity()
      }
    });
    const failedCommit = await jsonRequest(context, "/api/v2/auth/jellyfin/login", {
      username: "Owner",
      password: "owner-password-before-target-replacement",
      deviceName: "Failed commit browser",
      origin: context.origin
    });
    assert.equal(failedCommit.status, 500, JSON.stringify(failedCommit.json));
    const cleanupIndex = logoutHeaders.findIndex((value) => value.includes('Token="old-target-cleanup-token"'));
    assert.notEqual(cleanupIndex, -1, "the old-boundary token was not cleaned up");
    assert.equal(logoutTargets[cleanupIndex], "http://media.test:8096");
    assert.equal(logoutTargets.some((target, index) => (
      target === "http://replacement.test:8096"
      && logoutHeaders[index].includes('Token="old-target-cleanup-token"')
    )), false);
    broker.controlPlane.sessionStore.loginOwner = originalLoginOwner;
    await broker.store.mutate((next) => {
      next.connections.jellyfin = structuredClone(originalConnection);
    });

    loginResponses.push({
      status: 401,
      body: { Message: "Guess exists", Password: "wrong-password" }
    });
    const badCredentials = await jsonRequest(context, "/api/v2/auth/jellyfin/login", {
      username: "Guess",
      password: "wrong-password",
      deviceName: "Unknown browser",
      origin: context.origin
    });
    assert.equal(badCredentials.status, 401, JSON.stringify(badCredentials.json));
    assert.equal(badCredentials.json.code, "JELLYFIN_AUTH_REJECTED");
    assert.doesNotMatch(JSON.stringify(badCredentials.json), /Guess|wrong-password|exists/u);

    loginResponses.push({
      body: {
        AccessToken: "non-admin-token",
        ServerId: "server-1",
        User: jellyfinIdentity({ administrator: false })
      }
    });
    const rejected = await jsonRequest(context, "/api/v2/auth/jellyfin/login", {
      username: "Other",
      password: "valid-but-not-owner",
      deviceName: "Rejected browser",
      origin: context.origin
    });
    assert.equal(rejected.status, 401, JSON.stringify(rejected.json));
    assert.equal(rejected.json.code, "JELLYFIN_AUTH_REJECTED");
    assert.doesNotMatch(JSON.stringify(rejected.json), /Other|valid-but-not-owner|non-admin-token/u);
    assert.ok(logoutHeaders.some((value) => value.includes('Token="non-admin-token"')));

    Date.now = () => realDateNow() + (13 * 60 * 60 * 1000);
    const validated = await request(port, "/api/v2/config", {
      headers: { Cookie: ownerSession.cookie }
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.json));
    assert.equal(validationHeaders.length, 1);
    assert.match(validationHeaders[0], /DeviceId="[a-f0-9-]{36}"/u);
    assert.match(validationHeaders[0], /Token="browser-token-one"/u);

    validationIdentity = jellyfinIdentity({ administrator: false });
    const demoted = await request(port, "/api/v2/config", {
      headers: { Cookie: ownerSession.cookie }
    });
    assert.equal(demoted.status, 401, JSON.stringify(demoted.json));
    assert.equal(demoted.json.code, "JELLYFIN_AUTH_REJECTED");
    assert.ok(logoutHeaders.some((value) => value.includes('Token="browser-token-one"')));

    validationIdentity = jellyfinIdentity();
    loginResponses.push({
      body: {
        AccessToken: "browser-token-two",
        ServerId: "server-1",
        User: jellyfinIdentity()
      }
    });
    const signedIn = await jsonRequest(context, "/api/v2/auth/jellyfin/login", {
      username: "Owner",
      password: "owner-password-two",
      deviceName: "Second owner browser",
      origin: context.origin
    });
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.json));
    const secondSession = { cookie: cookiePair(signedIn), csrf: signedIn.json.csrfToken };

    const loggedOut = await request(port, "/api/v2/session", {
      method: "DELETE",
      headers: {
        Origin: context.origin,
        Cookie: secondSession.cookie,
        "X-Jellofin-Csrf": secondSession.csrf
      }
    });
    assert.equal(loggedOut.status, 204);
    assert.ok(logoutHeaders.some((value) => value.includes('Token="browser-token-two"')));

    assert.equal(loginResponses.length, 0);
    assert.ok(loginBodies.length >= 2);
    for (const body of loginBodies) {
      assert.ok(body.every((byte) => byte === 0), "a transient Jellyfin credential body was not zeroed");
    }
  } finally {
    Date.now = realDateNow;
    if (context) {
      context.broker.beginShutdown();
      await close(context.server).catch(() => {});
      await context.broker.drain().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});
