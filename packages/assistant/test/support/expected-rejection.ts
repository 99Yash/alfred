/**
 * Mark a promise's rejection as expected, and hand back the original promise so
 * the claim and the assertion are bound to the same value.
 *
 * A promise created inside an awaited region can reject before the next line
 * attaches a handler. When the rejection is a genuine failure that costs
 * nothing — the test was going to fail anyway. When the rejection IS the
 * expected outcome it is actively misleading: the runner records an unhandled
 * rejection and fails the test, and only afterwards does `assert.rejects`
 * attach, match, and emit `PromiseRejectionHandledWarning: Promise rejection
 * was handled asynchronously`. The assertion passes and the test still fails,
 * so the log shows a failure whose stated cause is not the assertion that
 * failed.
 *
 * The DB-backed recovery tests hit this by construction. Each starts
 * `retryMcpRecoveryOperation` inside a transaction holding the very row the
 * retry blocks on, so the retry cannot settle until that transaction commits —
 * by which point the test is still awaiting the commit and no handler is
 * attached. Whether the rejection lands in that window is event-loop timing, so
 * the case is green in isolation and red under full-shard pressure.
 *
 * ## Required pairing
 *
 * Every claimed promise MUST have exactly one unconditional `assert.rejects` on
 * it, reached on every path. Before this helper an expected rejection was caught
 * twice — by `assert.rejects` and by Node's unhandled-rejection path — so a lost
 * assertion still failed the test. Claiming removes the second detector
 * permanently, and the compiler cannot see that pairing: a site that claims a
 * promise and then guards its assertion behind a conditional loses the
 * runner-level net with no type error and no lint error. Keep the
 * `assert.ok(promise)` that proves the assignment ran; it is what makes the
 * pairing unconditional.
 *
 * ## Why this is not a silent catch
 *
 * `docs/reference/code-style.md` lists "silent `catch` with no user feedback" as
 * a recurrent review hit, and `processAgentJob` in
 * `packages/assistant/src/execution/worker.ts` is the incident behind it: the
 * old bare `.catch(() => {})` on the heartbeat hid lease drift until a run was
 * reclaimed and re-billed. That failure mode is a swallowed rejection with
 * nothing behind it. This is the opposite — the rejection is carried onward to
 * an assertion that must match, and the handler exists only to close a window
 * in which the runner would otherwise decide the verdict on its own. The reason
 * is recorded here and the function is named so the next reader does not
 * "simplify" it back into a bare catch.
 *
 * @see awaitGate in ./gate-timeout.ts — the same concern from the other
 * direction: a runner-level timing artefact deciding a verdict the assertions
 * never reached.
 */
export function claimExpectedRejection<T>(promise: Promise<T>): Promise<T> {
  // The derived promise can only reject if this handler throws. Its body is
  // empty, so it cannot — the claim exists purely to mark the rejection handled
  // on the original, which is returned below and still rejected.
  void promise.catch(() => {});

  return promise;
}
