import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createControlPlane, ControlPlaneError } from "../server/control-plane.mjs";
import { StateStore } from "../server/state.mjs";

const CONTAINER_ID = "c".repeat(64);
const PORTAINER_TOKEN = "portainer-action-test-token";
const PROXMOX_TOKEN_ID = "helmsman@pve!controls";
const PROXMOX_TOKEN_SECRET = "proxmox-action-test-secret";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "helmsman-actions-control-"));
  const store = new StateStore(root);
  await store.initialize();
  const setupToken = await store.rotateUnclaimedSetupToken();
  const calls = [];
  let refreshes = 0;
  let snapshot = {};
  let seasonDetail = null;
  const seasonDetailCalls = [];
  const actionFailures = new Map();
  const actionBlocks = new Map();
  async function beforeAction(provider) {
    const block = actionBlocks.get(provider);
    if (block) {
      block.enter();
      await block.wait;
      actionBlocks.delete(provider);
    }
    const failure = actionFailures.get(provider);
    if (failure) throw failure;
  }
  const controlPlane = await createControlPlane({
    stateStore: store,
    dataDir: root,
    version: "test",
    lookup: async (hostname) => {
      assert.match(hostname, /^(?:media|portainer|proxmox)\.test$/u);
      return [{ address: "10.20.30.40", family: 4 }];
    },
    testInfrastructureConnection: async () => ({
      type: "proxmox",
      state: "healthy",
      connectionState: "connected",
      version: "9.2.1",
      discovery: {
        kind: "cluster",
        name: "example-cluster",
        clusterName: "example-cluster",
        quorate: true,
        nodeNames: ["pve-a", "pve-b"]
      }
    }),
    executePortainerContainerAction: async (input) => {
      assert.equal(input.credentials.accessToken.toString("utf8"), PORTAINER_TOKEN);
      await beforeAction("portainer");
      calls.push({ provider: "portainer", ...input, credentials: undefined, targetResolution: undefined });
      return {
        ok: true,
        provider: "portainer",
        operation: input.operation,
        serviceId: input.service.id,
        environmentId: input.environmentId,
        containerId: input.containerId,
        providerStatus: 204,
        noOp: false
      };
    },
    executeProxmoxWorkloadAction: async (input) => {
      assert.equal(input.credentials.tokenId.toString("utf8"), PROXMOX_TOKEN_ID);
      assert.equal(input.credentials.tokenSecret.toString("utf8"), PROXMOX_TOKEN_SECRET);
      await beforeAction("proxmox");
      calls.push({ provider: "proxmox", ...input, credentials: undefined, targetResolution: undefined });
      return {
        ok: true,
        provider: "proxmox",
        operation: input.operation,
        environmentId: input.environment.id,
        node: input.node,
        type: input.type,
        vmid: input.vmid,
        providerStatus: 200
      };
    },
    executeMediaRecoveryAction: async (input) => {
      assert.equal(Buffer.isBuffer(input.credential), true);
      await beforeAction(input.serviceId);
      calls.push({
        provider: input.serviceId,
        operation: input.operation,
        resourceId: input.resourceId,
        ...(input.seasonNumbers ? { seasonNumbers: [...input.seasonNumbers] } : {}),
        credential: input.credential.toString("utf8")
      });
      return {
        ok: true,
        provider: input.serviceId,
        operation: input.operation,
        resourceId: input.resourceId,
        ...(input.seasonNumbers ? { seasonNumbers: [...input.seasonNumbers] } : {}),
        providerStatus: input.operation === "requestSeasons" ? 201 : 200
      };
    },
    fetchSeerrSeriesSeasons: async (input) => {
      seasonDetailCalls.push({ ...input });
      if (!seasonDetail) {
        throw new ControlPlaneError(503, "MEDIA_SEASONS_UNAVAILABLE", "No test season detail is available.");
      }
      return structuredClone(seasonDetail);
    }
  });
  controlPlane.setMonitor({
    getSnapshot: () => structuredClone(snapshot),
    requestRefresh: () => { refreshes += 1; }
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
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ code: error?.code || "INTERNAL_ERROR", message: error?.message || "failed" }));
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
    controlPlane,
    server,
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`,
    calls,
    setSnapshot(value) { snapshot = value; },
    getSnapshot: () => structuredClone(snapshot),
    setSeasonDetail(value) { seasonDetail = value ? structuredClone(value) : null; },
    seasonDetailCalls,
    setActionFailure(provider, error) {
      if (error) actionFailures.set(provider, error);
      else actionFailures.delete(provider);
    },
    blockAction(provider) {
      let release;
      let markEntered;
      const wait = new Promise((resolve) => { release = resolve; });
      const entered = new Promise((resolve) => { markEntered = resolve; });
      actionBlocks.set(provider, { wait, enter: markEntered });
      return { entered, release };
    },
    refreshCount: () => refreshes
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
      deviceName: "Action test browser",
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

test("minor controls require CSRF, current inventory, exact revisions, and saved credentials", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const portainer = await request(context.port, "/api/v2/infrastructure/services", {
      method: "POST",
      ...authentication,
      body: {
        type: "portainer",
        displayName: "Portainer",
        url: "https://portainer.test:9443",
        enabled: true,
        monitoringEnabled: true,
        tlsMode: "system",
        certificateFingerprint: "",
        credentials: { accessToken: PORTAINER_TOKEN }
      }
    });
    assert.equal(portainer.status, 201, JSON.stringify(portainer.json));

    const proxmox = await request(context.port, "/api/v2/infrastructure/environments", {
      method: "POST",
      ...authentication,
      body: {
        type: "proxmox",
        displayName: "Example Proxmox",
        url: "https://proxmox.test:8006",
        enabled: true,
        monitoringEnabled: true,
        monitoringIntervalSeconds: 60,
        tlsMode: "system",
        certificateFingerprint: "",
        credentials: { tokenId: PROXMOX_TOKEN_ID, tokenSecret: PROXMOX_TOKEN_SECRET }
      }
    });
    assert.equal(proxmox.status, 201, JSON.stringify(proxmox.json));

    const media = {};
    for (const [service, port] of [["seerr", 5055], ["radarr", 7878], ["sonarr", 8989]]) {
      const saved = await request(context.port, `/api/v2/services/${service}`, {
        method: "PUT",
        ...authentication,
        body: {
          url: `http://media.test:${port}`,
          authMode: "apiKey",
          credential: `${service}-action-test-key`,
          clearCredential: false,
          monitoringEnabled: true
        }
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      media[service] = saved.json;
    }

    const checkedAt = new Date().toISOString();
    context.setSnapshot({
      infrastructure: {
        portainer: [{
          id: portainer.json.id,
          targetRevision: portainer.json.targetRevision,
          checkedAt,
          connectionState: "connected",
          inventory: {
            environments: [{ id: 7, state: "up", containerCapable: true }],
            containers: [{ id: CONTAINER_ID, environmentId: 7, state: "running" }]
          }
        }],
        environments: [{
          id: proxmox.json.id,
          targetRevision: proxmox.json.targetRevision,
          checkedAt,
          connectionState: "connected",
          selectedEndpointId: proxmox.json.primaryEndpointId,
          workloads: [{ node: "pve-a", type: "qemu", vmid: 2101, status: "running", template: false, lock: null }]
        }]
      },
      media: {
        requests: [{ requestId: 41, requestStatus: "failed" }],
        records: [
          {
            mediaType: "movie",
            monitored: true,
            available: false,
            downloading: false,
            actionTargets: [{ service: "radarr", resourceId: 22 }]
          },
          {
            mediaType: "series",
            monitored: true,
            available: false,
            downloading: false,
            actionTargets: [{ service: "sonarr", resourceId: 33 }]
          }
        ]
      },
      services: [
        {
          id: "seerr",
          targetRevision: media.seerr.targetRevision,
          checkedAt,
          connectionState: "connected",
          inventory: {}
        },
        {
          id: "radarr",
          targetRevision: media.radarr.targetRevision,
          checkedAt,
          connectionState: "connected",
          inventory: { library: [{ sourceId: "22", mediaType: "movie", monitored: true }] }
        },
        {
          id: "sonarr",
          targetRevision: media.sonarr.targetRevision,
          checkedAt,
          connectionState: "connected",
          inventory: { library: [{ sourceId: "33", mediaType: "series", monitored: true }] }
        }
      ]
    });
    const refreshBaseline = context.refreshCount();

    const portainerPayload = {
      serviceId: portainer.json.id,
      environmentId: 7,
      containerId: CONTAINER_ID,
      operation: "restart",
      targetRevision: portainer.json.targetRevision
    };
    const missingCsrf = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      origin: authentication.origin,
      cookie: authentication.cookie,
      body: portainerPayload
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    const extraField = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: { ...portainerPayload, upstreamPath: "/api/users" }
    });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.code, "INVALID_REQUEST");

    const restarted = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: portainerPayload
    });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.json));
    assert.equal(restarted.json.containerId, CONTAINER_ID);

    const duplicateRestart = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: portainerPayload
    });
    assert.equal(duplicateRestart.status, 409);
    assert.equal(duplicateRestart.json.code, "ACTION_RECENTLY_ACCEPTED");
    assert.equal(context.calls.length, 1);

    const rebooted = await request(context.port, "/api/v2/actions/proxmox/workload", {
      method: "POST",
      ...authentication,
      body: {
        environmentId: proxmox.json.id,
        node: "pve-a",
        type: "qemu",
        vmid: 2101,
        operation: "reboot",
        targetRevision: proxmox.json.targetRevision
      }
    });
    assert.equal(rebooted.status, 200, JSON.stringify(rebooted.json));
    assert.equal(Object.hasOwn(rebooted.json, "taskId"), false);

    for (const payload of [
      { serviceId: "seerr", operation: "retryRequest", resourceId: 41, targetRevision: media.seerr.targetRevision },
      { serviceId: "radarr", operation: "searchMovie", resourceId: 22, targetRevision: media.radarr.targetRevision },
      { serviceId: "sonarr", operation: "searchSeries", resourceId: 33, targetRevision: media.sonarr.targetRevision }
    ]) {
      const acted = await request(context.port, "/api/v2/actions/media", {
        method: "POST",
        ...authentication,
        body: payload
      });
      assert.equal(acted.status, 200, JSON.stringify(acted.json));
      assert.equal(acted.json.resourceId, payload.resourceId);
    }
    assert.equal(context.calls.length, 5);
    assert.equal(context.refreshCount() - refreshBaseline, 5);

    const shortId = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: { ...portainerPayload, containerId: CONTAINER_ID.slice(0, 12) }
    });
    assert.equal(shortId.status, 400);
    assert.equal(context.calls.length, 5);

    const invalidState = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: { ...portainerPayload, operation: "start" }
    });
    assert.equal(invalidState.status, 409);
    assert.equal(invalidState.json.code, "ACTION_NOT_AVAILABLE");
    assert.equal(context.calls.length, 5);

    const staleRevision = await request(context.port, "/api/v2/actions/proxmox/workload", {
      method: "POST",
      ...authentication,
      body: {
        environmentId: proxmox.json.id,
        node: "pve-a",
        type: "qemu",
        vmid: 2101,
        operation: "shutdown",
        targetRevision: "11111111-1111-4111-8111-111111111111"
      }
    });
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.json.code, "TARGET_CHANGED");
    assert.equal(context.calls.length, 5);

    const unobservedMovie = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "radarr", operation: "searchMovie", resourceId: 23, targetRevision: media.radarr.targetRevision }
    });
    assert.equal(unobservedMovie.status, 409);
    assert.equal(unobservedMovie.json.code, "ACTION_TARGET_NOT_CURRENT");
    assert.equal(context.calls.length, 5);

    const nonFailedRequest = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "seerr", operation: "retryRequest", resourceId: 42, targetRevision: media.seerr.targetRevision }
    });
    assert.equal(nonFailedRequest.status, 409);
    assert.equal(nonFailedRequest.json.code, "ACTION_NOT_AVAILABLE");
    assert.equal(context.calls.length, 5);

    const currentSnapshot = context.getSnapshot();
    const mismatchedEvidence = structuredClone(currentSnapshot);
    mismatchedEvidence.infrastructure.portainer[0].targetRevision = "11111111-1111-4111-8111-111111111111";
    context.setSnapshot(mismatchedEvidence);
    const staleInventoryRevision = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: { ...portainerPayload, operation: "stop" }
    });
    assert.equal(staleInventoryRevision.status, 409);
    assert.equal(staleInventoryRevision.json.code, "ACTION_INVENTORY_STALE");

    const expiredEvidence = structuredClone(currentSnapshot);
    expiredEvidence.infrastructure.environments[0].checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    context.setSnapshot(expiredEvidence);
    const staleInventoryTime = await request(context.port, "/api/v2/actions/proxmox/workload", {
      method: "POST",
      ...authentication,
      body: {
        environmentId: proxmox.json.id,
        node: "pve-a",
        type: "qemu",
        vmid: 2101,
        operation: "shutdown",
        targetRevision: proxmox.json.targetRevision
      }
    });
    assert.equal(staleInventoryTime.status, 409);
    assert.equal(staleInventoryTime.json.code, "ACTION_INVENTORY_STALE");

    const availableMovie = structuredClone(currentSnapshot);
    availableMovie.media.records[0].available = true;
    context.setSnapshot(availableMovie);
    const alreadyAvailable = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "radarr", operation: "searchMovie", resourceId: 22, targetRevision: media.radarr.targetRevision }
    });
    assert.equal(alreadyAvailable.status, 409);
    assert.equal(alreadyAvailable.json.code, "ACTION_TARGET_NOT_CURRENT");

    const downloadingSeries = structuredClone(currentSnapshot);
    downloadingSeries.media.records[1].downloading = true;
    context.setSnapshot(downloadingSeries);
    const alreadyDownloading = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "sonarr", operation: "searchSeries", resourceId: 33, targetRevision: media.sonarr.targetRevision }
    });
    assert.equal(alreadyDownloading.status, 409);
    assert.equal(alreadyDownloading.json.code, "ACTION_TARGET_NOT_CURRENT");
    assert.equal(context.calls.length, 5);

    const concurrentContainerId = "e".repeat(64);
    const concurrentSnapshot = structuredClone(currentSnapshot);
    concurrentSnapshot.infrastructure.portainer[0].inventory.containers.push({
      id: concurrentContainerId,
      environmentId: 7,
      state: "running"
    });
    context.setSnapshot(concurrentSnapshot);
    const blocked = context.blockAction("portainer");
    const concurrentPayload = { ...portainerPayload, containerId: concurrentContainerId };
    const firstRestart = request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: concurrentPayload
    });
    await blocked.entered;
    const secondRestart = await request(context.port, "/api/v2/actions/portainer/container", {
      method: "POST",
      ...authentication,
      body: concurrentPayload
    });
    assert.equal(secondRestart.status, 409);
    assert.equal(secondRestart.json.code, "ACTION_IN_PROGRESS");
    blocked.release();
    const acceptedRestart = await firstRestart;
    assert.equal(acceptedRestart.status, 200, JSON.stringify(acceptedRestart.json));
    assert.equal(context.calls.length, 6);

    const ambiguousSnapshot = structuredClone(currentSnapshot);
    ambiguousSnapshot.media.requests.push({ requestId: 43, requestStatus: "failed" });
    context.setSnapshot(ambiguousSnapshot);
    context.setActionFailure(
      "seerr",
      new ControlPlaneError(
        502,
        "ACTION_OUTCOME_UNKNOWN",
        "Seerr stopped responding after the action began. Refresh before trying again."
      )
    );
    const refreshesBeforeAmbiguousAction = context.refreshCount();
    const ambiguousAction = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "seerr", operation: "retryRequest", resourceId: 43, targetRevision: media.seerr.targetRevision }
    });
    assert.equal(ambiguousAction.status, 502);
    assert.equal(ambiguousAction.json.code, "ACTION_OUTCOME_UNKNOWN");
    assert.equal(context.refreshCount(), refreshesBeforeAmbiguousAction + 1);
    const ambiguousRetry = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { serviceId: "seerr", operation: "retryRequest", resourceId: 43, targetRevision: media.seerr.targetRevision }
    });
    assert.equal(ambiguousRetry.status, 409);
    assert.equal(ambiguousRetry.json.code, "ACTION_RECENTLY_ACCEPTED");
    assert.equal(context.calls.length, 6);
  } finally {
    await stop(context);
  }
});

