/**
 * Tool registry — single map of every tool the boss (or a sub-agent) can
 * call. Tools register themselves at server boot inside their owning
 * integration's module; the dispatcher (Phase 3) reads from here on
 * every tool call and treats unknown names as a synthesized validation
 * failure.
 *
 * `riskTier` is a UX hint — the dispatcher's gate is `user_action_policies`,
 * not the tier (per the Tool-risk-tier glossary entry / ADR-0034). Tiers
 * drive integration-card summaries, staging-card badges, and email
 * subject prefixes; they never silently change whether a call is gated.
 */

import type { ActionSlug, IntegrationSlug, ToolName, ToolRiskTier } from "@alfred/contracts";
import { buildToolName, INTEGRATION_ACTIONS, integrationFromToolName } from "@alfred/contracts";
import type { z } from "zod";

export interface ToolExecuteContext {
  runId: string;
  /** Id of the executor step that originated the call (audit only). */
  stepId: string;
  /** Stable id from the model's tool call — used as the staging row's tool_call_id. */
  toolCallId: string;
  userId: string;
  /**
   * Who is calling — `'boss'` for the parent run, a sub-agent id like
   * `'sub_a'` when the dispatcher is serving a child run. Tools rarely
   * care; the scratchpad zone gate (Phase 6) does.
   */
  caller: "boss" | { subId: string };
  /**
   * Workflow-level integration cap. Empty or undefined means unrestricted.
   * Internal system tools such as `system.load_integration` use this to
   * validate without reading or mutating run state.
   */
  allowedIntegrations?: readonly string[];
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
  inputSchema: S;
  /**
   * Pure side-effect: the dispatcher validates input against
   * `inputSchema` before calling, persists the proposed input + a hash,
   * and writes the resolved result back to `action_stagings.execute_result`.
   * Throwing is fine — the dispatcher catches and records the error.
   */
  execute: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<unknown>;
}

export interface RegisteredTool {
  name: ToolName;
  integration: IntegrationSlug;
  action: string;
  riskTier: ToolRiskTier;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: unknown, ctx: ToolExecuteContext) => Promise<unknown>;
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
    description: args.description,
    inputSchema: args.inputSchema,
    execute: async (input, ctx) => {
      const parsed = args.inputSchema.parse(input);
      return args.execute(parsed, ctx);
    },
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

/** Test-only: drop every registration. Production code never calls this. */
export function clearToolRegistryForTests(): void {
  REGISTRY.clear();
}
