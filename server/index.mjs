#!/usr/bin/env node
import http from "node:http";
import { randomBytes } from "node:crypto";
import { lstat, open, rename } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { createBroker, createHttpServer } from "./broker.mjs";
import { acquireDataDirLock } from "./lock.mjs";
import { CredentialStore } from "./secrets.mjs";
import { SessionAuthStore } from "./session-auth.mjs";
import { StateStore } from "./state.mjs";

const BROWSER_AUTH_STATE_NAMESPACE = "browser-auth-state";
const BROWSER_AUTH_STATE_FIELD = "schema";
const BROWSER_AUTH_STATE_VERSION = "4";

function configuredPort() {
  const raw = process.env.HELMSMAN_PORT || process.env.JELLOFIN_COMMAND_PORT || "8080";
  if (!/^\d{1,5}$/u.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error("HELMSMAN_PORT must be a TCP port from 1 to 65535.");
  }
  return Number(raw);
}

function configuredHost() {
  const raw = process.env.HELMSMAN_HOST || process.env.JELLOFIN_COMMAND_HOST || "0.0.0.0";
  if (!isIP(raw)) throw new Error("HELMSMAN_HOST must be an IPv4 or IPv6 address.");
  return raw;
}

async function serve() {
  const port = configuredPort();
  const host = configuredHost();
  const dataDir = process.env.HELMSMAN_DATA_DIR || process.env.JELLOFIN_COMMAND_DATA_DIR || "/data";
  const lock = await acquireDataDirLock(dataDir);
  let broker;
  try {
    broker = await createBroker({
      dataDir,
      stateGuard: () => lock.assertHeld(),
      log: (message) => process.stdout.write(`${message}\n`)
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
  const server = createHttpServer(broker.handler);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await lock.release();
    throw error;
  }
  process.stdout.write(`Helmsman broker ${broker.version} listening on port ${port}.\n`);
  await broker.recordEvent({
    level: "info",
    category: "application",
    event: "application.started",
    outcome: "started",
    service: "helmsman"
  });

  let stopping = null;
  const stop = (failed = false) => {
    if (stopping) return stopping;
    broker.beginShutdown();
    stopping = (async () => {
      let closeError = null;
      const closed = new Promise((resolve) => {
        server.close((error) => {
          closeError = error;
          resolve();
        });
      });
      const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
      forceClose.unref();
      await closed;
      clearTimeout(forceClose);
      const shutdownFailed = failed || Boolean(closeError);
      await broker.drain({
        finalEvent: {
          level: shutdownFailed ? "error" : "info",
          category: "application",
          event: "application.stopped",
          outcome: shutdownFailed ? "failed" : "succeeded",
          service: "helmsman",
          ...(shutdownFailed ? { code: "APPLICATION_STOP_FAILED" } : {})
        }
      });
      try {
        await lock.release();
      } catch {
        process.exitCode = 1;
        return;
      }
      process.exitCode = failed || closeError ? 1 : 0;
    })().catch(() => {
      process.exitCode = 1;
    });
    return stopping;
  };
  server.on("error", () => void stop(true));
  lock.onLost(() => {
    // The journal shares the same lock guard, so writing after lock loss would
    // be unsafe and is deliberately refused. stderr is the durable container
    // runtime signal for this exceptional condition.
    process.stderr.write("Helmsman broker error: the data-directory lock was lost.\n");
    void stop(true);
  });
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function healthcheck() {
  const port = configuredPort();
  await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/healthz",
      headers: { Host: `127.0.0.1:${port}` },
      timeout: 2_000,
      agent: false
    }, (response) => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error("The health endpoint returned a non-success status."));
    });
    request.on("timeout", () => request.destroy(new Error("The healthcheck timed out.")));
    request.on("error", reject);
  });
}

