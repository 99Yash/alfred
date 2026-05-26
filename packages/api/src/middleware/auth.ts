import { Elysia } from "elysia";
import { getSessionCached } from "./session-cache.js";

export const authMacro = new Elysia({ name: "auth-macro", normalize: "typebox" }).macro("auth", {
  async resolve({ status, request }) {
    const session = await getSessionCached(request);
    if (!session) return status(401);
    return { user: session.user };
  },
});
