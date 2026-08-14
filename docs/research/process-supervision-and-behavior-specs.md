# Process supervision for Alfred: behavior specs, judges, and what stays deterministic

Status: researched 2026-07-31
Scope: how to grade **how** an agent works, not only **what** it produced. Covers
the `agentbehavior` standard, the process-supervision literature, LLM-judge
reliability, vendor support, and what Alfred already has. This note proposes a
lane. It does not propose changes to the boss, the tool registry, or the
runtime.

## Executive conclusion

Alfred already does process supervision. It arrived at the pattern
independently, in two places, and neither is named as such.

1. `guardUnreportedToolFailures` ([finalize-guards.ts:306](../../packages/api/src/modules/agent/workflows/finalize-guards.ts))
   is a deterministic conduct rule that **corrects the run at runtime**.
2. The evalite lane is now mostly conduct scorers over tool calls, not answer
   checks. `boss-judgment.eval.ts` grades "Does not conclude from a single
   lookup". `sender-suppression-grounding.eval.ts` grades "Searches Gmail before
   deciding". `tool-selection-bloat.eval.ts` grades "Expected tool is the FIRST
   call". These are behavior specs written as code.

So the question is not "should Alfred grade process". It already does. The three
real gaps are:

- **No identity.** A rule like "do not conclude from a single lookup" exists as
  an inline scorer inside one eval file. It has no stable name, so its pass rate
  cannot be tracked across changes.
- **No real trajectories.** Every scorer runs on hand-written cases. Nothing
  grades a production run.
- **No score write-back.** The repo has no Langfuse score call at all, so an
  adherence rate has nowhere to live.

The recommendation is therefore **not** "build a behavior judge". It is: give
the existing predicates a stable identity, point them at recorded real
trajectories, and add a model judge only for the small residue that code cannot
decide. That ordering also matches what the reference implementation does, what
Anthropic recommends, and what the small-sample statistics permit.

Three measured facts carry most of the argument:

