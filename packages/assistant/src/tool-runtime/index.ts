import type { ToolSet } from "@alfred/ai";
import {
  activateWorkflowInput,
  authorWorkflowInput,
  readChatHistoryInput,
  type AgentTranscriptMessage,
  type CancellationFence,
  type IanaTimezone,
  type IntegrationAvailabilitySnapshot,
  type TOOL_INPUT_SCHEMAS,
  type ToolName,
  type ToolRunContext,
  type WakeCondition,
  type WorkflowRequiredCapability,
} from "@alfred/contracts";
import type { z } from "zod";
import { bootPort } from "./boot-port";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import { runToolCallRound } from "./internal/tool-call-round";
import type { SpawnSubAgentInput } from "./sub-agent-contract";
export { isMutatingToolName } from "./internal/result-routing";
export { joinToolInput } from "./join-contract";
// The tool catalog. `internal/registry.ts` owns the one
// `Map<ToolName, RegisteredTool>` every reader in every package resolves; the
// map itself and its sorted cache are module-locals that no export can name.
// The FILE remains reachable through the package's wildcard deep export until
// campaign item 105 fences `internal/` imports. Two groups below, and the split
// is deliberate.
//
// GROUP A — permanent, 8 names. The registration + tool-contract door.
// `docs/plans/agent-friendly-module-structure.md:210` gives this module the
// interface "registerTools, resolveSurface, executeCalls, resolveApproval;
// registry and queues stay private", so `registerTools` is plan-sanctioned. The
// other three plan names are not symbols in this repo: `resolveToolSurface` and
// `executeToolCallRound` further down this file are their live equivalents, and
// approval resolution sits in `dispatch`. Built-in definition files build
// entries with `liveTool`, and `builtin-tools.ts` makes every production
// registration call. `registerTool` (singular) remains the fixture door.
// `riskTierCountsForIntegration` is the permanent web-facing projection used
// by `@alfred/http`; it cannot read the private registry implementation.
export {
  liveTool,
  registerTool,
  registerTools,
  clearToolRegistryForTests,
  riskTierCountsForIntegration,
  type RegisteredTool,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
} from "./internal/registry";
export {
  awaitSubAgentInputSchema,
  spawnSubAgentInputSchema,
  subAgentIdSchema,
  type SpawnSubAgentInput,
} from "./sub-agent-contract";
export { bootPort, type BootPort } from "./boot-port";
export { startToolLoadSpan, startToolSearchSpan } from "./internal/runtime-spans";
export {
  registerWorkflowToolCatalogSource,
  workflowToolCatalog,
  type WorkflowToolCatalog,
  type WorkflowToolCatalogSource,
  type WorkflowToolFacts,
} from "./workflow-tool-catalog";
// Action-staging approval SCHEDULING surface (ADR-0034). The delayed-job
// wrappers stay here because they import only queue/connection + contracts,
// keeping tool-runtime a 0-outgoing-edge sink; the dispatcher and the decision
// API schedule/remove through this door. The worker side (wake/notify) lives in
// `agent/` (execution), which drives the run-wake primitive + `delivery.send`.
export {
  APPROVAL_EXPIRY_QUEUE_NAME,
  approvalExpiryJobId,
  approvalExpiryJobDataSchema,
  getApprovalExpiryQueue,
  scheduleApprovalExpiryJob,
  removeApprovalExpiryJob,
  closeApprovalExpiryQueue,
  type ApprovalExpiryJobData,
} from "./approval-expiry-queue";
export {
  APPROVAL_NOTIFICATION_QUEUE_NAME,
  approvalNotificationJobId,
  approvalNotificationJobDataSchema,
  getApprovalNotificationQueue,
  scheduleApprovalNotificationJob,
  removeApprovalNotificationJob,
  closeApprovalNotificationQueue,
  type ApprovalNotificationJobData,
} from "./approval-notification-queue";

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
  /**
   * The cancellation fence this step started under (#559b). The dispatch gate
   * re-reads the run's current fence before each effect and refuses the call
   * when the current value has moved past it. Bounded contract from
   * `@alfred/contracts` — the tool runtime consumes it without importing any
   * execution implementation.
   */
  fence: CancellationFence;
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

/**
 * Caller label for trace metadata: `boss` or `sub:<id>`. The single source for
 * this format — execute spans, reject spans, sub-agent-await spans, and the
 * workflow's `runtime.dispatch.batch` span all derive their caller through here,
 * so a run's spans tag the same caller identically and the format lives in one
 * place if it ever changes.
 */
