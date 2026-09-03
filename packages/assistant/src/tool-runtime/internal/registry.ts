/**
 * Tool registry — single map of every tool the boss (or a sub-agent) can
 * call. Tools register themselves at server boot inside their owning
 * integration's module; the dispatcher (Phase 3) reads from here on
 * every tool call and treats unknown names as a synthesized validation
 * failure.
 *
 * `riskTier` drives integration-card summaries, staging-card badges, and email
 * subject prefixes. For `no_risk`/`low`/`medium` it is purely a UX hint — the
 * gate is `user_action_policies` (ADR-0034). The ONE exception is `high`: per
 * ADR-0069 a high-tier tool ALWAYS confirms regardless of policy (a one-way
 * floor the autonomy toggle can't override — see `toolRequiresApproval` in the
 * dispatcher). So `high` is load-bearing for the gate; the lower tiers are not.
 */

import type {
  ActionSlug,
  IanaTimezone,
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  RiskTierCounts,
  ToolName,
  ToolRunContext,
  ToolAvailabilityResult,
  ToolCredentialRequirement,
  ToolRiskTier,
} from "@alfred/contracts";
import {
  buildToolName,
  holdsAnyScope,
  INTEGRATION_ACTIONS,
  INTEGRATION_DISPLAY_NAMES,
  integrationFromToolName,
  isLoadableIntegrationSlug,
  isSupportedPassthroughSlug,
} from "@alfred/contracts";
// Type-only, deliberately: importing the `integrations` VALUE here would pull
// `@alfred/db` and `@alfred/corpus` into the import graph of the module every
// tool declaration imports. Building a context lives in `../context`.
import type { Integrations } from "@alfred/integrations";
// Same erasure rule: the corpus bind is a TYPE here so tool declarations can
// name it without loading the embedder + pg graph. The value is attached in
// `../context`, next to the provider bind.
import type { SearchArgs, SearchHit } from "@alfred/corpus";
import { z } from "zod";
import { joinToolInput } from "../join-contract";
import { deriveToolDiscovery, type ResolvedDiscovery } from "./metadata-defaults";

export interface ToolDiscoveryMetadata {
  /** Compact model-facing name; defaults to the humanized action slug. */
  title?: string;
  /** One-sentence catalog copy; defaults to the tool description. */
  summary?: string;
  /** Alternative phrases users or models commonly use for this capability. */
  aliases?: readonly string[];
  /** Broad capability groupings such as `communication` or `research`. */
  tags?: readonly string[];
  /** Nouns this tool operates on, such as `message`, `event`, or `issue`. */
  entities?: readonly string[];
  /** User-intent verbs such as `search`, `read`, `create`, or `send`. */
  verbs?: readonly string[];
  /** Exact companion tools that are often useful after this one. */
  relatedTools?: readonly ToolName[];
}

interface ToolAvailabilityMetadata {
  /** Always expose this tool in the run-local bootstrap surface. Omit for lazy-loaded tools. */
  surface?: "kernel";
  /** Credential capability required by this exact tool, when narrower than its integration. */
  credential?: ToolCredentialRequirement;
  /** Caller kinds that may actually receive and invoke this tool. */
  callers?: readonly ("boss" | "sub_agent")[];
  /** True when execution requires an interactive chat thread. */
  requiresLiveChat?: boolean;
  /**
   * Marks a general read-only passthrough tool (ADR-0074). Its integration slug
   * is the key for the default-OFF `feature.passthrough.<slug>` preference: with
   * the preference unset or disabled, availability resolves to `feature_disabled`
   * (hidden plumbing — the model must not narrate a capability the user turned
   * off), and `dispatchToolCall` re-checks this immediately before execution so a
   * stale active surface can't bypass the kill switch.
   */
  passthrough?: true;
}

