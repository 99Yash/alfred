# Triage v3 — implementation plan

Implements **[ADR-0051](../../decisions.md#adr-0051)** (email triage v3: cheap-model-always,
made smart by deterministic context), which supersedes [ADR-0042](../../decisions.md#adr-0042)'s
classifier shape. Read ADR-0051 first — this plan is the build sequence, not the rationale.

Cross-references: [`../../CONTEXT.md`](../../CONTEXT.md) (glossary: *Sender prior*, *Account
persona*, *Observation/inconsistency layer*, *Triage override floor*, *Thread state (triage)*,
plus the surviving *SenderContext*, *Effective author*, *User context*),
[`../../decisions.md`](../../decisions.md) (ADRs 0012, 0013, 0021, 0025, 0037, 0042, 0051),
[`../reference/triage.md`](../reference/triage.md) (current pipeline — supersede in Phase 5).

> **Status.** Design grilled and locked 2026-06-04/05 (resolutions folded in below).
> ADR-0051 written. Ready to build. Two fixes already shipped this cycle:
> `gmail.watch_install` on OAuth connect (the actual latency fix), and the
> self-initiated sign-in/magic-link carve-out in the classify prompt (rule 15).
> Last-commit delta: real-time todo suggestions are now partially live on the
> existing v2 path (`todoSuggestion` in `classify.ts`, `suggestTodo` tail step in
> `email-triage.ts`). Triage v3 must preserve that tail step while moving the
> classifier to observation-rich inputs.
>
> **Build progress (2026-06-05).** Phases 1 + 2 landed (foundation):
> - *Phase 1* — `persistMessage` flags `metadata.isSent`; ingestor results carry
>   `triageDocumentIds` (non-sent inserts); `queue.ts` triages that subset only
>   while embedding all inserts; `getThreadState()` reads sent-aware thread
>   observations. Sent mail is now ingested + embedded but never triaged/labeled.
> - *Phase 2* — `sender_priors` table + migration `0032`; `sender-priors.ts`
>   (`senderKeyFor`/`getSenderPrior`/`incrementSenderPrior`, Redis read-through +
>   bust); `integration_credentials.persona` auto-detected from the Google `hd`
>   claim (`detectPersona`), exposed via `GET /credentials` + overridable via
>   `PATCH /credentials/:id/persona`; pure `observations.ts` assembler. Histogram
>   write-back is wired into the existing classifier path — **no prompt change yet**.
> - Reads (`getSenderPrior`, `getThreadState`, `assembleObservations`) are built,
>   exported, and unit-tested but **not yet fed to the model** — that is Phase 3.
> - Remaining: Phase 0 (todo regression coverage), Phase 3 (context-rich
>   classifier), Phase 4 (retire boss `deepen`), Phase 5 (observability/docs/copy).

---

## 1. Why (one paragraph)

The "slow tagging" complaint was a **delivery bug** — a freshly-connected account had no
Gmail watch, so mail waited on the 5-min sweep ([ADR-0037](../../decisions.md#adr-0037)'s
study: 4.5s classify vs 195s ingest). Fixed. The **real** problem is quality: ADR-0042
deliberately kept the cheap classifier *email-only*, so Alfred ignores everything it knows
about you and your senders when tagging. Triage v3 fixes that **without** a bigger model:
keep the fast cheap model on every email, and make it smart by **feeding it deterministic
context** — sender history, account persona, thread state, known-contact, Gmail signals —
plus an observation/inconsistency layer that focuses its attention. No routine boss.

## 2. The spine

```
ingest doc (gmail.poll_recent / gmail.poll_history)   [+ in:sent ingested, NEVER triaged]
  ↓
extract-sender-context           deterministic, ~5ms (UNCHANGED — ADR-0042)
  ↓
gather observations              deterministic, ~ms:
                                   • sender prior histogram   (sender_priors)
                                   • account persona          (integration_credentials.persona)
                                   • thread state             ("you last replied <date>")
                                   • known-contact flag       (entities graph)
                                   • Gmail signals            (CATEGORY_*, IMPORTANT, STARRED)
                                   • content regex flags      (unsubscribe / $ amount / security / invite)
  ↓
classify (cheap, context-rich)   gemini-2.5-flash-lite, ~sub-second, ALWAYS
  ↓
[inconsistency check]            deterministic; on hard conflict → ONE more cheap pass
[override floor]                 deterministic; forces urgent/action_needed on the
                                   small high-precision severity set only
  ↓
persist email_triage + update sender_priors histogram
  ↓
apply-label                      Gmail messages.modify + sibling strip (UNCHANGED)
```

The cheap model **always** runs (R-Q4) — the prior is a *hint*, not a bypass, so an urgent
message from a usually-newsletter sender is still caught. No routine boss/Sonnet tier (R-Q5);
the only escalation is a *second cheap pass* on a detected conflict (R-Q6).

## 3. Data model

### 3a. `sender_priors` (new — `packages/db/src/schema/triage.ts`)

```ts
sender_priors (
  user_id         text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  sender_key      text NOT NULL,        // exact lowercased email | service:<botSlug>
  category_counts jsonb NOT NULL DEFAULT '{}',  // histogram: { newsletter: 12, marketing: 1 }
  last_category   text,
  display_name    text,
  last_seen_at    timestamptz,
  ...lifecycle_dates,
  PRIMARY KEY (user_id, sender_key)
)
```

Raw histogram only — **no** `confidence`/`locked`/`source`/`observations`/`domain` (R-Q1, R-Q5,
R-Q8h). Written on every classification. **Never** keyed on a human sender (`effectiveAuthor:
'person'`) and **never** on the user's own sent mail.

Migration contract: one Drizzle schema change + generated migration. Use `pnpm db:generate`
then `pnpm db:migrate` locally; do not `db:push`.

### 3b. `integration_credentials.persona`

Add `persona text` (`'work' | 'personal'`), auto-detected from the Google `hd` claim at
connect, user-overridable. (R-Q7)

Implementation detail: `exchangeCode()` currently verifies `sub` + `email` from the Google
`id_token` and drops the rest. Widen the verified claims shape to expose `hd?: string`, pass
it through `upsertCredential()`, and store both:

- `persona`: `hd` present -> `work`, absent -> `personal`
- `metadata.googleHostedDomain`: the raw `hd` value when present, for audit/debug

Credential listing is REST-backed today (`GET /api/integrations/google/credentials`), so the
override can be a small authenticated route plus the existing integration detail page. No
Replicache row-version is required unless integration credentials become a synced entity first.

### 3c. Sent mail (R-Q8)

No schema change — reuses `documents` (`source='gmail'`, same `source_thread_id`). Flag sent
docs (`metadata.isSent`). Ingested **and embedded**; **excluded** from the triage event
fan-out and from prior updates.

Implementation detail: Gmail already stores raw `labelIds` in `documents.metadata.labelIds`.
The sent-mail path should preserve that shape and set `metadata.isSent = labelIds includes
"SENT"` (or equivalent `from === accountLabel` fallback). The event filter belongs in
`emitGmailMessageEvents` / the ingestion worker boundary so sent docs never create
`gmail.message_received` runs.

## 4. Components & files

| Concern | Where | Change |
|---|---|---|
| Sender prior store | `packages/api/src/modules/triage/sender-priors.ts` (new) | get histogram + upsert-increment; Redis read-through (`alfred:sender-prior:{userId}:{senderKey}`) reusing the `resolve.ts` cache+bust pattern |
| Persona detect | `packages/integrations/src/google/oauth.ts`, `packages/api/src/modules/integrations/google-routes.ts`, `integration_credentials` | expose verified `hd` claim → persona column + metadata audit; override endpoint on integration detail page |
| Observation gather | `packages/api/src/modules/triage/observations.ts` (new) | pure-ish assembler: priors + persona + thread state + contact flag + Gmail signals + content regex flags |
| Classifier | `packages/api/src/modules/triage/classify.ts` | consume observations; keep `todoSuggestion`; drop the email-only prompt + the regex-guardrail pile; keep a *small* override floor + the conditional second-pass |
| Workflow | `apps/server/src/builtins/workflows/email-triage.ts` | remove the boss `deepen` branch; add observation gather + histogram write-back; preserve the `suggestTodo` tail step; thread state via sent-mail |
| Sent-mail ingest | `packages/integrations/src/google/ingestor.ts` + `packages/api/src/modules/integrations/queue.ts` | add `in:sent`; embed; exclude sent docs from `emitGmailMessageEvents` and prior write-back |
| Todo suggestion | `classify.ts` + `email-triage.ts` + `packages/api/src/modules/todos/suggest.ts` | keep one optional `todoSuggestion` field on the cheap call; no second LLM call; source ref remains `{ provider:'gmail', kind:'thread', id: sourceThreadId }` |
| Observability | `triage.sender_extraction` log event | extend with the new observations + second-pass/override flags |

## 5. Phased plan (each lands before the next; sub-steps parallel-safe)

### Phase 0 — preserve shipped todo behavior

Already partially shipped in `cb10363`. Before the v3 rewrite, add/keep regression coverage
around the current contract:

- cheap classifier schema accepts `todoSuggestion: null | { name, assist? }`
- workflow calls `suggestTodo()` only on the new-classification path
- `marketing`/`newsletter`/`fyi`/`done` suppress suggestions even if the cheap result emitted one
- source-overlap merge stays non-fatal and idempotent

Acceptance:

- A fixture `action_needed` message with a concrete ask creates or merges one `suggested` todo.
- A fixture `fyi`/`newsletter` message with a bogus `todoSuggestion` creates no todo.

### Phase 1 — sent-mail foundation

Ingest `in:sent` (+ embed) through `persistMessage`; guardrails: never triaged, never a prior.
Unblocks thread state *and* chat recall. Shippable on its own.

Implementation checklist:

- Add the sent query/path without disturbing existing inbox `poll_recent` latency.
- Set `metadata.isSent` consistently from Gmail labels and/or account-label fallback.
- Filter sent docs before `emitGmailMessageEvents`.
- Add a thread-state reader that returns bounded observations only (`lastUserReplyAt`, newest
  sender direction), not a category decision.

Acceptance:

- A sent fixture inserts a `documents` row and chunks, but no `agent_runs` email-triage run.
- A received fixture in the same thread observes the prior sent reply in `observations`.
- `/api/me/inbox` does not surface sent-only docs as actionable inbox items.

### Phase 2 — context layer

`sender_priors` table + store + Redis read-through; histogram write-back wired into the
existing classifier (no prompt change yet — proves the plumbing). Account persona detection +
column + override. Observation assembler.

Implementation checklist:

- Add `sender_priors` schema + migration.
- Implement `getSenderPrior()` and `incrementSenderPrior()`; Postgres remains source of truth,
  Redis is a read-through cache with bust on increment.
- Compute sender keys exactly: lowercased email or `service:<botSlug>` only.
- Skip prior reads/writes for `effectiveAuthor: 'person'` and `metadata.isSent`.
- Add `integration_credentials.persona`; detect from `hd`; expose override in API/UI.
- Assemble observations in a pure-ish module with no LLM calls.

Acceptance:

- Three newsletter classifications from the same service sender produce
  `{ newsletter: 3 }` in `sender_priors.category_counts`.
- A human sender produces no `sender_priors` row.
- Persona auto-detect stores `work` when `hd` exists and `personal` otherwise; override persists.
- Observation assembler returns stable JSON that can be snapshot-tested.

### Phase 3 — context-rich classifier

Rewrite `classify` to consume observations; delete the email-only prompt and the brittle
guardrail pile; add the small override floor + the conditional second cheap pass. This is the
intelligence upgrade.

Implementation checklist:

- Update `ClassifyEmailArgs` to include `observations`.
- Keep `todoSuggestion` in the output schema and prompt rules.
- Make content regexes produce named flags for the prompt and conflict checker, not hidden
  category rewrites.
- Add the override floor as a tiny, tested function with explicit signal names.
- Add a second-pass wrapper that records `firstPass`, `conflict`, and `secondPass` for audit.

Acceptance:

- Prior-heavy newsletter sender + urgent credential-exposure body still lands `urgent`.
- Self-initiated magic links remain `action_needed`, not `urgent`.
- A hard deterministic conflict triggers at most one second cheap pass.
- `todoSuggestion` still behaves per Phase 0 after the prompt rewrite.

### Phase 4 — retire the boss deepen path

Remove the routine boss branch from the triage workflow. Keep the dormant `dossierRequest` hook
and `system.read_user_context` surface for non-triage/future use.

Implementation checklist:

- Delete `shouldDeepen` execution from `email-triage.ts`.
- Remove/deprecate triage-only `deepen` imports and state fields.
- Ensure classification model/cost attribution is still `role: 'triage'`.
- Keep fallback behavior simple: failed second-pass falls back to first-pass output, not boss.

Acceptance:

- No `boss`/`deepen` run is created for severity-suspect bot mail.
- Triage still writes `email_triage`, applies the Gmail label, and emits inbox update events.
- `pnpm check:web-boundaries` still passes; no server package leaks into `apps/web`.

### Phase 5 — observability, docs, copy

Extend `triage.sender_extraction`; supersede `docs/reference/triage.md`; surface the onboarding
copy (below). Tune conflict conditions and override membership from real logs.

Implementation checklist:

- Log sender key type, prior histogram summary, persona, thread-state summary, Gmail-signal
  flags, content flags, override flag, second-pass reason, and todo suggestion presence.
- Update `docs/reference/triage.md` from ADR-0042/v2 to ADR-0051/v3.
- Add copy to the chosen Gmail connection or integration detail surface.
- Add a short "how to tune" note: conflict conditions loosen/tighten only from observed logs.

Acceptance:

- `triage.sender_extraction` logs enough to debug a bad tag without reading raw email bodies.
- The reference doc no longer describes routine boss `deepen` as the live path.
- Smoke triage on a real dev Gmail account completes without boss calls.

## 6. Deferred (own discussions / future ADRs)

- **Persona policy** — what work-urgent vs personal-urgent actually means. Its own ADR.
- **Chat-driven correction** — a chat tool to correct a tag and pin a prior (no Gmail-label
  correction loop — R-Q3).
- **Connect-time prior backfill** — pre-warm priors by classifying recent mail at connect.
  Now a nice-to-have, since cold start isn't a correctness problem (model always runs).

## 7. Open (settle at build time from logs, not now)

- Exact deterministic conditions that trigger the second cheap pass (prior-vs-output,
  content-flag-vs-output, signal-vs-output) — seed conservative.
- Override-floor membership — start minimal, grow on observed evidence only.
- Second-pass firing rate — if too high, conflict conditions are too loose; tighten.

## 8. Onboarding copy to place (R-Q-copy)

Surface this on the login / landing / Gmail-integration page (TBD — leaning landing or the
Gmail integration detail page):

> Alfred analyzes the content of every email and automatically applies relevant labels.
> From receipts and newsletters to project updates and personal messages, everything gets
> sorted into the right category without you lifting a finger.

(Voice OK per the copy-voice convention — no em-dashes.)