export function callerLabel(caller: ToolCallActor["caller"] | undefined): string {
  if (caller === undefined || caller === "boss") return "boss";
  return `sub:${caller.subId}`;
}

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

/**
 * Surface:  chat.
 * Owns/hides: owns the executable tool surface — surface restore, surface
 *   resolve, integration-name projection, and preload selection. Hides the tools
 *   IMPLEMENTATION that answers them: the credential and availability gates,
 *   integration projection, and preload selector. That implementation lives in
 *   `tool-runtime/surface-adapter.ts` and reaches `connections` -> `@alfred/db`.
 * Why the seam: it keeps that implementation and its database-bearing import
 *   graph out of this barrel's eager load graph.
 * Wiring: tool-runtime/surface-adapter.ts installs; the tool-runtime forwarders
 *   (resolveToolSurface, restoreToolSurface, selectToolPreload) read.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
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

const toolRuntimeAdapterPort = bootPort<ToolRuntimeAdapter>("tool runtime adapter");

/**
 * Surface:  chat.
 * Owns/hides: the ToolCallRoundAdapter interface lives in ./internal/adapter;
 *   this seam owns the guarded dispatch of one tool-call round. Hides the
 *   dispatch module.
 * Why the seam: it inverts tool-runtime -> dispatch, so the call-round runs the
 *   guarded dispatcher without an import edge to dispatch.
 * Wiring: dispatch/index.ts installs; executeToolCallRound (this file) reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
const toolCallRoundAdapterPort = bootPort<ToolCallRoundAdapter>("tool call-round adapter");

/** Runtime composition registers the current tools implementation before workers start. */
export function registerToolRuntimeAdapter(adapter: ToolRuntimeAdapter): () => void {
  return toolRuntimeAdapterPort.install(adapter);
}

/** Runtime composition installs the guarded dispatcher behind the call-round seam. */
export function registerToolCallRoundAdapter(adapter: ToolCallRoundAdapter): () => void {
  return toolCallRoundAdapterPort.install(adapter);
}

type ReadChatHistoryInput = z.infer<typeof readChatHistoryInput>;
// The workflow-authoring seam carries the exact tool inputs the model produces,
// not the branded `@alfred/contracts` activation type. The tool schemas coerce
// JSON array fields, so their inferred shape (for example `allowedTools:
// string[]`) is what the workflow owner receives and re-validates.
type AuthorWorkflowToolInput = z.infer<typeof authorWorkflowInput>;
type ActivateWorkflowToolInput = z.infer<typeof activateWorkflowInput>;

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

export interface JoinChildRunRequest {
  parentRunId: string;
  userId: string;
  childRunId: string;
}

declare const safeToParkSignalBrand: unique symbol;

/**
 * A signal name whose dead-man wake is already scheduled.
 *
 * Execution owns the only mint, after its scheduler returns `scheduled`. The
 * brand crosses the adapter seam so another adapter cannot return a plain
 * signal name and accidentally park a run without that backstop.
 */
export type SafeToParkSignal = string & {
  readonly [safeToParkSignalBrand]: true;
};

export type AwaitSubAgentDispatchResult =
  | {
      kind: "executed";
      stagingId: null;
      toolResult: unknown;
      editedByUser: false;
    }
  | {
      kind: "parked";
      wake: Extract<WakeCondition, { kind: "signal" }> & { name: SafeToParkSignal };
    };

export type SystemToolScratchRead =
  | { runId: string; zone: "shared"; path: string }
  | { runId: string; zone: "scratch"; subId: string; path: string };

export type SystemToolScratchWrite = SystemToolScratchRead & {
  value: unknown;
  writtenBy: string;
};

export interface SystemToolScratchPromote {
  runId: string;
  fromSubId: string;
  fromPath: string;
  toSharedPath: string;
  writtenBy?: string | undefined;
}

/**
 * Surface:  chat.
 * Owns/hides: owns the agent-behavior door the system tools reach — spawn a
 *   sub-agent, read a child run outcome. Hides the agent runtime and its state
 *   (`agentRuns`). Each method returns `unknown`, so no agent result type crosses
 *   the seam.
 * Why the seam: it inverts tool-runtime -> execution, so tool-runtime never
 *   imports the agent runtime.
 * Wiring: execution/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolAgentAdapter {
  spawnSubAgent(args: SpawnSubAgentRequest): Promise<unknown>;
  readChildRunOutcome(args: JoinChildRunRequest): Promise<unknown>;
  resolveAwaitSubAgent(args: JoinChildRunRequest): Promise<AwaitSubAgentDispatchResult>;
  readScratch(args: SystemToolScratchRead): Promise<unknown>;
  writeScratch(args: SystemToolScratchWrite): Promise<unknown>;
  promoteScratch(args: SystemToolScratchPromote): Promise<unknown>;
}

const systemToolAgentAdapterPort = bootPort<SystemToolAgentAdapter>("system-tool agent adapter");

/** Runtime composition installs the agent-behavior handler at boot. */
export function registerSystemToolAgentAdapter(adapter: SystemToolAgentAdapter): () => void {
  return systemToolAgentAdapterPort.install(adapter);
}

