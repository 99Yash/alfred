# General Invocation Tier v1 — read-only passthrough (breadth)

**Status:** PRD / ready-for-agent · **Date:** 2026-07-19
**ADR:** designs the rung-(a) of **ADR-0074** (currently FRAMED → becomes DESIGNED for rung-a). Inherits ADR-0071 #6 (result-honesty) and ADR-0070 (sanitizer). Epic: **#271**.
**Grilled:** 2026-07-19 (`batch-grill-me` → `to-prd`), tightened in a second implementation-readiness pass. Design tree walked in full; architecture settled below.

---

## Problem Statement

When the user asks Alfred to do something that touches an integration endpoint the team never curated a tool for, the boss simply can't reach it — and worse, it often *lies about the absence* rather than admitting it can't look. Real incidents:

- The morning digest reported **"no new deployments"** because there was no tool to read the relevant Railway field — a confident zero for a *reach* reason, not a real one.
- Gmail's user labels **are Alfred's own triage tags** (`4: awaiting reply`, `5: meeting`, `6: fyi`, …) that the ingestor writes, yet the chat boss cannot list, read, or reconcile them — a close-the-loop gap with no curated tool.
- The long tail generally: "what properties does this Notion database have," "show me this repo's latest workflow runs," "what regions is this service in" — all reachable in the underlying API, none curated.