/**
 * How a call reaches execution at the dispatch floor. Declared here rather than
 * matched on by name in the dispatcher, so the routing for a tool is readable
 * from its registration and a new tool cannot acquire a bypass by being added to
 * a list in another module.
 *
 * - `"staged"` (the default when omitted) — the call writes an `action_stagings`
 *   row and passes the ADR-0034 policy / ADR-0069 risk gate. Every tool with an
 *   external side effect belongs here.
 * - `"fast_path"` — a bounded LOCAL read with no external side effect and no
 *   approval surface: it skips the staging row and, because they all live below
 *   the routing switch, FOUR things with it — the ADR-0034 policy / ADR-0069 risk
 *   gate, the retry-suppression check for an input the user already rejected, the
 *   run-cancellation guard (a fast-path call still runs in a cancelled run), and
 *   the durable audit row itself. Only a run-local read/write earns this. The
 *   availability and active-surface checks still authorize the call, and
 *   {@link registerTool} refuses the declaration for anything that could require
 *   approval — see {@link LiveToolArgs.policyGateWaiver} for the non-`system`
 *   case, which is the sharp edge.
 * - `"join"` — ADR-0073. The dispatcher intercepts the call to *park* the parent
 *   run on a child-completion signal instead of returning a result the boss would
 *   have to poll; the tool's own `execute` is the non-blocking read-only fallback.
 *   This arm is a JOIN PROTOCOL, not a free-form routing choice: the dispatcher
 *   resolves the child named by {@link joinToolInput}, so a tool declaring it must
 *   accept that input. `registerTool` proves both that and single occupancy at
 *   boot, so the arm never has to trust the declaration.
 */
type ToolStagingPolicy = "staged" | "fast_path" | "join";

// The join contract (`joinToolInput`, imported above from tool-runtime) is the
// shape every `staging: "join"` tool must accept. `registerTool` proves at boot
// that each join tool accepts `{ childRunId: string }`, so a mis-declared join
// tool fails at boot rather than at first dispatch.

export interface ToolExecuteContext {
  runId: string;
  /**
   * Scratchpad namespace for this call. Boss calls use their own run id;
   * sub-agent calls keep `runId` as the child audit row but write/read the
   * parent run's scratchpad.
   */
  scratchpadRunId: string;
  /** Id of the executor step that originated the call (audit only). */
  stepId: string;
  /** Stable id from the model's tool call — used as the staging row's tool_call_id. */
  toolCallId: string;
  /** Exact provider account id approved by an immutable workflow revision. */
  accountRef?: string | undefined;
  /**
   * The `action_stagings` row id this execution is committing, when the call went
   * through the staged/approved path. Present only for staged tools (the fast
   * path has no staging row and leaves it undefined). The MCP execution broker
   * needs it to mint its durable operation ledger row 1:1 with the staging row.
   */
  stagingId?: string;
  userId: string;
  /**
   * Every provider client, already bound to THIS call's user — so a tool's
   * `execute` reads `ctx.integrations.github.search({ q })` and is done.
   *
   * It hangs off the context rather than being imported because that is what
   * removes the knowledge a tool used to need: which credential function its
   * provider uses, that the token it returns must never be logged or persisted,
   * and that the right `userId` to bind is this call's. The dispatcher binds it
   * once from {@link ToolExecuteContext.userId}, so a tool cannot reach a
   * different user's credentials without going outside the context, and no tool
   * ever holds a curated-read token (see `githubClientForUser`; ADR-0074 raw
   * reads cross this boundary as opaque passthrough capabilities, never headers).
   *
   * Binding is lazy and holds no credential: a provider client is built on first
   * touch and resolves its credential per request, so nothing here goes stale and
   * a context is safe to pass around for as long as the call lives.
   */
  integrations: Integrations;
  /**
   * Corpus reads, already bound to THIS call's user — the same inversion the
   * provider bind gets: a tool calls `ctx.corpus.search({ query })` and never
   * imports `@alfred/db` or `@alfred/corpus` itself. Built in `../context`
   * beside `integrations`, so the tool graph stays free of the static db edge.
   */
  corpus: {
    search(args: SearchArgs): Promise<SearchHit[]>;
  };
  /**
   * The user's operational IANA timezone (the `"timezone"` pref, falling back
   * to UTC), resolved once by the dispatcher. Tools that turn a relative window
   * ("today", "the past week") into concrete bounds resolve it against this so
   * "today" means the user's calendar day — never the server's UTC day. Always
   * present; the dispatcher fills it from `DispatchArgs.timezone` or by reading
   * the preference.
   */
  timezone: IanaTimezone;
  /**
   * Who is calling — `'boss'` for the parent run, a sub-agent id like
   * `'sub_a'` when the dispatcher is serving a child run. Tools rarely
   * care; the scratchpad zone gate (Phase 6) does.
   */
  caller: "boss" | { subId: string };
  /** Product facts used to expose and authorize tools for this run. */
  runContext: ToolRunContext;
  /**
   * The chat thread + assistant message this call belongs to, when the call
   * originates from a chat turn. Present only for chat dispatch (the chat-turn
   * workflow snapshots both on its run state); background/sub-agent runs leave
   * them undefined. Artifact authoring tools (ADR-0075) require them — an
   * artifact is owned by the thread/message that produced it — and refuse the
   * call honestly when they are absent.
   */
  threadId?: string | undefined;
  messageId?: string | undefined;
  /**
   * Workflow-level integration cap. Empty or undefined means unrestricted.
   * Exact tool discovery and loading use this to validate without reading or
   * mutating run state.
   */
  allowedIntegrations?: readonly string[] | undefined;
  // TODO(#286): no abortSignal is threaded here yet, so a long network tool
  // (system.fetch_url, system.web_search) outlives a stopped turn until its own
  // ~15s timeout fires. Platform-level — every tool shares this; wire a per-run
  // AbortSignal through the dispatcher and into the network tools when the turn
  // cancellation path lands.
}

