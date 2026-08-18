import { db } from "@alfred/db";
import * as schema from "@alfred/db/schema/auth";
import { serverEnv } from "@alfred/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { encryptedAuthAdapter } from "./credential-adapter";
import { authIpAddress, authRateLimit } from "./rate-limit";
import { authSecureCookies, authSession } from "./session-policy";

let _sessionAuth: ReturnType<typeof _createSessionAuth> | undefined;

function _createSessionAuth(env: {
  BETTER_AUTH_URL: string;
  CORS_ORIGIN: string;
  NODE_ENV: string;
}) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    // Same boundary as `auth()` — see the note there.
    database: encryptedAuthAdapter(drizzleAdapter(db(), { provider: "pg", schema })),
    // No `socialProviders` here, so no OAuth callback and no account linking
    // runs through this instance. Declare a provider here and this becomes a
    // second linking surface: re-read the `accountLinking` reasoning in
    // `index.ts` before doing it, because the reason Alfred sets no policy is
    // that it has exactly one sign-in path.
    trustedOrigins: [env.CORS_ORIGIN],
    // Same limit, same Redis buckets, as `auth()` — see `rate-limit.ts`.
    rateLimit: authRateLimit(env.NODE_ENV),
    // Same lifetime as `auth()` — see `session-policy.ts`. This instance reads
    // the same `session` rows, so a longer window here would be a longer window
    // everywhere.
    session: authSession(),
    advanced: {
      ipAddress: authIpAddress(),
      // Must match `auth()`. This instance passes a `baseURL` and `auth()` does
      // not, so without this option the two derive the `__Secure-` cookie name
      // prefix from different inputs and can look for different cookie names.
      useSecureCookies: authSecureCookies(env.NODE_ENV),
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        httpOnly: true,
      },
    },
  });
}

export function sessionAuth() {
  if (_sessionAuth) return _sessionAuth;
  _sessionAuth = _createSessionAuth(serverEnv());
  return _sessionAuth;
}