/**
 * Surface:  chat.
 * Owns/hides: owns the chat-history door the `system.read_chat_history` tool
 *   reaches — read bounded raw evidence from the current chat thread. Hides the
 *   `chat` retrieval implementation and its chat-message/attachment
 *   state. The method returns `unknown`, so no chat result type crosses
 *   the seam.
 * Why the seam: it inverts tool-runtime -> chat, so tool-runtime never
 *   imports a product recipe. `chat` installs its own half over the
 *   existing `chat -> tool-runtime` edge, so no new module edge is added.
 * Wiring: chat/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolChatHistoryAdapter {
  readChatHistory(args: {
    userId: string;
    threadId: string;
    input: ReadChatHistoryInput;
  }): Promise<unknown>;
}

const systemToolChatHistoryAdapterPort = bootPort<SystemToolChatHistoryAdapter>(
  "system-tool chat-history adapter",
);

/** Runtime composition installs the chat-history handler at boot. */
export function registerSystemToolChatHistoryAdapter(
  adapter: SystemToolChatHistoryAdapter,
): () => void {
  return systemToolChatHistoryAdapterPort.install(adapter);
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

/** Resolve the join protocol while preserving execution's safe-to-park proof. */
export function resolveAwaitSubAgent(
  args: JoinChildRunRequest,
): Promise<AwaitSubAgentDispatchResult> {
  return requireSystemToolAgentAdapter().resolveAwaitSubAgent(args);
}

/** Read one run-local scratch entry behind the execution-owned adapter. */
export function readScratch(args: SystemToolScratchRead): Promise<unknown> {
  return requireSystemToolAgentAdapter().readScratch(args);
}

/** Write one run-local scratch entry behind the execution-owned adapter. */
export function writeScratch(args: SystemToolScratchWrite): Promise<unknown> {
  return requireSystemToolAgentAdapter().writeScratch(args);
}

/** Promote one sub-agent scratch entry behind the execution-owned adapter. */
export function promoteScratch(args: SystemToolScratchPromote): Promise<unknown> {
  return requireSystemToolAgentAdapter().promoteScratch(args);
}

export type SystemToolRequest<Name extends keyof typeof TOOL_INPUT_SCHEMAS> = {
  input: z.infer<(typeof TOOL_INPUT_SCHEMAS)[Name]>;
  context: {
    userId: string;
    runId: string;
    stepId: string;
    toolCallId: string;
  };
};

/**
 * Surface: chat.
 * Owns/hides: knowledge reads, standing-instruction writes, and live web search.
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolKnowledgeAdapter {
  readUserContext(args: SystemToolRequest<"system.read_user_context">): Promise<unknown>;
  rememberSenderSuppressionAndDismissTodos(
    args: SystemToolRequest<"system.remember">,
  ): Promise<unknown>;
  listInstructions(args: SystemToolRequest<"system.list_instructions">): Promise<unknown>;
  forgetInstruction(args: SystemToolRequest<"system.forget_instruction">): Promise<unknown>;
  editInstruction(args: SystemToolRequest<"system.edit_instruction">): Promise<unknown>;
  webSearch(args: SystemToolRequest<"system.web_search">): Promise<unknown>;
}

/**
 * Surface: chat.
 * Owns/hides: todo suggestion and Gmail-sender todo resolution.
 * Why the seam: tool-runtime must not import tasks or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolTaskAdapter {
  resolveTodo(args: SystemToolRequest<"system.resolve_todo">): Promise<unknown>;
  suggestTodo(args: SystemToolRequest<"system.suggest_todo">): Promise<unknown>;
}

const systemToolKnowledgeAdapterPort = bootPort<SystemToolKnowledgeAdapter>(
  "system-tool knowledge adapter",
);
const systemToolTaskAdapterPort = bootPort<SystemToolTaskAdapter>("system-tool task adapter");

export function registerSystemToolKnowledgeAdapter(
  adapter: SystemToolKnowledgeAdapter,
): () => void {
  return systemToolKnowledgeAdapterPort.install(adapter);
}

export function registerSystemToolTaskAdapter(adapter: SystemToolTaskAdapter): () => void {
  return systemToolTaskAdapterPort.install(adapter);
}

export function readUserContext(
  args: SystemToolRequest<"system.read_user_context">,
): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().readUserContext(args);
}

export function rememberSenderSuppressionAndDismissTodos(
  args: SystemToolRequest<"system.remember">,
): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().rememberSenderSuppressionAndDismissTodos(args);
}

export function listInstructions(
  args: SystemToolRequest<"system.list_instructions">,
): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().listInstructions(args);
}

export function forgetInstruction(
  args: SystemToolRequest<"system.forget_instruction">,
): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().forgetInstruction(args);
}

export function editInstruction(
  args: SystemToolRequest<"system.edit_instruction">,
): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().editInstruction(args);
}

export function webSearch(args: SystemToolRequest<"system.web_search">): Promise<unknown> {
  return systemToolKnowledgeAdapterPort.read().webSearch(args);
}

export function resolveTodo(args: SystemToolRequest<"system.resolve_todo">): Promise<unknown> {
  return systemToolTaskAdapterPort.read().resolveTodo(args);
}

export function suggestTodo(args: SystemToolRequest<"system.suggest_todo">): Promise<unknown> {
  return systemToolTaskAdapterPort.read().suggestTodo(args);
}

/** Read bounded raw evidence from the current chat thread. */
export function readChatHistory(args: {
  userId: string;
  threadId: string;
  input: ReadChatHistoryInput;
}): Promise<unknown> {
  return requireSystemToolChatHistoryAdapter().readChatHistory(args);
}

/**
 * Surface:  chat.
 * Owns/hides: owns the workflow-behavior door the system tools reach
 *   (`system.author_workflow` / `system.recover_workflow` /
 *   `system.activate_workflow`) — author, recover, and activate a workflow, then
 *   shape the tool result. Hides workflow authoring, revision, recovery, and
 *   readiness policy. Each method returns `unknown`, so no workflow result type
 *   crosses the seam.
 * Why the seam: it inverts tool-runtime -> workflows, so tool-runtime never imports
 *   workflows.
 * Wiring: workflows/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolWorkflowAdapter {
  authorWorkflow(args: {
    userId: string;
    runId: string;
    timezone: IanaTimezone;
    input: AuthorWorkflowToolInput;
  }): Promise<unknown>;
  recoverWorkflow(args: {
    userId: string;
    workflowId: string;
    revisionId: string;
  }): Promise<unknown>;
  activateWorkflow(args: {
    userId: string;
    input: ActivateWorkflowToolInput;
    createdByRunId: string;
  }): Promise<unknown>;
}

const systemToolWorkflowAdapterPort = bootPort<SystemToolWorkflowAdapter>(
  "system-tool workflow adapter",
);

/** Runtime composition installs the workflow-behavior handler at boot. */
export function registerSystemToolWorkflowAdapter(adapter: SystemToolWorkflowAdapter): () => void {
  return systemToolWorkflowAdapterPort.install(adapter);
}

/** Author or revise a workflow draft behind the registered workflow-behavior seam. */
export function authorWorkflow(args: {
  userId: string;
  runId: string;
  timezone: IanaTimezone;
  input: AuthorWorkflowToolInput;
}): Promise<unknown> {
  return requireSystemToolWorkflowAdapter().authorWorkflow(args);
}

/** Revalidate a blocked workflow draft after setup behind the registered seam. */
export function recoverWorkflow(args: {
  userId: string;
  workflowId: string;
  revisionId: string;
}): Promise<unknown> {
  return requireSystemToolWorkflowAdapter().recoverWorkflow(args);
}

/** Publish an approved workflow revision behind the registered seam. */
export function activateWorkflow(args: {
  userId: string;
  input: ActivateWorkflowToolInput;
  createdByRunId: string;
}): Promise<unknown> {
  return requireSystemToolWorkflowAdapter().activateWorkflow(args);
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
  return toolRuntimeAdapterPort.read();
}

function requireToolCallRoundAdapter(): ToolCallRoundAdapter {
  return toolCallRoundAdapterPort.read();
}

function requireSystemToolAgentAdapter(): SystemToolAgentAdapter {
  return systemToolAgentAdapterPort.read();
}

function requireSystemToolChatHistoryAdapter(): SystemToolChatHistoryAdapter {
  return systemToolChatHistoryAdapterPort.read();
}

function requireSystemToolWorkflowAdapter(): SystemToolWorkflowAdapter {
  return systemToolWorkflowAdapterPort.read();
}