The curated typed tier (ADR-0071) is deliberately small and sized to the hot path. It should not grow into an API mirror (unmaintainable, and it can't cover the prose-only DSL layer anyway). So there is a permanent long tail the boss cannot honestly serve today.

## Solution

Give the boss a **general, read-only invocation tier**: one raw passthrough tool per integration that lets it issue an *uncurated* read against that integration's real API, using the credentials and transport Alfred already holds. The boss composes the request (method + path + params, or a GraphQL query); Alfred's trusted boundary enforces that the call is **read-only**, executes it, and returns a **structured, honest envelope** (real HTTP status + body) so the boss never mistakes a wrong-path error for "nothing exists."

Safety is structural, not label-based: a **fail-closed per-integration read gate** is the only thing standing between a prompt-injected request and a destructive call, so it denies by default. Results are bounded and sanitized (reusing existing shared helpers), and when a result is clipped the tier emits a **structured "handle-eligible" thermometer signal** so we can *measure* when the raw firehose starts hurting real workflows — the trigger to build the object-handle layer (L0) as a fast-follow rather than speculatively now.

This is **breadth only**. It needs **no sandbox, no Cloudflare, no MCP** — it runs as portable TypeScript on the existing Railway + R2 + Vercel-AI-SDK stack, through the existing dispatch layer.

## User Stories

1. As the user, I want the boss to read a Railway field we never curated (e.g. a deployment detail), so that the digest never again reports "no new deployments" for a reach reason.
2. As the user, I want the boss to list and read my Gmail labels, so that it can reconcile against its own triage tags instead of being blind to them.
3. As the user, I want the boss to inspect a Notion database's properties/schema, so that I can ask questions about structure we never modeled a tool for.
4. As the user, I want the boss to fetch a GitHub repo's recent workflow runs / commits / releases, so that I get repo-scoped answers without waiting for a curated tool.
5. As the user, I want the boss to query a Vercel project/deployment detail on demand, so that the long tail of "just look it up" works.
6. As the user, when I ask for something in the API but uncurated, I want the boss to *attempt the nearest real read* rather than bail to me, so that it behaves like it has full read access.
7. As the user, when the boss's raw call fails (bad path/params), I want it to say "I couldn't read that / that call errored," not "there is nothing," so that I'm never misled by a confident zero.
8. As the user, I want the boss to correct-and-retry an uncurated read that came back empty-for-a-suspicious-reason, so that a single fumbled param doesn't end the task.
9. As the operator, I want every passthrough call to be read-only-enforced at Alfred's boundary regardless of what method the model asked for, so that a prompt-injected request can never issue a write/delete.
10. As the operator, I want the read gate to **fail closed on authority and method** — the model cannot choose an origin or headers, non-read methods are denied, and read-via-POST paths are explicitly allowlisted — while new GET/HEAD endpoints on a pinned provider remain reachable without curation.
11. As the operator, I want GraphQL passthrough (Railway) to reject any document containing a `mutation` or `subscription`, so that read-only holds even though GraphQL is all-POST.
12. As the operator, I want REST passthrough to honor a per-integration allowlist that includes legitimate **read-via-POST** endpoints (Notion query, search), so that the gate is neither too permissive nor blocking real reads.
13. As the operator, I want the gate to reflect **auth-scope reachability honestly** — e.g. GitHub `/notifications` 403s under the App-installation token because it's user-scoped — so that the boss gets a truthful "not reachable under current auth," not a mysterious failure.
14. As the operator, I want each passthrough tool behind a visible, per-user Settings preference that defaults off, so that I can dark-launch and enable/kill it per integration without a deploy if a gate bug surfaces.
15. As the operator, I want the passthrough tools to be **lazy** (found via tool search/load, never in the always-on kernel), so that their definitions cost nothing in the base prompt/transcript.
16. As the operator, I want raw results bounded and null-byte/surrogate sanitized before they enter the transcript, so that a huge or poisoned body can't bloat context or break the jsonb persist.
17. As the operator, I want a structured "truncated N rows/bytes — handle-eligible" signal emitted whenever a passthrough result is clipped, visible in Langfuse, so that I can *see* the context wall being hit and decide when to build the object-handle layer.
18. As the boss (agent), I want a clear per-integration description carrying that API's DSL/param guidance (GitHub qualifiers, Notion filter shape, Railway GraphQL), so that I compose valid reads without guessing.
19. As the boss (agent), I want the passthrough result to tell me the real HTTP status and whether it was truncated, so that I can decide to paginate, narrow, or report honestly.
20. As the developer, I want the read gate and the result-shaper to be **pure, exhaustively unit-tested functions**, so that the security boundary is provable without touching the network.
21. As the developer, I want one end-to-end eval (evalite) proving the boss reaches an uncurated read-only endpoint and reports honestly (no confident-zero on a bad path), so that regressions are caught in CI.
22. As the developer, I want the dispatch seam shaped so the future L0 object-handle layer slots in without rework, so that graduating the thermometer to real handles is a fast-follow, not a refactor.
23. As a maintainer, I want the passthrough tier to stay strictly per-integration (never cloned into a cross-integration "activity" aggregate), so that #422/#428 remains the correct home for that and this tier doesn't drift.

## Implementation Decisions

**Where it lives.** A new general-tier module beside the curated tools, registering one passthrough tool per connected integration through the existing `liveTool()` registry and executing through the existing `dispatchToolCall` boundary. No new dispatch path; reuse the two existing execute paths that already apply `sanitizeToolResult`.

**Per-integration passthrough tools (all ship in v1).** `github.request`, `railway.graphql`, `notion.request`, `gmail.request`, `calendar.request`, `drive.request`, `docs.request`, `sheets.request`, `slides.request`, and `vercel.request`. Each reuses its existing `@alfred/integrations` credential and transport ownership (GitHub App installation token, Railway PAT, Google OAuth, Notion/Vercel bearer). Railway's internal GraphQL transport is refactored so the raw-response path and existing typed callers share the same authenticated fetch primitive rather than duplicating it. Tools are **non-kernel and lazy** (discovered via `system.search_tools`/`system.load_tool`).

**Exhaustive coverage, not a drifting hand-written scope list.** The canonical `LOADABLE_INTEGRATION_SLUGS` remains the source of truth. A shared general-invocation coverage registry must satisfy `Record<LoadableIntegrationSlug, CoverageDecision>`, where every entry is explicitly `supported`, `deferred`, or `not_applicable`. Adding a new integration slug without classifying it is a compile error. A second API-side handler registry is keyed by the type-level subset marked `supported`; changing a coverage decision to `supported` is a compile error until its read gate (`Record<SupportedRestSlug, …>`) and transport kind (`Record<SupportedIntegrationSlug, …>`) are wired — those two exhaustive maps drag the developer into the right files. The remaining links close at other rungs: the preference key is auto-derived from the supported-slug set (nothing to hand-wire), and the actual tool registration + transport-profile builder are enforced by the registration test (tier 4), not the compiler — `PASSTHROUGH_TOOL_ACTION` is keyed by transport-kind, not by slug, so no type forces a supported slug to have a registered `request` tool. The Settings UI renders supported entries from the same registry, so there is no third provider list. v1 classifications:

- `supported`: Gmail, Calendar, Drive, Docs, Sheets, Slides, GitHub, Notion, Railway, Vercel.
- `deferred`: Slack and Linear (no live integration client yet).
- `not_applicable`: iMessage (ingest-only; no provider API passthrough).

**Visible, default-off per-user rollout controls.** The grill settled on "flag-gated"; this deliberately upgrades that to a **visible per-user Settings toggle** rather than a static config flag, for one reason worth naming: a gate bug in a security-sensitive tier must be killable **without a deploy**, and per-integration, and the visible toggle also makes the tier's reach legible to the user. Each supported integration has a shared-contract preference key, label/description, and user-facing toggle under Settings → Features. Absence of a preference row means **off** for this tier (unlike the older background-agent flags). The preference participates in the existing tool-availability snapshot: a disabled tool is omitted from preload/search/load with a structured `feature_disabled` reason, and `dispatchToolCall` rechecks the same availability immediately before execution so a stale active surface cannot bypass a kill switch. Backend gating may land before the UI in the build sequence, but v1 is not complete until the visible controls exist.

**The read gate (the security boundary) — fail-closed, per-integration, structural.** A single pure function decides reachability; it never trusts a caller/author label:

```ts
// Encodes the decision precisely: deny-by-default, per-integration signal.
type ReadGateResult =
  | { ok: true }
  | { ok: false; reason: 'method_not_read' | 'path_not_allowlisted'
        | 'invalid_path' | 'graphql_non_query' | 'graphql_operation_ambiguous'
        | 'auth_scope_unreachable'; detail: string };

function assertReadableRequest(
  integration: Integration,
  request: PassthroughRequest,   // REST {method, path} | GraphQL {document}
): ReadGateResult;
```

- **REST integrations** pin a trusted API namespace and own authentication, provider/version headers, timeout, and redirect policy. The model cannot supply an absolute URL or arbitrary headers. All GET/HEAD paths inside the pinned namespace are allowed so the general tier actually provides breadth; every other method is denied except POST paths on a small, exact per-provider read-via-POST allowlist (for example Notion query/search). Providers with a known side-effecting GET/HEAD endpoint must add it to an explicit denylist before that integration can be marked supported.
- **Path hardening** happens before URL construction: require one namespace-relative path beginning with `/`; reject `//`, schemes/authority, backslashes, dot segments (including encoded variants), encoded slash/backslash ambiguity, fragments, query text embedded in the path, control characters, or any normalized URL whose origin/namespace differs from the handler's pinned base. Query parameters travel only in the separate `query` field.
- **Redirects are never followed.** Handlers use `redirect: "manual"`; a 3xx is an HTTP outcome with `succeeded: false`. Any returned `Location` is redacted to origin + path because signed redirect URLs may carry credentials. Binary/download flows stay in curated tools.
- **GraphQL (Railway)** parses the document into an AST rather than scanning source text. Reject the entire document if it contains a mutation or subscription, even when another operation was selected. Queries and fragments pass; multiple queries require `operationName`; variables must be JSON-compatible. Introspection queries are allowed, but full-schema introspection (`__schema`) always exceeds the body bound and a truncated schema is *misleading*, not merely lossy — so the tool description steers the model to **targeted `__type(name:)`** introspection; a full `__schema` still passes the gate but returns bounded-and-flagged-truncated (see "large-structure reads" below).
- **Auth-scope honesty is a static curated denylist, not a predictive gate.** The gate is pure, so it can only pre-flight-reject the *known* unreachable endpoints it enumerates (e.g. GitHub `/notifications` under an App-installation token → `rejected` / `auth_scope_unreachable`). It cannot predict arbitrary auth-scope failures; every un-enumerated auth failure comes back as an honest `http` envelope with `status: 403, succeeded: false`. Both are honest; the denylist just upgrades the *known* cases to a clearer pre-flight reason.
- **Posture:** deny by default on authority and capability, not on every GET path. The single-user token is broad-grant, so the pinned namespace + method gate + exact read-via-POST allowlist — not the token scope — is the write-safety guarantee.

REST request inputs are deliberately smaller than `fetch`:

```ts
type RestPassthroughRequest = {
  method: 'GET' | 'HEAD' | 'POST';
  path: `/${string}`;
  query?: Record<string, string | number | boolean | readonly string[]>;
  body?: unknown; // accepted only for an allowlisted read-via-POST path
};

type GraphqlPassthroughRequest = {
  document: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};
```

**Honest result envelope (inherits ADR-0071 #6).** Passthrough cannot pre-validate params, so it surfaces the raw outcome and is explicit about non-completion:

```ts
type PassthroughResult =
  | {
      outcome: 'http';          // API answered, including 4xx/5xx
      status: number;           // real status; GraphQL errors may still be HTTP 200
      succeeded: boolean;       // 2xx and, for GraphQL, no errors[]
      body: unknown;            // sanitized + bounded, including API error bodies
      truncation?: PassthroughTruncation;
    }
  | {
      outcome: 'rejected';      // request never left Alfred
      reason: ReadGateReason;
      message: string;
    }
  | {
      outcome: 'transport';     // request left Alfred but no HTTP response arrived
      kind: TransportErrorKind; // timeout | dns | connection_reset | tls
      retryable: boolean;
      message: string;
    };
```

For JSON media types, parse and return JSON. For textual media types, return bounded text. Binary bytes never enter the transcript: represent a binary response with content type plus declared/observed byte count and set `succeeded: false`; actual download/export remains curated. Existing typed credential/re-consent errors retain their established application-error path instead of being flattened into `transport`. **GraphQL partial success:** GraphQL can return `data` *and* `errors[]` in one HTTP-200 response — any non-empty `errors[]` sets `succeeded: false`, but the partial `data` still rides in `body`. The rubric tells the model to read both, so a partial response is neither trusted as complete nor discarded as total failure.

**Large-structure reads truncate — steer to targeted reads, not full dumps.** Some reads are structurally guaranteed to blow the body bound and mislead when clipped: GraphQL `__schema` introspection, and a full `docs`/`sheets`/`slides` document read (the entire element tree / grid). For these the tool descriptions steer to **targeted** reads (a single `__type`, a named range, a metadata/revisions call) and warn that a full dump returns truncated-and-flagged. **Document *content* is the curated tier's job, not passthrough's:** `drive.export_file` (ADR-0071) reads a Google-native file's text into context; the raw `docs`/`sheets`/`slides.request` passthrough is for **structure/metadata** (properties, revisions, permissions, named ranges), not content-as-text. The descriptions state this split explicitly so the model does not reach for the raw structural read when it wants content (the redundant-read-tool confusion that motivated #267).

The tool description carries the rubric: *"This is a raw, unvalidated read. A failed HTTP response or empty result may mean your path/params were wrong — NOT that the thing is absent. Correct once and retry, or state the uncertainty. Never report a raw empty as a confident zero."* The retry policy is deterministic: at most one self-correction per attempt; it must materially change the path, parameters, operation, or pagination; never repeat an identical failed/rejected request; never retry 401/403; **never auto-retry a 429 in-turn — surface the rate limit and stop**; retry transport failures only when `retryable`; after the retry fails or remains suspiciously empty, state uncertainty. A **per-turn passthrough call ceiling** bounds runaway pagination loops (which read as forward progress and would otherwise slip past the ADR-0070 non-progress backstop); exceeding it fails the call with an honest "call budget exhausted this turn" message, not silently.

**Bounding + poison (reuse, don't reinvent).** Compose `sanitizeToolResult` with the existing 8,000-character per-string cap, then apply two general-tier bounds: every array at any depth is capped to its first 50 elements, and the complete returned body is capped to 32 KiB using deterministic structural pruning that always leaves valid JSON. A nested provider list (`items`, `data`, `messages`, `value`, etc.) must be bounded; a top-level-only row cap is insufficient.

```ts
type PassthroughTruncation = {
  handleEligible: true;
  originalBytesApprox: number;
  returnedBytes: number;
  causes: Array<
    | { kind: 'string_chars'; droppedApprox: number }
    | { kind: 'array_items'; droppedApprox: number }
    | { kind: 'body_bytes'; droppedApprox: number }
  >;
};
```

**Thermometer (the L0 trigger).** Every `handleEligible` result emits structured telemetry on the dispatch/tool span: integration/tool, truncation causes, returned/original approximate bytes, dropped items/chars, run id, and whether the HTTP call otherwise succeeded. Reopen the object-handle plan when either (a) at least 3 distinct runs truncate within 7 days, or (b) at least 10% of passthrough calls truncate after a minimum sample of 20 calls. Crossing a threshold causes an operator review, never an automatic architecture switch. The dispatch seam is shaped so L0 replaces "clip + notice" with "spill + handle" without touching callers.

**Dispatch wiring — a gate `rejected` is a visible result, `feature_disabled` is hidden plumbing.** These route *oppositely* and it is easy to get wrong. A read-gate `rejected` (`outcome: 'rejected'`) is a **normal, successful tool execution whose value is the rejection envelope** — the boss must *see* it to self-correct ("that path is a write; try the read endpoint"). It must **not** be mapped onto dispatch's `not_allowed` / `invalid_input` `nonExecution` kinds, which are structurally hidden from the chat UI across all four surfaces (the tool-card channels *and* the narration channel). Conversely, a `feature_disabled` rejection (the user turned this tier off; a stale active surface tried to call it) **is** correct `nonExecution` plumbing — hide it, because the model should not narrate a capability the user disabled. One is model-facing signal; the other is invisible enforcement.

**Per-integration, never cross-integration.** These tools are strictly per-integration. "What happened across ALL my integrations" is a *different* architectural layer (#422 Context Fabric / #428 source adapters) and must never be served by cloning passthrough into an aggregate.

## Testing Decisions

Good tests assert external behavior at three deterministic seams and never hit a real provider in CI:

- **Coverage + availability** — compile-time fixtures and runtime assertions prove every `LoadableIntegrationSlug` has a coverage decision, every supported slug has exactly one handler/tool/preference definition, deferred/not-applicable slugs expose none, unset preferences disable the tool, disabled tools are absent from discovery/load, and dispatch re-rejects a stale active tool with `feature_disabled`.
- **Read gate (`assertReadableRequest`)** — exhaustive table tests, the highest-value seam because it is the security boundary: same-namespace GET/HEAD allowed without endpoint curation; DELETE/PATCH/PUT and unlisted POST rejected; known read-via-POST allowed; scheme-relative/absolute/dot-segment/encoded traversal/query-in-path/control-character inputs rejected; redirects not followed; Railway query/introspection allowed while mutation/subscription/mixed documents reject; multiple queries require `operationName`; GitHub known user-scoped endpoint returns `auth_scope_unreachable`.
- **Result shaper / envelope** — real HTTP status and API error body preserved; GraphQL HTTP-200 `errors[]` produces `succeeded: false`; **GraphQL partial success (`data` + `errors[]`) sets `succeeded: false` yet keeps the partial `data` in `body`**; gate denial produces `rejected`; timeout/DNS/reset/TLS classification produces `transport`; JSON and text handled; binary omitted; null-byte/surrogate sanitization composes with string, nested-array, and total-body bounds; simultaneous truncation causes survive in one `PassthroughTruncation`.
- **Retry + budget policy** — a 401/403 is not retried; a 429 is surfaced and **not** auto-retried in-turn; a retryable `transport` is retried at most once with a materially changed request; an identical failed/rejected request is never re-issued; exceeding the per-turn passthrough call ceiling fails with an explicit "budget exhausted" message rather than silently.
- **Dispatch routing of rejections** — a read-gate `rejected` is a visible tool result the boss can read and self-correct from (asserted present on the model-facing surfaces), while a `feature_disabled` call on a stale active surface is `nonExecution`-hidden (asserted absent from the chat-UI surfaces) — the two route oppositely.
- **Per-provider adapter contract tests** — mocked transport and credential resolution prove fixed namespace/auth/version headers, no model-controlled headers or authority, separate query encoding, POST body only on an allowlisted read path, manual redirects with redacted `Location`, timeout use, and faithful handoff to the common result shaper. These are a third seam; existing curated-client tests do not cover the new raw adapters.
- **End-to-end honesty (evalite, ADR-0055 lane)** — one eval mirroring `github-grounding.eval.ts`: the boss discovers/loads and reaches an uncurated read-only endpoint; a deliberately bad path does not yield a confident zero; a suspicious failure gets at most one materially changed retry; a write path is rejected and reported honestly.
- **Live enablement gate** — before enabling a default-off preference for any supported integration, run one real read smoke test against that integration and record the result. Vercel or any other unconnected provider remains implemented but disabled until credentials exist for this proof.

The tool `execute` bodies stay thin (preference/availability → credential → gate → provider adapter → common shaper), but their transport contract is explicitly tested rather than assumed.

## Out of Scope

- **Writes / mutations of any kind.** v1 is read-only; write passthrough stays in the curated typed tier where per-action risk tiers and approval (ADR-0069) apply.
- **BYO-MCP (MCP client import).** Deferred: a third-party server's read-only claim (`readOnlyHint`) is author-supplied and untrusted, and can't be structurally enforced without network-egress control — i.e. the sandbox problem. The registry (`metadata-defaults.ts`) is already shaped to accept imported tools later. **We do not build an MCP *server*** — the registry's Zod→JSON-Schema already *is* the structured API; wrapping our own tools in MCP to consume them back would be a pointless lossy round-trip.
- **Typed-binding / `declare const` generator.** A Code-Mode artifact for model-authored code. Breadth passthrough is a normal structured tool call and needs no binding.
- **Object handles / context virtualization (L0).** Evidence-gated. Ship the cap + thermometer now; build L0 (dispatch-boundary spill-to-object-store + `read_object`) as a fast-follow only after one of the numeric thermometer thresholds above triggers operator review. Reopen sketch already lives in `docs/plans/context-working-set-considered.md`.
- **Composition / Code Mode / `code.run` over handles (L1/L2/L3).** All behind a code-execution sandbox, deferred behind "prove the pain first" (sub-agent fan-out and the lazy tool surface are the partial substitutes). Sandbox direction, when picked up: `node:vm` never; isolated-vm or a Deno subprocess for L1 (data-only, no egress); L2 (code that calls tools) is dominated by egress + capability-injection control → prefer a Deno OS-allowlist or **call CF / self-syncing-agent as a service** rather than rebuild isolation in Elysia ("don't pay the sandbox tax twice"). Single-user threat model (prompt-injection via ingested content, not multi-tenant) lets us skip microVM-grade hardening but **not** egress / no-ambient-secrets / no-destructive-capability.

## Further Notes

- **Threat model.** Single-user; the adversary is prompt-injection via ingested content (emails, web pages, GitHub issue bodies), not a hostile co-tenant. That is why the trusted boundary pins authority/headers, rejects write methods, exact-allows read-via-POST, blocks redirects, and never puts binary bytes in the transcript. It also bounds why v1 needs no sandbox — a structured request proposal executed by trusted code is not model-authored code.
- **Relationship to curated tools.** Passthrough is the *unvalidated sibling* of the curated tier. It does not replace curated tools — those keep their DSL sanitizers, param-ergonomics tolerance, and risk tiers. Passthrough serves the long tail the curated tier deliberately doesn't cover. If a passthrough path proves hot and correctness-sensitive, that's a signal to *promote* it into a curated tool, not to grow passthrough's smarts.
- **Param ergonomics.** Per the "query-flawless is param-ergonomics not DSL-grammar" finding, the model generally writes the DSL correctly; passthrough sidesteps curated-schema param ergonomics entirely (it takes raw method/path/params), but the read-gate rejection is a new place the model can fumble — the honest envelope + retry rubric is what recovers those.
- **Sequencing.** (1) Shared contracts: coverage decisions, preference keys/labels, request/result/truncation types, and action slugs. (2) Availability: default-off preference reads, `feature_disabled`, discovery/load filtering, dispatch recheck, and visible Settings toggles (the UI may land anywhere before completion). (3) Pure gate + shaper + bounds. (4) Railway vertical slice, including AST validation and raw GraphQL response preservation. (5) Shared REST adapter plus GitHub/Notion/Vercel. (6) Google adapters for Gmail/Calendar/Drive/Docs/Sheets/Slides. (7) behavioral eval, telemetry thresholds/dashboard query, and per-integration live smoke/enablement. Each phase lands with its deterministic tests; no integration is enabled before its live smoke passes.
