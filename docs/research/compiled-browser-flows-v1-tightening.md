# Compiled browser flows v1 — architecture and contract tightening

**Date:** 2026-07-24  
**Question:** Does `docs/plans/compiled-browser-flows-v1.md` make technical sense, and what should be
tightened before implementation?  
**Scope:** browser substrate, Playwright/CDP semantics, selector durability, security/isolation,
compilation and replay, persistence/resume/idempotency, repair, observability, and the named reference
projects.  
**Source discipline:** external claims below use owning-project documentation/source, standards, and
primary research only. Repository observations are from the plan and Alfred's current source tree.

## Bottom line

The architecture is directionally sound: a versioned, declarative browser program interpreted by a
durable executor is a much better v1 boundary than replaying model-authored JavaScript. The plan is
not yet an executable safety/runtime contract, though. Six issues should be resolved before the
vertical slices start:

1. **Choose one browser API contract.** The plan mixes `agent-browser`, Playwright locators, and
   Playwright Test's `toMatchAriaSnapshot()` as though they were one runtime. They are not.
2. **Move a small security contract into v1.** Logged-out browsing removes credential custody, but
   does not bound egress, SSRF, unwanted public-side effects, resource abuse, or a poisoned repair
   revision.
3. **Define crash/retry semantics per browser action.** A durable DAG step is not automatically an
   idempotent browser effect. A timed-out click can have succeeded.
4. **Pin every run to an immutable compiled-flow revision and make repair promotion explicit.** A
   repair revision must not silently change the program under a waiting or retrying run.
5. **Replace "Zod in JSON" and clarify extraction cost.** Store a JSON Schema or a versioned contract
   reference; split deterministic DOM extraction from LLM extraction.
6. **Do not use LinkedIn or Reddit as the first acceptance fixture.** LinkedIn's current User
   Agreement expressly prohibits scraping/copying with scripts/robots and unauthorized automated
   access. A public page is not an automation license.

The highest-leverage rewrite is to add a normative **Compiled Flow Runtime Contract** to the plan:
artifact format/version, engine/version pin, origin policy, node lifecycle, timeout/retry/outcome
semantics, revision pinning, and evidence emitted by every node.

## P0 — tighten before implementation

### 1. Decide whether the interpreter is Playwright-native or `agent-browser`-native

The plan names `vercel-labs/agent-browser` as the production model, a Playwright base image in
development, Playwright locators for replay, and Playwright Test's `toMatchAriaSnapshot()` for
assertions. Those abstractions do not compose automatically:

