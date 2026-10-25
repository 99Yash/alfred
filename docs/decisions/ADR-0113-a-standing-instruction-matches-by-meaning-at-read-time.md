# ADR-0113 — A standing instruction matches by meaning at read time; code enforces only the effects the user asked for

**Status.** Proposed; not built. Builds the ADR-0060 schema v2 that was never built. Supersedes the sender-only match of ADR-0106 and ADR-0110, and the ADR-0106 rule that every row carries every effect. Keeps the ADR-0110 floor and the security floor.

**Decision.** A standing instruction is the user's words, a plain-text **scope**, optional exact **targets**, and the typed **effects** that the words ask for. Two different parts of the system answer two different questions:

- **Does the instruction apply to this item?** This needs judgment. A target hit answers it in code. If no target hits, the cheap triage model answers it, in the same call that classifies the mail.
- **What happens when it applies?** This needs a guarantee. Code applies the instruction's own effects, through the existing floors, for matched instruction ids only.

The model proposes a match. It never applies an effect and never bends the category for an instruction. This is the PROPOSE/DISPOSE rule of ADR-0067.

## Why

The shipped v1 shape (ADR-0058) stores one suppression for each sender address or domain. Prod on 2026-10-25 shows three faults:

1. **The wrong key.** One chat sentence, "do not tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders", became 21 active `standing_instruction` rows (15 addresses, 6 domains). At capture time the model guessed a sender list from past mail. A new sender is not covered: in 45 days, `camsonline.com`, `cdslstatement.com`, and four `kfintech.com` addresses got no instruction. The user named a class of mail. The store can hold only a sender.
2. **One verb.** `STANDING_INSTRUCTION_ACTIONS` is `["suppress"]`. "Tag her emails urgent" (the north-star example) cannot be stored.
3. **No effect choice.** ADR-0106 makes every row carry all four effects and forbids a reader to branch on the stored list. Thus "not urgent" also blocks reply drafts and removes the sender from the briefing. ADR-0110 then demotes every demand verdict from the sender, and states the cost: a real suspension notice lands as `fyi`. The "meetings are not my concern" half has no effect at all, because no effect expresses it.

Each later ADR fixed one symptom by making the sender match stronger. Thus a wrong match now does more damage. ADR-0060 already rejected an enumerated, sender-keyed design on 2026-06-17.

## The shape

The observation log stays the system of record (the ADR-0060 amendment for ADR-0067). `user_facts` with `key="standing_instruction"` stays the read projection, at `schemaVersion: 2`:

| Field | Meaning | Who reads it |
| --- | --- | --- |
| `phrasing` | The user's own words, verbatim. | Every model consumer (the ADR-0106 rule: the user's words outrank Alfred's paraphrase). |
| `directive` | The resolved sentence for model consumers. | Agent consumers (ADR-0060 micro-decision 1). |
| `scope` | Plain text that says which items the instruction is about, for example "stock, demat, e-voting, and registrar notices". Optional. | The triage model, for the match. |
| `targets` | Exact sender addresses or domains that the user's words name, for the whole sender. Optional. | Code, for the match. |
| `senderFilter` | Exact sender addresses or domains that narrow a scope. Optional, and valid only with a `scope`. | Code, before the scope match. |
| `effects` | The typed effects that the words ask for. Can be empty. | The floors that own each effect. |
| `exceptionOf` | The id of a broader instruction that this one narrows. Optional. | Code, for precedence. |
| `revision` | A number that increases at each change to the instruction, including a change of status. | Every consumer of a stored match. |

**Match rule.** An instruction matches an item when a target hits, **or** when the model returns its id for a scope match. When `senderFilter` is set, the scope match counts only for a sender in that list, so the filter alone never matches. An instruction with neither a scope nor a target is prose only, and agent consumers apply it by judgment (ADR-0060 micro-decision 1).

**A target is sender-wide.** Capture writes a `targets` entry only when the user's words name that sender or domain, for example "stop emailing me about Ben Book". A sender list that the model selects from past mail is never a target. If the words name both a class and some senders, the senders go in `senderFilter`, and both conditions must be true.

