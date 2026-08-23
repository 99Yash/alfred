/**
 * Sync module constants — caps and limits for Replicache pull/push.
 *
 * This file is the single owner for hard coded sync limits. Logic files
 * import from here; never hard code a mutation cap inline.
 */

/** Per-request mutation cap. Batches over this are rejected with 413. */
export const MAX_MUTATIONS = 100;

/**
 * TypeBox cap — returns 422 before the handler runs. Sized well above
 * the soft cap so legitimate clients never hit it.
 */
export const HARD_MUTATION_LIMIT = 1000;
