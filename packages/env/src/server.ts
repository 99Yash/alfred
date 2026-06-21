import { z } from "zod";

/**
 * Optional secret that tolerates an empty string in `.env`. A blank
 * `FOO=` line yields `""` (defined), which would fail a bare
 * `.min(1).optional()` and break boot — so we coerce empty/whitespace to
 * `undefined` first. Used for integrations that may be half-configured
 * (Notion/Vercel) without bouncing the whole server.
 */
const optionalSecret = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(1).optional(),
  );

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** HTTP port the server binds to. Railway injects this; defaults to 3001 locally. */
  PORT: z.coerce.number().int().positive().default(3001),
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
  // Required secrets: `.min(1)` so a blank `FOO=` line fails fast at boot
  // instead of constructing an empty-key client that errors mid-request. Not
  // `.email()` on RESEND_FROM_EMAIL — the display-name form
  // `Alfred <noreply@example.com>` is valid and `.email()` would reject it.
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  /**
   * Opt-in capture of prompt/completion text on Langfuse spans (#215).
   * Off by default: the metering layer records usage/cost/latency but NOT
   * the full I/O, so prod stays lean and prompt content (which may carry
   * user PII) never leaves the box. Set `LANGFUSE_CAPTURE_IO=true` on a
   * self-hosted instance to populate the Input/Output columns for debugging.
   */
  LANGFUSE_CAPTURE_IO: z
    .string()
    .optional()
    .transform((s) => s === "true"),
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
  /**
   * Notion public OAuth integration (https://www.notion.so/my-integrations).
   * Optional so the server still boots before the integration is registered;
   * the connect route throws a clean 503 when these are absent. Notion access
   * tokens are long-lived (no refresh), so there is no refresh secret here.
   */
  NOTION_OAUTH_CLIENT_ID: optionalSecret(),
  NOTION_OAUTH_CLIENT_SECRET: optionalSecret(),
  NOTION_OAUTH_REDIRECT_URI: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  /**
   * Vercel integration (https://vercel.com/dashboard → Integrations → Develop).
   * `VERCEL_APP_SLUG` is the integration's slug used to build the install URL
   * (`https://vercel.com/integrations/<slug>/new`). Optional for the same
   * boot-before-setup reason as Notion; Vercel access tokens don't expire.
   */
  VERCEL_CLIENT_ID: optionalSecret(),
  VERCEL_CLIENT_SECRET: optionalSecret(),
  VERCEL_REDIRECT_URI: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  VERCEL_APP_SLUG: optionalSecret(),
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
