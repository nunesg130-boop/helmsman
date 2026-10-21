import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";

import { anySignal, trackedDependentCount } from "../server/abort-signals.mjs";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("anySignal aborts with the reason of whichever input aborts first", async () => {
  const shutdown = new AbortController();
  const request = new AbortController();
  const combined = anySignal([shutdown.signal, request.signal, null]);
  assert.equal(combined.aborted, false);
  const reason = new Error("request cancelled");
  request.abort(reason);
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, reason);
  assert.equal(shutdown.signal.aborted, false, "aborting one request never aborts the shutdown signal");

  const timed = anySignal([AbortSignal.timeout(20), shutdown.signal]);
  await new Promise((resolve) => setTimeout(resolve, 80)); // AbortSignal.timeout timers are unref()ed
  assert.equal(timed.aborted, true);
  assert.equal(timed.reason?.name, "TimeoutError", "timeouts keep their TimeoutError reason");

  const pending = anySignal([AbortSignal.timeout(60_000), shutdown.signal]);
  shutdown.abort(new Error("stopping"));
  assert.equal(pending.aborted, true);
  assert.equal(pending.reason?.message, "stopping");
  assert.equal(anySignal([shutdown.signal]).aborted, true, "an already-aborted input aborts the result at once");
});

test("a long-lived input does not keep every combined signal it ever saw", async () => {
  const shutdown = new AbortController();
  for (let index = 0; index < 20_000; index += 1) {
    const signal = anySignal([new AbortController().signal, shutdown.signal]);
    if (signal.aborted) throw new Error("unexpected abort");
  }
  await settle();
  gc();
  await settle();
  gc();
  assert.ok(trackedDependentCount(shutdown.signal) < 500, `expected the shutdown signal to drop finished requests, still tracking ${trackedDependentCount(shutdown.signal)}`);

  const kept = anySignal([shutdown.signal]);
  shutdown.abort(new Error("stopping"));
  assert.equal(kept.aborted, true, "live combined signals are still aborted on shutdown");
});
