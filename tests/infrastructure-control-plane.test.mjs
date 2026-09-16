import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const TOKEN_ID = "helmsman@pve!monitoring";
const TOKEN_SECRET = "proxmox-test-token-secret-never-persist-plain";
const FINGERPRINT = Array.from({ length: 32 }, () => "ab").join(":");

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
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-infrastructure-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const calls = [];
  let failNextMutation = false;
  const guardedStateStore = {
    snapshot: () => store.snapshot(),
    mutate: async (mutator) => {
      if (failNextMutation) {
        failNextMutation = false;
        throw new Error("forced state mutation failure");
      }
      return store.mutate(mutator);
    }
  };
  const controlPlane = await createControlPlane({
    stateStore: guardedStateStore,
    dataDir: root,
    version: "test",
    lookup: async (hostname) => {
      assert.equal(hostname, "proxmox.test");
      return [{ address: "10.20.30.40", family: 4 }];
    },
    testInfrastructureConnection: async (input) => {
      assert.equal(Buffer.isBuffer(input.credentials.tokenId), true);
      assert.equal(Buffer.isBuffer(input.credentials.tokenSecret), true);
      calls.push({
        type: input.type,
        url: input.target.url,
        address: input.targetResolution.pinned.address,
        tlsMode: input.tlsMode,
        certificateFingerprint: input.certificateFingerprint,
        tokenId: input.credentials.tokenId.toString("utf8"),
        tokenSecret: input.credentials.tokenSecret.toString("utf8")
      });
      const clusterName = input.target.port === 8008
        ? "Other Cluster"
        : input.target.port === 8009 ? null : "Lab Cluster";
      return {
        type: input.type,
        state: "healthy",
        connectionState: "connected",
        version: "8.4.1",
        discovery: {
          kind: "cluster",
          name: clusterName || "Proxmox cluster",
          clusterName,
          quorate: true,
          nodeNames: ["pve-1", "pve-2"]
        }
      };
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
      const status = error instanceof ControlPlaneError ? error.status : error?.status || 500;
      const payload = Buffer.from(JSON.stringify({
        code: error?.code || "INTERNAL_ERROR",
        message: error instanceof ControlPlaneError ? error.message : "Request failed."
      }), "utf8");
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(payload);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    root,
    store,
    setupToken,
    calls,
    controlPlane,
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    failNextStateMutation() { failNextMutation = true; }
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
      deviceName: "Infrastructure test browser",
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

async function assertPlaintextAbsent(directory, values) {
  for (const name of await readdir(directory)) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, name));
    } catch (error) {
      if (error?.code === "EISDIR") continue;
      throw error;
    }
    for (const value of values) assert.equal(bytes.includes(Buffer.from(value, "utf8")), false, name);
  }
}

