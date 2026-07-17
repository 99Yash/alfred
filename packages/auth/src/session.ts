import { db } from "@alfred/db";
import * as schema from "@alfred/db/schema/auth";
import { serverEnv } from "@alfred/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

let _sessionAuth: ReturnType<typeof _createSessionAuth> | undefined;

function _createSessionAuth(env: {
  BETTER_AUTH_URL: string;
  CORS_ORIGIN: string;
  NODE_ENV: string;
}) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db(), { provider: "pg", schema }),
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
