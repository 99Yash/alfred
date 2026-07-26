# ADR-0042 — Email triage v2: layered pipeline with deterministic sender extraction + cheap classifier + boss escalation + async dossier trigger


**Decision.** Email triage becomes a four-step workflow: `extract-sender-context → classify → [deepen?] → apply-label`. The middle two steps form a layered classifier: a cheap-tier LLM handles the obvious bulk from email + `SenderContext` only; a boss-agent `deepen` step fires only when the gate's three conditions are met and is the only path where broader user bio/profile context affects tagging. The deterministic extraction step at the head exists so neither LLM step has to parse email headers — that's regex work. The dossier-research side-effect for unknown important human senders fires async from `deepen`, with TTL-based caching of completed dossiers in `person_profiles` once ADR-0031 is implemented.

Seven coordinated micro-decisions:

1. **Deterministic `extract-sender-context` step.** Parses `From:` + body and emits a typed `SenderContext` (`{ fromKind, bodyActor?, effectiveAuthor, botSlug? }`). Lives in `packages/api/src/modules/triage/sender-context.ts`. Zero LLM cost; ~5ms; output threaded through workflow state into the classifier.
2. **Cheap classifier consumes `SenderContext`, not user bio.** Today's classify step keeps its cheap-tier model and 10-bucket taxonomy; the system prompt evolves to consume `SenderContext` as a first-class input. Rule #9 splits into 9a/9b/9c: bot review comments → `fyi`; severity-suspect bot alerts → classify on body content alone; unknown service envelopes → today's behavior. Bot identification stops being prompt-derived; severity judgment stays prompt-derived. The cheap path deliberately stays email-only: it does not load the user's biography, long-term memory, or profile context. Bio-aware tagging belongs to `deepen`, so obvious mail stays fast and cheap while ambiguous/high-impact mail gets the richer boss pass.
3. **`deepen` step, boss-tier, gated.** Eligibility is any of: classifier `confidence < 0.7`, OR `senderContext.botSlug ∈ SEVERITY_SUSPECT_BOTS`, OR `effectiveAuthor === 'person'` AND sender not in confirmed contacts. Initial live rollout executes only the severity-suspect bot branch; the low-confidence and unknown-human branches run in shadow/log-only mode (`wouldDeepen`, reason, classifier distribution) until the observed rate is acceptable. The live `deepen` path runs a brief-only `AlfredAgent` loop (ADR-0040 sentinel) with a read-only tool surface: `system.read_user_context`, `github.list_repos`, `gmail.thread_history`. Web search is *not* in the deepen tool surface — that budget belongs to the async dossier workflow (see "deepen step shape" below). Outputs a refined category, a severity flag, and an optional `request_dossier(personEmail)` side-effect. Failure (model timeout, m13 hiccup) falls back to the cheap classifier's output — triage never blocks on the boss.
4. **Async dossier auto-trigger via `person-research`.** When `deepen` returns `request_dossier` for an unknown human in `urgent` / `action_needed` / `awaiting_reply`, enqueues the ADR-0031 workflow as a side-effect. The current email's classification does NOT wait — it ships on classifier + deepen output alone. Future emails from the same sender benefit from the now-cached dossier.
5. **Dossier cache via `person_profiles` with confidence-tier TTL.** ADR-0031's saved profile IS the cache; no new table. Cache key is the stable sender identifier: `email` for direct senders, `service:handle` for body actors (`github:coderabbitai`). TTL by `identity_confidence`: ≥0.9 → 90d, 0.7-0.9 → 30d, <0.7 → 7d. Re-research fires when stale AND sender lands in an important triage category (or via explicit user refresh).
6. **`system.read_user_context` as the fast profile surface.** Boss and sub-agents can query compact user context through a system tool, not a loadable `memory` integration. The tool is always available, autonomy-overridden like other `system.*` tools, and returns bounded, provenance-aware slices from user facts, preferences, entities/relations, semantic memory chunks, and later saved `person_profiles`. Postgres remains the source of truth; Redis is a read-through cache for the derived profile/slices (for example `alfred:user-context:{userId}:v1`) and is invalidated when memory/facts/preferences/profile rows change. The model-facing concept is "user context" because this is runtime context the boss needs for judgment, not a generic memory corpus dump.
7. **Coverage observability.** New logging event `triage.sender_extraction` per email, recording `{ fromKind, bodyActor?, effectiveAuthor, botSlug?, parserHit?, classifierConfidence, wouldDeepen, wouldDeepenReason?, deepenExecuted, shadowOnly }`. The bot allowlist and body-actor parser set grow from observed log data, not speculation.

