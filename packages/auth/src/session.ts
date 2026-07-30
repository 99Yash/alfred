import { db } from "@alfred/db";
import * as schema from "@alfred/db/schema/auth";
import { serverEnv } from "@alfred/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { encryptedAuthAdapter } from "./credential-adapter";

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
    // No `socialProviders` here, so no OAuth callback runs through this
    // instance and the `accountLinking` policy `auth()` sets has nothing to
    // apply to. Declare a provider here and you must copy that policy too.
    trustedOrigins: [env.CORS_ORIGIN],
    advanced: {
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