**Effects are chosen, not stamped.** Capture selects only the effects that the words ask for, and stores them. Readers branch on the stored list. This reverses the ADR-0106 "derived membership" rule. The first registry:

| Effect | Owner | Meaning |
| --- | --- | --- |
| `demote_urgent` | triage floor (ADR-0110) | `urgent` becomes `action_needed`. Any other category stays. The ask, the todo suggestion, and the briefing priority stay. The security floor still wins. |
| `demote_demand` | triage floor (ADR-0110) | `urgent` and `action_needed` become `fyi`. The security floor still wins. Use it only when the words ask for low priority for all demand, not only for the urgent tag. |
| `demote_meeting` | triage floor | `meeting` becomes `fyi`, for mail that asks the user to attend or vote, for example a shareholder AGM notice. A calendar event is not mail, and this effect does not reach it. |
| `force_category` `{category}` | triage floor | The user's positive override (ADR-0060 micro-decision 4), with the audit breadcrumb. |
| `block_todo_suggestion` | triage | No todo suggestion. |
| `exclude_briefing_priority` / `include_briefing_priority` | briefing gather | Drops the item from, or adds it to, the priority buckets. |
| `block_reply_draft` | reply-draft gate (ADR-0098) | No draft. |

ADR-0060 also named `force_todo_suggestion` ("always track X"). It enters the registry with the same rule. A new effect enters the registry only with a consumer that enforces it. Until then, that part of the instruction is prose only, and the review panel labels it "not enforced". For the investment example, `demote_meeting` covers meeting mail. A calendar event from the same class has no consumer yet, so that part is "not enforced".

## Matching at read time

- **Retrieval.** The triage call receives every active instruction that has a scope, with its id, `phrasing`, and `scope`, under the separate instruction allowance of the shared-context plan. If the set is larger than the allowance, the trace reports the overflow. An instruction is never dropped without a report.
- **Output.** The classify schema gains a list of matched instruction ids, each with one line of reason. Code drops an id that was not in the input set, so a model-invented id matches nothing.
- **The model does not apply the instruction.** The prompt tells the model to classify the message on its own evidence. Code applies the effects after classification. Thus the category the model writes stays honest, and the floor carries the user's authority (ADR-0060 micro-decision 4).
- **Other consumers.** Briefing gather and the reply-draft gate do not call a model. They read the match results that triage stored for the same document, and they derive the effective result under the lifetime rules below. Chat, briefing compose, and workflows read instructions as prose, through the shared reader.

## Lifetime of a stored match

A stored match is a derived decision. It is valid only for the inputs that made it. An applied effect is also derived: it must stop when its instruction stops. Thus triage stores three things apart:

- **The model verdict.** The category, the ask, and the todo suggestion that the model wrote, before any instruction effect. This is history, and nothing rewrites it. Today the floor overwrites the category and clears `documentAsk` and `todoSuggestion` (`triage/floors/floor.ts`), so the original verdict survives only in rationale text. This ADR keeps it as a field.
- **The evaluation identity.** The document id and the content revision that the model read; the instruction-set revision (a per-user number that increases at each instruction write, edit, status change, or deletion); and each evaluated instruction id with its own `revision`.
- **The match results.** For each evaluated scoped instruction: `matched` (with its match kind and reason) or `not_matched`.

**Three states, not two.** For one document and one scoped instruction, the state is `matched`, `not_matched`, or `unknown`. A state is `unknown` when the instruction is new or edited since the evaluation, when the document content revision changed, when no match is stored (triage failed, or ran before this ADR), or when the match failed or exceeded its bound. `unknown` is never read as `not_matched`.

Every consumer that makes a decision (briefing gather, the reply-draft gate, the todo surface) applies these rules at each read:

