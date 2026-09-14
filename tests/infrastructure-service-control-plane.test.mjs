import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const ACCESS_TOKEN = "ptr_access-token-that-must-remain-encrypted";
const FINGERPRINT = Array.from({ length: 32 }, () => "cd").join(":");

function request(port, pathname, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.csrf ? { "X-Jellofin-Csrf": options.csrf } : {}),
        ...(body ? { "Content-Type": "application/json", "Content-Length": String(body.length) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          json: bytes.length ? JSON.parse(bytes.toString("utf8")) : null
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body || undefined);
  });
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-infrastructure-service-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const calls = [];
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    lookup: async (hostname) => {
      assert.match(hostname, /^portainer-[12]\.test$/u);
      return [{ address: hostname === "portainer-1.test" ? "10.20.30.50" : "10.20.30.51", family: 4 }];
    },
    testInfrastructureServiceConnection: async (input) => {
      assert.equal(input.type, "portainer");
      assert.equal(Buffer.isBuffer(input.credentials.accessToken), true);
      calls.push({
        url: input.target.url,
        address: input.targetResolution.pinned.address,
        tlsMode: input.tlsMode,
        certificateFingerprint: input.certificateFingerprint,
        accessToken: input.credentials.accessToken.toString("utf8")
      });
      return { type: "portainer", state: "healthy", connectionState: "connected", version: "2.27.0" };
    }
  });
  const server = http.createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (!await controlPlane.handle(incoming, response, url)) {
        response.statusCode = 404;
        response.end();
      }
    } catch (error) {
      const payload = Buffer.from(JSON.stringify({
        code: error?.code || "INTERNAL_ERROR",
        message: error instanceof ControlPlaneError ? error.message : "Request failed."
      }), "utf8");
      response.statusCode = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      response.setHeader("Content-Type", "application/json");
      response.end(payload);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    root,
    store,
    setupToken,
    calls,
    controlPlane,
    server,
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`
  };
}

async function stop(context) {
  await new Promise((resolve) => context.server.close(resolve));
  await context.controlPlane.close();
  await rm(context.root, { recursive: true, force: true });
}

async function claim(context) {
  const response = await request(context.port, "/api/v2/setup/claim", {
    method: "POST",
    origin: context.origin,
    body: {
      setupToken: context.setupToken,
      deviceName: "Infrastructure service test browser",
      origin: context.origin,
      allowedCidrs: ["10.0.0.0/8"],
      allowPublicHttps: false
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return {
    origin: context.origin,
    cookie: response.headers["set-cookie"][0].split(";", 1)[0],
    csrf: response.json.csrfToken
  };
}

async function assertPlaintextAbsent(directory, value) {
  for (const name of await readdir(directory)) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, name));
    } catch (error) {
      if (error?.code === "EISDIR") continue;
      throw error;
    }
    assert.equal(bytes.includes(Buffer.from(value, "utf8")), false, name);
  }
}

test("Portainer infrastructure service CRUD and tests keep access tokens write-only", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const anonymous = await request(context.port, "/api/v2/infrastructure/services");
    assert.equal(anonymous.status, 401);

    const noCsrf = await request(context.port, "/api/v2/infrastructure/services/test", {
      method: "POST",
      origin: context.origin,
      cookie: authentication.cookie,
      body: {
        type: "portainer",
        url: "https://portainer-1.test:9443",
        tlsMode: "system",
        credentials: { accessToken: ACCESS_TOKEN }
      }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    const draft = await request(context.port, "/api/v2/infrastructure/services/test", {
      method: "POST",
      ...authentication,
      body: {
        type: "portainer",
        displayName: "Draft Portainer",
        url: "https://portainer-1.test:9443/",
        enabled: true,
        monitoringEnabled: true,
        tlsMode: "pinned",
        certificateFingerprint: `SHA256:${FINGERPRINT}`,
        credentials: { accessToken: ACCESS_TOKEN }
      }
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.json));
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].certificateFingerprint, "cd".repeat(32));
    assert.deepEqual(context.store.snapshot().infrastructureServices, {});

    const created = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: {
        type: "portainer",
        displayName: " Main Portainer ",
        url: "https://portainer-1.test:9443/",
        enabled: true,
        monitoringEnabled: true,
        tlsMode: "system",
        certificateFingerprint: "",
        credentials: { accessToken: ACCESS_TOKEN }
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.displayName, "Main Portainer");
    assert.equal(created.json.url, "https://portainer-1.test:9443");
    assert.equal(created.json.credentialConfigured, true);
    assert.equal(created.json.certificateFingerprint, null);
    assert.equal(JSON.stringify(created.json).includes(ACCESS_TOKEN), false);
    assert.equal(Object.hasOwn(created.json, "credentials"), false);

    const second = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: {
        type: "portainer",
        displayName: "Backup Portainer",
        url: "https://portainer-2.test:9443",
        enabled: true,
        monitoringEnabled: false,
        tlsMode: "pinned",
        certificateFingerprint: FINGERPRINT,
        credentials: { accessToken: "second-access-token" }
      }
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const listed = await request(context.port, "/api/v2/infrastructure/services", authentication);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.definitions.map(({ id }) => id), ["portainer"]);
    assert.deepEqual(listed.json.services.map(({ displayName }) => displayName), ["Backup Portainer", "Main Portainer"]);
    const config = await request(context.port, "/api/v2/config", authentication);
    assert.equal(config.status, 200);
    assert.equal(config.json.infrastructureServices.length, 2);
    assert.deepEqual(config.json.infrastructureServiceDefinitions.map(({ id }) => id), ["portainer"]);
    assert.equal(JSON.stringify(config.json).includes(ACCESS_TOKEN), false);

    const savedTest = await request(
      context.port,
      `/api/v2/infrastructure/services/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(savedTest.status, 200, JSON.stringify(savedTest.json));
    assert.equal(context.calls.at(-1).accessToken, ACCESS_TOKEN);

    const updated = await request(context.port, `/api/v2/infrastructure/services/${created.json.id}`, {
      method: "PUT",
      ...authentication,
      body: { displayName: "Primary Portainer" }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.displayName, "Primary Portainer");
    assert.equal(updated.json.targetRevision, created.json.targetRevision);
    assert.equal(updated.json.credentialConfigured, true);

    const policyUpdated = await request(context.port, "/api/v2/config", {
      method: "PUT",
      ...authentication,
      body: { allowedCidrs: ["10.20.0.0/16"], allowPublicHttps: false }
    });
    assert.equal(policyUpdated.status, 200, JSON.stringify(policyUpdated.json));
    const rebound = policyUpdated.json.infrastructureServices.find(({ id }) => id === created.json.id);
    assert.equal(rebound.credentialConfigured, true);
    assert.notEqual(rebound.targetRevision, updated.json.targetRevision);
    const reboundTest = await request(
      context.port,
      `/api/v2/infrastructure/services/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(reboundTest.status, 200, JSON.stringify(reboundTest.json));
    assert.equal(context.calls.at(-1).accessToken, ACCESS_TOKEN);

    assert.equal(context.controlPlane.listMonitorInfrastructureServices().length, 1);
    await assertPlaintextAbsent(context.root, ACCESS_TOKEN);

    const removed = await request(context.port, `/api/v2/infrastructure/services/${created.json.id}`, {
      method: "DELETE",
      ...authentication
    });
    assert.equal(removed.status, 204);
    assert.equal(Object.hasOwn(context.store.snapshot().infrastructureServices, created.json.id), false);
    assert.equal(
      Object.keys(context.controlPlane.credentialStore.publicSnapshot().credentials)
        .some((namespace) => namespace.startsWith(`infra-svc-${created.json.id}-`)),
      false
    );
  } finally {
    await stop(context);
  }
});

test("Portainer infrastructure services require HTTPS, coherent TLS trust, and an access token", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const base = {
      type: "portainer",
      displayName: "Unsafe Portainer",
      enabled: true,
      monitoringEnabled: true,
      credentials: { accessToken: ACCESS_TOKEN }
    };
    const insecure = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: { ...base, url: "http://portainer-1.test:9000", tlsMode: "system" }
    });
    assert.equal(insecure.status, 400);
    assert.equal(insecure.json.code, "HTTPS_REQUIRED");

    const missingPin = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: { ...base, url: "https://portainer-1.test:9443", tlsMode: "pinned" }
    });
    assert.equal(missingPin.status, 400);
    assert.equal(missingPin.json.code, "CERTIFICATE_FINGERPRINT_REQUIRED");

    const missingCredential = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: {
        type: "portainer",
        displayName: "No token",
        url: "https://portainer-1.test:9443",
        tlsMode: "system"
      }
    });
    assert.equal(missingCredential.status, 400);
    assert.equal(missingCredential.json.code, "CREDENTIAL_REQUIRED");
  } finally {
    await stop(context);
  }
});
