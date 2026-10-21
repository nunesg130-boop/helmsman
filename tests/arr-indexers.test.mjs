import assert from "node:assert/strict";
import test from "node:test";

import { authorizeArrIndexerStep, parseArrIndexers } from "../server/arr-indexers.mjs";
import { authorizeBridgeRoute } from "../server/routes.mjs";

const SECRET = "s3cr3t-api-key-0123456789abcdef0123456789";

test("Radarr and Sonarr indexer summaries keep only safe fields", () => {
  const indexers = parseArrIndexers([
    { id: 2, name: "Tracker B (Prowlarr)", enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false, protocol: "usenet", fields: [{ name: "apiKey", value: SECRET }] },
    { id: 1, name: "Tracker A (Prowlarr)", enableRss: true, enableAutomaticSearch: true, protocol: "torrent", priority: 25, fields: [{ name: "apiKey", value: SECRET }], baseUrl: `https://x/?apikey=${SECRET}` },
    { id: 1, name: "duplicate" },
    { id: 0, name: "invalid" }
  ], [{ indexerId: 1, initialFailure: "2026-10-20T13:00:00Z", disabledTill: "2026-10-20T14:00:00Z" }]);
  assert.deepEqual(indexers.map(({ id }) => id), [1, 2], "failing first, duplicates and invalid ids dropped");
  assert.deepEqual(indexers[0], {
    id: 1, name: "Tracker A (Prowlarr)", enabled: true, rss: true, search: true, protocol: "torrent", priority: 25,
    failing: true, disabledUntil: "2026-10-20T14:00:00.000Z", failingSince: "2026-10-20T13:00:00.000Z", lastFailureAt: null
  });
  assert.equal(indexers[1].enabled, false);
  assert.equal(JSON.stringify(indexers).includes(SECRET), false);
  assert.throws(() => parseArrIndexers({}, []), /invalid indexer list/u);
});

test("only the fixed indexer steps are allowed, for Radarr and Sonarr only", () => {
  const read = authorizeArrIndexerStep("radarr", "readIndexer", { indexerId: 3 });
  assert.equal(read.upstreamPath, "/api/v3/indexer/3");
  assert.equal(read.service, "radarr");
  assert.equal(read.internalOnly, true);
  const record = JSON.stringify({ id: 3, fields: [{ name: "apiKey", value: SECRET }] });
  const tested = authorizeArrIndexerStep("sonarr", "testIndexer", { indexerId: 3, record });
  assert.equal(tested.method, "POST");
  assert.equal(tested.upstreamPath, "/api/v3/indexer/test");
  assert.equal(authorizeArrIndexerStep("sonarr", "testIndexer", { indexerId: 3, record: JSON.stringify({ id: 4 }) }).allowed, false);
  assert.equal(authorizeArrIndexerStep("sonarr", "testIndexer", { indexerId: 3, record: "x".repeat(300 * 1024) }).allowed, false);
  assert.equal(authorizeArrIndexerStep("sonarr", "testAllIndexers").upstreamPath, "/api/v3/indexer/testall");
  assert.equal(authorizeArrIndexerStep("sonarr", "testAllIndexers", { indexerId: 3 }).allowed, false);
  assert.equal(authorizeArrIndexerStep("prowlarr", "testAllIndexers").allowed, false);
  assert.equal(authorizeArrIndexerStep("radarr", "deleteIndexer", { indexerId: 3 }).allowed, false);
});

test("indexer records are readable by the server only", () => {
  for (const service of ["radarr", "sonarr"]) {
    const list = authorizeBridgeRoute(service, "GET", `/bridge/${service}/api/v3/indexer`);
    assert.equal(list.allowed, true);
    assert.equal(list.internalOnly, true, "never relayed to a browser");
    assert.equal(authorizeBridgeRoute(service, "GET", `/bridge/${service}/api/v3/indexerstatus`).internalOnly, false);
    assert.equal(authorizeBridgeRoute(service, "GET", `/bridge/${service}/api/v3/indexer/3`).allowed, false);
    assert.equal(authorizeBridgeRoute(service, "POST", `/bridge/${service}/api/v3/indexer/test`).allowed, false);
  }
});

test("a missing indexerstatus endpoint means no failure details, not no indexers", async () => {
  const { optionalIndexerStatus } = await import("../server/arr-indexers.mjs");
  assert.deepEqual(optionalIndexerStatus({ status: 200, body: [{ indexerId: 2 }] }), { body: [{ indexerId: 2 }], available: true });
  assert.deepEqual(optionalIndexerStatus({ status: 404, body: "Not Found" }), { body: [], available: false });
  assert.deepEqual(optionalIndexerStatus({ status: 405, body: null }), { body: [], available: false });
  assert.equal(optionalIndexerStatus({ status: 401, body: null }), null);
  assert.equal(optionalIndexerStatus({ status: 500, body: null }), null);
  const parsed = parseArrIndexers([{ id: 1, name: "Tracker", enableRss: true, protocol: "torrent" }], optionalIndexerStatus({ status: 404 }).body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].failing, false);
});
