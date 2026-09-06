import { z } from "zod";
import { agentWorkerConcurrencySchema } from "./pool";

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

/** Decoded byte length every AES-256 key in this codebase must have. */
const KEK_BYTES = 32;

/**
 * A 256-bit key supplied as base64 or base64url. Validation decodes the value
 * and checks the byte length, because the failure mode it prevents is silent:
 * `Buffer.from` ignores characters it does not recognize, so a truncated or
 * whitespace-mangled key decodes to *fewer* bytes and `createCipheriv` then
 * rejects it at the first credential write rather than at boot. Normalized to
 * base64url so the consumer decodes one way.
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
     * Key-encryption key for the OAuth credential vault (#453), base64 or
     * base64url, decoding to exactly 32 bytes. Generate one with
     * `openssl rand -base64 32`.
     *
     * Deliberately separate from `BETTER_AUTH_SECRET`: the auth secret signs
     * cookies and is handled as a routine application secret, while this key is
     * the only thing between a leaked database artifact and a replayable Google,
     * GitHub, Notion, Vercel, or Railway token. Rotating one must not force
     * rotating the other.
     *
     * Required in **every** environment, and required here rather than at the
     * first credential read, because the vault also backs Better Auth's `account`
     * token columns through `encryptedAuthAdapter`. A process that boots without
     * this key does not degrade to "integrations are unavailable" — it fails
     * every sign-in and every session check, in the adapter, at request time.
     * One loud boot error naming the generation command is the cheaper failure.
     * There is no plaintext fallback and no derived default. Read the value
     * through `credentialVault()` in `@alfred/db/credential-vault`, never
     * directly.
     */
    OAUTH_CREDENTIAL_KEK: credentialKek(),
    BETTER_AUTH_URL: z.url(),
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
    /**
     * Direct provider keys — optional when Cloudflare AI Gateway is configured.
     * When `cloudflareGatewayEnabled()` is true, every call routes via CF Unified
     * Billing (`cfut_` token) at `gateway.ai.cloudflare.com` and no provider key is
     * needed. Kept optional so a fully-migrated CF deploy boots without them.
     * When CF is disabled, at least one of these must be set or model construction
     * will throw at first LLM call (not at boot, to keep `tsx --test` without env working).
     */
    ANTHROPIC_API_KEY: optionalSecret(),
    GOOGLE_GENERATIVE_AI_API_KEY: optionalSecret(),
    OPENAI_API_KEY: optionalSecret(),
    /**
     * Cloudflare AI Gateway — when all three are set, every LLM call routes via
     * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}` using
     * Unified Billing (`cfut_` token). Speech to text is the one endpoint that
     * differs: it posts to `https://api.cloudflare.com/client/v4/accounts/
     * {account}/ai/run` with `cf-aig-gateway-id`, because the provider-native
     * pass-through carries no managed credential on `/audio/transcriptions`
     * (`packages/ai/src/gateway.ts`). Both surfaces read these same three vars.
     * This fully replaces the Vercel AI Gateway
     * (`AI_GATEWAY_API_KEY` `vck_` prefix) and direct keys when present.
     * All three are `optionalSecret` so a half-configured gateway does not bounce
     * boot — the gateway simply stays disabled and the provider fallback handles it.
     */
    CLOUDFLARE_AI_GATEWAY_TOKEN: optionalSecret(),
    CLOUDFLARE_ACCOUNT_ID: optionalSecret(),
    CLOUDFLARE_GATEWAY_ID: optionalSecret(),
    /**
     * Vercel AI Gateway (`vck_` token) — kept for migration but unused when
     * Cloudflare is configured. `optionalSecret` tolerates `AI_GATEWAY_API_KEY=`
     * blank line; a `cfut_` token here is also accepted as Cloudflare alias so
     * the single var `AI_GATEWAY_API_KEY=cfut_...` continues to work.
     * Validated to start with `vck_` or `cfut_` when set so the prefix
     * discrimination happens at the owning boundary, not at each reader.
     */
    AI_GATEWAY_API_KEY: optionalSecret().refine(
      (v) => v === undefined || v.startsWith("vck_") || v.startsWith("cfut_"),
      { error: "must start with vck_ (Vercel) or cfut_ (Cloudflare) when set" },
    ),
    VOYAGE_API_KEY: z.string().optional(),
    /**
     * Vendor pricing override for the embed cost-cap math (`maxTokensForPrice`
     * in `@alfred/corpus`). Optional: unset falls back to the in-code Voyage
     * list price, so a vendor price change is an env edit, not a deploy.
     */
    VOYAGE_INPUT_PRICE_PER_MTOK_USD: z.coerce.number().positive().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    /**
     * Firecrawl render+extract API — the escalation path for JS-rendered pages
     * that `system.fetch_url` reads back empty (#509/#510). Optional: when unset,
     * fetch_url reports `empty_content` honestly instead of escalating. Base URL
     * is overridable so the OSS self-hosted Firecrawl is a config swap.
     */
    FIRECRAWL_API_KEY: z.string().optional(),
    FIRECRAWL_BASE_URL: z.url().default("https://api.firecrawl.dev"),
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
    LANGFUSE_HOST: z.url().optional(),
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
    GOOGLE_OAUTH_REDIRECT_URI: z.url(),
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
    GITHUB_APP_REDIRECT_URI: z.url(),
    /**
     * Built-in GitHub MCP OAuth client (PRD #934). Optional — when `GITHUB_MCP_CLIENT_ID`
     * is unset the built-in falls back to DCR (which GitHub's AS does not support,
     * so the flow then fails closed). `optionalSecret` tolerates blank env lines.
     */
    GITHUB_MCP_CLIENT_ID: optionalSecret(),
    GITHUB_MCP_CLIENT_SECRET: optionalSecret(),
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
      z.url().optional(),
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
      z.url().optional(),
    ),
    VERCEL_APP_SLUG: optionalSecret(),
    /**
     * The Sentry internal integration that Alfred's Sentry provider pairs with
     * (Settings → Developer Settings → the integration's slug). The connect
     * route resolves the integration's installation in the user's organization
     * through it, so the stored credential carries the `installation.uuid` that
     * webhook deliveries name. Optional for the same boot-before-setup reason as
     * Notion; the connect route returns 503 while it is unset.
     */
    SENTRY_INTEGRATION_SLUG: optionalSecret(),
    /**
     * The same internal integration's Client Secret. Sentry signs every webhook
     * body with it (`sentry-hook-signature`, HMAC-SHA256 hex over the raw
     * bytes). Optional so the server boots before the integration exists; the
     * `sentry` ingress descriptor rejects every delivery while it is unset.
     */
    SENTRY_WEBHOOK_CLIENT_SECRET: optionalSecret(),
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
    /**
     * Gate for the repeatable cron schedules — the ingestion poll, the memory
     * extract, the hourly briefing tick, and the workflows tick.
     *
     * These are the only jobs a *timer* enqueues, so they are the only ones that
     * spend money with nobody watching: the briefing tick calls a model and sends
     * mail on a schedule. Worse, `pnpm dev` runs the server under `tsx watch`,
     * and that supervisor listens on no port — so it survives closing the
     * terminal, is invisible to a "what is on :3001" check, and silently respawns
     * the child on every file change. One such orphan ran for three days and
     * billed real tokens against seeded test rows.
     *
     * Deliberately scoped to the schedules and NOT to the workers. A worker only
     * acts on a job somebody enqueued, and in dev that somebody is usually the
     * developer — sending a chat message, triggering a run by hand. Gating the
     * workers would break interactive local work; gating the schedules removes
     * the unattended spend and leaves everything a person initiates untouched.
     *
     * Tri-state, mirroring {@link GMAIL_MAILBOX_WRITES_ENABLED}: unset → default
     * (on in `production`, off otherwise); `"true"`/`"false"` → explicit opt-in
     * or opt-out, so a developer can deliberately exercise a cron locally.
     * Resolve via {@link scheduledJobsEnabled}; never branch on this field
     * directly.
     */
    ALFRED_RUN_SCHEDULED_JOBS: optionalBooleanString(),
    /**
     * Hedge delay for the triage classify call, in milliseconds (#436). If the
     * cheap-model call has not answered within this window, a second identical
     * call is fired and whichever lands first wins — the tail of
     * `triage.classify` is Google-side scheduling jitter, not work (fast and slow
     * calls carry identical token counts), so a duplicate draw is the cheapest
     * way to recover p90/p95 without touching p50.
     *
     * Default 2500ms ≈ measured p75, so the common fast call never duplicates.
     * Set `0` to disable hedging (single call, previous behaviour).
     */
    TRIAGE_CLASSIFY_HEDGE_MS: z.coerce.number().int().nonnegative().default(2500),
    /**
     * Max concurrent agent runs per server process (#437). Each run executes one
     * step at a time, and a triage classify step is dominated by a ~2s model
     * call, so the previous 4 left the queue serializing behind idle wall-clock.
     *
     * This is the *only* knob to turn: the shared `pg.Pool` ceiling is derived
     * from it (`derivePoolMax` in `./pool`), so raising concurrency raises the
     * pool with it and there is no second place to forget.
     */
    AGENT_WORKER_CONCURRENCY: agentWorkerConcurrencySchema,
  })
  .superRefine((data, ctx) => {
    // Boot guarantee: either Cloudflare gateway is fully configured, or at least
    // one direct provider key is present. Restores tier-2 validation from the
    // previous tier-5 comment. Exempt NODE_ENV=test where tsx --test boots
    // without env (barrel-load detector) — enforcement is for real deploys.
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
 * `NODE_ENV` on its own, validated against the same field schema as
 * `serverEnv()` but without the other ~25 variables. Total: an absent or
 * unrecognized value falls back to the schema's declared default, so this never
 * throws and there is no third "unknown" state for a caller to mishandle.
 *
 * For the reader that must answer before any entrypoint validates the whole
 * environment — a module-scope default that runs on import, where a bare test
 * run has no `--env-file`. Anything that needs a second variable wants
 * `serverEnv()`, which throws and names what is missing.
 */
export function nodeEnv(): ServerEnv["NODE_ENV"] {
  const field = serverEnvSchema.shape.NODE_ENV;
  const result = field.safeParse(process.env.NODE_ENV);
  return result.success ? result.data : field.parse(undefined);
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

/**
 * Whether this process may register the repeatable cron schedules. The single
 * decision point: an explicit `ALFRED_RUN_SCHEDULED_JOBS` wins, otherwise it
 * defaults to production-only so an unattended dev process cannot spend money or
 * send mail on a timer. The runtime's `start()` checks this; nothing else should
 * read the env field.
 */
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
  const result = field.safeParse(process.env[key as string]);
  return result.success ? (result.data as ServerEnv[K]) : undefined;
}

/**
 * Full Cloudflare gateway config when all three vars are present, otherwise
 * undefined. Reads only the three CF fields through their Zod shapes (same
 * single-field pattern as `nodeEnv()`), so a mistyped unrelated var
 * (e.g. `AGENT_WORKER_CONCURRENCY=four`) does not silently disable the
 * gateway and cause billing to fall through to the direct provider.
 */
export function cloudflareGatewayConfig():
  | { token: string; accountId: string; gatewayId: string }
  | undefined {
  const token = gatewayTokenFromEnv();
  const accountId = envFieldValue("CLOUDFLARE_ACCOUNT_ID") as string | undefined;
  const gatewayId = envFieldValue("CLOUDFLARE_GATEWAY_ID") as string | undefined;
  if (token && accountId && gatewayId) return { token, accountId, gatewayId };
  return undefined;
}

/**
 * Whether Cloudflare AI Gateway should be used. True only when
 * `cloudflareGatewayConfig()` is present. Single decision point — callers
 * must not branch on raw env fields. Delegates to `cloudflareGatewayConfig()`
 * so the environment is parsed once per check.
 */
export function cloudflareGatewayEnabled(): boolean {
  return cloudflareGatewayConfig() !== undefined;
}