function quarantineSuffix() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/gu, "");
  return `${timestamp}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

async function regularFileExists(filePath, label, required) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) {
      throw new Error(`${label} is not a regular file; recovery was refused.`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return false;
    if (error?.code === "ENOENT") throw new Error(`${label} was not found; there is nothing to reset.`);
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch {
    // The individual renames are still atomic on filesystems that do not
    // support opening or syncing a directory.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function quarantineFiles(dataDir, entries) {
  const suffix = quarantineSuffix();
  const prepared = [];
  for (const entry of entries) {
    if (!await regularFileExists(entry.source, entry.label, entry.required === true)) continue;
    prepared.push({
      source: entry.source,
      destination: path.join(dataDir, `${path.basename(entry.source)}.${entry.reason}-${suffix}`)
    });
  }

  const moved = [];
  try {
    for (const entry of prepared) {
      await rename(entry.source, entry.destination);
      moved.push(entry);
    }
    await syncDirectory(dataDir);
    return moved;
  } catch (error) {
    let rollbackFailed = false;
    for (const entry of moved.reverse()) {
      try {
        await rename(entry.destination, entry.source);
      } catch {
        rollbackFailed = true;
      }
    }
    await syncDirectory(dataDir);
    if (rollbackFailed) {
      throw new Error("Recovery could not safely quarantine or restore every data file.", { cause: error });
    }
    throw error;
  }
}

async function resetAccess() {
  if (process.argv.length !== 4 || process.argv[3] !== "--confirm") {
    throw new Error("Access reset refused. Stop the broker, then run: node server/index.mjs reset-access --confirm");
  }
  const dataDir = process.env.HELMSMAN_DATA_DIR || process.env.JELLOFIN_COMMAND_DATA_DIR || "/data";
  const lock = await acquireDataDirLock(dataDir);
  try {
    const store = new StateStore(dataDir, { guard: () => lock.assertHeld() });
    await store.initialize();
    const credentials = new CredentialStore(dataDir, {
      instanceId: store.snapshot().instanceId,
      keyFilePath: process.env.HELMSMAN_MASTER_KEY_FILE
        ?? process.env.JELLOFIN_COMMAND_MASTER_KEY_FILE,
      guard: () => lock.assertHeld()
    });
    try {
      await credentials.initialize();
      const markerPresent = credentials.hasCredential(
        BROWSER_AUTH_STATE_NAMESPACE,
        BROWSER_AUTH_STATE_FIELD
      );
      if (markerPresent) {
        const markerValid = await credentials.useCredential(
          BROWSER_AUTH_STATE_NAMESPACE,
          BROWSER_AUTH_STATE_FIELD,
          (value) => value.equals(Buffer.from(BROWSER_AUTH_STATE_VERSION, "utf8"))
        );
        if (!markerValid) throw new Error("The browser authorization-state version is not supported.");
      }
      const allowLegacySessionMigration = !markerPresent
        && !credentials.createdDuringInitialization();
      // Persist the anti-downgrade marker before the one authorized legacy
      // conversion. If recovery is interrupted, the next reset-access run
      // quarantines the now-untrusted legacy file instead of reopening it.
      if (!markerPresent) {
        await credentials.setCredential(
          BROWSER_AUTH_STATE_NAMESPACE,
          BROWSER_AUTH_STATE_FIELD,
          BROWSER_AUTH_STATE_VERSION
        );
      }
      const sessionOptions = {
        guard: () => lock.assertHeld(),
        stateIntegrityTag: (payload) => credentials.sessionStateIntegrityTag(payload),
        allowLegacyMigration: allowLegacySessionMigration
      };
      let sessions = new SessionAuthStore(dataDir, sessionOptions);
      let recoveredSessionState = false;
      try {
        await sessions.initialize();
        await sessions.clearAccess();
      } catch {
        await lock.assertHeld();
        await quarantineFiles(dataDir, [{
          source: sessions.filePath,
          label: "Browser session state",
          reason: "corrupt",
          required: true
        }]);
        sessions = new SessionAuthStore(dataDir, { ...sessionOptions, allowLegacyMigration: false });
        await sessions.initialize();
        recoveredSessionState = true;
      }
      const namespaces = Object.keys(credentials.publicSnapshot().credentials || {})
        .filter((namespace) => /^browser-auth-[a-f0-9-]{36}$/u.test(namespace));
      for (const namespace of namespaces) await credentials.removeServiceCredentials(namespace);
      await store.resetAccess();
      if (recoveredSessionState) {
        process.stdout.write("Malformed browser session state was quarantined and replaced.\n");
      }
    } finally {
      await credentials.close().catch(() => {});
    }
  } finally {
    await lock.release();
  }
  process.stdout.write("Helmsman access was reset. Saved services and encrypted credentials were preserved. Start the broker to receive a new setup token.\n");
}

async function resetCredentials() {
  if (process.argv.length !== 4 || process.argv[3] !== "--confirm") {
    throw new Error("Credential reset refused. Stop the broker, then run: node server/index.mjs reset-credentials --confirm");
  }
  const dataDir = process.env.HELMSMAN_DATA_DIR || process.env.JELLOFIN_COMMAND_DATA_DIR || "/data";
  const externalKeyConfigured = process.env.HELMSMAN_MASTER_KEY_FILE !== undefined
    || process.env.JELLOFIN_COMMAND_MASTER_KEY_FILE !== undefined;
  const lock = await acquireDataDirLock(dataDir);
  try {
    const store = new StateStore(dataDir, { guard: () => lock.assertHeld() });
    await store.initialize();
    await quarantineFiles(dataDir, [
      {
        source: path.join(dataDir, "credentials.json"),
        label: "Encrypted credential store",
        reason: "unrecoverable",
        required: true
      },
      ...(externalKeyConfigured ? [] : [{
        source: path.join(dataDir, "credentials.key"),
        label: "Local credential encryption key",
        reason: "unrecoverable",
        required: false
      }])
    ]);
  } finally {
    await lock.release();
  }
  process.stdout.write("Encrypted credentials were quarantined. The prior browser authorization seal cannot be trusted without the prior key. Before restarting Helmsman, run reset-access --confirm to remove the owner binding and browser sessions, then enroll the Jellyfin owner again.\n");
  if (externalKeyConfigured) {
    process.stdout.write("The externally managed master-key file was not modified.\n");
  }
}

const command = process.argv[2];
try {
  if (command === "serve") await serve();
  else if (command === "healthcheck") await healthcheck();
  else if (command === "reset-access") await resetAccess();
  else if (command === "reset-credentials") await resetCredentials();
  else throw new Error("Usage: node server/index.mjs <serve|healthcheck|reset-access --confirm|reset-credentials --confirm>");
} catch (error) {
  process.stderr.write(`Helmsman broker error: ${error?.message || "startup failed"}\n`);
  process.exitCode = 1;
}
