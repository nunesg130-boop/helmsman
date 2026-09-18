import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeLokiRoute,
  LOKI_QUERY_LIMITS,
  LOKI_ROUTE_IDS,
  normalizeLokiQueryInput
} from "../server/loki.mjs";

const START = "1789750800000000000";
const END = "1789754400000000000";

test("Loki routes are an exact, frozen, GET-only allowlist", () => {
  assert.deepEqual(LOKI_ROUTE_IDS, ["ready", "buildInfo", "labels", "labelValues", "queryRange"]);
  const fixed = new Map([
    ["ready", "/ready"],
    ["buildInfo", "/loki/api/v1/status/buildinfo"],
    ["labels", "/loki/api/v1/labels"]
  ]);
  for (const [routeId, path] of fixed) {
    const route = authorizeLokiRoute(routeId);
    assert.equal(route.allowed, true);
    assert.equal(route.service, "loki");
    assert.equal(route.method, "GET");
    assert.equal(route.upstreamPathAndQuery, path);
    assert.equal(route.internalOnly, true);
    assert.equal(Object.isFrozen(route), true);
  }

  assert.equal(
    authorizeLokiRoute("labelValues", "GET", { labelName: "service_name" }).upstreamPathAndQuery,
    "/loki/api/v1/label/service_name/values"
  );
  for (const labelName of ["", "1service", "service-name", "../admin", "x?query=evil", "a".repeat(129)]) {
    assert.equal(authorizeLokiRoute("labelValues", "GET", { labelName }).code, "ROUTE_NOT_ALLOWED");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    assert.equal(authorizeLokiRoute("labels", method).code, "METHOD_NOT_ALLOWED");
  }
  for (const routeId of ["", "query", "series", "push", "delete", "../../ready", "/ready", null]) {
    assert.equal(authorizeLokiRoute(routeId).code, "ROUTE_NOT_ALLOWED");
  }
});

test("Loki range routes construct one exact bounded query with URLSearchParams", () => {
  const route = authorizeLokiRoute("queryRange", "GET", {
    query: "{service=\"radarr\"} |= \"failed request\"",
    start: START,
    end: END,
    direction: "forward",
    limit: 50
  });
  assert.equal(route.allowed, true);
  assert.equal(route.upstreamPath, "/loki/api/v1/query_range");
  const expected = new URLSearchParams();
  expected.set("query", "{service=\"radarr\"} |= \"failed request\"");
  expected.set("start", START);
  expected.set("end", END);
  expected.set("direction", "forward");
  expected.set("limit", "50");
  assert.equal(route.upstreamPathAndQuery, `/loki/api/v1/query_range?${expected.toString()}`);

  const wrapped = authorizeLokiRoute("queryRange", "GET", {
    queryInput: { query: "{job=\"helmsman\"}", start: START, end: END }
  });
  assert.equal(wrapped.allowed, true);
  assert.match(wrapped.upstreamPathAndQuery, /direction=backward&limit=200$/u);
});

test("Loki query normalization rejects unknown fields and enforces all bounds", () => {
  assert.deepEqual(normalizeLokiQueryInput({
    query: "  {job=\"helmsman\"}  ",
    start: "2026-09-18T12:00:00.000Z",
    end: "2026-09-18T13:00:00.000Z"
  }), {
    query: "{job=\"helmsman\"}",
    start: "1789732800000000000",
    end: "1789736400000000000",
    direction: "backward",
    limit: 200
  });
  assert.equal(Object.isFrozen(normalizeLokiQueryInput({ query: "{}", start: START, end: END })), true);

  const valid = { query: "{job=\"helmsman\"}", start: START, end: END };
  assert.throws(() => normalizeLokiQueryInput({ ...valid, path: "/admin" }), /unsupported fields/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, query: "" }), /visible characters/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, query: "{}\n{evil=\"1\"}" }), /visible characters/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, query: "x".repeat(LOKI_QUERY_LIMITS.maximumQueryCodePoints + 1) }), /visible characters/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, start: END, end: START }), /before start/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, start: "0", end: "86400000000001" }), /24-hour/iu);
  assert.throws(() => normalizeLokiQueryInput({ ...valid, direction: "sideways" }), /direction/iu);
  for (const limit of [0, -1, 501, 1.5, "01", null]) {
    assert.throws(() => normalizeLokiQueryInput({ ...valid, limit }), /limit/iu);
  }
});

test("Loki route authorization is non-throwing for hostile option objects", () => {
  const hostile = new Proxy({}, {
    get() { throw new Error("do not inspect"); },
    ownKeys() { throw new Error("do not enumerate"); }
  });
  assert.doesNotThrow(() => authorizeLokiRoute("queryRange", "GET", hostile));
  assert.equal(authorizeLokiRoute("queryRange", "GET", hostile).allowed, false);
  assert.doesNotThrow(() => authorizeLokiRoute("labelValues", "GET", hostile));
  assert.equal(authorizeLokiRoute("labelValues", "GET", hostile).allowed, false);
});
