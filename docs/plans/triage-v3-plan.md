# Triage v3 — context-grounded decision cache (DRAFT for grilling)

> **Status: DRAFT.** Not yet an ADR, not yet built. This proposes **ADR-0051**, which
> *inverts the default* of [ADR-0042](../../decisions.md#adr-0042): today's pipeline is
> *cheap-classify-always + boss-deepen-rarely*; v3 is *deterministic-cache-always +
> boss-on-miss, learning as it goes*. Read [ADR-0042](../../decisions.md#adr-0042),
> [ADR-0037](../../decisions.md#adr-0037), [ADR-0031](../../decisions.md#adr-0031),
> [ADR-0025](../../decisions.md#adr-0025), and [ADR-0012](../../decisions.md#adr-0012)
> (memory tables) before grilling this.

Cross-references: [`../reference/triage.md`](../reference/triage.md) (current pipeline),
[`../../CONTEXT.md`](../../CONTEXT.md) (new glossary terms below), action-policy cache
pattern at `packages/api/src/modules/action-policies/resolve.ts` (the per-user
in-process cache + Redis-bust template we reuse).

---

## 0. The reframe (why this exists)

Two complaints triggered this: (a) sign-in links tagged `urgent`, (b) tagging slow /
missing. **Only one is architectural.**

- **Latency was a delivery bug, not the model.** [ADR-0037](../../decisions.md#adr-0037)'s
  own study: an email "took 195s to ingest and 4.5s to classify — the classifier was
  never the bottleneck." The observed "untagged after 2 min" was the **missing Gmail
  watch on connect** (fixed: `gmail.watch_install` job now enqueued from the OAuth
  callback). Realtime delivery restored ⇒ classification is already ~1–4s.
- **Intelligence is the real target.** Today's quality ceiling is a single cheap model
  reading a **context-free prompt** ([ADR-0042 #2](../../decisions.md#adr-0042):
  "deliberately stays email-only … does not load the user's biography, memory, or
  profile"), propped up by a growing pile of regex guardrails in `classify.ts`. Alfred
  ignores everything it already knows about you and your senders when it tags. That is
  the "subpar."

**Resolution of the apparent tension** ("models really intelligent" vs "not dependent on
the model"): **amortization.** Use a smart model when a sender is *novel/ambiguous*,
then **cache its conclusion per sender** so the next N emails from that sender are tagged
in ~0ms with no model call. Steady state becomes deterministic and grounded in *your*
history, not a prompt guess. The model-call rate trends toward zero as the cache warms.

## 1. Locked decisions (confirmed with user 2026-06-04)

1. **Scope:** intelligence + caching only. Keep the 10-bucket taxonomy and the
   [ADR-0037](../../decisions.md#adr-0037) realtime pipeline unchanged.
2. **Sent mail:** ingest it, so thread state ("have I replied?") is deterministic.
3. **Learning:** priors learn from the user's Gmail label corrections (self-improving).
4. **Cache-miss tier:** boss-tier, context-rich, result cached.

## 2. Proposed architecture — the resolver chain

`classify` (one cheap LLM call + regex guardrails) is replaced by an ordered
**resolver chain**. First confident resolver wins; the model is the *last* resort.

```
extract-sender-context            deterministic, ~5ms (UNCHANGED — ADR-0042 #1)
  ↓ SenderContext { effectiveAuthor, botSlug, ... } + senderKey
resolveTriage(doc, senderContext, userId):
  R1. thread-state resolver        sent-mail aware, deterministic, conf 1.0
        newest msg in thread is FROM the user (after this inbound) → done/fyi
        (user already handled it — never re-tag as needs-reply)
  R2. sender-prior resolver        Redis read-through, ~5–20ms, no model
        prior.locked (user correction / Gmail filter) → category, conf 1.0  ← never wrong twice
        prior.confident (≥N agreeing obs, dominant share ≥τ) → category, high conf
  R3. gmail-signal resolver        deterministic priors, medium conf
        CATEGORY_PROMOTIONS + unsubscribe → marketing; IMPORTANT/STARRED → boost
  R4. boss-on-miss (context-rich)  ~3–8s, only when R1–R3 not confident
        feeds: SenderContext + prior histogram + contact status (entities graph)
             + thread state + bounded user-context slice + gmail signals
        → category, confidence, rationale, severityFlag, dossierRequest?
        WRITE-BACK: upsert sender_priors (source=alfred_classification)
  ↓
apply-label                        UNCHANGED — Gmail messages.modify + sibling strip
[fire-and-forget] person-research if dossierRequest   (UNCHANGED — ADR-0031/0042 #4)
```

**What survives from ADR-0042 verbatim:** the deterministic `extract-sender-context`
step (#1), the async dossier trigger + `person_profiles` cache (#4/#5), the
`system.read_user_context` surface + Redis read-through (#6), and the
`triage.sender_extraction` observability event (#7). **What v3 supersedes:** #2 (cheap,
email-only default) and #3 (the confidence/bot/contact escalation *gate*) — the boss is
no longer a rare escalation, it's the **cache-miss filler**, and the cheap email-only
path is gone.

## 3. Data model changes

### 3a. `sender_priors` (new table — `packages/db/src/schema/triage.ts`)

```ts
sender_priors (
  user_id        text NOT NULL REFERENCES user(id) ON DELETE CASCADE,  // ADR single-user FK CASCADE
  sender_key     text NOT NULL,        // normalized identity (see §3b)
  category       text NOT NULL,        // current best-guess (TRIAGE_CATEGORIES)
  confidence     real NOT NULL,        // derived (see §3c)
  observations   integer NOT NULL DEFAULT 0,
  category_counts jsonb NOT NULL DEFAULT '{}',  // histogram {newsletter:8, marketing:1}
  source         text NOT NULL,        // user_correction | alfred_classification | gmail_filter | seed
  locked         boolean NOT NULL DEFAULT false,  // user correction / filter pins it
  display_name   text,                 // last-seen, for UI + dossier
  domain         text,                 // for domain-level fallback rows
  ...lifecycle_dates,
  PRIMARY KEY (user_id, sender_key)
)
INDEX (user_id, domain)   // domain-level fallback lookups
```

### 3b. `senderKey` normalization

- Direct human/service sender → lowercased email address.
- Recognized body-actor bot → `service:<botSlug>` (e.g. `service:coderabbit`), reusing
  `SenderContext.botSlug` so all GitHub-review mail shares one prior.
- Domain-level fallback row → `domain:<domain>` (e.g. `domain:stripe.com`) for when an
  exact-sender prior is missing but the org is known.

### 3c. Confidence + the anti-poisoning rules

A prior is **confident** only when `observations ≥ 3` AND the dominant category's share
of `category_counts ≥ 0.8`. **Locked** priors (source `user_correction` or `gmail_filter`)
are always `confidence = 1.0` and Alfred never overrides them. Self-classifications never
lock and never alone make a prior confident on the first sighting — this stops one wrong
boss call from poisoning a sender. **Mixed-intent senders** (e.g. a `noreply@` used for
receipts *and* marketing) never clear the dominant-share threshold, so they correctly
keep falling through to the boss instead of being mis-cached.

### 3d. Sent-mail ingestion (Phase 3)

Ingest `in:sent` on the same realtime + sweep paths as inbox (reuse `persistMessage`;
the `(user_id, source, source_id)` unique index dedups). Mark sent docs (`metadata.isSent`
or `from === credential.accountLabel`). The thread-state resolver (R1) reads the newest
doc per `(user_id, source_thread_id)` to decide whether the user already has the ball.

### 3e. Correction learning (Phase 4)

The Gmail watch already streams history. Extend the poll path (today it only acts on
`messagesAdded`) to also process `labelAdded` / `labelRemoved` for `Alfred/*` labels:
if a message's Alfred label diverges from `email_triage.applied_label_id` **and the
change wasn't ours**, that's a user correction → upsert the sender prior with
`source=user_correction, locked=true`. Bust the Redis prior cache. This is the core of
"not model-dependent": the system gets a sender wrong **at most once**.

## 4. Caching layers (reuse `resolve.ts` pattern)

| Cache | Key | TTL / invalidation | Source of truth |
|---|---|---|---|
| Sender prior | `alfred:sender-prior:{userId}:{senderKey}` | bust on prior upsert / correction | `sender_priors` (Postgres) |
| User context | `alfred:user-context:{userId}:v1` (ADR-0042 #6) | bust on facts/prefs/entities change | memory tables |
| Per-instance LRU | in front of both | short TTL; single-user app ⇒ trivially hot | — |

Postgres is always the source of truth; Redis loss only causes a cache miss
([ADR-0042 #8](../../decisions.md#adr-0042) holds). Bust channels mirror
`policy-bust:u:{userId}`.

## 5. Latency budget

| Path | Classification | + label write | Total |
|---|---|---|---|
| R1/R2 hit (the majority, growing) | ~5–20ms | ~300–800ms | **< 1s** |
| R4 boss miss (minority, shrinking) | ~3–8s | ~300–800ms | **< 10s** |

End-to-end user-perceived latency is dominated by realtime delivery (watch → pub/sub →
poll_recent, already ~sub-30s), not classification. Goal met by construction.

## 6. Phased plan (each phase lands before the next; independently shippable)

- **Phase 1 — cache scaffold.** `sender_priors` table + Replicache-free server cache +
  the resolver chain wired with R2 + **write-back from the *existing* cheap classifier**
  as a temporary filler. De-risks the cache before touching the model. Proves hit-rate
  on real mail via logs. *(Note: filler is cheap-tier here only to isolate the cache
  change; Phase 2 swaps it for boss per locked decision #4.)*
- **Phase 2 — boss-on-miss, context-rich.** Replace the filler with a boss brief-only
  run ([ADR-0040](../../decisions.md#adr-0040) sentinel) fed the full context slice;
  wire the `alfred:user-context` Redis read-through. Keep dossier trigger.
- **Phase 3 — sent-mail + thread-state resolver (R1).** Ingest `in:sent`; add R1.
- **Phase 4 — correction learning loop.** Process `labelAdded`/`labelRemoved`; locked
  priors from user corrections; cache bust.
- **Phase 5 — gmail-signal resolver (R3) + cold-start seed + observability.** Seed
  priors from existing Gmail filters/labels and the connect backfill so a fresh account
  isn't 100% boss misses on day one. Supersede ADR-0042 docs; write the ADR-0051 final.

## 7. Cost (100 emails/day, single user) — vs ADR-0042's table

ADR-0042 steady state: 100 cheap + ~10 boss/day ≈ **$0.26/day**. Triage v3 **cold**
(empty cache) is worse for a few days (more boss misses), then **warm** is better: as
priors saturate, boss calls fall toward the new-sender rate (~handful/day) and most mail
is a 0-cost cache hit. Net: slightly higher cost while learning, **lower** at steady
state, and strictly higher quality throughout because every decision is context-grounded.

## 8. Open questions to grill

1. **Cold start.** Empty cache ⇒ every email is a boss miss until warm. Is the Phase 5
   seed (Gmail filters + connect backfill classifying recent mail) enough, or do we want
   a one-time bulk backfill that classifies the last ~N days to pre-warm priors?
2. **Domain vs exact-sender priors.** Do we want `domain:` fallback rows in v1, or only
   exact-sender priors (simpler, but `noreply@notifications.x` and `billing@x` don't
   share)?
3. **Prior staleness.** A sender's category can legitimately change (a vendor starts
   sending invoices). Do confident priors expire / re-validate, or only flip on a user
   correction or a low-agreement streak?
4. **Re-tag on correction.** When a correction locks a prior, do we retroactively re-tag
   other open threads from that sender, or only apply going forward?
5. **Boss latency in dev.** Boss runs gemini-2.5-pro (~min-scale per dev notes). Phase 2
   needs a fast smoke that doesn't wait on a full boss turn — reuse `smoke-triage-v2.ts`?
6. **Taxonomy untouched?** Confirm we're *not* revisiting categories (locked decision #1
   says no) even though R1's "user already replied" maps awkwardly onto `done`/`fyi`
   rather than a dedicated "waiting on them" bucket.

## 9. Alternatives rejected

- **Keep cheap-always, just add context to the prompt.** (= ADR-0042 #2 + rejected
  alt (g).) Rejected again: every email still pays a model call and a context fetch; no
  amortization; quality still capped by one cheap pass. The cache is the whole point.
- **Pure boss on every email.** (ADR-0042 alt (a).) Rejected: 10× cost/latency with no
  amortization. The cache makes boss affordable *because* it runs rarely.
- **Deterministic-only (no model).** Rejected: novel senders and genuinely ambiguous
  mail need judgment once; the cache captures it thereafter.