/**
 * Everything a caller supplies to build a {@link ToolExecuteContext} — which is
 * everything EXCEPT the derived binds (the provider bind and the corpus bind),
 * because those are derived rather than passed. See `toolExecuteContext` in
 * `../context`.
 */
export type ToolExecuteContextFields = Omit<ToolExecuteContext, "integrations" | "corpus">;

export interface LiveToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodTypeAny,
> {
  integration: I;
  action: A;
  /**
   * Static risk tier. `high` is the one-way ADR-0069 approval floor; lower tiers
   * are UX hints. `resolveRiskTier` is the only supported effective-tier hook.
   */
  riskTier: ToolRiskTier;
  /**
   * Optional: compute the EFFECTIVE risk tier from the validated input at the
   * dispatch gate. The dispatcher centrally clamps an undeclared downgrade to
   * the static `riskTier`; raising the tier needs no extra declaration.
   *
   * The resolver must be side-effect free because it runs on every fresh
   * dispatch before staging. A tool that intentionally lowers its static tier
   * must also set `riskTierDowngradeReason`; the dispatcher records that reviewed
   * exception without logging the tool input. See decisions.md (ADR-0088).
   */
  resolveRiskTier?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<ToolRiskTier>;
  /**
   * Reviewed reason that permits `resolveRiskTier` to return below the static
   * tier. Omit for input-dependent escalation rules; an accidental downgrade is
   * then clamped centrally. Illegal without `resolveRiskTier`.
   */
  riskTierDowngradeReason?: string;
  /** How the dispatch floor routes this call. Omitted means `"staged"`. */
  staging?: ToolStagingPolicy;
  /** Calls in the same live-chat lane execute in model order. */
  executionLane?: "artifact_mutation";
  /**
   * REQUIRED to declare `staging: "fast_path"` on a non-`system` tool, and
   * illegal otherwise. Holds the reason waiving the per-user ADR-0034 policy gate
   * is safe for this exact tool.
   *
   * The trap this closes: `riskTier` is NOT what decides approval. The floor
   * computes `toolRequiresApproval(policyMode, riskTier)`, and `resolvePolicyMode`
   * answers `autonomy` for `integration === "system"` only — every other
   * integration reads the user's policy, whose default is `gated`. So under
   * default policy a non-`system` tool requires approval at EVERY risk tier, and
   * `staging: "fast_path"` on it silently skips the approval, the audit row, and
   * the Replicache approval card no matter how low its tier looks. A required
   * string makes that decision impossible to make by accident: the naive
   * `riskTier: "medium", staging: "fast_path"` fails at boot instead of shipping.
   *
   * `mcp.list_tools` is the one holder — a bounded local read of Alfred's own
   * already-validated catalog (#540 clarification #5).
   */
  policyGateWaiver?: string;
  description: string;
  /** Compact discovery copy co-located with the executable definition (#411). */
  discovery?: ToolDiscoveryMetadata;
  /** Exact execution prerequisites used by search, preload, and load. */
  availability?: ToolAvailabilityMetadata;
  inputSchema: S;
  /**
   * Pure side-effect: the dispatcher validates input against
   * `inputSchema` before calling, persists the proposed input + a hash,
   * and writes the resolved result back to `action_stagings.execute_result`.
   * Throwing is fine — the dispatcher catches and records the error.
   */
  execute: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<unknown>;
  /**
   * Optional: scrub secrets from the input *before it is persisted to a sink*
   * (the Langfuse span/trace always; `action_stagings.proposed_input` when the
   * call is autonomous). The tool owns what counts as sensitive; the dispatcher
   * owns where the scrubbed value goes (#293). MUST be pure and return a value of
   * the same shape — the hash and `execute` always see the raw input, so this
   * never affects idempotency or behavior. `fetch_url` uses it to redact
   * credential-bearing URL query/fragment values.
   */
  redactInput?: (input: z.infer<S>) => z.infer<S>;
}

