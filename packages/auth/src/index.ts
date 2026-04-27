import { db } from '@alfred/db';
import * as schema from '@alfred/db/schema/auth';
import { serverEnv } from '@alfred/env/server';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Resend } from 'resend';

let _auth: ReturnType<typeof betterAuth<BetterAuthOptions>> | undefined;

const OTP_EMAIL_TIMEOUT_MS = 30_000;

export function auth() {
  if (_auth) return _auth;
  const env = serverEnv();
  const resend = new Resend(env.RESEND_API_KEY);

  _auth = betterAuth<BetterAuthOptions>({
    database: drizzleAdapter(db(), {
      provider: 'pg',
      schema,
    }),
    trustedOrigins: [env.CORS_ORIGIN],
    plugins: [
      emailOTP({
        sendVerificationOTP: async ({ email, otp, type }) => {
          const safeOtp = String(otp).replace(/[^0-9]/g, '');
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              resend.emails.send({
                from: env.RESEND_FROM_EMAIL,
                to: email,
                subject: type === 'sign-in' ? 'Your Alfred sign-in code' : 'Verify your Alfred account',
                html: `<p>Your code is: <strong>${safeOtp}</strong></p><p>Expires in 10 minutes.</p>`,
                text: `Your Alfred code: ${safeOtp}\n\nExpires in 10 minutes.`,
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`OTP email timed out after ${OTP_EMAIL_TIMEOUT_MS}ms`)),
                  OTP_EMAIL_TIMEOUT_MS,
                );
              }),
            ]);
          } catch (error) {
            console.error('[auth] Failed to send OTP', { type, error: error instanceof Error ? error.message : String(error) });
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const allowedEmail = serverEnv().ALFRED_ALLOWED_EMAIL.toLowerCase();
            if (user.email.toLowerCase() !== allowedEmail) {
              throw new Error('Signup not permitted for this email address');
            }
            if (!user.name) {
              const prefix = user.email.split('@')[0] ?? 'Alfred';
              return { data: { ...user, name: prefix } };
            }
          },
        },
      },
    },
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        httpOnly: true,
      },
    },
  });
  return _auth;
}
