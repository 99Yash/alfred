# Triage: the theory

This page states what email triage is for and the rules that follow from that. It is the owner's model, settled in a grilling session on 2026-11-06. It is the target, not a description of the built code. [`product-flow.md` §3](./product-flow.md#3-email-tagging-triage) records the built flow. [ADR-0121](../decisions/ADR-0121-triage-labels-what-it-costs-to-ignore-a-thread.md) records the decision and what it replaces.

Each triage ADR, plan, and prompt change must agree with this page. If a change does not agree, update this page first, or do not make the change.

Last verified: 2026-11-06 at `7c62f224a`.

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

## What counts as an error

- A real matter under a quiet label is the worst error.
- Noise under a loud label is the second error. It causes Yash to stop trusting the loud labels.
- The same kind of mail from the same sender must keep its label, unless the mail contains something new: a real deadline, money that is owed, or a person instead of a bot. A label that changes without new evidence is a defect. This is a check that the evals run. It is not a separate mechanism.

## The evidence

The model weighs these:

- Yash's standing instructions.
- Yash's corrections.
- The **triage profile**: a short text about who Yash is, who is important to him, what he cares about, and what is noise to him. The memory system keeps it current from chats, long-term memory, and cold-start research. Triage only reads it. Yash can see and edit it.
- Facts about the sender, when Alfred has them.
- What Yash did, for example a reply to this sender.
- The mail itself.

The evidence has no fixed rank. The model uses these principles:

- Yash's own words win over an inference.
- A specific item wins over a general one.
- A newer item wins over an older one. Instructions arrive with their dates, from oldest to newest.
- **Alfred's own past labels are never evidence.** A system that learns from its own guesses repeats its errors.

The reason on each label names the evidence that decided it.

## Standing instructions

- An instruction is stored in Yash's words. It can be clear or vague. Yash does not need to say it in a special form.
- An instruction that describes a kind of mail ("investor emails are not urgent") applies to senders that Alfred has not seen yet. Alfred never converts a description into a list of senders.
- An instruction that names one person ("my wife's mail is urgent") is resolved to that person's address one time, when Yash saves it. Alfred shows the result and Yash confirms it.
- A new instruction can apply to the last 30 days of mail. From chat, Alfred first shows a dry run of the changes, then applies them.

## What code decides

Code overrules the model in three cases only:

1. Yash's correction on that thread.
2. An instruction that names one person.
3. The security check (for example, an exposed secret).

All other deterministic facts are evidence for the model. If any step changes a label after the model, the trace records what changed it and why. A change with no recorded reason is a defect.

## Corrections

A label that Yash changes in Gmail is a correction. The correction stays on that thread. It is also evidence for similar mail from that sender. When a new message arrives in the thread, triage judges the thread again, and the correction is strong evidence.

## Cost

The limit is a daily amount of money, not a model tier.

- The cheap model makes the first decision on each mail.
- A stronger model makes a second decision in two cases only. Code starts it, because the cheap model's confidence does not measure anything:
  - The first decision is loud, and the sender is a bot or a bulk sender. False alarms come from here.
  - The first decision is quiet, and the mail has a signal of money, access, or a deadline. Buried matters come from here.

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
