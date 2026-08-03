# Readable module interfaces

Research date: 2026-08-03

## Decision

“Reads like poetry” is useful only when it has a testable meaning. For Alfred, it should mean:

> A call site states the workflow in domain order, uses names from Alfred’s domain, and does not require the reader to know setup, credentials, storage, registry mechanics, or safety rules.

This is not a request for method chaining. A fluent chain can still expose many concepts, hide an important choice, or add a shallow wrapper. The target is less required knowledge at the point of use.

## What the primary sources establish

### Judge the declaration through real call sites

Swift’s official API design guidelines make “clarity at the point of use” the main goal. They say to inspect use cases, prefer clarity over brevity, name values by role, include words that remove ambiguity, and omit words that add no information. They also support grammatical call sites, but only when the phrase expresses the correct meaning. [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)

Eric Evans gives the domain version of the same rule. An intention-revealing interface names an operation by its effect and purpose, not by its implementation. Its names use the domain’s shared language, so the caller does not have to inspect internals. [DDD Reference, “Intention-Revealing Interfaces”](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf#page=20)

Alfred implication: review the normal chat, background, and remote-workflow call sites. Do not approve an interface from `index.ts` alone. A correct call should read in workflow order. A reader should see product facts such as “live chat” or “background run,” not storage facts such as “has thread.”

### Hide decisions likely to change together

Parnas defines modules around hidden design decisions, not execution steps. The goal is that a change to one decision stays in one module and that a reader can study one module without knowing all others. [D. L. Parnas, “On the Criteria To Be Used in Decomposing Systems into Modules”](https://dl.acm.org/doi/10.1145/361598.361623)

Ousterhout states the depth test directly: an interface is everything another module must know; a deep module gives much functionality through a small interface; a shallow module adds almost as much interface complexity as the work it hides. [John Ousterhout, “Modular Design” lecture notes](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php%3Ftopic%3DmodularDesign)

Alfred implication: a public module verb must hide a coherent decision. A wrapper that only renames `registry.resolve(...)` is not enough. `tool-runtime` earns its seam when it owns model visibility, discovery, dispatch eligibility, approval, execution, and result routing as one tool-run policy. Until then, the public interface must be honest about its narrower surface.

### Fluency is a means, not the score

Fowler defines a fluent interface as an internal DSL whose main purpose is readable flow. He also states its costs: it takes more design work, can require unusual API rules, and individual methods can stop making sense alone. [Martin Fowler, “Fluent Interface”](https://martinfowler.com/bliki/FluentInterface.html)

Alfred implication: do not reward chaining, namespaces, or sentence-like names by themselves. Prefer one clear workflow verb over a chain that makes the reader learn several intermediate states. Do not add `toolRuntime.forRun(...).surface(...).resolve()` unless each step is a real domain state and the types constrain the next legal operation.

### Put hazards in types or at the owning boundary

The Rust library team’s API guidelines prefer an input type that rules out invalid values. Runtime validation is the fallback when a property cannot be expressed statically. The same guidance warns that dynamic checks add delayed failure paths. [Rust API Guidelines, “Functions validate their arguments”](https://rust-lang.github.io/api-guidelines/dependability.html#functions-validate-their-arguments-c-validate)

TypeScript’s official handbook shows how a discriminated union and `never` make a new unhandled case a compile error. [TypeScript Handbook, “Discriminated unions” and exhaustiveness checking](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)

Zod’s official guide shows the complementary runtime boundary: parse `unknown`, then derive the TypeScript type with `z.infer` from the same schema. [Zod, “Basic usage”](https://zod.dev/basics)

Alfred implication:

- Keep trusted in-process facts as a discriminated union. `interaction: "live_chat" | "background"` is clearer and safer than `hasThread: boolean`.
- Parse persisted, queued, or remote run input at its ingress. If that value crosses a runtime boundary, make a Zod schema the source and derive its type. Do not parse the same trusted object again inside `tool-runtime`.
- Make a new interaction kind force an exhaustive decision in model visibility, discovery, and dispatch. A comment that asks all three paths to stay aligned is only convention.
- If a hazard is hidden by the seam, its policy needs a typed value, a runtime gate, or one authoritative operation. A smooth call site must not make authorization, approval, retry, or conversation access disappear from enforcement.

## Proposed structural-review rule

Add this under **Required knowledge**, after its four recurring shapes:

### Call-site narrative

For each new or changed module interface, write one normal call site before reading its implementation. Read it in execution order.

The call site passes only if:

1. **Intent is visible.** Names state the domain action and the role of each input.
2. **Mechanics are absent.** The caller does not coordinate registration, credentials, storage, caches, adapters, or registry order.
3. **Hazards remain enforced.** Hidden auth, approval, retry, ordering, redaction, and access rules move to enforcement tiers 1–3. They do not move only to comments.
4. **The vocabulary ledger is negative.** Count every module, helper, intermediate type, lifecycle rule, and ordering fact the caller must know. The interface must remove more names than it adds.
5. **The module is deep.** Each public verb hides a coherent policy or operation. Reject a wrapper that mostly forwards parameters or mirrors another interface.
6. **The words survive a change probe.** Add the next caller, interaction mode, remote executor, or policy. The new domain case should change one owner, and missed handling should fail statically or at the owning boundary.

“Poetry” is the result when these six checks pass. It is not a separate style score.

## PR #633 application

The new `ToolRunContext` improves the interface because `caller` and `interaction` state product facts. Moving it to `@alfred/contracts` also gives chat, background, dispatch, and future remote ingress one cross-boundary vocabulary.

The remaining change probe is remote execution. “Remote” is an execution location, not an interaction mode. Remote ingress should parse its protocol data, then map it to the same domain context used by local runs. Do not add `remote` beside `live_chat | background` unless remote execution changes tool eligibility by itself.

This PR now applies the call-site rule in four places:

- A workflow binds stable facts once with `toolRuntimeForRun(...)`. Its model path then reads `tools.preload(...)` and `tools.forModel(...)`.
- Dispatch receives the same explicit `ToolRunContext`. It does not infer live chat from `threadId`. `threadId` is now only a conversation address.
- `restoreToolSurface(...)` uses an explicit source: `kernel`, `exact`, or `legacy`. The caller cannot make a legacy merge by leaving fields undefined.
- `selectToolPreload(...)` returns the selected tools and prompt size in one async result. The workflow does not coordinate a public two-step preload plan for telemetry.

The dispatch input is also a discriminated union. A boss caller must carry `caller: "boss"`; a sub-agent caller must carry `caller: "sub_agent"`. TypeScript rejects a mismatch before execution.

The seam is still narrower than its name can suggest. `tool-runtime` owns the model-visible tool surface, restoration, catalog lookup, and preload selection. `dispatch` still owns execution, approval, retry, and result routing. Also, built-in tools still provide one adapter through boot registration. These are valid remaining boundaries, but a later change must either deepen `tool-runtime` to own execution policy or keep its public description limited to model tool selection.

`toolNamesForIntegrations` is still a catalog query, not a run action. If the catalog grows more public operations, move them behind a separate read interface. Do not add a fluent facade over forwarding functions.

## Sources

- [Swift API Design Guidelines](https://www.swift.org/documentation/api-design-guidelines/)
- [Eric Evans, DDD Reference](https://www.domainlanguage.com/ddd/reference/)
- [D. L. Parnas, module decomposition paper](https://dl.acm.org/doi/10.1145/361598.361623)
- [John Ousterhout, modular design lecture notes](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php%3Ftopic%3DmodularDesign)
- [Martin Fowler, Fluent Interface](https://martinfowler.com/bliki/FluentInterface.html)
- [Rust API Guidelines, Dependability](https://rust-lang.github.io/api-guidelines/dependability.html)
- [TypeScript Handbook, Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Zod, Basic usage](https://zod.dev/basics)
