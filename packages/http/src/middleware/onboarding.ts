import { Errors } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { getSessionCached } from "./session-cache";

export const requireOnboarded = new Elysia({
  name: "require-onboarded-macro",
  normalize: "typebox",
}).macro("requireOnboarded", {
  async resolve({ request }) {
    const session = await getSessionCached(request);
    if (!session) throw Errors.UnauthorizedError();

    const rows = await db()
      .select({ onboardedAt: user.onboardedAt })
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1);
    const row = rows[0];
    if (!row) throw Errors.NotFoundError("User not found");
    if (row.onboardedAt === null) throw Errors.ForbiddenError("Onboarding required");
  },
});
