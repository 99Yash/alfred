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

Baseline on 2026-11-07, before any slice: 67% and 70% on two runs (20 cases, 43 mails). Each run makes real model calls, so a case near a label boundary can change from run to run. Run the deck two times before and after a slice, and read the label of each mail, not only the total. The misses are the faults above: every payment failure gets `payment`, the webinars get `action_needed` or `meeting`, the own CI failures get `action_needed`, and the streak mails get three labels.

## Slice 0b — The mail facts

Before this slice, the model saw a few Gmail signals that code had interpreted (`spam=true`, a calendar regex hint). It could not see the headers that show if a mail is genuine. A phishing invite in Gmail's spam folder got `action_needed` and went into the morning brief on 2026-11-10.

- `readMailFacts` (`@alfred/integrations/google`) reads one object of verbatim facts from `documents.raw`. ADR-0121 decision 4 names the fields.
- `classify` sends that object in place of the `Gmail signals:` line.
- The model answers with a `legitimacy` verdict first (`genuine`, `doubtful`, `fake`), then the label. The facts alone did not move the spam-filed invite off `meeting`; the verdict did.
- Two deck cases test it: a spam-filed signature-request invite (`fyi`) and a spam-filed recruiter reply on Yash's own application (`action_needed`).

**Removes:** `CALENDAR_RE` and `hasCalendarInvite`, and the calendar hint in the prompt. `GmailSignals` stays until slices 1 and 3, because the conflict pass, the spam floor, and the trace still read it.
*Gate:* the eval deck holds, and the two new cases pass.

Result on 2026-11-10, 2 runs on each side, the same labels in each run: old mails 25/43 before and 27/43 after, and both new cases pass. Two old mails got worse, and Yash accepted them: the Vercel "Production deployment failed" mail and the REIT TDS notice moved from `fyi` to `action_needed`. The model reads the user's address in `To` as a reason to act. Slice 3 owns that prompt text.

## Slice 1 — Stop the self-learning

- `classify` stops writing `incrementSenderPrior` with its own category (`workflow-operations.ts:568`) and stops reading the prior.
- `detectConflict` and the second cheap pass go, because they depend on the prior.

**Removes:** the prior write and read, `priorBulkProfile`, `priorActionShare`, `detectConflict` (`classify.ts:575-730`).
*Gate:* the eval deck holds. The chess.com cases keep one label.

## Slice 2 — The nine labels

- New category ids: `urgent`, `action`, `reply`, `meeting`, `receipt`, `fyi`, `done`, `news`, `promo`, in `@alfred/contracts`.
- One migration maps the stored rows: `action_needed` → `action`, `awaiting_reply` and `follow_up` → `reply`, `payment` → `receipt`, `newsletter` → `news`, `marketing` → `promo`. The `email_triage_category_valid` check follows. This is a rename of stored values, not a new triage run.
- Gmail labels are renamed in place, with no number prefix, and with the colors from the theory page. `4: awaiting reply` becomes `Reply`. `3: follow up` is not written again and stays on old threads.
- The readers follow:
  - attention scores (`contracts/src/attention.ts`);
  - rail suppression;
  - reply-drafting eligibility (`reply` only);
  - briefing buckets and the "Also seen" line;
  - the drift audit.

**Removes:** `follow_up` and the follow-up/awaiting split in the prompt and in reply drafting, plus the numbered `LABEL_NAMES`.
*Gate:* the compiler finds every reader. Each Gmail label is renamed, not created again.

## Slice 3 — The prompt is the theory

- The system prompt is rewritten from the theory page. It holds the job, the labels, precedence, the evidence principles, the profile slot, and the instructions slot.
- The 38 numbered rules and the todo rubric go.
- The sender-kind, meeting, and spam floors become evidence lines for the model.
- `applyFloors` keeps only the security floor (`floors/override.ts`) and the named-person instruction rule. Any step after the model that changes the label writes its cause to the trace.

**Removes:** `floors/sender-kind.ts`, `floors/meeting.ts`, `floors/spam.ts`, the rule text and `TODO_RULE`/`TODO_EXEMPLARS` in `classify.ts`, and the todo suppression code in `classify.ts` (`todoSuppressionReason`, `resolveTodoSuggestion`).
*Gate:* the eval deck is better on the payment, webinar, and investor cases, and no case is worse. Todos stay off until slice 7.

## Slice 4 — The triage profile and instructions in words

- The memory system writes one triage profile from chats, long-term memory, and cold-start research. Yash can see and edit it. `classify` reads it on each call.
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

## Slice 6 — The second decision

- `deepen.ts` becomes the second decision, with the two triggers from the theory page and a daily budget in settings. Low confidence is not a trigger.
- On a day over budget, the first decision stands.

**Removes:** `shouldDeepen`, and the dormant `dossierRequest` path if no other reader needs it.
*Gate:* the trigger rate and the cost per day are in the trace. The payment-failure cases are caught when the first decision misses them.

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
