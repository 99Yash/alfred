import type { ToolSet } from "@alfred/ai";
import type {
  AgentTranscriptMessage,
  IanaTimezone,
  IntegrationAvailabilitySnapshot,
  ToolName,
  ToolRunContext,
  WakeCondition,
  WorkflowRequiredCapability,
} from "@alfred/contracts";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import { runToolCallRound } from "./internal/tool-call-round";
export { isMutatingToolName } from "./internal/result-routing";

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