**Why this is its own ADR.** ADR-0025 #1's 2026-05-21 amendment widened *what* triage outputs (6 → 10 buckets). This ADR widens *how* triage decides — different cost/latency tradeoffs, a new pipeline step, a new dependency on m13's boss runtime, a new auto-trigger contract amending ADR-0031. Different shape, different blast radius.

**Pipeline.**

```
ingest doc (gmail.poll_recent or gmail.poll_history)
  ↓
extract-sender-context           deterministic, ~5ms
  ↓                              SenderContext { effectiveAuthor, ... }
classify                          cheap LLM, ~500ms
                                  email + SenderContext only; no bio/profile lookup
  ↓                              category, confidence, rationale
[deepen?]                         live iff senderContext.botSlug ∈ SEVERITY_SUSPECT_BOTS
                                  shadow iff confidence < 0.7
                                  shadow iff effectiveAuthor === 'person' AND not in contacts
                                  boss may query system.read_user_context
  ↓                              refined category, severityFlag, dossierRequest?
apply-label                       deterministic, Gmail messages.modify
                                  + thread-sibling alfred-label strip
[fire-and-forget]
  person-research workflow if dossierRequest
```

**`SenderContext` shape (in `@alfred/contracts`).**

```ts
export const SENDER_KIND = ['person', 'service', 'unknown'] as const;
export type SenderKind = (typeof SENDER_KIND)[number];

export const EFFECTIVE_AUTHOR = ['bot', 'person', 'service', 'unknown'] as const;
export type EffectiveAuthor = (typeof EFFECTIVE_AUTHOR)[number];

export const BOT_SLUGS = [
  'coderabbit', 'copilot-review', 'github-actions', 'dependabot', 'renovate',
  'vercel', 'sentry', 'stripe-billing', 'google-security', 'datadog',
] as const;
export type BotSlug = (typeof BOT_SLUGS)[number];

export interface SenderContext {
  fromKind: SenderKind;
  bodyActor?: {
    kind: 'bot' | 'person' | 'unknown';
    name: string;            // 'coderabbitai', 'alice', 'dependabot[bot]'
    handle?: string;         // GitHub handle when extractable
  };
  effectiveAuthor: EffectiveAuthor;
  botSlug?: BotSlug;         // populated when effectiveAuthor === 'bot' AND recognized
}
```

**Severity-suspect bot allowlist.** A const subset of `BOT_SLUGS` indicating "this bot CAN be urgent, so escalate to `deepen` even if the cheap classifier said `fyi`":

```ts
export const SEVERITY_SUSPECT_BOTS: ReadonlySet<BotSlug> = new Set([
  'sentry',           // alert: errors spiking
  'stripe-billing',   // payment failure breaks access today
  'google-security',  // sign-in verification, account compromise
  'vercel',           // deploy fail on user's own project
  'datadog',          // SLO breach, incident
]);
```

CodeRabbit / Copilot review / Dependabot / Renovate / GitHub Actions are deliberately *not* in this set — their messages are advisory in 99% of cases. If a Dependabot PR is genuinely severe (high-CVE security alert), the classifier's text-content reasoning catches it on rule 9a's exception clause, not via the sender-severity-suspect heuristic.

**Body-actor parsers (v1).** Three sources cover ~80% of bot/human disambiguation in real inboxes:

