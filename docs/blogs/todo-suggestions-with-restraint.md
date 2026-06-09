# Todo Suggestions With Restraint

A suggested todo is a small thing.

One line. A checkbox. Maybe a sentence of help.

But if the line is wrong, it is worse than silence. A bad todo does not just misread an email. It creates work.

That was the central problem with Alfred's todo suggestions: not how to find more of them, but how to deserve fewer.

## A Tag Is Not a Task

Email triage and todos look adjacent. They are not the same decision.

An email can be `done` and still contain a trailing ask. An email can be `fyi` and still carry a real obligation. An `urgent` email can be urgent for someone else. A `meeting` email can be ceremonial, not something you need to prepare for.

The first mistake would have been to say: if the category is important, create a todo.

That is how products become noisy.

Alfred treats todo-worthiness as its own judgment. The label explains what kind of email arrived. The todo asks a different question: is there a real commitment the user should track?

## The Five Gates

The current rubric is deliberately small and ordered.

First: is the obligation on me?

The email has to ask the user to do something. Not a teammate named in the body. Not a reviewer. Not a third party. The model gets minimal identity context, like the user's name and email, so it can avoid turning "Maya will run standup" into "you should run standup."

Second: is there a real external stake?

Someone is waiting. Money is owed or at risk. Access could be lost. There is a hard deadline. A commitment was made to a human. Or a real-world consequence exists, like a credential already exposed or production already broken.

Manufactured urgency does not count. Streaks, unread counts, "people viewed your profile," marketing scarcity, AGMs, and "save the date" ceremony can sound important without creating a real personal obligation.

Third: would the user forget it?

Some things are in motion already. A login code you just requested does not need to become a todo. Neither does a mid-flow confirmation that will self-resolve.

Fourth: is it actionable from the email alone?

"Thoughts?" may be too vague. "Send the signed SOW by Friday" is not.

Fifth: is it already handled?

Thread state matters. If the user replied, Alfred should not create a reminder for the thing they already closed.

Only when all five gates pass does Alfred propose a todo.

## The Real Mitigation: Trace the No

The important field is not only `todoSuggestion`.

It is `todoDecision`.

Every classification emits an outcome: `proposed`, `no_obligation`, `not_significant`, `would_not_forget`, `too_vague`, or `already_handled`. That means a miss is debuggable. If Alfred failed to suggest something important, we can see which gate said no. If Alfred suggested something silly, we can see what it thought the stake was.

This avoids the most dangerous prompt-tuning loop: adding examples until the model obeys the latest annoyance.

Instead, Alfred keeps the rubric stable and tunes at the boundary. A few exemplars anchor hard cases. The logs show where the boundary is wrong.

## Suggestions Happen in Real Time

Another product choice mattered: todos are suggested from the email-triage run, not from the daily briefing.

The briefing is a render of open loops. It is prose, context, and timing. It should not be the thing that creates durable tasks.

The email-triage run is closer to the event. It sees the source thread, the sender context, the category, the todo decision, and the exact moment the mail entered the system. If the classifier emits a valid suggestion, the workflow tail calls `system.suggest_todo`.

No human approval is needed because a suggestion has no external side effect. It is not sending mail. It is not changing a calendar. It creates a passive row with provenance. The user can accept it, ignore it, or dismiss it.

That is the right level of autonomy.

## Duplicates Are a Trust Leak

The next problem was duplication.

The same real-world commitment can arrive through multiple channels, or the same Gmail thread can be re-triaged after a reply. Without care, Alfred would create a second checkbox for the same loop.

So todo suggestions carry sources: provider, kind, id, and optional URL. If an existing open or suggested todo already references the incoming source, Alfred merges the source refs instead of creating a duplicate.

This is not full semantic dedup. Alfred does not yet know that a Slack thread and a Gmail thread are the same obligation unless their sources overlap. But it gets the structural case right, which is the case it can prove.

The schema is built for the next step: multiple sources on one todo, agent-authored assist text, and future executor fields. But v1 stays passive.

## What the Data Says

In the dev database, there are 22 agent-authored todo rows: 7 still suggested, 1 open, 2 done, and 12 dismissed.

That ratio is useful. It says suggestions are not being treated as free wins. They are being inspected, rejected, and tightened.

The June 9 stringency pass made this more explicit. Historical agent todos can be reclassified in dry-run mode, comparing what the old prompt suggested against what the new rubric would keep or kill. The dry run does not write to `todos` or `email_triage`; it exists to make prompt changes observable before they touch the product.

The product principle is simple: Alfred should remember what matters, not create a second inbox.

The best todo suggestion is not loud. It is specific. It names the real verb. It names the object. It carries the source. And it arrives only when there is something worth carrying forward.

## Source Notes

- Core docs: `CONTEXT.md` Todos section, `decisions.md` ADR-0050 amendments, `docs/plans/triage-v3-plan.md`.
- Implementation paths: `packages/api/src/modules/triage/classify.ts`, `apps/server/src/builtins/workflows/email-triage.ts`, `packages/api/src/modules/todos/suggest.ts`, `packages/contracts/src/tool-schemas.ts`.
- Validation scripts: `apps/server/src/scripts/dry-run-triage-backfill.ts`, `apps/server/src/scripts/dry-run-attribution-fixtures.ts`.
- Dev DB aggregate checked 2026-06-09: 22 agent-authored todos total: 7 suggested, 1 open, 2 done, 12 dismissed.
