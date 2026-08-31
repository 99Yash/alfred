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

/**
 * Postgres `integer` upper bound. `replicache_client_group.cvr_version` is an
 * `integer` column; accepting `2147483647` as a cookie `order` would let a
 * malformed cookie turn a cold-sync fallback into a DB range error on
 * `prevVersion + 1`. One below max is the highest order we store.
 */
export const POSTGRES_INTEGER_MAX = 2_147_483_647;
export const MAX_ACCEPTED_COOKIE_ORDER = POSTGRES_INTEGER_MAX - 1;
