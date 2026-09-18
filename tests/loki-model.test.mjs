import assert from "node:assert/strict";
import test from "node:test";

import {
  LOKI_QUERY_LIMITS,
  normalizeLokiQueryResult,
  normalizeLokiResponse
} from "../server/loki.mjs";

function response(result) {
  return { status: "success", data: { resultType: "streams", result } };
}

test("Loki response normalization preserves nanosecond timestamps and drops upstream metadata", () => {
  const normalized = normalizeLokiResponse({
    status: "success",
    warnings: ["not for clients"],
    data: {
      resultType: "streams",
      stats: { ingester: { secret: "drop-me" } },
      result: [{
        stream: { job: "helmsman", service_name: "radarr" },
        values: [["1789754400123456789", "normal message"]],
        extra: "drop-me"
      }]
    }
  });
  assert.deepEqual(normalized, {
    status: "success",
    data: {
      resultType: "streams",
      result: [{
        stream: { job: "helmsman", service_name: "radarr" },
        values: [["1789754400123456789", "normal message"]]
      }]
    },
    truncated: false
  });
  assert.equal(typeof normalized.data.result[0].values[0][0], "string");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.data.result), true);
});

test("Loki lines and labels redact obvious credentials and setup tokens", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: [REDACTED]"],
    ["proxy-authorization=Basic dXNlcjpwYXNz", "proxy-authorization=[REDACTED]"],
    ["retry with Bearer abcdefghijklmnop", "retry with Bearer [REDACTED]"],
    ["password=hunter2 token:abcdef123456 api-key=topsecret", "password=[REDACTED] token:[REDACTED] api-key=[REDACTED]"],
    ["Cookie: session=abcdef123456", "Cookie: [REDACTED]"],
    ["Helmsman setup token: one-time-secret", "Helmsman setup token: [REDACTED]"]
  ];
  const normalized = normalizeLokiResponse(response([{
    stream: {
      job: "helmsman",
      authorization: "Bearer secret-label-value",
      token: "token=label-secret"
    },
    values: cases.map(([line], index) => [`17897544001234567${89 + index}`, line])
  }]));
  assert.equal(normalized.data.result[0].stream.authorization, "Bearer [REDACTED]");
  assert.equal(normalized.data.result[0].stream.token, "token=[REDACTED]");
  assert.deepEqual(
    normalized.data.result[0].values.map((entry) => entry[1]),
    cases.map(([, expected]) => expected)
  );
});

test("Loki response normalization bounds streams, lines, labels, values, and line length", () => {
  const labels = {};
  for (let index = 0; index < LOKI_QUERY_LIMITS.maximumLabelsPerStream + 10; index += 1) {
    labels[`label_${index}`] = index === 0
      ? "v".repeat(LOKI_QUERY_LIMITS.maximumLabelValueCodePoints + 20)
      : `value-${index}`;
  }
  labels["invalid-name"] = "drop";
  const values = Array.from(
    { length: LOKI_QUERY_LIMITS.maximumLines + 20 },
    (_, index) => [String(1_789_754_400_000_000_000n + BigInt(index)), index === 0
      ? "x".repeat(LOKI_QUERY_LIMITS.maximumLineCodePoints + 20)
      : `line ${index}`]
  );
  const streams = Array.from(
    { length: LOKI_QUERY_LIMITS.maximumStreams + 5 },
    (_, index) => ({ stream: { ...labels, stream: String(index) }, values })
  );
  const normalized = normalizeLokiResponse(response(streams));
  assert.equal(normalized.truncated, true);
  assert.equal(normalized.data.result.length, 1);
  assert.equal(normalized.data.result[0].values.length, LOKI_QUERY_LIMITS.maximumLines);
  assert.equal(Object.keys(normalized.data.result[0].stream).length, LOKI_QUERY_LIMITS.maximumLabelsPerStream);
  assert.equal("invalid-name" in normalized.data.result[0].stream, false);
  assert.equal(Array.from(normalized.data.result[0].stream.label_0).length, LOKI_QUERY_LIMITS.maximumLabelValueCodePoints);
  assert.equal(Array.from(normalized.data.result[0].values[0][1]).length, LOKI_QUERY_LIMITS.maximumLineCodePoints);
  assert.match(normalized.data.result[0].values[0][1], /\u2026$/u);
});

test("Loki response normalization rejects non-stream envelopes and skips malformed entries", () => {
  for (const payload of [
    null,
    {},
    { status: "error", data: { resultType: "streams", result: [] } },
    { status: "success", data: { resultType: "matrix", result: [] } },
    { status: "success", data: { resultType: "streams", result: {} } }
  ]) assert.throws(() => normalizeLokiResponse(payload), /Invalid Loki streams response/u);

  const normalized = normalizeLokiResponse(response([
    null,
    { stream: { job: "valid", "bad-name": "drop" }, values: [
      [1789754400123456789, "imprecise number timestamp"],
      ["not-a-timestamp", "bad timestamp"],
      ["1789754400123456789", 123],
      ["1789754400123456790", "valid\nline"]
    ] }
  ]));
  assert.deepEqual(normalized.data.result, [{
    stream: { job: "valid" },
    values: [["1789754400123456790", "valid line"]]
  }]);
  assert.equal(normalized.truncated, true);
});

test("Loki query results merge streams globally in the requested direction before limiting", () => {
  const payload = response([
    {
      stream: { job: "first" },
      values: [
        ["1789754400000000001", "first-old"],
        ["1789754400000000004", "first-new"]
      ]
    },
    {
      stream: { job: "second" },
      values: [
        ["1789754400000000002", "second-old"],
        ["1789754400000000003", "second-new"]
      ]
    }
  ]);
  const backward = normalizeLokiQueryResult(payload, { direction: "backward", limit: 3 });
  assert.deepEqual(backward.entries.map(({ line }) => line), ["first-new", "second-new", "second-old"]);
  assert.equal(backward.truncated, true);
  assert.equal(backward.entries[0].timestamp, "2026-09-18T18:00:00.000Z");

  const forward = normalizeLokiQueryResult(payload, { direction: "forward", limit: 4 });
  assert.deepEqual(forward.entries.map(({ line }) => line), ["first-old", "second-old", "second-new", "first-new"]);
  assert.equal(forward.truncated, false);
});
