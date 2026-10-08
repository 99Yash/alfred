/**
 * The map of every tool the boss or a sub-agent can call, filled at boot.
 * `riskTier` is a UX hint, except `high`: a high-tier tool always confirms (ADR-0069).
 * The approval gate is `user_action_policies` (ADR-0034).
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
  ASK_USER_TOOL,
  buildToolName,
  holdsAnyScope,
  INTEGRATION_ACTIONS,
  INTEGRATION_DISPLAY_NAMES,
  integrationFromToolName,
  isLoadableIntegrationSlug,
  isSupportedPassthroughSlug,
} from "@alfred/contracts";
// Type-only: the values pull `@alfred/db` into every tool declaration. `../context` binds them.
import type { Integrations } from "@alfred/integrations";
import type { SearchArgs, SearchHit } from "@alfred/corpus";
import { z } from "zod";
import { joinToolInput } from "../join-contract";
import {
  QUESTION_TOOL_MODEL_PROBE_INPUT,
  QUESTION_TOOL_PROBE_INPUT,
  questionToolInput,
} from "../question-contract";
import { deriveToolDiscovery, type ResolvedDiscovery } from "./metadata-defaults";

export interface ToolDiscoveryMetadata {
  /** Defaults to the humanized action slug. */
  title?: string;
  /** Defaults to the tool description. */
  summary?: string;
  aliases?: readonly string[];
  tags?: readonly string[];
  entities?: readonly string[];
  verbs?: readonly string[];
  relatedTools?: readonly ToolName[];
}

interface ToolAvailabilityMetadata {
  /** Always in the bootstrap surface. Omit for lazy-loaded tools. */
  surface?: "kernel";
  /** Set when the tool needs a narrower credential than its integration. */
  credential?: ToolCredentialRequirement;
  callers?: readonly ("boss" | "sub_agent")[];
  requiresLiveChat?: boolean;
  /**
   * A read-only passthrough tool (ADR-0074), gated by the default-off
   * `feature.passthrough.<slug>` preference. Dispatch re-checks it so a stale surface cannot bypass it.
   */
  passthrough?: true;
}

/**
 * How dispatch routes a call. `registerTool` checks each arm at boot.
 * - `"staged"` (default): writes an `action_stagings` row and passes the approval gate.
 * - `"fast_path"`: a local read. Skips the staging row, approval gate, retry
 *   suppression, cancel guard, and audit row.
 * - `"join"` (ADR-0073): parks the parent run until the child named by
 *   {@link joinToolInput} finishes. `execute` is the non-blocking fallback.
 * - `"question"` (ADR-0099): parks the chat turn on a question approval.
 *   Only `ASK_USER_TOOL` may use it. `STAGING_ARM` holds the per-arm differences.
 */
export type ToolStagingPolicy = "staged" | "fast_path" | "join" | "question";

export interface ToolExecuteContext {
  runId: string;
  /** Sub-agent calls use the parent run's scratchpad. */
  scratchpadRunId: string;
  stepId: string;
  /** Becomes the staging row's tool_call_id. */
  toolCallId: string;
  /** Exact provider account id approved by an immutable workflow revision. */
  accountRef?: string | undefined;
  /** Set only on the staged path. The MCP broker keys its ledger row on it. */
  stagingId?: string;
  userId: string;
  /**
   * Provider clients bound to this call's user, so a tool never handles a token.
   * Lazy: each client resolves its credential per request.
   */
  integrations: Integrations;
  /** Corpus reads bound to this call's user. */
  corpus: {
    search(args: SearchArgs): Promise<SearchHit[]>;
  };
  /** The user's zone, so "today" means the user's day, not the server's UTC day. */
  timezone: IanaTimezone;
  caller: "boss" | { subId: string };
  runContext: ToolRunContext;
  /** Set only for chat dispatch. Artifact tools (ADR-0075) refuse without them. */
  threadId?: string | undefined;
  messageId?: string | undefined;
  /** Empty or undefined means unrestricted. */
  allowedIntegrations?: readonly string[] | undefined;
  // TODO(#286): no abort signal yet, so a network tool outlives a stopped turn until its own timeout.
}

/** The context minus the binds that `toolExecuteContext` in `../context` derives. */
export type ToolExecuteContextFields = Omit<ToolExecuteContext, "integrations" | "corpus">;

