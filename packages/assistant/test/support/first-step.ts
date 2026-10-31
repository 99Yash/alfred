import type { DispatchStepLease } from "@alfred/assistant/tool-runtime";

/**
 * The step fields of a fresh run's first attempt: fence generation 0 and executor attempt 0, the
 * Postgres defaults. A dispatch fixture spreads it, so a new lease field changes one place.
 */
export const FIRST_STEP = {
  fence: { generation: 0 },
  attempt: 0,
} as const satisfies Omit<DispatchStepLease, "runId">;
