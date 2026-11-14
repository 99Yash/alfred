# The core agent: one runner, its destination, and its voice

Status: draft for owner review, 2026-11-14. The decisions dated 2026-11-14 are owner direction from the grill on the core-agent handoff. Nothing is merged yet.

Read first: [README principles](./README.md#2-the-principles), [journal.md §9](./journal.md#9-not-settled) (what waited on a push surface), [ADR-0099](../decisions/ADR-0099-ask-user-is-the-single-clarification-act.md) (`ask_user`), and the research page that this page settles: [core-agent-primitives-vs-junior-2026-11-14.md](../research/core-agent-primitives-vs-junior-2026-11-14.md).

---

## 1. The job

**One runner runs every agent loop of Alfred, and everything Alfred does is a workflow on one engine — the chat turn, the briefing composer, the background boss, and (as the shape allows) email tagging and action items. The surface the run serves, the interaction kind, and the destination it posts to are parameters.** Owner direction, 2026-11-14: **determinism at the core, non-determinism at the edges, as and when appropriate.** The magic is non-determinism done right, and it is facilitated by the deterministic spine — the dedup keys, the gather, the floors, the loop verdicts, the code-owned guarantees — because the spine is what gives the LLM-heavy parts the capabilities they need. The runner hosts each workflow's non-deterministic edge; the spine is code. This generalizes principle 4 from one judgment to the shape of the whole system.

**Scope, owner direction 2026-11-14.** One user, the web chat today. More surfaces — Slack, WhatsApp, a bot in someone else's product — are parked, not a work item. The theory below does not depend on them arriving.

**The worst errors**, in order:

1. A run posts to a place the user did not choose.
2. Alfred narrates its mechanism to the user.
3. Alfred speaks when nothing needs the user.
4. Two loops drift — the same job, done differently by each prompt.
5. The core and the edge swap places — code judges what needs the model, or the model owns what code must guarantee.

## 2. The runner

Three loops run today, and they already share one shape: a model loop over tools that ends in an explicit act.

- The chat turn (`packages/assistant/src/chat/chat-turn.ts`), streaming, `CHAT_SYSTEM_PROMPT_BASE`.
- The briefing composer (`packages/assistant/src/briefings/agent/agent.ts`), tools ending in `dump_briefing`, with a budget that fails rather than burns tokens past the end.
- The background boss (`packages/assistant/src/execution/workflows/user-authored-brief.ts`), `BOSS_SYSTEM_PROMPT_BASE`.

The charter of the chat turn names web parts ("side panel", "approval card") at `chat-turn.ts:159-175`. A runner with the surface as a parameter has one charter that names none of them. Owner decision, 2026-11-14: **one runner**, with the surface, the interaction kind (`live_chat` | `background`), and the budget as parameters.

Two parts join the runner when it is built:

- **Skills.** They are authored (`skills`, `skill_revisions`; `parseMentions` exists) and never loaded into a run. The runner loads them.
- **Code Mode (ADR-0124, #535).** The read path of the runner. Its type surface is the [evidence map](./evidence-map.md).

## 3. The destination

Owner decision, 2026-11-14: **the destination is fixed on the workflow revision at save, and a run cannot choose where it posts.** This matches the existing design — `workflow_revisions` are immutable and hold `allowed_tools` — and it bounds worst error 1. The chat turn's destination is its thread; the briefing's is the email and the briefings page; a workflow's is whatever the user chose when they saved it.

## 4. The push

Owner direction, 2026-11-14: **push is a function Alfred calls to mail the user about something, with a section in the UI as the record. "No biggie."** The mechanism exists: `notify()` sends email through Resend (`packages/assistant/src/delivery/notify.ts`), and the notification kinds `briefing` and `evening_recap` are already recorded in `packages/db/src/schema/notifications.ts`. What is missing is small:

- **Kinds for an ask and a result.** No notification kind carries a result today; a workflow result is visible only on the web History tab.
- **A UI section** as the durable record of what Alfred sent. The briefings page (`apps/web/src/routes/-briefings/`) is the precedent: it shows what Alfred told the user, and never how it worked.

What the push does **not** carry, owner decision 2026-11-14: journal remarks. They stay on briefs and the next chat, and the journal's "no net runs within minutes of an item" rule survives as a choice ([journal.md §9](./journal.md#9-not-settled)). The push carries what needs the user's side — an ask, a result, a confirmation — and nothing else.

**`ask_user` with no person present.** With the push, a background run that needs the user can park the question and ask through the push instead of denying it (Junior denies). This is open (section 9), but it is now mechanically possible, which it was not before the push kinds exist.

## 5. The voice

Owner direction, 2026-11-14: **Alfred never narrates its internals. What it believes, doubts, or has done appears as a passing clause in a brief or a push; the one explicit form is a question, when something needs the user's side.** The owner's words: "most of the stuff should be kind of implicit and subliminal"; great writing says things without being too explicit; "feel free to take a look. we can take out later."

The rules, as direction and eval cases — not as code checks and not as a floor:

- **Default silence.** The journal's rule, generalized: Alfred speaks when something is pressing or strange, or when the user's side is needed.
- **The passing clause.** An acknowledgement or a doubt rides inside a sentence about the user's thing. It is never its own item, never a section. Practiced in prod: "Railway's production build is showing success now, *closing the failure flagged this morning*"; "Your TDS declaration is due today, *as noted last night*".
- **The explicit form is a question.** An ask, a confirmation, a "was that you?". A user-asserted claim that the check job supersedes is told this way ([memory.md §6](./memory.md#6-the-check-job)) — the tell stays, because it needs the user's side; the evidence trail and the revert live in the UI, not in the prose.
- **Certainty is expressed by wording, not by a label.** No confidence number in prose. A confirmed fact is a passing clause; an uncertain join is a question; the requested action carries the implied provenance — "if it wasn't you, secure the account" says both the doubt and the stakes. This is the journal's impact-and-certainty rule ([journal.md §6](./journal.md#6-speak-and-what-happens-after)) generalized to every surface.
- **Never mechanism words.** The internal reason for a doubt is not explained. The briefing prompt already codifies this: "use at most one plain sentence such as 'I couldn't confirm whether that's still needed yet' … do not explain the internal reason, turn it into an ask, or imply progress", and bans internal vocabulary outright. One leak reached prod ("the activity record has no … events") and was fixed by patch (PR #1682) — per principles 1 and 2, the third patch in this area would be a fault, so the rule lives here, in theory, not as a fourth prompt line.
- **Uncertainty appears when it is live.** A passing clause that repeats every brief is boilerplate, and it makes the honest days indistinguishable from noise. The calendar-read clause appeared in every brief for days (2026-11-12 to 11-14). This is the first eval case of the voice.

The wording itself is the model's judgment, checked by eval cases ([journal.md §7](./journal.md#7-what-the-model-owns-and-what-code-owns) works this way). One code check already exists and stays: the terminal briefing writer rejects internal vocabulary — a guarantee, which is code's to own.

## 6. What the model owns, and what code owns

| Question | Owner |
| --- | --- |
| Whether to speak, and the words | Model |
| Which kind a push carries, within the destination the revision fixed | Model |
| The passing clause, the question, the implied provenance | Model (eval cases) |
| A run posts only to its destination, fixed at save | Code |
| Internal vocabulary never reaches a surface | Code |
| A push is recorded once, with its kind | Code |
| The skills of a run are loaded before its first step | Code |

## 7. Theory state and code state

| Part | Theory | Code | The gap today |
| --- | --- | --- | --- |
| One runner with surface, interaction, budget as parameters | Settled (owner, 2026-11-14) | Not built | Three loops, two prompts, a charter that names web parts |
| Destination fixed on the revision | Settled (owner, 2026-11-14) | Not built | `workflow_revisions` hold tools, not a destination |
| Push kinds for asks and results, and the UI section | Settled (owner, 2026-11-14) | Partly | `notify()` and two kinds exist; no ask/result kind; no section |
| The voice | Settled as direction (owner, 2026-11-14) | Partly | Practiced in briefs by prompt; not carried by eval cases or the other loops |
| Skills loaded in a run | Settled (part of the runner) | Not built | Authored, never loaded |
| Code Mode as the read path | Settled (ADR-0124) | Not built | #535 |
| A second surface (Slack, WhatsApp) | Parked (owner, 2026-11-14) | Not built | No work until the owner unparks it |

## 8. Order of work

Owner direction, 2026-11-14: **not now.** The theory is recorded so that it is settled when building starts; nothing queues behind it today. When it starts, the order follows the dependencies:

1. Code Mode (#535) — the read path and the evidence map's home.
2. The runner, with the destination on the revision.
3. The push kinds and the UI section.
4. Budgets — needs research or trial and error before it settles (section 9).

## 9. Not settled

- **Budgets.** Step caps of 40 and 60 exist (`turn-budgets.ts`). Whether cost caps, tool-call caps, or a wrap-up step fit better is not decidable from the armchair — the owner expects research or trial and error. Open until then.
- **Silence as an act.** Does a run end with an explicit "no reply", as Junior's `noReply` does? It fits "the default verdict is silence" ([journal.md §9](./journal.md#9-not-settled)), but a turn that just ends is what the user knows today. Open.
- **`ask_user` with no person present.** Deny (today), or park and ask through the push. Mechanically possible once the push kinds exist; a wording question as much as a mechanism one. Open.
- **Thread binding for a second surface.** Parked with the surfaces. When a second surface arrives, the question returns: a column on `chat_threads` (`packages/db/src/schema/chat.ts` has none today) or a binding table.
