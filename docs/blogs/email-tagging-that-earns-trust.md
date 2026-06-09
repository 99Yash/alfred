# Email Tagging That Earns Trust

Email looks simple from a distance.

A message arrives. Alfred reads it. A label appears.

But the closer we got to making that feel automatic, the less it looked like a classification problem. It became a trust problem.

An inbox is full of almosts. A calendar invite that is really a webinar. A GitHub review comment that sounds urgent, but only applies to code that has not shipped. A security alert that looks like a robot until it says a secret was exposed. A shareholder notice with a deadline, but no real action for you. A thread that used to be `follow_up`, then ended with a `done` reply.

The hard part was not naming ten labels. It was making the right label appear quickly, quietly, and consistently enough that you stop thinking about the system.

## The First Hurdle: Speed Was Not the Whole Story

At one point, tagging felt slow. The obvious guess was the model.

It was not the model.

The expensive part was delivery. A newly connected Gmail account did not always have a fresh watch installed, so new mail could wait for the five-minute sweep. That made the product feel asleep, even when the classifier itself was fast.

The fix was infrastructural, not magical: install the Gmail watch at connect time, keep polling as a fallback, and route both real-time and catch-up paths through the same persistence helper. One path for dedup. One path for triage. One path for label writes.

The lesson was useful. If a personal assistant is late, it does not matter how smart it is. The first promise is presence.

## The Second Hurdle: Gmail Threads Do Not Behave Like Rows

Gmail has a quiet trap: thread view unions labels across every message in a thread.

If the first email in a thread was `fyi`, the second was `follow_up`, and the final reply closed the loop, Gmail could show all of those labels at once. Technically true. Product-wise, unreadable.

Alfred needed one current tag per thread.

So the label writer became thread-aware. Before applying the latest Alfred label, it asks Gmail for the thread siblings, strips old Alfred labels from every sibling message, then applies the new label to the latest message. Gmail is treated as the source of truth for the thread shape, not the local database. That means the system also self-heals if an older deployment or manual label drifted.

The user sees a simple thing: one tag.

The system does the fussy work underneath.

## The Third Hurdle: Cheap Models Need Better Eyes

The first instinct was to escalate. When the cheap classifier was uncertain, call the boss model. Give it user context. Let it think harder.

That worked as a design, but it made the hot path heavier than it needed to be.

Email tagging happens all day. It should be cheap by default. It should not summon the most capable model every time a sender looks unfamiliar.

So triage v3 changed the shape: keep the cheap model, but give it sharper observations.

Before the model sees the email, Alfred now gathers deterministic context:

- what kind of sender this is
- whether it is a service envelope, bot, or human
- what this sender usually becomes
- whether the account is work or personal
- whether the user already replied in this thread
- whether Gmail marked the message important, promotional, or sent
- whether the content carries a high-precision signal like exposed credentials

The model still reads the email. It still makes the judgment. But it no longer has to infer the entire world from raw prose.

That gave us the better tradeoff: fast on every message, smarter without becoming heavy.

## The Fourth Hurdle: Rules Can Become Clutter

Every inbox creates tempting patches.

"This sender is usually a newsletter."

"This bot is usually harmless."

"This phrase often means urgency."

Left unchecked, those patches become a wall of exceptions. They pass today's example and fail tomorrow's neighbor.

Alfred uses a narrower pattern:

First, observations. Then one cheap classification. Then, only when there is a hard deterministic conflict, one second cheap pass with the inconsistency spelled out. Finally, a very small override floor for the things we want to catch with high precision, like explicit secret exposure.

The override floor is intentionally tiny. CVEs, payments, and generic authentication language remain model-owned unless the text clearly crosses the bar. That keeps the system from turning every official-looking email into an emergency.

Bad tags are tuned from logs, not vibes. The `triage.sender_extraction` event records the sender context, observations, first and second pass, override flags, and todo decision. Enough to debug the mistake. Not a raw dump of the user's inbox.

## What It Became

Alfred now classifies email across ten labels: `urgent`, `action_needed`, `follow_up`, `awaiting_reply`, `meeting`, `fyi`, `done`, `payment`, `newsletter`, and `marketing`.

In the dev database, those labels are all in use across 307 thread-level triage rows. That matters. A taxonomy is not real until the product has to live with it.

The important part is not that Alfred can sort mail.

The important part is that Alfred has a memory of how sorting goes wrong:

- delivery can be mistaken for intelligence
- a Gmail thread is not one message
- a bot is not always noise
- urgency can be manufactured
- cheap models get better when code gives them the right facts
- corrections should come from observed misses, not one-off rules

The result should feel almost boring.

The email arrives. The label is there. The thread has one current state. And you move on.

That is the product.

## Source Notes

- Core docs: `docs/reference/triage.md`, `docs/plans/triage-v3-plan.md`, `decisions.md` ADR-0025 amendments, ADR-0042, ADR-0051.
- Implementation paths: `apps/server/src/builtins/workflows/email-triage.ts`, `packages/api/src/modules/triage/classify.ts`, `packages/api/src/modules/triage/observations.ts`, `packages/integrations/src/google/labels.ts`.
- Dev DB aggregate checked 2026-06-09: 307 `email_triage` thread rows distributed across all ten categories; 389 completed `email-triage` runs.
