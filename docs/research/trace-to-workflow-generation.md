# Trace → reusable workflow: does the Generate step actually work?

**Date:** 2026-07-25
**Question:** For a "Describe → Execute once → **Generate** (execution history → reusable parameterized
workflow) → Store → Reuse (deterministic, no LLM)" loop: how does the Generate step work in practice,
how reliable is it, and what does that imply for building it on a **typed tool-call substrate** rather
than a browser/DOM substrate?
**Scope:** the Generate and Store halves of `browser-use/workflow-use`; academic prior art on inducing
reusable skills/workflows from agent execution traces; the variable-vs-constant induction problem;
hybrid deterministic-graph-with-LLM-node execution engines; commercial framing.
**Out of scope (settled in [compiled-browser-flows-v1-tightening.md](./compiled-browser-flows-v1-tightening.md)):**
selector durability, Playwright/CDP semantics, Vercel Sandbox, LinkedIn ToS.
**Source discipline:** external claims link to the owning project's source at a pinned commit, the paper
itself (arXiv/ACL/publisher), or first-party vendor documentation. Repository observations are from
Alfred's current tree. Quantitative claims computed by me from a pinned artifact are marked as such.

---

## Bottom line

### (a) Is one-demonstration variable induction viable?

**No — not as an autonomous decision. It is viable as a *proposal* confirmed at activation, or as a
*hypothesis* validated by re-execution.** Agent Workflow Memory's induction prompt *defines* the variable
signal as cross-task invariance — "find the repetitive subset of actions **across multiple tasks**… Keep the
values of invariant elements … as they will **share and stay invariant across tasks**." A single trace
contains no variance to observe. SkillDisCo states the rule outright: a skill "should be supported by
**multiple** successful traces, rather than being an incidental pattern that appears in only one execution."
The two systems that *do* induce from one episode (ASI, SkillWeaver) buy the missing variance back by
**re-executing the induced program in the live environment** — ASI verifies by replay, and SkillWeaver
LLM-generates fresh argument values and practices the skill. `workflow-use`, the only one-recording
production-shaped system, resolves the ambiguity by instructing the model to guess and to over-parameterize,
then hands the result to a human. Commercially, **no vendor in twenty-plus years of RPA recorders claims
automatic parameter inference from a trace**; OpenAI's shipped Record & Replay asks the user to
"state … any specific inputs that might vary between skill uses" *before* recording.

