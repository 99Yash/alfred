# Triage: the theory

This page states what email triage is for and the rules that follow from that. It is the owner's model, settled in a grilling session on 2026-11-06. It is the target, not a description of the built code. [`product-flow.md` §3](./product-flow.md#3-email-tagging-triage) records the built flow. [ADR-0121](../decisions/ADR-0121-triage-labels-what-it-costs-to-ignore-a-thread.md) records the decision and what it replaces.

Each triage ADR, plan, and prompt change must agree with this page. If a change does not agree, update this page first, or do not make the change.

Last verified: 2026-11-14 (owner decisions on echoes, the profile, the mail facts, and the gather; previous: 2026-11-06 at `7c62f224a`).

---

## The job

For each thread, triage decides **what it costs Yash to ignore it**. It shows that answer as one label in the Gmail inbox. Triage does nothing else.

Yash reads the labels in the inbox list. He does not filter by them. Thus a loud label must be correct, and a quiet label must not attract the eye.

## The labels

| Tier  | Label   | Meaning                                    | Look   |
| ----- | ------- | ------------------------------------------ | ------ |
| Loud  | Urgent  | It costs you something today.              | red    |
| Loud  | Action  | You must do something.                     | orange |
| Loud  | Reply   | A person waits for your answer.            | blue   |
| Quiet | Meeting | A meeting with you that specific people arranged — never a broadcast event. | pale   |
| Quiet | Receipt | Money moved, and nothing went wrong.       | pale   |
| Quiet | FYI     | Useful to know. Nothing to do.             | pale   |
| Quiet | Done    | The matter is finished. Nothing is left.   | pale   |
| Quiet | News    | Something that you subscribed to.          | grey   |
| Quiet | Promo   | Someone sells you something.               | grey   |

**Precedence.** Triage asks the loud question first. If the mail needs Yash, it gets a loud label, whatever kind of mail it is. Only a mail that needs nothing gets a quiet label. This is a hard rule, not a case-by-case judgment.

- A failed payment, a card that expired, or a service that will stop is **Action**, or **Urgent** when access stops today. It is never Receipt.
- Meeting is a meeting with you that specific people arranged — confirmed, proposed, or arranged by a scheduling service for you and one person. An event with an open audience — a webinar, a seminar, a cohort session, a conference — is never Meeting, even when you registered for it and the invite sits on your calendar. The other attendees decide, not the calendar object.
- Webinars, AGMs, e-voting notices, investor calls, and earnings calls are never Meeting.
- When triage is not sure, the label is **FYI**. FYI never hides a mail and never raises a false alarm.

Names are short words. No number prefix.

## Echoes of the user's own actions

A sign-in confirmation, a new-device notice, an OTP mail, and a backup-code mail are usually records of an act that Yash did himself. Such a mail is an **echo** while the facts fit that act. (Owner decisions, 2026-11-13 and 2026-11-14, from the nine-mail sign-in and OTP cluster of 2026-11-12 and 11-13.)

- **An echo is FYI.** It is never Urgent and never Action. This is the not-sure rule: triage usually cannot see whether Yash did the act.
- **A mail is an echo only while the facts fit Yash's own act.** The model weighs these facts together:
  - the service, and the device, place, and app that the mail names;
  - the account that got the mail: a work account or a personal account;
  - the arrival time in Yash's zone, against his usual hours from the profile. Workdays and weekends can differ;
  - Yash's own acts near that time, from every integration. The gather reads them ([Cost](#cost)).
