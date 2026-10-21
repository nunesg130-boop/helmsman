// A drop-in replacement for AbortSignal.any() that does not leak when one of
// its inputs lives for the whole process.
//
// Node's AbortSignal.any() records every combined signal in a set on each
// input signal and only empties that set when the input aborts. Helmsman
// combines a per-request timeout with the broker's shutdown signal on every
// upstream call, and the shutdown signal never aborts while the broker runs,
// so that set grew by one or two entries per request for as long as the
// process lived. A heap comparison of the demo showed thousands of WeakRefs
// piling up within minutes; in a busy deployment it adds megabytes per hour.
//
// Here each input gets one abort listener, installed on first use, which
// reaches combined signals only through WeakRefs. The WeakRef set is pruned as
// it grows, so once a request's signal is unreachable its entry disappears.

const dependents = new WeakMap(); // input signal -> { refs: Set<WeakRef<AbortSignal>>, additions }
const controllers = new WeakMap(); // combined signal -> its AbortController
const PRUNE_EVERY = 128;

function isSignal(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function";
}

function abortCombined(ref, reason) {
  const signal = ref.deref();
  if (!signal || signal.aborted) return;
  controllers.get(signal)?.abort(reason);
}

function prune(entry) {
  for (const ref of entry.refs) {
    const signal = ref.deref();
    if (!signal || signal.aborted) entry.refs.delete(ref);
  }
}

function track(input, combined) {
  let entry = dependents.get(input);
  if (!entry) {
    entry = { refs: new Set(), additions: 0 };
    dependents.set(input, entry);
    const tracked = entry;
    input.addEventListener("abort", () => {
      for (const ref of tracked.refs) abortCombined(ref, input.reason);
      tracked.refs.clear();
    }, { once: true });
  }
  entry.refs.add(new WeakRef(combined));
  entry.additions += 1;
  if (entry.additions % PRUNE_EVERY === 0) prune(entry);
}

/**
 * Returns a signal that aborts as soon as any of `signals` aborts, with that
 * signal's reason. Falsy entries are ignored. Behaves like AbortSignal.any().
 */
export function anySignal(signals) {
  const inputs = (Array.isArray(signals) ? signals : []).filter(isSignal);
  const controller = new AbortController();
  const combined = controller.signal;
  const alreadyAborted = inputs.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return combined;
  }
  controllers.set(combined, controller);
  for (const input of inputs) track(input, combined);
  return combined;
}

/** How many combined signals an input still tracks, after pruning. For tests. */
export function trackedDependentCount(input) {
  const entry = dependents.get(input);
  if (!entry) return 0;
  prune(entry);
  return entry.refs.size;
}