test("authenticated Proxmox target CRUD and tests keep credentials write-only", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);

    const anonymous = await request(context.port, "/api/v2/infrastructure/targets");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.code, "SESSION_REQUIRED");

    const noCsrf = await request(context.port, "/api/v2/infrastructure/targets/test", {
      method: "POST",
      origin: context.origin,
      cookie: authentication.cookie,
      body: {
        type: "proxmox",
        url: "https://proxmox.test:8006",
        tlsMode: "pinned",
        certificateFingerprint: FINGERPRINT,
        credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
      }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    const draft = await request(context.port, "/api/v2/infrastructure/targets/test", {
      method: "POST",
      ...authentication,
      body: {
        type: "proxmox",
        displayName: "Draft Proxmox",
        url: "https://proxmox.test:8006/",
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 60,
        tlsMode: "pinned",
        certificateFingerprint: `SHA256:${FINGERPRINT}`,
        credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
      }
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.json));
    assert.equal(draft.json.state, "healthy");
    assert.deepEqual(context.store.snapshot().infrastructureTargets, {});
    assert.equal(context.calls[0].url, "https://proxmox.test:8006");
    assert.equal(context.calls[0].certificateFingerprint, "ab".repeat(32));

    const created = await request(context.port, "/api/v2/infrastructure/targets", {
      method: "POST",
      ...authentication,
      body: {
        type: "proxmox",
        displayName: " Example Proxmox ",
        url: "https://proxmox.test:8006/",
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 45,
        tlsMode: "system",
        certificateFingerprint: "",
        credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.match(created.json.id, /^[a-f0-9-]{36}$/u);
    assert.equal(created.json.displayName, "Example Proxmox");
    assert.equal(created.json.url, "https://proxmox.test:8006");
    assert.equal(created.json.credentialConfigured, true);
    assert.equal(created.json.tlsMode, "system");
    assert.equal(created.json.environmentKind, "cluster");
    assert.equal(created.json.clusterName, "Lab Cluster");
    assert.equal(created.json.certificateFingerprint, null);
    assert.equal(JSON.stringify(created.json).includes(TOKEN_SECRET), false);
    assert.equal(Object.hasOwn(created.json, "credentials"), false);
    const firstRevision = created.json.targetRevision;

    const listed = await request(context.port, "/api/v2/infrastructure/targets", authentication);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.definitions.map(({ id }) => id), ["proxmox"]);
    assert.equal(listed.json.targets.length, 1);
    assert.equal(listed.json.targets[0].id, created.json.id);
    const config = await request(context.port, "/api/v2/config", authentication);
    assert.equal(config.json.infrastructureTargets.length, 1);
    assert.equal(config.json.infrastructureEnvironments.length, 1);
    assert.deepEqual(config.json.infrastructureDefinitions.map(({ id }) => id), ["proxmox"]);
    assert.equal(config.json.services.length, 7, "media services remain on the existing API");

    const savedTest = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(savedTest.status, 200, JSON.stringify(savedTest.json));
    assert.equal(context.calls.length, 3);
    assert.equal(context.calls[2].tokenSecret, TOKEN_SECRET);

    const updated = await request(context.port, `/api/v2/infrastructure/targets/${created.json.id}`, {
      method: "PUT",
      ...authentication,
      body: { displayName: "Primary Proxmox", monitoringIntervalSeconds: 90 }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.displayName, "Primary Proxmox");
    assert.notEqual(updated.json.targetRevision, firstRevision);
    assert.equal(updated.json.credentialConfigured, true);

    const policyUpdated = await request(context.port, "/api/v2/config", {
      method: "PUT",
      ...authentication,
      body: { allowedCidrs: ["10.20.0.0/16"], allowPublicHttps: false }
    });
    assert.equal(policyUpdated.status, 200, JSON.stringify(policyUpdated.json));
    const rebound = policyUpdated.json.infrastructureTargets[0];
    assert.equal(rebound.credentialConfigured, true);
    assert.notEqual(rebound.targetRevision, updated.json.targetRevision);
    const afterPolicyTest = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(afterPolicyTest.status, 200, JSON.stringify(afterPolicyTest.json));
    assert.equal(context.calls.length, 4);

    const rejectedSecret = "replacement-secret-that-must-not-commit";
    context.failNextStateMutation();
    const failedRotation = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}`,
      {
        method: "PUT",
        ...authentication,
        body: {
          displayName: "Must not commit",
          credentials: { tokenId: TOKEN_ID, tokenSecret: rejectedSecret }
        }
      }
    );
    assert.equal(failedRotation.status, 500);
    const afterFailedRotation = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}`,
      authentication
    );
    assert.equal(afterFailedRotation.json.displayName, "Primary Proxmox");
    const credentialAfterFailure = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(credentialAfterFailure.status, 200, JSON.stringify(credentialAfterFailure.json));
    assert.equal(context.calls.at(-1).tokenSecret, TOKEN_SECRET);

    const redirectedWithoutCredential = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}`,
      {
        method: "PUT",
        ...authentication,
        body: { url: "https://proxmox.test:8007" }
      }
    );
    assert.equal(redirectedWithoutCredential.status, 400);
    assert.equal(redirectedWithoutCredential.json.code, "CREDENTIAL_REQUIRED");

    const draftEndpoint = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints/test`,
      {
        method: "POST",
        ...authentication,
        body: {
          label: "pve-2 failover",
          url: "https://proxmox.test:8007",
          enabled: true,
          tlsMode: "pinned",
          certificateFingerprint: FINGERPRINT,
          credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
        }
      }
    );
    assert.equal(draftEndpoint.status, 200, JSON.stringify(draftEndpoint.json));
    assert.equal(draftEndpoint.json.discovery.clusterName, "Lab Cluster");

    const endpointCreated = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints`,
      {
        method: "POST",
        ...authentication,
        body: {
          label: " pve-2 failover ",
          url: "https://proxmox.test:8007/",
          enabled: true,
          tlsMode: "pinned",
          certificateFingerprint: FINGERPRINT,
          credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
        }
      }
    );
    assert.equal(endpointCreated.status, 201, JSON.stringify(endpointCreated.json));
    assert.equal(endpointCreated.json.label, "pve-2 failover");
    assert.equal(endpointCreated.json.primary, false);
    assert.equal(endpointCreated.json.credentialConfigured, true);
    assert.equal(JSON.stringify(endpointCreated.json).includes(TOKEN_SECRET), false);

    const endpointList = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints`,
      authentication
    );
    assert.equal(endpointList.status, 200, JSON.stringify(endpointList.json));
    assert.equal(endpointList.json.endpoints.length, 2);
    assert.equal(endpointList.json.endpoints.filter(({ primary }) => primary).length, 1);
    assert.equal(endpointList.json.endpoints.every(({ credentialConfigured }) => credentialConfigured), true);

    const alternateTest = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints/${endpointCreated.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(alternateTest.status, 200, JSON.stringify(alternateTest.json));
    assert.equal(context.calls.at(-1).url, "https://proxmox.test:8007");

    const primaryStillWorks = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/test`,
      { method: "POST", ...authentication, body: {} }
    );
    assert.equal(primaryStillWorks.status, 200, "adding an alternate must not delete the primary credential");
    assert.equal(context.calls.at(-1).url, "https://proxmox.test:8006");

    const mismatchedEndpoint = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints`,
      {
        method: "POST",
        ...authentication,
        body: {
          label: "Unrelated cluster",
          url: "https://proxmox.test:8008",
          enabled: true,
          tlsMode: "system",
          credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
        }
      }
    );
    assert.equal(mismatchedEndpoint.status, 409);
    assert.equal(mismatchedEndpoint.json.code, "ENVIRONMENT_IDENTITY_MISMATCH");

    const unnamedCluster = await request(context.port, "/api/v2/infrastructure/environments", {
      method: "POST",
      ...authentication,
      body: {
        type: "proxmox",
        displayName: "Unnamed cluster",
        url: "https://proxmox.test:8009",
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 60,
        tlsMode: "system",
        credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
      }
    });
    assert.equal(unnamedCluster.status, 409);
    assert.equal(unnamedCluster.json.code, "ENVIRONMENT_DISCOVERY_REQUIRED");

    const endpointRemoved = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints/${endpointCreated.json.id}`,
      { method: "DELETE", ...authentication }
    );
    assert.equal(endpointRemoved.status, 204);
    const endpointsAfterRemoval = await request(
      context.port,
      `/api/v2/infrastructure/environments/${created.json.id}/endpoints`,
      authentication
    );
    assert.equal(endpointsAfterRemoval.json.endpoints.length, 1);
    assert.equal(endpointsAfterRemoval.json.endpoints[0].primary, true);

    await assertPlaintextAbsent(context.root, [TOKEN_ID, TOKEN_SECRET]);
    const credentialStore = context.controlPlane.credentialStore;
    const removeCredentialRecord = credentialStore.removeServiceCredentials.bind(credentialStore);
    credentialStore.removeServiceCredentials = async () => {
      throw new Error("forced obsolete-credential cleanup failure");
    };
    const committedDespiteCleanup = await request(
      context.port,
      `/api/v2/infrastructure/targets/${created.json.id}`,
      { method: "PUT", ...authentication, body: { displayName: "Cleanup-safe Proxmox" } }
    );
    assert.equal(committedDespiteCleanup.status, 200, JSON.stringify(committedDespiteCleanup.json));
    assert.equal(committedDespiteCleanup.json.displayName, "Cleanup-safe Proxmox");

    const removed = await request(context.port, `/api/v2/infrastructure/targets/${created.json.id}`, {
      method: "DELETE",
      ...authentication,
      body: undefined
    });
    assert.equal(removed.status, 204);
    assert.deepEqual(context.store.snapshot().infrastructureTargets, {});
    assert.notDeepEqual(
      credentialStore.publicSnapshot().credentials,
      {},
      "a failed best-effort cleanup may leave only unusable destination-bound ciphertext"
    );
    credentialStore.removeServiceCredentials = removeCredentialRecord;
    for (const namespace of Object.keys(credentialStore.publicSnapshot().credentials)) {
      await removeCredentialRecord(namespace);
    }
    assert.deepEqual(context.controlPlane.credentialStore.publicSnapshot().credentials, {});
  } finally {
    await stop(context);
  }
});

test("Proxmox targets require HTTPS and coherent certificate trust", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const base = {
      type: "proxmox",
      displayName: "Unsafe target",
      enabled: true,
      monitoringEnabled: true,
      monitoringIntervalSeconds: 60,
      credentials: { tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET }
    };
    const httpTarget = await request(context.port, "/api/v2/infrastructure/targets", {
      method: "POST",
      ...authentication,
      body: { ...base, url: "http://proxmox.test:8006", tlsMode: "system" }
    });
    assert.equal(httpTarget.status, 400);
    assert.equal(httpTarget.json.code, "HTTPS_REQUIRED");

    const tooFrequent = await request(context.port, "/api/v2/infrastructure/targets", {
      method: "POST",
      ...authentication,
      body: {
        ...base,
        url: "https://proxmox.test:8006",
        tlsMode: "system",
        monitoringIntervalSeconds: 20
      }
    });
    assert.equal(tooFrequent.status, 400);
    assert.equal(tooFrequent.json.code, "INVALID_MONITOR_INTERVAL");

    const missingPin = await request(context.port, "/api/v2/infrastructure/targets", {
      method: "POST",
      ...authentication,
      body: { ...base, url: "https://proxmox.test:8006", tlsMode: "pinned" }
    });
    assert.equal(missingPin.status, 400);
    assert.equal(missingPin.json.code, "CERTIFICATE_FINGERPRINT_REQUIRED");
    assert.deepEqual(context.store.snapshot().infrastructureTargets, {});
  } finally {
    await stop(context);
  }
});
