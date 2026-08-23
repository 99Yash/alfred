# ADR-0041 — Daily briefing v2: cross-source LLM compose, split surface, `briefings` entity

**Decision.** The daily briefing is rebuilt around six coordinated micro-decisions, superseding the m10 deterministic-render path and widening the inbox-only fidelity bound from ADR-0033:

1. **Cross-source gather.** Five contributions feed each day's briefing: email triage rollup, Google Calendar (today's events), integration activity (GitHub first planned direct producer; other providers later only when their integrations exist), weather (Open-Meteo, location resolved from prefs/memory), day-of-week + holidays. Each source exposes `collectBriefingContribution(userId, date) → BriefingContribution` — same extensibility pattern as ADR-0011's cold-start signals. Future operational providers bolt on as activity producers without adding a new top-level briefing source.
2. **Single LLM compose call (boss-tier).** `gather → compose → send` stays the workflow shape, but `compose` becomes one `meteredGenerateText` call with `getBossModel()` and `output: zod(briefingComposerSchema)`. Cheap-tier produces flat tone-deaf prose for the warmth this surface needs; the per-day cost (~$0.02) is the right place to spend.
3. **Two artifacts from one composer call.** `breakingSummary` (4-6 lines of markdown) is the email body source; `fullBriefing` (`{ headline, sections: { source, label, body, why?, references? }[], sourcePanels?, auditSummary? }`) is the in-app surface. Single call emits both prose surfaces — they cannot drift in tone or facts because they share a generation. The full page exposes source-backed inclusion rationale, not raw model reasoning. Raw `gather` stays stored for audit/replay, and deterministic code builds `sourcePanels` from gather + resolved references after compose so the UI does not branch on every contributor's raw shape.
4. **Reference resolution via `[[<kind>:<id>]]` placeholders.** Composer prose names entities by opaque token, not URL. A per-surface resolver expands against the gather: email HTML gets bold + service icon + anchor; in-app gets a typed `<EntityChip>`; plain-text fallback uses the entity's label. The LLM never sees or generates a URL — prevents hallucinated links. Kinds at v1: `activity | meeting | email` (closed enum in `@alfred/contracts`). Provider-specific operational details live in `IntegrationActivityItem.providerKind`, not in the reference-kind enum.
5. **New `briefings` entity, one row per `(user_id, briefing_date)`, idempotent.** Canonical record of the day. Status-machine lifecycle. Replicache-synced read-only with a 30-day pull window. `briefing_date` is a PG `date` (string mode, no JS Date noise); `timezone` is branded `IanaTimezone` text validated against `Intl.supportedValuesOf('timeZone')` at the API boundary. Both columns are load-bearing — see below.
6. **New metering attribution kind: `briefing`.** Const-narrowed in `@alfred/contracts.AttributionKind`. Cost rollups bucket the daily briefing apart from agent runs, triage, web search, doc extraction.

**Trigger model unchanged.** Hourly `briefing.tick` continues to honor `user_preferences.briefing.delivery_hour`. Per-user scheduled jobs were considered and rejected — at single-user scale the tick's index lookup is free, and a second BullMQ scheduler buys nothing the unified `workflows.tick` (ADR-0027) hasn't already justified.

**Schema sketch.**

```ts
// packages/db/src/schema/briefings.ts
briefings (
  id            text PK,                          -- createId('brf')
  user_id       text FK -> users,
  briefing_date date NOT NULL,                    -- 'YYYY-MM-DD' in user tz (mode: 'string')
  timezone      text NOT NULL,                    -- $type<IanaTimezone>()
  status        text NOT NULL,                    -- 'pending' | 'gathering' | 'composing' | 'sent' | 'failed'

  gather           jsonb NOT NULL,                -- $type<BriefingGather>()
  breaking_summary text NOT NULL DEFAULT '',
  full_briefing    jsonb NOT NULL,                -- $type<FullBriefing>()
  model            text,                          -- model id used for compose
  compose_fallback boolean NOT NULL DEFAULT false, -- deterministic fallback delivered

  email_send_id text FK -> email_sends NULL,      -- delivery side-effect link
  row_version   bigint NOT NULL DEFAULT 0,
  ...lifecycle_dates,

  UNIQUE(user_id, briefing_date)
)
```

