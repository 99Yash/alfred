# AI-agent-friendly codebases: source-backed principles

Status: researched 2026-08-01  
Scope: the general design claims in Matt Pocock's [AI Hero article](https://www.aihero.dev/how-to-make-codebases-ai-agents-love), checked against primary sources. This note does not assess Alfred or prescribe an Alfred migration.

## Executive conclusion

The article's strongest idea is sound, but its evidence is mainly design reasoning and practitioner experience: an agent-friendly codebase has a small number of explicit, testable boundaries instead of a web of freely connected files. This is not a new AI-specific architecture. It is information hiding, strong interfaces, reproducible feedback, and discoverable repository knowledge applied to workers that start each task with limited context.

The primary sources support five principles:

1. **Hide decisions, not merely code.** A useful module owns a design decision and exposes a small contract. File count is not the measure.
2. **Make boundaries visible and enforceable.** Directory names and barrel files help navigation, but compiler, package, lint, and structural rules stop accidental cross-boundary imports.
3. **Test the contract at the boundary.** Tests are executable feedback for agents, but they must match the stated behavior. A green suite is evidence, not proof.
4. **Keep the repository as the operating record.** Put architecture, decisions, commands, plans, and validation tools where the agent can find and run them. Use a short entry-point document as a map.
5. **Turn repeated review feedback into mechanisms.** A prose rule is weak. A focused lint, type, test, schema, or generated check applies the rule on every later run.

## 1. What “deep module” means

