import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Comma-separated allowlist of emails permitted to sign up. A single email
  // is still valid (one-item list). Parsed into a normalized, lowercased
  // array; the auth signup hook checks membership. See packages/auth.
  ALFRED_ALLOWED_EMAIL: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().email()).min(1)),
  RESEND_API_KEY: z.string(),
  RESEND_FROM_EMAIL: z.string(),
  ANTHROPIC_API_KEY: z.string(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string(),
  OPENAI_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  POSTHOG_API_KEY: z.string().optional(),
  // Required: Better Auth Google sign-in uses these. The integration OAuth
  // flow (Gmail/Calendar scope grants) reuses the same client; that callback
  // URL lives in GOOGLE_OAUTH_REDIRECT_URI. Better Auth builds its own
  // callback URL automatically from BETTER_AUTH_URL.
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  /** Pub/Sub topic Gmail watch should publish to, e.g. `projects/<id>/topics/gmail-push`. */
  GOOGLE_PUBSUB_TOPIC: z.string().optional(),
  /** OIDC audience configured on the push subscription. Skip OIDC verification when blank. */
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  /** Service-account email expected as the `email` claim in the OIDC token. Optional defense-in-depth. */
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  /**
   * GitHub App credentials (ADR-0052). The App replaces the classic OAuth
   * App: identity comes from its user-to-server OAuth (CLIENT_ID/SECRET),
   * REST access from short-lived installation tokens minted with APP_ID +
   * PRIVATE_KEY, and activity webhooks are verified with WEBHOOK_SECRET.
   */
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  /** PEM private key. Railway stores newlines as literal `\n`; callers un-escape. */
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  /** Shared secret GitHub signs webhook bodies with (`x-hub-signature-256`). */
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  /** User-to-server OAuth callback, e.g. `https://api.alfred.beauty/api/integrations/github/callback`. */
  GITHUB_APP_REDIRECT_URI: z.string().url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let _serverEnv: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (_serverEnv) return _serverEnv;
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing or invalid environment variables:\n${formatted}`);
  }
  _serverEnv = result.data;
  return _serverEnv;
}
