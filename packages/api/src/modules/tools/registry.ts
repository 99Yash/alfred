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

import type { ActionSlug, IntegrationSlug, ToolName, ToolRiskTier } from "@alfred/contracts";
import { buildToolName, INTEGRATION_ACTIONS, integrationFromToolName } from "@alfred/contracts";
import type { z } from "zod";

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

export interface ToolAvailabilityMetadata {
  /** Credential capability required by this exact tool, when narrower than its integration. */
  credential?: {
    provider: string;
    anyOfScopes: readonly string[];
  };
  /** Caller kinds that may actually receive and invoke this tool. */
  callers?: readonly ("boss" | "sub_agent")[];
  /** True when execution requires an interactive chat thread. */
  requiresThread?: boolean;
}

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
  userId: string;
  /**
   * The user's operational IANA timezone (the `"timezone"` pref, falling back
   * to UTC), resolved once by the dispatcher. Tools that turn a relative window
   * ("today", "the past week") into concrete bounds resolve it against this so
   * "today" means the user's calendar day — never the server's UTC day. Always
   * present; the dispatcher fills it from `DispatchArgs.timezone` or by reading
   * the preference.
   */
  timezone: string;
  /**
   * Who is calling — `'boss'` for the parent run, a sub-agent id like
   * `'sub_a'` when the dispatcher is serving a child run. Tools rarely
   * care; the scratchpad zone gate (Phase 6) does.
   */
  caller: "boss" | { subId: string };
  /**
   * The chat thread + assistant message this call belongs to, when the call
   * originates from a chat turn. Present only for chat dispatch (the chat-turn
   * workflow snapshots both on its run state); background/sub-agent runs leave
   * them undefined. Artifact authoring tools (ADR-0075) require them — an
   * artifact is owned by the thread/message that produced it — and refuse the
   * call honestly when they are absent.
   */
  threadId?: string;
  messageId?: string;
  /**
   * Workflow-level integration cap. Empty or undefined means unrestricted.
   * Exact tool discovery and loading use this to validate without reading or
   * mutating run state.
   */
  allowedIntegrations?: readonly string[];
  // TODO(#286): no abortSignal is threaded here yet, so a long network tool
  // (system.fetch_url, system.web_search) outlives a stopped turn until its own
  // ~15s timeout fires. Platform-level — every tool shares this; wire a per-run
  // AbortSignal through the dispatcher and into the network tools when the turn
  // cancellation path lands.
}

export interface LiveToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodTypeAny,
> {
  integration: I;
  action: A;
  riskTier: ToolRiskTier;
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
  description: string;
  discovery: Required<Pick<ToolDiscoveryMetadata, "title" | "summary">> & ToolDiscoveryMetadata;
  availability?: ToolAvailabilityMetadata;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown, ctx: ToolExecuteContext) => Promise<unknown>;
  /** See {@link LiveToolArgs.redactInput}. Erased to `unknown` at the registry boundary. */
  redactInput?: (input: unknown) => unknown;
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
  const title = args.discovery?.title ?? humanizeAction(args.action);
  return {
    name,
    integration: args.integration,
    action: args.action,
    riskTier: args.riskTier,
    description: args.description,
    discovery: {
      ...args.discovery,
      title,
      summary: args.discovery?.summary ?? args.description,
    },
    availability: args.availability,
    inputSchema: args.inputSchema,
    execute: async (input, ctx) => {
      const parsed = args.inputSchema.parse(input);
      return args.execute(parsed, ctx);
    },
    ...(args.redactInput
      ? { redactInput: (input: unknown) => args.redactInput!(input as z.infer<S>) }
      : {}),
  };
}

const REGISTRY = new Map<ToolName, RegisteredTool>();

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
  // And the action must be a known action slug for that integration —
  // mirrors the compile-time check `liveTool` enforces, but covers the
  // case where someone bypasses the factory and constructs a
  // `RegisteredTool` literal directly.
  const knownActions = INTEGRATION_ACTIONS[tool.integration] as readonly string[];
  if (!knownActions.includes(tool.action)) {
    throw new Error(
      `[tools] '${tool.name}' action '${tool.action}' is not declared in @alfred/contracts INTEGRATION_ACTIONS['${tool.integration}']`,
    );
  }
  REGISTRY.set(tool.name, tool);
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

/** Stable snapshot of every executable the process currently knows about. */
export function listRegisteredTools(): RegisteredTool[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function humanizeAction(action: string): string {
  return action.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Per-tier counts for one integration. UX hint only (see file header). */
export type RiskTierCounts = Record<ToolRiskTier, number>;

function emptyTierCounts(): RiskTierCounts {
  return { no_risk: 0, low: 0, medium: 0, high: 0 };
}

/**
 * Tier breakdown for a single integration, e.g. `{ high: 1, medium: 0,
 * low: 1, no_risk: 1 }`. Drives the integration detail page's
 * "Gmail — 3 tools (1 high, 1 low, 1 no-risk)" summary. The web can't
 * import the registry, so this is exposed through the integrations API.
 */
export function riskTierCountsForIntegration(slug: IntegrationSlug): RiskTierCounts {
  const counts = emptyTierCounts();
  for (const t of listToolsForIntegration(slug)) counts[t.riskTier] += 1;
  return counts;
}

/** Test-only: drop every registration. Production code never calls this. */
export function clearToolRegistryForTests(): void {
  REGISTRY.clear();
}
