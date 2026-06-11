# Triage relevance — session handoff (2026-06-11)

**Purpose.** Continuity artifact for a fresh context window. Captures the chronological
progression, evidence, what shipped, and the open design decisions from a working
session on email-triage misclassification. Single-user app (Yash); accounts
`yash.k@oliv.ai` (work) and `yashgouravkar@gmail.com` (personal).

---

## TL;DR status

| # | Item | State |
|---|------|-------|
| 1 | **Rule 12e** — activity-feed/task-tracker mail classified by ownership, not subject | ✅ Shipped (PR #112, deploy `9e8415f0`), backfill applied |
| 2 | **`sanitizeTodoName`** — deterministic hedge-title guard for rail todos | ✅ Shipped (PR #113, deploy `a89ff3b1`) |
| 3 | **Backfill re-run** to clean the 21 existing hedge-title todos | ⏳ Pending (destructive; awaiting go-ahead) |
| 4 | **Greptile / vendor-upsell** misclassification (Layer 1 rubric — rule 11a) | ✅ Built + validated live (smoke 4/4); uncommitted, PR pending |
| 5 | **Standing instructions / durable memory** (Layer 2) | 🔭 Designed (ADR-0056/0057), not built |
| 6 | **Recurrence/dedup** of repeated notifications (Layer 3) | 🔭 Not started |
| 7 | **One-sided sender-prior brake** (Gap #1) | 🔭 Not started — the structural "again" mechanism |

Key files:
- `packages/api/src/modules/triage/classify.ts` — `SYSTEM_PROMPT` (rules incl. 12e),
  `sanitizeTodoName`, `resolveTodoSuggestion`, `detectConflict`, `applyOverrideFloor`,
  `todoSuppressionReason`.
- `packages/api/test/triage/classify.test.ts` — pure-fn tests (`tsx --test`).
- `apps/server/src/scripts/backfill-triage-committed.ts` — committed backfill.
- `apps/server/src/scripts/smoke-triage-clickup.ts` — live flash-lite validation for 12e.
- Reference: `docs/reference/triage.md`; memory `reference_prod_db_access`.

---

## Chronological progression

### 1. The reported bug (ClickUp → `action_needed`)
Yash: a ClickUp email on `yash.k@oliv.ai` was tagged `action_needed` but the comment said
*"nothing to be done — product understanding gap for the user."*

**Evidence (prod, `doc_z4cqduzg0dow`, thread `19eb61856174ba57`):**
- From: `Oliv AI <notifications@tasks.clickup.com>` (Gmail label `CATEGORY_UPDATES`).
- Subject (= `documents.title`): *"Conservice : Fix deal views resetting to open deals after
  saving and ensure filters persist"* — this is the **ClickUp task name**, not a directive.
- Body: *"Akshay Jyothis commented: Nothing to be done here - was a product understanding gap
  for the user."*
- Tag: `action_needed` @ 0.8, model `gemini-2.5-flash-lite` (no `+2pass` → single pass).
- It also minted a rail todo *"Review Conservice task comment"* (a hedge title rule 16f bans).

**Root cause (two compounding misreads):**
1. **Imperative-subject anchoring** — the model read the task-name subject as a command.
2. **Referent confusion** — "the user" in the comment = the product's end customer; the model
   read it as Yash and invented an obligation. The comment is a *closure*.

**Systemic, not one-off.** ClickUp histogram (current triage rows joined to clickup docs):
`action_needed: 22, done: 7, fyi: 3, urgent: 3, awaiting_reply: 1, meeting: 1`.
And ~8 rail todos minted off the activity feed (several hedge-shaped). **No deterministic net
catches it** — `detectConflict`'s over-classification net only fires for ≥80%-*bulk* priors;
ClickUp's prior was `action_needed`-dominated → a **self-reinforcing loop**.

### 2. Fix — rule 12e (principle, not a ClickUp exemplar)
`notifications@tasks.clickup.com` already resolves to `effectiveAuthor=service`, so rule 12d
("classify from body") existed but was too weak to beat the imperative subject. Added **rule
12e** to `SYSTEM_PROMPT`: activity-feed / task-tracker notifications (ClickUp, Linear, Asana,
Jira, Notion, GitHub Issues, doc/comment threads, support/CRM) classify from the **body event
+ ownership**, never the subject. `action_needed`/`awaiting_reply` only when the item is
assigned to the user, the user is @-mentioned with a concrete ask, or a reply is owed by them;
third-party comment / watched-item activity → `fyi`, explicit closure → `done`. Names the
"the user"/"the customer" = end-user-not-recipient trap. Plus two boundary category exemplars
and one todo-decision exemplar.

**Validated live** (`smoke-triage-clickup.ts`, gemini-2.5-flash-lite):
- real miss → `done`, no todo — **even under a 20/28 `action_needed` prior** (beats the prior);
- task assigned to user → stays `action_needed` + todo;
- direct @mention question → `action_needed` + todo.

PR #112 merged (squash `8d45d3f8`), deploy `9e8415f0` SUCCESS.

### 3. Backfill (prod)
Ran `backfill-triage-committed.ts` on prod via `railway ssh -s server` + the in-container
`tsx` (see Operational notes), `BACKFILL_RECENT_LIMIT=100 … --commit`:
- Deleted **57** stale agent todos (19 personal + 38 work).
- Enqueued **217** re-triage runs (104 + 113); all 217 drained.

**Verified:** the offending thread flipped `action_needed` → **`done`**, no todo. The remaining
ClickUp `action_needed` rows are now **ownership-grounded** (rationales cite *"assigned to the
user"*, *"@Yash Kar mentioned"*, *"reply to add a comment"*) — correct, because those are
genuinely Yash's assigned work tasks. The count not collapsing to zero is intended: the fix is
"classify by ownership," not "make all ClickUp `fyi`."

### 4. Backfill exposed the hedge-title gap (Gap #2, now fixed)
**21 of the rebuilt todos** still led with banned hedge verbs:
`Look into…`, `Investigate baserow response time alarm` (×… ), `Review Docker Sandbox use cases`,
`Check Baserow alarm`, `View task Eng in rotation…`, `Address Dependabot alerts…`. Rule 16f bans
these but flash-lite kept emitting them with no deterministic guard (unlike `sanitizeAssist`).

**Fix — `sanitizeTodoName`** in `resolveTodoSuggestion` (the single chokepoint: prod workflow +
dry-run + attribution all route through it). Strips an **unambiguous** lead hedge verb
(`look into` / `investigate` / `view` / `take a look at` / `dig into` / `provide info`) into an
object-led title (`Investigate baserow response time alarm` → `Baserow response time alarm`).
**Deliberately narrow & safe:** `review`/`check`/`address`/`confirm`/`verify` are EXCLUDED (they
can be the real action — "Review the contract"); `\b`-anchored to avoid embedded-word matches
("Viewer …"); **never drops** a todo (a degenerate strip keeps the original). 54/54 tests pass.
PR #113 merged (squash `972c82a3`), deploy `a89ff3b1`.

> ⚠️ `sanitizeTodoName` applies **forward only** — the 21 existing hedge todos in prod need a
> backfill re-run to clean (item #3, pending).

### 5. Greptile / vendor-upsell question (open — Layer 1/2/3)
Yash: Greptile emails about quota expiring / "upgrade your plan" are tagged `action_needed`; he
does *not* intend to upgrade, and Greptile posts one **per PR**. "Manufactured urgency or a real
vendor needing payment — how do we go about this, structurally?"

**Evidence (prod, `yashgouravkar@gmail.com`):** it's a **GitHub PR comment from
`greptile-apps[bot]` `<notifications@github.com>`**, body:
> ``99Yash`` has reached the 50-review limit for trial accounts. To continue receiving code
> reviews, [upgrade your plan](https://app.greptile.com/review/github).

Tagged `action_needed` @ 0.8–0.9 on PR #111, #112, #113, and `pnpm-elysia-template#1`. Rationale:
*"needs to upgrade their plan… requires a concrete action."*

**It's already wrong on today's rubric:** `effectiveAuthor=bot` → rule 12a says `fyi` by default;
12b escalates only for *severe impact* (exposed secret, auth bypass, data loss, outage, blocked
deploy). "Upgrade your plan" is none → the model is misreading the upsell as severity.

**Structural framing — the manufactured/real axis splits into content vs. intent:**

- **Layer 1 — content can decide *upsell vs. owed* (recommended next).** The discriminator is
  **is money owed?** *"Upgrade your trial / hit your free quota / unlock more"* = nothing owed,
  optional service, vendor-manufactured conversion pressure → `marketing`/`fyi` (+ no todo).
  *"Payment failed / card declined / invoice due / owed on a paid plan"* = money owed →
  `payment`/`action_needed`. This is a real rubric gap (the rubric names manufactured *engagement*
  (streaks) and *ceremonial* (AGM) urgency, but not manufactured *conversion/upsell* urgency).
  Naming it fixes **every freemium vendor** (Vercel, Linear, Greptile) from content alone.
- **Layer 2 — only the user can decide "I'm not paying for Greptile" (the true destination).**
  Even correctly `fyi`, Yash has *decided* not to upgrade — pure user intent, unknowable from
  content. This is the standing-instructions / durable-memory layer (ADR-0056/0057, memory
  `project_standing_instructions_vision` / `project_long_term_memory_foundation`): say it once →
  memory → triage demotes that vendor. Greptile is a strong forcing function for that build.
- **Layer 3 — the every-PR repetition is its own problem (dedup).** Same class as the
  `baserow alarm ×4` dupes: same sender + same template body → suppress repeats / fold into one
  rolling item, independent of category.

**Recommendation:** do Layer 1 now (principled, content-only, generalizes); fold the Greptile
re-tag into the pending backfill (#3). Treat Layer 2 as the strategic answer to "I don't intend
to do that." Layer 3 kills the repetition.

---

## Open design decisions (for the next context)

1. ~~**Greptile Layer 1 rubric clause.**~~ ✅ DONE (2026-06-11, uncommitted). Added **rule 11a**
   (sub-clause of payment-precedence — no renumbering) to `SYSTEM_PROMPT`: the discriminator is
   **is money owed?** Upsell/quota/"upgrade to continue" pressure where nothing is owed →
   `marketing` (plain neutral notice → `fyi`), never `payment`/`action_needed`/`urgent`; money
   owed on an existing paid relationship (failed payment, past-due invoice, card-will-be-charged)
   → `payment`. Holds for bot relays too (rule 12a still applies). Extended **16b**'s
   manufactured-stake list to name conversion/upsell pressure → no todo. Added one
   subject→category exemplar (Greptile bot upsell) + one todo-decision exemplar (vs. real invoice).
   Validated live via `apps/server/src/scripts/smoke-triage-upsell.ts` (gemini-2.5-flash-lite,
   **4/4**): Greptile miss flips `action_needed`→`marketing` under its self-reinforcing prior
   (rationale cites 11a); real Stripe failed-payment and past-due Linear invoice both stay
   `payment` + keep todos (no over-suppression); direct Vercel upgrade pitch → `marketing`, no todo.
   54/54 pure-fn tests + `@alfred/api`/`server` typecheck clean. **Still pending:** commit+PR, then
   fold the Greptile re-tag into the backfill (#3).
2. **Gap #1 — one-sided sender-prior brake (highest-leverage structural fix).** `detectConflict`'s
   over-classification net only fires for ≥80%-*bulk* priors. There is **no symmetric guard** for
   a sender wrongly skewed toward an *important* category (`action_needed`/`urgent`) — which is
   how ClickUp (and Greptile) self-reinforced. Proposed: trigger a second pass when an important
   category is chosen for a sender whose prior is overwhelmingly important AND the body shows no
   supporting severity. The backfill is a one-time mop, not a brake; without this, the next
   wrongly-skewed sender re-poisons silently. This is the mechanism behind "we have an issue
   *again*."
3. **Layer 2 — durable memory / standing instructions.** Designed (ADR-0056/0057) but unbuilt.
   The destination for all user-relative relevance (vendor mutes, "I don't care about X").
4. **Layer 3 / dedup.** Recurrence collapse for identical vendor notifications (Greptile per-PR,
   CloudWatch `baserow alarm ×4`).

---

## Operational notes (prod) — see memory `reference_prod_db_access`

- **No public Postgres proxy.** Query prod by exec'ing inside the `server` service over the
  internal network: `railway ssh -s server "<cmd>"`. `pg@8.20.0` is at
  `/app/node_modules/.pnpm/pg@8.20.0/node_modules/pg`. Pattern used here: base64 a `*.cjs`
  locally → `echo <b64> | base64 -d > /app/x.cjs && cd /app && node x.cjs` → `rm`.
- **Running committed workspace TS scripts on prod (backfills):** the `server` container has the
  FULL source tree at `/app` **and** `apps/server/node_modules/.bin/tsx`. So:
  `railway ssh -s server "cd /app/apps/server && BACKFILL_RECENT_LIMIT=100 ./node_modules/.bin/tsx src/scripts/backfill-triage-committed.ts [--commit]"`.
  No tsdown-entry/rebuild needed (the script header claiming "no tsx on prod" is stale as of
  2026-06-11). The backfill enqueues to prod BullMQ; the prod worker (deployed code) drains it —
  so **deploy the prompt change BEFORE backfilling**, or the worker re-triages with old code.
- **`railway run --service server` does NOT work locally** — it injects `*.railway.internal`
  hostnames that only resolve on-network.
- **Backfill semantics:** deletes ALL `created_by='agent'` todos for the target users, then
  re-triages (recent N threads ∪ threads behind deleted todos), re-tagging Gmail and re-minting
  todos under the current rubric. Dry by default; `--commit` to write. Re-running is the only
  way to retro-apply a prompt change to already-tagged mail.

---

## Footnote — concurrent work incident
During this session, unrelated working-tree edits appeared in `apps/web` (a markdown-renderer
feature: `unist-util-visit` dep + `markdown-renderer/index.tsx` + new
`routes/-preview-briefings/briefing-markdown.tsx`). These were mistakenly reverted, then
restored (`unist-util-visit` dep re-added, lockfile regenerated via `pnpm install --lockfile-only`,
the `.tsx` files left untouched). The triage PRs (#112/#113) staged files explicitly and contain
none of it. The regenerated lockfile entry may differ trivially from the concurrent author's —
a `pnpm install` reconciles.
