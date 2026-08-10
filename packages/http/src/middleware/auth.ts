import { Errors } from "@alfred/contracts";
import { Elysia } from "elysia";
import { getSessionCached } from "./session-cache";

export const authMacro = new Elysia({ name: "auth-macro", normalize: "typebox" }).macro("auth", {
  async resolve({ request }) {
    const session = await getSessionCached(request);
    if (!session) throw Errors.UnauthorizedError();
    return { user: session.user };
  },
});
