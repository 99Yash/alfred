# ADR-0051 — Email triage v3: cheap-model-always, made smart by deterministic context (sender priors + account persona + observation/inconsistency layer); supersedes ADR-0042's classifier shape


**Decision.** Triage keeps the cheap, fast model ([`getCheapModel`](../../packages/ai/src/provider.ts), gemini-2.5-flash-lite) on **every** email — speed and per-email cost are hard product constraints at real inbox volume. Intelligence comes not from a bigger model but from **deterministic context fed into the cheap model**: a per-sender category histogram (`sender_priors`), an account persona label (work/personal), thread state (sent-mail aware), a known-contact flag, Gmail-native signals, and cheap regex content flags. A deterministic **observation/inconsistency layer** focuses the model's attention on anomalies; a **conditional second cheap pass** re-runs the model with a detected conflict spelled out; a **small high-precision override floor** can force `urgent`/`action_needed` on unambiguous severity signals. There is **no routine boss/Sonnet escalation** — the expensive, slow agent boss is at most a vanishing edge case, ideally absent. This inverts and supersedes [ADR-0042](#adr-0042): v2 was *cheap-classify-email-only + boss-deepen-on-a-gate*; v3 is *cheap-classify-context-rich-always, no routine boss*. The latency complaint that triggered this was a delivery bug (missing Gmail watch on connect, [ADR-0037](#adr-0037)), not the model — so v3 is purely an intelligence play that keeps latency low by construction.

Eight coordinated micro-decisions:

1. **Cheap model on every email; never skip the model.** The prior cache is a **fed signal, not a bypass**. A 99%-newsletter sender can still send one genuinely urgent message; always-classifying catches the anomaly while staying consistent on the routine. Because the model runs every time, the prior histogram is refreshed every time — there is no staleness problem and no cache-invalidation problem to solve.
2. **`sender_priors` as a fed histogram.** New table keyed `(user_id, sender_key)` where `sender_key` is the **exact lowercased sender address** or `service:<botSlug>` for recognized bots. Stores a raw category histogram (`category_counts`), not a verdict. **No domain-level priors in v1** (domain is where multi-type senders collide). **Human senders (`effectiveAuthor: 'person'`) are not cached** — a person's category is a property of each message, not the sender; the prior cache is explicitly a **bulk-sender** signal (newsletter/marketing/payment/digest/bot). The model reads the raw histogram and decides; there is **no `confidence`/`locked`/`source`/dominant-share gating** (those were artifacts of the rejected bypass design).
3. **Account persona is a per-credential context label.** Single-user, multi-account: a user may connect a work Workspace account and a personal one. Detect persona from the Google **`hd` (hosted-domain)** claim — Workspace domain → `work`, absent → `personal` — store it on `integration_credentials`, allow user override on the integration detail page, and feed a one-line label into the model's context. The **rich persona *policy*** (what is work-urgent vs personal-urgent) is **deferred to its own ADR**; v1 gives the model the label + a short guidance line and lets it reason with existing `user context`.
4. **Observation/inconsistency layer (the "make a cheap model smart" mechanism).** Two passes. **(a) Pre-model observations**, computed deterministically and always fed into the single cheap call: prior histogram, persona, thread state, known-contact flag, Gmail-native signals (`CATEGORY_*`, `IMPORTANT`, `STARRED`), and cheap regex content flags (unsubscribe footer / currency amount / security keywords / calendar invite). **(b) Conditional second cheap pass**, only on a hard, deterministically-detected conflict between the model's output and a strong expectation (prior / content flag / Gmail signal) — re-runs flash-lite with the inconsistency spelled out. Most inconsistencies are *prevented* by (a); (b) is a thin net, still sub-second, still cheap, **no boss**.
5. **Deterministic override floor.** A **small, high-precision** set of unambiguous severity signals (exposed credential/secret, CVE, payment-failure-breaks-access-today) may **force** `urgent`/`action_needed` regardless of model output; the **model owns the category everywhere else**. The set is seeded small and grows only from observed-data evidence (mirrors ADR-0042's bot-allowlist philosophy) — explicitly **not** a large keyword ruleset, to avoid re-introducing the brittleness that mis-tagged self-initiated sign-in links as `urgent` (the bug that opened this work).
6. **No correction loop in v1.** Do **not** extend the Gmail history sweep to reconcile user label-moves; do not build label-change attribution (its "did Alfred or the user move this?" ambiguity is a self-poisoning risk). Priors learn **only from Alfred's own classifications**. User corrections, if ever, arrive through **chat** ("that wasn't urgent") and are **deferred** to a later iteration; the schema reserves no machinery for it in v1.
7. **Sent-mail ingestion as a shared foundation.** Ingest `in:sent` via the existing `persistMessage` path **and embed it** — triage needs only thread state, but the user wants **chat recall over sent mail** ("did I send so-and-so a doc about X?"), which needs vectors, and it feeds future style profiles ([ADR-0013](#adr-0013)). Two hard guardrails: sent mail is **never triaged/labeled** (excluded from the triage event fan-out) and **never becomes a sender prior** (you are not a sender to cache).
8. **Thread state is a fed observation, not a hard rule.** Sent-mail awareness lets us tell the model "you last replied in this thread on `<date>`" rather than deterministically forcing `done`/`fyi`. The model owns the resulting category, dissolving the taxonomy-edge question of how "you already replied" maps onto the 10 buckets.

**Pipeline.**

```
ingest doc (gmail.poll_recent / gmail.poll_history)   [+ in:sent ingested, never triaged]
  ↓
extract-sender-context           deterministic, ~5ms (UNCHANGED — ADR-0042 #1)
  ↓
gather observations              deterministic, ~ms — prior histogram, persona,
                                 thread state, known-contact, Gmail signals, content flags
  ↓
classify (cheap, context-rich)   gemini-2.5-flash-lite, ~sub-second, ALWAYS
  ↓
[inconsistency check]            deterministic; on hard conflict → one more cheap pass
[override floor]                 deterministic; forces urgent/action_needed on the
                                 high-precision severity set only
  ↓
persist email_triage + update sender_priors histogram
  ↓
apply-label                      Gmail messages.modify + sibling strip (UNCHANGED)
```

**`sender_priors` shape.**

```ts
sender_priors (
  user_id         text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  sender_key      text NOT NULL,        // exact lowercased email | service:<botSlug>
  category_counts jsonb NOT NULL DEFAULT '{}',  // histogram, e.g. { newsletter: 12, marketing: 1 }
  last_category   text,
  display_name    text,
  last_seen_at    timestamptz,
  ...lifecycle_dates,
  PRIMARY KEY (user_id, sender_key)
)
```

**What this keeps from ADR-0042.** The deterministic `extract-sender-context` step (#1) and its `SenderContext` shape; the async dossier trigger + `person_profiles` cache (#4/#5) as a future hook; the `system.read_user_context` surface + `alfred:user-context:{userId}:v1` Redis read-through (#6) — though triage now reads that slice deterministically and hands it to the model as text rather than via a tool; and the `triage.sender_extraction` observability event (#7), extended with the new observations.

**What this supersedes in ADR-0042.** #2 (cheap classifier is email-only, no bio/profile — now context-rich; alt (g) is **adopted**, not rejected); #3 (the boss `deepen` step as a brief-only `AlfredAgent` loop on a confidence/bot/contact gate — there is no routine boss step and no agent loop in triage v3).

**Cost & latency (100 emails/day single user).** Steady state ≈ 100 cheap calls/day + a small fraction of second cheap passes ≈ **~$0.01–0.02/day** — same order as ADR-0042's cheap path, *minus* the ~10%/day boss-deepen line, because there is no routine boss. Latency: one cheap call (~sub-second), a rare second cheap call on conflict (still sub-second total); end-to-end user-perceived latency is dominated by realtime delivery (watch → pub/sub → poll_recent, ~sub-30s post-ADR-0037), not classification. The <10s goal holds by construction.

**Alternatives.**

- **(a) Cache as a model *bypass*** (deterministic resolver chain; skip the model on a confident prior). Rejected — a confident `newsletter` prior would blind triage to the one urgent message that sender ever sends. "Never skip the model" catches the anomaly; the prior is a hint, not a verdict.
- **(b) Smart model (Sonnet-class) on every email, no cheap tier.** Rejected — slower and materially more expensive per email; unsustainable at real inbox volume for a per-message job. The needed smartness is concentrated in edge cases, deliverable via context rather than a bigger model on the 95% obvious path.
- **(c) Cheap-always + elevate-to-boss on the cheap model's judgment** ([ADR-0042](#adr-0042)'s shape, kept). Rejected — leans on the cheap model to know when it is out of its depth (the exact judgment cheap models are weakest at) and pays slow/expensive boss latency on the most frequent *important* category (fresh human mail). Deterministic inconsistency-flagging + a focused second cheap pass gets the edge-case win without the slow tier.
- **(d) Gmail-label correction loop** (learn from user label-moves; lock priors). Rejected for v1 — history label events don't say *who* moved the label, so attribution risks learning from Alfred's own writes and locking a sender wrong forever. Deferred to a chat-driven correction path.
- **(e) Domain-level priors.** Rejected for v1 — domain is exactly where multi-type senders (`@bank.com` sends statements, fraud alerts, and marketing) defeat a single category. Exact-sender (role address) priors are far more stable.
- **(f) Human-sender priors.** Rejected — a person's category is per-message; a person→category prior would actively mis-tag. Humans are reasoned per-message with a known-contact flag from `entities`.
- **(g) Skip embedding sent mail** (thin thread-state-only ingestion). Rejected — the user wants semantic chat recall over sent mail, which needs vectors; full ingest + embed also serves style profiles.
- **(h) Confidence/locked/source gating on priors.** Rejected — those existed to gate a bypass; with the model always running, the raw histogram fed to the model is sufficient and simpler.

**Deferred (own discussions / future ADRs).**

- **Persona policy** — the rich definition of work-urgent vs personal-urgent relevance. Its own ADR; v1 ships only the persona label + plumbing.
- **Chat-driven correction** — a chat tool by which the user corrects a tag and pins a prior.
- **Connect-time prior backfill** — pre-warming priors by classifying recent mail at connect. A nice-to-have now that cold start is not a correctness problem.

**Open.**

- **Inconsistency-conflict definition** — the exact deterministic conditions that trigger the second cheap pass (prior-vs-output, content-flag-vs-output, signal-vs-output). Seeded conservative; tuned from `triage.sender_extraction` logs, not specified up front.
- **Override-floor membership** — the precise high-precision severity set. Starts minimal; grows only on observed evidence.
- **Second-pass rate** — if the conditional second cheap pass fires on too large a fraction of mail, the conflict conditions are too loose and get tightened before they cost real latency.

**Amendment (2026-06-05) — Phase 3 build resolutions: the Open section settled, Phases 3+4 collapsed.**

Building the context-rich classifier (plan Phase 3) forced the three Open items to concrete seeds and surfaced one supersession the original ADR left implicit. Grilled and locked 2026-06-05; folded into `CONTEXT.md` (*Triage override floor*, *Observation/inconsistency layer*, *Content flags (triage)*, *Known-contact flag*).

1. **The conditional second cheap pass replaces the boss `deepen` step — so plan Phases 3 and 4 are one change, not two.** The two are not independent: running both means the boss `deepen` and the second cheap pass both escalate on the same severity-suspect-bot edge case, which contradicts this ADR's "no routine boss." The classifier rewrite therefore lands together with the removal of the `deepen` branch from the triage workflow. The dormant `dossierRequest` hook and the `system.read_user_context` surface survive for non-triage/future use (unchanged from the body).

2. **Override-floor membership — seeded to ONE signal.** A secret/API key/token/private key/password exposed, leaked, committed, compromised, found, or detected (in either noun→verb or verb→noun order) forces `urgent`. Generic `credential` is deliberately excluded from the unrecoverable floor and remains only in the broader security content flag. **CVE-id presence and payment-failure-breaks-access are deliberately NOT in the floor** — both go to the model. A bare `cve-\d{4}-\d+` match forcing `urgent` would override rule 12a and re-introduce the Dependabot/advisory-bot noise the taxonomy tags `fyi`; "breaks access today" is a semantic call the model makes from the body. Critically, the floor predicate keys on *exposure verbs*, NOT auth vocabulary — it is strictly narrower than the `hasSecurityKeyword` content flag — so self-initiated sign-in/magic links (the bug that opened this work) never trip it.

3. **Inconsistency-conflict definition — two tightly-gated nets, max one re-run.** Of the three axes the body named, the prior-vs-important-output direction (anomaly catch) and the Gmail-signal-vs-output axis are NOT seeded — the always-on model fed the observations already covers the anomaly case, and a bigger model isn't what's missing. The pure `detectConflict` fires only on: **(a) under-classification** — `hasSecurityKeyword` is set, the model chose a passive category (`fyi`/`done`/`newsletter`/`marketing`), and the override floor did not already fire (the dangerous miss the floor doesn't cover); **(b) over-classification** — the model chose `urgent`/`action_needed`, the sender's prior is strong-bulk (total ≥ 5 and bulk-share ≥ 0.8), and nothing supports the severity (no security flag, not Gmail `IMPORTANT`) — the promotional-urgency over-reaction. The second pass re-runs flash-lite once with the conflict spelled out; its output is final (no third pass). Cost is a non-issue at ~100 emails/day; "conservative" here is about flip-flop churn, tuned from `triage.sender_extraction` logs.

4. **The `applyTriageClassificationGuardrails` rewrites are deleted — regexes demoted to named content flags.** Per §5's anti-brittleness stance, no deterministic post-model category rewrite survives. The review-bot rewrite is dropped outright (covered by the `service:<botSlug>` prior histogram, which converges to `{fyi: N}`, plus the override floor for genuine severity). The investor/AGM and public-event detection regexes survive **as named `ContentFlags` (`hasInvestorNotice`, `hasPublicEventLanguage`) fed to the prompt** — the model decides; the flags never rewrite. The `extract-sender-context` step and `SenderContext` shape are unchanged.

5. **`classifyEmail` owns the full sequence and returns an audit object.** `classifyEmail(args + observations)` runs first pass → `detectConflict` → conditional second pass → `applyOverrideFloor` internally and returns `{ classification, model, audit }` (audit: `firstPass`, `conflict`, `secondPass`, `secondPassFailure`, `floorMatched`, `floorForced`, observation summary) for the `triage.sender_extraction` log. `detectConflict` and `applyOverrideFloor` are pure exported functions, unit-tested directly; the second-pass loop takes an injectable model-runner seam so "at most one second pass" is testable without a live LLM. The workflow assembles observations (the IO: `getSenderPrior`, `getThreadState`, persona via an extended `loadTriageContext`, and a new best-effort `isKnownContact` for human senders only), calls classify once, persists, logs the audit, applies the label.

**Amendment (2026-06-09) — minimal identity observation + manufactured-urgency category principle (companion to the ADR-0050 stringency reframe).** Two classifier-side changes ride the todo-rubric stringency work:

6. **A minimal identity observation joins the deterministic context.** The cheap classifier was identity-blind about the *user* (it has the known-contact flag for *senders*, persona, priors — but not "who am I"). The todo ownership-attribution gate (ADR-0050 16a) needs exactly one thing: the user's **display name + account email**, rendered as one prompt line (`You are: <name> <email>`). Sourced from `user.name` (Better Auth) + the per-credential account email already used for persona — no new IO, no new table. This is the smallest possible step toward D1's full `User context` projection and is deliberately *just* identity, not role/projects/relationships (those stay parked under D1). It honors the §5 anti-brittleness line: a single deterministic fact fed as a hint, not a rewrite.

7. **The real-stake / manufactured-urgency principle is not todo-only — it reinforces the *category* side too.** A ceremonial obligation (AGM/shareholder "meeting," "save-the-date" gala) and an engagement nudge carry no real stake for the user → `fyi`, never `meeting`/`action_needed`/`urgent` unless they impose a concrete action + deadline on the user. This generalizes the existing rule 8 (public events) and rule 9 (investor/AGM notices) under one principle rather than adding more keyword rules — same anti-brittleness stance. The cheap model applies it from content; the `hasPublicEventLanguage`/`hasInvestorNotice` flags remain hints, never rewrites.

Both are validated by the same **dry-run backfill** (ADR-0050 amendment): read-only re-classification of historical email, diffed before any live prompt swap or re-tag/re-suggest write.

**Amendment (2026-06-10) — self-initiated auth mail demoted `action_needed` → `fyi` (rule 15).**

Self-initiated authentication mail — sign-in/magic links, one-time login codes, and email-verification the user *just requested* — was classified `action_needed` (the v3 resting place after rule 15 demoted it from the pre-v3 `urgent` floor bug). Production showed that was still the wrong home. The rubric contradicted itself: rule 16c already calls this exact class "self-resolving / nothing to remember" (→ no todo), yet the category put it in `action_needed`, the bucket the user scans for *real* tasks. The user initiated the flow and is already mid-flow; the link expires harmlessly and the action is moot by the time triage runs and reconciles the Gmail label. So it is passive awareness — `fyi` — not an open action. Rule 15, its category-definition lines, and the worked examples now say `fyi`; rule 16c (no todo) is unchanged.

This **supersedes the "(correctly `action_needed`)" characterization** of the "Sign in to Anthropic" example in ADR-0050's 2026-06-08 todo amendment — that example's *todo* verdict (no todo, via memorability) still holds and still illustrates category-vs-todo orthogonality; only its category label changes to `fyi`.

**Safety rests on §3's under-classification net, not on the category alone.** `fyi` is a passive category, so a security-keyword body filed there now trips `detectConflict`'s under-classification net (§3a) → one second pass with the self-initiated-auth carve-out spelled out. A genuinely *unsolicited* security alert mis-judged as auth therefore can't silently rot in `fyi` — it gets re-checked, and unsolicited alerts still resolve to `urgent` (rule 15's reserve clause, unchanged). Bare "sign in"/"login" don't match `hasSecurityKeyword` (it keys on secret-nouns / `suspicious|unauthorized` prefixes), so clean magic links stay single-pass. No change to `detectConflict` or the override floor — the net firing here is the intended context re-check, not a regression.

**Amendment (2026-06-13) — "task created" is not closure + thread state carries recent-message *content*.** A real prod miss (ClickUp thread, 2026-06-12): dvd assigned the user a bug ("please make sure this is fixed"), then asked ClickUp's "Brain" AI to file a task; Brain's reply "**Done.** Created [task] in the Backlog" was the latest message in the thread, so the per-thread overwrite stamped the whole thread `done` @ 0.9. Two compounding errors, two fixes — both keep the §5 anti-brittleness stance (principle in the prompt, not a keyword rewrite; a fed observation, model owns the category):

8. **Filing a task OPENS a loop; it is never `done`.** The `done` definition, rule 5 (closure), and rule 12e (activity-feed) now state that a task/ticket being *created / filed / opened / logged / added to a backlog* — including an automation reporting "Done. Created …" — is the START of work, routed by ownership (assigned/@-mentioned the user → `action_needed`; direct unanswered question → `awaiting_reply`; pure activity on someone else's item → `fyi`), **never** `done`. Closure means the user's underlying request is resolved, not that an intermediate actor finished a sub-step.

9. **`ThreadState` is extended from dates to recent-message content (the structural fix).** ADR-0051 #8 fed only thread *dates* ("you last replied on `<date>`"), so a trailing low-signal message was classified blind to an earlier open ask in the *same* thread — and per-thread overwrite (the deliberate, kept "re-evaluate on reply" contract) let that trailing message bury the live action item. `getThreadState` now also returns the most recent prior messages as bounded body excerpts (`recentMessages`: ≤6, header-stripped, ≤220 chars each, newest-first), rendered into the Observations block. New rule 17 tells the model the thread carries ONE tag and to judge the LIVE loop, not the last keystroke: a bot's "done" must not overwrite an earlier unanswered assignment/question. Still a fed hint — the model owns the category (consistent with #8's "thread state is an observation, not a hard rule"). With no earlier ask in the thread, a lone "task created" line lands `fyi`, never `done`. Validated by `apps/server/src/scripts/smokes/smoke-triage-clickup.ts` (the real miss + a no-context guard counter-case).
