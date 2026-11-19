---
status: proposed
evidence: "Prod read-only 2026-11-06 (1,512 email_triage rows, 85 investor mails, 28 payment rows, 4 meeting rows, 35 standing-instruction rows) and code at 7c62f224a. Nothing built."
---

# Triage theory — v1 build plan

Builds [ADR-0121](../decisions/ADR-0121-triage-labels-what-it-costs-to-ignore-a-thread.md). The target is [`docs/theory/triage.md`](../theory/triage.md). Each slice must agree with that page. This plan replaces the draft `triage-context-v1.md`, which added mechanism without a theory.

The plan removes more than it adds. Each slice names what it deletes.

## Slice 0 — The eval deck (gate for every later slice)

Build the cases from the 2026-11-06 prod read. Each case has the label that the theory page gives it. Yash checks the expected labels once.

- chess.com streak and promo mail → `promo`, and the same label on each one.
- The 6 payment failures (Voyage AI, GitHub billing, Greptile low credit, Stripe "confirm your payment", Voyage "review your payment method") → `action`. Receipts and $0 invoices → `receipt`.
- The 4 vendor webinars (Arize ×3, aihero) → `promo` or `fyi`, never `meeting`.
- AGM and e-voting notices, smallcase reminders, TDS notices, and balance statements → quiet, under the stock instruction.
- CI and deploy failures from GitHub, Linear, Railway, and Vercel on Yash's own projects → `fyi`. Yash decided this on 2026-11-07. He ships many PRs a day on alfred and sees each failure in the PR. Blair is not active, and a Polylane autofix PR started its deploy. His activity decides the label, not the sender.
- Cold personal mail and AI-patterned outbound (`samuel@news.agensi.io`, `hi@agentcall.dev`, `talent@getclera.com`) and `pulse@jsgurujobs.com` (`urgent` today) → quiet unless a real person needs Yash.

The deck runs at $0 on the existing eval runner. Each later slice runs it before and after. A slice lands only when no case gets worse.

Built: `packages/assistant/evals/triage-deck.eval.ts`, with the cases in `evals/triage-deck/cases.ts` and the 21 prod instruction rows in `evals/triage-deck/instructions.ts`. The repo is public, so each body is a short excerpt with personal identifiers removed. Each case also records the label that prod gave it.