1. **Target hits are recomputed.** Code checks the current active instructions against the sender at read time. A stored target hit is not used.
2. **A stored scope result must match the full evaluation identity.** It is current only when the document content revision is the stored one, and the instruction is still active at its stored `revision`. Any difference makes the state `unknown`.
3. **The effective result is derived.** The consumer computes the effective category, ask, and todo suggestion from the model verdict plus the effects of the current target hits and the current `matched` scope results. A removed, paused, or edited instruction contributes nothing. Thus its old category effect stops at the next read, with no compensation step. For example: `demote_demand` changed `urgent` to `fyi`; the user removes the instruction; at the next gather the effective category is `urgent` again, because gather derives it from the model verdict. Gather must not filter on a stored post-floor category.
4. **`unknown` follows the effect, not one global default.**

   | Effect kind | Effects | When the state is `unknown` |
   | --- | --- | --- |
   | Changes rank | `demote_urgent`, `demote_demand`, `demote_meeting`, `force_category`, `exclude_briefing_priority`, `include_briefing_priority` | No effect. The consumer uses the model verdict, and the trace counts the item. |
   | Blocks a proactive output | `block_reply_draft`, `block_todo_suggestion` | The output waits. A proactive draft does not start, and a todo suggestion is not shown, until the state is known. A draft that the user asks for is not affected. |
   | Forces a proactive output | `force_todo_suggestion` | No effect until the state is known. |

   This keeps the current behavior: today the draft gate declines when the instruction read fails (`reply-drafting/worthiness.ts`), and the triage floor keeps the category when the read fails (`triage/floors/standing.ts`).
5. **The effective result can be cached.** Triage and the re-match job can write the effective result beside the evaluation identity that produced it, for display surfaces such as the inbox. A decision consumer uses the cached value only when its identity is current. Otherwise it derives the value by rule 3.

**Writes are conditional.** Triage and the re-match job write a match result only when the inputs that they read are still current: the same document content revision, and the same revision for each instruction they evaluated. If an input changed during the call, the database rejects the write, and the job enqueues that document again. Thus a slow call cannot store a match for content or an instruction that it did not read.

**Re-match after a change.** An instruction write enqueues one bounded re-match job over the documents that a consumer can still read: the current briefing window and the threads that can still get a reply draft.

- For a removed or paused instruction, or a change to targets only, the job makes no model call. It recomputes the cached effective results.
- For a new or edited scoped instruction, the job sends only the changed instructions to the cheap model, for the match field only. It does not classify again.
- If the job fails or exceeds its bound, the affected states stay `unknown`, and rule 4 applies. The trace and the review panel report the count. The job retries with the standard job policy. A failure never applies a rank effect, and it never keeps a stale one.

**History.** The model verdict, the floor note (instruction id and revision), and each change of the cached effective result are history. An edit changes the effective result from the next read. It does not rewrite the model verdict.

## Precedence, safety, and audit

- **An exception is explicit.** An instruction can carry `exceptionOf`: the id of a broader instruction that it narrows. On an item that both match, the exception cancels the effects of the broader instruction and applies its own effects, which can be none. Capture sets `exceptionOf` when the words state an exception. Example: "make this bank's mail urgent" is a target on the bank's domain with `force_category: urgent`. Then "except its marketing mail" is a scope "marketing mail", with `senderFilter` on the same domain and `exceptionOf` the first instruction. Bank marketing mail keeps the model verdict, and all other bank mail is `urgent`.
- **Match kind does not decide precedence.** A target hit shows how an item matched. It does not show that the user's intent is narrower. This amends the specificity rule of ADR-0060 micro-decision 8: specificity counts only when an instruction declares it with `exceptionOf`.
- **Conflicts without a declared exception.** The structural-conflict gate at capture (ADR-0060 micro-decision 6) asks the user to choose one result: the new instruction replaces the old one, the new one becomes an exception of the old one, or both stay. If both stay and give conflicting effects on one item, the instruction with the later write wins, and the trace and the review panel show the conflict. Effects that do not conflict apply together.
- The security floor outranks a user down-rank and never outranks a user up-rank (ADR-0060 micro-decision 8, ADR-0110).
- Every applied effect writes the instruction id and revision, the match kind (`target` or `scope`), and for a scope match the model's reason, in the trace and in the floor note.
- The review panel (ADR-0060 micro-decision 9) shows, for each instruction: its words, its effects, its exceptions, the parts that are not enforced, and the count of items it matched in the last 30 days, with links. A scope that matches too much is visible and can be undone in one step.

## Capture

`system.remember` gains a v2 arm. The model proposes `phrasing`, `directive`, `scope`, `targets`, `senderFilter`, and `effects`. Before it writes, the boss shows the user one line: what the instruction will match and what it will do. The structural-conflict gate of ADR-0060 micro-decision 6 stays. Capture never expands a class into a sender list.

