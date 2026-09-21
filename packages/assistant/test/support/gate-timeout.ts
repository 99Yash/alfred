/**
 * Bound a test rendezvous so a missed signal fails fast instead of hanging.
 *
 * Several DB-backed suites coordinate workers through `Promise.withResolvers`
 * gates (a paused protocol, a lock holder, an intercepted commit). A bare
 * `await gate.promise` never settles when the rendezvous is missed — usually
 * because an earlier behavior change rerouted the code under test — and the
 * file then sits silent until the CI job timeout (20 minutes), masking the
 * real assertion failure behind a cancelled shard. Racing the gate against a
 * timer converts that silence into a named failure in seconds.
 */
export function awaitGate<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  // NB: the timer stays referenced on purpose. An unref'd timer lets a child
  // process with no other live handles exit silently instead of failing, which
  // would turn a missed rendezvous into a quiet pass. The 10 s ceiling bounds
  // the cost, and the suite runs with `--test-force-exit` regardless.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`test gate timed out after ${String(timeoutMs)}ms: ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
