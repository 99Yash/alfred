import { Errors } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user, type User } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { getSessionCached } from "./session-cache";

/**
 * The one read of `user.onboarded_at`. `undefined` when the user row is missing; each caller
 * decides what a miss means (the OAuth callbacks redirect quietly, so do not throw here).
 */
export async function readOnboarding(
  userId: string,
): Promise<Pick<User, "onboardedAt"> | undefined> {
  const rows = await db()
    .select({ onboardedAt: user.onboardedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return rows[0];
}

export const requireOnboarded = new Elysia({
  name: "require-onboarded-macro",
  normalize: "typebox",
}).macro("requireOnboarded", {
  async resolve({ request }) {
    const session = await getSessionCached(request);

    if (!session) throw Errors.UnauthorizedError();

    const row = await readOnboarding(session.user.id);

    if (!row) throw Errors.NotFoundError("User not found");

    if (row.onboardedAt === null) throw Errors.ForbiddenError("Onboarding required");
  },
});
