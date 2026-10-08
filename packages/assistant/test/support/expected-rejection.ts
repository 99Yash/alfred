/**
 * Mark a rejection as expected and return the same promise.
 * Without this, a rejection that lands before `assert.rejects` attaches fails the test as unhandled.
 * Every claimed promise needs exactly one unconditional `assert.rejects`: the claim removes the runner's net.
 * Not a silent catch: the rejection still reaches the assertion.
 * @see awaitGate in ./gate-timeout.ts for the same timing concern from the other side.
 */
export function claimExpectedRejection<T>(promise: Promise<T>): Promise<T> {
  // The handler is empty, so the derived promise cannot reject. The original still rejects.
  void promise.catch(() => {});

  return promise;
}
