import { Errors } from "@alfred/contracts";
import { type Context, Elysia } from "elysia";
import { getSessionCached } from "./session-cache";

/**
 * The session gate. It runs in `transform`, which Elysia runs before validation. So an anonymous
 * caller gets 401, not the schema messages of the route (#1877). `getSessionCached` memoizes per
 * request, so `resolveAuthUser` below reads the same session at no cost.
 */
export async function requireAuthSession({ request }: Pick<Context, "request">): Promise<void> {
  if (!(await getSessionCached(request))) throw Errors.UnauthorizedError();
}

/** Gives the handler `user`. Runs after validation; `requireAuthSession` already refused anonymous. */
export async function resolveAuthUser({ request }: Pick<Context, "request">) {
  const session = await getSessionCached(request);

  if (!session) throw Errors.UnauthorizedError();

  return { user: session.user };
}

/**
 * `{ auth: true }` puts both hooks on a route. The boot route inventory
 * (`assertRouteAuthInventory`) finds a guarded route by these two function identities.
 */
export const authMacro = new Elysia({ name: "auth-macro", normalize: "typebox" }).macro("auth", {
  transform: requireAuthSession,
  resolve: resolveAuthUser,
});