The article defines a deep module as “lots of implementation controlled by a simple interface.” That formulation comes from John Ousterhout's *A Philosophy of Software Design*. Ousterhout's own [book page](https://web.stanford.edu/~ouster/cgi-bin/book.php) identifies “General-Purpose Modules are Deeper” as a central chapter and describes the larger aim as separating what matters from what does not.

The older primary source is David Parnas's 1972 paper, [“On the Criteria To Be Used in Decomposing Systems into Modules”](https://doi.org/10.1145/361598.361623). Parnas compares two decompositions of the same system and argues that each module should hide a design decision that is likely to change. His stated goals are flexibility, comprehensibility, and shorter development time. This is the foundation under the article's advice:

- group code by owned knowledge or capability, not by execution order;
- expose only the operations consumers need;
- prevent consumers from depending on representation details;
- keep likely changes inside one ownership boundary.

“Deep” does **not** mean “large file,” “many lines,” or “one service class.” A large implementation with a wide, unstable interface is still shallow. Several small files can form one deep module if they hide behind one stable contract.

## 2. Why this shape helps coding agents

The AI Hero article uses a useful mental model: every agent starts like a new engineer without the maintainer's private map. Repository-level coding research supports the difficulty, although it does not isolate module depth as the causal variable. The original [SWE-bench paper](https://arxiv.org/abs/2310.06770) found that real issues often require coordinated work across several functions, classes, and files, plus execution tools and long-context reasoning.

OpenAI's first-party report from an agent-generated codebase gives direct practitioner evidence. [“Harness engineering: leveraging Codex in an agent-first world”](https://openai.com/index/harness-engineering/) says that the team optimized for agent legibility, made repository-local artifacts the system of record, used a short `AGENTS.md` as a table of contents, enforced fixed dependency directions with custom linters and structural tests, and exposed the UI, logs, metrics, and traces to the agent. It also gives an important limit: the reported autonomy depends heavily on that repository's structure and tooling and should not be assumed to generalize without similar investment.

The mechanism is therefore plausible and concrete:

- a stable public surface reduces the amount of implementation an agent must load;
- an ownership boundary narrows the files that may need a change;
- a dependency rule reduces the number of plausible but invalid edits;
- an executable check gives immediate, local evidence about the edit;
- repository-local explanations replace context that would otherwise remain in a person's memory or a chat thread.

There is not yet a controlled result in these sources showing that “deep modules improve agent success by X%.” Treat that as a strong engineering hypothesis with consistent first-party experience, not as a measured universal law.

## 3. A visible boundary is not necessarily an enforced boundary

A folder and an `index.ts` make an interface easy to discover, but they do not stop a consumer from importing an internal file. Enforcement must exist in the toolchain.

For TypeScript, the official [Project References documentation](https://www.typescriptlang.org/docs/handbook/project-references) says that references can split a program into smaller pieces, improve build speed, and enforce logical separation. Referenced projects expose declaration output to consumers. The official [module-resolution reference](https://www.typescriptlang.org/docs/handbook/modules/reference) explains that `package.json` `exports` controls package entry points and blocks unexported package-relative subpaths in modes that honor it.

These tools support a general boundary stack:

1. **Discoverability:** one named directory or package per capability.
2. **Contract:** one intentional public entry point with domain types and operations.
3. **Runtime or build enforcement:** package exports, project references, dependency rules, or structural tests.
4. **Behavior enforcement:** contract tests and integration tests at the seam.
5. **Change record:** a nearby decision or design note when the boundary is not obvious from types.

No one layer is sufficient. Types cannot enforce runtime policy by themselves. Tests cannot make a hidden interface easy to find. Documentation cannot prevent an illegal import.

## 4. Tests are the feedback loop, with two qualifications

The article says that strong tests let a human own the interface while an agent changes the implementation. This matches how repository-level coding agents are evaluated. In [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/), a candidate patch must pass both tests that demonstrate the requested fix and regression tests that protect existing behavior.

Two qualifications matter:

- **The specification and the tests must agree.** OpenAI's audit found many original SWE-bench tasks had underspecified issue text, overly specific tests, or unreliable environments. The Verified set removed cases with these defects. A fast green test for the wrong contract gives misleading feedback.
- **Passing tests do not remove review responsibility.** OpenAI's [Codex introduction](https://openai.com/index/introducing-codex/) says agents work best with configured environments, reliable tests, and clear documentation, but it still tells users to review and validate generated code before integration.

The practical rule is to make the shortest relevant validation command deterministic and easy to discover. Then retain broader checks for cross-module regressions and human review for product intent, maintainability, security, and gaps in the test model.

## 5. Progressive disclosure belongs in both code and documentation

The article applies progressive disclosure to source layout: show the interface first and reveal implementation only when needed. OpenAI reports the same pattern for repository knowledge: a short, stable map points to deeper architecture, product, plan, and reference documents. It states that a large instruction file consumes context, becomes stale, and is hard to verify; indexed repository documents can be checked for structure, freshness, and links.

This suggests a general information architecture:

- the root agent guide is a routing table, not an encyclopedia;
- each major capability has a clear public contract and an owner location;
- architectural decisions are versioned with the code they constrain;
- commands for setup, focused validation, and full validation are executable and current;
- generated facts, such as schemas, are generated instead of copied by hand;
- stale-document checks and link checks run in CI where practical.

The same rule applies at every scale: start with the smallest stable surface that lets the reader choose the next correct source.

## 6. What a project should establish from day one

The source-backed day-one doctrine is small:

1. Define the first domain boundaries before convenience imports make them porous.
2. Give each boundary one public contract and make internal paths non-public.
3. Encode allowed dependency direction in the compiler, package graph, lint rules, or structural tests.
4. Put one focused contract test beside each important seam and one documented command to run it.
5. Keep a short repository map plus versioned decisions; do not depend on private human context.
6. Convert every repeated review correction into a shared abstraction or a mechanical check.
7. Treat agent failure as a repository-feedback event: identify the missing contract, tool, fixture, signal, or rule and add the smallest durable fix.

This is stronger than “write a good `AGENTS.md`.” Instructions help an agent choose. Architecture and feedback determine which choices are possible and whether the result can be checked.

## Source assessment

| Claim | Source quality | Conclusion |
| --- | --- | --- |
| Deep modules reduce exposed complexity | Primary design sources: Ousterhout and Parnas | Strong design principle; not an AI performance measurement |
| Real repository work requires cross-file navigation and execution | Primary research: SWE-bench | Directly supported |
| Repository-local knowledge, strict layers, and mechanical checks help Codex | First-party OpenAI production report | Strong practitioner evidence; explicitly repository-specific |
| Tests give agents useful correctness feedback | Primary benchmark design and OpenAI product guidance | Supported, with specification and coverage limits |
| Effect makes TypeScript modularization “simple” | Personal experience in the AI Hero article | Not established by the reviewed primary sources; Effect may be one implementation choice, not the principle |
| The codebase matters more than the prompt or `AGENTS.md` | Thesis in the AI Hero article | Directionally consistent with first-party experience, but no reviewed source provides a controlled comparison |

## Alfred retrospective

### Conclusion

Alfred chose a good outer monorepo shape on day one, but it did not make the
first domain modules deep. The initial scaffold named technical packages and
future subsystems, exposed broad import surfaces, and had no executable contract
tests. As the product grew, domain knowledge spread through `@alfred/api` and
callers learned implementation details. Much of the July structural work has
been the delayed payment for this choice: consolidate parallel idioms, assign
one owner, make states representable in types, and recover seams around agent
execution, integrations, time, errors, credentials, and streaming state.

This is not a reason for a repository rewrite. Alfred now has many of the right
mechanisms. The next step is to apply them consistently to the remaining
internal module graph and to make the shortest complete verification command
obvious.

### What the repository shows

The actual repository root commit is `5d22193d` on 2026-04-27, not the later
history import on 2026-07-17. The root commit contained 51 tracked TypeScript
files and no tests. Its scaffolding plan required build, type-check, migration,
manual boot, and one end-to-end health call. It did not require a contract test
for an important domain seam because the domain behavior was intentionally
deferred.

Several day-one choices were good and should remain:

- The repo had a short orientation document, 25 ADRs, explicit package purposes,
  and a staged milestone plan.
- Browser/server separation, schema ownership, migrations, and package naming
  were stated early.
- The scaffold stopped at a working vertical health call instead of pretending
  that placeholder business logic was complete.

The structural misses were more important than the documentation misses:

- Packages were mainly technical layers: `api`, `db`, `ai`, `sync`,
  `integrations`, and `ingestion`. This was a useful deployment and runtime map,
  but not yet a map of Alfred's domain decisions.
- Several packages exported `./*`. A caller could bypass the root interface and
  bind to any source file. Some of those wildcard exports remain in
  `contracts`, `db`, `env`, `sync`, and `auth` today.
- The scaffold created generic files such as `utils.ts`, `helpers.ts`,
  `schemas.ts`, and `types.ts`. These names do not say which decision they own
  and invite unrelated knowledge to accumulate.
- The milestone briefs specified files and implementation order more often than
  an owned decision, a small interface, allowed dependencies, observable
  behavior, and a contract test.
- No test ran on day one. Therefore the first agents learned mainly from the
  compiler and manual smoke checks, not from executable behavior at module
  seams.

The present repository is much stronger, but the remaining pressure is visible:

- There are 28 top-level modules under `packages/api/src/modules`.
- A static import scan finds 181 imports across those top-level modules, covering
  83 directed module pairs. High-coupling areas are `agent`, `tools`,
  `integrations`, `memory`, `workflows`, `briefing`, `triage`, and `dispatch`.
- Some relationships are two-way, including `tools`/`workflows`,
  `memory`/`triage`, and several links around `agent`. A folder and `index.ts`
  cannot hide a decision when both sides reach into each other.
- The repository now has 241 tracked tests, strong CI, targeted architectural
  checks, nested agent guides, ADRs, reference docs, and a structural-review
  method. These are real strengths.
- The root has no `test` or `verify` command. `pnpm check` mutates formatting and
  omits both type-checking and tests, while CI assembles the complete feedback
  loop across several jobs. An agent must know that assembly instead of finding
  one local, non-mutating command.
- From 2026-07-17 through this audit, 79 commit subjects mention a refactor,
  consolidation, owner, seam, boundary, protocol, or derivation. The titles are
  unusually direct evidence that the repository has been recovering missing
  ownership and interfaces after feature growth.

Counts are diagnostic signals, not quality scores. A cross-module import can be
correct, a large file can belong to a deep module, and a test can assert the
wrong contract. The important fact is the combination: broad reachability,
two-way dependencies, repeated ownership refactors, and behavior checks that
are harder to invoke locally than they should be.

### What Alfred should have done from day one

| Day-one rule | What it would have changed |
| --- | --- |
| Start each milestone with an owned decision, not a file list | `email triage`, `run execution`, `briefing composition`, and `integration access` would each have had one named module interface before implementation files multiplied. |
| Build the first real behavior as a tracer-bullet module | The first Gmail-to-triage path would have fixed the interface, dependency direction, error modes, and observable result before adjacent features reused internals. |
| Permit one public entry point per module | Callers would import a contract instead of arbitrary files. Package `exports`, lint, and structural tests would reject internal paths. |
| State dependency direction before code exists | Cycles such as tools/workflows and memory/triage would either never form or would force an early decision about which module owns the shared protocol. |
| Put a focused behavior test at every new seam | The compiler would verify shapes; the contract test would verify outcomes, retries, cancellation, authorization, and persistence rules through the same interface callers use. |
| Keep the root guide as a map | The original `CLAUDE.md` was close to this ideal. Detailed rules should still move into owned reference docs or mechanical checks as they recur. |
| Promote the second review correction into a mechanism | The second occurrence of a copied shape, stale token read, raw timezone operation, unsafe retry, or protocol switch should produce a type, schema, deep module, lint rule, or contract test. |
| Avoid speculative seams | Empty package shells are acceptable deployment placeholders, but a port or adapter should not be added until production and test adapters, or two production variants, make the seam real. |

The key change is in planning language. Every feature brief should have contained
this small architecture block before its task list:

```md
Module:
Owned decisions:
Interface, including errors and performance limits:
Allowed dependencies and dependency direction:
Production adapter and test adapter, if the seam is real:
Observable contract tests:
Facts that must be enforced by types, schemas, or checks:
```

This would not have predicted every correct abstraction. It would have forced
each early agent to make ownership explicit while the cost of changing it was
still low.

## Applying it now

### Priority 0: improve the feedback loop

1. Add one non-mutating root `verify` command that runs boundary checks, import
   checks, consolidation checks, formatting verification, lint, type-checking,
   and deterministic tests. Keep a faster affected-package or module command
   for normal edits. Do not make the primary verification command rewrite files.
2. Document focused test commands beside each major module interface. An agent
   should be able to verify one change without reading the CI workflow.
3. Add a structural import report for `packages/api/src/modules`. Record the
   current graph as a baseline, reject new cycles and new internal-path imports,
   then ratchet existing violations down. An immediate all-or-nothing rule would
   only create a large migration and weak exceptions.

### Priority 1: make interfaces real

1. Replace package wildcard exports with explicit supported entry points. Start
   with an inventory of current consumers so this is a controlled compatibility
   change.
2. Require cross-module imports to enter through the owning module interface.
   Keep implementation files private. Do not add barrel exports for everything;
   that preserves the wide interface under a different name.
3. Resolve two-way dependencies by assigning the shared decision to one owner.
   Start with the execution cluster (`agent`, `dispatch`, `tools`, `workflows`,
   and `approvals`) because it has the highest coupling and contains durable,
   retry, cancellation, authorization, and external-effect hazards. Then address
   the `memory`/`triage` cycle.
4. Test the new interface and remove internal-shape tests that must change during
   harmless refactors. Replace tests at the seam; do not layer another test suite
   on top of all old shallow-module tests.

The target is not one giant execution module. It is a small number of deep
modules with one-way relationships. For example, a run-execution module can own
checkpoint transitions, cancellation, and resume rules behind a small command
interface while integration access remains a separate injected capability. The
exact cut must follow the decisions that change together, not the current folder
names.

### Priority 2: make the map self-maintaining

1. Generate or check the module dependency map in CI. Use it to find new cycles
   and interface expansion, not as a decorative diagram.
2. Add an interface-budget review to feature plans and PR review: new exported
   names, required caller knowledge, new dependency edges, and the contract test
   that earns each addition.
3. Continue Alfred's present enforcement ladder: move durable facts from prose
   into types, schemas, package exports, database constraints, lint rules, and
   focused tests. Keep prose for rationale and navigation.

### What not to do

- Do not migrate to Effect only because the article mentions it. Alfred can
  enforce these principles with its present TypeScript types, package exports,
  project references, scripts, and tests. Adopt a framework only for a concrete
  capability it improves.
- Do not split every folder into a package. More package names can create more
  shallow interfaces and more caller knowledge.
- Do not equate `index.ts` with encapsulation. An interface is small only when
  unsupported paths are inaccessible and callers do not need hidden ordering or
  policy knowledge.
- Do not run a repository-wide rewrite. Ratchet the import graph, then deepen one
  high-hazard cluster at a time through behavior-preserving tests.

## Recommended first slice

The best first slice is tooling, not a large refactor:

1. Add a read-only script that emits the top-level API module dependency graph,
   detects cycles, and distinguishes public-interface imports from internal-file
   imports.
2. Commit the current result as a baseline and fail only on regressions.
3. Add a non-mutating root `verify` command.
4. Select one execution-cluster cycle and design its interface twice before
   changing code. Accept the design only if it reduces required caller knowledge
   and has a focused behavioral test.

This slice makes every later refactor safer and gives agents immediate feedback
about the architecture they are changing.

## Sources

- Matt Pocock, [“How To Make Codebases AI Agents Love”](https://www.aihero.dev/how-to-make-codebases-ai-agents-love).
- John Ousterhout, [*A Philosophy of Software Design* book page](https://web.stanford.edu/~ouster/cgi-bin/book.php).
- D. L. Parnas, [“On the Criteria To Be Used in Decomposing Systems into Modules”](https://doi.org/10.1145/361598.361623), *Communications of the ACM*, 1972.
- Carlos E. Jimenez et al., [“SWE-bench: Can Language Models Resolve Real-World GitHub Issues?”](https://arxiv.org/abs/2310.06770), ICLR 2024.
- OpenAI, [“Harness engineering: leveraging Codex in an agent-first world”](https://openai.com/index/harness-engineering/), 2026.
- OpenAI, [“Introducing SWE-bench Verified”](https://openai.com/index/introducing-swe-bench-verified/), 2024.
- OpenAI, [“Introducing Codex”](https://openai.com/index/introducing-codex/), 2025.
- TypeScript, [Project References](https://www.typescriptlang.org/docs/handbook/project-references) and [Modules Reference](https://www.typescriptlang.org/docs/handbook/modules/reference).
