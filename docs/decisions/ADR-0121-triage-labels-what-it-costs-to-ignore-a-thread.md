# ADR-0121 — Triage labels what it costs to ignore a thread; the model weighs evidence, and code decides only three things

**Status.** Proposed; not built. The design comes from a grilling session with the owner on 2026-11-06. The settled model is [`docs/theory/triage.md`](../theory/triage.md); this ADR records the decision and what it replaces. The build plan is [`docs/plans/triage-theory-v1.md`](../plans/triage-theory-v1.md).

Amends ADR-0051 (a stronger second decision is allowed, and the floor set shrinks), ADR-0066 (the significance-weighted category is kept, with a new label set and a new order of authority), ADR-0113 and ADR-0106 (an instruction in words is evidence for the model, not a typed effect that code applies), ADR-0050 (todos leave the triage step), and ADR-0025 (the label names). Keeps ADR-0048 (one label for each thread).

**Decision.** For each thread, triage decides what it costs the user to ignore it, and shows that as one label in the Gmail inbox. Nine labels in two tiers. The loud question comes first. The model weighs all evidence, and code overrules it in three cases only: the user's correction on the thread, an instruction that names one person, and the security check. Alfred's own past labels are never evidence. Todos, memory write-back, loop closing, asks, and reply drafts are follow-up workflows that read the result and never change a label.

## Why

These facts are from production (read-only, 2026-11-06, 1,512 `email_triage` rows) and from the code at `7c62f224a`:

- **The labels mix two questions.** Ten labels answer "what kind of mail is this" (`newsletter`, `marketing`, `payment`, `meeting`) and "what does it ask of me" (`urgent`, `action_needed`, `awaiting_reply`, `follow_up`, `done`). The readers of the category make only about four distinctions. The chess.com streak mail moved through `marketing`, `fyi`, `newsletter`, and `action_needed` from September to November, with confidence 0.8 to 0.99 each time.
- **The kind wins over the need.** All 6 payment-failure mails ("Your Voyage AI payment failed", "We had a problem billing your account") are `payment`, not `action_needed`. All 4 `meeting` rows are vendor webinars. No real meeting has the label.
- **Investor mail is loud.** Of 85 mails from brokers and share registries, 23 are `action_needed`: AGM and e-voting notices, smallcase reminders, TDS notices, and balance statements. The balance statements were `fyi` from the model and `action_needed` at the end, and the trace does not say what changed them.
- **An instruction lost its meaning.** The owner said "do not tag stock-related emails as urgent or treat scheduled meetings as my concern; apply this to all investment-related senders". It was stored as about 13 sender addresses, most without an effect that can change a category. Later fixes added domains. The share registries (kfintech, cameo, cams) match no rule.
- **The system learns from itself and never from the user.** `incrementSenderPrior` (`triage/workflow-operations.ts:568`) counts the model's own category. All 1,512 rows are `source='auto'`: the owner never corrected one. A label change in the Gmail UI is not seen, because `listHistory` reads only `messageAdded` (`connections/ingestion/gmail-ingest.ts:740`).
- **Triage knows little about the user.** It gets the name and address, 600 characters of cold-start research, and the job title and employer. No chat memory reaches it.
- **The rules grow without a theory.** `triage/` is 37 files and about 9,000 lines. The system prompt is about 42,000 characters with 38 numbered rules. Standing instructions are about 4,000 lines in 8 files. `classify.ts` had 40 commits since 2026-09-01. Each production error added a rule, and each rule moved its neighbours.

## Decisions

### 1. The job is the cost of ignoring the thread

Triage answers one question for each thread: what does it cost the user to ignore it. The label in the Gmail inbox is the product. The rail, the briefing, and reply drafting read the same result.

### 2. Nine labels in two tiers

Loud: `urgent`, `action`, `reply`. Quiet: `meeting`, `receipt`, `fyi`, `done`, `news`, `promo`. The stored category ids are these words. `awaiting_reply` and `follow_up` become `reply`. `payment` becomes `receipt`, and a payment that failed or needs an action is `action` or `urgent`. `meeting` is only a meeting that the user attends. The Gmail names are short words with no number prefix. Loud labels have strong colors. Quiet labels are pale or grey.

### 3. The loud question comes first

If a mail needs the user, it gets a loud label, whatever kind of mail it is. A quiet label is only for a mail that needs nothing. When triage is not sure, the label is `fyi`. A real matter under a quiet label is the worst error. Noise under a loud label is the second.

