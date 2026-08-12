/**
 * The pre-fix behavior this package's Redis probes exist to catch is a command
 * that NEVER settles, so `assert.rejects` is the wrong tool: it waits forever
 * and the file times out with no statement about which command hung.
 *
 * `settleWithin` turns "still pending" into an ordinary value the test can
 * assert on, in both directions — the bounded kinds must not be `"pending"`,
 * and the `"queue"` control must be.
 */
export type Settlement =
  | { readonly state: "resolved"; readonly value: unknown }
  | { readonly state: "rejected"; readonly error: unknown }
  | { readonly state: "pending" };

export async function settleWithin(
  work: Promise<unknown>,
  deadlineMs: number,
): Promise<Settlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<Settlement> = work.then(
    (value): Settlement => ({ state: "resolved", value }),
    (error: unknown): Settlement => ({ state: "rejected", error }),
  );
  try {
    return await Promise.race([
      settled,
      new Promise<Settlement>((resolve) => {
        timer = setTimeout(() => resolve({ state: "pending" }), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The rejection's message, for asserting on WHICH bound fired. */
export function settlementMessage(settlement: Settlement): string {
  if (settlement.state !== "rejected") return "";
  return settlement.error instanceof Error ? settlement.error.message : String(settlement.error);
}
