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

const optionalBooleanString = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  );

// Long secrets (currently only `ENTITY_ID_NAMESPACE`). Blank/whitespace-only
// coerces to `undefined` (optional, may be half-configured); a non-blank value
// must have NO surrounding whitespace — a stray space in a quoted `.env` line
// would otherwise survive validation and silently change the HMAC keyed off it
// (for ENTITY_ID_NAMESPACE that remints every content-addressed entity id).
// Fail loud at boot rather than normalize behind the operator's back.
const optionalLongSecret = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .min(32)
      .refine((v) => v === v.trim(), {
        error: "must not have leading or trailing whitespace",
      })
      .optional(),
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
  /**
   * HMAC namespace for ADR-0067 stable entity IDs. Optional during P0 because no
   * projection writer computes IDs yet; P1 must require it before writing
   * `entity_nodes.id`, and it must be backed up like an auth secret because
   * changing it remints every content-addressed entity id on replay.
   */
  ENTITY_ID_NAMESPACE: optionalLongSecret(),
  SENTRY_DSN: z.string().optional(),
  /**
   * Opt-in Sentry capture when `NODE_ENV !== "production"`. Off by default:
   * with a DSN in a local `.env`, every mid-edit crash and hot-reload
   * artifact ships to Sentry as `environment: development` and drowns the
   * handful of real prod signals. Set `SENTRY_ENABLE_DEV=true` to capture
   * from a dev box on purpose (prod always captures when a DSN is set).
   */
  SENTRY_ENABLE_DEV: z
    .string()
    .optional()
    .transform((s) => s === "true"),
  /**
   * Optional explicit Sentry release override. Normally left UNSET: the SDK
   * auto-detects the release from Railway's `RAILWAY_GIT_COMMIT_SHA` (the commit
   * SHA prod issues already carry), and the build-time `sentry-cli` step
   * (apps/server/scripts/sentry-release.mjs) reads the same var, so source maps
   * and commit association line up without any config. Set this only to pin the
   * release to a specific value on both build and runtime.
   */
  SENTRY_RELEASE: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
  /**
   * Langfuse tracing environment slug (#226 review). `NODE_ENV` only
   * separates development|production|test, but every deploy target (staging,
   * preview, prod) runs with `NODE_ENV=production`, so it can't keep their
   * traces apart. Set this per deploy target (e.g. `staging`, `preview`,
   * `production`) to slice the Langfuse Environments view; falls back to
   * `NODE_ENV` when unset. Lowercase, no leading `langfuse` (Langfuse's own
   * reserved-prefix rule).
   */
  LANGFUSE_TRACING_ENVIRONMENT: z
    .string()
    .max(40)
    .regex(
      /^(?!langfuse)[a-z0-9-_]+$/,
      "must be lowercase [a-z0-9-_], max 40 chars, and not start with 'langfuse' (Langfuse Environments rule)",
    )
    .optional(),
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
  GOOGLE_PUBSUB_TOPIC: optionalSecret(),
  /** OIDC audience configured on the push subscription. Required in production. */
  GOOGLE_PUBSUB_AUDIENCE: optionalSecret(),
  /** Service-account email expected as the `email` claim in the OIDC token. Required in production. */
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: optionalSecret(),
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
  /**
   * Object storage for chat file uploads (ADR-0065). Backed by **Cloudflare R2**
   * (S3-compatible) via `files-sdk`'s `s3` adapter. Create an R2 bucket + an R2
   * API token, then set on the server service:
   *   CHAT_S3_BUCKET            = <bucket name>
   *   CHAT_S3_REGION            = auto
   *   CHAT_S3_ENDPOINT          = https://<accountid>.r2.cloudflarestorage.com
   *   CHAT_S3_ACCESS_KEY_ID     = <R2 token Access Key ID>
   *   CHAT_S3_SECRET_ACCESS_KEY = <R2 token Secret Access Key>
   * All optional so the server boots before storage is provisioned; the upload
   * route throws a clean 503 when unset (mirrors the OPENAI_API_KEY gate). R2
   * serves virtual-hosted URLs on the account endpoint, so leave
   * `CHAT_S3_FORCE_PATH_STYLE` unset (false). R2 buckets are private with no
   * public CDN, so leave `CHAT_S3_PUBLIC_BASE_URL` unset (reads use presigned
   * GETs); it exists only for a future R2 custom-domain / CDN front.
   */
  CHAT_S3_BUCKET: optionalSecret(),
  CHAT_S3_REGION: optionalSecret(),
  CHAT_S3_ENDPOINT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  CHAT_S3_ACCESS_KEY_ID: optionalSecret(),
  CHAT_S3_SECRET_ACCESS_KEY: optionalSecret(),
  CHAT_S3_PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  CHAT_S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((s) => s === "true"),
  /**
   * Opt-in gate for the chat→memory idle capture worker (#398). Disabled by
   * default because the current slice only extracts propositions; durable
   * observation writes/review land in the follow-up slices. Enable deliberately
   * when exercising the pipeline end-to-end in a controlled environment.
   */
  CHAT_MEMORY_CAPTURE_ENABLED: optionalBooleanString(),
  /**
   * Gate for Gmail *mailbox mutations* — triage label writes and watch
   * install/renew/stop (#278). Dev and prod connect to the same real Gmail
   * account; if a non-prod instance writes labels or (un)installs the watch it
   * fights prod over the shared mailbox (each environment strips the other's
   * Alfred labels). Tri-state: unset → default (on in `production`, off
   * otherwise); `"true"`/`"false"` → explicit opt-in/out so a developer can
   * deliberately enable writes locally. DB-only classify is unaffected — only
   * the outbound Gmail mutations are gated. Resolve via
   * {@link gmailMailboxWritesEnabled}; never branch on this field directly.
   */
  GMAIL_MAILBOX_WRITES_ENABLED: optionalBooleanString(),
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

/**
 * Whether Alfred may mutate the connected Gmail mailbox — triage label writes
 * and Gmail watch install/renew/stop (#278). The single decision point: an
 * explicit `GMAIL_MAILBOX_WRITES_ENABLED` wins, otherwise it defaults to
 * production-only so dev/test never fight prod over the shared real account.
 * Callers at the Gmail-mutation boundaries (the triage relabel writer, the
 * watch lifecycle) check this; nothing else should read the env field.
 */
export function gmailMailboxWritesEnabled(): boolean {
  const env = serverEnv();
  return env.GMAIL_MAILBOX_WRITES_ENABLED ?? env.NODE_ENV === "production";
}

export function chatMemoryCaptureEnabled(): boolean {
  return serverEnv().CHAT_MEMORY_CAPTURE_ENABLED === true;
}