| Source | Detection | Parser |
| --- | --- | --- |
| GitHub          | `From: noreply@github.com`              | Extract `**actor**` markdown bold in first ~10 lines; `[bot]` suffix → bot; otherwise person |
| Google Calendar | `From: calendar-notification@google.com`| Parse iCal `ORGANIZER` field or "organizer:" line in body                                   |
| Linear          | `From: notifications@linear.app`         | Parse "Comment from {actor}" / "{actor} commented" line                                     |

Each parser is ~30 LOC, tested with fixture emails in `packages/api/test/triage/sender-context.test.ts`. Long-tail sources (Notion, Slack, Vercel deploy notifications, Jira) fall through to `effectiveAuthor: 'unknown'` — the escalation gate's `confidence < 0.7` clause is the safety net.

**Classifier system-prompt evolution.** Rule #9 today (*"Automated alerts that demand a remediation step → 'urgent' if same-day else 'action_needed'. NOT 'fyi'."*) splits into:

```
9a. Bot review comments (effectiveAuthor === 'bot' AND botSlug ∈
    {coderabbit, copilot-review, github-actions, dependabot, renovate}):
      → 'fyi'. Advisory at best; the user can scan when they want.
      EXCEPTION: escalate to 'action_needed' or 'urgent' only if body text
      indicates a security advisory (CVE, vulnerability, secret exposed),
      regardless of bot identity.

9b. Severity-suspect bot alerts (effectiveAuthor === 'bot' AND
    botSlug ∈ SEVERITY_SUSPECT_BOTS):
      Classify on body content alone — 'urgent' if same-day-actionable
      (Sentry error spike, Stripe payment failure breaking access,
      Google sign-in verification, Vercel deploy failure on the user's
      project), 'action_needed' otherwise.

9c. Unknown bot or service envelope (effectiveAuthor === 'service' AND
    no botSlug, OR effectiveAuthor === 'unknown'):
      Today's behavior — classify on body content alone.
```

**`deepen` step shape.** Boss brief-only run with a fixed brief:

```
Refine the triage classification for this email. The cheap classifier
output: {category, confidence, rationale}. The sender context: {SenderContext}.

Use the read-only tools to gather context:
  - system.read_user_context : user's compact bio/profile, preferences, known contacts,
                               important people, current company/projects, and saved dossiers
  - github.list_repos   : is the user's relationship to a service active?
  - gmail.thread_history: prior interactions with this sender

Return:
  - refinedCategory: one of TRIAGE_CATEGORIES (may equal cheap classifier output)
  - severityFlag:   'severe' | 'normal' | 'low'
  - dossierRequest?: { personEmail } if web search would be valuable but
                     you didn't run it (the async dossier workflow handles it)
```

The boss is *not* invited to call `web_search` directly — that's web search budget that belongs to the async dossier workflow, not to per-email triage. The `dossierRequest` side-effect surfaces the request; the triage workflow enqueues `person-research` separately.

**User-context tool.** `system.read_user_context` is the always-available profile/memory read surface for the boss runtime. It should accept a bounded query shape such as `{ query?: string; include?: ('bio'|'preferences'|'contacts'|'projects'|'relationships'|'dossiers')[]; subjectEmail?: string; subjectHandle?: string }` and return a compact result with provenance. It may read from Redis first for speed, but the cached value is derived from Postgres-owned state (`user_facts`, `user_preferences`, `entities`, `entity_relations`, `memory_chunks`, and eventually `person_profiles`). Redis loss only causes a cache miss; it must not lose memory.

**Shadow rollout.** `triage.sender_extraction` logs both eligibility and execution: `wouldDeepen`, `wouldDeepenReason`, `deepenExecuted`, and `shadowOnly`. v1 executes `deepen` for `severity_suspect_bot`; `low_confidence` and `unknown_human` are shadow-only until each branch clears its own promotion gate. `low_confidence` can go live after 200 triaged emails or 7 days of logs if it fires on <=15% of mail; above that, tune the confidence threshold before enabling. `unknown_human` can go live only if it fires on <=5% of mail and a manual spot-check shows the matched senders are real people worth dossier work. This keeps the high-signal safety branch live without accidentally routing a large fraction of inbox traffic through boss-tier due to uncalibrated confidence scores or sparse contacts.

