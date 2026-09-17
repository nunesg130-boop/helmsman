import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBroker, createHttpServer } from "../server/broker.mjs";
import { CredentialStore } from "../server/secrets.mjs";
import { SessionAuthStore } from "../server/session-auth.mjs";
import { StateStore } from "../server/state.mjs";

const SERVICE_URL = "http://10.20.30.40:8096";
const TARGET_REVISION = "87654321-4321-4123-8123-cba987654321";
const SECRET = "legacy-v05-jellyfin-token";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function statusRequest(port, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/api/v2/status",
      headers: { Host: `127.0.0.1:${port}`, Cookie: cookie },
      agent: false
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

test("Helmsman boots the frozen v0.5 state, session, and credential formats", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "helmsman-v05-compat-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  // These domain-separation labels and protocol names are deliberately frozen.
  // The integration part below then proves the renamed broker still opens the
  // same on-disk files and authenticates the same browser cookie.
  const secretsSource = await readFile(new URL("../server/secrets.mjs", import.meta.url), "utf8");
  const sessionsSource = await readFile(new URL("../server/session-auth.mjs", import.meta.url), "utf8");
  assert.match(secretsSource, /"jellofin-command\/credential"/u);
  assert.match(secretsSource, /"jellofin-command\/credential-store"/u);
  assert.match(sessionsSource, /DEFAULT_COOKIE_NAME = "JFC_SESSION"/u);
  assert.match(sessionsSource, /`jellofin-command-csrf-v1\\0\$\{record\.id\}`/u);

  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const origin = `http://127.0.0.1:${port}`;

  const stateStore = new StateStore(dataDir);
  const initial = await stateStore.initialize();
  await stateStore.mutate((state) => {
    state.claimed = true;
    state.claimedAt = "2026-09-12T00:00:00.000Z";
    state.setupTokenHash = null;
    state.policy.allowedCidrs = ["10.20.30.40/32"];
    state.connections.jellyfin = {
      url: SERVICE_URL,
      targetRevision: TARGET_REVISION,
      updatedAt: "2026-09-12T00:00:00.000Z",
      authMode: "token",
      monitoringEnabled: false
    };
  });

  const namespace = `jellyfin-${createHash("sha256").update(SERVICE_URL, "utf8").digest("hex").slice(0, 48)}`;
  const legacyCredentials = new CredentialStore(dataDir, { instanceId: initial.instanceId });
  await legacyCredentials.initialize();
  await legacyCredentials.setCredential(namespace, "token", SECRET);
  await legacyCredentials.close();

  const legacySessions = new SessionAuthStore(dataDir);
  await legacySessions.initialize();
  const issued = await legacySessions.issue({ name: "Existing v0.5 browser", origin });
  const cookie = issued.cookie.split(";", 1)[0];
  assert.match(cookie, /^JFC_SESSION=/u);
  const legacySessionState = JSON.parse(await readFile(legacySessions.filePath, "utf8"));
  legacySessionState.version = 1;
  delete legacySessionState.accessKeyHash;
  delete legacySessionState.owner;
  delete legacySessionState.integrity;
  for (const record of Object.values(legacySessionState.sessions)) delete record.principal;
  await writeFile(legacySessions.filePath, `${JSON.stringify(legacySessionState)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  const logs = [];
  const broker = await createBroker({ dataDir, log: (message) => logs.push(String(message)) });
  const server = createHttpServer(broker.handler);
  t.after(async () => {
    broker.beginShutdown();
    await close(server);
    await broker.drain();
  });
  assert.equal(await listen(server, port), port);

  const status = await statusRequest(port, cookie);
  assert.equal(status.status, 200);
  assert.equal(status.body.version, "1.0.5");
  assert.equal(status.body.authenticated, true);
  assert.deepEqual(status.body.authentication, {
    provider: null,
    configured: false,
    ownerName: null,
    legacyAccessKeyAvailable: false
  });
  assert.equal(status.body.session.name, "Existing v0.5 browser");
  assert.equal(logs.some((line) => line.includes("setup token")), false);

  const reopenedCredentials = new CredentialStore(dataDir, { instanceId: initial.instanceId });
  const metadata = await reopenedCredentials.initialize();
  assert.equal(metadata.credentials[namespace], undefined, "the URL-only v0.5 namespace was not retired");
  const migratedNamespaces = Object.keys(metadata.credentials)
    .filter((candidate) => candidate.startsWith("jellyfin-b3-"));
  assert.equal(migratedNamespaces.length, 1, "the legacy credential was not rebound to the hardened namespace");
  const [migratedNamespace] = migratedNamespaces;
  assert.equal(metadata.credentials[migratedNamespace].token.configured, true);
  assert.equal(
    await reopenedCredentials.useCredential(migratedNamespace, "token", (value) => value.toString("utf8")),
    SECRET
  );
  await reopenedCredentials.close();
});
