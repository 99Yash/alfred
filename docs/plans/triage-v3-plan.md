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

### 3b. `integration_credentials.persona`

Add `persona text` (`'work' | 'personal'`), auto-detected from the Google `hd` claim at
connect, user-overridable. (R-Q7)

### 3c. Sent mail (R-Q8)

No schema change — reuses `documents` (`source='gmail'`, same `source_thread_id`). Flag sent
docs (`metadata.isSent`). Ingested **and embedded**; **excluded** from the triage event
fan-out and from prior updates.

## 4. Components & files

| Concern | Where | Change |
|---|---|---|
| Sender prior store | `packages/api/src/modules/triage/sender-priors.ts` (new) | get histogram + upsert-increment; Redis read-through (`alfred:sender-prior:{userId}:{senderKey}`) reusing the `resolve.ts` cache+bust pattern |
| Persona detect | OAuth callback + `integration_credentials` | read `hd` claim → persona column; override endpoint on integration detail page |
| Observation gather | `packages/api/src/modules/triage/observations.ts` (new) | pure-ish assembler: priors + persona + thread state + contact flag + Gmail signals + content regex flags |
| Classifier | `packages/api/src/modules/triage/classify.ts` | consume observations; drop the email-only prompt + the regex-guardrail pile; keep a *small* override floor + the conditional second-pass |
| Workflow | `apps/server/src/builtins/workflows/email-triage.ts` | remove the boss `deepen` branch; add observation gather + histogram write-back; thread state via sent-mail |
| Sent-mail ingest | `packages/integrations/src/google/ingestor.ts` + `queue.ts` | add `in:sent`; embed; exclude from triage fan-out |
| Observability | `triage.sender_extraction` log event | extend with the new observations + second-pass/override flags |

## 5. Phased plan (each lands before the next; sub-steps parallel-safe)

- **Phase 1 — sent-mail foundation.** Ingest `in:sent` (+ embed) through `persistMessage`;
  guardrails: never triaged, never a prior. Unblocks thread state *and* chat recall. Shippable
  on its own (chat recall benefits immediately).
- **Phase 2 — context layer.** `sender_priors` table + store + Redis read-through; histogram
  write-back wired into the *existing* classifier (no prompt change yet — proves the plumbing).
  Account persona detection + column + override. Observation assembler.
- **Phase 3 — context-rich classifier.** Rewrite `classify` to consume observations; delete
  the email-only prompt and the regex-guardrail pile; add the small override floor + the
  conditional second cheap pass. This is the intelligence upgrade.
- **Phase 4 — retire the boss deepen path.** Remove the routine boss branch from the triage
  workflow (keep the dormant `dossierRequest` hook + `system.read_user_context` surface).
- **Phase 5 — observability, docs, copy.** Extend `triage.sender_extraction`; supersede
  `docs/reference/triage.md`; surface the onboarding copy (below). Tune conflict conditions
  and override membership from real logs.

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