## Migration of v1 rows

The 21 active v1 rows come from two sentences. A one-time script groups them into two v2 instructions by the chat observation that wrote them, not by the stored `phrasing`. Each gains a `scope` from the words. Prod on 2026-10-25 shows why `phrasing` alone is not safe: the backfill of issue #1229 (2026-10-16) wrote the `in.mpms.mufg.com` row with the Smallcase sentence, although MUFG is a registrar for investment mail. The script shows each backfill row with its sender and asks the owner which instruction it belongs to.

**Senders.** The script does not copy the old sender list into `targets`. The v1 list is a model guess from past mail (fault 1), and a target matches without the scope. The script shows each old address and domain to the owner one at a time. The owner chooses one of three results for each: a sender-wide target (only if the words name that sender), a `senderFilter` entry, or removal. The investment sentence names a class ("all investment-related senders"), so its default result is removal: the scope alone decides. The Smallcase and Polylane sentence names its senders, so its default result is a target. Before commit, the script lists the mail from each removed sender that the scope matcher rejects in the replay corpus, so the owner sees what the removal changes.

**Effects.** The script proposes effects from all of the owner's words about the instruction, not from the first sentence alone. A later clarification is evidence for the same instruction, and it outranks an earlier, narrower word. For the investment instruction, the evidence is:

| Date | Source | Owner's words |
| --- | --- | --- |
| 2026-06-08 | Claude session `b3f0d89f` | Shareholder mail tagged as meeting: "Manufactured urgency should not be considered as a to do … we might as well place them in fyi." |
| 2026-09-08 | Alfred chat (the v1 rows) | "Please remember not to tag stock-related emails as urgent or treat any scheduled meetings as my concern. Apply this to all investment-related senders." |
| 2026-09-16 | Claude session `7b88a731` | About a funds-and-securities balance mail and a dividend TDS mail tagged "needs action": "I had asked it to not surface these emails as important any investment related or banking or maybe investment stocks related stuff". |

**The 2026-09-11 directive edit.** Fourteen `edit` observations on 2026-09-11 changed the stored `directive` to include "If a message is genuinely urgent or requires immediate action, it may be surfaced." The cheap model uses this sentence to keep e-vote mail as `action_needed`. In prod, six e-vote threads from 2026-09-22 to 2026-09-28 are still `action_needed`, and their deadlines have passed. The script shows this edit to the owner, and it asks whether the edit states the owner's intent. Until the owner answers, the script proposes from the owner's quoted words above, which do not contain that exception.

The word "urgent" in the chat sentence is narrower than what the owner asked for before and after it. `demote_urgent` would keep the "needs action" tag that the owner disputed on 2026-09-16. Thus the script proposes:

| Phrase | Proposed effect | Why |
| --- | --- | --- |
| "not … urgent", "not surface these emails as important", "place them in fyi" | `demote_demand` | The owner disputed `action_needed`, not only `urgent`. |
| "should not be considered as a to do" | `block_todo_suggestion` | Stated on 2026-06-08. |
| "or treat any scheduled meetings as my concern" | `demote_meeting` | Shareholder meeting mail goes to `fyi`. In the 45 days to 2026-10-25, prod tagged no investment mail `meeting` (AGM and e-vote mail was `action_needed` or `fyi`), so `demote_demand` does most of the work. A calendar event is "not enforced". |
| None | No `exclude_briefing_priority` | The owner did not ask for it. A `fyi` item already leaves the briefing priority buckets, because gather derives its category from rule 3. |
| None | No `block_reply_draft` | The owner did not ask for it. |
| "or banking" | None by default | The script asks the owner one question: does the scope include banking mail? Banking mail includes security and fraud notices, so the scope does not grow without an answer. |

The security floor still outranks `demote_demand`.

The Smallcase and Polylane sentence gets the same treatment: the script reads its words and any later owner words again, and it proposes only the effects that they ask for, with the phrase beside each effect.

