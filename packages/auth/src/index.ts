import { db } from "@alfred/db";
import * as schema from "@alfred/db/schema/auth";
import { serverEnv } from "@alfred/env/server";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getOnUserCreatedHooks } from "./hooks";

export { registerOnUserCreated, type OnUserCreatedHook } from "./hooks";

let _auth: ReturnType<typeof betterAuth<BetterAuthOptions>> | undefined;

export function auth() {
  if (_auth) return _auth;
  const env = serverEnv();

  _auth = betterAuth<BetterAuthOptions>({
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema,
    }),
    trustedOrigins: [env.CORS_ORIGIN],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const allowedEmail = serverEnv().ALFRED_ALLOWED_EMAIL.toLowerCase();
            if (user.email.toLowerCase() !== allowedEmail) {
              throw new Error("Signup not permitted for this email address");
            }
            if (!user.name) {
              const prefix = user.email.split("@")[0] ?? "Alfred";
              return { data: { ...user, name: prefix } };
            }
          },
          // Fan out post-signup work to whatever the server bootstrap
          // registered via `registerOnUserCreated`. Each hook runs in
          // sequence; failures log + continue so one broken downstream
          // subsystem can't bounce a legitimate signup.
          after: async (user) => {
            for (const hook of getOnUserCreatedHooks()) {
              try {
                await hook({ id: user.id, email: user.email });
              } catch (err) {
                console.error("[auth] onUserCreated hook failed", {
                  userId: user.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          },
        },
      },
    },
    advanced: {
      defaultCookieAttributes: {
        // Web and server live on different *.up.railway.app subdomains, which
        // sit under a Public Suffix List entry — browsers treat them as
        // cross-site. Lax cookies are stripped on the cross-site fetches the
        // web app makes, so the session cookie never reaches the API after
        // sign-in. None+Secure is required for prod; local dev stays Lax.
        sameSite: env.NODE_ENV === "production" ? "none" : "lax",
        secure: env.NODE_ENV === "production",
        httpOnly: true,
      },
    },
  });
  return _auth;
}