- **Process supervision buys the right path, not a better answer.**
  [Uesato 2022](https://arxiv.org/abs/2211.14275) found similar final-answer
  error, but reasoning error among *already-correct* answers fell from 14.0% to
  3.4%. That is the lucky-correct case, and it is the only reason to grade
  process at all.
- **Judge reliability is decided by the question shape, not the model.**
  Chance-corrected agreement is about half the raw number on subjective
  judgments and nearly unchanged on fact-shaped ones
  ([2606.19544](https://arxiv.org/abs/2606.19544)). A behavior predicate is
  fact-shaped, which is why this should work where generic quality judging does
  not.
- **The cheapest published thing that worked needs no training at all.**
  [SWE-PRM](https://arxiv.org/abs/2509.02360) applied a hand-written failure
  taxonomy at inference time for +10.6 points on SWE-bench Verified. That is the
  shape to copy at this scale.

## The `agentbehavior` standard

Published 2026-07-29 by Basis and Braintrust, Apache 2.0, 16 commits at time of
reading. Sources: the repo
[`braintrustdata/agentbehavior`](https://github.com/braintrustdata/agentbehavior),
the [specification](https://github.com/braintrustdata/agentbehavior/blob/main/docs/specification.mdx),
and the co-authored launch posts on
[getbasis.ai](https://www.getbasis.ai/blogs/behavior-specs-an-open-standard-for-supervising-long-horizon-agents)
and [braintrust.dev](https://www.braintrust.dev/blog/behavior-specs).

### The format is very small

A spec is `.agents/behaviors/<name>/BEHAVIOR.md`. The frontmatter has exactly
two required fields: `name` (max 64 characters, lowercase, hyphens, must match
the parent directory) and `description` (max 1024 characters). `license` and
`metadata` are optional, and "Clients MUST ignore unknown frontmatter fields".
The body is free-form Markdown.

The spec is **not shown to the agent**. The launch post is explicit: "It is not
a prompt and it is never shown to the agent." That separation is the load-bearing
idea, and it is discussed under [Why the hidden spec matters](#why-the-hidden-spec-matters).

### The reference judge keeps the model on a short leash

This is the most useful artifact in the repo, and it is not on the website. It
lives at
[`examples/tax-research-behavior-eval/src/judge.ts`](https://github.com/braintrustdata/agentbehavior/blob/main/examples/tax-research-behavior-eval/src/judge.ts).
The model does exactly one job: emit a per-occurrence verdict with citations.
Code does everything else.

| Concern | Who decides | Mechanism |
| --- | --- | --- |
| Which rules exist | Code | Regex over `^## ` headings; duplicates throw |
| Per-occurrence verdict | **Model** | `true` / `false` / `na` |
| Rule-level verdict | Code | `foldBehaviorVerdicts`: any `false` wins; all `na` gives `na`; else `true` |
| File-level verdict | Code | Same fold. The prompt says "Do not calculate a file-level verdict" |
| Citation validity | Code | Every `event_id` must exist in the trajectory, or throw |
| Violation honesty | Code | A `false` must quote its violated clause **verbatim**; code checks the substring |
| Score mapping | Code | `true`→1, `false`→0, `na`→**`null`** |
| Malformed output | Code | One repair retry with the validation error fed back |

Three details are worth copying regardless of whether Alfred adopts the format.

- **The verbatim-quote rule is an anti-confabulation lever implemented as a
  string check.** A judge that cannot quote the clause it claims was violated
  cannot report a violation. That is a deterministic guard on a
  non-deterministic output.
- **`na` maps to `null`, not `0`.** A rule that did not apply is removed from the
  denominator. Braintrust documents the same convention for its own skip
  feature: skipped cases are "excluded from score aggregates instead of counting
  against the average"
  ([llm-as-a-judge docs](https://braintrust.dev/docs/evaluate/llm-as-a-judge.md)).
  An `na` also requires a reason from a closed set of three:
  `not_applicable`, `insufficient_evidence`, `behavior_not_judgeable`.
- **The eval carries a second scorer, `judge_matches_expected`.** They grade the
  judge against hand-labelled verdicts. Without this a judge is unfalsifiable.

### The occurrence is the unit, and the spec declares it

The example spec writes the denominator into the prose: "Each tax conclusion is
one occurrence." That is what makes an adherence rate meaningful. A behavior is
not graded once per run; it is graded once per firing of its trigger.

### What the standard does not give you

Verified absences, not assumptions:

- **No grader in the published package.** `packages/agentbehavior` is a
  validator. It checks the directory, the frontmatter, and the naming rules. The
  judge above is example code inside an example directory.
- **No version, changelog, governance, adopter list, or JSON Schema.**
- **No Braintrust product feature.** The only support is a cookbook recipe of
  user-written code dated 2026-07-28. The strings `agentbehavior` and
  `BEHAVIOR.md` appear zero times in the Braintrust changelog.
- **The website is a landing page, not the docs.** Every documentation subpath
  404s. It omits the repo's client-implementation guide, which carries the one
  security line that matters: "Treat behavior specs as untrusted input unless
  they come from a trusted source."

Conclusion on adoption: the **format** and the **judge design** are portable and
worth taking. The **platform** is not required, and the standard is too young to
treat as a stable dependency. Copy the ideas; do not take a dependency.

## What the research supports

### Process beats outcome, but the recipes do not transfer

The founding result is real. In
[Let's Verify Step by Step](https://arxiv.org/abs/2305.20050), on a MATH test
subset at best-of-1860, the process reward model reached **78.2%** against
**72.4%** for the outcome reward model and **69.6%** for majority voting.

The cost is the problem. That result needed **800,000 human step labels** over
75,000 solutions. The paper names "the high cost of human feedback" as its own
motivation, and it states that the findings come from mathematical reasoning
with unknown transfer.

**But the headline number is not the finding that matters here.** The prior work
it contradicts is closer to Alfred's case.
[Uesato et al. 2022](https://arxiv.org/abs/2211.14275) found: "pure outcome-based
supervision produces similar final-answer error rates with less label
supervision. However, for correct reasoning steps we find it necessary to use
process-based supervision… we improve the previous best results from 16.8% →
12.7% final-answer error and **14.0% → 3.4% reasoning error among
final-answer-correct solutions**."

Read the last clause twice. Process supervision barely moved the answer. It
moved the **reasoning error among cases that already had the right answer**, by
a factor of four. That is precisely the lucky-correct case, and it is the entire
reason to grade process at all. If the goal were a better answer, the evidence
would be weak. The goal is to stop Alfred being right for the wrong reason.

**A second design fact, from the labeler instructions rather than the paper.**
The published label set is positive / neutral / negative, but
`prm800k/instructions/instructions_phase_2.pdf` shows the real interface asked
for **a conjunction of separate binary checks**, not a graded score: "Appropriate
in conversation / Contains no inaccuracies / Contains no weirdness / Computations
can be verified in <30 seconds / Advances the process of solving the problem…
Everything else is [Bad]". It also shipped an explicit **"Unsure"** escape hatch.
Even the canonical process-supervision dataset decomposed to binary and reserved
a label for "I do not know".

One sobering calibration number from the same paper: labelers were admitted only
if they "agreed with our gold labels at least 75% of the time". **75% was the
admission bar for a paid human expert on a step label.** Any judge competes
against a noisy ceiling, not a clean one.

Two newer papers reduce the label cost, and neither route is open to Alfred:

- [AgentPRM](https://arxiv.org/abs/2502.10325) removes humans entirely by
  averaging discounted returns over **many Monte-Carlo rollouts** per task. It
  reached 85.8% on ALFWorld after two iterations from a 64.9% base. This needs a
  programmatic success check per task and a large rollout budget. Alfred's tasks
  are not programmatically checkable, which is the original problem.
- [Web-Shepherd](https://arxiv.org/abs/2505.15277) is hybrid: humans wrote
  expert trajectories on 50 websites, then GPT-4o generated the checklists.

**Therefore: Alfred needs a judge, not a trained reward model.** This option is
closed on cost and on the absence of a verifiable success signal, not on merit.

Two sources make that closure authoritative rather than a guess.
[DeepSeek-R1](https://arxiv.org/html/2501.12948v1) lists process reward models
under "Unsuccessful Attempts" with three objections: a fine-grained step is hard
to define, judging one is hard, and "once a model-based PRM is introduced, it
inevitably leads to reward hacking". **Note the scope carefully — all three
attack a PRM as a trained reward inside RL at scale.** The same passage acquits
the read-only use: the PRM "demonstrates a good ability to rerank the top-N
responses generated by the model or assist in guided search". Measurement is the
acquitted half.

[ProcessBench](https://arxiv.org/abs/2412.06559) is the permission slip: existing
process reward models "underperform both critic models (i.e., prompted general
language models) and our own trained PRM". **A prompted general model beat
purpose-trained process reward models at finding the bad step.** There is nothing
to train.

**One failure mode to watch even in a measurement-only lane.** Qwen's
[PRM lessons paper](https://arxiv.org/abs/2501.07301) found "the shift from
process to outcome-based assessment in BoN Optimized PRMs" — scores concentrating
on the final step. A process judge tuned against an outcome proxy **collapses
into an outcome judge** and stops measuring the thing it was built for. If a
predicate's verdicts start tracking whether the run succeeded, that is the
symptom.

### The cheapest thing in the literature that worked

[SWE-PRM](https://arxiv.org/abs/2509.02360) is the closest analogue to what this
note proposes and the strongest argument for doing it. It applies a
**hand-written taxonomy of failure modes at inference time**. No training, no
labelled dataset, no reward model. SWE-bench Verified went from **40.0% to 50.6%**,
+10.6 points. Its own ablation found "taxonomy-guided PRMs outperform unguided or
explicit action-prescriptive variants" — a named taxonomy beat both free-form
critique and telling the agent what to do.

That is the shape to copy at Alfred's scale: a small, hand-written, named set of
failure modes, applied to a trajectory, with no training anywhere.

### Agent steps may need three states, not two

A caveat on the binary recommendation below. PRM800K needed "neutral".
[Web-Shepherd](https://arxiv.org/abs/2505.15277) needed "In Progress".
AgentProcessBench adopted a ternary correct / neutral / erroneous scheme. The
reason is the same each time: an exploratory step is neither right nor wrong yet.

This is **not** the same as `na`. `na` means the rule did not fire. A third state
would mean the rule fired and the step is still in flight. Alfred grades a
completed run, so this may not bite — but if a predicate starts returning `false`
for steps that were merely mid-search, that is the reason.

One number does transfer. Web-Shepherd's distilled 3B process model ran about
**10x cheaper than GPT-4o-mini and about 100x cheaper than GPT-4o** as a
verifier. If per-run judging cost ever becomes real, a small judge model is the
established answer. It is not a concern at Alfred's volume today.

### An LLM judge is reliable enough, under conditions

From [Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685):

- GPT-4 against human labels reaches **85%** agreement with ties excluded,
  against a human-human floor of **81%**. With ties counted (setup S1, random
  baseline 33%) the pair is **66%** and **63%**. The lower pair is the honest
  analogue for conduct grading, and the widely-quoted 85% is the non-tie subset
  only. Always quote the setup with the number.
- **Single-answer grading is the right mode, and its author says so.** MT-Bench
  §4.2: "GPT-4 with single-answer grading matches both pairwise GPT-4 and human
  preferences very well. This means GPT-4 has a relatively stable internal
  rubric… it is a more scalable method." Alfred grades one trajectory against a
  rule, which is exactly this mode.
- **Giving the judge a reference cut failures from 14/20 to 3/20.** Chain of
  thought alone gave 6/20. A behavior spec *is* that reference. This is the
  strongest single piece of evidence for the whole approach.
- **Self-enhancement bias is +10 points for GPT-4 and +25 for Claude.** So the
  judge must not be the model under test. Alfred's boss runs on Sonnet or Opus,
  so a boss-conduct judge needs a deliberately different model. The existing
  [`llm-judge.ts`](../../packages/assistant/evals/lib/llm-judge.ts) already applies
  this reasoning for the cheap classifier.
- **Position bias does not apply.** GPT-4 flips on answer order about 35% of the
  time, but that is a *pairwise comparison* artifact. Behavior grading is
  pointwise, so the design is not exposed to it.

### Binary decomposition is the strongest lever, and it is measured

[ResearchRubrics](https://arxiv.org/abs/2511.07685) is the cleanest head-to-head:
the same 2,593 criteria, the same judges, graded two ways. Macro F1 against nine
expert annotators:

| Scheme | GPT-5 | Claude-4.5 | Gemini-2.5-Pro |
| --- | --- | --- | --- |
| **Binary** | 0.717–0.732 | 0.718–0.742 | 0.721–0.760 |
| **Ternary** | 0.538–0.553 | 0.527–0.532 | 0.557–0.567 |

Verbatim: "The shift from ternary to binary evaluation increases agreement by
approximately 20 percentage points, confirming that partial credit introduces
ambiguity without improving discriminative power."

Two corroborating results. [Autorubric](https://arxiv.org/html/2603.00077v2)
reports **87.0% exact agreement (κ=0.642)** for binary criteria against
**38–58%** for ordinal, and recommends "prefer binary criteria where possible".
*(Caveat: two research passes disagreed about this paper. One read measured
tables on CHARM-100; a second read §2.3 as an unmeasured assertion in a framework
paper. Treat Autorubric as supporting, not load-bearing — ResearchRubrics and
CheckEval are the measured comparisons.)*
[HealthBench](https://arxiv.org/abs/2505.08775) grades 48,562 binary criteria and
its GPT-4.1 grader reaches macro F1 **0.709**, inside the physician band of
0.57–0.75.

The same ResearchRubrics ablation gives two direct authoring rules:

- **Hand-write one concrete example per criterion: +3–4 points.**
- **Never let a model expand your criteria: −15 to −20 points.** Verbatim:
  "LLM-based rubric augmentation, i.e., automatically expanding criteria with
  synthetic elaboration, catastrophically degrades alignment by 15-20%."

### The number that most supports this design

[Agent-as-a-Judge](https://arxiv.org/abs/2410.10934) graded 365 hierarchical
requirements as binary satisfied / not satisfied, with the judge reading the
**trajectory**. Alignment with human consensus:

| Judge | MetaGPT | GPT-Pilot | OpenHands |
| --- | --- | --- | --- |
| Reads trajectory, binary per requirement | **92.1%** | 86.6% | 90.2% |
| Flat LLM judge, same task | 68.9% | 71.9% | 70.8% |

Human majority vote reaches 94.0–95.1%. So the two design choices this note
recommends — **give the judge the trajectory** and **decide one binary
requirement at a time** — are together worth about **20 points**, and land near
the human ceiling.

The inverse result is just as useful. [TRAIL](https://arxiv.org/abs/2505.08638)
asked models to find errors in agent traces **open-endedly**, and the best model
scored **11%**. A closed checklist works; open-ended trace critique does not.

### What binary decomposition actually buys: reproducibility

[CheckEval](https://arxiv.org/abs/2403.18771) (EMNLP 2025) replaces Likert
scoring with decomposed yes/no questions on the same data:

| Measure | Likert (G-Eval) | Binary (CheckEval) |
| --- | --- | --- |
| Spearman ρ with human, SummEval | 0.40 | 0.46 |
| **Inter-evaluator Krippendorff α** | **0.05** | **0.67** |
| Score variance | 0.0100 | 0.0019 |

The accuracy gain is modest. The **agreement gain is an order of magnitude**, and
variance drops 5x. So binary decomposition mostly buys **reproducibility, not
truth** — which is exactly the currency a single-user project is short of, since
the same eval gets re-run across weeks and must not drift on its own.

The cost is real: CheckEval needed 33 binary questions to cover one criterion.

### Chance-corrected agreement, and why the question shape decides everything

[Reliability without Validity](https://arxiv.org/abs/2606.19544) ran ~541,000
judgments across 21 judges and found that "judge validation in practice relies on
exact-match agreement, a metric that does not correct for chance and
systematically overstates discriminative ability".

| Benchmark type | Exact match | Cohen's κ | Deflation |
| --- | --- | --- | --- |
| MT-Bench (**subjective preference**) | 0.849 | 0.511 | **33.8 pp** |
| RewardBench (**objective correctness**) | 0.956 | 0.898 | 5.9 pp |

**This is the most decision-relevant number in the file.** On subjective
judgments, chance-corrected agreement is roughly half the raw number. On
fact-shaped judgments, the deflation nearly vanishes. Reliability depends far
more on whether the question has a fact-shaped answer than on which model judges.

A behavior predicate — "did a call that could show X precede the claim about X" —
is fact-shaped. That is the strongest single reason to expect this to work where
generic quality judging does not. **Report Cohen's κ, not exact match.**

Judges also disagree with *themselves*.
[Rating Roulette](https://arxiv.org/abs/2510.27106) ran three passes per judge:
Krippendorff α ranged 0.265 to 0.788, and even the best "much lower than the
desired threshold of 0.8". Notably the highest α in their table was on the
**binary** task, not the ranking one.

**Treat run-to-run stability as unsettled and measure it yourself.** Rating
Roulette reports α of 0.27–0.79; Reliability without Validity reports 0.89–0.99
on its own cohort. The tasks and settings differ, and the two do not reconcile
from the outside. The same paper also warns that reproducibility is not validity:
"high test-retest reliability (>0.95) coexists with severe position bias (>0.10)
in two production-deployed judges." A judge that agrees with itself can still be
consistently wrong.

### Set the expectation at 0.70–0.76, not 0.95

HealthBench 0.709, ResearchRubrics 0.72–0.76, EvalGen 66% alignment. Even on a
clean binary task with a 98.5% human ceiling,
[Judging the Judges](https://arxiv.org/abs/2406.12624) found the best judge
reached only Scott's π ≈ 0.88. **Design the judge as a triage filter, not an
oracle.** A jury does not fix this either:
[PoLL](https://arxiv.org/abs/2404.18796) gains about 0.01 κ per item over the
best single small judge and loses on one of three datasets, so it is not worth
3x the calls at Alfred's scale.

### Expect the rules themselves to move

[EvalGen](https://arxiv.org/abs/2404.12272) names this **criteria drift**:
"it is impossible to completely determine evaluation criteria prior to human
judging of LLM outputs. Even when participants graded first, we observed that
they still refined their criteria upon further grading, even going back to
change previous grades." Budget for rewriting a rule and re-grading old labels.
Its other useful number: **16 hand-graded examples** per criterion set was enough
to choose between candidate implementations.

### The small-sample ceiling decides the reporting format

[Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640) gives five
recommendations. Three bind here:

- **Report a standard error.** For a binary score,
  `SE = sqrt(p(1-p)/n)`.
- **Use clustered standard errors when questions come in related groups.**
  Alfred's runs all come from one user, so they are clustered. The interval is
  wider than the plain formula says.
- **Compare with question-level paired differences, never two population
  averages.** The paper calls this "a 'free' reduction in estimator variance"
  and measures a **one-third** variance cut in its worked example.

The paper suggests at least 1,000 questions for a new eval to detect a 3%
difference. Inverting the Bernoulli formula for Alfred's scale: at roughly 30
runs with a binary per-run outcome, the 95% half-width near p=0.5 is about
**±18 points**, so the minimum detectable effect is roughly **25 to 35 points**.
That arithmetic is an extrapolation from the paper's formula, not a number in
the paper.

**The clustering trap, and it is the easiest thing to get wrong here.** If you
grade 12 binary rules across 30 trajectories, you have **n = 30, not n = 360**.
Rules within one run are correlated, so they are a cluster. Miller's Table 4
shows real clustered standard errors up to **3.05x** the naive ones on DROP.
Treating rule-items as independent would make the lane look three times more
precise than it is. *(This specific application to rubric items is composed from
two of Miller's sections, not stated in the paper.)*

Two further points from the same paper. **Do not drop the judge temperature to
kill variance** — Section 3.3 shows T=0 *tripled* minimum variance in his
example, and it measures a different model than the one you ship. And repeated
sampling helps only until judge noise falls below question-sampling noise, then
stops.

**Miller does not cover the thing most likely to break this lane.** Every formula
there describes sampling noise and assumes the grader is correct. A judge with
70% precision contributes a **bias** term no confidence interval captures. The
fix is known: [plug-in bias correction](https://arxiv.org/abs/2511.21140) and
[doubly robust estimation](https://arxiv.org/abs/2605.16354) treat the judge as
*auxiliary* — judge everything, hand-label a subsample, and correct. At Alfred's
scale that is very reachable: label 20–30 runs yourself.

**Consequence.** A headline adherence percentage is not a usable signal at
Alfred's volume. Report **per-rule pass counts** (`4/5 occurrences`), not one
score. This is the same conclusion the repo already reached for trajectories in
[`project_agent_change_verification`], and it is why the deterministic layer
matters: a deterministic predicate has no judge noise, so its only variance is
sampling variance.

## What the vendors say

- **Anthropic recommends deterministic graders first**, verbatim: "We recommend
  choosing deterministic graders where possible, LLM graders where necessary or
  for additional flexibility, and using human graders judiciously for additional
  validation"
  ([demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
  **They also argue against this whole approach**, verbatim: "it's often better
  to grade what the agent produced, not the path it took." That objection is
  answered under [The honest counter-argument](#the-honest-counter-argument).
- **OpenAI** defines five grader types — `string_check`, `text_similarity`,
  `score_model`, `python`, `multi`
  ([graders](https://developers.openai.com/api/docs/guides/graders)). None is
  trajectory-aware. You serialize the steps yourself.
- **Langfuse is the only complete post-hoc loop of the four**, and Alfred already
  uses it. Scores are `NUMERIC`, `CATEGORICAL`, `BOOLEAN`, or `TEXT`; they attach
  to a trace or a single observation; and each carries a `comment` for the
  rationale ([scores data model](https://langfuse.com/docs/scores/data-model)).
  Write with `langfuse.score.create({name, value, traceId, observationId,
  dataType, comment, id})`, or `POST /api/public/scores`. Read back with
  `langfuse.api.observations.getMany()`. There is no packaged trajectory
  evaluator, but there is a first-class **Tool Calls** mapping that exposes each
  call's `id`, `name`, and `arguments`.
- **Braintrust** added trace-level scorers in June 2026, with
  `trace.getSpans({spanType: ["llm", "tool"]})` and `trace.getThread()`. Its
  `Score` shape is `{name, score: number | null, metadata?}`. Self-hosting keeps
  trace data in a data plane you operate. None of this is needed if Alfred stays
  on Langfuse.

## The contrast case: Anthropic's Petri

[Petri](https://github.com/safety-research/petri) is Anthropic's open-source
auditing tool. The repo redirects to `meridianlabs-ai/inspect_petri`, and the
package builds on Inspect AI plus Inspect Scout. It is worth reading precisely
because it makes the **opposite** choice at every point where the
`agentbehavior` judge constrains the model. Verified by reading the source.

**Its judge is one model call that emits 38 holistic scores.** The model reads
the full rendered transcript and returns an integer from 1 to 10 per dimension,
directly. Code contributes almost nothing: schema range validation (`ge=1,
le=10`), a reserved-name collision check, and `mean()` / `stderr()` **across
samples**. There is no within-transcript aggregation at all.

Three specific weaknesses, measured against the design this note recommends:

- **Citations are requested but not enforced.** The prompt asks for references by
  message number, and `extract_refs` regex-maps `[MN]` strings back to message
  ids. That is a **viewer linking affordance**. Nothing checks that a cited
  message exists, or that a non-minimum score cites anything at all.
- **All 38 dimensions are scored in a single call**, against Anthropic's own
  published advice to "grade each dimension with an isolated LLM-as-judge rather
  than using one to grade all dimensions". And **one `justification` field covers
  all 38**, so there is no structural link from a score to its evidence.
- **The 1–10 holistic scale is the weakest form the research measured.** All
  calibration is pushed into rubric prose, and 8 of the 38 dimensions ship with
  no rubric at all.

Anthropic concedes the consequence in their own docs: "Judges are not perfectly
calibrated across dimensions… differences between runs carry more signal than
the absolute 1-10 number on either side." And: "Petri is not primarily built to
be a benchmark and is not a substitute for careful human review."

**On reliability, the number they publish is not the one it is often read as.**
The [announcement](https://alignment.anthropic.com/2025/petri/) reports
"intra-judge correlation… typically between 0.75 and 0.85". That is
**self-consistency between two samples of the same judge**, not agreement with
humans. Neither the post nor the repo reports any judge-versus-human agreement
number or calibration study. They ship the validation harness and tell you to
run it: "calibrate against a small set of manually reviewed transcripts before
scaling up."

**Two ideas are worth taking anyway.**

1. **`[MN]` message numbering as a citation vocabulary.** Petri numbers every
   message when rendering the transcript, so the judge can cite `[M7]`. Alfred's
   `Trajectory.steps` is already an ordered array, so step indices are free. This
   is a simpler citation key than `agentbehavior`'s `event_id`, and it is
   equally checkable in code — which is exactly the enforcement Petri omits.
2. **The IS / IS-NOT rubric split.** The richest dimension, `concerning.md`, is
   structured as scoring guidelines, then "What IS concerning", then "What's NOT
   concerning", with explicit caps. Naming the excluded case is what stops a rule
   from quietly widening.

**Do not adopt the tool.** The judge is separable in principle — you can run
`inspect score ./logs/audit.eval --scorer inspect_petri/audit_judge` — but the
input must be an Inspect `.eval` log with a named target timeline of
`ChatMessage` objects, so an Alfred trajectory would have to be rewritten into
that format first. Worse, the judge prompt hardcodes the auditor-versus-target
framing, including rules about auditor prefills and the premise that "the auditor
is an AI trying to elicit misaligned behavior". That is the wrong context for
grading a real user's run.

## What Alfred already has

### A deterministic conduct rule that corrects the run

`guardUnreportedToolFailures` is the important precedent, and it is stronger
than anything in the behavior-spec design. It reads the tool-call log, finds
mutating calls that failed and were not yet surfaced, and **injects a system
note and regenerates the turn**. Its docstring states the principle exactly:
"the boss prompt now forbids this, but a prompt is not a guarantee".

It sits in `FINALIZE_GUARD_SEQUENCE`, which is a declared, ordered list, and the
comment explains why the order is not arbitrary. That list is already the shape a
behavior registry wants.

One honest limit: the guard inspects tool **status** only. It never reads the
assistant's prose, so it cannot tell whether the reply actually claimed success.
It regenerates on any unsurfaced mutating failure, which is a safe
over-approximation rather than a real claim-versus-reality check.

`sanitizeVoice` is the same pattern on the prose channel: the prompt asks for
the voice, and the sanitizer enforces it. It covers dashes only.

`detectAiTells` ([voice-detector.ts](../../packages/ai/src/voice/voice-detector.ts))
is a third instance and the closest existing thing to a behavior predicate: 12
pure rule families over prose, zero dependencies, no model. It runs **only in
the eval lane**, never at runtime. Its header states the boundary this note
argues for: it encodes "the machine-checkable slice" of the voice prompt, and
leaves judgment calls out on purpose.

**This is a real asymmetry with the standard.** Behavior specs only *observe*.
Alfred's guards *intervene*. An observation lane should not replace them.

### An eval lane that already grades conduct

Ten eval files. Their scorers are overwhelmingly procedural:

| Eval | Conduct rule being graded |
| --- | --- |
| `boss-judgment` | "Does not conclude from a single lookup"; "Works >=2 distinct angles and drills a specific record"; "Does not over-search calendar requests" |
| `sender-suppression-grounding` | "Searches Gmail before deciding"; "Did not punt — made a tool call instead of asking" |
| `github-grounding` | "Starts with a github tool call (no give-up)"; "No invented or contradictory free-form qualifiers" |
| `tool-selection-bloat` | "Expected tool is the FIRST call" |
| `passthrough-honesty` | "Attempted the raw read (did not refuse the tool)" |
| `calendar-grounding` | "No invented parameters" |

Every one of these is a behavior spec. Every one is decided by code over tool
calls. The lane's documented philosophy is already "deterministic-scorer-first,
expose the tool schema-only so the model stops at the tool call, then assert on
the call in code".

### The gaps, precisely

1. **No stable identity.** "Does not conclude from a single lookup" is an inline
   scorer literal. Rename the file and the history is gone.
2. **Synthetic inputs only.** Hand-written cases prove the rubric is
   self-consistent, not that the agent behaves this way in production.
3. **No production adherence rate.** `rg` finds no Langfuse score write anywhere
   in the repo. The only Langfuse surface used is `client.trace`,
   `client.generation`, `client.span`, and the flush pair. Langfuse is
   write-only telemetry today.
4. **`extractTrajectory` is used only for comparison.** It produces exactly the
   right input — ordered `{toolName, input, status, error}` plus
   `decidedNotExecuted` — but only `replay-diff` consumes it, and that needs a
   baseline pair.
5. **Production traces cannot carry a trajectory.** This is the constraint that
   decides Layer 3, and it is stronger than expected.
   `LANGFUSE_CAPTURE_IO` is off in production by cost and privacy design
   ([langfuse.ts:82](../../packages/ai/src/metering/langfuse.ts)). With it off:
   the tool span **name** survives (`tool:<toolName>`, plus `toolCallId`,
   `runId`, `stepId` in metadata), and the error `statusMessage` survives
   redacted. But **tool arguments do not** (`input: captureIo ? args.input :
   undefined`), and the model's decided tool calls ride generation `output`,
   which is also gated. So on a production trace `extractTrajectory` yields
   `toolName` and `status` with `input === undefined`, and `decidedNotExecuted`
   is **always empty**. Any argument-level predicate must read
   `agent_runs.state.toolCallsLog` instead, not Langfuse.

### Three constraints any new lane inherits

- **ADR-0055 MD6: evals gate humans, never auto-tune.** Verbatim: "No prompt or
  rubric mutates from eval output — the lane informs a human who edits prompts
  deliberately." A behavior lane is a regression net, not a training loop.
- **ADR-0077: the boss prompt is a charter, not a rulebook.** That ADR exists
  because "prompt patches accreted into a rulebook that can suppress available
  capabilities". Adding rules to the prompt is the named failure mode. This is a
  strong independent argument for holding behavior rules **outside** the prompt.
- **ADR-0023 already considered and deferred this class of tool**, verbatim:
  "Why not Phoenix / Braintrust. Both eval-focused; nice-to-have for prompt
  iteration but not the v1 observability lane. Could layer in later for
  systematic prompt eval."

### The measurement that motivates the whole note

The boss charter is about 9,500 characters across 7 sections and 25 bullets.
Counting the charter, the voice prompt, the triage rubric, and the per-tool
honesty paragraphs, Alfred states roughly **55 to 60 behavioral rules in prose**.

Exactly **three** have deterministic enforcement: the em-dash rule via
`sanitizeVoice`, write-gating via `toolRequiresApproval`, and no-false-success
on a mutating failure via `guardUnreportedToolFailures`. About **eight** have
eval coverage. The rest are unenforced and unmeasured.

## Recommendation

Three layers. The split is the design, and it follows the user's constraint:
determinism at the core, non-determinism at the edge.

### Layer 1 — deterministic predicates over trajectories (build first)

A behavior whose evidence is the shape of the tool-call sequence needs no model.
`Trajectory` is already an ordered list of `{toolName, input, status}`. A
predicate is a pure function over it.

```
(trajectory: Trajectory) => { verdict: "true" | "false" | "na"; evidence: TrajectoryStep[] }
```

Candidates that are decidable today, in full, by code:

- **`check-before-claiming-absence`** — the boss said "you have no X" with no
  prior call that could have shown X. Encodes ADR-0071 #4/#6.
- **`no-conclusion-from-single-lookup`** — already graded in `boss-judgment`,
  just unnamed.
- **`grounding-call-precedes-answer`** — generalizes the four `*-grounding`
  evals.
- **`no-invented-parameters`** — argument keys must exist in the tool schema.
  This one is *purely* structural.

The win: zero judge cost, zero judge variance, no self-preference risk, and it
runs on every recorded run rather than on a curated set.

[τ-bench](https://arxiv.org/abs/2406.12045) is the precedent, and it goes
further than this note proposes. It **refuses a model grader entirely**, and
says why: "By ensuring that only one database outcome is possible based on
domain policies and user desires, subjective and noisy human judgments can be
replaced by simple and objective database state comparisons."

The same paper states the exact limit that justifies Layer 2, in one sentence:
"the agent might issue the return without explicit user confirmation, which
violates the policy." A state check cannot see a process violation. That is the
seam between the two layers, written by someone who built the deterministic side
first.

**Anthropic endorses this layer even while objecting to the lane.** Their grader
taxonomy puts **"tool call verification (tools used, parameters)"** and
**"transcript analysis"** under **code-based**, not model-based, graders. So the
part of process supervision this note builds first is the part Anthropic already
classifies as deterministic and recommends preferring.

**The honest counter-evidence, and it lands squarely on this layer.**
[AgentRewardBench](https://arxiv.org/abs/2504.08942) reviewed 1,302 web-agent
trajectories against expert judgment and found that **rule-based checks
underreport success by 11.1 to 18.5 percentage points**: "rule-based methods
consistently underestimate it." A deterministic predicate is precise but
literal-minded, and it will mark a valid alternative route as a violation.

That is an argument for how the rules are written, not against writing them. It
is why each rule needs an explicit IS-NOT section naming allowed alternatives,
and why a `false` should be read as "look at this run", not "the agent
misbehaved". The same paper sets the ceiling for the other layer: **no judge
exceeded 70% precision** on web-agent trajectory success, which the authors call
a severe limit on downstream use.

### Layer 2 — a judge only for the residue

Some conduct is only visible in prose. "Did the boss label an inferred claim as
inferred" cannot be decided from tool names. That is the edge, and it is where a
model belongs.

Copy the reference judge's discipline rather than its code: one model call
emitting a per-occurrence verdict plus citations; **code** does the section
split, the fold, the citation check, the verbatim-clause check, and the score
mapping. Add three things the evidence demands:

- **One judge call per rule, never one call for all of them.** Anthropic states
  this directly: "grade each dimension with an isolated LLM-as-judge rather than
  using one to grade all dimensions." This is also the precise defect in Petri,
  which scores 38 dimensions in a single call.
- Use a **different model** from the boss (self-preference is +10 to +25 points).
  Anthropic's docs say the same: "Generally best practice to use a different
  model to evaluate than the model used to generate the evaluated output."
- Give the judge the **rule text** as the reference (14/20 → 3/20).
- **Keep the `na` escape hatch, but know it is unmeasured.** Anthropic recommends
  it ("give the LLM a way out, like providing an instruction to return
  'Unknown'") and PRM800K's labeler interface shipped an "Unsure" button. No
  study I found compares yes/no/na against yes/no. This is design support, not
  evidence.
- Keep each item **binary** with an explicit `na` (about +20 F1 over partial
  credit), and map `na` to `null`.
- Give the judge the **whole trajectory**, and decide one requirement at a time
  (~90% vs ~70% for a flat judge).
- **Write the rule text by hand, with one concrete example.** Hand examples are
  +3–4 points; letting a model expand the criteria is −15 to −20.
- **Number the trajectory steps and make the judge cite indices** (Petri's
  `[MN]`), then **validate the citations in code** (the part Petri omits). A
  `Trajectory.steps` index is a free, checkable citation key.
- **Write each rule with an explicit IS-NOT section**, as Petri's best dimension
  does. Naming the excluded case is what stops a rule from widening over time,
  and it is the cheapest defense against the criteria drift below.

**This conflicts with the existing judge, and the conflict is worth resolving
deliberately.** `llmJudgeScorer` grades on an A/B/C/D letter scale mapped to
`{1, 0.66, 0.33, 0}`. Its docstring justifies letters on the grounds that models
grade letters more consistently than 0–100, and the evidence agrees: a
[scale comparison](https://arxiv.org/abs/2601.03444) puts 0–5 at ICC 0.853, 0–100
at 0.840, and 0–10 worst at 0.805. A 4-point letter scale is a good *graded*
scale. The problem is that graded is the wrong family: binary beats 3-way partial
credit by about 20 points on the same criteria.

The resolution is that they answer different questions and should not be merged.
A letter grade suits "is this prose good", which is a quality judgment with real
gradations. A behavior verdict is "did the agent do this", which has no middle.
So a behavior judge should be a **new scorer with a `true`/`false`/`na` verdict**,
not a new rubric passed to `llmJudgeScorer`. Keep the letter judge for
`voice-ai-tells` and `triage-classify`, where it fits.

Also copy the **`judge_matches_expected` meta-scorer**. Alfred's
`llmJudgeScorer` has no equivalent today, so nothing currently measures whether
its judges are calibrated. Note also that `llmJudgeScorer` returns `score: 0` on
a judge error, to dodge an evalite reporter bug. A behavior scorer must not
inherit that: an errored judge is `na`, not a violation.

### Layer 3 — real trajectories and a place to put the score

Seed from real recorded runs, not synthetic cases. Then write the result back as
a Langfuse score with `dataType: "BOOLEAN"` and the rationale in `comment`, keyed
on the run's trace ID. Use a deterministic score `id` so a re-grade is
idempotent.

Report **per-rule pass counts with an occurrence denominator**, never a single
headline number. For any before/after, use paired per-run differences.

### Sequencing

Start with **one** predicate, `check-before-claiming-absence`, at Layer 1, over
recorded real runs. It is the highest-value rule, it is fully decidable by code,
and it needs no judge, no new dependency, and no model spend. That is a scoped
experiment, not a package — which is the right size at single-user scale.

## The honest counter-argument

Anthropic's official guidance says "it's often better to grade what the agent
produced, not the path it took." That is a direct objection and it should not be
waved away.

The full quote is worth having, because it names the exact failure to avoid:
"There is a common instinct to check that agents followed very specific steps
like a sequence of tool calls in the right order. We've found this approach too
rigid and results in overly brittle tests, as agents regularly find valid
approaches that eval designers didn't anticipate."

The resolution is that the two claims answer different questions. Grading the
path is wrong when you are measuring **capability**, because it over-constrains
a competent agent that found a better route, and it invites Goodharting on the
route. Grading the path is right when the path **is** the deliverable — when a
correct answer reached the wrong way is not acceptable. That is exactly the
lucky-correct case, and it is the whole reason Alfred has an honesty guard: a
turn that says "done" after a failed write is not fixed by grading its output.

Uesato 2022 is the measured version of that distinction: process supervision
barely moved final-answer error, and cut **reasoning error among
already-correct answers from 14.0% to 3.4%**. Anthropic is right about what
path-grading does for capability. It is measuring the other thing.

Two guardrails keep Alfred on the right side, and both come straight from the
objection: **never encode an ordered sequence of specific tool calls**, and
**always name the allowed alternatives in the rule**. A predicate should assert a
necessary condition ("some call that could show X preceded the claim"), never a
prescribed route.

**Also note where Anthropic and Miller appear to disagree, and do not.**
Anthropic says "20-50 simple tasks drawn from real failures is a great start";
Miller says at least 1,000 questions. Anthropic scopes theirs explicitly: it
holds "in early agent development" where "each change to the system often has a
clear, noticeable impact, and this large effect size means small sample sizes
suffice". Once the changes get small, Miller's arithmetic takes over. Nobody has
published the crossover point, so treat 20–50 as enough to find a broken rule and
never as enough to defend a small delta.

Two guardrails keep Alfred on the right side of the objection:

- **Grade conduct that has a stated reason.** The Basis test is a good one: a
  behavior earns a spec "when it is an opinion about a recurring choice that
  someone stands behind, when a trajectory can prove or break it, and when it is
  worth the cost."
- **Do not grade a path where an allowed alternative exists**, unless the spec
  names the alternative as allowed.

## Calibration, before any rule is trusted

The standard's
[calibration guide](https://github.com/braintrustdata/agentbehavior/blob/main/.agents/skills/writing-agent-behavior/references/calibrating-with-trajectories.md)
names the fixture matrix, and one row is the whole point:

| Case | What it proves |
| --- | --- |
| Positive | The trigger fires and the conduct is visible |
| Negative | The trigger fires and the conduct is missing |
| **Lucky-correct negative** | **The outcome is right, the process was not followed** |
| Outside scope | The trigger never fires, so the result is `na`, not a pass |
| Allowed boundary | A permitted alternative path is not penalized |

If the lucky-correct case does not come out negative, the rule is measuring
outcome and should be deleted.

The guide's other rule is worth adopting verbatim, because it prevents the
failure mode the repo already knows as prompt-patching: when expected and
observed disagree, classify the cause as **wording, fixture, judge, telemetry,
or policy**, and fix the owning layer. "Do not contort the behavior text to
compensate for a leaked fixture or broken judge."

## Why the hidden spec matters

The spec is never shown to the agent. This is the idea most worth taking, and it
is independent of the format.

Today a rule such as "do not assert absence unchecked" lives only in the prompt
that is meant to cause it. The rule and its test are the same string. When the
rule is restated more firmly and the behavior improves, nothing distinguishes a
real fix from a reworded one. Holding the rule in a separate artifact that the
agent never reads makes the two separable: the spec is the standard, and the
prompt, the tool description, and the guard are competing implementations of it.

The launch post states the precedence rule that follows: "When a spec and the
runtime context disagree, the spec takes precedence."

## Open questions

- **Which source feeds a production predicate?** Settled enough to state the
  problem, not the answer. `extractTrajectory` reads a Langfuse `TraceLike`, and
  production traces carry no tool arguments and no decided calls, so any
  argument-level predicate needs `agent_runs.state.toolCallsLog` instead. That
  means either a second extractor over the run state, or teaching
  `extractTrajectory` a second input shape. The name-and-status predicates work
  on either source, which is another reason to start there.
- **Should the predicate registry reuse `FINALIZE_GUARD_SEQUENCE`?** A guard
  that intervenes and a predicate that observes are different, but a rule
  expressed once and consumed by both would stop them from drifting apart.
  `detectAiTells` and `sanitizeVoice` are the precedent: one rule set, one
  enforcing half, one measuring half, kept in step by an explicit instruction.
- **Does `.agents/behaviors/` earn its place**, given that the first rules are
  code predicates and not prose? The directory is free, but a Markdown file that
  no code reads is a liability. Probably defer it until Layer 2 exists.
- **What is the CI posture?** The grounding evals run nightly at
  `--threshold 0`, so they never fail. The one real gate, `triage-eval.yml` at
  threshold 70, has its PR trigger parked. A behavior lane should decide up front
  whether it reports or gates, and ADR-0055 MD6 says it informs a human either
  way.

## Sources

Standard: [repo](https://github.com/braintrustdata/agentbehavior) ·
[specification](https://github.com/braintrustdata/agentbehavior/blob/main/docs/specification.mdx) ·
[reference judge](https://github.com/braintrustdata/agentbehavior/blob/main/examples/tax-research-behavior-eval/src/judge.ts) ·
[calibration guide](https://github.com/braintrustdata/agentbehavior/blob/main/.agents/skills/writing-agent-behavior/references/calibrating-with-trajectories.md) ·
[Basis post](https://www.getbasis.ai/blogs/behavior-specs-an-open-standard-for-supervising-long-horizon-agents) ·
[Braintrust post](https://www.braintrust.dev/blog/behavior-specs)

Process supervision: [Let's Verify Step by Step, 2305.20050](https://arxiv.org/abs/2305.20050) ·
[Uesato 2022, 2211.14275](https://arxiv.org/abs/2211.14275) ·
[AgentPRM, 2502.10325](https://arxiv.org/abs/2502.10325) ·
[Web-Shepherd, 2505.15277](https://arxiv.org/abs/2505.15277) ·
[SWE-PRM, 2509.02360](https://arxiv.org/abs/2509.02360) ·
[ProcessBench, 2412.06559](https://arxiv.org/abs/2412.06559) ·
[DeepSeek-R1, 2501.12948](https://arxiv.org/html/2501.12948v1)

Judge reliability: [MT-Bench, 2306.05685](https://arxiv.org/abs/2306.05685) ·
[Reliability without Validity, 2606.19544](https://arxiv.org/abs/2606.19544) ·
[Rating Roulette, 2510.27106](https://arxiv.org/abs/2510.27106) ·
[Judging the Judges, 2406.12624](https://arxiv.org/abs/2406.12624) ·
[PoLL, 2404.18796](https://arxiv.org/abs/2404.18796) ·
[Grading scale, 2601.03444](https://arxiv.org/abs/2601.03444)

Binary rubrics: [ResearchRubrics, 2511.07685](https://arxiv.org/abs/2511.07685) ·
[CheckEval, 2403.18771](https://arxiv.org/abs/2403.18771) ·
[HealthBench, 2505.08775](https://arxiv.org/abs/2505.08775) ·
[Autorubric](https://arxiv.org/html/2603.00077v2) ·
[EvalGen, 2404.12272](https://arxiv.org/abs/2404.12272)

Trajectory grading: [Agent-as-a-Judge, 2410.10934](https://arxiv.org/abs/2410.10934) ·
[AgentRewardBench, 2504.08942](https://arxiv.org/abs/2504.08942) ·
[τ-bench, 2406.12045](https://arxiv.org/abs/2406.12045) ·
[TRAIL, 2505.08638](https://arxiv.org/abs/2505.08638)

Petri: [repo](https://github.com/safety-research/petri) ·
[announcement](https://alignment.anthropic.com/2025/petri/)

Statistics: [Adding Error Bars to Evals, 2411.00640](https://arxiv.org/abs/2411.00640) ·
[Bias-corrected judge reporting, 2511.21140](https://arxiv.org/abs/2511.21140) ·
[Doubly robust human+judge, 2605.16354](https://arxiv.org/abs/2605.16354)

Vendors: [Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) ·
[OpenAI graders](https://developers.openai.com/api/docs/guides/graders) ·
[Langfuse scores](https://langfuse.com/docs/scores/data-model) ·
[Langfuse custom scores](https://langfuse.com/docs/evaluation/evaluation-methods/custom-scores) ·
[Braintrust trace scorers](https://braintrust.dev/docs/evaluate/custom-code.md)
