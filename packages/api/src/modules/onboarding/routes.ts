import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { NotFoundError } from "../../middleware/errors";
import { isValidTimezone } from "../briefing/preferences";
import { getPreference, setPreference } from "../memory/preferences";

/**
 * Onboarding state routes.
 *
 *   GET  /api/me/onboarding   → { routeToOnboarding: boolean, onboardedAt: string | null }
 *   POST /api/me/onboarding/complete → marks onboarding done (idempotent);
 *        optionally captures the browser timezone (#229)
 *
 * `routeToOnboarding` is server-truth: derived from `user.onboarded_at`.
 * The client reads it on boot and gates `/onboarding` access — both the
 * "redirect new users in" and "kick existing users out" directions.
 */
export const onboardingRoutes = new Elysia({ prefix: "/api/me/onboarding", normalize: "typebox" })
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
        if (!row) throw new NotFoundError("User not found");
        return {
          routeToOnboarding: row.onboardedAt === null,
          onboardedAt: row.onboardedAt?.toISOString() ?? null,
        };
      })
      .post(
        "/complete",
        async ({ user: u, body }) => {
          const rows = await db()
            .update(user)
            .set({ onboardedAt: sql`coalesce(${user.onboardedAt}, now())` })
            .where(eq(user.id, u.id))
            .returning({ onboardedAt: user.onboardedAt });
          const row = rows[0];
          if (!row) throw new NotFoundError("User not found");

          // #229: infer the user's zone from the browser at onboarding so chat
          // date grounding + briefing delivery don't silently default to UTC.
          // Write the canonical `timezone` key ONLY if unset — never clobber a
          // zone the user already chose (idempotent re-finish stays safe).
          const tz = body?.timezone;
          if (tz && isValidTimezone(tz)) {
            const existing = await getPreference(u.id, "timezone");
            if (existing === null) {
              await setPreference({ userId: u.id, key: "timezone", value: tz });
            }
          }

          return {
            routeToOnboarding: false,
            onboardedAt: row.onboardedAt?.toISOString() ?? null,
          };
        },
        { body: t.Optional(t.Object({ timezone: t.Optional(t.String()) })) },
      ),
  );