`BriefingGather` and `FullBriefing` live in `@alfred/contracts/briefing.ts`. Each `*Contribution` type is exported separately so future integrations add their slice without touching shared types. `gather` and `full_briefing` use Drizzle `.$type<T>()` for compile-time safety; runtime validation is the composer's structured-output contract.

**Why `briefing_date` + `timezone` as separate columns, not a `timestamptz`.**

`briefing_date` is the _identity_ of the briefing — the unique index, the query key for "yesterday's briefing", the idempotency key for `notify()`. Querying by calendar day must not require tz math at read time. A `timestamptz` encodes an instant + offset, not a calendar date in an IANA zone — Postgres stores the offset, not the IANA name, so "+05:30" identifies Asia/Kolkata _or_ Asia/Colombo _or_ a manual offset. The IANA name is the canonical zone identity (DST rules, historical offset changes); we need both pieces independently, captured at compose time. Cosmetic ergonomics via a `briefingDateAndTz` spread helper in `packages/db/src/helpers.ts`, same shape as the existing `lifecycle_dates` spread.

**Composer output schema.**

```ts
// packages/contracts/src/briefing.ts
export const briefingComposerSchema = z.object({
  breakingSummary: z.string().min(1).max(2000),
  fullBriefing: z.object({
    headline: z.string().min(1).max(200),
    sections: z
      .array(
        z.object({
          source: gatherSourceSlugSchema, // 'email' | 'calendar' | 'integration_activity' | 'weather' | 'day_of_week'
          label: z.string().min(1).max(80),
          body: z.string().min(1).max(2000),
          why: z.string().min(1).max(500).optional(),
          references: z.array(z.string().min(1)).max(12).optional(),
        }),
      )
      .max(12),
    auditSummary: z.string().min(1).max(2000).optional(),
  }),
});
```

`briefingComposerSchema` is model-facing and deliberately excludes `sourcePanels`. The persisted `FullBriefing` type/schema extends the composer output with deterministic `sourcePanels` after reference resolution:

```ts
type FullBriefing = BriefingComposerOutput["fullBriefing"] & {
  sourcePanels?: BriefingSourcePanel[];
};
```

Composer prompt explicitly enumerates every available reference. Example fragment passed to the LLM:

```
Available references (use ONLY these IDs; do not invent):
  Activity:  [activity:github:pr:warden#9 - "Review requested on warden#9"]
             [activity:provider:deploy:alfred-web:2026-06-02T08:12Z - "alfred-web deploy failed, then recovered after 6 attempts"]
  Meetings:  []
  Threads:   [email:thr_abc123 - "Quarterly check-in"]

When citing one of the above in your prose, use [[<kind>:<id>]] verbatim.
Do NOT emit URLs. Do NOT emit markdown bold or links for entity references.
```

**Reference resolution layer.**

```ts
// packages/api/src/modules/briefing/references.ts
type Segment =
  | { kind: "text"; value: string }
  | {
      kind: "activity";
      id: string;
      provider: IntegrationSlug;
      activityCategory: string;
      providerKind: string;
      title: string;
      url?: string;
    }
  | { kind: "meeting"; eventId: string; title: string; start: string; calendarUrl: string }
  | { kind: "email"; threadId: string; subject: string; gmailUrl: string };

export function resolveBriefingReferences(
  markdown: string,
  gather: BriefingGather,
): { segments: Segment[]; unresolved: string[] };
```

`renderBriefingEmail(segments) → { html, text }` and `renderBriefingApp(segments) → React.ReactNode` are the two surface-specific renderers. Unresolved placeholders fall back to a plain-text label and append to `unresolved`; the workflow logs them and a hook count surfaces in observability — drift between gather and composer is a real risk and we want it visible. The breaking-summary and full-briefing share the same resolver — one source of composer truth, two renderers.

**Full briefing UI.** The email stays intentionally short and ends with a `View full briefing` link into the in-app detail route. The full page can borrow the chat page's existing visual grammar: assistant prose as the main body, run/source accordions for details, source rows for provenance, and compact disclosures for "why included." Do not render raw model reasoning or chain-of-thought. `sections[].why` is a user-facing inclusion rationale ("included because the deploy loop took 47 minutes and needed six attempts"), while `auditSummary` is a bounded composition note suitable for a muted "Briefing notes" disclosure or diagnostics. The raw gather payload remains available in the row for audit/replay, but the UI renders `sourcePanels`: a normalized display model generated deterministically from gather + resolved references after compose, not model-authored.

