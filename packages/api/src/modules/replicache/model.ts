import { t } from 'elysia';

export namespace ReplicacheModel {
  /** Per-request mutation cap. Batches over this are rejected with 413. */
  export const MAX_MUTATIONS = 100;

  /**
   * TypeBox cap — returns 422 before the handler runs. Sized well above
   * the soft cap so legitimate clients never hit it.
   */
  export const HARD_MUTATION_LIMIT = 1000;

  /**
   * Cookie identifies the client's previous CVR snapshot. Embeds
   * `clientGroupID` so a stale cookie from a different group is detected
   * and treated as a cold sync rather than silently missing the CVR cache.
   */
  export const pullCookie = t.Object({
    order: t.Integer({ minimum: 0 }),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
  });
  export type PullCookie = typeof pullCookie.static;

  export const pull = t.Object({
    pullVersion: t.Literal(1),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
    cookie: t.Nullable(pullCookie),
    profileID: t.Optional(t.String({ maxLength: 200 })),
    schemaVersion: t.Optional(t.String({ maxLength: 50 })),
  });
  export type Pull = typeof pull.static;

  export const pushMutation = t.Object({
    id: t.Integer({ minimum: 0 }),
    clientID: t.String({ minLength: 1, maxLength: 200 }),
    name: t.String({ minLength: 1, maxLength: 100 }),
    args: t.Unknown(),
    timestamp: t.Integer({ minimum: 0 }),
  });
  export type PushMutation = typeof pushMutation.static;

  export const push = t.Object({
    pushVersion: t.Literal(1),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
    mutations: t.Array(pushMutation, { maxItems: HARD_MUTATION_LIMIT }),
    profileID: t.Optional(t.String({ maxLength: 200 })),
    schemaVersion: t.Optional(t.String({ maxLength: 50 })),
  });
  export type Push = typeof push.static;
}