The result is not merely empirical. Mitchell's 1980 bias theorem states that an unbiased generalizer "cannot
outperform programs that use rote learning," and anti-unification — the operation that turns mismatches into
variables — is **defined for n ≥ 2**. **From one trace the licensed number of parameters is zero**; every
parameter you emit comes from a bias supplied outside the trace. Only three such biases are known to work
from a single demonstration: **align the literal to the user's request** (SUGILITE), **join it against a data
source you own** (Koala, Rousillon), or **parse it against a domain grammar** (Potter's Wheel, LAPIS).
**Alfred has all three available and currently uses none of them.**

### (b) Is the tool-call substrate genuinely easier to compile than DOM?

**Yes on identity and segmentation, no on the variable decision, and strictly harder on validation.** It
removes the *element-identity* problem, which is where essentially all of `workflow-use`'s complexity lives.
Measured on the pinned tree: **5,167 lines** across the five identity modules
(`selector_generator`, `xpath_optimizer`, `element_finder`, `semantic_executor`, `semantic_converter`) versus
**1,014 lines** across the three variable-induction modules — a 5:1 ratio, and the identity half is the
unsolved half. On a typed tool substrate those 5,167 lines are zero. The sharper corollary: `workflow-use`'s
prompt forbids parameterizing `elementHash` and says "If you think a step has a variable on the `elementHash`
field, **use `agent` step**" — on a DOM substrate a variable *identity* forces an LLM node, so a tool
substrate spends its whole parameterization budget on **data**. It does **not** make the
variable-vs-constant decision easier: a Zod `q: z.string()` cannot tell you which substring of
`"from:acme.com after:2026/07/01"` varies. And on one axis a tool substrate is strictly **harder**: the
validation trick that makes single-episode induction work in the papers is *free re-execution*, which Alfred
cannot afford for writes. Net: build the read-only half first; that is where the substrate advantage is real.

### (c) JSON program we interpret, or generated code?

**JSON program on a versioned interpreter.** Every code-artifact system in the literature (Voyager, ASI,
SkillWeaver, SkillDisCo, NSI) executes generated code in a sandbox, and **Alfred has no sandbox of any kind**
— that alone forces the decision. Separately, the durable-execution engines make replay safety a property of
*program identity*, and they split on whether the memo key is **positional** (Temporal, Restate, DBOS) or
**nominal** (LangGraph, Inngest, Cloudflare). Under a nominal key a JSON artifact is *strictly easier* than
generated code, because artifact-owned immutable node IDs are exactly the "stable, descriptive, unique" step
identity these engines demand and that codegen cannot guarantee. Under a positional key the danger is that a
stable interpreter makes artifact edits invisible to the engine's own change detection — DBOS computes its
version from "a hash of workflow source code" — so the fix is to feed the engine the **artifact revision** as
the version. And Temporal's own LangGraph integration already mandates a per-node, non-defaultable
`execute_in: "activity" | "workflow"` declaration: a schema field in everything but name.

### (d) What is the smallest honest v1 of Generate?

**A "propose parameters, confirm at activation, verify by read-only replay" compiler that is never called
deterministic.** Whole-field parameters only, typed from the existing Zod schema, every candidate defaulted
to its recorded literal, confirmed on the existing activation card, with a third explicit bucket for
time-relative literals that must be *recomputed* rather than parameterized, and verification by replaying
the compiled program and diffing with the existing `diffTrajectories`. No loop induction, no intra-string
parameterization, no auto-promotion, writes excluded from v1. Spelled out in
[the v1 shape](#the-smallest-honest-v1-of-generate).

### A fifth finding that reframes the whole loop

**Two different objectives are being conflated, and only one of them needs a compiler.** Benchmarks built
specifically to test skill induction find that **raw-trajectory reuse frequently beats distilled skills** —
SkillEvolBench across 10 model configurations and 3 harnesses, Memp's verbatim-Trajectory mode beating its
Script mode at every model, and Synapse hitting 99.2% on MiniWoB++ storing nothing but raw traces. If the
goal is "the agent handles this kind of request better and in fewer turns," the evidence says **store and
retrieve the trace** — cheap, well-evidenced, and not on the PRD's ladder at all. Only if the goal is
"remove the LLM from the steady state" do you need a program, and then you need an execution oracle or
multiple traces plus a usage floor. TroVE measures what happens without a usage floor: minting a tool per
example and never reusing it **lowers** accuracy (GQA 0.37 → 0.16 with 395 induced functions).

**Three things in the repo context look wrong in light of this.**

- `packages/ai/src/replay/trajectory.ts` is **not** a sufficient Generate input, and calling it "the
  candidate input" understates the gap. It records `(toolName, canonical input, status, error)` and
  deliberately drops tool **results**. Without results you cannot distinguish "this literal is a
  constant" from "this literal was copied out of the previous step's output" — and inter-step data flow
  is the single most important structure in a parameterized workflow (`gmail.read_message({messageId})`
  where `messageId` came from `gmail.search`). A compiler fed input-only traces will parameterize
  data-flow-derived literals as user inputs. See [P0-3](#p0-3-alfreds-trajectory-normalizer-cannot-see-data-flow).
- `docs/plans/workflows-v1.md`'s graduation ladder implies **determinism** is the prize at rung 3–4. The
  measured literature says the prize is **fewer turns**: ASI −15.3% steps, SkillDisCo −11.3% turns
  (ALFWorld) / −13.1% (WebArena), AWM "reduced steps." Success-rate gains are real but modest in
  absolute terms (WebArena: 32.7% → 40.4% for ASI; 23.9% → 29.1% for SkillDisCo). The PRD's evidence
  gate is right; its framing oversells what compilation buys.
- The ladder has **no rung for trace retrieval**. Rung 1 is "interpreted brief," rung 2 adds a typed
  envelope, rung 3 jumps straight to a deterministic graph. The cheapest, best-evidenced intervention —
  "when this workflow fires, put the last successful run's trajectory in front of the interpreted brief" —
  sits between rungs 1 and 3 and is missing. It needs no compiler, no variable induction and no
  determinism claim, and it is what AWM, Synapse and Memp actually measure.

---

## P0 — the findings that decide the design

### P0-1. `browser-use/workflow-use`: the Generate step is one LLM call with a prior toward over-parameterizing

All source references are pinned to commit
[`fa53b3d4e49356f81f3c70496d54a465da30e93d`](https://github.com/browser-use/workflow-use/tree/fa53b3d4e49356f81f3c70496d54a465da30e93d)
(2026-07-16, which was `main` HEAD when read).

#### Two build pipelines, both a single structured-output call

There are two entry points into Generate, and they share a prompt shape:

| Path | Input | Prompt | Output |
|---|---|---|---|
| **Recorder → workflow** (`BuilderService.build_workflow`) | Chrome-extension event recording, one JSON message per event, optional screenshots (`max_images=20`) | [`builder/prompts.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/builder/prompts.py) | `WorkflowDefinitionSchema` via `output_format=` structured output ([`builder/service.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/builder/service.py)) |
| **Agent run → workflow** (`HealingService.create_workflow_definition`) | A `browser_use` `AgentHistoryList` flattened to per-step `(url, title, agent_brain, actions, results, interacted_elements)` + screenshots | [`healing/prompts/workflow_creation_prompt.md`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/healing/prompts/workflow_creation_prompt.md) | same schema ([`healing/service.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/healing/service.py)) |

The second path is the direct analogue of Alfred's loop: *execute once with an agent, then compile the
execution history*. It also proves that the compiler input is much richer than a canonicalized action
list — it carries the agent's reasoning (`agent_brain`), per-step results, screenshots, and the URL/title
of every state.

The available action set is injected into the prompt by reflecting over the controller registry and
rendering each action's Pydantic `model_json_schema()` as `` `name`* (type) `` lines
(`BuilderService._get_available_actions_markdown`). **The typed tool schema is already how the compiler
learns what it may emit** — a useful precedent for Alfred, where the same information is in the Zod
registry.

#### `.workflow.json` node kinds

From [`schema/views.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/schema/views.py):
`navigation`, `click`, `input`, `select_change`, `key_press`, `scroll`, `go_back`, `go_forward`,
`extract_page_content`, `extract`, and `agent`. Top level is `{workflow_analysis?, name, description,
version, default_wait_time?, steps[], input_schema[]}`. It is a **flat ordered list** — no edges, no
branches, no loops, no conditions. `BaseWorkflowStep` sets `model_config = {'extra': 'allow'}`, so
unmodelled recorder fields survive unvalidated.

Two things worth lifting:

- Every step may declare `verification_checks` and `expected_outcome` — i.e. postconditions are part of
  the artifact, which matches the tightening doc's recommendation.
- A validator **requires the workflow to end with an extract step**:
  `'Workflow must end with an extract step (extract or extract_page_content). … AI processing is always
  needed at the end of a workflow.'` So `workflow-use`'s own schema makes a fully LLM-free replay
  impossible. Any Alfred claim of "zero-LLM replay" needs the same honesty (`costClass`).

#### How variables are declared and typed

`WorkflowInputSchemaDefinition` is deliberately tiny: `{name, type: 'string'|'number'|'bool', format?,
required?, default?}`. `format` is free text ("MM/DD/YYYY", "user@domain.com"). References use Python
`str.format` single-brace placeholders, and resolution at run time is literally
`data.format(**self.context)` in
[`workflow/service.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/workflow/service.py)
(`_resolve_placeholders`), with `KeyError` silently returning the unformatted string. Inputs are
validated against a Pydantic model built from `input_schema` (`_validate_inputs`).

Note the asymmetry that matters most for Alfred: the **executor** can substitute *substrings*
(`"from:{sender} after:{date}"` works fine under `str.format`), but the **inducer** cannot produce them
(next section).

#### How variables are induced — three competing mechanisms, none authoritative

This is the crux, and the honest answer is that `workflow-use` has three mechanisms that do not agree,
which is itself evidence the problem is unsolved.

**(1) The build prompt guesses, and is instructed to over-guess.** From `builder/prompts.py`:

> "Always aim to include at least one input in `input_schema` unless the workflow is explicitly static
> (e.g., always navigates to a fixed URL with no user-driven variability). Base inputs on the user goal,
> event parameters (e.g., search queries, form inputs), or **potential reusable values**."

And from `workflow_creation_prompt.md`, the trace-based path:

> "Include at least one input unless the workflow is completely static"
> …
> "The goal shows the original task given to the agent. **Assume all agent actions can be
> parameterized** and identify which variables should be extracted."

The classification rubric is a prose list — "SHOULD BE VARIABLES: User-specific data (names, emails,
search terms, dates, amounts, selections) / SHOULD BE HARDCODED: Navigation targets, UI element labels,
constant values." The decisive input is the **user's task description** (`{goal}`), not the trace: the
model is told to read the goal and infer which recorded literals the user meant to vary. There is no
type inference, no invariance evidence, and no confirmation step in this path.

**(2) A second LLM pass exists but is explicitly advisory.**
[`healing/variable_extractor.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/healing/variable_extractor.py)
holds `VARIABLE_ANALYSIS_PROMPT` with a cleaner rubric and emits `VariableSuggestion{name, type, format,
required, original_value, step_indices, reasoning}`. But `create_workflow_definition` logs and discards
it:

> `# Note: We don't auto-apply these suggestions, just log them`
> `# The initial LLM generation should have already identified the main variables`

Two hard limits in the applier, when it *is* called: `apply_variable_suggestions` only acts when
`apply_all=True`, and `_replace_value_in_step` matches on **whole-field equality** over exactly
`['value','selectedText','url','task','target_text']`:

```python
for key in ['value', 'selectedText', 'url', 'task', 'target_text']:
    if key in step_dict and step_dict[key] == old_value:
        step_dict[key] = new_value
```

So **intra-string parameterization is not implemented on the induction side**, even though the executor
would support it. This is exactly the `q: "from:acme.com after:2026/07/01"` case, and the reference
implementation declines it.

**(3) A deterministic identifier exists and, by default, declines the ambiguous case.**
[`workflow/variable_identifier.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/workflow/variable_identifier.py)
is a genuinely deterministic three-stage classifier over `type == 'input'` steps' `value` field only:

- **Stage 1 — regex patterns** (email, phone, URL, zip, SSN, credit card, date, number): confidence
  `0.95`.
- **Stage 2 — context keywords** matched against `semanticInfo.labelText/placeholder/ariaLabel/name/id`,
  `target_text`, `description`, and name/id scraped out of the `cssSelector`: confidence `0.85`
  (`0.75` for the generic name-field fallback).
- **Stage 3 — `_looks_dynamic` heuristic**: ≥2 of {mixed case, contains a digit, contains one of
  `@#$%&*_-`, length > 10}: confidence **`0.5`**.

The default `min_confidence` is `0.6`. **Stage 3 therefore never fires by default** — the deterministic
path abstains precisely on the values it cannot type-classify. It also has a hardcoded
`STATIC_VALUES` deny-list (`'submit'`, `'cancel'`, `'ok'`, `'true'`, `'0'`, …), and it *always* writes the
recorded literal into `default`:

> `# IMPORTANT: Always add default value (original value from workflow)`
> `# This allows the workflow to run without user input if desired`

That last line is the single most transferable design decision in the whole project: **an induced
parameter defaults to its recorded literal, so a wrong parameterization degrades to the recorded
behaviour rather than to a prompt or a crash.**

**(4) The human path.** `VariableExtractor.MANUAL_MARKER_PATTERN` is
`re.compile(r'VAR:([a-z_][a-z0-9_]*):(\S+)')` — the user types `VAR:repo_name:browser-use` into the form
field *during recording*, and `process_workflow_with_markers` turns it into a declared input. And at
run time, [`docs/VARIABLES.md`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/docs/VARIABLES.md)
documents that the CLI prompts interactively for every variable
(`Enter value for repo_name (required, type: string):`). So the shipped end-to-end story has a human in
the loop at both ends.

#### Storage layout

[`storage/service.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/storage/service.py):
a directory of `<uuid>.workflow.yaml` files plus a single `metadata.json` index keyed by UUID, each entry
`{id, name, description, version, created_at, updated_at, file_path, generation_mode:
'manual'|'browser_use', original_task}`. Its own docstring says "This can be extended to use a proper
database … in the future." The committed
[`storage/metadata.json`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/storage/metadata.json)
still contains a developer's absolute `/Users/...` paths. **There is no revisioning, no content hash, no
pinned engine version, and no run ledger.** Alfred's `workflow_revisions` design in the PRD is strictly
ahead of the reference implementation here; do not look to `workflow-use` for the Store half.

One thing *is* worth copying: [`mcp/service.py`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/mcp/service.py)
globs the workflow directory and registers each stored workflow as an MCP tool whose **function
signature is generated from the induced `input_schema`** (via `inspect.Signature` over
`workflow._input_model.model_fields`). That is the honest shape of Reuse: an induced workflow becomes a
typed tool. For Alfred, a compiled workflow should appear in the registry as a first-class tool with a
Zod schema derived from the confirmed parameters.

#### Runner semantics, and the fallback-to-agent claim is false at this commit

The README headline is "Deterministic, Self Healing Workflows (RPA 2.0)" and claims workflows
"fallback to Browser Use if a step fails" and "automatically extract variables from forms"
([README](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/README.md)).
In the source at this commit, **the agent fallback is commented out**. `Workflow.__init__` still takes
`fallback_to_agent: bool = True`, `_fallback_to_agent` is entirely commented out (lines ~421–490 of
`workflow/service.py`), and `_execute_step` raises instead:

```python
except Exception as e:
    logger.warning(f'Deterministic step {step_index + 1} ({action_name}) failed: {e}. Attempting fallback with agent.')
    raise ValueError(f'Deterministic step {step_index + 1} ({action_name}) failed: {e}')
```

and for agent steps: `raise ValueError(f'Agent step … failed: {e}. (Agent fallback is disabled)')` —
followed by unreachable code. The log line still says "Attempting fallback with agent" while doing no
such thing.

What *does* exist is a **degradation ladder inside the step type**: if a selector step has no
`cssSelector` but has `target_text`, execution routes to `SemanticWorkflowExecutor`; `extract` /
`extract_page_content` route to an LLM extraction call; and `agent` steps run a full `browser_use` agent
bounded by `max_steps` (default 5 per the builder prompt). The project also self-warns:

> "This project is in very early development so we don't recommend using this in production."

**Takeaway for Alfred:** treat `workflow-use` as evidence about the *shape* of the Generate step
(one structured-output call over a rich trace, typed action catalog in the prompt, whole-field
parameters, recorded literal as default, human confirmation at both ends) and as evidence about which
claims not to make. Do not treat its README as a description of its behaviour.

#### Non-browser steps

None. The step union is browser actions plus two LLM node kinds (`agent`, `extract*`). There is no HTTP
node, no API node, no code node, and no state/branch node. `workflow-use` is not a general workflow
engine and does not answer the tool-call-substrate question — which is precisely why sections P0-2 and
P0-4 matter more.

#### Stated accuracy / reliability

The project publishes **no** success-rate numbers. The only quantitative self-claims are in
[`docs/DETERMINISTIC.md`](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/docs/DETERMINISTIC.md),
which compares its LLM-free converter against LLM-based generation: generation 5–10 s vs 20–40 s,
generation cost $0.01–0.05 vs $0.10–0.30, execution cost **$0/run vs $0.03–0.30/run**, "0 guaranteed"
agent steps. Those are cost/latency claims, not reliability claims. `HealingService._validate_workflow_quality`
prints a warning per induced `agent` step: "Agent steps are 10-30x slower and cost money per execution."

So the honest reading of the reference implementation is: **the measured, defensible win of compiling a
trace is cost and latency, not correctness.** That matches the academic picture exactly (P0-2).

### P0-2. Academic prior art: induction from ONE trace is the exception, and it is paid for with re-execution

#### Agent Workflow Memory (AWM) — the artifact is a prompt fragment, and the variable signal is cross-task invariance

[arXiv:2409.07429](https://arxiv.org/abs/2409.07429). Reported gains: **+24.6% relative** success on
Mind2Web and **+51.1% relative** on WebArena, with fewer steps on solved tasks, and +8.9 to +14.0
absolute points as the train/test distribution gap widens. Absolute WebArena numbers with GPT-4:
BrowserGym baseline 23.5% → AWM **35.5%** (SteP, with human-written workflows, 33.0%). Mind2Web
cross-task: MindAct 36.2% step-success / 2.0% task-success, Synapse 30.6 / 2.4, AWM **45.1 / 4.8**.
Offline AWM consumes ground-truth annotated training trajectories; online AWM processes the test stream
sequentially and admits only trajectories an LLM judge labels successful.

The decisive evidence is the induction prompt in the authors' repo, pinned at
[`8c0ff8c`](https://github.com/zorazrw/agent-workflow-memory/tree/8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1)
([`webarena/prompt/instruction.txt`](https://github.com/zorazrw/agent-workflow-memory/blob/8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1/webarena/prompt/instruction.txt)):

> "Given a list of web navigation tasks, your task is to extract the common workflows to solve these
> tasks. … You need to find the repetitive subset of actions **across multiple tasks**, and extract each
> of them out as a workflow. … Represent the **non-fixed** elements (input text, button strings) with
> descriptive variable names as shown in the example. Keep the values of **invariant** elements, e.g.,
> id of "Search" or "Customers", **as they will share and stay invariant across tasks**."

The variable/constant decision is *operationalized as variance across traces*. This is the cleanest
statement in the literature of why one demonstration is insufficient: the signal AWM uses does not exist
in a single trace.

Three further facts from the repo that matter:

- [`induce_prompt.py`](https://github.com/zorazrw/agent-workflow-memory/blob/8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1/webarena/induce_prompt.py)
  batches successful runs across **many** tasks, dedupes by WebArena `intent_template_id`, and samples
  `--num_samples` (default 1) per template. The input to a single induction call is a corpus, not a
  trace.
- [`induce_rule.py`](https://github.com/zorazrw/agent-workflow-memory/blob/8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1/webarena/induce_rule.py)
  — the rule-based alternative — does *no* abstraction at all: it dedupes by an abstract action
  signature and appends the raw concrete trajectory, gated on a literal human prompt:
  `to_add = input("Workflow: \n" + w + "\n\nAdd? (y/n): ")` unless `--auto`.
- The workflow files actually committed to the repo
  ([`webarena/workflow/*.txt`](https://github.com/zorazrw/agent-workflow-memory/tree/8c0ff8cd11d648c8fceb99e4e42f37e3b75381b1/webarena/workflow))
  contain **zero** variable placeholders. *My count over those five files at that commit: 178
  actions of the form `click('227')` / `fill('145', 'Hilton Pittsburgh Airport')` — per-observation
  numeric element IDs and concrete literals.* They are rule-based output: raw exemplars.

**And the paper's own ablation says the abstraction barely matters.** ⚠ *Second-hand from the parallel
sweep, worth verifying before quoting:* on WebArena, AWM's rule-based variant scores **35.6** success versus
**35.5** for the LLM-abstracted variant. If that holds, then on AWM's own benchmark **inducing variables adds
nothing over appending deduplicated concrete exemplars** — which is precisely what the committed
`webarena/workflow/*.txt` files are. The gain is retrieval and exemplar selection, not parameterization.

That last point is the substrate argument in miniature. AWM's artifact **cannot** be an executable
program, because its action space addresses elements by an ID that is only meaningful inside the
observation that produced it. So the artifact is text appended to the agent's prompt. The paper's own
noted failure mode follows: workflows with pre-determined action sequences fail when intermediate
environment states differ from the recording (e.g. an unexpected popup). The paper has **no dedicated
Limitations section**.

#### ASI (Agent Skill Induction) — the strongest one-episode result, and it works because it re-executes

[arXiv:2504.06821](https://arxiv.org/abs/2504.06821) (Wang, Gandhi, Neubig, Fried).
Artifact: an executable Python function over the browser action space, e.g.

```python
def search_reviews(search_box_id, search_button_id, search_term):
    """Search for reviews by a specific term."""
    fill(search_box_id, search_term)
    click(search_button_id)
```

Induction is from **a single filtered episode** — "given a clean input episode e, we now prompt the
induction module I to produce one or more program functions to represent reusable skills 𝒟={d} as
executable programs" — with the prompt constraining argument types: "The arguments to these functions
should be common variables (such as strings and lists), avoid using complex inputs such as another
function." Arguments are LLM-inferred abstractions of concrete trajectory values.

What makes it work is the **verification gate**, which is checked by re-running in the live environment
on three conditions: "(1) Correctness: if executing τf successfully solves the task q as judged by the
neural model evaluator Vℒ; (2) Skill Usage: if the trajectory contains at least one call to at least one
new skill in 𝒟; and (3) Skill Validity: if all skill-calling actions cause environment changes."
Induction is online across the 812 WebArena tasks; verified skills join the action space for subsequent
episodes.

Numbers: WebArena success **32.7% (vanilla) → 36.3% (text skills, AWM-style) → 40.4% (ASI)**; step
reduction 15.3% vs vanilla and 10.6% vs AWM; cross-website shopping transfer 80.0% → 90.0%. Authors'
own caveats: "we still find multiple pieces in ASI worthy of further investigation, such as the
conceptually or empirically suitable granularity of skills, the stability of the online evolving
process, and the skill quality in comparison to human expert desiderata," and skills induced on one
website "cannot be directly used on arbitrary new websites."

**This is the single most important paper for Alfred's design**, because it is the existence proof that
one-episode program induction can beat text-workflow induction — *conditional on programmatic
verification by re-execution*. The paper attributes the win to exactly that: "mainly thanks to the
programmatic verification guarantee during the induction phase."

#### SkillWeaver — manufactures the missing demonstrations, and its shipped library is mostly unparameterized

[arXiv:2504.07079](https://arxiv.org/abs/2504.07079) (OSU NLP). Abstract claims relative success-rate
improvements of **31.8%** (WebArena) and **39.8%** (real websites), and up to **54.3%** when a strong
agent's synthesized APIs are given to a weaker agent.

Source pinned at
[`f2a63d6`](https://github.com/OSU-NLP-Group/SkillWeaver/tree/f2a63d65d0f6ff46ac30e817cede8797f8f25b97).
Three mechanisms are directly relevant:

1. **Generalization is instructed, not derived.**
   [`templates/kb_procedural_update_base.md`](https://github.com/OSU-NLP-Group/SkillWeaver/blob/f2a63d65d0f6ff46ac30e817cede8797f8f25b97/skillweaver/templates/kb_procedural_update_base.md):
   "Try to make this logical procedure represent the **general case** of your task, rather than a
   specific case," and "Do not ``overfit'' your function name to a specific set of task parameters.
   Instead, try to generalize your parameters." Notably, it also encodes a *checkable* parameter-quality
   rule: "Avoid using `*_id` or `*_url` parameters, because these are not human-readable. … **We will
   check your code for such parameters!**"
2. **Practice replaces additional demonstrations.**
   [`templates/generate_practice_args.md`](https://github.com/OSU-NLP-Group/SkillWeaver/blob/f2a63d65d0f6ff46ac30e817cede8797f8f25b97/skillweaver/templates/generate_practice_args.md):
   "You have an **untested** automation called {name} with the signature: … Because this is untested, you
   want to test it right now. **Generate some reasonable parameters based on the page.** … Test new args,
   if it looks like existing ones have already been tested." `explore.py` samples an untested function by
   a softmax over a `rate_practice_utility` score, LLM-generates arguments **constrained to the
   function's JSON schema**, and re-executes. The exploration budget in the project's own example command
   is `--iterations 160` per website.
3. **The typed signature is derived from the induced code, not the reverse.**
   [`knowledge_base/generate_schema.py`](https://github.com/OSU-NLP-Group/SkillWeaver/blob/f2a63d65d0f6ff46ac30e817cede8797f8f25b97/skillweaver/knowledge_base/generate_schema.py)
   walks the function AST and maps annotations to JSON Schema (`str`→string, `list[T]`→array,
   `Union`→`anyOf`, `Literal`→enum), **defaulting an unannotated parameter to `{"type": "string"}`** and
   raising on `dict`.

And here is the uncomfortable measurement. *Computed by me over the five skill libraries the authors
ship in [`skillnet/`](https://github.com/OSU-NLP-Group/SkillWeaver/tree/f2a63d65d0f6ff46ac30e817cede8797f8f25b97/skillnet)
at that commit, by parsing each file's AST:*

| Library | Functions | With ≥1 parameter (besides `page`) | Parameters | Type-annotated | Lines |
|---|---|---|---|---|---|
| reddit | 121 | 7 (6%) | 10 | 0 | 4,479 |
| shopping | 56 | 2 (4%) | 3 | 0 | 2,219 |
| gitlab | 113 | 10 (9%) | 10 | 0 | 4,665 |
| map | 40 | 18 (45%) | 30 | 0 | 1,028 |
| cms | 108 | 17 (16%) | 21 | 0 | 4,562 |
| **total** | **438** | **54 (12.3%)** | **74** | **0** | **16,953** |

**After ~160 exploration iterations per site, 87.7% of the induced "APIs" take no argument at all, and
not one of the 74 parameters carries a type annotation** — so every one of them degrades to
`{"type": "string"}` in the generated schema. The libraries also contain near-duplicates
(`navigate_to_subreddit` and `navigate_to_forum` are byte-identical modulo the parameter name;
`extract_recent_submissions` / `retrieve_recent_submissions`; `navigate_to_submissions` /
`navigate_to_submissions_section`). *My inference:* the honest reading is that SkillWeaver's measured
gains come mostly from **procedure composition and documented usage logs**, not from successful
parameter induction. Its docstrings carry a mandated "usage log" of what happened on each call — which
is arguably the real transferable artifact.

#### Voyager — one trace per skill, but only because it has an execution oracle

[arXiv:2305.16291](https://arxiv.org/abs/2305.16291) (NeurIPS 2023). Artifact: an executable JavaScript
program plus an LLM-generated description; the *description* is what gets embedded into the vector DB, the
*program* is the value —
[`voyager/agents/skill.py`](https://github.com/MineDojo/Voyager/blob/main/voyager/agents/skill.py) stores
`{"code": program_code, "description": skill_description}` and calls
`vectordb.add_texts(texts=[skill_description], ids=[program_name])`. Retrieval injects the top-5 skills.

Admission requires success **and** self-verification: "we instantiate another GPT-4 agent for
self-verification. By providing Voyager's current state and the task to GPT-4, we ask it to act as a critic
and inform us whether the program achieves the task." Budget: "If the agent gets stuck after 4 rounds of
code generation, then we query the curriculum for another task."

Gains: 3.3× more unique items (63 within 160 prompting iterations), 15.3× faster tech-tree milestones.
The **skill-library ablation is more sobering than the headline** — iterations to reach each tier, lower
better: Wooden 6±2 vs 7±2, Stone **11±2 vs 9±4 (worse with the library)**, Iron 21±7 vs 29±11, Diamond
**1/3 runs with the library, 0/3 without**. The library matters only at depth. Stated limitations include
"**Cost.** The GPT-4 API incurs significant costs," and "**Inaccuracies.** … there are still cases where
the agent gets stuck and fails to generate the correct skill."

**Why this matters for Alfred:** Voyager is the closest classic result to "one trace → one parameterized
program," and it works because of three properties Alfred has only partially: (i) a cheap programmatic API,
(ii) execution errors fed back for repair, (iii) a critic that can read ground-truth world state. Alfred
has (i) and can build (ii)/(iii) for *reads* — not for writes.

#### ADAS and AFlow — the wrong ancestors: they search against a score, not a trace

**ADAS** ([arXiv:2408.08435](https://arxiv.org/abs/2408.08435), ICLR 2025) generates a Python `forward()`
function defining a whole agentic system, from an archive, with "two self-reflection steps … to ensure it is
novel" and up to five error-driven refinements. 25 iterations (ARC) / 30 (others), 128 val / 800 test.
Gains over the best hand-designed baseline: **+13.6 F1 on DROP, +14.4 pp on MGSM**, but MMLU (69.6±3.2 vs
67.6±3.2) and GPQA (34.6±3.2 vs 32.9±3.2) are within overlapping CIs. Cost, verbatim: "A single run of
search and evaluation on ARC … costs approximately **$500 USD** in OpenAI API costs." No Limitations
section; §6 concedes "Currently, we only evaluate Meta Agent Search on single-step QA tasks" and lists
online continual learning as future work.

**AFlow** ([arXiv:2410.10762](https://arxiv.org/abs/2410.10762), ICLR 2025 Oral) represents a workflow as
LLM-invoking nodes with **code as the edge structure** ("code representation inherently supports all these
relationships through standard programming constructs. Therefore, we adopt code as our primary edge
structure to maximize expressivity"), narrows the space with reusable **Operators**, and searches with MCTS
for 20 rounds against a 1:4 val:test split. Best average 80.3 vs 74.7 for CoT. The load-bearing datapoint
for Alfred is the ADAS row: **ADAS scores below plain IO prompting on HumanEval (82.4 vs 87.0), MBPP (53.4
vs 71.8) and MATH (35.4 vs 48.6)** — generic code-space search does not transfer. AFlow has no Limitations
section; it self-narrows to "reasoning tasks with numerical evaluation functions."

**Neither consumes an execution trace.** Both induce from a *benchmark score* over a validation set. If the
Generate step must come from a trace — which is Alfred's premise — these are the wrong lineage to cite, and
both require a dense automatic scalar reward that Alfred's workflows do not have.

#### Learn-by-Interact and Synapse — the two ends of the abstraction spectrum

**Learn-by-Interact** ([arXiv:2501.10893](https://arxiv.org/abs/2501.10893)) synthesizes (instruction,
trajectory) data by **backward construction** — re-deriving the instruction from what actually happened
rather than the reverse. Scale: 1,125–4,568 raw trajectories per environment yielding ~10k retained
examples (SWE-bench 4,568→10,232; WebArena 3,967→10,456; OSWorld 1,125→11,782; Spider2-V 1,226→10,169).
ICL gains (Claude-3.5-Sonnet): WebArena 35.8 → **48.0**, OSWorld 12.4 → **22.5**, Spider2-V 8.4 → **16.6**.
Training Codestral-22B: WebArena 4.7 → 9.9 untuned → **24.2** tuned. Its scaling section reports monotone
improvement with data volume — "both learning paradigms benefit from larger data" — i.e. **no knee showing
a small number of traces suffices**. Limitations, verbatim: "it requires a lot of LLM calls in generation
and filtering… these resources may be incomplete or not available."

**Synapse** ([arXiv:2306.07863](https://arxiv.org/abs/2306.07863), ICLR 2024) is the explicit
**no-induction control**, and it is the most awkward result for the whole compile-a-trace thesis. Memory is
`D = (K, V)` where V holds "state abstraction prompts and exemplary trajectories" retrieved by embedding
similarity. Nothing is abstracted or parameterized. With **3.45 exemplars per task** it reaches **99.2%
mean success across 64 MiniWoB++ tasks** — human-level — versus CC-Net's 1.3M demonstrations and WebGUM's
346,827. On Mind2Web, stacking components gives Step SR 17.4 → 25.2 (state abstraction) → 29.2
(trajectory-as-exemplar) → 30.6 (memory) cross-task; **memory adds only ~1.4 pp over static exemplars and
does not help cross-domain** ("memory does not aid in cross-domain generalization, as these domains are
entirely unseen"). Limitations include "our dependence on the quality of exemplars."

#### The demonstration-count evidence, gathered

This is the direct answer to the crux, and the split is by **artifact type**.

| Method | Artifact | Demonstrations to induce | Regime |
|---|---|---|---|
| [Voyager](https://arxiv.org/abs/2305.16291) | executable code + NL description | 1 success + ≤4 repair rounds + LLM critic | online, curriculum-driven |
| [TroVE](https://arxiv.org/abs/2401.12869) | parameterized Python fns | 1 allowed, **then trimmed if under-used** | online streaming |
| [ASI](https://arxiv.org/abs/2504.06821) | executable program | 1 verified episode | online |
| [SkillWeaver](https://arxiv.org/abs/2504.07079) | Python API + docstring | 1 discovery + N self-generated practice runs (~160 iterations/site) | online exploration |
| [LATM](https://arxiv.org/abs/2305.17126) | typed Python function | **3 demos + 3 validation samples** (⚠ second-hand) | offline, once per task type |
| [NSI](https://arxiv.org/abs/2605.01293) | logic-grounded program | 2 (ALFWorld) / 3 (TextCraft) / 1 (WebShop) | few-shot |
| [MSCE](https://arxiv.org/abs/2607.16621) | structured NL policy | **hard gate: `n_min = 2` distinct episodes** (⚠ second-hand) | online |
| [SkillDisCo](https://arxiv.org/abs/2606.26669) | parameterized PFSM subgraph → verified Python | **200 (ALFWorld) / 406 (WebArena) induction tasks → 5 / 20 skills** | offline corpus |
| [AWM](https://arxiv.org/abs/2409.07429) | NL/action text (prompt fragment) | corpus, deduped per intent template | offline or online stream |
| [Learn-by-Interact](https://arxiv.org/abs/2501.10893) | (instruction, trajectory) data | 1,125–4,568 per environment | offline |
| [Synapse](https://arxiv.org/abs/2306.07863) | raw trajectory, no abstraction | 3.45 exemplars/task, hand-provided | offline |
| MACLA (⚠ second-hand) | slot-parameterized NL procedure | **2,851 ALFWorld traces → ~187 procedures** (~15:1) | offline + post-episode merge |

**TroVE is the sharpest formal statement of the one-trace problem.** It processes examples "online in a
streaming fashion" and *will* create a function from a single instance — then deletes it: "Periodically
during testing, we remove functions that have been used less than λ times… we set λ = C × log₁₀(n), where
C = ½." And its own INSTANCE baseline, which mints a tool per example and never reuses them, **actively
hurts accuracy**: GQA 0.37 → 0.16 with 395 functions; TabMWP 0.43 → 0.36 with 3,175 functions; "most
induced functions are invalid and impair solution generation." Trimming to ~7–38 functions is what recovers
the win (MATH-alg 0.72/16 tools with GPT-4 vs CRAFT 0.68/282 and Creator 0.65/875). **The lesson for Alfred
is a usage floor: a compiled workflow that is never re-run is not an asset, it is clutter, and the
literature measures the clutter as negative.**

**One genuinely-one-shot positive result, and its trick is directly usable.** ⚠ *Second-hand from the
parallel sweep, worth verifying before quoting:* **MIND-Skill** ([arXiv:2605.08670](https://arxiv.org/abs/2605.08670))
reports 1 trajectory → 1 skill (AppWorld: 90 train tasks → 90 skills), optimizing 8 TextGrad iterations
against a **reconstruction** loss — a separate deduction agent must regenerate the original trajectory from
the skill document alone. That is the key move: **reconstruction is a verification signal obtainable from a
single trace, whereas support/frequency is not.** Alfred's version of this is strictly stronger, because
Alfred can *actually re-execute* and diff, rather than asking a model to imagine the trajectory. See
[the v1 shape](#the-smallest-honest-v1-of-generate), item 8.

Also worth noting, ⚠ second-hand: **SkillLearnBench**
([arXiv:2604.20087](https://arxiv.org/abs/2604.20087)) ablates refinement rounds and finds a single
induction pass already delivers most of the value (No-Skill 10.17% → One-Shot **30.44%** → Self-Feedback
31.08% → Teacher-Feedback 27.47%), with **human-authored skills at 74.50%**. So the bottleneck is not the
number of induction iterations; it is the gap to a human-authored artifact. Self-refinement without external
signal "leads to drift rather than progress."

#### The strongest counter-evidence: raw traces often beat distilled skills

This must be stated plainly because it cuts against the whole premise. ⚠ *Second-hand from the parallel
sweep.* **SkillEvolBench** ([arXiv:2605.24117](https://arxiv.org/abs/2605.24117), 2026) is a benchmark built
specifically to test whether episodic experience converts into reusable skills, over 180 tasks, six
environments, ten model configurations and three harnesses. Its abstract:

> "we find that current agents often adapt locally but **rarely form robust reusable skills**… **Raw-trajectory
> reuse frequently outperforms distilled skills**, suggesting that current abstraction procedures discard
> contextual and procedural cues that remain useful for future tasks."

Two independent corroborations. Memp ([arXiv:2508.06433](https://arxiv.org/abs/2508.06433)) compares
granularities head to head and **verbatim trajectories beat abstracted scripts at every model** on ALFWorld
(GPT-4o test: Trajectory 74.29 vs Script 56.43; only the combination reaches 77.86); the authors' reading is
that "scripts are more capable of generalizing to different test tasks, while trajectories are better suited
for scenarios involving tasks similar to those already completed." And Synapse wins MiniWoB++ outright while
storing nothing but raw traces.

**Does this kill the Generate step? No — but it narrows what Generate is for, and the distinction is
load-bearing.** All of this evidence measures *whether an abstraction helps an LLM agent do the task better*.
Alfred's stated goal is different: **Reuse deterministically, with no LLM.** For that goal, retrieving a raw
trace is useless — a trace is not a program. So:

- If the objective is "the agent handles this class of request better/faster," the literature says **store
  the trace and retrieve it**, and that is a cheap, well-evidenced feature Alfred could ship first (it is
  effectively what `AWM`, `Synapse` and Memp's Trajectory mode do).
- If the objective is "remove the LLM from the steady state," you need a program, and then the evidence says
  you need either an execution oracle (Voyager/ASI/SkillWeaver/SkillDisCo) or multiple traces, plus a usage
  floor to prevent clutter (TroVE).

**Two objectives, two mechanisms. The PRD's ladder conflates them at rungs 2–3.** Rung 3
("deterministic prefilter/reducer or outer graph with agent judgment nodes") is the *program* objective;
"retrieve a prior similar run to steer the interpreted brief" is the *agent-help* objective, is far cheaper,
is not on the ladder at all, and is the better-evidenced of the two.

⚠ One more second-hand datapoint worth verifying because it is unusually sharp: the "Experience Compression
Spectrum" survey ([arXiv:2604.15877](https://arxiv.org/abs/2604.15877)) aggregates a claim that "curated L₂
skills help (+16.2 pp) while **LLM-self-generated skills provide no benefit (+0.0 pp)**," and reports a
<1% cross-citation rate between the agent-memory and skill-discovery literatures. If the first figure holds,
it is the strongest single argument for putting the user on the confirmation path rather than trusting
autonomous induction.

#### SkillDisCo and NSI (2026) — the field's own answer to the one-trace question

Two recent papers state the position explicitly.

**SkillDisCo** ([arXiv:2606.26669](https://arxiv.org/abs/2606.26669), Guo et al., 2026-06-25) formulates
"procedural skills as reusable parameterized control-flow subgraphs" of an unknown FSM transition graph,
distilled from successful traces and compiled into "callable, executable, and verifiable procedural
skills." Its stated support requirement is the direct answer to question (a):

> "a useful procedural skill should be supported by **multiple successful traces**, rather than being an
> incidental pattern that appears in only one execution."

No numeric threshold is given; the pipeline scores reusability as coverage across traces, normalizes by
"replac[ing] concrete entities with **typed variables** when possible," clusters by shared parameterized
control flow, then runs a "synthesis and verification loop": synthesize a Python program, check
"runtime correctness, postcondition satisfaction, and action savings" on a held-out set, retry up to R
times with feedback, and **discard** what still fails. Numbers: ALFWorld (CodeAct + GPT-4o) 96.3% →
99.3% success, 3.6 → 3.2 turns (−11.3%); WebArena (ReAct + GPT-4o) 23.9% → 29.1% (+21.6% relative), 5.9
→ 5.1 turns (−13.1%). Limitations, verbatim: "**Procedural tasks only.** … It offers no benefit for pure
NLP tasks"; "**Pipeline quality depends on model capability.** … Insufficient model capability yields
incorrect or **overly specific** skills"; "**Requires successful traces.** Only successful episodes
contribute distillation signal."

**NSI** (Neuro-Symbolic Skill Induction, [arXiv:2605.01293](https://arxiv.org/abs/2605.01293), ICML 2026)
attacks the whole family's artifact choice:

> "existing skill induction methods mitigate this by distilling experience into **state-blind
> parameterized scripts**, [but] they fail to capture the conditional logic required for robust
> execution in dynamic environments."
> …
> "These induced skills produce state-blindly actions, and thus struggle to faithfully represent the
> underlying execution logic. … [they] risk becoming brittle 'shortcuts' that fail when environmental
> change[s occur]."

NSI's demonstration counts are the most concrete published data point on question (a): "two standard
demonstrations per task type" (ALFWorld), "3 expert trajectories" (TextCraft), and "a single successful
purchase trajectory" (WebShop). Reported: ALFWorld 98.0±1.2 (vs ASI 70.6, AWM 91.3), WebShop 76.5±1.2,
TextCraft 95.2±0.8. No Limitations section.

**Synthesis of P0-2.** The distribution of demonstration counts in the primary literature is: AWM =
corpus; SkillDisCo = "multiple, more than one, threshold unstated"; NSI = 1–3 depending on domain;
ASI = 1 + live verification; SkillWeaver = 1 discovery + N self-generated practice runs. **Nobody
induces a trusted parameterized artifact from one trace without either additional traces or
re-execution.**

### P0-3. Alfred's trajectory normalizer cannot see data flow

`packages/ai/src/replay/trajectory.ts` produces `TrajectoryStep = {toolName, canonicalized input,
status, error}` plus `decidedNotExecuted`. Its docstring is explicit that it exists as "the regression
primitive for multi-step runs" — a *diff* primitive. As a compiler input it is missing three things the
reference implementations all consume:

1. **Tool results.** `workflow-use` feeds per-step `results` (`SimpleResult{success, extracted_content}`),
   AWM feeds `<think>` blocks and results, ASI feeds the full episode. Without results, a literal in
   step *n*'s arguments that equals a substring of step *n−1*'s output is indistinguishable from a
   user-supplied constant. Concretely: a run that does
   `gmail.search({q:"from:acme.com"}) → gmail.read_message({messageId:"18f2…"})` will,
   input-only, look like it has **two** candidate parameters, when `messageId` is a *bound* value that
   must never be surfaced to the user. This is not a corner case; it is the dominant shape of Alfred's
   multi-step tool runs.
2. **The user's request.** Every one of `workflow-use`'s prompts is templated on `{goal}` and the
   trace-based prompt says the goal is the primary signal for what to parameterize. The trajectory
   carries no intent.
3. **Ordering/looping evidence.** Repeated calls to the same tool with different arguments are the only
   in-trace evidence of a loop; `stepKey` collapses them into a multiset for diffing.

`decidedNotExecuted` is, by contrast, exactly the right guard to reuse: a non-empty
`decidedNotExecuted` means a gate diverted the run, so the trace is not a faithful program and must not
be compiled.

**Recommendation:** the Generate step needs a purpose-built recorder (or an extension of the tool spans
already emitted for #214) carrying `(toolName, input, resultDigest, resultPointer, boundFrom)` per step
plus the run's brief. Do not extend `trajectory.ts`'s contract — its narrow shape is what makes the diff
primitive trustworthy.

### P0-4. The variable-induction problem, stated honestly

#### It is formally underdetermined, and the classical literature says so precisely

The decision "is this literal a parameter or a constant?" cannot be derived from one observation. Three
independent formulations:

- **Mitchell's bias theorem.** [*The Need for Biases in Learning Generalizations*, CBM-TR-117, Rutgers
  1980](https://www.cs.cmu.edu/~tom/pubs/NeedForBias_1980.pdf) defines bias as "any basis for choosing one
  generalization over another, other than strict consistency with the observed training instances," and
  proves the consequence: "**An unbiased learning system's ability to classify new instances is no better
  than if it simply stored all the training instances and performed a lookup**… Unbiased generalization
  programs … cannot outperform programs that use rote learning." Note how exactly this predicts
  SkillEvolBench's 2026 finding that raw-trace retrieval beats distilled skills — an abstraction with no
  real bias *is* rote lookup with extra steps.
- **Anti-unification is defined for n ≥ 2.** The operation that computes "the least general generalization"
  — replacing mismatched sub-terms with variables — takes at least two objects by definition
  ([Cerna & Kutsia, *Anti-unification and Generalization: A Survey*, IJCAI 2023](https://arxiv.org/abs/2302.00277)).
  The least general generalization of a singleton is the singleton. **From one trace, the formally licensed
  number of parameters is zero.**
- **The empirical control case.** [Drain (He, Zhu, Zheng, Lyu, ICWS 2017)](https://jiemingzhu.github.io/pub/pjhe_icws2017.pdf)
  is a log parser whose entire job is deciding which substrings of a line are variables. Its rule: "If the
  two tokens are the same, we do not modify the token in that token position. Otherwise, we update the token
  in that token position by wildcard." And with one observation: "If Drain cannot find a suitable log group,
  it creates a new log group based on the current log message … and **log event is exactly the log
  message**." Zero wildcards.

And the cost of a *guarantee*: [SynGuar](https://arxiv.org/abs/2106.11610) (ESEC/FSE 2021), the only
sample-complexity work for programming-by-example, finds "often **a few hundred examples suffice** to
provably bound generalization error below 5% with high (≥98%) probability." Everything else in this
document operates four orders of magnitude below that. **Design for correction, not for correctness.**

#### FlashFill: the ambiguity is enormous and the resolution is an admitted hand-set bias

[Gulwani, POPL 2011](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/popl11-synthesis.pdf)
represents all consistent programs in an intersectable DAG and then *ranks* them. §5.3, verbatim, and this is
the load-bearing admission:

> "The Occam's razor principle … comes to our rescue here. We define a comparison scheme between different
> string expressions by defining a partial order between them. **Some of these choices are subjective, but
> have been observed to work well.** … **A `SubStr` constructor is simpler than both `ConstStr` constructor**
> (it is less likely for constant parts of an output string to also occur in the input) **and `Concatenate`
> constructor**…"

Generalized in [*Programming by Examples*, Marktoberdorf 2016](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/pbe16.pdf)
§8.1: "If the user provides an input-output example (i,o), then the PBE system … might generate a program
that is simply **the constant expression o**. A useful generalization can be enforced by having the ranking
scheme also **prefer non-constant expressions above constant expressions**." That sentence *is* the
parameter-vs-constant rule, and it is set by fiat.

The scale of the ambiguity is worth quoting because it calibrates how much a single trace under-determines:
[BlinkFill](https://www.vldb.org/pvldb/vol9/p816-singh.pdf) reports "more than 10⁶ different choices of
conforming logics" for one position;
[Mayer et al., UIST 2015](https://alexpolozov.com/papers/uist2015-disambiguation.pdf) "up to 10³⁰ ambiguous
programs"; [Ellis & Gulwani, IJCAI 2017](https://www.ijcai.org/Proceedings/2017/0227.pdf) "on the order of
10¹⁰⁰ distinct programs consistent with the examples."

Two numbers from this literature matter directly to Alfred:

- **A *learned* ranker is what makes one example work.** [Singh & Gulwani, CAV 2015](https://people.csail.mit.edu/rishabh/papers/cav15-ranking.pdf)
  reduced examples needed from 4.17 to 1.48 and learns the transformation "**from just one input-output
  example for 74% of the benchmarks**" — where the **hand-tuned baseline learned from one example for 0 of
  123 tasks**. Ellis & Gulwani's learned *output/execution* features (`IsYear`, `IsPersonName`) lift PROSE
  from 76.4% to 88.4%/83.5%. Interpretation for Alfred: the tractable form of one-shot induction is a
  *ranker over candidate parameterizations informed by data features*, not a single LLM judgement.
- **The product bar was set at one example, deliberately.** Ellis & Gulwani, verbatim: "**Microsoft refused
  to ship the recent PBE system Flash Fill until common scenarios were learned from only one example.**"
  So one-example induction is a legitimate product requirement — it is just achieved with ranking plus
  interaction, never with unaided inference.

**And interaction is measurably cheap.** Mayer et al.'s *Conversational Clarification* asks the user about
the **first output discrepancy** between the top-ranked program and its alternatives; "the number of
Conversational Clarification rounds **never exceeded 5**," and both disambiguation models "significantly
reduce the number of errors in the performed task **without any difference in completion time**." This is
the strongest available evidence that Alfred's confirm-at-activation card does not cost the user anything.

#### Web/GUI programming-by-demonstration: the three mechanisms that actually work from one demonstration

**SmallStar (Halbert, 1984)** named the problem and refused to guess
([*Watch What I Do*, ch. 5](https://www.acypher.com/wwid/Chapters/05SmallStar.html)):

> "A program that is recorded by demonstration … is therefore often **incompletely specified**. The user has
> chosen some data, but **the computation to make the choice … has been done in the user's head, and has not
> been communicated to the system.** … The system can guess what the user means, but it cannot be sure.
> **It cannot read the user's mind. Because of this, I chose not to use inference techniques to try to
> determine the user's intentions.**"

His resolution is the single most transplantable design decision in this whole document:

> "**There are no constants in a SmallStar program. Every data object has a corresponding data description.**
> Data descriptions are editable; the user may change them after recording the program. … **The system
> chooses a reasonable default description for the object. The choice is fixed, and does not change based on
> the example being given.**"

And note his rejected alternative, which is a direct caution against one of the recommendations below: "In an
earlier version of SmallStar, the user had to specify the choice **as the program was being recorded**. This
turned out to be **distracting and intrusive**."

Then three mechanisms that *do* decide from one demonstration, none of which use the type signature:

1. **Join the literal against a known data source.**
   [Koala (Little et al., CHI 2007)](https://acypher.com/Publications/koala-chi07.pdf): "**During script
   recording, if the user fills in a form with a value that appears in the database, that step is
   automatically generalized to refer to the named attribute, rather than the current user's literal
   value.**… Note that Koala also **includes a sample value as part of the step**, since we have found that
   specific examples help future users of the script understand the format." Decision rule: *a literal is a
   parameter iff it resolves to a named entity in a data source you own.* Zero examples, zero ambiguity, and
   the bias comes entirely from outside the trace. (CoScripter, CHI 2008, productizes the same mechanism plus
   a `you …` escape hatch handing a step back to the human. ⚠ the CoScripter PDF was not directly
   retrievable; treat its mechanism as inherited from Koala.)
2. **Align the literal to the user's request.**
   [SUGILITE (Li, Azaria, Myers, CHI 2017)](https://toby.li/files/TobyLi-CHI2017-Sugilite.pdf) opens by
   naming exactly the failure Alfred would otherwise walk into: "Other PBD systems … **require multiple
   examples with different values for the parameters** … Prior studies have shown that **end users often have
   a hard time giving meaningfully different examples**." Its mechanism: "**SUGILITE can automatically
   identify the parameters in the task and generalize the scripts from a single demonstration** … it
   **compares the identifying features of the target UI elements and the arguments of the operations against
   the verbal command, trying to identify the parameters by matching the words in the command.**"
   The controlling example — same demonstration, different correct parameterization, decided purely by the
   utterance: "if the user demonstrated ordering a venti Cappuccino with skim milk by saying '**order a
   Cappuccino**', we will discover that '**Cappuccino' is a parameter, but not 'venti' or 'skim milk'**.
   However, if the user … had used the command '**order a venti Cappuccino**,' then we would also consider
   the size … to be a parameter." **The request is the missing second example.**
   [PUMICE (UIST 2019)](https://toby.li/files/Li_Pumice_UIST19.pdf) states the principle: "**Demonstrations
   can clearly communicate *what* the user does, but not *why* the user does this and *how* the user wants to
   do this in different contexts.** … natural language instructions can often reflect the user's underlying
   intent (*why*) and preferences (*how*)." Its ask-trigger is a **typed hole**: the parser marks unknown
   parts with `resolve...()` functions and asks only there — "It asks, 'How do I tell whether it's hot?'
   **since it has already figured out that 'it's hot' should be a function that returns a Boolean value.**"
3. **Parse the string against a domain grammar, then decide over parsed nodes.**
   [Potter's Wheel (Raman & Hellerstein, VLDB 2001)](https://www.vldb.org/conf/2001/P381.pdf) §3.2 states
   Alfred's exact ambiguity — "**A given value will typically be parseable in terms of the default and
   user-defined domains in multiple ways.** For example, `March 17, 2000` can be parsed as … or as
   `[achrM] [17]; [20]`" — and resolves it with recall/precision/conciseness under MDL *plus* a
   user-supplied domain vocabulary: "**This last example highlights the importance of allowing user-defined
   domains in the alphabet from which we create the structure.**"
   [LAPIS / simultaneous editing (Miller & Myers, IUI 2002)](https://www.cs.cmu.edu/~rcm/papers/iui02/iui02.html)
   is the best result on intra-string generalization from ~one example — "**the average selection needed only
   1.26 examples, and 84% of selections needed only one**" — and it is due entirely to a structure library:
   "for a machine-learning agent, the library is **a collection of high-level, domain-specific concepts that
   would be difficult or impossible to learn otherwise**." ⚠ Honest caveat: that 84% depends on having many
   sibling records to preprocess; it is one *selection*, not one *string*.

**Rousillon is the strongest one-demonstration prior art, and it does substring parameterization.**
[Chasins, Mueller, Bodik, UIST 2018](https://schasins.com/assets/papers/rousillon.pdf) asks the user to
"demonstrate how to collect the first row of a 'universal table'," and states its own generalizable
principle: "**ask the user to demonstrate one iteration of each nested loop** … and use domain-specific
insights to identify objects that should be handled together." Three transferable moves:

- **It manufactures the missing second observation from environment structure**: "**prior relation extractor
  techniques often required at least two rows of data as input.** … The key insight is to **fingerprint the
  structure of the input cells' deepest common ancestor (DCA), then find a sibling of the DCA that shares the
  structure fingerprint** … **Using the sibling node as a second row of labeled cells, we can apply the same
  techniques that drive prior relation extractors.**"
- **Parameterization is a join against relation cells, including inside strings**: "We repeat this process
  **for typed strings, for each type statement in a loop (checking whether the typed string *includes the
  text* of any relation node)**." That is intra-string parameterization, decided by "does this substring
  occur as data somewhere in the environment?"
- **Preview instead of interrogation**: "Rousillon's output program will always produce the previewed row of
  data as its first output row … **If at any point the user realizes that the preview does not show the
  intended data, they can identify without running the program — without even finishing the demonstration —
  that the current demonstration will not produce the desired program.**"

And [Ringer (Barman, Chasins, Bodik, Gulwani, OOPSLA 2016)](https://schasins.com/assets/papers/ringer.pdf)
supplies the architectural lesson: it deliberately ships **faithful replay only**, exposing parameterization
as an API for higher layers — "Our API lets programmers parametrize a script to interact with different
nodes, to type a different string, and to open a different URL" — and concedes "The similarity-based node
addressing approach is **inherently best-effort. We obtain no theoretical guarantees**." **Separate faithful
replay from generalization into two artifacts.**

#### LLM tool synthesis: every method decides by prompt sentence, and only one verifies parameterization

- **[LATM](https://arxiv.org/abs/2305.17126)** (ICLR 2024) explicitly invokes Halbert: "This process follows
  the 'programming by example' (PbE) paradigm (Halbert, 1984)… **In our experiments, we use 3 demonstrations
  for this stage**," plus "**3 validation samples**" and ≤3 retries. There is **no parameter guidance at
  all** — the whole instruction is "Please write a **generic** Python function to solve this type of
  problems." Parameterization is a side-effect of the word *generic* and of having to fit three demos. And
  its repair loop cannot fix a mis-parameterization: it corrects "the function calls in the unit test part
  and **will not correct the function**."
- **[CRAFT](https://arxiv.org/abs/2309.17428)** (ICLR 2024) has the most principled rule in the LLM branch,
  and it is a *syntactic position* declared to always be a parameter: "instructing GPT-4 to replace all
  specific variable names with general ones … and **wrap textual inputs of internal function calls as
  arguments of the tool** (e.g., `date = df["date"]` → `date = df[column_name]`)," with the prompt rule
  "**All columns names used inside the tool should be passed in as arguments**." The abstraction step is
  load-bearing: removing it costs GQA SAcc 45.4 → 37.1. Note it abstracts from **one** (query, solution) pair
  — there is no second example to diff against — and validates only by re-solving *the original problem*.
- **[TroVE](https://arxiv.org/abs/2401.12869)** (ICML 2024) says nothing about parameters ("create Python
  functions … if you believe the function can be reused") and verifies by execution self-consistency. Its
  reported wins are "79–98% smaller toolboxes" and "31% faster and 13% more accurate human verification."
  ⚠ **Important correction to the headline:** a compute-matched re-evaluation
  ([arXiv:2507.22069](https://arxiv.org/abs/2507.22069)) finds "**After matching for compute, the benefit of
  TroVE reduces to a marginal improvement of 1%**," and that the tools created "are often trivial or rarely
  reused." Cite TroVE for its *trimming rule*, not for its accuracy delta.
- **[CREATOR](https://arxiv.org/abs/2305.14318)**'s criterion is "numbers become parameters" — a tool for
  three-variable equations "**disregarding all the numerical details**."
  **[LEGO-Prover](https://arxiv.org/abs/2310.00656)** has the only explicit `Parameterize` operator ("**If
  the problem involves specific numbers, generalize it by replacing these with variables**") — verified by
  Isabelle, and honest about yield: parameterization-derived skills "constitute **6%**" of applied skills.
  **[ReGAL](https://arxiv.org/abs/2401.16467)** (ICML 2024) requires a batch — "the refactoring LLM requires
  a **multi-instance scope**" — and its real parameterization signal is *falsification by a sibling*: "a
  function like `draw_triangle()` might start with a **hardcoded value for a small size, leading it to fail
  on medium triangles**," repaired with "you can add parameters instead of hardcoded values."
- **The principled criterion, when you have variance, is compression.** DreamCoder
  ([arXiv:2006.08381](https://arxiv.org/abs/2006.08381)) — "**Ease of expression translates into a preference
  for libraries that best compress programs found during waking**" — and Stitch
  ([arXiv:2211.16605](https://arxiv.org/abs/2211.16605), POPL 2023), which names the trade-off exactly:
  "**maximize the product of the size of the abstraction and the number of locations where the abstraction can
  be used** … general enough that it applies in many locations, but specific enough that it captures a lot of
  structure at each location," with **arity explicitly penalized** (`cost_app · arity(A)`). **Operational
  upshot: a parameter must be paid for. Absent variance across match sites, the compressive optimum keeps the
  literal a constant.** This is the formal justification for defaulting to `constant` and making the user
  promote.
- **The honest state of the art in the agent branch is a prompt adverb.** An online web-agent skill learner
  ([arXiv:2606.04391](https://arxiv.org/html/2606.04391v1)) instructs: "**variable parts (search queries,
  usernames, element ids that *obviously vary* across tasks) become function arguments with descriptive
  names.** Windows that depend on one-off element ids or task-specific text that cannot be parameterized are
  NOT reusable." *Obviously vary.* And MIND-Skill
  ([arXiv:2605.08670](https://arxiv.org/html/2605.08670)) states the dilemma without resolving it: "**The core
  challenge is controlling the level of abstraction. An over-specific skill that retains instance-level
  details … fails to generalize across task variations. Conversely, an over-abstract skill … provides no
  procedural guidance beyond the task specification itself**," then concedes its own taxonomy "**serves as the
  primary inductive bias**."
- **Two closed-vocabulary exceptions worth copying.** NSI
  ([arXiv:2605.01293](https://arxiv.org/html/2605.01293v1)) constrains lifting to a fixed type list —
  "**Allowed parameter types (choose only from): ReceptacleName, ItemName, ReceptacleType, ItemType,
  List_T**" — and grounds its skill in MDL; it claims single-trace induction only for *branching*, never for
  parameterization. SkillDisCo's artifact is precisely the one Alfred wants — "a signature, including an
  action-oriented skill name, **typed parameters with default values**, and a structured return type …
  preconditions, postconditions, and declared side effects" — but gated on cross-trace support: "a procedural
  skill is a reusable PFSM subgraph **matched across traces under parameter binding**."
- **Only SkillWeaver verifies the parameterization itself, and both its guards are free.** (a) A liveness
  check: "**Warning: Unused parameter 'color' → identify_pill(page, imprint, color). The parameter 'color' is
  defined but never used in the function body.**" (b) Counterfactual execution: "For APIs requiring
  additional parameters, we **leverage the LLM to generate appropriate parameter values that serve as
  comprehensive test cases**" — i.e. run the tool with a *different* value than the one it was induced from.
  **LATM (re-solve unit tests), CRAFT (re-solve the original problem), TroVE (answer agreement) and ASI
  (replay the recorded instantiation) all pass a tool that hard-codes what should have been a parameter.**

#### The gap: nobody uses the callee's declared schema as the prior

Searched and not found: no primary source uses the **callee's declared parameter schema** — JSON Schema /
OpenAPI types, `enum`, `format`, `required`, defaults — as the prior over which trace literals are
parameters. The nearest neighbours solve adjacent problems: `Contract2Tool`
([arXiv:2606.07904](https://arxiv.org/abs/2606.07904)) infers pre/postconditions from "metadata, schemas,
documentation, and execution traces"; latent-preference modelling for tool calling
([arXiv:2604.17886](https://arxiv.org/abs/2604.17886)) infers *values* for under-specified arguments. **This
is genuinely unclaimed territory, and it is exactly the axis Alfred is well positioned on** — position it
against NSI's closed type vocabulary and SkillDisCo's typed signatures. ⚠ Absence of evidence from a search
is weaker than a positive citation; treat this as "not found," not "does not exist."

#### The hard case, answered

**Typing narrows the codomain, not the decision.** Alfred's `gmail.search` input is, in
`packages/contracts/src/tool-schemas.ts`:

```ts
q: z.string().min(1).max(GMAIL_SEARCH_QUERY_MAX_CHARS).describe(
  "Gmail search query. Supports the full Gmail operator set (in:, from:, has:, …). " +
  "For recency, prefer Gmail's relative operators (newer_than:3d, older_than:1w) …")
```

Given a recorded `q: "from:acme.com after:2026/07/01"`, the schema licenses exactly one conclusion: the
whole field is a string of bounded length. It cannot say that `acme.com` is the user's variable, that
`after:2026/07/01` is a date that must be *recomputed* per occurrence, or that `in:inbox` would be a
constant. `workflow-use`, the only system that ships whole-field induction over exactly this shape,
declines substrings entirely (`step_dict[key] == old_value`). SkillWeaver's parameters are *whole*
arguments to a Playwright call. ASI's are *whole* arguments to a browser action. **No source in the
LLM-agent literature performs intra-string parameterization from a trace** — and a targeted search for
"substring parameterization / query template induction from agent traces" found nothing.

**But the pre-LLM literature solved it three times, and all three transfer to Alfred.** For the recorded
`q: "from:acme.com after:2026/07/01"`:

1. **Align to the user's request (SUGILITE).** If the user said "emails from Acme this month," `acme.com`
   aligns to the utterance and becomes a parameter while `after:2026/07/01` is agent-invented scaffolding
   and stays constant. If they said "Acme mail since July 1st," both align and you get two. SUGILITE's
   venti/Cappuccino case proves the same trace yields different, correct parameterizations depending on the
   request. **Alfred has the user turn for free and nothing in the tool-induction line exploits it.**
2. **Join against your own entity store (Koala, Rousillon).** `acme.com` resolves to an organization/contact
   Alfred already models; `2026/07/01` does not. Rousillon does this *inside* strings, "checking whether the
   typed string **includes the text** of any relation node." Rule: **a substring is a parameter if it
   resolves to a first-class entity Alfred owns.** Alfred's identity-facts and entity-canonicalization layer
   is exactly this data source.
3. **Parse against the documented grammar first (Potter's Wheel, LAPIS).** Gmail's `q` is not an opaque
   string — the API says it "**Supports the same query format as the Gmail search box**"
   ([users.messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list))
   with an enumerated operator set ([support.google.com/mail/answer/7190](https://support.google.com/mail/answer/7190)).
   Parse `q` into `(operator, value)` pairs and the intra-string problem **collapses into the whole-argument
   problem the literature does solve** — and typing then genuinely helps, because `after:` takes a date and
   `from:` takes an address or domain. The same applies to GitHub search qualifiers, Notion filters, and
   Linear queries.

**And there is a hard calibration number against letting the model do the segmentation.**
[*Log Parsing: How Far Can ChatGPT Go?* (Le & Zhang, ASE 2023 NIER, arXiv:2306.01590)](https://arxiv.org/abs/2306.01590)
is the closest measured analogue — abstract the variables in *one* string. Zero-shot the LLM beats Drain on
token-level variable identification (MLA 0.543 vs 0.385) but loses on grouping accuracy (0.721 vs 0.844), and
the documented dominant failure is exactly the risk here: it "**cannot recognize the whole address of
`video.5054399.com:80` as one variable**." With one in-context example, MLA improves 19.5%; four examples is
best on all 16 datasets. **Translation: a bare LLM asked to lift substrings out of
`"from:acme.com after:2026/07/01"` will get the boundaries wrong often enough to silently corrupt the
template. Parse the DSL first, then choose over parsed nodes.**

If Alfred ever accumulates multiple calls to the same tool, the semi-supervised pattern is
[BlinkFill](https://www.vldb.org/pvldb/vol9/p816-singh.pdf): exploit *unlabeled* sibling inputs you already
have, and prefer "token sequences that have larger contexts around them in input data." That takes 1.53 → 1.27
examples in its domain. Alfred's Langfuse tool spans are exactly that corpus.

**The substrate advantage, measured.** *My line counts over the pinned `workflow-use` tree:* the modules
whose entire job is **element identity** — `healing/selector_generator.py` (630),
`healing/xpath_optimizer.py` (389), `workflow/element_finder.py` (609),
`workflow/semantic_executor.py` (**3,229**, the largest module in the project), and
`recorder/semantic_converter.py` (310) — total **5,167 lines**. The modules whose job is
**variable induction** — `healing/variable_extractor.py` (293), `workflow/variable_identifier.py` (527),
`healing/variable_utils.py` (194) — total **1,014 lines**. A 5:1 ratio, and the identity half is the part
that is still unsolved (the project's own README warns against production use, and the selector work is
what the [tightening doc](./compiled-browser-flows-v1-tightening.md) already picked apart). **On a typed
tool substrate that 5,167 lines is zero: `gmail.search` is `gmail.search`.** That is the honest, measurable
form of "the tool substrate is easier."

The corollary is sharper than the headline. `workflow-use`'s prompt says: "**NEVER modify, parameterize, or
guess element hashes** — they are unique identifiers (not variables)" and "If you think a step has a
variable on the `elementHash` field, **use `agent` step**." So on a DOM substrate, *a variable identity
forces an LLM node*. A typed tool substrate spends none of its parameterization budget on identity, which
means every parameter it does induce is a **data** parameter — the kind users actually care about.

**Typing does buy three real things**, and Alfred should collect all three:

1. A **candidate enumeration** that is exhaustive and finite. Every literal in a tool call sits at a
   known JSON path with a known type — no segmentation problem, unlike a DOM action where the compiler
   must first decide *what part of the interaction* is even a value (`workflow-use` had to invent
   `target_text`, `container_hint`, `position_hint`, `selectorStrategies` before it could talk about
   values at all).
2. A **validity check on a proposal.** A proposed parameter must re-validate against the owning Zod
   schema at every substitution. Enum/`Literal` fields are decidable: a parameter whose type is a Zod
   enum is safe to expose because the substitution space is closed. This is the one place where the
   typed substrate genuinely *resolves* rather than narrows.
3. A **refusal rule.** SkillWeaver's "we will check your code for such parameters" rule generalizes
   cleanly: an opaque-identifier field (`messageId`, `threadId`, `eventId`, `installationId`,
   `documentId`, `pageToken`) must **never** become a user-facing parameter. Alfred can enforce this
   deterministically from the schema and from `boundFrom` provenance, not by prompt.

**A third bucket the literature does not model: `recompute_per_run`.** Alfred's own tool description
already encodes the domain fact — prefer `newer_than:3d` to an absolute `after:` date, because Gmail
resolves it server-side. A recorded absolute date is therefore neither a parameter nor a constant: it is
a *stale* literal whose correct compilation is a relative expression. This class covers dates,
`"today"`, week boundaries, and any `authoredAt`-derived filter. Every trace of a scheduled workflow
will contain them, and both "parameterize it" and "freeze it" are wrong. A two-bucket
(parameter/constant) compiler will therefore silently produce a workflow that queries July 2026 forever.
*This is my inference from Alfred's schema semantics, not a sourced claim — but it is falsifiable: compile
any dated Gmail/Calendar/GitHub trace and check the second occurrence.*

**Where a tool substrate is strictly harder than DOM.** ASI's verification and SkillWeaver's practice
loop both assume re-execution is free and reversible. On a browser fixture it nearly is. On Alfred's
tool surface, `gmail.send_draft` is `riskTier: 'high'`, `github.*` writes are real, and there is no
staging environment. So:

- read-only tools (`gmail.search`, `calendar.list_events`, `github.list_*`, `notion.search`) can be
  verified by replay, and Alfred already has the diff primitive to do it;
- write tools cannot, and no amount of typing changes that.

That asymmetry, not the DOM/tool distinction, should set v1's scope.

---

## P1 — commercial framing: is trace-based generation actually shipped?

**Answer: NL-to-workflow is the norm. Trace-based generation ships in three narrow pockets, and every
shipped system that uses a trace pairs it with natural language rather than inferring parameters from the
trace alone.** The one fully uniform finding across every product surveyed is that the generated artifact
is user-editable.

### The mainstream workflow-automation products are all NL-only

- **Zapier.** Copilot builds from text: "Describe the workflow you want, and Zapier Copilot will create a
  basic outline of a trigger and one or more actions"
  ([help](https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows)).
  Decisively, Zapier's own inventory of every AI feature in the product
  ([Use of AI within Zapier](https://help.zapier.com/hc/en-us/articles/26583719914381-Use-of-AI-within-Zapier))
  lists eight features and **not one takes run history, a recording, or observed behaviour as input**; the
  closest is AI troubleshooting, which reads a *failed run's error* to suggest a fix. Output is editable
  and Copilot can edit published Zaps.
- **n8n.** The [AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder)
  takes "natural language descriptions of your goals" and emits a normal, editable workflow — i.e. plain
  JSON you can export/import ([export and import](https://docs.n8n.io/build/manage-workflows/export-and-import)).
  The strongest single data point in the whole survey is n8n's own data-handling table: sent to the LLM are
  prompts, node definitions, the current workflow, and "any **mock** execution data"; **not** sent are
  credentials and "**past executions of the workflow**." The builder is deliberately walled off from the
  real execution trace. Shipped 1.115.0 (2025-10-06) per the
  [changelog](https://docs.n8n.io/changelog/release-notes-1.x/).
- **Gumloop.** ⚠️ Flow generation is **absent from the docs entirely** — [docs.gumloop.com](https://docs.gumloop.com/llms.txt)
  describes manual canvas assembly; the only documented AI authoring is narrower than a flow
  ([AI trigger creation](https://docs.gumloop.com/core-concepts/ai_trigger_creation),
  [Agent Skills](https://docs.gumloop.com/core-concepts/skills) created via an interview). Gummie is
  documented only on the [vendor blog](https://www.gumloop.com/blog/gummie-agent) — prompt in, node graph
  out. No recording path anywhere.
- **Lindy.** ⚠️ NL *workflow* generation is not in the docs either; documented creation is templates or a
  blank canvas ([Create a Workflow](https://docs.lindy.ai/fundamentals/lindy-101/create-agent)), with NL at
  *field* level ("AI Prompt" field mode,
  [Field Configuration](https://docs.lindy.ai/fundamentals/lindy-101/fields)). The "describe it and Lindy
  builds it" claim is marketing-page only. No recording path.

### Where trace-based generation genuinely ships

1. **Skyvern** — the only pure-play product where recording is a first-class creation path. Three creation
   methods, two non-NL: Blank Agent, "**Record Browser** — record actions in a live browser to generate
   blocks," and "**Upload SOP** — upload a PDF procedure to auto-generate an agent"
   ([workflows intro](https://www.skyvern.com/docs/workflows/introduction)). Parameters are introduced
   **manually** via a Parameters button and referenced with Jinja `{{search_query}}`
   ([core concepts](https://www.skyvern.com/docs/developers/getting-started/core-concepts)). It also ships
   real trace→code caching: `run_with` is "Force execution mode: `\"code\"` (use cached Playwright code) or
   `\"agent\"` (use AI)" with `ai_fallback=True`
   ([SDK reference](https://www.skyvern.com/docs/sdk-reference/workflows/run-workflow)) — the closest
   commercial analogue of Alfred's "Reuse deterministically, fall back to the agent" idea. ⚠️ The docs
   confirm the recorder and the cached-code switch exist; the claim that the cached code is *derived from
   prior AI runs* appears only on Skyvern's marketing/blog pages.
2. **Power Automate "Record with Copilot"** — the most ambitious demonstration-to-flow feature shipped, and
   the most instructive. It "captures your voice, mouse, and keyboard inputs" and converts them into a
   desktop flow you "review, edit, and save"
   ([docs](https://learn.microsoft.com/en-us/power-automate/desktop-flows/create-flow-using-ai-recorder)).
   Microsoft draws the generalization line itself: the plain **Recorder** "creates a desktop flow that
   repeats those actions. However, it doesn't capture logic such as conditions or loops," whereas Record
   with Copilot "interprets your actions **and narration**" and suggests an automation that "includes
   conditions, loops, and necessary interactions." And the constraint that matters most here: "**If you
   don't provide narration, it doesn't generate an automation**," and "just talking over a screen without
   any mouse or keyboard interaction doesn't produce an automation suggestion." It is *trace + NL*, and
   neither alone suffices. **Status signal: still labeled preview as of the doc's 2026-04-09 revision,
   with an `ai-seo-date` of 2024-08-23, absent from both the
   [2025 wave 2](https://learn.microsoft.com/en-us/power-platform/release-plan/2025wave2/power-automate/planned-features)
   and [2026 wave 1](https://learn.microsoft.com/en-us/power-platform/release-plan/2026wave1/power-automate/planned-features)
   release plans, and the doc now opens by steering readers toward other features.** Read that as ~2 years
   in preview and de-emphasized.
3. **First-party AI vendors**, all within roughly a year of each other and all desktop-gated. Anthropic:
   "Instead of writing a skill by hand, you can record yourself doing a task and let Claude build the skill
   from what it observes… Claude proposes a skill for you to review" (Cowork in Claude for Mac, ~10-minute
   cap, narration recommended —
   [creating custom skills](https://support.claude.com/en/articles/12512198-creating-custom-skills)).
   OpenAI: "Record & Replay lets you demonstrate a workflow on your Mac and turn it into a reusable
   skill… [it] inspects the captured workflow and drafts a skill"
   ([Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay.md)). Google: ⚠️ Project
   Mariner's "Demo a task" is indexed with a full recording → editable step list → saved re-runnable task
   flow at [support.google.com/labs/answer/16270604](https://support.google.com/labs/answer/16270604) but
   the article body could not be retrieved directly; treat as unconfirmed.

### The two facts that should shape Alfred's v1

**(i) Every shipped system asks the human which values vary. None infers it.** OpenAI's instruction is the
cleanest statement of the pattern, and it is *pre*-recording: "State your goal and **any specific inputs
that might vary between skill uses** *before* you start recording"
([Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay.md)). Power Automate Desktop's
release-plan item that introduced recorder variables is even more explicit about the default:

> "Currently, you can populate a text field in a screen only by inserting **specific (static) text**. In
> order to set a dynamic value for a field, the user must **manually update the action in the designer
> after the recording completes**. With this new feature, you can **indicate** that the specific text
> field should be populated dynamically…"
> ([release plan, GA 2021-03-14](https://learn.microsoft.com/en-us/previous-versions/power-platform-release-plan/2020wave2/power-automate/use-variables-within-desktop-web-recorder-as-input-output-parameters))

Twenty-plus years of RPA recorders, and **no vendor claims automatic parameter inference from a trace.**
Where automatic parameterization *is* claimed — Automation Anywhere's Co-Pilot for Automators
"automatically generates variables for all mandatory attributes"
([docs](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/cp-automators-ov.html)) — the
input is a **prompt**, not a trace. Chrome DevTools Recorder and Playwright `codegen` are the honest
baselines: both record literals and both require hand-editing to generalize
([Recorder](https://developer.chrome.com/docs/devtools/recorder),
[codegen](https://playwright.dev/docs/codegen-intro)).

Note also that Automation Anywhere's Process Discovery pipeline **launders the trace into prose before the
AI sees it**: recordings become a Process Definition Document, Autopilot then "transforms **a description**
of a business process into usable automation code," and produces an *outline* a developer finishes
([Autopilot](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/autopilot.html),
[PD workflow](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/aup-workflow-pd-coem.html)).
Discovery Bot, the original recording product, is
[end-of-life](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/discovery-bot-eol-faq.html).
⚠️ UiPath and Automation Anywhere doc strings are search-index-sourced; both sites block or JS-render
against direct fetch.

**(ii) The two composition patterns are opposite, and choosing one is a real decision.** *Trace as
skeleton, human adds logic*: UiPath Task Capture exports "a **XAML robot prototype**" / "workflow
template … as a **skeleton**"
([export to Studio](https://docs.uipath.com/task-capture/standalone/2022.4/user-guide/export-uipath-studio)).
Versus *NL as skeleton, trace fills the grounded holes* — Microsoft's own admission, in shipping product:

> "**If Copilot identifies an intention to automate browser or UI tasks, it inserts an action
> placeholder.** This placeholder serves as a starting point for you to initiate the recorder and capture
> the user actions. After you complete this step, the action placeholder is automatically replaced with the
> actions created by the recorder."
> "The recording action **produces a design time error**. This is to remind you that a significant part of
> the flow is still missing."
> ([Copilot in Power Automate for desktop](https://learn.microsoft.com/en-us/power-automate/desktop-flows/copilot-in-power-automate-for-desktop))

**For Alfred, the second pattern is the better fit and is the one the PRD already half-implements.** The
brief *is* the NL skeleton; the trace's job is to ground the steps the brief cannot pin down (which tool,
which account, which resource, which query). That reframing matters: the Generate step is not "turn a trace
into a program," it is "use a trace to make an already-approved brief concrete." Alfred's `authoring_proposal`
and `required_capabilities` fields are exactly the holes to fill.

Also relevant, and closest to home: Claude Code ships **agent's-own-run → artifact** in two places —
`/run-skill-generator`, which "captures what worked (the install commands, the env vars, the launch script),
and commits it as a per-project skill," and `/workflows`, where after a run "you can save **that run's
script** as a command," thereafter runnable as `/<name>` with arguments
([workflows](https://code.claude.com/docs/en/workflows)). Note the shape: what is promoted is *the script a
specific successful run executed*, and arguments are declared, not inferred.

Two negatives worth recording. **Process/task mining does not generate flows** — task mining yields process
maps and analytics, and its "automation recommendation" is connector suggestions you then assemble by hand
([Identify automation opportunities](https://learn.microsoft.com/en-us/power-automate/process-advisor-automation)).
And Google, which ships by far the richest agent-trace observability — span DAGs with inputs/outputs, replay
against past sessions ([Agent Engine tracing](https://docs.cloud.google.com/agent-builder/agent-engine/manage/tracing))
— has **no documented path from a trace to a workflow**. Traces are diagnostics. That is a warning about
assuming trace→program is a natural next step just because the traces exist.

⚠️ Unverifiable from first-party sources: Browserbase Director's "mirrors the successful run" claim
(the [blog](https://www.browserbase.com/blog/introducing-director) confirms prompt→Stagehand script and
that the result "isn't the final version"; the changelog fetched empty); Skyvern's cached-code provenance;
Gumloop and Lindy NL generation (marketing/blog only); Make.com prompt-to-scenario; OpenAI Tasks/agent/
Operator (403-blocked). OpenAI's manual **Agent Builder** canvas is
[scheduled to shut down 2026-11-30](https://developers.openai.com/api/docs/guides/agent-builder).

---

## P1 — durable execution: what the engines demand of a stored program artifact

### The axis that decides JSON-vs-code: positional versus nominal memo keys

Every engine memoizes completed work and replays the rest. They split cleanly on **what the memo is keyed
by**, and that single property determines whether a data artifact is easier or harder than generated code.

| Engine | Memo/replay key | Mismatch behaviour | Run pinned to code version? | Program is… |
|---|---|---|---|---|
| **Temporal** | Ordinal position in the Command sequence + op type + name/ID | Workflow **Task** failure, retries indefinitely; the Execution survives | Opt-in per Workflow type (`Pinned` / `Auto-Upgrade`); unversioned by default | Code; version = `(deployment name, Build ID)` |
| **LangGraph** | Node **name** + state schema; edge topology *not persisted* | Fails only if a paused node's name is gone; otherwise the latest graph applies | **No** — "applies the latest graph immediately to *every* thread" | Code for topology; **data for config** (versioned Assistants) |
| **Inngest** | `SHA1(stepId[:n])`, a developer-supplied string | **Warning**, degrades to order-insensitive earliest-match | **No** — runs on all connected workers "regardless of the version" | Code; version deliberately absent |
| **Restate** | Positional journal entry | Hard error `RT0016` | **Yes** — immutable deployment endpoint | Code; version = endpoint URL/ARN |
| **DBOS** | Positional row in `operation_outputs` | Hard error `DBOSUnexpectedStepError`; cross-version recovery refused | **Yes** | Code; version = **hash of workflow source** (overridable) |
| **Cloudflare Workflows** | Step **name** as "cache key" | Not documented | Not documented | Code; runtime-loaded code via Dynamic Workflows |

### Temporal: determinism is over emitted commands, and its own AI integration already declares nondeterminism per node

[Workflow Definition → Deterministic constraints](https://docs.temporal.io/workflow-definition) states the
rule and, importantly, defines it over Commands rather than program text:

> "you must take care to ensure that any time your Workflow code is executed it makes the same Workflow API
> calls in the same sequence, given the same input."
> …
> "When this API is called upon re-execution, that Command is compared with the Event that is in the **same
> location within the sequence**. … If a generated Command doesn't match what it needs to in the existing
> Event History, then the Workflow Execution returns a *non-deterministic* error."

The prohibited set is enumerated — timers, activity scheduling (including **local** activities), child
workflows, external signals, Nexus operations, workflow completion, `Patched`/`GetVersion` calls, search
attributes, memos, and `SideEffect`/`MutableSideEffect`. The **safe** list is what matters for a stored
artifact: "The input parameters, return values, and execution timeouts of Child Workflows and Activities —
However, it is **not** safe to change the **types or IDs**." So: payloads are free, identity and ordering are
not.

Temporal's first-party LLM guidance is unambiguous:

> "Workflow code must be deterministic to support replay. To handle non-deterministic operations like API
> calls, **LLM/AI invocations**, database queries, and other external interactions, put them in Activities."
> ([workflow-definition](https://docs.temporal.io/workflow-definition))

And the single strongest external endorsement of Alfred's intended model is Temporal's own
[LangGraph integration](https://docs.temporal.io/develop/python/integrations/langgraph), which implements
"mostly-deterministic graph with a few declared nondeterministic nodes" as a **mandatory, non-defaultable,
per-node field**:

> "Every graph node and `@task` **must** specify `execute_in` — set it to `\"activity\"` to run as a Temporal
> Activity, or `\"workflow\"` to run directly inside the Workflow."
> "`execute_in` must be set per node or task; it **cannot** be set in `default_activity_options`."
> "A node running in the Workflow **must not** make network calls, use `random`, read the system clock, or do
> file I/O."

That is a schema field in everything but name. Temporal also strips LangGraph's own persistence when
composed this way ("use `InMemorySaver`. Temporal handles durability"), which is a useful warning against
stacking two checkpointers.

Side-effect primitives and their caveats, all first-party: `SideEffect` "does not re-execute during a
Replay… returns the recorded result," must not fail ("An exception … causes failure and retry of the current
Workflow Task"), and "You shouldn't modify the Workflow state inside a Side Effect function"
([side effects](https://docs.temporal.io/develop/go/side-effects)). `MutableSideEffect` only records a
marker "if the value … changes or is set the first time." **Local Activities are not a home for an LLM
call**: "A Local Activity result becomes durable only when the enclosing Workflow Task successfully
completes," they are at-least-once and "should always be idempotent," "Signals and other external Workflow
events are **not processed** until the Local Activities finish," and they "do not support Activity
heartbeats" ([local activity](https://docs.temporal.io/local-activity)).

Versioning: the [patching API](https://docs.temporal.io/develop/typescript/versioning) inserts a marker into
the Event History (`patched`), and `deprecatePatch` "also adds a marker … but this marker won't cause a
replay failure when the Workflow code doesn't produce it." Temporal now recommends
[Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
instead — "We strongly recommend using Worker Versioning as users see improved error rates"
([safe deployments](https://docs.temporal.io/develop/safe-deployments)) — where a Version is a
`(deployment name, Build ID)` pair and a Workflow type is either **Pinned** ("guaranteed to complete on a
single Worker Deployment Version") or **Auto-Upgrade** ("need to be kept replay-safe manually, i.e. with
patching").

The failure mode is forgiving, which matters for a versioned interpreter: "Non-deterministic failures do
**not** fail the Workflow Execution by default. A non-deterministic failure is considered a Workflow Task
Failure which is considered a transient failure, meaning it retries over and over"
([event history](https://docs.temporal.io/encyclopedia/event-history/event-history-go)). A bad interpreter
deploy wedges runs recoverably; it does not destroy them. The prescribed safeguard is replay testing against
stored histories.

⚠️ Temporal ships [Dynamic Handlers](https://docs.temporal.io/dynamic-handler) — the mechanism a data
interpreter needs — but discourages them ("used judiciously as a fallback mechanism rather than the primary
approach") and **documents nothing about their determinism or versioning implications**. There is no
first-party Temporal guidance on program-as-data. Do not claim Temporal blesses or forbids it.

### LangGraph: the only engine with a first-party *versioned data artifact*, and it draws the boundary exactly at Alfred's question

[Backward compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility) is the most
design-relevant page found:

> "Unlike workflow engines that pin a run to the version of code it started with, LangGraph applies the
> latest graph immediately to *every* thread… This is convenient: bug fixes propagate to in-flight
> conversations and agents without ceremony. It also means you must reason about how each change interacts
> with runs that started under the previous version of the code."
> …
> "When a thread resumes, LangGraph deserializes the saved state, dispatches it to a node **by name**…"
> "**Edge topology itself is *not* persisted in the checkpoint.** Adding, removing, or rerouting edges
> between nodes that still exist is safe for in-flight threads. … the only topology change that can break an
> interrupted thread is **renaming or removing a node**."

Breakage list: renaming/removing a node while a thread is paused at it; renaming/removing a state key; and
"**Tightening a State field**, such as making an `Optional` field required, narrowing a type, or adding a new
required field with no default." The migration matrix is explicit: for non-interrupted threads "you can
change the entire topology"; for interrupted threads "we support all topology changes other than renaming /
removing nodes"; "State keys that are renamed lose their saved state"
([graph migrations](https://docs.langchain.com/oss/python/langgraph/graph-api)).

The `interrupt()` re-execution hazard is the one operational trap Alfred must design around, because
Alfred's activation/approval model is built on human-in-the-loop pauses
([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)):

> "the runtime restarts the **entire node from the beginning** — it does not resume from the exact line where
> `interrupt` was called. This means any code that ran before the `interrupt` will execute again."
> "**Side effects called before `interrupt` must be idempotent.** … you might have an API call to update a
> record inside of a node. If `interrupt` is called after that call is made, it will be re-run multiple times
> when the node is resumed, potentially overwriting the initial update or creating duplicate records."
> "Matching is **strictly index-based**, so the order of interrupt calls within the node is important."
> "**Avoid `while True` + `interrupt()` loops inside a single node.** … The result is **exponential**
> re-execution of any code inside the loop body."

Prescribed remedies: idempotent operations before `interrupt`, side effects after `interrupt`, or separate
side effects into separate nodes. **Alfred's PRD already has the right instinct here** — approval staging is
a separate dispatcher boundary with a stable `effect_key`, not code inline before a pause.

Durability is a three-valued knob (`Durability = Literal["sync","async","exit"]`, confirmed in
[`types.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py)):
`"exit"` persists only at exit ("you cannot recover from system failures … mid-execution"), `"async"`
persists while the next step runs ("small risk that LangGraph does not write checkpoints if the process
crashes"), `"sync"` persists before the next step starts
([checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)). Node-level
`RetryPolicy(max_attempts, initial_interval, backoff_factor, max_interval, jitter, retry_on)` and
`CachePolicy(ttl=…)` with `builder.compile(cache=…)` exist
([fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance),
[graph API](https://docs.langchain.com/oss/python/langgraph/use-graph-api)).

Most relevant of all: LangGraph's platform layer ships
[Assistants](https://docs.langchain.com/langsmith/assistants) — "manage configurations (e.g., prompts, LLM
selection, tools) separately from your graph's core logic," with "**Versioned configurations**: Each
assistant maintains its own configuration history through versioning. Editing an assistant creates a new
version, and you can promote or roll back to any version." And the boundary is stated in a parenthetical:
"Through configuration variations (**rather than structural graph changes**)." So LangChain's product answer
is *data-versioned configuration, yes; data-defined topology, no*. Their escape hatch for semantic change is
also instructive and directly copyable: **stamp a behavioural version into the state at thread start** and
branch on it (`flow_version: NotRequired[int]`), because "This pattern only works if you set the version *at
thread start*, before any branch that needs to be versioned."

### Inngest: the one engine whose documented contract is natively compatible with an interpreter

Memoization is keyed by a hashed **developer-supplied string**, not by position
([SDK_SPEC §5.1.2](https://github.com/inngest/inngest/blob/main/docs/SDK_SPEC.md)):

> "The `id` of each Step MUST be a hex-encoded SHA-1 hash such that the Step can be identified reliably
> during multiple Call Requests."
> "IDs are hashed to ensure a consistent length and format across multiple SDKs, allowing cross-language,
> cross-cloud **migrations of Functions mid-Run**."
> "each repeated human-readable identifier MUST append `:n` to the end of the identifier before hashing,
> where `n` is the number of times the Step has previously been found."

The determinism obligation is scoped by a clause that is the whole point: "an SDK MUST maintain determinism
in Call Requests **when the underlying code has not changed**." And the recovery path on detected change is
order-insensitive set membership, not positional replay (§5.4): "the SDK MUST continue to memoize Steps, but
no longer expect them to sequentially match the `ctx.stack.stack` ordering. Instead … find the **earliest**
found Step that should be memoized." The spec candidly admits it cannot distinguish a code change from
nondeterminism: "this symptom may also be experienced if a user's function is non-deterministic."

[Versioning and Function Evolution](https://www.inngest.com/docs/learn/versioning) documents graceful
degradation: "New steps are executed when discovered"; "**Warnings, not failures** — If step execution order
changes, the SDK logs a warning rather than failing the function"; changing a step body but keeping its ID
uses the memoized result for in-flight runs; "**Changing step IDs** forces re-execution"; removed steps'
memo data "remains in state but is simply ignored"; reordering is tolerated. Required hygiene: IDs must be
"Descriptive… **Stable**: Avoid IDs that encode values that might change… **Unique**."

⚠️ Inngest does not document what happens when two distinct steps share an ID; the `:n` rule implies silent
loop-style memoization, but that is inference.

### Restate, DBOS, Cloudflare — what each adds

- **Restate** makes pinning the platform default, so no patching API exists:
  "When you deploy a version of your code, you give it an immutable, unique endpoint… Restate then makes sure
  that requests start and end on the same version… This eliminates mid-execution version mismatches: **no
  version compatibility logic is needed** in your code" ([versioning](https://docs.restate.dev/operate/versioning/)).
  Mismatch is a hard `RT0016` journal-mismatch error; the unsafe-change list is explicitly positional
  ("Reordering Restate SDK operations… Adding or removing SDK operations in the execution path"). The stated
  cost of pinning is the one Alfred inherits: "Avoid long-running handlers … otherwise you need to keep old
  deployments around until all invocations complete."
- **DBOS** is the sharpest cautionary tale for program-as-data:
  "By default, application version is automatically computed from **a hash of workflow source code**… When
  DBOS tries to recover workflows, it only recovers workflows whose version matches the current application
  version" ([upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)). An
  interpreter's source never changes, so **every artifact revision would hash to the same version** and DBOS
  would happily recover an old run against a new program shape, then fail positionally. The documented
  override (`applicationVersion` config / `DBOS__APPVERSION`) is the fix, and it generalizes.
- **Cloudflare Workflows** keys by step name — "Step names act as the 'cache key' in your Workflow" — and
  requires "conditions must be based on **deterministic values** — either values from `event.payload` or
  return values from previous steps" ([rules of workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)).
  ⚠️ **No first-party statement exists about in-flight instances during a new deploy**; the Workflows page
  index contains no versioning page and `/workflows/reference/faq/` 404s. Do not assert a Cloudflare pinning
  guarantee. Notably, Cloudflare's answer to per-tenant program logic is late-loaded **code**, not data
  ([Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)), and the
  resume path re-binds to a *tenant*, not a code revision — with no documented caveat about tenant code
  changing mid-instance.

### What this implies for Alfred's stored artifact

1. **Key everything nominally.** Give every node an artifact-owned, immutable `id`; derive the durable step
   identity from `(revisionId, nodeId, loopPath, attempt)`. This is what LangGraph and Inngest already
   require, and it is the property generated code cannot guarantee because codegen renames and reorders
   freely. LangGraph's rule translates directly: *never reuse or retire a node ID while a run is parked on
   it* — a schema invariant enforceable at artifact-write time.
2. **Feed the engine the artifact revision as the version, not the interpreter build.** DBOS's source-hash
   default is the trap; its `applicationVersion` override is the pattern. On a Temporal-shaped runtime the
   equivalent is a Build ID / pinned-version token that encodes the artifact revision. Alfred's PRD already
   persists `runtime_build_id` / `tool_catalog_hash` on the run — extend it with the revision content hash
   and make resume fail loudly on mismatch, which the PRD already says it should.
3. **Make the nondeterminism boundary a required schema field.** Temporal's `execute_in` is mandatory and
   non-defaultable per node. Alfred's equivalent is a required `kind: "tool" | "judgment"` plus the
   tightening doc's `costClass: zero_llm | may_call_llm` — computed at publish time, not asserted in prose.
4. **Keep approvals out of node bodies.** LangGraph's `interrupt` hazard is that everything before the pause
   re-runs, non-idempotently, and matching is index-based. Alfred's `effect_key` / `attempt_key` split and
   staged-dispatch boundary are the right shape; a JSON program should structurally forbid an external effect
   in the same node as an approval pause.
5. **Immutable, retained revisions plus drain detection.** Restate keeps old deployments alive until
   invocations complete; LangGraph concedes "LangGraph itself does not maintain a search index over thread
   state." Alfred must own the query "which runs are parked on revision R," which the PRD's
   `agent_runs.workflow_revision_id` already makes possible.
6. **Replay testing is the safeguard, and it gets cheaper with an interpreter.** Temporal's recommended
   practice is replaying stored histories against new code. With one interpreter and N artifacts, a single
   replay corpus covers everything; with N generated programs you need N corpora.

**The honest counterpoint, unaddressed by any of the six:** every engine assumes program change is rare and
deliberate — a deploy. A JSON artifact invites frequent, cheap, LLM-authored edits at a rate none of them
anticipates. Alfred inherits Restate's immutable-deployment discipline at *artifact* granularity and has to
build the drain detection itself. That is a real cost of the JSON choice, and it is the reason the PRD's
immutable-revision design is a prerequisite for the Generate step rather than an adjacent nicety.

---

## The smallest honest v1 of Generate

Framed to fit the PRD's existing draft → validate → activate lifecycle, so Generate produces a **draft
revision** and nothing else. Nine constraints, each traceable to a finding above.

**0. Ship the rung below Generate first, because it is cheaper and better evidenced.** Persist the last
successful run's trajectory on the workflow revision and prepend it to the interpreted brief on the next
occurrence. No compiler, no variable induction, no determinism claim. This is what AWM (+51.1% relative on
WebArena), Synapse (99.2% MiniWoB++ from 3.45 raw exemplars per task) and Memp's Trajectory mode actually
measure, and SkillEvolBench says it often beats the compiled artifact. If this alone reduces turns on
Alfred's real workflows, it also produces the volume and entropy data the PRD's compilation gate requires —
so it is a prerequisite, not a detour.

**1. Reframe it. Generate does not turn a trace into a program; it uses a trace to make an approved brief
concrete.** This is Microsoft's shipped pattern — NL is the skeleton, the recorder fills the grounded holes,
and the placeholder "produces a design time error … to remind you that a significant part of the flow is
still missing"
([Copilot in PAD](https://learn.microsoft.com/en-us/power-automate/desktop-flows/copilot-in-power-automate-for-desktop)).
Alfred's `brief` is the skeleton and `required_capabilities` / `capabilities[]` are the holes. The output of
Generate is a revision whose `brief` is unchanged and whose *tool/account/resource/argument* bindings are now
pinned from evidence. That is a smaller, more defensible claim than "a compiled workflow."

**2. Ask before executing, not after.** Every shipped commercial system with a trace declares parameters up
front: OpenAI's "state your goal and any specific inputs that might vary … **before** you start recording,"
Power Automate's 2021 in-recording variable declaration. Alfred's version is free: when the user says "do X
and remember how," the boss asks *once*, in the same turn, "which parts of this will change next time?"
before the run. A single answer collapses the induction problem into a lookup — this is SUGILITE's mechanism,
the only published method that parameterizes correctly from one demonstration without a data-source join.
**Highest-leverage item on the list; costs one prompt sentence.**

⚠ **The contrary datapoint, stated honestly.** Halbert removed exactly this from SmallStar: "In an earlier
version of SmallStar, the user had to specify the choice **as the program was being recorded**. This turned
out to be **distracting and intrusive**." What resolves the tension: Halbert asked *per action*, modally,
inside a GUI. Alfred asks *one question at the goal level, in a chat turn the user is already having* — the
shape OpenAI shipped. If it ever degrades into a per-tool-call prompt, drop it and fall back to
Rousillon-style **preview** (show the proposed parameterization before the run and let the user reject it)
rather than interrogation.

**3. Record enough. Add a compile-grade recorder; do not widen `trajectory.ts`.** Per
[P0-3](#p0-3-alfreds-trajectory-normalizer-cannot-see-data-flow), the minimum per step is
`{nodeId, toolName, input, resultDigest, boundFrom?}` where `boundFrom` records that an argument value was
copied from an earlier step's result (computed by exact-substring match against prior results at record time,
which is cheap and deterministic). Plus the run's brief and the user's turn. Reuse `decidedNotExecuted` as a
hard gate: **non-empty means a policy gate diverted the run, so the trace is not the program — refuse to
compile.**

**4. Refuse rather than guess.** Compile only a trace that is: all `status: "ok"`; no repeated
`(toolName, differing args)` pairs (no loop induction in v1); every step's tool still registered and
available; and — v1 only — **every tool `riskTier` below `high`**. Read-only first is not timidity: it is the
only regime where verification (item 7) is available at all, which is precisely the condition ASI attributes
its win to.

**5. Three buckets, not two.** Every literal is classified as `parameter | constant | recompute_per_run`.
The third bucket is deterministically detected — ISO dates, `after:`/`before:`/`newer_than:`/`older_than:`
operators, `YYYY-MM-DD` substrings, explicit `timeMin`/`timeMax` — and compiled to a *relative expression*,
which Alfred's own `gmail.search` description already prescribes ("prefer Gmail's relative operators
(newer_than:3d, older_than:1w) — Gmail resolves them server-side"). A two-bucket compiler silently ships a
scheduled workflow that queries July 2026 forever.

**6. Whole-field parameters only, with a hard refusal list.** No intra-string parameterization — the one
reference implementation that could do it declines it (`step_dict[key] == old_value`), and nothing in the
literature does it from a single trace. Deterministically **refuse** to expose as a parameter any field that
is an opaque identifier (`messageId`, `threadId`, `eventId`, `documentId`, `installationId`, `pageToken`,
`*Id` by convention) or that has a non-empty `boundFrom` — the generalization of SkillWeaver's "Avoid using
`*_id` or `*_url` parameters … We will check your code for such parameters!" Conversely, a field whose Zod
type is an enum/`Literal` union is *safe* to expose, because the substitution space is closed — the one place
typing genuinely resolves rather than narrows.

**7. Every parameter defaults to its recorded literal.** Copy `workflow-use`'s single best decision
verbatim: "Always add default value (original value from workflow) … This allows the workflow to run without
user input if desired." A wrong parameterization then degrades to the recorded behaviour, not to a crash or a
prompt.

**8. Verify by replay + diff before the revision is offered for activation.** Re-execute the compiled
program with the recorded arguments, read-only steps only, and diff against the recorded trajectory using the
existing `diffTrajectories`. Require `identical` modulo declared parameters and `recompute_per_run` fields.
This is ASI's verification gate implemented with machinery Alfred already owns, and ASI attributes its
+7.7-point WebArena margin over vanilla "mainly … [to] the programmatic verification guarantee during the
induction phase." If the diff is not clean, the compile is **rejected** — matching SkillDisCo's "Skills that
fail are re-synthesized with feedback for up to R retries; any remaining failures are discarded."

Add SkillWeaver's two guards, because replaying with the *recorded* arguments cannot catch a
mis-parameterization — that is precisely the blind spot in LATM's, CRAFT's, TroVE's and ASI's verification:
  - **Liveness:** reject any declared parameter that is not actually substituted anywhere in the program
    ("Warning: Unused parameter 'color' … defined but never used in the function body").
  - **Counterfactual substitution (reads only):** re-execute with a *different* value per parameter and
    assert the result *changes* in a way consistent with the parameter's meaning. A parameter whose value
    provably does not affect the outcome is a constant that was mislabelled.

**9. Store it as a typed executable revision, and label its cost class honestly.** A `workflow_revisions`
column (or sibling table) holding `{formatVersion, entryNodeId, nodes[], parametersSchema (constrained JSON
Schema + schemaVersion), toolCatalogHash, costClass}` — not `skill_revisions.metadata`, per the
[tightening doc §4](./compiled-browser-flows-v1-tightening.md). Node IDs immutable and never reused.
`costClass: zero_llm | may_call_llm` computed at publish time. **A workflow containing any judgment node is
not deterministic and must not be described as such** — `workflow-use`'s own schema requires an LLM extract
step at the end of every workflow, which is a good reminder of how easily that claim slips.

**10. Put a usage floor on the artifact.** TroVE's rule — delete functions used fewer than
`½ · log₁₀(n)` times — exists because per-instance tools measurably *hurt* (GQA 0.37 → 0.16 with 395 induced
functions). Alfred's analogue: a compiled revision that has not been reused within N occurrences reverts to
the interpreted brief and the compiled revision is archived. Compilation must be reversible and its value
must be measured per artifact, not assumed.

**What v1 deliberately does not do:** mine multiple traces, induce loops or branches, parameterize
substrings, self-heal, auto-promote, or compile writes. Each of those is a separate, later, measurable
graduation — and the PRD is already right that the gate is measured volume, low trajectory entropy, and a
measured cost/latency win.

**How to falsify this design in a week.** Take ten real Alfred runs from Langfuse that a user would plausibly
want repeated. For each: (i) does an input-only trajectory contain any literal that is actually
`boundFrom` a prior result? (ii) does it contain a date literal? (iii) how many whole-field literals are
there, and how many would the user actually want to vary? If (i) and (ii) are common, P0-3 and bucket three
are confirmed and the recorder must ship first. If (iii) averages more than about two candidates per run, the
confirm-at-activation card stays cheap and the design holds; if it averages ten, the card is unusable and
item 2 (ask up front) becomes mandatory rather than merely highest-leverage.

---

## Source confidence — what is solid and what is not

**Read first-hand at a pinned commit or from the paper itself** (highest confidence): all `workflow-use`
source and prompts at `fa53b3d`; all AWM repo prompts/inducers/workflow artifacts at `8c0ff8c`; all
SkillWeaver prompts, `generate_schema.py` and shipped `skillnet/` libraries at `f2a63d6`; Alfred's own
`trajectory.ts`, `skills.ts`, `tool-schemas.ts`, tools registry; the ASI HTML; the AWM v1 HTML; the SkillDisCo
and NSI HTML; every Temporal / LangGraph / Inngest / Restate / DBOS / Cloudflare docs page quoted; every
vendor docs page quoted in the commercial section except where marked ⚠.

**Computed by me from a pinned artifact** (verifiable, but my arithmetic): the SkillWeaver parameterization
table (438 functions / 54 parameterized / 74 parameters / 0 annotated), the 178 numeric-element-ID actions in
AWM's committed workflow files, and the 5,167-vs-1,014 line counts in `workflow-use`.

**Second-hand from a primary-source sweep, not re-read by me** — verify before quoting externally:
MIND-Skill (2605.08670), SkillEvolBench (2605.24117), SkillLearnBench (2604.20087), SkillGenBench (2605.18693),
Trace2Skill (2603.25158), MACLA, MSCE (2607.16621), AFTER (2606.23127), LATM's exact example counts, the AWM
rule-vs-LM ablation (35.6 vs 35.5), the Experience-Compression-Spectrum aggregated figures, and the
Voyager/ADAS/AFlow/Learn-by-Interact/Synapse/Memp/TroVE numbers.

**Not retrievable, quoted through primary sources that quote them:** Vegemite (ACM 403), CoScripter CHI 2008
(publisher redirect), Lau's "why PBD systems fail" AI Magazine 2009 (publisher errors), UiPath and Automation
Anywhere docs (bot-blocked / JS-rendered — strings came from the search index of the exact cited pages).

**Verified-by-absence, which is weaker than a citation:** no first-party Cloudflare Workflows statement about
in-flight instances across a deploy; no first-party Temporal guidance on program-as-data; no primary source
using a callee's declared parameter schema as the parameter/constant prior; no Gumloop or Lindy docs page for
NL workflow generation. Treat all of these as "not found," not "does not exist."

**Marked as my inference, not sourced:** the `recompute_per_run` bucket; the claim that `trajectory.ts`'s
missing results make data-flow literals indistinguishable from constants; the reading that SkillWeaver's gains
come from composition and usage logs rather than parameter induction; and the two-objectives framing in the
fifth bottom-line finding.

## Decision summary

| Question | Verdict | Primary evidence |
|---|---|---|
| Induce parameters from one trace, autonomously | **No** | AWM's signal is cross-task invariance; SkillDisCo: skills need "multiple successful traces, rather than … only one execution"; no RPA vendor claims it |
| Ship trace **retrieval** before trace **compilation** | **Yes — missing from the ladder** | SkillEvolBench: "raw-trajectory reuse frequently outperforms distilled skills"; Memp Trajectory 74.29 > Script 56.43; Synapse 99.2% MiniWoB++ from raw traces alone |
| Require a usage floor on compiled workflows | **Yes** | TroVE trims functions used fewer than ½·log₁₀(n) times; its per-instance baseline drops GQA 0.37 → 0.16 with 395 tools |
| Cite ADAS / AFlow as precedent | **No** | Both search against a validation *score*, not a trace, and need a dense scalar reward; ADAS scores below plain IO prompting on HumanEval/MBPP/MATH |
| Induce from one trace as a *proposal* + human confirm | **Yes — this is what everyone ships** | `workflow-use` CLI prompts per variable; AWM `induce_rule.py` gates on `input("Add? (y/n)")`; OpenAI Record & Replay asks for varying inputs pre-recording; PAD requires manual promotion |
| Induce from one trace + validate by re-execution | **Yes, for reads only** | ASI 32.7 → 40.4% WebArena, attributed to "programmatic verification guarantee"; SkillWeaver practices with LLM-generated args; SkillDisCo discards unverifiable skills |
| Ask "what varies?" before the run | **Highest-leverage single change** | OpenAI Record & Replay; PAD in-recording variable declaration (GA 2021); `workflow-use`'s `VAR:name:value` marker |
| Tool substrate removes the identity problem | **Yes, decisively** | Nearly all of `workflow-use`'s machinery is element identity; `elementHash` may never be a variable, and a variable identity forces an `agent` step; AWM's shipped artifacts contain 178 per-observation numeric element IDs |
| Typing resolves variable-vs-constant | **No — it narrows only** | `gmailSearchInput` is `q: z.string()`; `workflow-use` applier requires whole-field equality; no LLM-agent source performs intra-string induction from a trace |
| The problem is formally underdetermined from one trace | **Yes, provably** | Mitchell 1980: unbiased generalization "cannot outperform … rote learning"; anti-unification is defined for n ≥ 2; Drain emits zero wildcards at n=1 |
| One-shot induction works with a *learned ranker* + interaction | **Yes** | FlashFill: learned ranker gives 1-example success on 74% of benchmarks vs **0/123** hand-tuned; "Microsoft refused to ship … Flash Fill until common scenarios were learned from only one example" |
| Confirmation is expensive for the user | **No — measured cheap** | Conversational Clarification "never exceeded 5" rounds and reduced errors "without any difference in completion time" |
| Solve intra-string params by parsing the DSL first | **Yes, and Alfred's DSLs are documented** | Potter's Wheel/LAPIS resolve it with a domain vocabulary; Gmail `q` "supports the same query format as the Gmail search box" with an enumerated operator set |
| Let the model segment substrings unaided | **No** | Log-parsing study: LLM "cannot recognize the whole address of `video.5054399.com:80` as one variable"; grouping accuracy 0.721 vs Drain 0.844 |
| Align recorded literals to the user's utterance | **Yes — the missing second example** | SUGILITE parameterizes from one demonstration by matching arguments against the verbal command; same trace, different request → different correct parameterization |
| Join recorded literals against Alfred's entity store | **Yes** | Koala generalizes a literal automatically iff it appears in the personal data store; Rousillon does it for substrings of typed strings |
| Default every literal to a slot with a recorded default | **Yes** | SmallStar: "There are no constants … Every data object has a corresponding data description"; Koala ships a sample value with each slot |
| Verify by replaying recorded arguments alone | **Insufficient** | LATM/CRAFT/TroVE/ASI all pass a tool that hard-codes what should be a parameter; only SkillWeaver adds a liveness check and counterfactual values |
| Cite TroVE's accuracy delta | **No — cite its trimming rule** | Compute-matched re-evaluation: "the benefit of TroVE reduces to a marginal improvement of 1%"; tools "often trivial or rarely reused" |
| Compression/MDL as the criterion once variance exists | **Yes** | Stitch penalizes arity (`cost_app · arity(A)`) and rewards multi-use — absent variance, the compressive optimum keeps the literal constant |
| Schema-guided parameter induction is prior art | **Not found — likely unclaimed** | No primary source uses the callee's declared JSON Schema/OpenAPI as the prior; nearest neighbours infer contracts or argument *values*, not parameter/constant status |
| Typing resolves *closed* parameter spaces | **Yes** | Zod enum/`Literal` fields have a closed substitution space; SkillWeaver's schema generator defaults unannotated params to `string` |
| Tool substrate is harder for validation | **Yes** | ASI/SkillWeaver both assume free re-execution; Alfred's writes are `riskTier: 'high'` with no staging environment |
| `trajectory.ts` as the compiler input | **Insufficient** | Drops tool results → cannot distinguish a constant from a value bound from a prior step; drops the user's intent, which is `workflow-use`'s primary parameterization signal |
| Third literal bucket (`recompute_per_run`) | **Required, unmodelled anywhere** | Alfred's own `gmail.search` description prescribes relative operators over absolute dates; no paper or product models this class |
| Stored artifact = JSON program | **Yes** | Nominal memo keys (LangGraph node names, Inngest `SHA1(stepId)`) suit artifact-owned IDs; Temporal's LangGraph integration already mandates per-node `execute_in`; every code-artifact system in the literature needs a sandbox Alfred does not have |
| Stored artifact = generated code | **No** | Codegen cannot guarantee stable node identity; no schema to validate at publish time; requires a sandbox |
| Engine version must track the artifact | **Yes** | DBOS derives version from "a hash of workflow source code" — an interpreter would make artifact edits invisible; override with the artifact revision |
| Approval pauses inside node bodies | **Forbid structurally** | LangGraph: resume "restarts the entire node from the beginning," matching is "strictly index-based," `while True` + `interrupt()` gives "exponential re-execution" |
| Loop / branch induction in v1 | **No** | PAD recorder "doesn't capture logic such as conditions or loops"; Record with Copilot needs narration to recover them |
| Intra-string parameterization in v1 | **No** | Unattested in every primary source reviewed |
| Compile writes in v1 | **No** | Verification unavailable; ambiguous-write semantics already the PRD's hardest problem |
| Call the result "deterministic" | **No** | `workflow-use`'s schema mandates a terminal LLM extract step; the measured wins in the literature are *turns and cost*, not determinism |
| What compilation actually buys | **Turns and cost, not correctness** | ASI −15.3% steps; SkillDisCo −11.3%/−13.1% turns; `workflow-use`'s only quantified claim is $0/run vs $0.03–0.30/run and 5–10 s vs 20–40 s generation |

