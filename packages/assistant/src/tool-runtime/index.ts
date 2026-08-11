import type { ToolSet } from "@alfred/ai";
import {
  activateWorkflowInput,
  authorWorkflowInput,
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
import { bootPort } from "./boot-port";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import { runToolCallRound } from "./internal/tool-call-round";
import type { SpawnSubAgentInput } from "./sub-agent-contract";
export { isMutatingToolName } from "./internal/result-routing";
export { joinToolInput } from "./join-contract";
// The tool catalog. `internal/registry.ts` owns the one
// `Map<ToolName, RegisteredTool>` every reader in every package resolves; the
// map itself and its sorted cache are module-locals that no barrel re-exports as
// a value, so nothing outside this directory can name them. Two groups below,
// and the split is deliberate.
//
// GROUP A — permanent, 8 names. The registration + tool-contract door.
// `docs/plans/agent-friendly-module-structure.md:210` gives this module the
// interface "registerTools, resolveSurface, executeCalls, resolveApproval;
// registry and queues stay private", so `registerTools` is plan-sanctioned. The
// other three plan names are not symbols in this repo: `resolveToolSurface` and
// `executeToolCallRound` further down this file are their live equivalents, and
// approval resolution sits in `dispatch`. `@alfred/api`'s tool definitions are
// WRITERS: 12 files build entries with `liveTool`, and `modules/tools/
// runtime.ts` makes every registration call. `registerTool` (singular) has no
// production caller — item 97 narrows group A too, not only group B.
export {
  liveTool,
  registerTool,
  registerTools,
  clearToolRegistryForTests,
  type RegisteredTool,
  type LiveToolArgs,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
} from "./internal/registry";
// GROUP B — transitional readers, 13 names: the 12 in the statement below plus
// `singularizePhrase`, which needs its own statement because it comes from
// `./internal/metadata-defaults`. They are published only because the tool
// DEFINITIONS still live in `@alfred/api` while their catalog lives here, and
// they collapse into group A's 8-name shape when
// `packages/api/src/modules/tools/*` moves into this module. Nothing
// distinguishes them from group A to any check, so the removal phase is a queue
// item, not a lint. Do not add to this group.
//
// Removal phase (campaign item 97): once the tool definitions live here, delete
// this group and let this module's own surface forwarders answer the readers.
export {
  getTool,
  listRegisteredTools,
  listKernelTools,
  listToolsForIntegration,
  assertKernelToolsRegistered,
  riskTierCountsForIntegration,
  availableToolNames,
  evaluateToolRunContext,
  evaluateToolAvailability,
  evaluateToolCatalog,
  resolveToolAvailability,
  readsAvailabilitySnapshot,
} from "./internal/registry";
export { singularizePhrase } from "./internal/metadata-defaults";
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
 *   IMPLEMENTATION that answers them: the credential and availability gates, the
 *   integration projection, and the preload selector, all of which live in
 *   `@alfred/api`'s tools module. The catalog is NOT hidden by this seam any
 *   more — `internal/registry.ts` owns the one map, and the door at the top of
 *   this file publishes readers over it (group B, campaign item 97).
 * Why the seam: it inverts tool-runtime -> tools, so the runtime forwards to the
 *   installed tools implementation instead of importing it.
 * Wiring: tools/tool-runtime-adapter.ts installs; the tool-runtime forwarders
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

/**
 * Surface:  chat.
 * Owns/hides: owns the agent-behavior door the system tools reach — spawn a
 *   sub-agent, read a child run outcome. Hides the agent runtime and its state
 *   (`agentRuns`). Each method returns `unknown`, so no agent result type crosses
 *   the seam.
 * Why the seam: it inverts tools -> agent, so the tools layer never imports the
 *   agent runtime.
 * Wiring: agent/system-tool-adapter.ts installs; tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolAgentAdapter {
  spawnSubAgent(args: SpawnSubAgentRequest): Promise<unknown>;
  readChildRunOutcome(args: {
    parentRunId: string;
    userId: string;
    childRunId: string;
  }): Promise<unknown>;
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
 *   `conversations` retrieval implementation and its chat-message/attachment
 *   state. The method returns `unknown`, so no conversations result type crosses
 *   the seam.
 * Why the seam: it inverts tools -> conversations, so the tools layer never
 *   imports a product recipe. `conversations` installs its own half over the
 *   existing `conversations -> tool-runtime` edge, so no new module edge is added.
 * Wiring: conversations/system-tool-adapter.ts installs; tools/system.ts reads.
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
 * Why the seam: it inverts tools -> workflows, so the tools module never imports
 *   workflows.
 * Wiring: workflows/system-tool-adapter.ts installs; tools/system.ts reads.
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