export interface RegisteredTool {
  name: ToolName;
  integration: IntegrationSlug;
  action: string;
  riskTier: ToolRiskTier;
  /** See {@link LiveToolArgs.resolveRiskTier}. Erased to `unknown` at the registry boundary. */
  resolveRiskTier?: (input: unknown, ctx: ToolExecuteContext) => Promise<ToolRiskTier>;
  /** See {@link LiveToolArgs.riskTierDowngradeReason}. */
  riskTierDowngradeReason?: string | undefined;
  /** See {@link ToolStagingPolicy}. Resolved from the optional declaration. */
  staging: ToolStagingPolicy;
  /** Shared-state lane that tool-runtime serializes during a live chat round. */
  executionLane?: "artifact_mutation" | undefined;
  /** See {@link LiveToolArgs.policyGateWaiver}. */
  policyGateWaiver?: string | undefined;
  description: string;
  discovery: ResolvedDiscovery;
  availability?: ToolAvailabilityMetadata | undefined;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown, ctx: ToolExecuteContext) => Promise<unknown>;
  /** See {@link LiveToolArgs.redactInput}. Erased to `unknown` at the registry boundary. */
  redactInput?: (input: unknown) => unknown;
}

function evaluateRunContextGates(
  tool: RegisteredTool,
  allowed: ReadonlySet<string>,
  context: ToolRunContext,
): ToolAvailabilityResult {
  if (tool.integration !== "system" && allowed.size > 0 && !allowed.has(tool.integration)) {
    return {
      available: false,
      code: "not_allowed",
      reason: "Outside this workflow's integration allowlist.",
    };
  }
  return evaluateToolRunContext(tool, context);
}

/** One eligibility truth shared by model projection, discovery, and dispatch. */
export function evaluateToolRunContext(
  tool: RegisteredTool,
  context: ToolRunContext,
): ToolAvailabilityResult {
  if (tool.availability?.callers && !tool.availability.callers.includes(context.caller)) {
    return {
      available: false,
      code: "wrong_caller",
      reason: `Only the ${tool.availability.callers.join(" / ")} caller may use this tool.`,
    };
  }
  if (tool.availability?.requiresLiveChat && context.interaction !== "live_chat") {
    return {
      available: false,
      code: "requires_thread",
      reason: "Runs only inside a live chat.",
    };
  }
  return { available: true };
}

/** Whether connection state can change this tool's availability result. */
export function readsAvailabilitySnapshot(tool: RegisteredTool): boolean {
  return (
    tool.availability?.passthrough === true ||
    tool.availability?.credential !== undefined ||
    isLoadableIntegrationSlug(tool.integration)
  );
}

function evaluateSnapshotGates(
  snapshot: IntegrationAvailabilitySnapshot,
  tool: RegisteredTool,
): ToolAvailabilityResult {
  const name = INTEGRATION_DISPLAY_NAMES[tool.integration];

  if (tool.availability?.passthrough) {
    const enabled =
      isSupportedPassthroughSlug(tool.integration) &&
      snapshot.passthroughEnabled.get(tool.integration) === true;
    if (!enabled) {
      return {
        available: false,
        code: "feature_disabled",
        reason: `${name} raw API access is turned off. Enable it under Settings → Features to use this tool.`,
      };
    }
  }

  const credential = tool.availability?.credential;
  if (credential) {
    const providerRows = snapshot.providers.get(credential.provider) ?? [];
    if (providerRows.length === 0) {
      return { available: false, code: "not_connected", reason: `${name} is not connected.` };
    }
    const activeRows = providerRows.filter((row) => row.status === "active");
    if (activeRows.length === 0) {
      return { available: false, code: "needs_reauth", reason: `${name} needs to be reconnected.` };
    }
    const scopeMatches = activeRows.some((row) =>
      holdsAnyScope(row.scopes, credential.anyOfScopes),
    );
    if (!scopeMatches) {
      return {
        available: false,
        code: "missing_scope",
        reason: `${name} is connected but missing a required permission; reconnect to grant it.`,
      };
    }
    return { available: true };
  }

  if (isLoadableIntegrationSlug(tool.integration)) {
    const health = snapshot.integrations.get(tool.integration)?.health;
    if (health === "needs_reauth") {
      return { available: false, code: "needs_reauth", reason: `${name} needs to be reconnected.` };
    }
    if (health !== "active") {
      return { available: false, code: "not_connected", reason: `${name} is not connected.` };
    }
  }
  return { available: true };
}