export interface LiveToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType<any>,
> {
  integration: I;
  action: A;
  /** `high` always confirms (ADR-0069). Lower tiers are UX hints. */
  riskTier: ToolRiskTier;
  /**
   * The effective tier from validated input (ADR-0088). Must be side-effect free.
   * Dispatch clamps a downgrade unless `riskTierDowngradeReason` is set.
   */
  resolveRiskTier?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<ToolRiskTier>;
  /** Permits a downgrade below `riskTier`. Requires `resolveRiskTier`. */
  riskTierDowngradeReason?: string;
  /** Defaults to `"staged"`. */
  staging?: ToolStagingPolicy;
  /** Calls in the same live-chat lane execute in model order. */
  executionLane?: "artifact_mutation";
  /**
   * Required for `fast_path` on a non-`system` tool, illegal otherwise.
   * Only `system` resolves to autonomy; every other integration defaults to `gated`,
   * so a fast path there skips a real approval at every risk tier.
   */
  policyGateWaiver?: string;
  description: string;
  discovery?: ToolDiscoveryMetadata;
  availability?: ToolAvailabilityMetadata;
  inputSchema: S;
  /**
   * The narrower schema the model sees, for a field only the runtime writes
   * (`answers` on `system.ask_user`, ADR-0099). Must be a subset of `inputSchema`.
   */
  modelInputSchema?: z.ZodType<any>;
  /** Receives parsed input. A throw is recorded by the dispatcher. */
  execute: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<unknown>;
  /**
   * Scrub secrets before the input reaches a trace or a staging row (#293).
   * Must be pure and keep the shape. The hash and `execute` see the raw input.
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
  inputSchema: z.ZodType<any>;
  /** Falls back to `inputSchema`, so it is always set. */
  modelInputSchema: z.ZodType<any>;
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

/** Build a registry entry. Call `registerTool` at boot to register it. */
export function liveTool<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType<any>,
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
    discovery: deriveToolDiscovery({
      integration: args.integration,
      action: args.action,
      description: args.description,
      // Model-facing: a field the model cannot write is not a search keyword.
      inputSchema: args.modelInputSchema ?? args.inputSchema,
      overrides: args.discovery,
    }),
    availability: args.availability,
    inputSchema: args.inputSchema,
    modelInputSchema: args.modelInputSchema ?? args.inputSchema,
    execute: async (input, ctx) => {
      const parsed = args.inputSchema.parse(input);

      return args.execute(parsed, ctx);
    },
    ...(args.redactInput
      ? {
          // SAFETY: restores the erased generic S. Dispatch passes raw pre-parse
          // input and catches a throw, so the redactor reads fields defensively.
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

/** Sorted snapshot for {@link listRegisteredTools}. Reset on every registry write. */
let cachedSortedTools: readonly RegisteredTool[] | null = null;

export function registerTool(tool: RegisteredTool): void {
  const existing = REGISTRY.get(tool.name);

  if (existing && existing !== tool) {
    throw new Error(
      `[tools] duplicate registration for '${tool.name}' — each tool may only be registered once`,
    );
  }

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

  // `fast_path` skips the approval gate, so refuse both halves of
  // `toolRequiresApproval`: `policyMode === "gated" || riskTier === "high"`.
  if (tool.staging === "fast_path") {
    // A dynamic `resolveRiskTier` can return `high`.
    if (tool.riskTier === "high" || tool.resolveRiskTier) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='fast_path' but can require approval ` +
          `(riskTier='${tool.riskTier}'${tool.resolveRiskTier ? ", dynamic resolveRiskTier" : ""}) — ` +
          "the fast path skips the approval gate",
      );
    }

    // Only `system` resolves to autonomy, so any other fast path needs a waiver.
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

  // The join arm reads `childRunId` off the call, so the schema must accept it.
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

  // ADR-0099. The resume path re-parses the decided input, which carries `answers`.
  if (tool.staging === "question") {
    // Readers outside the registry recognize a question by `ASK_USER_TOOL`.
    if (tool.name !== ASK_USER_TOOL) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but only '${ASK_USER_TOOL}' may — ` +
          "readers outside the registry key a question on that name (ADR-0099)",
      );
    }

    const probe = tool.inputSchema.safeParse(QUESTION_TOOL_PROBE_INPUT);

    if (!probe.success || !questionToolInput.safeParse(probe.data).success) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but its inputSchema does not accept ` +
          "`{ questions, answers }` — the dispatcher's question arm reads both fields off the call",
      );
    }

    // A model that sees `answers` fills it, and the arm then refuses the call.
    if (tool.modelInputSchema.safeParse(QUESTION_TOOL_PROBE_INPUT).success) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but its modelInputSchema accepts ` +
          "`answers` — declare a narrower modelInputSchema that omits the user's field (ADR-0099)",
      );
    }

    if (!tool.modelInputSchema.safeParse(QUESTION_TOOL_MODEL_PROBE_INPUT).success) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but its modelInputSchema does not ` +
          "accept `{ questions }` — the model would have no way to ask anything",
      );
    }

    // The arm skips the policy read, which matches policy only for `system`.
    if (tool.integration !== "system") {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' on integration='${tool.integration}' — ` +
          "the question arm forces its own approval and is only defined for 'system' tools",
      );
    }

    // A question needs a person on a live thread. A sub-agent asks its parent instead.
    const callers = tool.availability?.callers ?? [];
    const bossOnly = callers.length === 1 && callers[0] === "boss";

    if (!bossOnly || tool.availability?.requiresLiveChat !== true) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but is not limited to the chat boss on a ` +
          "live thread — declare availability: { callers: ['boss'], requiresLiveChat: true }",
      );
    }

    const existingQuestion = [...REGISTRY.values()].find(
      (other) => other.staging === "question" && other.name !== tool.name,
    );

    if (existingQuestion) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='question' but '${existingQuestion.name}' already does — ` +
          "the question arm has one implementation (ADR-0099 ask the user), so a second declarer " +
          "would silently route into it",
      );
    }
  }

  assertModelSchemaIsSubset(tool);
  // Repeats the `liveTool` compile-time check for a hand-built `RegisteredTool`.
  // SAFETY: widens the readonly tuple only to type the .includes receiver.
  const knownActions = INTEGRATION_ACTIONS[tool.integration] as readonly string[];

  if (!knownActions.includes(tool.action)) {
    throw new Error(
      `[tools] '${tool.name}' action '${tool.action}' is not declared in @alfred/contracts INTEGRATION_ACTIONS['${tool.integration}']`,
    );
  }

  REGISTRY.set(tool.name, tool);
  cachedSortedTools = null;
}