To add (2026-11-14, from [the echo section](../theory/triage.md#echoes-of-the-users-own-actions)): the nine sign-in and OTP echoes of 2026-11-12 and 11-13 → `fyi`, and one sign-in by another person → loud, so that the deck guards both errors. The A56 join trail is a journal case, not a deck case.

Built (2026-11-16): the deck takes the nine sign-in and OTP echoes of 2026-11-13 → `fyi` (`echoes-of-the-users-own-sign-ins`), with one synthetic sign-in by another person → loud (`sign-in-by-another-person-is-loud`). The echoes are the nine that went `urgent` in prod that day (probe P1). On the first run every echo came back `urgent`: the recorded fault that the slice 3 prompt rewrite takes. The loud case held `urgent`.

Baseline on 2026-11-07, before any slice: 67% and 70% on two runs (20 cases, 43 mails). Each run makes real model calls, so a case near a label boundary can change from run to run. Run the deck two times before and after a slice, and read the label of each mail, not only the total. The misses are the faults above: every payment failure gets `payment`, the webinars get `action_needed` or `meeting`, the own CI failures get `action_needed`, and the streak mails get three labels.

Gate tool per change (owner decision, 2026-11-16): the paired prod replay (`apps/server/src/scripts/dry-runs/triage-prompt-replay.ts`) is the gate for a prompt or model slice. The deck is the gate for a theory or product change. The replay compares before and after with no labels, so it sees every changed behavior; the deck checks the labels the owner set.

The deck now runs each case three times (2026-11-16). The runner scores each trial on its own and reports one result per trial. So read a case across its trials: a case regressed only when every trial misses it. One miss in one trial is run-to-run variance, not a regression.

## Slice 0b — The mail-facts reader (foundation)

- One reader of `documents.raw` builds the mail facts that [the theory page](../theory/triage.md#the-mail-facts) requires. Triage, the loop joins, the briefing, and the user model read from it.
- It reuses the parsing that exists. `reduceGmailDocument` in `packages/assistant/src/knowledge/gmail-reducer.ts` already parses the recipients (principle 3).
- This slice decides the wire shape and the trimming (principle 7).

**Removes:** the recipient and header parsing that triage does again by itself.
*Gate:* the eval deck holds, and each deck mail gets its facts from this reader only.

### Wire shape

`MailFacts` in `packages/assistant/src/knowledge/mail-facts.ts`. `readMailFacts(row, ctx)` is pure; `loadMailFacts(userId, documentIds)` reads the rows, the user's zone, the mailboxes, the known contacts, and the user's own replies.

| Field | Value |
| --- | --- |
| `documentId`, `messageId`, `threadId` | `documents.id`, `source_id`, `source_thread_id` |
| `arrivedAt` | `authoredAt`, else Gmail's `internalDate`; the wall clock in the user's zone with its year (`2026-10-19 13:30`), the short weekday, and the zone name |
| `sender` | address, display name, and `parse`: the whole `extractSenderContext` result (the sender context with the effective author, the parser that named a body actor, and the parsed address). The address and the name come from the string the parse read, with the raw `From` header as a fallback. The parse reads the stored `metadata.from`, the title, and the stored content with its envelope lines, as the classify step did before the reader, so this slice does not change it |
| `replyTo` | the `Reply-To` header, trimmed |
| `to`, `cc`, `bcc` | one entry per parsed address, each with `isUser` (one of the user's own addresses) and `knownContact`. `null` when the header is absent; `[]` when it is present and empty |
| `receivedBy` | the user's mailbox address for the row's account |
| `subject`, `body` | the subject header; the plain body |
| `ownReplies` | the user's sent messages in the thread at or before this mail's time, newest first |
| `stated` | `devices`, `places`, `apps`: copied from labelled body lines |
| `labelIds`, `spam` | `metadata.labelIds` first (a later write can change it), else the raw labels; `spam` is the `SPAM` label |
| `hasAttachments` | a part with a filename and an attachment id |
| `authenticationResults` | the header, kept for the DMARC check of ADR-0122 decision 1a |

Rules:

- **Headers.** One rule: the first occurrence of a name wins. Gmail puts the newest hop first, so `Authentication-Results` is Gmail's own. `gmailHeaderLookup` in the reducer is the one header walk, and the reducer and the reader share its address parsers. A row with no stored message falls back to `metadata.from`, `to`, and `cc`.
- **Trim.** The body stops at 6000 characters and ends in `[…truncated]`. At most 3 own replies, each cut to 500 characters, with quoted lines and the quoted history (from an `On … wrote:` line) removed. At most 5 values for each `stated` field.
- **Stated names.** Only a line of the shape `Label: value` in the first 200 body lines counts, with a value of 1 to 120 characters, copied as written. The labels (case-insensitive): devices `Device`, `Device name`, `Browser`, `Operating system`, `OS`, `Platform`; places `Location`, `Approximate location`, `Country`, `Country/region`, `Region`, `City`; apps `App`, `Application`, `Client`. A name stated only in a sentence stays in the body. This is a parser of the mail's words, not a verdict and not a sender list.
- **Known contact.** One batch read of the `person` aliases (`knownContactAddresses`) for the sender and every recipient. The user's own addresses are never known contacts. The sender's `Known contact:` observation reads the same aliases; the people-store step (ADR-0127) replaces both with one history line for each address, from `readCorrespondents`.
- **Best effort.** Each lookup that fails gives a warning and its empty value: no mailboxes, the UTC zone, no known contacts, no own replies.
- **What the triage prompt shows.** From, Reply-To, To, Cc (each address marked `(you)` when it is the user's own, else `(known contact)` when it is one; `(empty)` for an empty header), the receiving account, the arrival as `Date: 2026-10-19 13:30 (Mon, Asia/Kolkata)` (the label stays `Date`, because the prompt rules name "the email's Date", and the year resolves a deadline), the stated device, place, and app names, whether attachments are present, the subject, and the body. It does not show the authentication results or the own replies yet: slice 3 rewrites the prompt and decides them. The thread block stays as it is.

### Deck result (owner decision, 2026-11-15)

The owner kept the new fact lines as they are. The owner waived the deck rule ("lands only when no case gets worse") for this slice. Slice 3 takes these known misses:

- `vendor-webinars` mail 1: `fyi` before, `action_needed` now. The `Received by` line moves it.
- The new `spam-filed-sign-this-invite-sent-bcc-style` case: `action_needed` after the `Date` line got its year.

The line tests showed that one changed fact line moves mails near a category boundary in the current prompt. This is evidence for the slice 3 rewrite.

## Slice 1 — Stop the self-learning

- `classify` stops writing `incrementSenderPrior` with its own category (`workflow-operations.ts:568`) and stops reading the prior.
- `detectConflict` and the second cheap pass go, because they depend on the prior.

Built: https://github.com/99Yash/alfred/pull/1758.

**Removes:** the prior write and read, `priorBulkProfile`, `priorActionShare`, `detectConflict` (`classify.ts:575-730`).
*Gate:* the eval deck holds. The chess.com cases keep one label.

Held (owner, 2026-11-16): the gate fails without the prior. On the branch merged to today's main (#1767, #1768), three trials each: `chess-streak-mail-keeps-one-label` 0.50 → 0.25, and `voyage-review-payment-method-by-date` 1 → 0, both deterministic across trials. The removed second pass was also the echo amplifier: it re-asked when the label disagreed with the self-taught prior, and it re-escalated its own `fyi` echoes back to `urgent` (the echo case improves 0 → 0.22 with it gone). The owner chose to hold slice 1 until the slice 3 prompt rewrite makes the deck hold without the prior. The self-confirmation write keeps running in prod until then, and that cost is accepted. The resolved merge sits on the branch, unpushed. Slice 3 takes this deck state as its before-run.

Unheld (2026-11-17): slices 2 and 3 landed on this branch (the nine labels, the theory prompt, the floors fold), and the deck holds without the prior. Three trials each: `voyage-review-payment-method-by-date` 0 → 1, and the other five payment-failure cases 0 → 1; `chess-streak-mail-keeps-one-label` 0.25 → 1; the echo case 0.22 → 0.89. No case is worse than the held before-run. Slice 1 rides this branch to the same PR.

## Slice 2 — The nine labels

### Built (2026-11-17, with slice 3 and slice 1 in one PR)

- New category ids in `@alfred/contracts` (`urgent`, `action`, `reply`, `meeting`, `receipt`, `fyi`, `done`, `news`, `promo`), with `migrateTriageCategory` and `LEGACY_TRIAGE_CATEGORY_MAP` for readers of stored values. `follow_up` and `awaiting_reply` share `reply`; the split is gone.
- Migration `0173_triage_nine_labels`: one rename of stored values — `email_triage.category`, `email_triage.model_verdict`'s category, the `force_category` effect on standing instructions, and `sender_priors.last_category` — then the two CHECK constraints. The history tables (`email_triage_changes`, `agent_decision_traces`, run states) keep their old values: history is never rewritten. Not a new triage run.
- Gmail labels renamed in place (`ensureAlfredLabels` patches a label that still carries its numbered name to the new name and the theory's color, so the id and every message stay); `3: follow up` is not written again and stays on old threads. New labels carry colors from the theory page.
- The readers followed: attention scores (`reply` 0.7, `receipt` 0.55, `news` 0.1, `promo` 0.05), rail suppression, reply-drafting eligibility (`reply` only), briefing buckets, the drift audit, loop categories, and the web rail chip colors.

## Slice 2a — What triage tags

- Triage skips mail outside the scope of [the theory page](../theory/triage.md#what-triage-tags). The Gmail labels decide: `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_FORUMS`, `SPAM`, no `INBOX`, or a mail from Yash's own address to his own addresses only.
- In the same PR, the briefing reads the mail that triage did not label, from `documents`. Today the briefing reads only `email_triage` rows (`briefings/gather.ts`). Without this change, the briefing loses that mail.
- The briefing says when a mail that it reports is in spam.

**Removes:** the triage calls on mail outside the scope, and the spam floor.
*Gate:* the eval deck holds. Each deck case outside the scope expects no label. The two spam-filed deck cases (`spam-filed-sign-this-invite-sent-bcc-style`, `spam-filed-recruiter-ask-on-the-users-own-application`) change to a skip check, and to a check that the briefing says the mail is in spam.

### Built (2026-11-15)

- `triageOutOfScope` (`packages/assistant/src/triage/scope.ts`) reads the mail facts and gives where the mail sits: `spam`, `not_in_inbox`, `social`, `promotions`, `forums`, or `to_yourself`. The classify step calls it after the sent-mail check and before any model call. To find "to yourself", the reader now marks the sender with `isUser`, as it marks each recipient.
- The briefing did not lose this mail. The composer's `list_emails_since` already listed every Gmail mail of the window, with or without a label. The gap was that it could not see where a mail sits. Each item now carries `outsideTriage`, from the same function (or `sent_by_you` for the user's own sent mail). The composer prompt says how to judge such mail and to say "spam" for a mail in spam.
- The window (owner, 2026-11-15): the briefing picks mail by `ingested_at` since the last briefing, and orders it by `authored_at`. It is not moved to the sent time. The composer's list (`list_emails_since`) now returns its mail in sent order; before, it used the received order. See [stores.md](../theory/stores.md#3-time).
- The deck: each out-of-scope mail names its expected scope (`outOfScope`). The deck checks the skip and makes no model call for it. Out of scope: `chess-promo-mail`, `vendor-webinars`, two of three `broadcast-event-invites`, one `cold-and-automated-outreach` mail, `newsletter-about-a-hack-is-not-a-security-alert`, and the two spam-filed cases.
- The briefing check: `apps/server/evals/briefing-out-of-scope-mail.eval.ts` runs the composer on the two spam-filed mails. The recruiter ask must appear and say spam. The sign-this invite must be dropped, or appear with spam. It shares the composer harness (`apps/server/evals/lib/briefing-scenario.ts`) with the notification-reminder eval.
- Two mails in one thread: a thread that triage labelled can get a new mail outside the scope. The list item then has the thread's label and `outsideTriage`. The prompt says that the label is from an earlier mail.
- `to_yourself` is rare: the user's own copy has `SENT`, and the sent-mail check skips it first. It fires for mail from one of the user's addresses to another, with each visible recipient the user's own. A mail with no visible recipient stays in scope.
- The four spam rows of `triage-classify.eval.ts` are deleted: they tested the model and the spam floor on mail that no longer reaches the model.
- Left for slice 3: prompt rule 20 and the other spam lines in `classify.ts`. No spam mail reaches the model now, so they have no effect.
- Not covered: Gmail can set the tab labels when the user has turned the inbox tabs off. Then this rule still skips Promotions mail, against the theory line "when the inbox has no category tabs, all inbox mail is in scope". Alfred reads no setting that says whether the tabs are on, so this rule cannot tell.

## Slice 3 — The prompt is the theory

### Built (2026-11-17, with slices 2 and 1 in one PR)

- `SYSTEM_PROMPT` is the theory page in prompt form: the job, the nine labels, precedence, the echoes, the evidence principles, and the instruction line. One prompt, no todo variant, no `proposeTodo`. The 38 numbered rules and the todo rubric are gone; the todo lane mints nothing until slice 7.
- The sender-kind and meeting floors are deleted; `applyFloors` holds only the override (security) floor, and `FLOOR_TRACE_PROJECTIONS` carries only it. Their judgments are evidence lines in the prompt now.
- `resolveTodoSuggestion`, `todoSuppressionReason`, and their helpers are deleted; `decideTriageTodo` keeps its signature and mints nothing. `triage-classify.eval.ts` lost the todo scorers and keeps the category, collab, and judge scorers.
- The paired prod replay (40 real mails, before-run snapshotted from the held slice-1 state) shows only theory-consistent movement: the own-project build failures lose their false `urgent` (→ `action`, the own-CI residual the gather takes in slice 6), the renames, and quiet-to-quiet moves. No mail got louder.
- The deck (three trials, before-run from the held branch): no case is worse, twelve cases improve. All six payment-failure cases 0 → 1 (`receipt` → `action` fixed); the echo case 0.22 → 0.89; `chess-streak` 0.25 → 1; evoting/TDS 0.67 → 1; cold outreach 0.5 → 0.75; `sign-in-by-another-person-is-loud` holds 1 after the echo test sharpened to the page's "only while the facts fit" line. The theory page gained one decided case from this gate: an engagement nudge is Promo or FYI, never Action (owner decision of 2026-11-07, recorded where the page's other decided cases sit). Two misses are equal on both sides and wait for later slices: `a-person-answered-his-question` (0 on both) and two of five own-CI mails (0.4 on both — the gather's job, slice 6).

## Slice 4 — The triage profile and instructions in words

- The memory system writes one triage profile from chats, long-term memory, and cold-start research. It has two parts ([the profile](../theory/triage.md#the-profile)): a durable part, and a now section of at most 10 lines with decay dates. The now section stays empty until the journal exists. Yash can see and edit it. `classify` reads it on each call.
- Each active instruction goes to the model in Yash's words, with its date, oldest to newest.
- An instruction that names one person is resolved to an address at save time, Yash confirms it, and code applies it.
- `rematch` becomes "triage the last 30 days again". From chat it shows a dry run first.
- The 21 stored stock and smallcase rows become the instructions in Yash's words. The sender lists and the misplaced phrasing from the 2026-10-16 backfill go.

**Removes:** the scope, target, and effect matching (`standing-scope.ts`, `floors/standing.ts`, the effect derivation in `effective.ts`), and most of the matching in `knowledge/standing-instructions.ts`.
*Gate:* new eval cases for each instruction. A registry that has no rule today (kfintech, cameo, cams) gets the quiet label from the words alone.

## Slice 5 — A correction in Gmail teaches

- The Gmail history read also asks for `labelsAdded` and `labelsRemoved`. An Alfred label that Yash changes becomes a correction row, with the same effect as a rail override (`source='user'`).
- The correction is evidence for similar mail from that sender. `categoryFromLabelName`, which has no caller today, does the mapping.

*Gate:* a relabel in Gmail is seen, stays on the thread, and appears as evidence on the next mail from that sender.

## Slice 6 — The gather

- `deepen.ts` becomes the gather ([Cost](../theory/triage.md#cost)): a read-only Code Mode program, then the model decides again. It has the three triggers from the theory page and a daily budget in settings. Low confidence is not a trigger.
- The gather reads only the stores that are built: first the activity record, the thread, and the sender facts. Chats, claims, and journal notes join it when they are built.
- On a day over budget, the first decision stands.

**Removes:** `shouldDeepen`, and the dormant `dossierRequest` path if no other reader needs it.
*Gate:* the trigger rate and the cost per day are in the trace. The payment-failure cases are caught when the first decision misses them. The echo cases keep `fyi`, and the sign-in by another person is loud.
*Waits here:* the deck case `deepinfra-scoped-keys-newsletter-is-quiet` (owner decision 2026-11-19). Prod gave the DeepInfra bulk newsletter `action` at 0.9 from the first pass alone. Three prompt-wording attempts moved the confidence to 0.8 and never flipped the label, and a principle-form rewrite of the case bullets regressed `sign-in-by-another-person-is-loud` and the chess-streak cases in a paired probe, so the prompt change was reverted. The loud-plus-bulk-sender trigger, with the activity record in hand, is the piece that decides it.

## Slice 7 — Follow-up workflows

- Todos become a follow-up on the `email-triage.classified` seam, for loud labels only, with their own prompt and the settings flag.
- The `gmail/email_interpretation` link write moves from `classify` to the same seam, because it serves loop closing (ADR-0120).
- The `open-document-ask` step and the `document_ask` column go.
- The triage workflow is `classify` → `apply-label`. `close-loop-todos` moves to the todo follow-up.

**Removes:** `todo-decision.ts`, `instruction-todo-sweep.ts`, `runEmailTriageOpenDocumentAsk`, `sentDocumentStatusAtClassifyTime`, and `runEmailTriageCloseLoopTodos` from triage.
*Gate:* with the todo flag on, loud labels mint todos, and no quiet label mints one.

## Not in this plan

- Loop closing and asks (always on, at most 5 each day). This needs its own session.
- Memory write-back from mail.
- Moving or archiving mail.
- Triaging old threads again.
