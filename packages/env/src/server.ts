import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ALFRED_ALLOWED_EMAIL: z.string().email(),
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
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  /** Pub/Sub topic Gmail watch should publish to, e.g. `projects/<id>/topics/gmail-push`. */
  GOOGLE_PUBSUB_TOPIC: z.string().optional(),
  /** OIDC audience configured on the push subscription. Skip OIDC verification when blank. */
  GOOGLE_PUBSUB_AUDIENCE: z.string().optional(),
  /** Service-account email expected as the `email` claim in the OIDC token. Optional defense-in-depth. */
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: z.string().optional(),
  /**
   * Classic GitHub OAuth App credentials. Optional so the server boots
   * before an app is created; `getGithubOAuthConfig()` throws with a
   * descriptive error when the integration routes try to use them
   * without configuration.
   */
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITHUB_OAUTH_REDIRECT_URI: z.string().url().optional(),
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
