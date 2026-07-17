/**
 * Authz surface for the Replicache sync engine.
 *
 * Alfred is single-user, so there are no asset memberships or roles to check.
 * Authorization is enforced structurally:
 *   - Read (pull): notes are queried WHERE user_id = userId — no row leaks.
 *   - Write (push): server mutators use ctx.userId for all inserts/updates,
 *     and the clientGroup → userId binding in push.ts ensures a client can
 *     only push for its own user.
 *
 * This module exists so the pattern is familiar if multi-user is added later,
 * and to provide the MutatorForbiddenError type that push.ts catches.
 */

export class MutatorForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutatorForbiddenError";
  }
}
