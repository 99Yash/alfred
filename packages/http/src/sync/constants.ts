/** The only home for Replicache sync limits. */

/** A push over this gets a 413. */
export const MAX_MUTATIONS = 100;

/** The schema cap: a 400 before the handler runs. Far above the soft cap. */
export const HARD_MUTATION_LIMIT = 1000;

/** `cvr_version` is an `integer`. Pull adds 1 to the cookie order, so accept one below the max. */
export const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const MAX_ACCEPTED_COOKIE_ORDER = POSTGRES_INTEGER_MAX - 1;
