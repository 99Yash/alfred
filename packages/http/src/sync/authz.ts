/**
 * Sync authz is structural: reads filter by `user_id`, writes use the bound user.
 * `push.ts` catches this error.
 */

export class MutatorForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutatorForbiddenError";
  }
}
