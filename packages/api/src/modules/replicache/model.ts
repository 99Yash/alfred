import { t } from "elysia";

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
  export type PullCookie = {
    order: number;
    clientGroupID: string;
  };

  /**
   * Body schema for `/replicache/pull`. `cookie` is typed as `t.Unknown`
   * (rather than `t.Nullable(...)`) because `t.Nullable` desugars to
   * `t.Union([schema, t.Null()])` and Elysia 1.4's `exact-mirror`
   * validator logs a noisy "[exact-mirror] TypeBox's TypeCompiler is
   * required to use Union" warning on every route compile. The handler
   * does the (cheap) shape narrow at the top of `executePull` — see
   * `narrowPullCookie` in `pull.ts`. Replicache sends either `null` on
   * cold start or a `{ order, clientGroupID }` object thereafter; we
   * tolerate any other shape by treating it as cold-sync.
   */
  export const pull = t.Object({
    pullVersion: t.Literal(1),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
    cookie: t.Unknown(),
    profileID: t.Optional(t.String({ maxLength: 200 })),
    schemaVersion: t.Optional(t.String({ maxLength: 50 })),
  });
  export type Pull = typeof pull.static;

  export const pushMutation = t.Object({
    id: t.Integer({ minimum: 0 }),
    clientID: t.String({ minLength: 1, maxLength: 200 }),
    name: t.String({ minLength: 1, maxLength: 100 }),
    args: t.Unknown(),
    // DOMHighResTimeStamp from the client — fractional millisecond, NOT an integer.
    // Was `t.Integer` originally; that silently rejected every push with status 400
    // until this commit. Pull schema didn't have a timestamp so /notes pushes
    // happened to round to integers in some browsers and "looked" fine in passing.
    timestamp: t.Number({ minimum: 0 }),
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
