# ADR-0132 — A follow-up is a proposal that carries its action, its reason, and its sources

**Status.** Accepted; not built. Owner decision, 2026-11-22. The owner decided three points: a follow-up from a background run carries its action; one proposal tool serves every workflow; a proposal lapses after 4 days by default, and earlier when its context says so. The other decisions below are the agent's proposal, built on the existing approval path. The owner reviews them with this page.

Amends: [ADR-0034](./ADR-0034-human-in-the-loop-approval-taxonomy-action.md) (a staged row can outlive the run that made it, and it stores a reason and sources), [ADR-0121](./ADR-0121-triage-labels-what-it-costs-to-ignore-a-thread.md) (an ask of loop closing is a proposal; the daily limit applies here). Keeps: [ADR-0099](./ADR-0099-a-question-is-an-approval-with-a-different-card.md) (`system.ask_user` stays in a live chat). Partly closes [core-agent.md §9](../theory/core-agent.md#9-not-settled) ("`ask_user` with no person present").

## Why

- **A follow-up has no place to go.** Triage slice 4a removed the todo sweep after a saved instruction. Nothing replaced it. A workflow that thinks a todo should close, or that a loop needs the user's yes, can only act alone or say nothing.
- **A background run cannot ask.** Boot allows `system.ask_user` only for the chat boss in a live thread (`tool-runtime/internal/registry.ts`). A workflow run can stage a gated write, but the run then waits, and the row lapses after 24 hours (`APPROVAL_EXPIRY_MS`).
- **Four theory pages expect a parked ask, and none is built.** Loop closing (ADR-0121: at most 5 asks each day, in the briefing and the next chat), the memory check job ([memory.md](../theory/memory.md): "a pending question that the next chat or the review surface shows"), the push ([core-agent.md §4](../theory/core-agent.md#4-the-push)), and the journal. One mechanism must serve all of them. A store for each workflow would give four question stores (principle 3).
- **An approval card cannot say why.** The `action_stagings` row has no reason in the model's words and no link to the mail, thread, or instruction behind it. The card shows the policy cause ("Gmail is set to ask first") and the run's task text. The approval email shows the tool and its input. No page shows a workflow run's transcript. So the user cannot decide from the card.

## Decisions

1. **A follow-up that needs the user's yes is a proposal.** A workflow never runs a follow-up action alone. Examples: close these todos, mark this loop done, supersede this claim. In a live chat, the model still asks an open question with `system.ask_user`. It calls a tool directly when the user asked for that action.
2. **One tool for every workflow: `system.propose_followup`.** Default workflows, user-written workflows, and chat use the same tool. Its input has four parts:
   - **The action:** one tool name and its input.
   - **The reason:** one or two sentences in the voice of [core-agent.md §5](../theory/core-agent.md#5-the-voice), with no mechanism words.
   - **The sources:** references to items in the settled stores (a mail, a thread, a standing instruction, a todo, a provider object), in the reference shape of the evidence card (ADR-0101).
   - **An optional lapse time,** inside the bound of decision 6.
3. **A proposal is one `action_stagings` row.** It uses the same decision route, card, Replicache queue, approval email, and expiry worker as a gated write (ADR-0034). The row also stores the reason and the sources. Alfred has no second store of asks.
4. **The proposing run ends. The row outlives it.** The run does not wait for the user. An approval runs the stored input exactly, through the dispatcher, with the effect ledger and the attribution of ADR-0115 (the authority is the user's decision on the row). A revision changes the input before it runs. A rejection or a lapse runs nothing. *(Agent decision on the mechanism: how an approved row runs when its run has ended.)*
5. **Code owns the guarantees. The model owns the judgment.**

   | Question | Owner |
   | --- | --- |
   | Whether to propose, the reason, and which sources | Model |
   | The action parses against its tool's schema when it is proposed | Code |
   | The action is a tool that a proposal may carry: not `system.ask_user`, not `system.propose_followup`, not a send (Alfred never sends mail) | Code |
   | Each source exists and belongs to the user | Code |
   | At most 5 unprompted proposals each day (ADR-0121); over the limit, the tool refuses and the run says nothing | Code |
   | One open proposal for one action: the same tool and the same input do not stage twice | Code |
   | The lapse time is inside the bound | Code |
   | An approval runs exactly the stored input | Code |

6. **A proposal lapses after 4 days by default.** The right time depends on the context (owner, 2026-11-22). The proposer may set an earlier time when the context has one, for example a deadline in the mail or a meeting that passes. It may not set a later time. On a lapse, the row is expired, nothing runs, and Alfred sends no message about it. Review the 4 days when the first data exists.
7. **The user decides from the card, not from a transcript.**
   - The approvals page and the chat tray show the reason and the sources, as links, on the card.
   - The approval email shows the reason and the sources.
   - The briefing and the next chat point to an open proposal in a passing clause, with a link to its card.
   - Most runs propose nothing, and the daily limit holds the rest. So the page lists at most a few proposals each day, not one item for each mail.
   - A run-detail page with the transcript comes last. The card and the History tab link to it. It is for the user who wants to see how Alfred got there, not for the decision.
8. **Evals before the user interface.**
   - Alfred proposes only when the action applies to the item.
   - Each proposal names real sources.
   - No follow-up action runs without the user's approval.
   - The reason contains no mechanism words.

## Order of work

1. This page, and the changes to the theory pages that it names.
2. The tool, the reason and the sources on the row, the code checks of decision 5, and the 4-day bound.
3. The eval cases of decision 8.
4. The card, the email, the passing clause in the briefing and chat, and then the run-detail page.

The first user is the todo follow-up of triage (plan slice 7). It proposes to close todos after a saved instruction, in place of the sweep that slice 4a removed.

## Not settled

- **An open question from a background run.** A proposal is a yes or no on one action. A question with a free answer and no person present (for example, a claim of the memory check job that has no clear action) is still open in [core-agent.md §9](../theory/core-agent.md#9-not-settled).
- **Does the daily limit count proposals in a live chat?** The agent suggests no: the user is present and the proposal answers the user's turn.
- **Several actions in one proposal.** One `system.resolve_todo` call with a list of todo ids is one action. A proposal that joins different tools is not decided.

## Alternatives rejected

- **A store of open follow-ups for each workflow.** It repeats the approval path four times, with four limits and four lapse rules.
- **Add a reason and sources to every gated write.** It mixes "Alfred suggests this" with "Alfred wants to do this, and the policy asks you first". A proposal is the model's suggestion. A gated write is the user's policy.
- **Park the proposing run until the user decides.** A run that waits for days holds state that nothing reads. An approval must run the stored action only, so the run adds nothing after the proposal.
- **Show the transcript of each background run in chat.** Thousands of mails give thousands of runs. The user cannot find the few that need a decision.