/** One policy for discovery, preload, workflow readiness, and dispatch. */
export function evaluateToolAvailability(
  snapshot: IntegrationAvailabilitySnapshot,
  tool: RegisteredTool,
  allowed: ReadonlySet<string>,
  context: ToolRunContext,
): ToolAvailabilityResult {
  const contextResult = evaluateRunContextGates(tool, allowed, context);
  if (!contextResult.available) return contextResult;
  return evaluateSnapshotGates(snapshot, tool);
}

/** Evaluate one tool and lazily read connection state only when it can matter. */
export async function resolveToolAvailability(args: {
  tool: RegisteredTool;
  allowed: ReadonlySet<string>;
  context: ToolRunContext;
  loadSnapshot: () => Promise<IntegrationAvailabilitySnapshot>;
}): Promise<ToolAvailabilityResult> {
  const contextResult = evaluateRunContextGates(args.tool, args.allowed, args.context);
  if (!contextResult.available) return contextResult;
  if (!readsAvailabilitySnapshot(args.tool)) return { available: true };
  return evaluateSnapshotGates(await args.loadSnapshot(), args.tool);
}

export function availableToolNames(
  snapshot: IntegrationAvailabilitySnapshot,
  tools: readonly RegisteredTool[],
  allowedIntegrations: readonly string[],
  context: ToolRunContext,
): Set<RegisteredTool["name"]> {
  const allowed = new Set(allowedIntegrations);
  const available = new Set<RegisteredTool["name"]>();
  for (const tool of tools) {
    if (evaluateToolAvailability(snapshot, tool, allowed, context).available) {
      available.add(tool.name);
    }
  }
  return available;
}

export function evaluateToolCatalog(
  snapshot: IntegrationAvailabilitySnapshot,
  tools: readonly RegisteredTool[],
  allowedIntegrations: readonly string[],
  context: ToolRunContext,
): Map<RegisteredTool["name"], ToolAvailabilityResult> {
  const allowed = new Set(allowedIntegrations);
  const out = new Map<RegisteredTool["name"], ToolAvailabilityResult>();
  for (const tool of tools) {
    out.set(tool.name, evaluateToolAvailability(snapshot, tool, allowed, context));
  }
  return out;
}

/**
 * Build a registry entry. The returned object is not yet registered —
 * call `registerTool()` (or `registerTools()`) at server boot. Splitting
 * the factory from the registration keeps the act of registering
 * explicit and grep-able.
 */
export function liveTool<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodTypeAny,
>(args: LiveToolArgs<I, A, S>): RegisteredTool {
  const name = buildToolName(args.integration, args.action);
  return {
    name,
    integration: args.integration,
    action: args.action,
    riskTier: args.riskTier,
    riskTierDowngradeReason: args.riskTierDowngradeReason,
    staging: args.staging ?? "staged",
    executionLane: args.executionLane,
    policyGateWaiver: args.policyGateWaiver,
    description: args.description,
    // Every tool carries a derived discovery baseline (#413) so it is findable
    // by capability, not only by its exact canonical name; hand-authored copy in
    // `args.discovery` merges on top as a local override.
    discovery: deriveToolDiscovery({
      integration: args.integration,
      action: args.action,
      description: args.description,
      inputSchema: args.inputSchema,
      overrides: args.discovery,
    }),
    availability: args.availability,
    inputSchema: args.inputSchema,
    execute: async (input, ctx) => {
      const parsed = args.inputSchema.parse(input);
      return args.execute(parsed, ctx);
    },
    ...(args.redactInput
      ? {
          // SAFETY: the registry erases schema-typed fields to unknown on
          // RegisteredTool, so this restores the authoring generic S for the
          // stored closure. Dispatch invokes redactInput on raw pre-parse
          // input and catches a throw, so the redactor reads its fields
          // defensively.
          redactInput: (input: unknown) => args.redactInput!(input as z.infer<S>),
        }
      : {}),
    ...(args.resolveRiskTier
      ? {
          resolveRiskTier: (input: unknown, ctx: ToolExecuteContext) =>
            args.resolveRiskTier!(args.inputSchema.parse(input), ctx),
        }
      : {}),
  };
}