test("Seerr season details and requests require current identity, revisions, and revalidation", async () => {
  const context = await start();
  try {
    const authentication = await claim(context);
    const saved = await request(context.port, "/api/v2/services/seerr", {
      method: "PUT",
      ...authentication,
      body: {
        url: "http://media.test:5055",
        authMode: "apiKey",
        credential: "seerr-season-action-test-key",
        clearCredential: false,
        monitoringEnabled: true
      }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const targetRevision = saved.json.targetRevision;
    const checkedAt = new Date().toISOString();
    const snapshot = {
      media: {
        requests: [],
        records: [{
          id: "series:tmdb:1396",
          mediaType: "series",
          providerIds: { tmdb: 1396 },
          seasonRequestTarget: { service: "seerr", resourceId: 1396 }
        }]
      },
      services: [{
        id: "seerr",
        targetRevision,
        checkedAt,
        connectionState: "connected",
        inventory: {}
      }]
    };
    context.setSnapshot(snapshot);
    const detailRevision = "a".repeat(64);
    context.setSeasonDetail({
      tmdbId: 1396,
      targetRevision,
      detailRevision,
      privateServer: { rootFolder: "/must/not/leak" },
      seasons: [
        {
          seasonNumber: 0,
          name: "Specials",
          episodeCount: 4,
          airDate: null,
          status: "unknown",
          requestState: null,
          requestable: false,
          requestedBy: "must-not-leak"
        },
        {
          seasonNumber: 1,
          name: "Season 1",
          episodeCount: 10,
          airDate: "2025-01-01",
          status: "unknown",
          requestState: null,
          requestable: true
        },
        {
          seasonNumber: 2,
          name: "Season 2",
          episodeCount: 10,
          airDate: null,
          status: "available",
          requestState: "completed",
          requestable: false
        },
        {
          seasonNumber: 3,
          name: "Season 3",
          episodeCount: 8,
          airDate: null,
          status: "deleted",
          requestState: "declined",
          requestable: true
        }
      ]
    });

    const path = `/api/v2/media/series/1396/seasons?targetRevision=${targetRevision}`;
    const unauthenticated = await request(context.port, path);
    assert.equal(unauthenticated.status, 401);

    const loaded = await request(context.port, path, {
      origin: authentication.origin,
      cookie: authentication.cookie
    });
    assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
    assert.equal(loaded.json.tmdbId, 1396);
    assert.equal(loaded.json.detailRevision, detailRevision);
    assert.equal(loaded.json.seasons[0].requestable, false);
    assert.equal(Object.hasOwn(loaded.json, "privateServer"), false);
    assert.equal(Object.hasOwn(loaded.json.seasons[0], "requestedBy"), false);
    assert.equal(context.seasonDetailCalls.at(-1).cacheMode, "read");

    const extraQuery = await request(context.port, `${path}&path=/api/v1/users`, {
      origin: authentication.origin,
      cookie: authentication.cookie
    });
    assert.equal(extraQuery.status, 400);
    assert.equal(extraQuery.json.code, "INVALID_REQUEST");

    const unknownSeries = await request(
      context.port,
      `/api/v2/media/series/1397/seasons?targetRevision=${targetRevision}`,
      { origin: authentication.origin, cookie: authentication.cookie }
    );
    assert.equal(unknownSeries.status, 409);
    assert.equal(unknownSeries.json.code, "ACTION_TARGET_NOT_CURRENT");

    const staleSnapshot = structuredClone(snapshot);
    staleSnapshot.services[0].checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    context.setSnapshot(staleSnapshot);
    const staleInventory = await request(context.port, path, {
      origin: authentication.origin,
      cookie: authentication.cookie
    });
    assert.equal(staleInventory.status, 409);
    assert.equal(staleInventory.json.code, "ACTION_INVENTORY_STALE");
    context.setSnapshot(snapshot);

    const payload = {
      serviceId: "seerr",
      operation: "requestSeasons",
      resourceId: 1396,
      seasonNumbers: [1],
      targetRevision,
      detailRevision
    };
    const missingCsrf = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      origin: authentication.origin,
      cookie: authentication.cookie,
      body: payload
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.json.code, "CSRF_TOKEN_REQUIRED");

    for (const seasonNumbers of [[], [0], [2, 1], [1, 1], ["1"]]) {
      const invalid = await request(context.port, "/api/v2/actions/media", {
        method: "POST",
        ...authentication,
        body: { ...payload, seasonNumbers }
      });
      assert.equal(invalid.status, 400, JSON.stringify({ seasonNumbers, response: invalid.json }));
      assert.equal(invalid.json.code, "INVALID_ACTION_TARGET");
    }

    const extraField = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { ...payload, userId: 1 }
    });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.code, "INVALID_REQUEST");

    const staleDetail = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { ...payload, detailRevision: "b".repeat(64) }
    });
    assert.equal(staleDetail.status, 409);
    assert.equal(staleDetail.json.code, "ACTION_TARGET_CHANGED");
    assert.equal(context.seasonDetailCalls.at(-1).cacheMode, "bypass");

    const unavailable = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { ...payload, seasonNumbers: [2] }
    });
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.json.code, "ACTION_NOT_AVAILABLE");

    const blocked = context.blockAction("seerr");
    const first = request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: payload
    });
    await blocked.entered;
    const overlapping = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { ...payload, seasonNumbers: [3] }
    });
    assert.equal(overlapping.status, 409);
    assert.equal(overlapping.json.code, "ACTION_IN_PROGRESS");
    blocked.release();
    const created = await first;
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.deepEqual(created.json.seasonNumbers, [1]);
    assert.equal(created.json.providerStatus, 201);
    assert.deepEqual(context.calls[0], {
      provider: "seerr",
      operation: "requestSeasons",
      resourceId: 1396,
      seasonNumbers: [1],
      credential: "seerr-season-action-test-key"
    });

    const recent = await request(context.port, "/api/v2/actions/media", {
      method: "POST",
      ...authentication,
      body: { ...payload, seasonNumbers: [3] }
    });
    assert.equal(recent.status, 409);
    assert.equal(recent.json.code, "ACTION_RECENTLY_ACCEPTED");
    assert.equal(context.calls.length, 1);
  } finally {
    await stop(context);
  }
});
