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
| `revision` | A number that increases at each change to the instruction, including a change of status. | Every consumer of a stored match. |

**Match rule.** An instruction matches an item when a target hits, **or** when the model returns its id for a scope match. When `senderFilter` is set, the scope match counts only for a sender in that list, so the filter alone never matches. An instruction with neither a scope nor a target is prose only, and agent consumers apply it by judgment (ADR-0060 micro-decision 1).

**A target is sender-wide.** Capture writes a `targets` entry only when the user's words name that sender or domain, for example "stop emailing me about Ben Book". A sender list that the model selects from past mail is never a target. If the words name both a class and some senders, the senders go in `senderFilter`, and both conditions must be true.

**Effects are chosen, not stamped.** Capture selects only the effects that the words ask for, and stores them. Readers branch on the stored list. This reverses the ADR-0106 "derived membership" rule. The first registry:

| Effect | Owner | Meaning |
| --- | --- | --- |
| `demote_urgent` | triage floor (ADR-0110) | `urgent` becomes `action_needed`. Any other category stays. The ask, the todo suggestion, and the briefing priority stay. The security floor still wins. |
| `demote_demand` | triage floor (ADR-0110) | `urgent` and `action_needed` become `fyi`. The security floor still wins. Use it only when the words ask for low priority for all demand, not only for the urgent tag. |
| `force_category` `{category}` | triage floor | The user's positive override (ADR-0060 micro-decision 4), with the audit breadcrumb. |
| `block_todo_suggestion` | triage | No todo suggestion. |
| `exclude_briefing_priority` / `include_briefing_priority` | briefing gather | Drops the item from, or adds it to, the priority buckets. |
| `block_reply_draft` | reply-draft gate (ADR-0098) | No draft. |

ADR-0060 also named `force_todo_suggestion` ("always track X"). It enters the registry with the same rule. A new effect enters the registry only with a consumer that enforces it. Until then, that part of the instruction is prose only, and the review panel labels it "not enforced". The "meetings" half of the example is in this state today.

## Matching at read time

- **Retrieval.** The triage call receives every active instruction that has a scope, with its id, `phrasing`, and `scope`, under the separate instruction allowance of the shared-context plan. If the set is larger than the allowance, the trace reports the overflow. An instruction is never dropped without a report.
- **Output.** The classify schema gains a list of matched instruction ids, each with one line of reason. Code drops an id that was not in the input set, so a model-invented id matches nothing.
- **The model does not apply the instruction.** The prompt tells the model to classify the message on its own evidence. Code applies the effects after classification. Thus the category the model writes stays honest, and the floor carries the user's authority (ADR-0060 micro-decision 4).
- **Other consumers.** Briefing gather and the reply-draft gate do not call a model. They read the match that triage stored for the same document, under the lifetime rules below. Chat, briefing compose, and workflows read instructions as prose, through the shared reader.

## Lifetime of a stored match

A stored match is a derived decision. It is valid only for the inputs that made it. Triage stores, for each evaluated document:

- the document id and the content revision that the model read;
- the instruction-set revision: a per-user number that increases at each instruction write, edit, status change, or deletion;
- the evaluated instruction ids, each with its own `revision`;
- the matched ids, each with its match kind and reason.

Briefing gather and the reply-draft gate apply these rules at each read:

1. **Target hits are recomputed.** Code checks the current active instructions against the sender at read time. A stored target hit is not used.
2. **A stored scope match must be current.** The consumer applies a scope effect only when the instruction is still active and its `revision` is the stored revision. Otherwise the match is stale, and the consumer applies no effect from it. Thus a deleted, paused, or edited instruction stops at the next read.
3. **A new or edited instruction is not yet evaluated for old mail.** When the stored instruction-set revision is older than the current one, each changed instruction is `unevaluated` for that document. The consumer applies no scope effect from an `unevaluated` instruction, and the trace says so.
4. **Re-match after a change.** An instruction write enqueues one bounded re-match job. It sends only the changed scoped instructions and the documents that a downstream consumer can still read: the current briefing window and the threads that can still get a reply draft. The job calls the cheap model for the match field only. It does not classify again. It writes a new stored match with the current revisions.
5. **Failure.** If the re-match job fails or exceeds its bound, the affected documents stay `unevaluated`. Consumers apply only the current target hits, and the trace and the review panel report the count. The job retries with the standard job policy. A failure never applies an effect, and it never keeps a stale effect.
6. **A missing match.** A document with no stored match (for example, triage failed or ran before this ADR) is `unevaluated` for every scoped instruction. Rule 5 applies.