**Failure model.** If `deepen` fails (model timeout, boss runtime error, m13 phase regression), the workflow logs the failure and proceeds to `apply-label` with the cheap classifier's output. Triage never blocks; the user always gets a label. The History tab surfaces the failure for diagnosis.

**Cost calculus (100 emails/day single user).**

| Phase | Calls/day | Tier | $/day |
| --- | --- | --- | --- |
| Extract sender context  | 100       | regex    | 0       |
| Classify                | 100       | cheap    | ~$0.01  |
| Deepen                  | ~10 (10% escalation) | boss    | ~$0.20  |
| Dossier (new sender, rate-limited) | ~1 | research | ~$0.05  |
| **Total**               |           |          | **~$0.26/day** |

vs **pure boss agent on every email**: 100 × ~$0.02 = ~$2.00/day. **10x cost reduction** for the obvious 90% of email, with the boss's judgment exactly where it adds value. The bigger structural argument is latency: the cheap path returns a Gmail label in ~1s; pure-boss takes ~10s. For an inbox-tagging job that fires per-message, that delta is the difference between "feels real-time" and "feels broken."

**Alternatives.**

- (a) **Pure boss agent on every email.** Single mental model; richest reasoning. Rejected — 10x cost, 10x latency, depends on m13 phase 4 landing solid before m9 cleanup can ship. At single-user scale cost isn't crippling, but the latency story is the real disqualifier.
- (b) **Bot detection inside classifier prompt only.** Cheapest to ship. Rejected — classifier becomes parser + judge; parsing GitHub email headers in natural language is exactly what regex is for; prompt-rule precedence degrades past ~12 rules (we're at 11 today).
- (c) **Post-classifier deterministic re-score.** Classifier runs unchanged; a deterministic step adjusts output. Rejected — classifier's `rationale` field gets out of sync with the final category ("Rationale: code review owed. Category: fyi." reads as a bug to anyone auditing).
- (d) **Sync dossier in `deepen`.** Boss blocks on web search + dossier compose during triage. Rejected — dossier work is 30-60s; blocking triage on it means the Gmail label arrives 30s late. Async via `person-research` is the right cadence split.
- (e) **Speculative dossier on every new human sender.** Rejected — generates dossiers for cold-outbound sales pitches and one-off senders. Wasteful. The gate's "important triage category" clause is the right filter.
- (f) **User-triggered dossiers only (no auto-trigger).** Rejected — the whole point of "if it's a human, maybe Google search them" is for Alfred to do the work proactively; the escalation gate already has the signal it needs.
- (g) **Pass user bio/profile context into the cheap classifier.** Rejected for v1 — it makes every email classification depend on a memory/profile fetch and widens the prompt for the 90% obvious path. Bio-aware tagging is valuable, but it belongs to the boss `deepen` path where the added context can actually adjudicate ambiguity.
- (h) **Make Redis the source of truth for user context.** Rejected — user profile and memory state must survive Redis loss and remain inspectable/editable through the durable memory tables. Redis is a speed layer over a compact derived profile, not the memory store.
- (i) **Enable every `deepen` trigger live on day one.** Rejected — classifier confidence calibration and contact/memory coverage are unknown. Live severity-suspect bots are narrow and high-signal; low-confidence and unknown-human branches need shadow data first.

**Open.**

- Bot allowlist storage migration to DB-backed when it grows past ~20 entries. Hardcoded const is the right scale at v1.
- Body-actor parsers beyond GitHub / Calendar / Linear — add per observed-data evidence, not speculation.
- Email-tagging leniency and activity extraction from service mail are related but separate from this ADR's core shape. Revisit after the shadow logs show how often service envelopes / provider emails are being over- or under-tagged.
- Whether to surface escalation reasons in the History tab UI ("deepened because confidence was 0.6") for tunable observability.
- Whether `deepen`'s read-only tool surface needs a per-tool `read_only=true` flag at the registry level, or whether the tool selection in the workflow brief is sufficient (current take: brief sufficient; structural flag only if a future workflow needs to enforce read-only across all calls).
