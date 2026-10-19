import { Errors, isIanaTimezone } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import { settings } from "@alfred/assistant/settings";

/** Onboarding state. `routeToOnboarding` comes from `user.onboarded_at`; the client gates on it. */
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

        if (!row) throw Errors.NotFoundError("User not found");

        return {
          routeToOnboarding: row.onboardedAt === null,
          onboardedAt: row.onboardedAt?.toISOString() ?? null,
        };
      })
      .post(
        "/complete",
        async ({ user: u, body }) => {
          const row = await db().transaction(async (tx) => {
            const rows = await tx
              .update(user)
              .set({ onboardedAt: sql`coalesce(${user.onboardedAt}, now())` })
              .where(eq(user.id, u.id))
              .returning({ onboardedAt: user.onboardedAt });

            const updated = rows[0];

            if (!updated) throw Errors.NotFoundError("User not found");

            // Take the browser zone so dates do not default to UTC. Never overwrite a chosen zone.
            const tz = body?.timezone;

            if (tz && isIanaTimezone(tz)) {
              await settings({ userId: u.id, exec: tx }).setIfUnset("timezone", tz);
            }

            return updated;
          });

          return {
            routeToOnboarding: false,
            onboardedAt: row.onboardedAt?.toISOString() ?? null,
          };
        },
        { body: t.Optional(t.Object({ timezone: t.Optional(t.String()) })) },
      ),
  );