- **When the facts point to another person, the mail is a security notice, not an echo.** The loud question then applies, as for any other mail.
- No rule turns one fact into a label. An odd hour alone does not make a mail loud. The reason names the facts that decided it.
- An OTP in the inbox is **not** the exposed-secret case of "what code decides". The model weighs an OTP mail like the other echoes.
- Every echo starts the gather, because it is quiet and carries an access signal ([Cost](#cost)). Echoes are few each day, so this cost is small.
- What is live in Yash's life now reaches the first call through the profile's now section. An example: he bought a phone, and he signs in on new devices. The first call searches nothing.
- At briefing time the journal owns the confirm. A remark on a security notice asks "was that you?", and it never makes the notice look safe ([journal.md §6](./journal.md#6-speak-and-what-happens-after)). Neither answer changes the label. A "no" is an alarm in the same chat turn.
- The strongest evidence that an echo is routine is often in the same mailbox: the order confirmation for the device, the booking, or the receipt of the act behind it. The pre-briefing pass joins that receipt to the echo ([journal.md §5](./journal.md#5-read-two-nets-that-catch-a-link)). The order confirmation can open the matter, and the echoes join it ([journal.md §4](./journal.md#4-write-who-writes-an-entry)). When no reference point exists, for example when someone else ordered the device for Yash, the not-sure rule applies. The model never assumes.

**Eval cases.** The nine echoes of 2026-11-12 and 11-13 have the label FYI. The trail around them is the eval case for the **join**: the Flipkart order of the Galaxy A56 (11-08), the setup prompt, the Wallet registration, and the delivery notice (11-13). All four sat under quiet labels while five echoes went Urgent. The deck also needs a sign-in by another person, with a loud label, so that it guards the worst error too.

## What counts as an error

- A real matter under a quiet label is the worst error.
- Noise under a loud label is the second error. It causes Yash to stop trusting the loud labels.
- The same kind of mail from the same sender must keep its label, unless the mail contains something new: a real deadline, money that is owed, or a person instead of a bot. A label that changes without new evidence is a defect. This is a check that the evals run. It is not a separate mechanism.

## The evidence

The model weighs these:

- Yash's standing instructions.
- Yash's corrections.
- The **triage profile** (see [The profile](#the-profile)): who Yash is, who matters to him, what is noise to him, and what is live in his life right now. Triage only reads it.
- Facts about the sender, when Alfred has them.
- What Yash did, for example a reply to this sender.
- The mail itself.

The evidence has no fixed rank. The model uses these principles:

- Yash's own words win over an inference.
- A specific item wins over a general one.
- A newer item wins over an older one. Instructions arrive with their dates, from oldest to newest.
- **Alfred's own past labels are never evidence.** A system that learns from its own guesses repeats its errors.

The reason on each label names the evidence that decided it.

## The profile

Two bounded parts (owner decision, 2026-11-14):

- **Durable.** Who Yash is, who matters to him, what is noise to him, his accounts (work and personal), and his standing patterns. A pattern is, for example, his usual active hours on workdays and at weekends. Only Yash's own acts are evidence for a pattern (principle 5). This part changes slowly.
- **Now.** The matters that are live in his life now. Each is one line with a decay date. The memory system refreshes this part from the journal's matters. A new mention renews the date, and an ended matter leaves the list. The list holds at most 10 lines. When it is full, the stalest line falls off.

The cap and the decay dates make bloat impossible, not only unlikely, so the profile stays a short text. The profile is what the cheap first call knows. A search at label time is the job of the gather ([Cost](#cost)). If an eval shows that the profile is not sufficient for the first call, the escape hatch of ADR-0121 decision 6 applies. Yash sees and edits both parts.

## The mail facts

One reader of the stored mail builds the facts that the model reads, and triage, the loop joins, the briefing, and the user model all read from it ([foundations](./README.md#4-what-to-work-on-next-foundations-first)). The required set (owner decision, 2026-11-14):

- The message and thread identity, and the arrival time in Yash's zone.
- The sender: the address, the display name, and the effective author that the sender context gives.
- The recipients, which of Yash's accounts got the mail, and whether each recipient is a known contact.
- The subject, and the plain body text.
- Yash's own words in the thread: his replies.
- The device, place, and app names that the mail states.
- The Gmail-native signals: the labels and the spam state.
- Whether attachments are present.

The build plan owns the exact wire shape and the trimming (principle 7). No fact is a verdict: each fact is a source's words, and the model judges them.

The mail facts hold only what the mail says. Triage is not limited to mail: Yash's acts in every other integration reach the model through the gather ([Cost](#cost)).

## Standing instructions

- An instruction is stored in Yash's words. It can be clear or vague. Yash does not need to say it in a special form.
- An instruction that describes a kind of mail ("investor emails are not urgent") applies to senders that Alfred has not seen yet. Alfred never converts a description into a list of senders.
- An instruction that names one person ("my wife's mail is urgent") is resolved to that person's address one time, when Yash saves it. Alfred shows the result and Yash confirms it.
- A new instruction can apply to the last 30 days of mail. From chat, Alfred first shows a dry run of the changes, then applies them.

## What code decides

Code overrules the model in three cases only:

1. Yash's correction on that thread.
2. An instruction that names one person.
3. The security check (for example, an exposed secret). An OTP in the inbox is not this case (owner decision, 2026-11-13).

All other deterministic facts are evidence for the model. If any step changes a label after the model, the trace records what changed it and why. A change with no recorded reason is a defect.

## Corrections

A label that Yash changes in Gmail is a correction. The correction stays on that thread. It is also evidence for similar mail from that sender. When a new message arrives in the thread, triage judges the thread again, and the correction is strong evidence.

## Cost

The limit is a daily amount of money, not a model tier. A decision has the shape **judge → gather → judge**. It is never one stateless call (owner decision, 2026-11-14). Cost buys depth, not shape.

- The cheap model makes the first decision on each mail. It reads the profile and the facts in hand. It searches nothing.
- When the first decision hits a trigger, code starts the **gather**. The gather is a read-only Code Mode program (ADR-0124). It reads the stores below, and then the model decides again. The sources:
  - Yash's own acts near the arrival time, from every integration, in time order (the activity record, ADR-0118). This gives the chronology at almost no cost.
  - The thread, and Yash's own words in it.
  - The sender facts.
  - The searchable chats, the claims, and the journal notes with their sources.
- The gather reads only the stores that are built. Each store joins the gather when it is built. Thus the gather does not wait for the journal or for memory.
- The triggers. Code starts the gather. The cheap model's confidence never starts it.
  - The first decision is loud, and the sender is a bot or a bulk sender. False alarms come from here.
  - The first decision is quiet, and the mail has a signal of money, access, or a deadline. Buried matters come from here.
  - A keyed fact contradicts the first decision. Example: the activity record shows that Yash already acted on the same thread or thing (a key join, ADR-0122). Code compares keys only, and Alfred's own past labels are never part of the comparison (principle 5).
- The gather replaces the "stronger second decision" of ADR-0121 decision 10. For the gather only, it supersedes the "no search for each mail" rule of decision 6. The first call still searches nothing. The daily budget prices the gather. On a day over budget, the first decision stands.

## The prompt

The prompt contains only this page in prompt form: the job, the labels, precedence, the evidence principles, the triage profile, and the instructions. A past error does not become a new prompt rule. It becomes an **eval case**, with the label that this page gives it, and Yash checks it.

## Outside triage

These are **follow-up workflows**. Each one reads the triage result. None of them changes a label.

- **Todos.** Only for loud labels. Their own prompt. Behind the settings flag.
- **Memory write-back** from mail.
- **Loop closing.** Asks are part of loop closing. Asks are always on, at most 5 each day, and they get context to close a loop.
- **Reply drafts.**

## Change of labels

The old labels change name in place in Gmail. `awaiting_reply` and `follow_up` become Reply. `payment` becomes Receipt. Old threads are not triaged again.
