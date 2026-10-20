import assert from "node:assert/strict";
import test from "node:test";

import { authorizeBridgeRoute } from "../server/routes.mjs";
import {
  authorizeProwlarrStep,
  cleanProwlarrMessage,
  parseApplications,
  parseIndexers,
  parseTestResults,
  validationMessage
} from "../server/prowlarr.mjs";

const SECRET = "s3cr3t-api-key-0123456789abcdef0123456789";

const INDEXERS = [
  {
    id: 3,
    name: "1337x",
    enable: true,
    protocol: "torrent",
    privacy: "public",
    priority: 25,
    implementation: "Cardigann",
    fields: [{ name: "apiKey", value: SECRET }, { name: "cookie", value: SECRET }],
    baseUrl: `https://example.invalid/?apikey=${SECRET}`
  },
  { id: 7, name: "Usenet Example", enable: false, protocol: "usenet", privacy: "private", fields: [{ name: "password", value: SECRET }] },
  { id: 7, name: "duplicate" },
  { id: -1, name: "invalid" }
];

test("indexer summaries keep only safe fields and merge status and stats", () => {
  const indexers = parseIndexers(
    INDEXERS,
    [{ id: 1, indexerId: 3, initialFailure: "2026-10-20T13:00:00Z", mostRecentFailure: "2026-10-20T13:40:00Z", disabledTill: "2026-10-20T14:10:00Z" }],
    { indexers: [{ indexerId: 3, numberOfQueries: 120, numberOfGrabs: 9, numberOfFailedQueries: 4, averageResponseTime: 850 }] }
  );
  assert.deepEqual(indexers.map(({ id }) => id), [3, 7], "failing first, duplicates and invalid ids dropped");
  assert.deepEqual(indexers[0], {
    id: 3,
    name: "1337x",
    enabled: true,
    protocol: "torrent",
    privacy: "public",
    priority: 25,
    failing: true,
    disabledUntil: "2026-10-20T14:10:00.000Z",
    failingSince: "2026-10-20T13:00:00.000Z",
    lastFailureAt: "2026-10-20T13:40:00.000Z",
    queries: 120,
    grabs: 9,
    failedQueries: 4,
    averageResponseMs: 850
  });
  assert.equal(indexers[1].failing, false);
  assert.equal(JSON.stringify(indexers).includes(SECRET), false, "no secret survives");
  assert.throws(() => parseIndexers({ records: [] }, []), /invalid Prowlarr indexer list/u);
});

test("applications keep names only", () => {
  const apps = parseApplications([{ id: 1, name: "Sonarr", implementationName: "Sonarr", syncLevel: "fullSync", fields: [{ name: "apiKey", value: SECRET }] }]);
  assert.deepEqual(apps, [{ id: 1, name: "Sonarr", kind: "Sonarr", syncLevel: "fullSync" }]);
  assert.deepEqual(parseApplications("nope"), []);
});

test("Prowlarr messages are cleaned of keys, query strings and control characters", () => {
  assert.equal(cleanProwlarrMessage(`Unable to connect to https://tracker.example/api?apikey=${SECRET}&t=caps`), "Unable to connect to https://tracker.example/api?…");
  assert.equal(cleanProwlarrMessage(`Invalid passkey=${SECRET}`), "Invalid [removed]");
  assert.equal(cleanProwlarrMessage("Line one\nline\u0007 two"), "Line one line two");
  assert.equal(validationMessage([
    { propertyName: "BaseUrl", errorMessage: "Unable to connect to indexer, check the log above the ValidationFailure for more details", attemptedValue: SECRET },
    { errorMessage: "Cloudflare challenge" },
    { errorMessage: "third is dropped" }
  ]), "Unable to connect to indexer, check the log above the ValidationFailure for more details Cloudflare challenge");
  assert.deepEqual(parseTestResults([{ id: 3, isValid: false, validationFailures: [{ errorMessage: "Site down" }] }, { id: 7, isValid: true, validationFailures: [] }]), [
    { id: 3, ok: false, message: "Site down" },
    { id: 7, ok: true, message: "" }
  ]);
});

test("only the fixed Prowlarr action steps are allowed", () => {
  const read = authorizeProwlarrStep("readIndexer", { indexerId: 3 });
  assert.equal(read.method, "GET");
  assert.equal(read.upstreamPath, "/api/v1/indexer/3");
  assert.equal(read.internalOnly, true);

  const record = JSON.stringify({ id: 3, name: "1337x", fields: [{ name: "apiKey", value: SECRET }] });
  const tested = authorizeProwlarrStep("testIndexer", { indexerId: 3, record });
  assert.equal(tested.method, "POST");
  assert.equal(tested.upstreamPath, "/api/v1/indexer/test");
  assert.equal(JSON.parse(tested.body).id, 3);

  assert.equal(authorizeProwlarrStep("testIndexer", { indexerId: 3, record: JSON.stringify({ id: 4 }) }).allowed, false, "the record must be the same indexer");
  assert.equal(authorizeProwlarrStep("testIndexer", { indexerId: 3, record: "[]" }).allowed, false);
  assert.equal(authorizeProwlarrStep("testIndexer", { indexerId: 3, record: "x".repeat(300 * 1024) }).allowed, false);
  assert.equal(authorizeProwlarrStep("testAllIndexers", { indexerId: 3 }).allowed, false);
  assert.equal(authorizeProwlarrStep("deleteIndexer", { indexerId: 3 }).allowed, false);
  assert.equal(authorizeProwlarrStep("readIndexer", { indexerId: "3" }).allowed, false);
  assert.deepEqual(JSON.parse(authorizeProwlarrStep("syncApps").body), { name: "ApplicationIndexerSync" });
  assert.equal(authorizeProwlarrStep("testApps").upstreamPath, "/api/v1/applications/testall");
});

test("indexer and application records are readable by the server only", () => {
  for (const path of ["/api/v1/indexer", "/api/v1/indexerstats", "/api/v1/applications"]) {
    const route = authorizeBridgeRoute("prowlarr", "GET", `/bridge/prowlarr${path}`);
    assert.equal(route.allowed, true, path);
    assert.equal(route.internalOnly, true, `${path} is never relayed to a browser`);
  }
  assert.equal(authorizeBridgeRoute("prowlarr", "GET", "/bridge/prowlarr/api/v1/indexerstatus").internalOnly, false);
  assert.equal(authorizeBridgeRoute("prowlarr", "GET", "/bridge/prowlarr/api/v1/indexer/3").allowed, false, "single records are only read by the action path");
  assert.equal(authorizeBridgeRoute("prowlarr", "POST", "/bridge/prowlarr/api/v1/indexer/test").allowed, false);
});
