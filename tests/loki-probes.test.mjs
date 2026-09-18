import assert from "node:assert/strict";
import test from "node:test";
import { probeLoki } from "../server/loki-probes.mjs";

test("Loki probe keeps connection and service readiness separate", async () => {
  const responses = {
    ready: { status: 503, body: Buffer.from("not ready") },
    buildInfo: { status: 200, body: { version: "3.5.1" } },
    queryRange: {
      status: 200,
      body: { status: "success", data: { resultType: "streams", result: [] } }
    }
  };
  let time = 0;
  const result = await probeLoki(async (route) => responses[route], { now: () => ++time });
  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "degraded");
  assert.equal(result.checks[0].code, "LOKI_NOT_READY");
  assert.equal(result.version, "3.5.1");
});

test("Loki probe distinguishes query authorization from connectivity", async () => {
  const result = await probeLoki(async (route) => ({
    ready: { status: 200, body: "ready" },
    buildInfo: { status: 200, body: { version: "3.5.1" } },
    queryRange: { status: 403, body: "" }
  })[route]);
  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "auth_required");
  assert.equal(result.checks.find(({ id }) => id === "query").code, "AUTHENTICATION_REQUIRED");
});

test("Loki readiness authorization failures still prove transport connectivity", async () => {
  const result = await probeLoki(async () => ({ status: 401, body: "unauthorized" }));
  assert.equal(result.connectionState, "connected");
  assert.equal(result.state, "auth_required");
  assert.equal(result.checks[0].code, "AUTHENTICATION_REQUIRED");
  assert.equal(result.checks[0].status, 401);
});

test("Loki probe reports a healthy read path without retaining query results", async () => {
  let queryParameters = null;
  const result = await probeLoki(async (route, parameters) => {
    if (route === "queryRange") queryParameters = parameters;
    return ({
    ready: { status: 200, body: Buffer.from("ready\n") },
    buildInfo: { status: 200, body: JSON.stringify({ version: "3.5.1", secret: "discard" }) },
    queryRange: {
      status: 200,
      body: {
        status: "success",
        data: {
          resultType: "streams",
          result: [{ stream: { secret: "discard" }, values: [["1", "sensitive line"]] }]
        }
      }
    }
  })[route];
  }, { checkedAt: "2026-09-18T12:00:00.000Z" });
  assert.equal(result.state, "healthy");
  assert.equal(result.connectionState, "connected");
  assert.equal(result.version, "3.5.1");
  assert.deepEqual(queryParameters, {
    queryInput: {
      query: "{__helmsman_probe__=\"1\"}",
      start: "1789732740000000000",
      end: "1789732800000000000",
      direction: "backward",
      limit: 1
    }
  });
  assert.equal(JSON.stringify(result).includes("sensitive line"), false);
  assert.equal(JSON.stringify(result).includes("discard"), false);
});
