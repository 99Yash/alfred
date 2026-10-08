import { z } from "zod";
import { agentWorkerConcurrencySchema } from "./pool";

/** Optional secret. A blank `FOO=` line counts as unset instead of failing boot. */
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

// Optional 32+ char secret. Surrounding whitespace fails boot: it would change every HMAC keyed off it.
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

/** AES-256 key length in bytes. */
const KEK_BYTES = 32;

/**
 * A 256-bit key as base64 or base64url, normalized to base64url.
 * Checks the decoded length: `Buffer.from` skips bad characters, so a mangled
 * key would otherwise fail at the first credential write, not at boot.
 */
const credentialKek = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string({ error: `required — generate with \`openssl rand -base64 ${KEK_BYTES}\`` })
      .refine((v) => v === v.trim(), {
        error: "must not have leading or trailing whitespace",
      })
      .refine((v) => /^[A-Za-z0-9+/_-]+={0,2}$/.test(v), {
        error: "must be base64 or base64url",
      })
      .refine((v) => Buffer.from(v, "base64url").length === KEK_BYTES, {
        error: `must decode to exactly ${KEK_BYTES} bytes — generate with \`openssl rand -base64 ${KEK_BYTES}\``,
      })
      .transform((v) => Buffer.from(v, "base64url").toString("base64url")),
  );

const serverEnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    REDIS_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    /**
     * Key that encrypts stored OAuth tokens. Required in every env: without it,
     * every sign-in fails, so boot fails instead. Keep it separate from
     * `BETTER_AUTH_SECRET` so each rotates alone. No plaintext fallback.
     * Read it through `credentialVault()`, never directly.
     */
    OAUTH_CREDENTIAL_KEK: credentialKek(),
    BETTER_AUTH_URL: z.url(),
    CORS_ORIGIN: z.string().default("http://localhost:3000"),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    /** Railway injects this. */
    PORT: z.coerce.number().int().positive().default(3001),
    // Comma-separated emails allowed to sign up.
    ALFRED_ALLOWED_EMAIL: z
      .string()
      .transform((s) =>
        s
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().email()).min(1)),
    // Not `.email()`: the form `Alfred <noreply@example.com>` is valid.
    RESEND_API_KEY: z.string().min(1),
    RESEND_FROM_EMAIL: z.string().min(1),
    /** Direct provider keys. Not needed when the Cloudflare gateway is on. */
    ANTHROPIC_API_KEY: optionalSecret(),
    GOOGLE_GENERATIVE_AI_API_KEY: optionalSecret(),
    OPENAI_API_KEY: optionalSecret(),
    /** Cloudflare AI Gateway. Set all three to route every LLM call through it. */
    CLOUDFLARE_AI_GATEWAY_TOKEN: optionalSecret(),
    CLOUDFLARE_ACCOUNT_ID: optionalSecret(),
    CLOUDFLARE_GATEWAY_ID: optionalSecret(),
    /**
     * Overrides the gateway pacer rate in `gateway-throttle.ts`, which owns the default.
     * Not the gateway's own `rate_limiting_limit`; if one is set, keep this below it.
     */
    CLOUDFLARE_AI_GATEWAY_RPM: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce
        .number()
        .int()
        .positive()
        // Above this, `Math.round(60_000 / rpm)` is 0 and pacing silently turns off.
        .max(120_000)
        .optional(),
    ),
    /** Overrides the pacer burst. Capped so it cannot eat the margin below the gateway limit. */
    CLOUDFLARE_AI_GATEWAY_BURST: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(0).max(10).optional(),
    ),
    /** Legacy. Only a `cfut_` value is read, as an alias for `CLOUDFLARE_AI_GATEWAY_TOKEN`. */
    AI_GATEWAY_API_KEY: optionalSecret().refine(
      (v) => v === undefined || v.startsWith("vck_") || v.startsWith("cfut_"),
      { error: "must start with vck_ (Vercel) or cfut_ (Cloudflare) when set" },
    ),
    VOYAGE_API_KEY: z.string().optional(),
    /** Overrides the in-code Voyage price used by the embed cost cap. */
    VOYAGE_INPUT_PRICE_PER_MTOK_USD: z.coerce.number().positive().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    /** Fallback renderer for JS pages that `fetch_url` reads back empty. */
    FIRECRAWL_API_KEY: z.string().optional(),
    FIRECRAWL_BASE_URL: z.url().default("https://api.firecrawl.dev"),
    /**
     * HMAC key for stable entity ids (ADR-0067 D2). Back it up like an auth secret:
     * a change remints every id. Optional here; `requireEntityIdNamespace()` throws when unset.
     */
    ENTITY_ID_NAMESPACE: optionalLongSecret(),
    SENTRY_DSN: z.string().optional(),
    /** Send Sentry events outside production. Off so dev noise does not drown prod errors. */
    SENTRY_ENABLE_DEV: z
      .string()
      .optional()
      .transform((s) => s === "true"),
    /** Pins the Sentry release. Unset uses `RAILWAY_GIT_COMMIT_SHA`. */
    SENTRY_RELEASE: z.string().optional(),
    /**
     * Sentry trace sample rate. Unset is `0` in production (tracing costs egress
     * and quota) and `1` elsewhere. Errors are reported at any rate.
     */
    SENTRY_TRACES_SAMPLE_RATE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().min(0).max(1).optional(),
    ),
    LANGFUSE_PUBLIC_KEY: z.string().optional(),
    LANGFUSE_SECRET_KEY: z.string().optional(),
    LANGFUSE_HOST: z.url().optional(),
    /** Read directly by `LangfuseSpanProcessor`; declared here only to validate it. */
    LANGFUSE_RELEASE: z.string().optional(),
    /** Langfuse environment per deploy target, since all of them run `NODE_ENV=production`. */
    LANGFUSE_TRACING_ENVIRONMENT: z
      .string()
      .max(40)
      .regex(
        /^(?!langfuse)[a-z0-9-_]+$/,
        "must be lowercase [a-z0-9-_], max 40 chars, and not start with 'langfuse' (Langfuse Environments rule)",
      )
      .optional(),
    /** Send prompt and completion text to Langfuse. Off because prompts can carry PII. */
    LANGFUSE_CAPTURE_IO: z
      .string()
      .optional()
      .transform((s) => s === "true"),
    POSTHOG_API_KEY: z.string().optional(),
    // One Google client for sign-in and the integration grant. The redirect URI is the integration's.
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
    GOOGLE_OAUTH_REDIRECT_URI: z.url(),
    /** Pub/Sub topic for the Gmail watch, e.g. `projects/<id>/topics/gmail-push`. */
    GOOGLE_PUBSUB_TOPIC: optionalSecret(),
    /** OIDC audience configured on the push subscription. Required in production. */
    GOOGLE_PUBSUB_AUDIENCE: optionalSecret(),
    /** Expected `email` claim in the push OIDC token. Required in production. */
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: optionalSecret(),
    /** GitHub App (ADR-0052): OAuth client for identity, app key for installation tokens. */
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_SLUG: z.string().min(1),
    GITHUB_APP_CLIENT_ID: z.string().min(1),
    GITHUB_APP_CLIENT_SECRET: z.string().min(1),
    /** PEM private key. Railway stores newlines as literal `\n`; callers un-escape. */
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    /** Verifies `x-hub-signature-256` on webhooks. */
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    /** OAuth callback, e.g. `https://api.alfred.beauty/api/integrations/github/callback`. */
    GITHUB_APP_REDIRECT_URI: z.url(),
    /** Static OAuth client for the GitHub MCP. GitHub has no DCR, so unset means connect fails. */
    GITHUB_MCP_CLIENT_ID: optionalSecret(),
    GITHUB_MCP_CLIENT_SECRET: optionalSecret(),
    /** Notion OAuth. Optional; Notion stays unconfigured until all three are set. */
    NOTION_OAUTH_CLIENT_ID: optionalSecret(),
    NOTION_OAUTH_CLIENT_SECRET: optionalSecret(),
    NOTION_OAUTH_REDIRECT_URI: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.url().optional(),
    ),
    /** Vercel integration. The slug builds `https://vercel.com/integrations/<slug>/new`. */
    VERCEL_CLIENT_ID: optionalSecret(),
    VERCEL_CLIENT_SECRET: optionalSecret(),
    VERCEL_REDIRECT_URI: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.url().optional(),
    ),
    VERCEL_APP_SLUG: optionalSecret(),
    /** Verifies `sentry-hook-signature`. While unset, every Sentry delivery is rejected. */
    SENTRY_WEBHOOK_CLIENT_SECRET: optionalSecret(),
    /** S3-compatible storage for chat uploads (ADR-0065). Uploads are off until it is set. */
    CHAT_S3_BUCKET: optionalSecret(),
    CHAT_S3_REGION: optionalSecret(),
    CHAT_S3_ENDPOINT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.url().optional(),
    ),
    CHAT_S3_ACCESS_KEY_ID: optionalSecret(),
    CHAT_S3_SECRET_ACCESS_KEY: optionalSecret(),
    CHAT_S3_PUBLIC_BASE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.url().optional(),
    ),
    CHAT_S3_FORCE_PATH_STYLE: z
      .string()
      .optional()
      .transform((s) => s === "true"),
    /** Turns on the chat-to-memory idle capture. Off by default. */
    CHAT_MEMORY_CAPTURE_ENABLED: optionalBooleanString(),
    /**
     * Allows Gmail label writes and watch changes. Unset means production only,
     * because dev and prod share one mailbox and would undo each other's labels.
     * Read it through {@link gmailMailboxWritesEnabled}.
     */
    GMAIL_MAILBOX_WRITES_ENABLED: optionalBooleanString(),
    /**
     * Allows the cron schedules. Unset means production only, because an orphaned
     * `tsx watch` dev process can spend money on a timer. Workers run either way.
     * Read it through {@link scheduledJobsEnabled}.
     */
    ALFRED_RUN_SCHEDULED_JOBS: optionalBooleanString(),
    /**
     * After this many ms, triage classify fires a duplicate call and takes the first answer.
     * The slow tail is provider jitter, not work. Default is about p75. `0` turns it off.
     */
    TRIAGE_CLASSIFY_HEDGE_MS: z.coerce.number().int().nonnegative().default(2500),
    /** Max concurrent agent runs per process. The `pg.Pool` size derives from it (`derivePoolMax`). */
    AGENT_WORKER_CONCURRENCY: agentWorkerConcurrencySchema,
  })
  .superRefine((data, ctx) => {
    // Need the gateway or a direct key. Tests are exempt because they boot without env.
    const cfToken =
      data.CLOUDFLARE_AI_GATEWAY_TOKEN ??
      (data.AI_GATEWAY_API_KEY?.startsWith("cfut_") ? data.AI_GATEWAY_API_KEY : undefined);

    const cfEnabled = Boolean(cfToken && data.CLOUDFLARE_ACCOUNT_ID && data.CLOUDFLARE_GATEWAY_ID);

    if (cfEnabled) return;
    const hasDirectKey = Boolean(data.ANTHROPIC_API_KEY ?? data.GOOGLE_GENERATIVE_AI_API_KEY);

    if (!hasDirectKey && data.NODE_ENV !== "test") {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message:
          "either Cloudflare gateway (CLOUDFLARE_AI_GATEWAY_TOKEN + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_GATEWAY_ID, or AI_GATEWAY_API_KEY=cfut_...) or a direct provider key (ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY) must be set",
      });
    }
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
 * Read only `NODE_ENV`. Never throws: a bad value gives the schema default.
 * For module-scope code that runs before the full env is valid.
 */
