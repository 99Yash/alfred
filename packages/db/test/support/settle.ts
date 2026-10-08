/**
 * Turns "still pending after the deadline" into a value a test can assert on.
 * `assert.rejects` on a command that never settles just times out with no diagnosis.
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

/** The rejection message, to check which bound fired. */
export function settlementMessage(settlement: Settlement): string {
  if (settlement.state !== "rejected") return "";

  return settlement.error instanceof Error ? settlement.error.message : String(settlement.error);
}
