import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import * as schema from "@alfred/db/schema/auth";
import { serverEnv } from "@alfred/env/server";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authCookiePolicy } from "./cookie-policy";
import { encryptedAuthAdapter } from "./credential-adapter";
import { getOnUserCreatedHooks } from "./hooks";
import { authIpAddress, authRateLimit } from "./rate-limit";
import { authSessionPolicy } from "./session-policy";

export { registerOnUserCreated, type OnUserCreatedHook } from "./hooks";

let _auth: ReturnType<typeof betterAuth<BetterAuthOptions>> | undefined;

export function auth() {
  if (_auth) return _auth;
  const env = serverEnv();

  const sessionPolicy = authSessionPolicy({
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // The env parse already lowercases the allowlist.
            const allowedEmails = serverEnv().ALFRED_ALLOWED_EMAIL;

            if (!allowedEmails.includes(user.email.toLowerCase())) {
              throw new Error("Signup not permitted for this email address");
            }

            if (!user.name) {
              // No provider name: use the email local part, capitalized.
              const prefix = user.email.split("@")[0] || "Alfred";
              const titled = prefix.charAt(0).toUpperCase() + prefix.slice(1);

              return { data: { ...user, name: titled } };
            }
          },
          // A failed hook is logged, so it cannot fail the signup.
          after: async (user) => {
            for (const hook of getOnUserCreatedHooks()) {
              try {
                await hook({ id: user.id, email: user.email });
              } catch (err) {
                console.error("[auth] onUserCreated hook failed", {
                  userId: user.id,
                  error: toMessage(err),
                });
              }
            }
          },
        },
      },
    },
  });

  _auth = betterAuth<BetterAuthOptions>({
    // Encrypts `account` OAuth tokens at rest. Do not add a second Better Auth config that skips it.
    database: encryptedAuthAdapter(
      drizzleAdapter(db(), {
        provider: "pg",
        schema,
      }),
    ),
    trustedOrigins: [env.CORS_ORIGIN],
    // Read `rate-limit.ts` before adding `customRules`: one replaces the stricter sign-in rule.
    rateLimit: authRateLimit(env.NODE_ENV),
    // From about day 24 to day 30 the cap can cause one write per request. Accepted for one user.
    ...sessionPolicy,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        // Without this, the user name falls back to the email local part.
        mapProfileToUser: (profile) => ({
          name: profile.name,
          image: profile.picture,
        }),
      },
    },
    // No `accountLinking` block. Better Auth 1.6.11+ fixes CVE-2026-53516 by default.
    // Not `disableImplicitLinking`: with Google as the only sign-in it does nothing,
    // and it would block linking a future second provider.
    advanced: {
      // Which forwarded hop is the client, for the rate-limit key.
      ipAddress: authIpAddress(),
      ...authCookiePolicy(env.NODE_ENV),
    },
  });

  return _auth;
}