### 4. Evidence, with principles and no fixed rank

The model weighs the instructions, the corrections, the triage profile, sender facts, the user's actions, and the mail. The user's words win over an inference, specific wins over general, and newer wins over older. Instructions arrive with dates, oldest to newest. The label's reason names the evidence that decided it.

"The mail" is the text and one object of **mail facts**: the headers that tell who sent the mail, to whom, and if it is genuine (`From`, `Reply-To`, `To`, `Cc`, `Delivered-To`, `Return-Path`, `Authentication-Results`, `List-Id`, `Precedence`, `Auto-Submitted`, and each header whose name ends in `-Reason` or `-Class`), the presence of `List-Unsubscribe`, Gmail's `labelIds`, a calendar-invite flag, and the attachment names. Code copies each value as Gmail recorded it at arrival and does not interpret it. Code computes no verdict and adds no vendor rule. The model writes a `legitimacy` verdict (`genuine`, `doubtful`, or `fake`, with a short basis) as the first key of its answer, and then it writes the label. A `fake` mail gets a quiet label unless the user owns the obligation. The verdict goes to the trace and the reason only. No column stores it, and no floor reads it. Gmail's `SPAM` label is evidence, and Gmail is correct on most mail it files there.

### 5. Alfred's own labels are never evidence

`sender_priors` stops counting the model's category. A per-sender history may hold only what the user did: corrections and replies.

### 6. The triage profile

A short text about who the user is, who matters, what matters, and what is noise. The memory system writes it from chats, long-term memory, and cold-start research. Triage reads it on each call. The user can see and edit it. No search for each mail (ADR-0113 rule kept); a search is added only when an eval shows that the profile is not sufficient.

### 7. Instructions are the user's words

An instruction is stored in the words that the user said, clear or vague. The model applies a description of a kind of mail to any sender, including a new one. Alfred never converts a description into a list of senders. An instruction that names one person is resolved to an address once, at save time, and the user confirms it; code then applies it. A new instruction can apply to the last 30 days; from chat, Alfred shows a dry run first.

### 8. Code decides three things

Code overrules the model only for the user's correction on the thread, an instruction that names one person, and the security check. The sender-kind, meeting, and spam floors and the conflict pass become evidence for the model. Any change to a label after the model writes its cause to the trace.

### 9. A correction in Gmail teaches

A label change in the Gmail UI is a correction. It stays on that thread and is evidence for similar mail from that sender. A new message in the thread is judged again, with the correction as strong evidence.

### 10. A daily budget, and a second decision that code starts

The cheap model makes the first decision on each mail. A stronger model makes a second decision only when (a) the first is loud and the sender is a bot or bulk sender, or (b) the first is quiet and the mail has a money, access, or deadline signal. The cheap model's confidence never starts it. `deepen.ts` becomes this step or is deleted.

### 11. The prompt is the theory

The prompt is rewritten from the theory page. A past error becomes an eval case with its expected label, not a prompt rule.

### 12. Follow-up workflows read and never write the label

Todos (loud labels only, own prompt, behind the settings flag), memory write-back, loop closing with its asks (always on, at most 5 each day), and reply drafts run after triage on the `email-triage.classified` seam (ADR-0098). None changes a label.

## Preserved behavior

- One label for each thread, judged again on each new message (ADR-0048).
- A user override is never overwritten by the model.
- The security check stays absolute.
- The cheap model makes the first decision on each mail.
- The triage path reads no activity search and no embeddings (ADR-0113).
- Old threads are not triaged again when the labels change.

## Residual risk

- **The model can ignore a vague instruction.** Code no longer enforces its effect. The guards are the reason that names the instruction, the eval cases for each instruction, and the 30-day dry run.
- **The profile can go stale.** A wrong profile moves many labels at once. The user can see and edit it.
- **The second decision costs money.** The two triggers and the daily budget bound it. A day over budget falls back to the first decision.
- **Gmail cannot merge labels.** `awaiting_reply`'s label becomes `Reply`. The old `follow up` label stays on old threads and is not written again.

## Rejected alternatives

- **(a) More prompt rules for each error.** This is the current method, and it is the cause.
- **(b) Route the label from a table of structured stake facts.** It makes the model fill fields that it cannot judge well, and it moves the judgment into code.
- **(c) A fixed rank of evidence.** Recency and specificity change which source is right.
- **(d) Compile each instruction into sender targets.** It lost the meaning of the stock instruction in production.
- **(e) Escalate on low confidence.** The confidence does not measure the error.
