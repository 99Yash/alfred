import type { ToolSet } from "@alfred/ai";
import {
  readChatHistoryInput,
  type AgentTranscriptMessage,
  type IanaTimezone,
  type IntegrationAvailabilitySnapshot,
  type ToolName,
  type ToolRunContext,
  type WakeCondition,
  type WorkflowRequiredCapability,
} from "@alfred/contracts";
import type { z } from "zod";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import { runToolCallRound } from "./internal/tool-call-round";
import type { SpawnSubAgentInput } from "./sub-agent-contract";
export { isMutatingToolName } from "./internal/result-routing";
export { joinToolInput } from "./join-contract";
export {
  awaitSubAgentInputSchema,
  spawnSubAgentInputSchema,
  subAgentIdSchema,
  type SpawnSubAgentInput,
} from "./sub-agent-contract";
export { startToolLoadSpan, startToolSearchSpan } from "./internal/runtime-spans";

export type ToolSurfaceSource =
  | { kind: "kernel" }
  | { kind: "exact"; names: readonly string[] }
  | {
      kind: "legacy";
      integrationNames: readonly string[];
      pendingNames: readonly string[];
    };

export interface ResolvedToolSurface {
  tools: ToolSet;
  surfacedNames: ToolName[];
  loadedNames: ToolName[];
  kernelCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export interface SelectedToolPreload {
  promptChars: number;
  selectedNames: ToolName[];
}

export interface ProposedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolCallRunBase {
  runId: string;
  stepId: string;
  userId: string;
  workflow: string;
  threadId?: string | undefined;
  messageId?: string | undefined;
  scratchpadRunId?: string | undefined;
  timezone?: IanaTimezone | undefined;
  allowedIntegrations?: readonly string[] | undefined;
  allowedTools?: readonly ToolName[] | undefined;
  requiredCapabilities?: readonly WorkflowRequiredCapability[] | undefined;
}

type ToolCallActor =
  | { caller: "boss"; runContext: ToolRunContext & { caller: "boss" } }
  | {
      caller: { subId: string };
      runContext: ToolRunContext & { caller: "sub_agent" };
    };

/** Stable run facts shared by every proposed call in one tool round. */
export type ToolCallRun = ToolCallRunBase & ToolCallActor;

export type ToolCallDispatchArgs = Omit<ToolCallRunBase, "workflow"> &
  ToolCallActor &
  ProposedToolCall & {
    /** Round dispatch supplies this for tracing; direct safety probes may omit it. */
    workflow?: string | undefined;
    activeTools: readonly ToolName[];
  };

export interface CompletedToolCall<Call extends ProposedToolCall = ProposedToolCall> {
  call: Call;
  result: unknown;
  status: "succeeded" | "failed";
  execution: "completed" | "failed" | "not_reached";
  sanitized: boolean;
  nonExecution: boolean;
}

export type ToolCallRoundOutcome<Call extends ProposedToolCall = ProposedToolCall> =
  | { kind: "waiting"; wake: WakeCondition; activeNames: ToolName[] }
  | {
      kind: "completed";
      transcript: AgentTranscriptMessage[];
      calls: CompletedToolCall<Call>[];
      activeNames: ToolName[];
      reissue: boolean;
    };

export interface ToolRuntimeAdapter {
  restore(source: ToolSurfaceSource): ToolName[];
  resolve(input: {
    activeNames: readonly ToolName[];
    context: ToolRunContext;
  }): ResolvedToolSurface;
  namesForIntegrations(integrations: readonly string[]): ToolName[];
  availableToolNamesByIntegration(input: {
    availability: IntegrationAvailabilitySnapshot;
    allowedIntegrations: readonly string[];
    context: ToolRunContext;
  }): Map<string, ToolName[]>;
  selectPreload(input: {
    userId: string;
    transcript: readonly { role: string; content: unknown }[];
    allowedIntegrations: readonly string[];
    activeNames: readonly ToolName[];
    context: ToolRunContext;
    availability: IntegrationAvailabilitySnapshot;
  }): Promise<SelectedToolPreload>;
}

let toolRuntimeAdapter: ToolRuntimeAdapter | undefined;
let toolCallRoundAdapter: ToolCallRoundAdapter | undefined;

/** Runtime composition registers the current tools implementation before workers start. */
export function registerToolRuntimeAdapter(adapter: ToolRuntimeAdapter): () => void {
  if (toolRuntimeAdapter && toolRuntimeAdapter !== adapter) {
    throw new Error("A tool runtime adapter is already registered");
  }
  toolRuntimeAdapter = adapter;
  return () => {
    if (toolRuntimeAdapter === adapter) toolRuntimeAdapter = undefined;
  };
}

/** Runtime composition installs the guarded dispatcher behind the call-round seam. */
export function registerToolCallRoundAdapter(adapter: ToolCallRoundAdapter): () => void {
  if (toolCallRoundAdapter && toolCallRoundAdapter !== adapter) {
    throw new Error("A tool call-round adapter is already registered");
  }
  toolCallRoundAdapter = adapter;
  return () => {
    if (toolCallRoundAdapter === adapter) toolCallRoundAdapter = undefined;
  };
}

type ReadChatHistoryInput = z.infer<typeof readChatHistoryInput>;

/** Everything `spawnSubAgent` needs beyond the tool input the model supplies. */
export type SpawnSubAgentRequest = SpawnSubAgentInput & {
  parentRunId: string;
  userId: string;
  parentToolCallId: string;
  /**
   * The parent's chat turn, when it has one — the child streams its trail
   * there. Kept structural (not the agent's `SubAgentChatOrigin`) so this seam
   * adds no `tool-runtime -> agent` edge.
   */
  chat?: { threadId: string; messageId: string } | undefined;
};

/**
 * The agent-owned behaviors the system tools reach through a registered
 * handler, instead of importing the agent module. The two sub-agent operations
 * and chat-history retrieval read and write agent-owned state (`agentRuns`,
 * chat messages), so the tools layer — a lower layer than the agent runtime —
 * calls them behind this seam. Each returns `unknown`: the system tools return
 * every result straight through, and `ChildRunOutcome` / chat-history shapes
 * stay agent-owned. Composition installs the concrete adapter at boot; a call
 * before registration throws, the same failure mode as the other tool-runtime
 * adapters.
 */
export interface SystemToolAgentAdapter {
  spawnSubAgent(args: SpawnSubAgentRequest): Promise<unknown>;
  readChildRunOutcome(args: {
    parentRunId: string;
    userId: string;
    childRunId: string;
  }): Promise<unknown>;
  readChatHistory(args: {
    userId: string;
    threadId: string;
    input: ReadChatHistoryInput;
  }): Promise<unknown>;
}

let systemToolAgentAdapter: SystemToolAgentAdapter | undefined;

/** Runtime composition installs the agent-behavior handler at boot. */
export function registerSystemToolAgentAdapter(adapter: SystemToolAgentAdapter): () => void {
  if (systemToolAgentAdapter && systemToolAgentAdapter !== adapter) {
    throw new Error("A system-tool agent adapter is already registered");
  }
  systemToolAgentAdapter = adapter;
  return () => {
    if (systemToolAgentAdapter === adapter) systemToolAgentAdapter = undefined;
  };
}

/** Spawn one focused sub-agent run behind the registered agent-behavior seam. */
export function spawnSubAgent(args: SpawnSubAgentRequest): Promise<unknown> {
  return requireSystemToolAgentAdapter().spawnSubAgent(args);
}

/** Read a spawned child run's real outcome for a joining parent. */
export function readChildRunOutcome(args: {
  parentRunId: string;
  userId: string;
  childRunId: string;
}): Promise<unknown> {
  return requireSystemToolAgentAdapter().readChildRunOutcome(args);
}

/** Read bounded raw evidence from the current chat thread. */
export function readChatHistory(args: {
  userId: string;
  threadId: string;
  input: ReadChatHistoryInput;
}): Promise<unknown> {
  return requireSystemToolAgentAdapter().readChatHistory(args);
}

/** Restore one explicit persisted-surface shape against today's tool catalog. */
export function restoreToolSurface(source: ToolSurfaceSource): ToolName[] {
  return requireToolRuntimeAdapter().restore(source);
}

/**
 * Project names that already passed load-time allowlist and credential gates.
 * Tool-runtime registration is part of worker boot; calling before boot fails.
 */
export function resolveToolSurface(input: {
  activeNames: readonly ToolName[];
  context: ToolRunContext;
}): ResolvedToolSurface {
  return requireToolRuntimeAdapter().resolve(input);
}

export function toolNamesForIntegrations(integrations: readonly string[]): ToolName[] {
  return requireToolRuntimeAdapter().namesForIntegrations(integrations);
}

/**
 * Project the exact executable tool names, grouped by integration slug, under a
 * run's availability, allowlist, and caller/interaction context. The connected
 * summary reads this to ground the boss in the live `integration.action` names;
 * registry entries, availability calculation, and the no-database fast path stay
 * behind this seam. Names are sorted within each integration for stable output.
 */
export function availableToolNamesByIntegration(input: {
  availability: IntegrationAvailabilitySnapshot;
  allowedIntegrations: readonly string[];
  context: ToolRunContext;
}): Map<string, ToolName[]> {
  return requireToolRuntimeAdapter().availableToolNamesByIntegration(input);
}

export function selectToolPreload(input: {
  userId: string;
  transcript: readonly { role: string; content: unknown }[];
  allowedIntegrations: readonly string[];
  activeNames: readonly ToolName[];
  context: ToolRunContext;
  availability: IntegrationAvailabilitySnapshot;
}): Promise<SelectedToolPreload> {
  return requireToolRuntimeAdapter().selectPreload(input);
}

/** Execute one complete run-local tool round or return its durable wait. */
export function executeToolCallRound<Call extends ProposedToolCall>(input: {
  calls: readonly Call[];
  transcript: readonly AgentTranscriptMessage[];
  run: ToolCallRun;
  activeNames: readonly ToolName[];
  onCallStarted?:
    | ((call: Call, activeNames: readonly ToolName[]) => void | Promise<void>)
    | undefined;
}): Promise<ToolCallRoundOutcome<Call>> {
  return runToolCallRound(input, requireToolCallRoundAdapter(), restoreToolSurface);
}

function requireToolRuntimeAdapter(): ToolRuntimeAdapter {
  if (!toolRuntimeAdapter) throw new Error("No tool runtime adapter is registered");
  return toolRuntimeAdapter;
}

function requireToolCallRoundAdapter(): ToolCallRoundAdapter {
  if (!toolCallRoundAdapter) throw new Error("No tool call-round adapter is registered");
  return toolCallRoundAdapter;
}

function requireSystemToolAgentAdapter(): SystemToolAgentAdapter {
  if (!systemToolAgentAdapter) throw new Error("No system-tool agent adapter is registered");
  return systemToolAgentAdapter;
}