**Replicache integration.**

- `IDB_KEY.BRIEFING` entry in `packages/sync/src/keys.ts` — actual prefix `briefing/`. ADR-0041's original day-keyed row became slot-keyed in ADR-0048; current per-row key is `briefing/{briefingDate}/{slot}`.
- Read schema in `packages/sync/src/schemas.ts` includes `breakingSummary`, `fullBriefing`, `briefingDate`, `slot`, `timezone`, `status`, `sendDecision`, `gather`, `rowVersion`.
- No client mutators at v1 — the workflow is the only writer. A future "regenerate" mutator flips `status` back to `'pending'` and re-enqueues the workflow.
- Pull window: **last 30 days**. Older briefings reachable via an on-demand `/api/briefings/history?before=...` route. Keeps IndexedDB cache bounded — at up to two rows/day, 30d is ~60 rows × small jsonb each.

**Gather extensibility.**

```ts
// packages/contracts/src/briefing.ts
export interface BriefingContributor<T> {
  source: GatherSourceSlug;
  collect(args: { userId: string; date: string; timezone: IanaTimezone }): Promise<T | null>;
}
```

Each contributor returns `null` if its integration isn't connected or the OAuth scope is missing — composer prompt handles the empty cases ("no meetings today" / "weather unavailable"). Operational integrations bolt on by adding an `integration_activity` producer; only truly distinct briefing roles should add a new `GatherSourceSlug`.

**v1 source notes.**