The category that triage wrote at classification time is history. The floor note records the instruction id and revision that changed it. A later edit does not rewrite that category. It changes the next classification and every later downstream read.

## Precedence, safety, and audit

- The specificity-then-recency order of ADR-0060 micro-decision 8 stays. A target hit is more specific than a scope match.
- The security floor outranks a user down-rank and never outranks a user up-rank (ADR-0060 micro-decision 8, ADR-0110).
- Every applied effect writes the instruction id, the match kind (`target` or `scope`), and for a scope match the model's reason, in the trace and in the floor note.
- The review panel (ADR-0060 micro-decision 9) shows, for each instruction: its words, its effects, the parts that are not enforced, and the count of items it matched in the last 30 days, with links. A scope that matches too much is visible and can be undone in one step.

## Capture

`system.remember` gains a v2 arm. The model proposes `phrasing`, `directive`, `scope`, `targets`, `senderFilter`, and `effects`. Before it writes, the boss shows the user one line: what the instruction will match and what it will do. The structural-conflict gate of ADR-0060 micro-decision 6 stays. Capture never expands a class into a sender list.

## Migration of v1 rows

The 21 active v1 rows come from two sentences. A one-time script groups them by `phrasing` into two v2 instructions. Each gains a `scope` from the words.

**Senders.** The script does not copy the old sender list into `targets`. The v1 list is a model guess from past mail (fault 1), and a target matches without the scope. The script shows each old address and domain to the owner one at a time. The owner chooses one of three results for each: a sender-wide target (only if the words name that sender), a `senderFilter` entry, or removal. The investment sentence names a class ("all investment-related senders"), so its default result is removal: the scope alone decides. The Smallcase and Polylane sentence names its senders, so its default result is a target. Before commit, the script lists the mail from each removed sender that the scope matcher rejects in the replay corpus, so the owner sees what the removal changes.

**Effects.** The script proposes an effect only beside the phrase that asks for it, and shows that phrase to the owner:

| Sentence | Phrase | Proposed effect |
| --- | --- | --- |
| Investment | "do not tag stock-related emails as urgent" | `demote_urgent` |
| Investment | "or treat any scheduled meetings as my concern" | None. No registered effect expresses it. The panel labels it "not enforced". |
| Smallcase and Polylane | its own words, read again at migration | Only the effects that those words ask for, with the same phrase check. |

The v1 rows also carried `block_todo_suggestion`, `exclude_briefing_priority`, and `block_reply_draft` for both sentences, because ADR-0106 stamped every effect. The script does not carry an effect forward because v1 had it. The owner can add a broader effect, for example `demote_demand` in place of `demote_urgent`, only by an explicit choice on that row, and the panel then shows it as owner-added. The script commits nothing before the owner reviews every row.

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
  - expected exclusions, including unrelated mail from an investment sender, and mail with a real action deadline that the urgent-only instruction must not demote below `action_needed`;
  - expected effect results for each matched item: the final category, the todo suggestion, the briefing priority, and the reply-draft result.

  A paired replay diff over real stored mail must then show all of these: every expected match matches, no expected exclusion matches, every effect result is as expected, and verdicts do not move for the mail that the labels mark as unrelated. A matcher that returns no ids fails the first condition.
- **Prose-only parts.** An effect with no consumer is not enforced. The panel label makes this visible. It does not fix it.
- **Re-match delay.** Between an instruction change and the end of its re-match job, old mail gets no scope effect from the changed instruction. This delay makes a removal safe at once. It makes a new rule late for old mail, and the trace shows the `unevaluated` count.

**Related.** [ADR-0060](./ADR-0060-standing-instructions-prose-first-central-store.md) (the v2 schema this builds), [ADR-0106](./ADR-0106-a-sender-suppression-reaches-triage-category-as-prior.md) and [ADR-0110](./ADR-0110-a-standing-instruction-hard-demotes-its.md) (superseded in part), [ADR-0051](./ADR-0051-email-triage-v3-cheap-model-always-made-smart.md) (the cheap classifier), [ADR-0067](./ADR-0067-multi-source-user-model-substrate-an-event.md) (the observation log), [ADR-0111](./ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md) and the [shared-context plan](../plans/shared-context-memory-v1.md) (the shared reader and its instruction allowance), issue #323 (general instruction selection).