/**
 * A model-facing key the runtime refuses would be filled, then rejected, with no repair.
 * Checks top-level names only. An unreadable schema passes.
 */
function assertModelSchemaIsSubset(tool: RegisteredTool): void {
  if (tool.modelInputSchema === tool.inputSchema) return;
  const modelKeys = topLevelPropertyNames(tool.modelInputSchema);
  const runtimeKeys = topLevelPropertyNames(tool.inputSchema);

  if (!modelKeys || !runtimeKeys) return;
  const extra = modelKeys.filter((key) => !runtimeKeys.includes(key));

  if (extra.length === 0) return;
  throw new Error(
    `[tools] '${tool.name}' declares a modelInputSchema with ${extra.map((k) => `'${k}'`).join(", ")} ` +
      "which inputSchema does not accept — the model-facing schema must be a subset of the " +
      "validating one, or the model is shown a field its own call will be rejected for",
  );
}

/** Top-level input property names, or `null` when the schema cannot be read. */
function topLevelPropertyNames(schema: z.ZodType<any>): string[] | null {
  let json: z.core.JSONSchema.BaseSchema;

  try {
    json = z.toJSONSchema(schema, { io: "input", reused: "inline", unrepresentable: "any" });
  } catch {
    return null;
  }

  const properties = json.properties;

  return properties ? Object.keys(properties) : null;
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

/** Every registered tool, sorted by name. Memoized and frozen. */
export function listRegisteredTools(): readonly RegisteredTool[] {
  return (cachedSortedTools ??= Object.freeze(
    [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ));
}

export function listKernelTools(): RegisteredTool[] {
  return listRegisteredTools().filter((tool) => tool.availability?.surface === "kernel");
}

/** Boot check: at least one kernel tool, each registered as that exact object. */
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

/** Tool count per risk tier for one integration. `@alfred/http` reads this, not the map. */
export function riskTierCountsForIntegration(slug: IntegrationSlug): RiskTierCounts {
  const counts = emptyTierCounts();

  for (const t of listToolsForIntegration(slug)) counts[t.riskTier] += 1;

  return counts;
}

/** Test-only. */
export function clearToolRegistryForTests(): void {
  REGISTRY.clear();
  cachedSortedTools = null;
}