- **Email** — reuses `email_triage` joined to `documents` (no new query path).
- **Calendar** — requires `calendar.events.readonly` added to `GOOGLE_FEATURE_SCOPES.briefing` (currently `briefing` includes only `gmail.readonly`). Same Google OAuth client; user re-consent on next OAuth refresh or feature reconnect.
- **Integration activity** — normalized operational updates across connected systems. GitHub is the first planned direct producer (PRs awaiting review + yesterday's authored commits; requires `repo` scope on the GitHub OAuth app). Classic OAuth `repo` is broad, but pragmatic for private repo activity in this single-user v1; re-consent must be explicit and user-facing, and a GitHub App / fine-grained-token shape should be revisited if the scope becomes uncomfortable. Other providers, such as deployment, incident, domain, billing, security, docs, or project-management systems, add producers only when their integrations exist. Email triage can backfill provider activity before direct APIs exist, marked `source='email_triage'`.
- **Weather** — Open-Meteo (no API key, generous free tier). Location resolved from `user_preferences.location` (added alongside this ADR) or falls back to the IANA timezone's principal city. Cached in Redis per `(lat, lng, briefingDate)` for the day.
- **Day-of-week + holidays** — pure `Intl.DateTimeFormat` on the user's timezone; holidays via a small `@alfred/contracts` table covering US/IN holidays at v1.

**Integration activity rollup.** The briefing is not a raw event feed. Producers may emit many raw events, but the gather normalizes and rolls them up into `IntegrationActivityItem`s before compose:

```ts
type IntegrationActivityItem = {
  id: string;
  provider: IntegrationSlug;
  source: "direct_api" | "email_triage";
  activityCategory:
    | "work"
    | "deploy"
    | "incident"
    | "account"
    | "billing"
    | "security"
    | "usage"
    | "other";
  providerKind: string; // provider-scoped, e.g. github.pr_review_requested, some_provider.deployment.failed
  title: string;
  status?: "open" | "succeeded" | "failed" | "resolved" | "needs_attention";
  severity?: "info" | "warning" | "critical";
  occurredAt: string;
  url?: string;
  relatedRepo?: string;
  rollup?: {
    eventCount: number;
    attemptCount?: number;
    durationMinutes?: number;
    suppressedEventIds?: string[];
  };
};
```

Resolved noise is suppressed by default. Example: a deployment from any connected deployment provider that failed once and then succeeded should not brief the user. It becomes brief-worthy when the cluster is still unresolved, has critical severity, required clear user attention, crossed a pain threshold (for example >=3 failed attempts or >30 minutes from first failure to recovery), or is a notable day-level accomplishment. This is intentionally "intelligent and intuitive": the briefing should say "the build finally recovered after a rough deploy loop" only when that is a meaningful event in the user's day.

**Empty-state behavior.** A day with no meetings, no important email, and no meaningful integration activity does _not_ skip — the empty state is itself the content. The composer prompt's tone rule: _"On a quiet day, acknowledge the quiet — name what didn't happen, recognize recent effort if memory carries it, leave the user feeling earned rest, not informational void."_ The dimension worked example _"no PR activity. After shipping 11k lines of warden security yesterday, you've earned the quiet"_ is baked into the prompt as a canonical example.

**Failure modes.**

- **Composer LLM unavailable.** Workflow falls back to a deterministic template render of the gather data, sent under the same idempotency key. If delivery succeeds, the briefing row is `status='sent'` with `compose_fallback=true`; this is degraded compose, not delivery failure. Better to ship the gather than nothing.
- **Send failure (Resend outage).** Briefing row stays at `status='failed'`. `breakingSummary` and `fullBriefing` are already composed; the in-app surface still renders. A per-row "resend" affordance lets the user retry once the upstream recovers.
- **Reference resolution miss.** Unresolved `[[activity:foo]]` falls back to the inner label `"foo"` as plain text; `unresolved[]` is logged. Composer prompt drift is the most likely cause; the log surfaces it.

**Cost calculus (single user).**

| Phase           | Calls/day      | Tier | $/day      |
| --------------- | -------------- | ---- | ---------- |
| Gather (no LLM) | 5 contributors | —    | 0          |
| Compose         | 1              | boss | ~$0.02     |
| Send            | 1              | —    | 0          |
| **Total**       |                |      | ~$0.02/day |

vs the previous deterministic-render path (~$0/day, deterministic prose) — the delta is the cost of the warmth and judgment that the dimension example demonstrates is the actual product surface.

**Alternatives.**

- (a) **Single email with collapsible "full briefing" disclosure.** Rejected — HTML email rendering of per-source drill-downs is awkward across clients; mobile especially mangles disclosure widgets; loses a place for briefing history. Email should stay summary-only with a `View full briefing` link.
- (b) **Boss-agent-driven gather (LLM picks which tools to call per day).** Rejected — daily user-facing surface on top of m13 infrastructure still under construction. "What matters" is a product decision (same five sources every day), not a per-run reasoning decision; pushing it into a boss burns tokens to re-derive a fixed answer.
- (c) **Cheap-tier compose model.** Rejected — the warmth and judgment in the dimension example are not cheap-model outputs. Saving ~$0.01/day on the most-visible artifact is the wrong trade.
- (d) **Plain markdown without reference placeholders (LLM emits URLs inline).** Rejected — URL hallucination on a daily user-facing email is unacceptable; in-app entity chips can't be reconstructed from `<a href>`; styling responsibility belongs to surfaces, not the LLM.
- (e) **Single `timestamptz briefing_at` column for date + tz.** Rejected — loses the calendar-date identity needed for the idempotency unique index and history queries; Postgres timestamptz stores offset, not IANA zone name; canonical zone identity is lost.
- (f) **Append-only `briefing_runs` history per render.** Rejected — at single-user scale, day-by-day overwrite is the natural model; render history is a feature nobody asked for; `agent_runs` already audits the workflow itself.

**Open.**

- Future "regenerate" mutator for the in-app surface — server-authored only at v1.
- `briefing_history` route shape for pulls older than 30 days. Likely a simple paginated read; no Replicache involvement.
- Whether the composer prompt should evolve to consume `person_profiles` (ADR-0031) once dossiers exist — so "Alice requested your review" becomes "Alice (eng lead at $company) requested your review". Forward-compatible via the reference resolver; the gather payload would carry resolved dossier slices alongside.
- Holiday calendar coverage beyond US/IN — add per locale as needed; the const table is the right scale at v1.
- How much raw gather data the full briefing page should expose. Default v1: render sections, entity/activity chips, source-backed `why` disclosures, normalized `sourcePanels`, and a muted `auditSummary`; keep raw gather as stored data for audit/replay rather than rendering directly from each contributor shape.