The v1 rows carried `block_todo_suggestion`, `exclude_briefing_priority`, and `block_reply_draft` for both sentences, because ADR-0106 stamped every effect. The script does not carry an effect forward because v1 had it. Each proposed effect shows its phrase and date. The owner can remove an effect or add one, and the panel then shows it as owner-added. The script commits nothing before the owner reviews every row.

## Alternatives

- **(a) Keep sender targets and add more domains.** Rejected. A class of mail does not map to a fixed sender set, and each new sender needs a new row.
- **(b) A separate cheap matcher call for each email.** Rejected for now. It doubles the triage calls for a question the classify call can answer in one more field. Reopen it if the replay diff shows that the instruction block moves verdicts of unrelated mail. The re-match job in "Lifetime of a stored match" is a match-only call, but it runs only after an instruction change and only over mail that a consumer can still read.
- **(c) Let the model apply the instruction (prose only in triage).** Rejected again, for the ADR-0060 (b) reason. ADR-0110 measured this: the cheap model did not obey a matched instruction for a month.
- **(d) Embedding similarity for the match.** Rejected. It needs a threshold that nobody can explain, and it adds a call to the tagging path that the shared-context plan keeps local.

## Residual risk

- **A wrong scope match.** The cheap model can match a scope too widely. The effect is bounded by the stored effects, the security floor, and the trace. The review panel count is the detection.
- **Prompt change for all mail.** ADR-0106 found that a rule in the shared prompt moved four unrelated eval rows. The instruction block reaches every email that has at least one scoped instruction.
- **Rollout gate.** The gate uses a labeled set that the owner reviews before the candidate matcher runs. The candidate's output never defines an expected label. The set holds three groups:
  - expected matches, including the mail from `camsonline.com`, `cdslstatement.com`, and the four `kfintech.com` addresses that v1 missed;
  - expected exclusions, including unrelated mail from an investment sender, and, for an instruction that keeps only `demote_urgent`, mail with a real action deadline that must stay `action_needed`;
  - expected effect results for each matched item: the final category, the todo suggestion, the briefing priority, and the reply-draft result.

  A paired replay diff over real stored mail must then show all of these: every expected match matches, no expected exclusion matches, every effect result is as expected, and verdicts do not move for the mail that the labels mark as unrelated. A matcher that returns no ids fails the first condition.

  The gate also needs these product cases. Each case checks the result that the owner sees, not only the stored match:

  | Case | Required result |
  | --- | --- |
  | An investment notice from a sender that no v1 row named | `fyi`, no todo suggestion, and not in the briefing priority buckets, as the owner's instruction asks. |
  | Shareholder meeting mail from an investment sender | `fyi`, not `meeting`. |
  | The owner removes the instruction | At the next gather, mail that it demoted shows the model verdict again. |
  | The owner narrows the instruction with an exception | Mail inside the exception shows the model verdict. Other mail keeps the effect. |
  | A new "never draft these" instruction, before its re-match ends | No proactive draft starts for mail that is still `unknown`. |
  | An investment mail with a real deadline, under `demote_demand` | `fyi`, with the deadline in the summary. An exposed-secret notice still lands on `urgent` (the security floor). |
- **Prose-only parts.** An effect with no consumer is not enforced. The panel label makes this visible. It does not fix it.
- **Re-match delay.** Between an instruction change and the end of its re-match job, old mail is `unknown` for the changed instruction. A removal takes effect at once, because the effective result is derived. A new rank rule is late for old mail. A new blocking rule holds proactive drafts and todo suggestions for that mail until the job ends. The trace shows the `unknown` count.

**Related.** [ADR-0060](./ADR-0060-standing-instructions-prose-first-central-store.md) (the v2 schema this builds), [ADR-0106](./ADR-0106-a-sender-suppression-reaches-triage-category-as-prior.md) and [ADR-0110](./ADR-0110-a-standing-instruction-hard-demotes-its.md) (superseded in part), [ADR-0051](./ADR-0051-email-triage-v3-cheap-model-always-made-smart.md) (the cheap classifier), [ADR-0067](./ADR-0067-multi-source-user-model-substrate-an-event.md) (the observation log), [ADR-0111](./ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md) and the [shared-context plan](../plans/shared-context-memory-v1.md) (the shared reader and its instruction allowance), issue #323 (general instruction selection).
