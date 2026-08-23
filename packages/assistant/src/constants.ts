/**
 * Assistant module constants — cost, rate limits, and caps.
 *
 * This file is the single owner for hard coded assistant limits that are
 * not cross-seam (cross-seam values belong in `@alfred/contracts`). Logic
 * files import from here; never hard code a rate limit inline.
 *
 * For provider batch limits and pricing, see `packages/ai/src/constants.ts`.
 * For sync caps, see `packages/http/src/sync/constants.ts`.
 */

/**
 * Max raw passthrough calls that may execute within one agent run before the
 * ceiling fires (ADR-0074). Re-exported by the owning module for boundary
 * compatibility.
 */
export const PASSTHROUGH_PER_RUN_CEILING = 15;

/**
 * Wait-ceiling for the sub-agent join (ADR-0073). Re-exported by the owning
 * module for boundary compatibility.
 */
export const AWAIT_SUB_AGENT_CEILING_MS = 6 * 60_000;

/**
 * Default delay between staging a gated action and sending the user a
 * fallback approval email (5 min). Re-exported by the owning module for
 * boundary compatibility.
 */
export const DEFAULT_APPROVAL_NOTIFY_DELAY_MS = 5 * 60 * 1000;