const REGISTRY = new Map<ToolName, RegisteredTool>();

/**
 * Cached sorted snapshot for {@link listRegisteredTools}. The registry is
 * write-once at boot and frozen thereafter, so the sorted copy is stable for
 * the process lifetime; recomputing it on every discovery/search/preload/kernel
 * read is pure waste. Invalidated (set back to `null`) on any registry mutation
 * — `registerTool` and the test-only `clearToolRegistryForTests` — so it can
 * never go stale.
 */
let cachedSortedTools: readonly RegisteredTool[] | null = null;

export function registerTool(tool: RegisteredTool): void {
  const existing = REGISTRY.get(tool.name);
  if (existing && existing !== tool) {
    throw new Error(
      `[tools] duplicate registration for '${tool.name}' — each tool may only be registered once`,
    );
  }
  // Defensive: the integration claimed by the tool must match the
  // integration encoded in its name. Catches typos at boot rather than
  // at first dispatch.
  const expected = integrationFromToolName(tool.name);
  if (expected !== tool.integration) {
    throw new Error(
      `[tools] '${tool.name}' declared integration='${tool.integration}' but name resolves to '${expected}'`,
    );
  }
  if (tool.availability?.surface === "kernel" && tool.integration !== "system") {
    throw new Error(`[tools] only system tools may declare availability.surface='kernel'`);
  }
  if (tool.riskTierDowngradeReason !== undefined) {
    if (!tool.resolveRiskTier) {
      throw new Error(
        `[tools] '${tool.name}' declares riskTierDowngradeReason without resolveRiskTier`,
      );
    }
    if (tool.riskTierDowngradeReason.trim().length === 0) {
      throw new Error(`[tools] '${tool.name}' declares an empty riskTierDowngradeReason`);
    }
  }
  // `fast_path` skips the staging row and with it the ADR-0034 policy / ADR-0069
  // risk gate, so it must be unreachable for anything that could ever require
  // approval. These guards mirror BOTH disjuncts of `toolRequiresApproval`
  // (`policyMode === "gated" || riskTier === "high"`) — a guard that closed only
  // the risk half would be worse than none, because the next author would trust
  // it. Refused at boot rather than at first dispatch.
  if (tool.staging === "fast_path") {
    // Disjunct 2 — the risk floor. A `high` static tier always confirms, and a
    // dynamic `resolveRiskTier` can return `high`.
    if (tool.riskTier === "high" || tool.resolveRiskTier) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='fast_path' but can require approval ` +
          `(riskTier='${tool.riskTier}'${tool.resolveRiskTier ? ", dynamic resolveRiskTier" : ""}) — ` +
          "the fast path skips the approval gate",
      );
    }
    // Disjunct 1 — the policy mode, which is the half that actually bites.
    // `resolvePolicyMode` answers `autonomy` for `integration === "system"` ONLY;
    // every other integration reads the user's policy, whose default is `gated`.
    // So a non-`system` fast path skips a real approval at EVERY risk tier, and
    // the declaration must name why that is safe for this exact tool.
    if (tool.integration !== "system" && tool.policyGateWaiver === undefined) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='fast_path' on integration='${tool.integration}', ` +
          "but only 'system' is forced to autonomy by resolvePolicyMode — under the default " +
          "'gated' policy this skips a real approval at every risk tier. Set " +
          "`policyGateWaiver` with the reason waiving the gate is safe, or use staging='staged'",
      );
    }
  } else if (tool.policyGateWaiver !== undefined) {
    throw new Error(
      `[tools] '${tool.name}' sets policyGateWaiver but does not declare staging='fast_path' — ` +
        "nothing waives its approval gate, so the waiver is misleading",
    );
  }
  // `join` is a protocol, not a preference: the dispatcher reads `childRunId` off
  // the call itself (see `joinToolInput`) and never reaches this tool's `execute`
  // for a still-running child. Prove the schema accepts that input, so the
  // dispatcher's parse cannot be the place a copy-pasted declaration first fails.
  if (tool.staging === "join") {
    const probe = tool.inputSchema.safeParse({
      childRunId: "00000000-0000-0000-0000-000000000000",
    });
    if (!probe.success || !joinToolInput.safeParse(probe.data).success) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='join' but its inputSchema does not accept ` +
          "`{ childRunId: string }` — the dispatcher's join arm resolves the child run from that field",
      );
    }
    const existingJoin = [...REGISTRY.values()].find(
      (other) => other.staging === "join" && other.name !== tool.name,
    );
    if (existingJoin) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='join' but '${existingJoin.name}' already does — ` +
          "the join arm has one implementation (ADR-0073 sub-agent join), so a second declarer " +
          "would silently route into it",
      );
    }
  }
  // And the action must be a known action slug for that integration —
  // mirrors the compile-time check `liveTool` enforces, but covers the
  // case where someone bypasses the factory and constructs a
  // `RegisteredTool` literal directly.
  // SAFETY: the per-integration row is a readonly tuple of action strings;
  // widening only types the .includes receiver for the membership test below.
  const knownActions = INTEGRATION_ACTIONS[tool.integration] as readonly string[];
  if (!knownActions.includes(tool.action)) {
    throw new Error(
      `[tools] '${tool.name}' action '${tool.action}' is not declared in @alfred/contracts INTEGRATION_ACTIONS['${tool.integration}']`,
    );
  }
  REGISTRY.set(tool.name, tool);
  cachedSortedTools = null;
}