export function nodeEnv(): ServerEnv["NODE_ENV"] {
  const field = serverEnvSchema.shape.NODE_ENV;
  const result = field.safeParse(process.env.NODE_ENV);

  return result.success ? result.data : field.parse(undefined);
}

/** Whether Alfred may change the Gmail mailbox. Unset means production only. */
export function gmailMailboxWritesEnabled(): boolean {
  const env = serverEnv();

  return env.GMAIL_MAILBOX_WRITES_ENABLED ?? env.NODE_ENV === "production";
}

/** Whether this process may register the cron schedules. Unset means production only. */
export function scheduledJobsEnabled(): boolean {
  const env = serverEnv();

  return env.ALFRED_RUN_SCHEDULED_JOBS ?? env.NODE_ENV === "production";
}

export function chatMemoryCaptureEnabled(): boolean {
  return serverEnv().CHAT_MEMORY_CAPTURE_ENABLED === true;
}

function gatewayTokenFromEnv(): string | undefined {
  const tokenField = serverEnvSchema.shape.CLOUDFLARE_AI_GATEWAY_TOKEN;
  const legacyField = serverEnvSchema.shape.AI_GATEWAY_API_KEY;
  const tokenResult = tokenField.safeParse(process.env.CLOUDFLARE_AI_GATEWAY_TOKEN);

  if (tokenResult.success && tokenResult.data) return tokenResult.data;
  const legacyResult = legacyField.safeParse(process.env.AI_GATEWAY_API_KEY);

  if (legacyResult.success && legacyResult.data?.startsWith("cfut_")) return legacyResult.data;

  return undefined;
}

export function envFieldValue<K extends keyof ServerEnv>(key: K): ServerEnv[K] | undefined {
  const field = serverEnvSchema.shape[key];
  const result = field.safeParse(process.env[key]);

  // SAFETY: `field` is the schema for `key`, so its output is ServerEnv[K].
  return result.success ? (result.data as ServerEnv[K]) : undefined;
}

/**
 * The gateway config when all three vars are set.
 * Parses only these fields, so a bad unrelated var cannot turn the gateway off.
 */
export function cloudflareGatewayConfig():
  | { token: string; accountId: string; gatewayId: string }
  | undefined {
  const token = gatewayTokenFromEnv();
  const accountId = envFieldValue("CLOUDFLARE_ACCOUNT_ID");
  const gatewayId = envFieldValue("CLOUDFLARE_GATEWAY_ID");

  if (token && accountId && gatewayId) return { token, accountId, gatewayId };

  return undefined;
}

/** Whether to use the Cloudflare AI Gateway. Do not branch on the raw env fields. */
export function cloudflareGatewayEnabled(): boolean {
  return cloudflareGatewayConfig() !== undefined;
}
