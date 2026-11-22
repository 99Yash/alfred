# ADR-0133 — Evals carry the product direction: the deck stays the gate, and Langfuse holds the datasets and the scores

**Status.** Accepted; step 1 built in #1851 (decisions 5 and 6: the two suites, `triage-eval.yml`, and the `grounding-evals.yml` nightly are gone; the briefing regex scorers wait). Next: the Langfuse score bridge and the deck dataset. Owner decision, 2026-11-22, after an audit of the eval lane ([docs/research/2026-11-22-eval-lane-audit.md](../research/2026-11-22-eval-lane-audit.md)). Amends ADR-0055 (the lane's tooling decisions, not its scorer law) and ADR-0023 (prompt-version linking). ADR-0055 stays the law for scorers: score the real path, deterministic first, the judge on a stronger and different model.

**Decision in one paragraph.** The job of the eval lane is to carry what the product must not get wrong, not to grade a runner. The triage deck keeps that job for triage and keeps its local runner. Its scores live in Langfuse, and its cases live in Langfuse datasets, so history, trends, and alerts exist without a new vendor — Langfuse is already ADR-0023's. Each stage's theory names its worst error and its eval gate before the first slice of it builds, and each case cites the theory it protects. Suites that grade behavior the settled theory rejects retire, starting with `sender-suppression-grounding`. CI keeps no eval gate: the owner runs the deck before and after each slice, and Langfuse alerts on drops of the tracked scores. Prompts stay in the repo; the metering module records the prompt version on each trace, so cost and quality group per prompt version.

## Why

- The audit found the deck earns its keep — it held slice 1, let slices 2 and 3 through with per-case evidence, and on 2026-11-22 caught slice 4a regressing the worst-error case (`sign-in-by-another-person-is-loud` 1 → 0) — and that the other 10 of 12 suites are old nets, one-off tools, or nightly signals nobody reads. The only CI-wired suite is the wrong one, and the nightly that runs cannot fail (`--threshold 0`).
- The weaknesses split in two. **Runner-bound:** no score history, no datasets fed from production, terminal-only comparison, evalite-beta reporter brittleness. **Design-bound:** one-step grading, suites that grade rejected mechanisms, regex scorers over prose, no harness for seeded state, event sequences, or recall@k. A runner swap fixes only the first group, so the ADR does not frame the change as a migration.
- The stages next on the roadmap (journal, memory, loop closing, cold start) have no cases, and today's lane cannot grade them. What is missing is the rule that names the gate before the build, not a different runner.
- ADR-0055 rejected hosted eval platforms when no vendor was in the stack. ADR-0023 brought Langfuse in, and its 2026-09-18 amendment keeps it current. The vendor half of that rejection is gone. The privacy gate stays: fixtures are redacted before they become cases, and trace I/O capture stays off by default.

## The decisions

1. **Evals carry the direction.** Every stage and foundation names, in its theory page or its slice plan, its worst error and its eval gate before the first slice of it builds. Each eval case cites the theory section and the principle it protects. This extends principle 1: a production fault becomes a case after the fact; a gate becomes a case before the build. The first two forward fixtures are the memory check job's labelled verdict set (a Code Mode program graded offline with fake host functions, the `code-mode-read` pattern) and the journal's labelled recall set (queries mapped to the past chat that must be found).
2. **Datasets live in Langfuse.** Versioned Langfuse datasets are the store of record for eval cases. A production fault becomes a dataset item, redacted first, through the existing mining flow. The local deck reads a checked-in export of its dataset, so the dev loop needs no network; the export is a sync point, not a second store of record.
3. **The scorers stay in the repo, and the runner is an implementation detail.** The deck keeps its local runner while it works. Where a case needs a judge, the judge runs on a stronger and different model than the system under test — the same-model judge drift found in `triage-classify` is a fault against this rule, not a new law.
4. **Every deck run posts its scores to Langfuse.** Item-level and run-level, tagged with the slice, the commit, and the served model. The Langfuse dashboard is the receipt; prose receipts in scratch logs stop being the record. Alerts track only the scores the theory names, not every score.
5. **CI keeps no eval gate.** The stale manual `triage-eval.yml` (last run 2026-10-30) and the `--threshold 0` nightly go. The gate is the owner running the deck before and after each slice, as the deck does today. A red nightly nobody reads is not a gate; an alert on a tracked score is the replacement.
6. **Suites that grade rejected mechanisms retire.** `sender-suppression-grounding` grades the sender-list mechanism `triage.md` rejects, so it goes first. `triage-classify` duplicates the deck with June-era cases and goes with it. The briefing regex scorers wait for the briefing harness question (stub tools, `dump_briefing`, prose grading) — rewriting the regexes is not the fix.
7. **Prompts stay in the repo; metering records the version.** A prompt-version tag or metadata field on each metered call (ADR-0023's module) groups cost and quality per prompt version, so a prompt change's spend and effect are one query. Prompt-as-data stays rejected; the trigger to revisit is when playground iteration beats the diff-review loop in practice, not a scheduled re-think.

## Instrumentation

These start with the first slice that builds this ADR, so the change is measured from day one:

- The share of deck cases mined from production faults, per month — the number that says whether direction capture is real.
- Each slice's theory gate: named and fixtured, or not, at slice start.
- Deck scores in Langfuse from the first run after the score-ingestion bridge.

## Alternatives

- **(a) Migrate the lane wholesale to Langfuse experiments** (UI or SDK runner, hosted datasets only). Rejected: it trades the local dev loop's independence for a hosted runner, and it fixes none of the design-bound weaknesses — one-step grading, rejected mechanisms, and regex scorers move over unchanged. The runner is not the fault.
- **(b) Stay all-local: evalite plus prose receipts.** Rejected: this is today, and the audit showed the result — no history, unseen drops (`sender-suppression-grounding` at 33% for weeks), hand-mined fixtures.
- **(c) A second eval vendor (Braintrust, LangSmith).** Rejected for ADR-0055's reasons, which still stand for a vendor that is not already in the stack.
- **(d) Move prompts to Langfuse prompt management now.** Rejected by the owner on 2026-11-22: the triage prompt's history is read through code review (`classify.ts` commits); a DB row breaks that. Decision 7 keeps the version link so the later door is open.

## Residual risk

- The dataset export can drift from the Langfuse dataset. The sync is one direction (Langfuse → export at case-add time). Until the export carries a content hash that fails loudly, a stale export is a risk to watch.
- Scores exist only when the deck runs, and nothing forces it. The habit is the gate; a missed run shows as a gap in the history.
- Redacted fixtures go to Langfuse Cloud. Redaction is the privacy gate; a fixture that skips it is a boundary fault, the same as an unredacted capture.
- Retiring suites shrinks the net before the replacements exist. The order is deliberate: retire what grades a rejected mechanism first, and let the deck's score history prove the gap before anything new is written for old faults.

## Cross-ref

Amends ADR-0055 (tooling; its scorer law stands) and ADR-0023 (prompt-version linking). Serves theory README principle 1 and §4 (foundations first). Receipt: [docs/research/2026-11-22-eval-lane-audit.md](../research/2026-11-22-eval-lane-audit.md).
