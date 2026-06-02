# Triage + briefing v2 — implementation plan

Rebuilds m9 (email triage) and m10 (morning briefing) under [ADR-0042](../decisions.md#adr-0042) and [ADR-0041](../decisions.md#adr-0041) plus the inline amendments to ADR-0025, ADR-0031, ADR-0033. The two ADRs are independent but share foundations (contracts package, OAuth scopes, observability) and one cross-cutting consumer (the briefing's email gather contributor reads triage rollup).

This is a phased plan. Each phase is "land before the next phase starts"; sub-steps inside a phase are parallel-safe. Triage and briefing tracks run in parallel where they don't share files.

Cross-references: [`../CONTEXT.md`](../CONTEXT.md) (glossary: `SenderContext`, `Effective author`, `Body actor parsing`, `Bot allowlist`, `SEVERITY_SUSPECT_BOTS`, `User context`, `Deepen step`, `Dossier cache TTL`, `Briefing`, `Breaking summary`, `Full briefing`, `Briefing reference`, `Gather source`, `Integration activity`, `IanaTimezone`), [`../decisions.md`](../decisions.md) (ADRs 0011, 0025, 0031, 0033, 0041, 0042), [`./triage.md`](./triage.md) (legacy doc — 6-category drift to fix in Phase 6), [`./briefing.md`](./briefing.md) (legacy m10 doc — supersede in Phase 6).

---

## Sequencing constraints (read first)

1. **`@alfred/contracts` is the chokepoint again.** `SenderContext`, `BOT_SLUGS`, `IanaTimezone`, `BriefingGather`, `briefingComposerSchema`, `fullBriefingSchema`, the `briefing` `AttributionKind` value, integration-activity item types, and the reference-kind enum all live here. Schema columns (`briefings.timezone`, `documents` triage join) type their jsonb against contracts via `.$type<T>()`. Land Phase 1 first; rebase downstream PRs on it.
2. **Triage v2 (ADR-0042) depends on m13 phase 4 for `deepen`.** The boss brief-only `AlfredAgent` loop and `userAuthoredBriefWorkflow` sentinel are required for the escalation step. m13 phase 4 is shipped (status board green), so `deepen` is unblocked. Phase 5 of m13 (HIL surface) is *not* a prerequisite — `deepen`'s tool surface is read-only (`system.read_user_context`, `github.list_repos`, `gmail.thread_history`); nothing routes through `action_stagings`.
3. **Briefing v2 (ADR-0041) does not depend on m13 for compose.** The composer is a single `meteredGenerateText` structured-output call, not an agent loop. It only needs `getBossModel()` and the gather payload. ADR-0041 §"Alternatives" rejected the boss-driven gather explicitly.
4. **OAuth scope additions are user-facing.** `calendar.events.readonly` (Google) and `repo` (GitHub, first `integration_activity` producer) require re-consent. Land the code in Phase 1, but the actual scope bumps go through the in-app integration UI as a Phase 5 user-flow step. Until the user re-consents, the matching contributors return `null` / empty activity arrays and the composer prompt's empty-case path renders.
5. **`briefings` is a new table.** `briefing_runs` (m10 v1, watermark + slot model) and `briefings` (one row per user/day, idempotent on `(user_id, briefing_date)`) coexist during cutover. The morning briefing workflow flips writes to `briefings` in Phase 6; `briefing_runs` is read-only legacy after that and gets dropped in a later milestone. No data migration — both surface distinct shapes; legacy rows are diagnostics-only per the existing schema comment.
6. **Doc drift gets fixed last.** `docs/triage.md` (6 categories) and `packages/integrations/src/google/labels.ts` (source-of-truth) reconcile in Phase 6 once the live pipeline matches. Holding cleanup until implementation lands keeps the diff size of each phase auditable.

---

## Open items to settle during the plan

- **Resolved — `AttributionKind` location.** `packages/contracts/src/metering.ts` owns `AttributionKind` and includes `'briefing'`; `@alfred/ai` re-exports it as `CallKind` for existing callers. Keep Phase 1 as verification only.
- **Resolved — `briefings.briefing_date` column type.** `packages/db/src/schema/briefings.ts` uses `date("briefing_date", { mode: "string" })`. Keep Phase 2 acceptance focused on guarding the string round-trip, not choosing a type.
- **Phase 3 — `deepen` shadow rollout.** ADR-0042 specifies `confidence < 0.7`, severity-suspect bots, and unknown humans as `deepen` eligibility. Severity-suspect bots execute live in v1; confidence-floor and unknown-human branches are shadow/log-only first. Promotion is per branch: `low_confidence` needs 200 triaged emails or 7 days of logs and <=15% fire rate; `unknown_human` needs <=5% fire rate plus a manual spot-check that the senders are real people worth dossier work.
- **Phase 3 — `system.read_user_context` cache invalidation.** User context is Postgres-owned (`user_facts`, `user_preferences`, `entities`, `entity_relations`, `memory_chunks`, later `person_profiles`) with Redis as a read-through cache. Decide the first invalidation mechanism: broad delete on writes vs. versioned key. Default plan: broad delete on every memory/fact/preference/profile mutation; optimize to versioned keys only if churn becomes visible.
- **Resolved — reference-resolver kinds at v1.** Replace the current `pr | commit | meeting | email | repo` contract shape with `activity | meeting | email`. PRs, commits, deployments, incidents, billing notices, security alerts, and future provider updates become `integration_activity` items referenced as `[[activity:<id>]]`.
- **Resolved — Open-Meteo location fallback.** `packages/contracts/src/weather.ts` owns a hand-curated `WEATHER_FALLBACK_CITIES` `ReadonlyMap` plus `weatherFallbackFor(tz)`. Keep misses as misses; the weather contributor can return `null` rather than guessing.
- **Deferred — email-tagging leniency.** Integration-activity backfill from service mail depends on the triage labels being a little more tolerant than the current strict classifier shape. Discuss separately after Phase 3 shadow logs show the real provider-email distribution.

Decide each in the corresponding phase's PR description so reviewers know what was chosen.

---

## Phase 1 — Foundations

Goal: land all shared types so triage and briefing implementations have a stable target.

### 1a. `@alfred/contracts/triage.ts` extensions

Extend the existing 10-category file (`packages/contracts/src/triage.ts`):

- `SENDER_KIND = ['person', 'service', 'unknown'] as const` + `SenderKind` type
- `EFFECTIVE_AUTHOR = ['bot', 'person', 'service', 'unknown'] as const` + `EffectiveAuthor` type
- `BOT_SLUGS` const tuple — initial 10 entries per ADR-0042
- `BotSlug` derived type
- `SEVERITY_SUSPECT_BOTS: ReadonlySet<BotSlug>` — Sentry, Stripe billing, Google security, Vercel deploy, Datadog. Const-frozen.
- `SenderContext` interface (`fromKind`, `bodyActor?`, `effectiveAuthor`, `botSlug?`).
- `senderContextSchema` zod for runtime validation at workflow boundaries — body-actor `kind` is `'bot' | 'person' | 'unknown'`.

### 1b. `@alfred/contracts/briefing.ts` replacement

Replace the partially-landed `packages/contracts/src/briefing.ts` shape. The file already exists today with `github`, `pr | commit | repo`, and `reasoning`; Phase 1 rewrites that contract to the revised `integration_activity`, `activity | meeting | email`, and `why` / `auditSummary` shape rather than adding a second file.

Zero-dep types and consts:

- `GATHER_SOURCE_SLUGS = ['email', 'calendar', 'integration_activity', 'weather', 'day_of_week'] as const` + `GatherSourceSlug` type. This replaces the partially-landed `github` source; GitHub becomes the first `integration_activity` producer.
- `BRIEFING_REFERENCE_KINDS = ['activity', 'meeting', 'email'] as const` + `BriefingReferenceKind`. This replaces the partially-landed `pr | commit | repo` reference kinds; provider detail lives inside `IntegrationActivityItem`.
- `IanaTimezone` branded `string` (`string & { readonly __ianaTimezone: unique symbol }`) with `assertIanaTimezone(value)` runtime guard against `Intl.supportedValuesOf('timeZone')`
- `IntegrationActivityItem` + `IntegrationActivityContribution`:

```ts
type IntegrationActivitySource = 'direct_api' | 'email_triage';
type IntegrationActivityCategory =
  | 'work'
  | 'deploy'
  | 'incident'
  | 'account'
  | 'billing'
  | 'security'
  | 'usage'
  | 'other';

interface IntegrationActivityItem {
  id: string;
  provider: IntegrationSlug;
  source: IntegrationActivitySource;
  activityCategory: IntegrationActivityCategory;
  providerKind: string;
  title: string;
  status?: 'open' | 'succeeded' | 'failed' | 'resolved' | 'needs_attention';
  severity?: 'info' | 'warning' | 'critical';
  occurredAt: string;
  url?: string;
  relatedRepo?: string;
  rollup?: { eventCount: number; attemptCount?: number; durationMinutes?: number };
}
```

- `BriefingGather` discriminated union per source + per-source contribution types (`EmailContribution`, `CalendarContribution`, `IntegrationActivityContribution`, `WeatherContribution`, `DayOfWeekContribution`)
- `BriefingComposerOutput` (`{ breakingSummary, fullBriefing: ComposerFullBriefing }`) is the model-facing structured-output type. It intentionally does **not** include `sourcePanels`.
- Persisted `FullBriefing` (`{ headline, sections: { source, label, body, why?, references? }[], sourcePanels?, auditSummary? }`). `why` is user-facing inclusion rationale; `auditSummary` is bounded composition notes. `sourcePanels` is the normalized display model for the full-page UI, generated deterministically from `gather` + resolved references after compose; raw `gather` stays stored for audit/replay. Do not expose raw model reasoning.

```ts
interface BriefingSourcePanel {
  source: GatherSourceSlug;
  label: string;
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    status?: string;
    severity?: 'info' | 'warning' | 'critical';
    href?: string;
    reference?: string; // e.g. activity:..., meeting:..., email:...
    metadata?: Record<string, string>;
  }>; // generated by code, not by the composer model
}
```
- `briefingComposerSchema` zod schema producing the model-authored `{ breakingSummary, fullBriefing }` without `sourcePanels` (per ADR-0041 §"Composer output schema")
- `fullBriefingSchema` / persisted type adds deterministic `sourcePanels` after compose/reference resolution.
- `BriefingContributor<T>` interface (`source`, `collect({ userId, date, timezone })`)
- `briefingStatusValues = ['pending', 'gathering', 'composing', 'sent', 'failed'] as const` + `BriefingStatus` type

`BriefingGather` is the input to the composer — every contributor's output is keyed by its `GatherSourceSlug`. `null` for missing/unconnected integrations is part of the schema.

### 1c. `AttributionKind` move + `'briefing'` addition

- Decide per the "Open items" above; default plan: move `CallKind` from `@alfred/ai/metering/types.ts` to `@alfred/contracts/metering.ts` as `AttributionKind`, add `'briefing'`, re-export from `@alfred/ai`.
- `@alfred/ai` keeps `CallAttribution` / `MeteredMeta` (these reference Node-aware caller fields like `runId`) but pulls `AttributionKind` from contracts.
- `triage`, `web_search`, `embedding`, `llm`, `transcription`, `tool_api` are already in `CallKind` today. Add `'briefing'`.

### 1d. `@alfred/contracts/weather.ts` (new, small)

- `WEATHER_FALLBACK_CITIES: Record<IanaTimezone-ish, { lat: number; lng: number }>` — hand-curated, ~10–20 entries covering the user's real timezone footprint. Stand-in for `tz-lookup` per "Open items".

### 1e. `mentions` / `tools` / `transcript` files unchanged

These already exist (`@alfred/contracts/mentions.ts`, `tools.ts`, `transcript.ts`). Verify nothing in 1a–1d conflicts with their exports.

### Phase 1 acceptance

- `pnpm check-types` clean across the workspace.
- `apps/web` builds with no Node-only modules leaked (re-run `pnpm check:web-boundaries`).
- `import { senderContextSchema, briefingComposerSchema, fullBriefingSchema } from '@alfred/contracts'` compiles in `packages/api`, `packages/db`, `apps/web`.
- New `AttributionKind` union includes `'briefing'`; `@alfred/ai` re-export keeps the public API of `meteredGenerateText` unchanged for existing callers.
- `packages/contracts/src/briefing.ts` no longer exposes a top-level `github` gather source or `pr` / `commit` / `repo` reference kinds; GitHub data compiles through `IntegrationActivityContribution`.

---

## Phase 2 — Schema migrations

Goal: stand up the `briefings` table and any column additions the runtime needs.

One migration per logical change (`pnpm db:generate` → `pnpm db:migrate`; never `db:push`). Update `packages/db/src/schema/*.ts` and re-export through `packages/db/src/schemas.ts`.

### 2a. `briefings` table

New file `packages/db/src/schema/briefings-v2.ts` (or rename existing `briefings.ts` to `briefing-runs.ts` and own the new shape under `briefings.ts` — pick the cleanup that produces the smallest blast radius; default plan: keep `briefings.ts` filename, rename the existing export to `briefingRuns` declared in `briefing-runs.ts`, add the new `briefings` export in this file). Columns per ADR-0041 §"Schema sketch":

- `id text PK` (`createId('brf')`)
- `user_id text FK -> user.id ON DELETE CASCADE`
- `briefing_date date NOT NULL` (`mode: 'string'`)
- `timezone text NOT NULL .$type<IanaTimezone>()`
- `status text NOT NULL` (default `'pending'`; typed against `BriefingStatus`)
- `gather jsonb NOT NULL .$type<BriefingGather>()`
- `breaking_summary text NOT NULL DEFAULT ''`
- `full_briefing jsonb NOT NULL .$type<FullBriefing>()`
- `model text` (compose model id; null until composed)
- `compose_fallback boolean NOT NULL DEFAULT false` — true when deterministic fallback prose was sent because the composer model failed.
- `email_send_id text FK -> email_sends NULL`
- `row_version bigint NOT NULL DEFAULT 0` (Replicache bump on every status/body change)
- `...lifecycle_dates`
- `UNIQUE(user_id, briefing_date)` — idempotency key
- Index `(user_id, briefing_date DESC)` for "last N briefings"

Add a `briefingDateAndTz` spread helper to `packages/db/src/helpers.ts` mirroring `lifecycle_dates` shape if the column duo recurs anywhere else.

### 2b. `person_profiles` cache-key amendment (ADR-0031 + ADR-0042)

ADR-0031 is not landed in the current tree: there is no `person_profiles` schema yet. Phase 2 must branch explicitly:

- If ADR-0031 lands before this plan's Phase 2 PR, confirm the existing `person_profiles` row supports `service:handle` keys (`github:coderabbitai`) alongside `email` keys. If `person_profiles.identifier` is `email`-only, add a `kind` column (`'email' | 'service'`) + widen `identifier` semantics. Cache TTL is read-time logic (compare `identity_confidence` against `lifecycle_dates.updated_at`); no new column needed.
- If ADR-0031 is still absent, do **not** pretend dossier caching exists. Either add the ADR-0031 tables in this phase or mark dossier enqueue/cache acceptance as deferred until the ADR-0031 schema PR lands. During the shadow rollout, unknown-human dossier enqueue is already disabled, so deferring this schema does not block live v1 triage.

ADR-0031 people dossiers should include a bounded `public_relationships` section in `sections jsonb` for publicly attested family/cofounder/advisor/investor/collaborator context. No extra schema is needed for v1; accepted relationship facts can still use `person_profile_facts` / `entity_relations` with provenance. Keep this out of quick lookup and out of automated triage enrichment.

### 2c. `user_preferences.location` (ADR-0041 weather source)

Optional `location jsonb` on the existing `user_preferences` (or sibling row) with shape `{ lat: number; lng: number; label?: string }`. Null falls back to `WEATHER_FALLBACK_CITIES[timezone]`. Settings UI surface comes in Phase 5; the column lands now so the contributor compiles.

### 2d. `documents` / `email_triage` audit field (optional)

For Phase 6 observability — if Phase 3's `triage.sender_extraction` log event references a `documents.sender_context jsonb` snapshot column for after-the-fact analysis, add it now to keep one migration boundary. Default plan: skip — log to the event sink only; revisit if log volume makes ad-hoc SQL queries hard.

### Phase 2 acceptance

- `pnpm --filter @alfred/db db:generate` produces a migration that adds the `briefings` table with all columns + indexes from 2a; no incidental drift against the existing `briefingRuns` table.
- `pnpm --filter @alfred/db db:migrate` succeeds locally.
- `SELECT briefing_date, timezone FROM briefings LIMIT 1` after a manual insert returns the `YYYY-MM-DD` string and a `text` IANA name — Drizzle does not convert the date to a JS Date object.
- `pnpm check-types` clean against the new `.$type<BriefingGather>()` / `.$type<FullBriefing>()` / `.$type<IanaTimezone>()` columns.

---

## Phase 3 — Triage v2 implementation (ADR-0042)

Goal: ship the layered pipeline. Deterministic extraction → cheap classifier consuming `SenderContext` only → boss `deepen` escalation with optional user-context lookup → label write-back. Async dossier dispatch on the side.

### 3a. `sender-context.ts` module

`packages/api/src/modules/triage/sender-context.ts`. Pure function `extractSenderContext({ fromHeader, subject, body }) → SenderContext`. ~5ms target; zero LLM calls.

Sub-modules:

- `parseFromHeader(from: string) → { fromKind, displayName, address }` — distinguishes `person` (named human email), `service` (no-reply addresses, recognized service domains), `unknown`.
- `parseBodyActor(senderDomain, body) → BodyActor | null` — dispatches by `From:` domain to a per-service parser. v1 parsers:
  - `parseGithubBodyActor(body)` — extracts `**actor**` markdown bold in first 10 lines; `[bot]` suffix → `kind: 'bot'`.
  - `parseCalendarBodyActor(body)` — iCal `ORGANIZER:` field or "organizer:" line.
  - `parseLinearBodyActor(body)` — "Comment from {actor}" / "{actor} commented".
  - Fallthrough → `null`, which produces `effectiveAuthor: 'unknown'` and trips the escalation gate's `confidence < 0.7` clause.
- `resolveBotSlug(fromAddress, bodyActor) → BotSlug | undefined` — maps known senders/handles to the `BOT_SLUGS` tuple.
- `deriveEffectiveAuthor({ fromKind, bodyActor, botSlug }) → EffectiveAuthor` — the rule set from ADR-0042 §"`SenderContext` shape".

Fixture tests in `packages/api/test/triage/sender-context.test.ts` covering at minimum:

- GitHub `noreply@github.com` with `**coderabbitai** commented` → `effectiveAuthor: 'bot'`, `botSlug: 'coderabbit'`
- Google Calendar invite from `calendar-notification@google.com` with iCal `ORGANIZER` → `effectiveAuthor: 'person'`, `bodyActor.kind: 'person'`
- Linear `notifications@linear.app` with "Comment from Alice" → `effectiveAuthor: 'person'`
- Sentry `noreply@sentry.io` alert → `effectiveAuthor: 'bot'`, `botSlug: 'sentry'`
- Plain person `alice@example.com` → `effectiveAuthor: 'person'`, `botSlug: undefined`
- Unknown service `info@somerandomsaas.com` → `effectiveAuthor: 'unknown'`

### 3b. Classifier prompt evolution

`packages/api/src/modules/triage/classify.ts`. Existing `SYSTEM_PROMPT` updated to:

- Receive `SenderContext` as a typed structured input alongside the email body (not as raw header text). Add the field block to the prompt template.
- Split rule #9 into 9a/9b/9c per ADR-0042 §"Classifier system-prompt evolution":
  - 9a: bot review comments (`botSlug ∈ {coderabbit, copilot-review, github-actions, dependabot, renovate}`) → `fyi` unless body indicates security advisory.
  - 9b: severity-suspect bots (`botSlug ∈ SEVERITY_SUSPECT_BOTS`) → classify on body content alone.
  - 9c: unknown service or unknown effective author → today's behavior.
- Add the `SenderContext` payload to the classifier's user-message JSON so the model doesn't re-parse `From:`.

`classify()` signature gains `senderContext: SenderContext`. The triage workflow's `classify-document` step constructs `SenderContext` first, passes it through. Do **not** pass bio/profile/user-context into the cheap classifier in v1; bio-aware tagging is reserved for `deepen` so the hot path stays fast and cheap.

### 3c. `system.read_user_context` tool + cache

Add `system.read_user_context` before wiring `deepen`, because both the triage boss pass and future boss/sub-agent runs need the same fast profile surface.

- **Contracts:** add `"read_user_context"` to `SYSTEM_ACTIONS`.
- **Tool registration:** `packages/api/src/modules/tools/system.ts` registers `system.read_user_context` with `riskTier: 'no_risk'` and a bounded input schema:

```ts
{
  query?: string;
  include?: Array<'bio' | 'preferences' | 'contacts' | 'projects' | 'relationships' | 'dossiers'>;
  subjectEmail?: string;
  subjectHandle?: string;
}
```

- **Source of truth:** Postgres. Build the response from confirmed `user_facts`, `user_preferences`, `entities`, `entity_relations`, semantic `memory_chunks`, and later `person_profiles` once ADR-0031 is implemented. Redis is only a read-through cache for a compact derived payload (`alfred:user-context:{userId}:v1` or equivalent); cache loss must degrade to a DB rebuild, not memory loss.
- **Invalidation:** broad delete the user-context Redis key on fact/preference/entity/profile writes in v1. Keep the invalidation coarse until real churn says otherwise.
- **Exposure:** system tool, not loadable `memory` integration. Boss and sub-agents may call it without `@memory`, `allowed_integrations`, or HIL approval.
- **Output:** compact, provenance-aware, and capped. Never dump the full memory corpus; return the smallest context that answers the query/include shape.

### 3d. `deepen` workflow step

`packages/api/src/modules/triage/deepen.ts`. New workflow step inserted between `classify-document` and `apply-label`. Gate function:

```ts
type DeepenDecision =
  | { mode: 'execute'; reason: 'severity_suspect_bot' }
  | { mode: 'shadow'; reason: 'low_confidence' | 'unknown_human' }
  | { mode: 'skip' };

function shouldDeepen({ classifier, senderContext, contacts }): DeepenDecision {
  if (senderContext.botSlug && SEVERITY_SUSPECT_BOTS.has(senderContext.botSlug)) {
    return { mode: 'execute', reason: 'severity_suspect_bot' };
  }
  // Shadow-only at v1: log wouldDeepen, but do not execute boss deepen yet.
  if (classifier.confidence < 0.7) return { mode: 'shadow', reason: 'low_confidence' };
  // Shadow-only at v1: contact/memory sparsity can over-fire this branch.
  if (senderContext.effectiveAuthor === 'person' && !contacts.has(senderEmail)) {
    return { mode: 'shadow', reason: 'unknown_human' };
  }
  return { mode: 'skip' };
}
```

Implementation maps `mode` to both notions: `wouldDeepen = mode !== 'skip'`, `wouldDeepenReason = reason`, `deepenExecuted = mode === 'execute'`, and `shadowOnly = mode === 'shadow'`. Initial v1 execution is live for `severity_suspect_bot`; `low_confidence` and `unknown_human` are shadow-only until observed rates are acceptable.

Promotion gates:

- `low_confidence`: after either 200 triaged emails or 7 days of logs, enable live deepen only if `wouldDeepenReason='low_confidence'` fires on <=15% of mail. If it is higher, tune the confidence threshold before enabling.
- `unknown_human`: enable live deepen only if `wouldDeepenReason='unknown_human'` fires on <=5% of mail and a manual spot-check shows the senders are actual people worth dossier work, not newsletters, sales aliases, or weakly parsed service envelopes.
- `severity_suspect_bot`: live from v1.

Step body uses `AlfredAgent` brief-only loop (m13 ADR-0040 sentinel) with:

- System prompt: the deepen brief from ADR-0042 §"`deepen` step shape".
- Allowed tools: `system.read_user_context`, `github.list_repos`, `gmail.thread_history`. Configure GitHub/Gmail via `state.activeIntegrations = ['github', 'gmail']` plus an allowlist on a per-tool basis (no `web_search`, no `send_*`). `system.read_user_context` is always available through the system namespace.
- Output schema: `{ refinedCategory: TriageCategory; severityFlag: 'severe' | 'normal' | 'low'; dossierRequest?: { personEmail: string } }`.

Failure modes (timeout, model error, run failure) → log + return the cheap classifier's output unchanged. The triage workflow never blocks on `deepen` — the path through `apply-label` always runs.

### 3e. Async dossier auto-trigger

If `deepen` emits `dossierRequest` AND the refined category is in `{'urgent', 'action_needed', 'awaiting_reply'}`:

- Check `person_profiles` cache by `email` key. If a row exists and `identity_confidence` × TTL bucket is fresh (`≥0.9 → 90d`, `0.7-0.9 → 30d`, `<0.7 → 7d`), skip — cached dossier is good enough.
- Otherwise enqueue the ADR-0031 `person-research` workflow with `trigger.kind = 'event'`, `event.payload = { personEmail, source: 'triage', triageCategory }`. Fire-and-forget; triage workflow does not await it.
- The dossier UI's "review-before-memory" affordance (ADR-0031) is preserved — auto-trigger doesn't bypass it.

Cache helper: `packages/api/src/modules/cold-start/dossier-cache.ts` with `isDossierFresh({ personEmail, now })`. Reused by both triage and any future caller.

Initial rollout note: the unknown-human branch is shadow-only, so this auto-trigger is code-ready but does not fire from unknown-human eligibility until that branch is promoted live. If a live severity-suspect or manually-forced `deepen` emits a dossier request, the same cache/queue path applies.

### 3f. `triage.sender_extraction` observability event

Logged after every `extract-sender-context → classify → [deepen?]` cycle:

```ts
log.info('triage.sender_extraction', {
  documentId,
  fromKind,
  bodyActor,
  effectiveAuthor,
  botSlug,
  parserHit,              // 'github' | 'calendar' | 'linear' | null
  classifierConfidence,
  classifierCategory,
  wouldDeepen,            // boolean
  wouldDeepenReason,      // 'low_confidence' | 'severity_suspect_bot' | 'unknown_human' | undefined
  deepenExecuted,         // boolean; v1 true only for severity_suspect_bot
  shadowOnly,             // boolean; true for low_confidence / unknown_human during rollout
  refinedCategory,        // present iff deepenExecuted
  dossierRequested,       // boolean
});
```

Sink is the standard pino logger; Langfuse tracing already covers the `deepen` LLM call separately. The event is what drives bot-allowlist and body-parser growth — adds happen from observed log evidence, not speculation (ADR-0042 §"Coverage observability").

### Phase 3 acceptance

- `packages/api/test/triage/sender-context.test.ts` green for the 6+ fixture cases.
- Integration test: an email with `From: noreply@github.com` + `**coderabbitai** commented` produces `effectiveAuthor: 'bot'`, `botSlug: 'coderabbit'`, classifier emits `fyi`, no `deepen` fires.
- Integration test: an email with `From: noreply@sentry.io` + "error spike" body produces `effectiveAuthor: 'bot'`, `botSlug: 'sentry'`, `deepen` fires (severity-suspect), refined category in `{urgent, action_needed}`.
- Integration test: a context-sensitive service email only changes category in `deepen` after `system.read_user_context` returns relevant user-owned project/company context; the cheap classifier remains email-only.
- Integration test: an unknown human sender (`alice@somecompany.com`) lands in `urgent` → `triage.sender_extraction` logs `wouldDeepen=true`, `wouldDeepenReason='unknown_human'`, `shadowOnly=true`, and no boss deepen/person-research enqueue occurs during the shadow rollout.
- Integration test: a low-confidence classifier result logs `wouldDeepen=true`, `wouldDeepenReason='low_confidence'`, `shadowOnly=true`, and no boss deepen call occurs during the shadow rollout.
- Promotion report fixture: aggregate `triage.sender_extraction` logs can compute `low_confidence` fire rate, `unknown_human` fire rate, and sample size for the 200-email / 7-day gate.
- After the unknown-human branch is promoted live, or when a dossier request is manually forced, re-running the same scenario within 30 days of a cached `identity_confidence: 0.8` dossier → no `person-research` enqueue.
- `triage.sender_extraction` events present in logs for every classification.
- `deepen` model failure (mock 500) does not fail the triage workflow; `apply-label` still runs with cheap classifier output.
- Redis miss for `system.read_user_context` rebuilds from Postgres and repopulates the cache; Redis loss does not lose user memory.

---

## Phase 4 — Briefing v2 implementation (ADR-0041)

Goal: ship the cross-source gather + single-call boss compose + per-surface render path. New `briefings` writes; legacy `briefing_runs` continues to back the live morning email until Phase 6 cutover.

### 4a. `BriefingContributor<T>` registry + v1 sources

`packages/api/src/modules/briefing/contributors/` directory. One file per source; each exports a `BriefingContributor<T>`.

- `email.ts` — joins `email_triage` to `documents` over the prior 24h window in user tz. Returns `EmailContribution { categories: { [TriageCategory]: Array<{ documentId, threadId, subject, sender, snippet }> } }`.
- `calendar.ts` — `googleClient.calendar.events.list` for `today` in user tz. Returns `CalendarContribution { events: Array<{ eventId, title, start, end, attendees, location }> } | null`. Returns `null` if `calendar.events.readonly` scope not granted (Phase 5 prerequisite). `null` is part of the schema; composer handles "no calendar" verbatim.
- `integration-activity.ts` — gathers normalized operational activity. v1 producers:
  - GitHub direct API: PRs awaiting user review + commits authored yesterday, returning `IntegrationActivityItem[]` with `source='direct_api'`, `provider='github'`, and provider-scoped `providerKind` values such as `github.pr_review_requested` / `github.commit_authored`.
  - Email triage backfill: selected severity-suspect service mail from the prior 24h can become `IntegrationActivityItem[]` with `source='email_triage'` when no direct provider API exists yet. Provider-specific examples include deployment, incident, billing, security, docs, or project-management systems, depending on connected integrations and observed email.
  - Future producers: provider modules are added under this contributor as integrations land, rather than new top-level gather sources by default.
- `weather.ts` — Open-Meteo fetch (no key) keyed on `user_preferences.location` or `WEATHER_FALLBACK_CITIES[timezone]`. Cached in Redis under `briefing:weather:{lat}:{lng}:{briefingDate}` for the day. Returns `WeatherContribution { current, forecast } | null`.
- `day-of-week.ts` — pure `Intl.DateTimeFormat` + small holiday const table (US/IN at v1, expandable). Returns `DayOfWeekContribution { dayName, isWeekend, holiday? }`. Always non-null.

Registry: `getBriefingContributors() → BriefingContributor<unknown>[]`. The gather step `Promise.allSettled`s them — a single source failing does not fail the gather. Failed sources land as `null` in the resulting `BriefingGather`.

Activity rollup runs inside `integration-activity.ts` before the composer sees the gather. It suppresses raw event noise and emits only unresolved or notable clusters:

- A failed deployment followed by a successful deployment for the same project/service/branch is suppressed by default.
- The cluster is retained when it is still unresolved, has `severity='critical'`, required clear user attention, had >=3 failed attempts, lasted >30 minutes from first failure to recovery, or is a meaningful day-level accomplishment.
- Retained clusters keep rollup metadata (`eventCount`, `attemptCount`, `durationMinutes`) so the composer can explain why it matters without seeing every raw event.
- Suppressed raw event ids are kept only in logs/diagnostics, not in the prompt.

### 4b. Reference resolver + Segment types

`packages/api/src/modules/briefing/references.ts`. Per ADR-0041 §"Reference resolution layer":

- `Segment` discriminated union (`text | activity | meeting | email`).
- `resolveBriefingReferences(markdown: string, gather: BriefingGather) → { segments: Segment[]; unresolved: string[] }`. Tokenizer parses `[[<kind>:<id>]]` placeholders against the gather's enumerated entities. Unknown placeholders fall back to a plain-text `<kind>:<id>` segment and append to `unresolved`.
- Two renderers: `renderBriefingEmailHtml(segments) → { html, text }` and `renderBriefingApp(segments) → ReactNode` (the latter in `apps/web`).

Test cases (`packages/api/test/briefing/references.test.ts`):

- `"Review [[activity:github:pr:warden#9]]"` resolves to `[text, activity]` segments with the matching gather row.
- `"[[activity:github:pr:warden#999]]"` (not in gather) → unresolved fallback `"github:pr:warden#999"` text + `unresolved: ['activity:github:pr:warden#999']`.
- Mixed prose `"On a quiet day... but check [[email:thr_abc]]"` segments correctly.
- Adjacent placeholders `"[[activity:a]] and [[activity:b]]"` produce two `activity` segments separated by text `" and "`.

### 4c. Composer rewrite

`packages/api/src/modules/briefing/compose.ts`. Replace the existing deterministic-template path with:

```ts
export async function composeBriefing(args: {
  userId: string;
  briefingDate: string;       // YYYY-MM-DD in user tz
  timezone: IanaTimezone;
  gather: BriefingGather;
}): Promise<{ breakingSummary: string; fullBriefing: FullBriefing; modelId: string }>
```

Implementation:

- Build the system prompt per ADR-0041 §"Composer output schema" — enumerate available references explicitly, instruct to emit `[[<kind>:<id>]]` verbatim, never URLs, and ask for source-backed `why` rationale rather than model reasoning.
- Single `meteredGenerateText` call with `getBossModel()`, `output: zod(briefingComposerSchema)`, `attribution: { kind: 'briefing', userId, runId }`.
- After compose/reference resolution, call `buildBriefingSourcePanels(gather, resolvedReferences)` to deterministically attach `fullBriefing.sourcePanels`. The composer model never authors source-panel rows.
- Empty-state tone rule baked into the prompt (the "earned the quiet" canonical example).
- Failure fallback: deterministic template render of `gather` → `breakingSummary` + a minimal `fullBriefing`. If the fallback email sends, the row reaches `status='sent'` with `compose_fallback=true`; composer degradation is not delivery failure.

### 4d. Workflow rewrite + delivery

`packages/api/src/modules/briefing/queue.ts` and `workflow-input.ts`. The morning-briefing workflow shape stays `gather → compose → send` but each step changes:

- `gather` step: `Promise.allSettled` across `getBriefingContributors()`. Persist the resulting `BriefingGather` to the in-progress `briefings` row (status='gathering' → 'composing').
- `compose` step: call `composeBriefing(...)`. Update the row with `breaking_summary`, `full_briefing`, `model`. Status → 'composing' → 'sent' after `send`.
- `send` step: `resolveBriefingReferences(breakingSummary, gather)` + `renderBriefingEmailHtml(segments)` + call `notify({ userId, kind: 'briefing', idempotencyKey: 'briefing:' + briefingDate, ... })` via the existing m10 `notify()` helper. Link the resulting `email_sends.id` back to `briefings.email_send_id`.

Idempotency: `INSERT INTO briefings ... ON CONFLICT (user_id, briefing_date) DO NOTHING RETURNING id` at the start; if the conflict short-circuits with an already-`sent` row, the workflow no-ops. Re-run on a `failed` row is allowed; the row transitions back through the status machine.

### 4e. In-app surface (web)

Briefing detail route in `apps/web/src/routes/-app/briefings/$date.tsx` (or under the existing app shell). Read via Replicache (Phase 4f). Renders:

- `headline` as section title.
- `sections[]` as collapsible panels keyed by `source` (with a small icon per `GatherSourceSlug`), borrowing the chat page's visual grammar from `DimensionChatThread`: prose first, compact source rows, and accordion-style detail disclosure.
- `sections[].why` as a collapsed "Why included" row. This is user-facing rationale, not raw model reasoning.
- `sourcePanels[]` for source/detail accordions. The web route renders these normalized panels instead of branching over raw `gather.email`, `gather.calendar`, `gather.integration_activity`, etc. Panels are generated by code after compose, so they stay faithful to source data.
- `auditSummary` as a muted "Briefing notes" disclosure under the fold or diagnostics-only. It should mention rollup decisions like suppressed deploy noise, not chain-of-thought.
- Reference segments rendered via `<EntityChip kind={...} />` components in `apps/web/src/components/briefing/entity-chip.tsx`. One chip variant per `BriefingReferenceKind`.
- Email render includes only `breakingSummary` plus a bottom `View full briefing` link to this route.

Briefing list route at `/briefings` — Replicache-backed scroll over the last 30 days.

### 4f. Replicache sync

Per `CLAUDE.md` "Replicache" recipe:

- `IDB_KEY.briefing` in `packages/sync/src/keys.ts` — prefix `idb/briefing/`, per-row key `idb/briefing/{briefingDate}`.
- Read schema in `packages/sync/src/schemas.ts`: `{ id, briefingDate, timezone, status, breakingSummary, fullBriefing, gather, modelId?, rowVersion }`. Inferred type exported through `packages/sync/src/types.ts`.
- No client mutators at v1 — workflow is the only writer.
- `ENTITY_FETCHERS.briefing` in `packages/api/src/modules/replicache/pull.ts` — filters to `user_id = current_user AND briefing_date >= now() - 30 days`. Bump `row_version` on every `briefings` UPDATE inside the workflow.
- Pokes fire generically from the push handler after commit.

History route `/api/briefings/history?before=...` for pulls older than 30 days. Plain paginated read, no Replicache involvement.

### Phase 4 acceptance

- `pnpm --filter @alfred/api test briefing/references` green.
- Manual smoke: trigger morning-briefing workflow for the dev user → `briefings` row appears with status `sent`, `breaking_summary` non-empty, `full_briefing.sections.length >= 1`, an `email_sends` row linked.
- `breaking_summary` references resolve in the rendered email HTML to bold + icon + anchor; unresolved fallbacks log to `briefing.references.unresolved` with the placeholder content.
- `apps/web` `/briefings/{today}` route renders the full briefing with entity chips for each placeholder kind that fired in the prose, normalized `sourcePanels`, collapsible `why` disclosures, and no raw reasoning field.
- Replicache pull returns `briefing` rows for the last 30 days; older briefings reachable via `/api/briefings/history`.
- Composer model failure (mock model error) flows to deterministic-template fallback; if email sends, row reaches `status='sent'` with `compose_fallback=true`.

---

## Phase 5 — OAuth scope additions + integration prerequisites

Goal: light up Calendar + the first `integration_activity` producer (GitHub) and the Weather/location settings UI.

### 5a. Google Calendar scope

- Add `https://www.googleapis.com/auth/calendar.events.readonly` to `GOOGLE_FEATURE_SCOPES.briefing` in `packages/integrations/src/google/scopes.ts` (or whichever file the per-feature scope map lives in).
- Update the OAuth consent flow in `packages/integrations/src/google/oauth.ts` to request the expanded scope set on the `briefing` feature toggle.
- Per `CLAUDE.md` "Auth — GCP setup", confirm the OAuth client redirect URIs and ensure the Google Calendar API is enabled in the GCP project (already required for any calendar work; verify, don't assume).
- Re-consent prompt surfaces in the existing integrations settings page when the user enables briefing or the calendar contributor is wired.

### 5b. GitHub `repo` scope for `integration_activity`

- Bump `GITHUB_OAUTH_SCOPES` in `packages/integrations/src/github/oauth.ts` from `read:user` to `read:user repo`.
- "Reconnect" CTA on the GitHub integration tile in settings — the existing tile derives `status: "connected"` from credential row presence; add a `scopesGranted` check and surface a "Reconnect for briefing activity data" affordance when `repo` is missing.
- Scope tradeoff: classic OAuth `repo` is broad, but it is the pragmatic v1 route for private repo activity in a single-user app. Keep the re-consent explicit and user-facing. Revisit GitHub App / fine-grained token shape if this grows beyond personal use or the user's repo footprint makes classic `repo` uncomfortable.
- The user has to actively re-consent — there is no silent scope upgrade.

### 5c. Weather + location

- Open-Meteo client in `packages/integrations/src/weather/open-meteo.ts` (new sub-package or sibling under integrations). No API key; daily forecast endpoint.
- Redis cache helper in `packages/api/src/modules/briefing/contributors/weather.ts` keyed on `(lat, lng, briefingDate)` with 24h TTL.
- Settings UI in `apps/web/src/routes/-app/settings/preferences.tsx` (or analogous existing route) — small location picker (manual lat/lng + label) writing to `user_preferences.location`. Fallback chain visible to the user: "Using {label}" / "Falling back to {timezone}'s default".

### 5d. Contributor `null` paths verified

- Calendar contributor returns `null` until 5a + user re-consent. Composer prompt produces "no meetings today" without crashing.
- GitHub activity producer returns `[]` until 5b + user re-consent. Composer omits GitHub activity references.
- Weather contributor returns `null` if Open-Meteo is down. Composer omits weather section.

### Phase 5 acceptance

- Dev user re-consents the Google scope → next briefing run produces a non-null `CalendarContribution` in `gather`.
- Dev user re-consents GitHub → next briefing run produces non-empty `IntegrationActivityContribution.items` when there is PR/commit activity.
- Settings page surfaces location preference; toggling it changes the next-day weather fetch coordinates.
- Briefing for a user with no Calendar/GitHub consent still ships successfully with `gather.calendar = null` and `gather.integration_activity.items = []`; composer prompt handles the empty case.

---

## Phase 6 — Cutover + legacy retirement + doc reconciliation

Goal: flip the live morning briefing onto the new path; reconcile docs; deprecate legacy.

### 6a. Workflow cutover

- Flip the morning-briefing workflow to write `briefings` (Phase 4d) instead of `briefing_runs`. The composer + send path uses the new resolver.
- Run dual-write for one cycle (writes to both tables) if needed for diffability; default plan: hard cutover, since `briefing_runs.body_html` is read-only diagnostics and the surface-of-truth is now Replicache.
- The legacy "watermark + slot" read path in `gatherBriefingDigest` is replaced by the new contributors. Evening briefing (if it existed as a slot) is parked — ADR-0041 §"Trigger model unchanged" is morning-only at v1; evening lands when product asks for it.

### 6b. Legacy retirement

- Mark `briefing_runs` schema deprecated with a top-of-file comment pointing at `briefings`.
- Remove the `slot`-aware code paths from `apps/web` if any surface the legacy rows directly (they shouldn't — the new Replicache key is the only client read).
- Schedule `DROP TABLE briefing_runs` for a later milestone once the team has confidence the new path is stable for at least a week. Not in this plan; tracked as a follow-up.

### 6c. Doc reconciliation

- `docs/triage.md` — update 6-category statement to 10; add `SenderContext` section + `deepen` step + dossier auto-trigger explanation; link ADR-0042. Roll the existing m9 prose into the new flow rather than rewriting from scratch — keep the "Sources of truth" framing.
- `docs/briefing.md` — supersede the m10 deterministic-render explanation; document the five-source gather, single-call compose, reference resolver, `briefings` table, Replicache surface; link ADR-0041.
- `packages/integrations/src/google/labels.ts` — verify `TRIAGE_CATEGORIES` re-export from `@alfred/contracts/triage` is still the single source of truth; remove any local 6-category drift.
- `CLAUDE.md` — update the "Milestone status" entry for m9 and m10 to point at the new ADRs and reference this plan.
- `CONTEXT.md` already has the new triage and briefing glossary sections from the working tree diff — no extra changes needed here, just verify post-merge.

### 6d. Particles UI tweak (working tree carry-over)

The `dispersed` prop on `apps/web/src/components/ui/particles.tsx` + the chat-shell wiring in the working diff are unrelated to triage/briefing but are in-flight. Ship them in their own PR ahead of or alongside Phase 6 — they have no dependency on the rest of this plan but block a clean diff.

### Phase 6 acceptance

- Morning briefing for the dev user writes only to `briefings` (no `briefing_runs` row created).
- `docs/triage.md` and `docs/briefing.md` accurately describe live behavior.
- `pnpm check:web-boundaries` clean.
- `CLAUDE.md` milestone status reflects m9 / m10 amendments.

---

## Phase 7 — Smokes

Goal: prove the whole pair works end-to-end as features.

### 7a. `smoke-triage-v2.ts`

`apps/server/src/scripts/smoke-triage-v2.ts`. Fixtures (mock or real) covering the four canonical paths from Phase 3 acceptance, run against the dev user's Gmail:

- Bot review comment → `fyi`, no `deepen`.
- Severity-suspect bot alert → escalation, refined category in `{urgent, action_needed}`.
- Unknown human in `urgent` during shadow rollout → `wouldDeepen=true`, `shadowOnly=true`, no `deepen`, no `person-research` enqueue.
- Cached-dossier replay → no re-enqueue within TTL.

Capture the `triage.sender_extraction` log lines and assert their shape.

### 7b. `smoke-briefing-v2.ts`

`apps/server/src/scripts/smoke-briefing-v2.ts`. Triggers a real morning briefing for the dev user with all five contributors wired (post Phase 5 scope re-consent). Asserts:

- `briefings` row with `status='sent'`, non-empty `breaking_summary` and `full_briefing.sections`.
- At least one resolved entity reference in each surface.
- `email_sends` row linked.
- Replicache pull surfaces the row to the connected web client.

Falls back gracefully if any contributor returns `null` — the smoke asserts the composer's empty-case prose path actually fires for missing sources.

### 7c. Reference-resolver fuzz

`packages/api/test/briefing/references.fuzz.test.ts` — generate ~200 randomized markdown bodies with mixed placeholder kinds (valid + invalid), verify:

- All valid placeholders resolve to typed segments.
- All invalid placeholders land in `unresolved[]` with the inner label preserved as text.
- No exceptions thrown for adversarial input (`[[]]`, `[[activity:]]`, `[[:foo]]`, nested `[[[[activity:x]]]]`).

### Phase 7 acceptance

- `pnpm smoke-triage-v2` and `pnpm smoke-briefing-v2` complete green against the dev environment.
- Reference fuzz green.
- Captured smoke output attached to the milestone PR.

---

## Status board (update inline as work lands)

- [ ] **Phase 1** — Foundations: `@alfred/contracts/triage.ts` + `briefing.ts` + `weather.ts`; `AttributionKind` move + `'briefing'`
- [ ] **Phase 2** — Schema: `briefings` table, `person_profiles` cache-key amendment, `user_preferences.location`
- [ ] **Phase 3** — Triage v2: `sender-context.ts` + parsers, classifier 9a/9b/9c, `deepen` step, dossier auto-trigger, observability event
- [ ] **Phase 4** — Briefing v2: contributors, reference resolver, compose rewrite, workflow + delivery, in-app surface, Replicache
- [ ] **Phase 5** — OAuth + integrations: Google `calendar.events.readonly`, GitHub `repo`, Open-Meteo + location pref
- [ ] **Phase 6** — Cutover + docs: workflow flip, legacy `briefing_runs` deprecation, `docs/triage.md` + `docs/briefing.md` reconciliation, particles UI tweak ship
- [ ] **Phase 7** — Smokes: `smoke-triage-v2.ts`, `smoke-briefing-v2.ts`, reference fuzz
