import { t } from "elysia";
import { z } from "zod";
import {
  HARD_MUTATION_LIMIT as SYNC_HARD_LIMIT,
  MAX_MUTATIONS as SYNC_MAX_MUTATIONS,
  MAX_ACCEPTED_COOKIE_ORDER,
} from "./constants";

export namespace ReplicacheModel {
  export const MAX_MUTATIONS = SYNC_MAX_MUTATIONS;
  export const HARD_MUTATION_LIMIT = SYNC_HARD_LIMIT;

  /** Points at the client's last CVR. A cookie from another client group means a cold sync. */
  export const pullCookieSchema = z.object({
    order: z.number().int().min(0).max(MAX_ACCEPTED_COOKIE_ORDER).refine(Number.isSafeInteger),
    clientGroupID: z.string().min(1),
  });
  export type PullCookie = z.infer<typeof pullCookieSchema>;

  /**
   * `cookie` is `t.Unknown`, not `t.Nullable`: Elysia's exact-mirror warns on a Union.
   * `narrowPullCookie` in `pull.ts` treats any bad shape as a cold sync.
   */
  export const pull = t.Object({
    pullVersion: t.Literal(1),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
    cookie: t.Unknown(),
    profileID: t.Optional(t.String({ maxLength: 200 })),
    schemaVersion: t.Optional(t.String({ maxLength: 50 })),
  });
  export type Pull = typeof pull.static;

  const pushMutation = t.Object({
    id: t.Integer({ minimum: 0 }),
    clientID: t.String({ minLength: 1, maxLength: 200 }),
    name: t.String({ minLength: 1, maxLength: 100 }),
    args: t.Unknown(),
    // A DOMHighResTimeStamp: fractional, so `t.Integer` rejects real pushes.
    timestamp: t.Number({ minimum: 0 }),
  });

  export const push = t.Object({
    pushVersion: t.Literal(1),
    clientGroupID: t.String({ minLength: 1, maxLength: 200 }),
    mutations: t.Array(pushMutation, { maxItems: HARD_MUTATION_LIMIT }),
    profileID: t.Optional(t.String({ maxLength: 200 })),
    schemaVersion: t.Optional(t.String({ maxLength: 50 })),
  });
  export type Push = typeof push.static;
}
