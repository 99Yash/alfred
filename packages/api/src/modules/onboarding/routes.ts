import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";
import { Elysia, status } from "elysia";
import { authMacro } from "../../middleware/auth";

/**
 * Onboarding state routes.
 *
 *   GET  /api/me/onboarding   → { routeToOnboarding: boolean, onboardedAt: string | null }
 *   POST /api/me/onboarding/complete → marks onboarding done (idempotent)
 *
 * `routeToOnboarding` is server-truth: derived from `user.onboarded_at`.
 * The client reads it on boot and gates `/onboarding` access — both the
 * "redirect new users in" and "kick existing users out" directions.
 */
export const onboardingRoutes = new Elysia({ prefix: "/api/me/onboarding" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/", async ({ user: u }) => {
        const rows = await db()
          .select({ onboardedAt: user.onboardedAt })
          .from(user)
          .where(eq(user.id, u.id))
          .limit(1);
        const row = rows[0];
        if (!row) return status(404, { message: "User not found" });
        return {
          routeToOnboarding: row.onboardedAt === null,
          onboardedAt: row.onboardedAt?.toISOString() ?? null,
        };
      })
      .post("/complete", async ({ user: u }) => {
        const rows = await db()
          .update(user)
          .set({ onboardedAt: sql`coalesce(${user.onboardedAt}, now())` })
          .where(eq(user.id, u.id))
          .returning({ onboardedAt: user.onboardedAt });
        const row = rows[0];
        if (!row) return status(404, { message: "User not found" });
        return {
          routeToOnboarding: false,
          onboardedAt: row.onboardedAt?.toISOString() ?? null,
        };
      }),
  );