- Playwright's locator API re-resolves the element on every action and provides strictness,
  auto-waiting, and actionability checks. `click()` waits for exactly one visible, stable, enabled
  element that receives events ([Playwright locators](https://playwright.dev/docs/locators),
  [actionability](https://playwright.dev/docs/actionability)).
- `toMatchAriaSnapshot()` is a Playwright Test assertion over a Playwright `Page` or `Locator`; the
  matcher retries until its assertion timeout and supports ordered partial matching, regexes, and
  `/children` modes ([Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots),
  [LocatorAssertions API](https://playwright.dev/docs/api/class-locatorassertions)).
- `agent-browser` exposes a CLI/native-daemon accessibility snapshot with ephemeral `@eN` refs,
  semantic `find`, and its own snapshot diff. Its own instructions say to re-snapshot after actions
  because old refs may be stale
  ([agent-browser instructions at commit `83e4151`](https://github.com/vercel-labs/agent-browser/blob/83e415154c6b846a224cd9458765da006fc1e578/packages/%40agent-browser/eve/extension/instructions.md),
  [README](https://github.com/vercel-labs/agent-browser/blob/83e415154c6b846a224cd9458765da006fc1e578/README.md)).
- Attaching Playwright to a browser over CDP would not erase this distinction. Playwright documents
  `connectOverCDP()` as Chromium-only and "significantly lower fidelity" than its Playwright protocol
  connection ([BrowserType API](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)).

**Recommendation:** use Playwright directly inside both the local container and Vercel Sandbox for
v1. Build a small typed RPC/command adapter around the same Playwright implementation in both
environments. This gives the interpreter the exact locator, actionability, ARIA matcher, tracing, and
browser-context semantics named in the plan. Keep `agent-browser` as a substrate feasibility
reference or initial spike, not as an implicit second automation API.

If the owner prefers `agent-browser`, make that explicit and remove `toMatchAriaSnapshot()` from the
contract; implement and test Alfred's own snapshot matcher over `agent-browser` output. Do not attach
Playwright over CDP merely to obtain one assertion API.

Pin the engine tuple in every flow revision:

```ts
engine: {
  adapter: "playwright";
  adapterVersion: string;
  browser: "chromium";
  browserRevision: string;
  snapshotFormatVersion: number;
}
```

CDP tip-of-tree changes frequently and does not guarantee backward compatibility, while the stable
1.3 protocol is only a small subset ([Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)).
Engine pinning plus compatibility tests is therefore part of determinism, not dependency hygiene.

### 2. A v1 security section is still load-bearing

Vercel's Firecracker microVM gives strong host isolation, but **network access is unrestricted by
default**. Vercel now supports deny-by-default egress policies using TLS SNI and CIDR matching, and
can change the policy at runtime
([Vercel Sandbox](https://vercel.com/docs/sandbox),
[egress firewall announcement](https://vercel.com/changelog/advanced-egress-firewall-filtering-for-vercel-sandbox)).
The plan currently accepts default-open egress while arguing that logged-out state makes the blast
radius only a logged-out browser. Those are different boundaries.

Logged-out automation can still:

- reach arbitrary public or private-address targets;
- follow redirects, subresources, iframes, popups, workers, and WebSockets outside the intended
  origin set;
- trigger public-side effects or abuse unauthenticated endpoints;
- spend CPU, memory, bandwidth, or create downloads;
- poison the repair agent into minting a durable malicious revision.

Primary security research supports treating this as an execution-authorization problem, not only a
prompt-filter problem. `The Hidden Dangers of Browsing AI Agents` demonstrates prompt injection,
domain-validation bypass, and credential exfiltration in Browser Use and recommends defense in depth
([arXiv:2505.13076](https://arxiv.org/abs/2505.13076)). `WAAA!` expands the threat model beyond prompt
injection to traditional web attacks and reproduces attacks across four model families
([arXiv:2605.05509](https://arxiv.org/abs/2605.05509)). The plan's cited
`Building Browser Agents` likewise argues for specialized tools with programmatic constraints
([arXiv:2511.19477](https://arxiv.org/abs/2511.19477)).

Add these v1 invariants:

1. `allowedOrigins` is part of the immutable flow revision. The network firewall enforces it for all
   browser traffic, not only top-level `browser_navigate`.
2. Navigation validates scheme, normalized host, port, redirects, popup targets, and frame origins.
   Default-deny `file:`, `data:`, browser-internal URLs, private/link-local CIDRs, downloads, uploads,
   extensions, and arbitrary CDP endpoints.
3. Build the runtime image/snapshot before the run; start the actual browser session with the
   per-flow allowlist. Never use `allow-all` during page execution.
4. Do not inject the Vercel access token, Alfred credentials, Railway URLs, or model keys into the
   sandbox. Vercel documents access tokens as the authentication path from non-Vercel environments;
   that token belongs only in the trusted orchestrator
   ([Vercel Sandbox authentication](https://vercel.com/docs/sandbox)).
5. Enforce per-run limits: wall time, commands, pages/popups, redirects, response bytes, download
   bytes, extraction bytes, and outbound requests.
6. Route **every** interpreter action through the same policy decision used by live tools. A
   whitelisted primitive is not automatically an approved target/action.
7. A repair-produced revision lands as `draft`. It must pass replay/evals and be promoted atomically;
   sensitive or newly widened origin/action scopes require HIL.

For local development, the stock Playwright Docker image is not by itself the security boundary.
Playwright explicitly says the image is for testing/development and is not recommended for untrusted
sites; for crawling it recommends a non-root user plus its seccomp profile
([Playwright Docker](https://playwright.dev/docs/docker)). The dev slice should specify
`pwuser` + Chromium sandbox/seccomp, `--init`, bounded resources, no host networking, and a
default-deny proxy/firewall. Do not use `--add-host=hostmachine:host-gateway` for this service.

### 3. Browser actions need durable **effect** semantics, not only durable steps

The plan says the existing executor already supplies retries and checkpoints, but does not specify
what a retry means for each browser node. HTTP defines safe and idempotent methods separately; a
client cannot infer that an arbitrary application action is idempotent simply because it was
replayed ([RFC 9110, §§9.2.1–9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2)).
A browser click can submit a form, vote, react, enqueue work, or navigate via a POST. If the worker
loses its connection after the site accepted the click but before Alfred commits the step, the
outcome is `unknown`, not `failed`.

Give every node an explicit effect class and recovery contract:

```ts
effect: "read_only" | "browser_local" | "external_effect";
retry: "safe" | "reconcile_then_retry" | "never_automatic";
precondition?: Assertion[];
postcondition: Assertion[];
timeoutMs: number;
```

- `browser_navigate`, scoped assertions, and pure reads may usually be retried after a new ephemeral
  browser is constructed.
- input should be `browser_fill` by default, not ambiguous `browser_type`. Playwright's `fill()` sets
  the value and emits an input event; `pressSequentially()` sends key events character by character
  and can append on retry ([Locator `fill` and `pressSequentially`](https://playwright.dev/docs/api/class-locator#locator-fill)).
- `browser_click` is not retryable by default. Classify it at compile time, require a postcondition,
  and on ambiguous termination either reconcile from an independently observable state or park for
  repair/HIL.
- Never force an action through failed actionability checks in deterministic replay.

Persist a node attempt **before** execution, then commit its result and postcondition evidence after
execution. On restart, an in-progress `external_effect` attempt becomes `unknown`; it does not
silently rerun. Retrying must reuse a stable logical effect ID, separate from attempt number.

### 4. Pin immutable revisions and separate repair from activation

The artifact being append-only is useful, but the run contract needs to say which revision it
executes:

- Persist `compiledFlowRevisionId` on the run at dispatch.
- Resolve all node definitions, policies, variables schema, and engine version from that immutable
  revision for the run's lifetime.
- Edits and repairs affect future runs only. A waiting run resumes its pinned revision unless a
  deliberate migration record says otherwise.
- Repair writes a child revision with `parentRevisionId`, `createdByRunId`, `repairReason`,
  changed-node IDs, source evidence, eval results, and policy diff.
- Promotion from draft to active is a compare-and-swap against the expected current revision.
  Concurrent repairs must not last-write-win.
- Rollback changes the active pointer for future runs; it does not rewrite historical run meaning.

This likely argues for a dedicated `compiled_flow_revisions` table or an explicit typed
`skill_revisions.executable` sibling column rather than burying an evolving executable protocol in
generic `metadata`. Alfred's current `skillRevisions.metadata` documents presentation/mount metadata,
and its `kind` values are prose lifecycle kinds. A dedicated table gives schema versioning,
constraints, indexes, revision parentage, activation state, and run foreign keys a clear owner.

### 5. The stored extraction schema cannot be a Zod object

`jsonb` cannot carry executable Zod schema instances. Zod 4 can emit JSON Schema with
`z.toJSONSchema()`, but several Zod types—including transforms, dates, maps, sets, custom types, and
`undefined`—have no sound JSON Schema representation and conversion throws by default
([Zod JSON Schema](https://zod.dev/json-schema)).

Store one of:

- a constrained JSON Schema dialect plus `schemaVersion`; or
- a versioned registry key pointing to a code-owned schema.

Validate the schema at compile time and validate extracted output again at the execution boundary.
Do not round-trip arbitrary JSON Schema through `z.fromJSONSchema()` as the primary contract; Zod
currently marks that API experimental.

Also split:

- `browser_extract_dom`: deterministic selectors/attributes/text/table mapping, zero LLM;
- `browser_extract_llm`: explicit model, prompt/intent, JSON Schema, token/output limits, metering,
  and provenance.

As written, the one-line claim "replay ... with zero LLM turns" is false for a flow containing
`browser_extract`, and direct extraction inference might bypass the existing `AlfredAgent.turn()`
metering row. The compiler should compute and persist `costClass: zero_llm | may_call_llm`; the UI,
scheduler, and cost accounting should use it.

### 6. Change the first real flow away from LinkedIn/Reddit

LinkedIn says public-group posts can be viewed by people who are not signed in
([LinkedIn group types](https://www.linkedin.com/help/linkedin/answer/a548061)), but its User
Agreement separately prohibits scraping/copying the service with scripts/robots and unauthorized
automated access
([LinkedIn User Agreement, §8.2](https://www.linkedin.com/legal/user-agreement)).
Visibility does not grant automation permission.

Use a first-party fixture site that deliberately simulates:

- static and virtualized lists;
- delayed content and navigation;
- iframes/shadow DOM;
- selector drift between fixture revisions;
- an ambiguous submit outcome;
- prompt-injection text;
- redirects/popups to a disallowed origin.

Then use a real public target whose terms/robots/API explicitly allow the intended automation. Keep
LinkedIn/Reddit out of the acceptance criterion unless there is a permitted first-party API or
written authorization.

## P1 — tighten the compiled artifact and interpreter

### 7. Replace the vague "fat selector bundle" with a typed ordered locator plan

The current workflow-use source does not support the exact claim in the plan. At commit
`fa53b3d`, its selector generator emits these strategy types:

`text_exact`, `role_text`, `aria_label`, `placeholder`, `title`, `alt_text`, `text_fuzzy`, and
`xpath`; its constructor defaults `max_total_strategies` to **2**, despite a docstring describing ten
reliability categories
([selector generator source](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/healing/selector_generator.py)).
Its workflow-creation prompt also says not to output `cssSelector`, `xpath`, or `elementTag` in the
generated workflow and prefers `targetText`/`elementHash`
([workflow creation prompt](https://github.com/browser-use/workflow-use/blob/fa53b3d4e49356f81f3c70496d54a465da30e93d/workflows/workflow_use/healing/prompts/workflow_creation_prompt.md)).
The project README itself warns that it is early development and not recommended for production
([workflow-use README](https://github.com/browser-use/workflow-use/tree/fa53b3d4e49356f81f3c70496d54a465da30e93d)).

Alfred should own a versioned locator grammar rather than copying undocumented fields:

```ts
locatorPlan: {
  scope: {
    origin: string;
    urlPattern: string;
    framePath?: FrameLocatorSpec[];
    region?: LocatorStrategy;
  };
  strategies: Array<
    | { kind: "role"; role: string; name: TextMatcher }
    | { kind: "label"; text: TextMatcher }
    | { kind: "text"; text: TextMatcher; exact: boolean }
    | { kind: "placeholder"; text: TextMatcher }
    | { kind: "test_id"; value: string }
    | { kind: "css"; value: string }
    | { kind: "xpath"; value: string }
  >;
  cardinality: "exactly_one";
}
```

For every attempt, record which strategy matched, candidate count, resolved accessible
role/name/text, bounding box, frame, and post-action URL. A fallback is successful only if it resolves
exactly one candidate and the node's semantic precondition passes. Do not persist `@eN`, AX node IDs,
CDP node IDs, or backend node IDs as cross-run identities; CDP defines them as identifiers in the
current inspected document/session, not semantic identities
([CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
[CDP DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)).

### 8. Make assertions semantic and distinguish drift from runtime failure

Scoped, partial ARIA snapshots are a good **component-state** assertion. Playwright matching is still
ordered, and large/dynamic snapshots have the normal snapshot-maintenance problems. Add targeted
assertions for invariants that matter:

- URL/origin and page title;
- exactly-one target;
- visible/enabled/editable state;
- exact/regex text or value;
- count bounds;
- a postcondition such as target disappeared, toast appeared, URL changed, or extracted IDs changed.

Use this failure taxonomy:

```text
infrastructure | navigation | policy_denied | timeout | target_missing |
target_ambiguous | actionability | assertion_mismatch | extraction_invalid |
external_effect_unknown
```

Only `target_missing`, `target_ambiguous`, or a confirmed semantic assertion mismatch should enter
locator repair. A sandbox boot failure, DNS failure, policy deny, transient CDP disconnect, or
ambiguous external effect is not selector drift.

ARIA snapshots should specify their Playwright matching mode literally (`contain`, `equal`, or
`deep-equal`) rather than inventing a parallel `match` field unless Alfred's adapter deliberately
maps and versions it. Keep a targeted assertion alongside the broader snapshot so a permissive
partial snapshot cannot silently bless the wrong semantic element.

### 9. Record execution evidence, not only canonical tool inputs

`packages/ai/src/replay/trajectory.ts` intentionally stores `(toolName, canonical input, status,
error)` for regression diffs. That is insufficient as a browser compiler input. The recorder also
needs:

- start/end URL and origin, redirect chain, page/tab and frame path;
- browser/viewport/locale/timezone/user-agent;
- the full ordered locator candidates considered;
- the actually resolved element evidence;
- precondition and postcondition observations;
- navigation/download/popup/dialog effects;
- action timing and actionability waits;
- extracted value plus source provenance;
- explicit user/model decision versus normalized executed input.

Compilation should reject rather than guess when the trajectory lacks enough evidence to prove a
stable locator and postcondition.

### 10. Define the DAG and loop execution model

Alfred's current schema discriminates on `kind`, not `type`, and existing nodes already carry `id`
and explicit edges. Keep one discriminator. Add a top-level artifact schema:

```ts
{
  formatVersion: number;
  entryNodeId: string;
  parametersSchema: JsonSchema;
  outputSchema?: JsonSchema;
  engine: EnginePin;
  allowedOrigins: string[];
  limits: RunLimits;
  nodes: BrowserWorkflowNode[];
}
```

Validation at publish time must reject duplicate/missing IDs, dangling edges, unreachable nodes,
illegal cycles, unbounded loops, undeclared variables, incompatible output references, and paths
that can skip required HIL.

Persist the execution program counter and loop state by stable logical identity:

```text
(run_id, revision_id, node_id, loop_path, logical_effect_id, attempt)
```

`loop_path` must identify the iteration from stable item keys where possible, not only array
position. Define maximum iterations, maximum total node executions, and whether a resumed loop uses
the captured input collection or re-reads the page. For deterministic replay, capture/validate the
collection boundary before entering the loop.

## P1 — substrate lifecycle, cost, and observability

### 11. Make each run non-persistent; use only an immutable base snapshot

Vercel now distinguishes session duration from sandbox persistence. Current documentation says
`Sandbox.create()` defaults to a five-minute session, persistence defaults to true, and snapshots
capture the filesystem and installed packages
([Vercel duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)).
That is a mismatch with the plan's intended "ephemeral" browser unless configured.

Use:

- one immutable, reviewed base snapshot with browser + exact dependencies, created before any user
  navigation;
- `persistent: false` (or the equivalent current SDK option) for every browser run;
- a fresh browser context and user-data directory per run;
- explicit `finally` cleanup, plus a reaper for leaked active sandboxes;
- no snapshot of a live page session and no session-name/profile/state persistence.

`agent-browser`'s own Vercel example says a fresh run otherwise installs dependencies and Chromium,
while a prebuilt sandbox snapshot makes startup sub-second
([environment example](https://github.com/vercel-labs/agent-browser/blob/83e415154c6b846a224cd9458765da006fc1e578/examples/environments/README.md)).
Benchmark four phases independently: sandbox create/restore, browser launch, first CDP/Playwright
connection, and first page ready. "MicroVM starts in milliseconds" does not measure the latter three.

The `iad1`-only claim should be removed unless it can be linked to current Vercel documentation; the
current general Sandbox documentation reviewed here does not state that limitation. Treat region as
an observed field in the spike and pin only if the SDK exposes a supported region choice.

The "$0" claim should be expressed as a measured budget, not an architectural fact. Current Vercel
pricing includes five sandbox active-CPU hours, 420 GB-hours of provisioned memory, 5,000 creations,
20 GB network, ten concurrent sandboxes, and 15 GB snapshot storage on Hobby, then separately meters
those dimensions ([Vercel pricing](https://vercel.com/pricing)). Record all four relevant quantities
per run: active CPU, provisioned-memory wall time, outbound bytes, and creation count.

### 12. Specify observability and evidence retention

Emit one structured event per node attempt with:

- run/revision/node/loop/effect/attempt IDs;
- engine and base-snapshot versions;
- start/end URL, origin, page, frame;
- chosen locator strategy, candidate count, resolved-element evidence;
- actionability wait and timeout;
- assertion/extraction result and bounded provenance;
- redirects, popups, downloads, dialogs, and policy denies;
- failure taxonomy, retry decision, and repair revision link;
- sandbox ID, launch timings, browser exit reason, and resource counters.

Capture a bounded failure bundle: screenshot, scoped DOM/ARIA snapshot, console errors, relevant
network failures, and optionally a Playwright trace. Playwright traces can include DOM snapshots,
screenshots, network activity, console output, and timing
([Playwright tracing](https://playwright.dev/docs/api/class-tracing),
[Trace Viewer contents](https://playwright.dev/mcp/tools/tracing)). Those artifacts are page-content
custody even in a logged-out flow. Define redaction, encryption/access, maximum size, and retention;
do not put raw trace payloads into `agent_runs.transcript` or the passthrough path.

Extraction must always return:

```ts
{
  value: unknown;
  matched: boolean;
  sourceCount: number;
  sources: BoundedSourcePointer[];
  validation: "valid" | "invalid";
  truncated: boolean;
}
```

Empty, invalid, or truncated output is a typed outcome, never an apparently successful empty result.
The passthrough thermometer is useful for transcript/model transport, but it is not the browser
artifact store, schema validator, or evidence contract.

## Suggested revised build gates

1. **Contract fixture, not a real third-party site:** Playwright adapter in local hardened Docker;
   typed URL/origin policy; action result/failure taxonomy; fixture covers frames, virtualization,
   drift, redirects, popup, and ambiguous submit.
2. **Vercel parity:** same adapter and browser pin from an immutable base snapshot; `persistent:
   false`; default-deny egress; no secrets; startup/resource benchmark.
3. **Recorder/compiler:** evidence-rich trajectory; strict compile rejection; versioned JSON artifact;
   deterministic DOM extraction only.
4. **Durable replay:** revision-pinned run, program counter/loop state, logical effect IDs, unknown
   outcome handling, cancellation fence, and crash-injection tests at every pre/post checkpoint.
5. **Repair:** failure taxonomy routes only true drift; repair creates draft child revision; eval and
   compare-and-swap promotion; policy widening requires HIL.
6. **Real permitted read-only target:** zero-LLM replay with provenance, bounded cost, and explicit
   terms/API permission. Add LLM extraction later as a separately metered node kind.

## Decision summary

| Area | Plan direction | Tightened verdict |
|---|---|---|
| Declarative DAG vs model-authored JS | Correct | Keep; add artifact/runtime versioning and graph validation |
| Vercel Firecracker isolation | Correct substrate | Add default-deny egress, non-persistent runs, secret separation, limits |
| `agent-browser` + Playwright | Ambiguous | Pick one API; Playwright-native is the cleanest match to named semantics |
| Selector bundle | Under-specified and misattributed | Own a typed ordered locator plan; never persist session refs/node IDs |
| Scoped partial ARIA assertions | Good supporting signal | Pair with targeted semantic pre/postconditions and failure taxonomy |
| Durable retries | Incomplete | Effect identity, `unknown`, reconciliation, and no blind click retry |
| Skill revisions | Useful concept | Pin run revision; dedicated executable revision storage is cleaner |
| Self-heal | Valuable differentiator | Draft child revision + eval + atomic promotion, never silent auto-activation |
| `browser_extract` | Contradictory | Split deterministic DOM and metered LLM extraction; JSON Schema, not Zod |
| Zero-LLM cost | True only for a subset | Persist `costClass`; meter direct extraction calls |
| First LinkedIn/Reddit flow | Poor acceptance target | Replace with owned fixture, then a permitted public target |

