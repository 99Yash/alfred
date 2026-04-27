import { db } from '@alfred/db';
import * as schema from '@alfred/db/schema/auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { z } from 'zod';

const sessionEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

let _sessionAuth: ReturnType<typeof _createSessionAuth> | undefined;

function _createSessionAuth(env: { BETTER_AUTH_URL: string; CORS_ORIGIN: string; NODE_ENV: string }) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db(), { provider: 'pg', schema }),
    trustedOrigins: [env.CORS_ORIGIN],
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        httpOnly: true,
      },
    },
  });
}

export function sessionAuth() {
  if (_sessionAuth) return _sessionAuth;
  const env = sessionEnvSchema.parse(process.env);
  _sessionAuth = _createSessionAuth(env);
  return _sessionAuth;
}