export function registerTools(tools: readonly RegisteredTool[]): void {
  for (const t of tools) registerTool(t);
}

export function getTool(name: ToolName): RegisteredTool | undefined {
  return REGISTRY.get(name);
}

export function listToolsForIntegration(slug: IntegrationSlug): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  for (const t of REGISTRY.values()) {
    if (t.integration === slug) out.push(t);
  }
  return out;
}

/**
 * Stable snapshot of every executable the process currently knows about.
 * Read-only and shared: the returned array is memoized and frozen, so callers
 * must not mutate it (all current readers iterate, `.filter`, or pass it to
 * `readonly RegisteredTool[]` params). The cache is rebuilt only after a
 * registry mutation.
 */
export function listRegisteredTools(): readonly RegisteredTool[] {
  return (cachedSortedTools ??= Object.freeze(
    [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ));
}

/** Stable snapshot of the tools that bootstrap every agent run. */
export function listKernelTools(): RegisteredTool[] {
  return listRegisteredTools().filter((tool) => tool.availability?.surface === "kernel");
}

/**
 * Boot-time invariant, called once from `registerBuiltinTools`: every tool the
 * caller declares as kernel surface is registered as that exact object, and at
 * least one exists. The runtime kernel read (`systemToolKernel`) trusts this ran
 * at boot and does not re-validate on every call.
 */
export function assertKernelToolsRegistered(declaredTools: readonly RegisteredTool[]): void {
  const declaredKernel = declaredTools.filter((tool) => tool.availability?.surface === "kernel");
  if (declaredKernel.length === 0) {
    throw new Error("No system tools are declared for the kernel surface");
  }
  const missing = declaredKernel.filter((tool) => getTool(tool.name) !== tool);
  if (missing.length > 0) {
    throw new Error(
      `Declared system kernel tools are not registered: ${missing.map((tool) => tool.name).join(", ")}`,
    );
  }
}

function emptyTierCounts(): RiskTierCounts {
  return { no_risk: 0, low: 0, medium: 0, high: 0 };
}

/**
 * Tier breakdown for a single integration, e.g. `{ high: 1, medium: 0,
 * low: 1, no_risk: 1 }`. Drives the integration detail page's
 * "Gmail — 3 tools (1 high, 1 low, 1 no-risk)" summary. This is the permanent
 * web-facing projection because `@alfred/http` cannot import the private map.
 */
export function riskTierCountsForIntegration(slug: IntegrationSlug): RiskTierCounts {
  const counts = emptyTierCounts();
  for (const t of listToolsForIntegration(slug)) counts[t.riskTier] += 1;
  return counts;
}

/** Test-only: drop every registration. Production code never calls this. */
export function clearToolRegistryForTests(): void {
  REGISTRY.clear();
  cachedSortedTools = null;
}
