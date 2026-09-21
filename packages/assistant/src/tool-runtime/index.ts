import type { ToolSet } from "@alfred/ai";
import {
  activateWorkflowInput,
  authorWorkflowInput,
  readChatHistoryInput,
  type ActivateWorkflowInput,
  type AgentTranscriptMessage,
  type CancellationFence,
  type ChatConnectNudge,
  type IanaTimezone,
  type IntegrationAvailabilitySnapshot,
  type PersistedWorkflowReadinessProblem,
  type ScratchEntry,
  type StandingInstructionDroppedInput,
  type StandingInstructionOverlap,
  type StandingInstructionScopeNarrowing,
  type StandingInstructionValue,
  type TOOL_INPUT_SCHEMAS,
  type ToolName,
  type ToolRunContext,
  type ToolUnavailabilityCode,
  type WakeCondition,
  type WorkflowRecoveryNavigation,
  type WorkflowRequiredCapability,
} from "@alfred/contracts";
import type { z } from "zod";
import { bootPort } from "./boot-port";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import { runToolCallRound } from "./internal/tool-call-round";
import type { SpawnSubAgentInput } from "./sub-agent-contract";

export { isMutatingToolName } from "./internal/result-routing";

export { withdrawToolCallApproval } from "./approval-lifecycle";

export { joinToolInput } from "./join-contract";

export { questionToolInput, QUESTION_TOOL_PROBE_INPUT } from "./question-contract";

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
  notificationJobDataSchema,
  scheduleWorkflowBlockedNotificationJob,
  workflowBlockedNotificationJobDataSchema,
  workflowBlockedNotificationJobId,
  type ApprovalNotificationJobData,
  type NotificationJobData,
  type WorkflowBlockedNotificationJobData,
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
  /**
   * Set only when the floor refused this call on connection health (#378 item
   * 3): the user-meaningful repair the chat surfaces as a connect nudge, live
   * and on the durable row. Absent on every other refusal.
   */
  connectNudge?: ChatConnectNudge | undefined;
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
 * The spawn receipt `system.spawn_sub_agent` returns to the model. Mirrors
 * the `spawnSubAgent` result in `execution/sub-agents.ts`, which stays the
 * source of truth — this seam type exists so tool-runtime never imports
 * execution (ADR-0089).
 */
export interface SpawnSubAgentResult {
  readonly ok: true;
  readonly status: "spawned" | "already_spawned";
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly subId: string;
}

/**
 * A spawned child run's real outcome for a joining parent. Mirrors
 * `ChildRunOutcome` in `execution/sub-agents.ts`, which stays the source of
 * truth — this seam type exists so tool-runtime never imports execution
 * (ADR-0089). `output`/`error` stay `unknown`: the child's payload is
 * untyped at this boundary by design.
 */
export interface ChildRunOutcomeResult {
  readonly ok: boolean;
  /** True once the child reached a terminal status (completed/failed/cancelled). */
  readonly done: boolean;
  readonly status: string;
  /** Present for a completed child — its run output. */
  readonly output?: unknown;
  /** Present for a failed child — its terminal error. */
  readonly error?: unknown;
  /** ms the child has been running, used by the await wait-ceiling. */
  readonly runningMs?: number | undefined;
  /** Why the call could not return the child's result, if applicable. */
  readonly reason?: string;
}

/**
 * Surface:  chat.
 * Owns/hides: owns the agent-behavior door the system tools reach — spawn a
 *   sub-agent, read a child run outcome. Hides the agent runtime and its state
 *   (`agentRuns`). Each method returns a named seam result, so no agent result
 *   type crosses the seam.
 * Why the seam: it inverts tool-runtime -> execution, so tool-runtime never
 *   imports the agent runtime.
 * Wiring: execution/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolAgentAdapter {
  spawnSubAgent(args: SpawnSubAgentRequest): Promise<SpawnSubAgentResult>;
  readChildRunOutcome(args: JoinChildRunRequest): Promise<ChildRunOutcomeResult>;
  resolveAwaitSubAgent(args: JoinChildRunRequest): Promise<AwaitSubAgentDispatchResult>;
  readScratch(args: SystemToolScratchRead): Promise<ScratchEntry<unknown> | null>;
  writeScratch(args: SystemToolScratchWrite): Promise<void>;
  promoteScratch(args: SystemToolScratchPromote): Promise<ScratchEntry<unknown> | null>;
}

const systemToolAgentAdapterPort = bootPort<SystemToolAgentAdapter>("system-tool agent adapter");

/** Runtime composition installs the agent-behavior handler at boot. */
export function registerSystemToolAgentAdapter(adapter: SystemToolAgentAdapter): () => void {
  return systemToolAgentAdapterPort.install(adapter);
}

/**
 * A bounded excerpt of a stored text field. The model sees `text` plus the
 * truncation facts, so a cut excerpt never reads as a complete field.
 */
export interface ChatHistoryExcerpt {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

/** One message's model-facing evidence inside a chat-history read. */
export interface ChatHistoryMessageEvidence {
  readonly kind: "message";
  readonly id: string;
  readonly role: string;
  readonly createdAt: string;
  readonly content: ChatHistoryExcerpt;
  readonly toolCallIds: readonly string[];
}

/** One attachment's model-facing evidence inside a chat-history read. */
export interface ChatHistoryAttachmentEvidence {
  readonly kind: "attachment";
  readonly id: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly name: string;
  readonly mime: string;
  readonly status: string;
  readonly extractedText: ChatHistoryExcerpt;
  readonly representation: ChatHistoryExcerpt | null;
  readonly failureReason: ChatHistoryExcerpt | null;
}

/** One tool call's model-facing evidence inside a chat-history read. */
export interface ChatHistoryToolCallEvidence {
  readonly kind: "tool_call";
  readonly id: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly toolName: string;
  readonly status: string;
  readonly args: ChatHistoryExcerpt;
  readonly outcome: ChatHistoryExcerpt;
  readonly sanitized: boolean;
}

/**
 * The packed result `system.read_chat_history` returns to the model. Search
 * mode answers with bounded message evidence; fetch mode answers with one
 * message, attachment, or tool-call evidence, or a not-found note carrying
 * the requested kind and id. Error cases carry `error`, never a throw —
 * a direct caller that skips the dispatch-layer parse still gets a value.
 */
export type ChatHistoryToolResult =
  | { readonly ok: false; readonly mode: "search"; readonly error: string }
  | {
      readonly ok: true;
      readonly mode: "search";
      readonly query: string;
      readonly results: readonly ChatHistoryMessageEvidence[];
    }
  | { readonly ok: false; readonly mode: "fetch"; readonly error: string }
  | {
      readonly ok: true;
      readonly mode: "fetch";
      readonly found: false;
      readonly kind: string;
      readonly id: string;
    }
  | {
      readonly ok: true;
      readonly mode: "fetch";
      readonly found: true;
      readonly result:
        | ChatHistoryMessageEvidence
        | ChatHistoryAttachmentEvidence
        | ChatHistoryToolCallEvidence;
    };

/**
 * Surface:  chat.
 * Owns/hides: owns the chat-history door the `system.read_chat_history` tool
 *   reaches — read bounded raw evidence from the current chat thread. Hides the
 *   `chat` retrieval implementation and its chat-message/attachment
 *   state. The method returns the named `ChatHistoryToolResult`, so the
 *   result shape the model consumes is owned here rather than widened to
 *   `unknown`.
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
  }): Promise<ChatHistoryToolResult>;
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
export function spawnSubAgent(args: SpawnSubAgentRequest): Promise<SpawnSubAgentResult> {
  return requireSystemToolAgentAdapter().spawnSubAgent(args);
}

/** Read a spawned child run's real outcome for a joining parent. */
export function readChildRunOutcome(args: {
  parentRunId: string;
  userId: string;
  childRunId: string;
}): Promise<ChildRunOutcomeResult> {
  return requireSystemToolAgentAdapter().readChildRunOutcome(args);
}

/** Resolve the join protocol while preserving execution's safe-to-park proof. */
export function resolveAwaitSubAgent(
  args: JoinChildRunRequest,
): Promise<AwaitSubAgentDispatchResult> {
  return requireSystemToolAgentAdapter().resolveAwaitSubAgent(args);
}

/** Read one run-local scratch entry behind the execution-owned adapter. */
export function readScratch(args: SystemToolScratchRead): Promise<ScratchEntry<unknown> | null> {
  return requireSystemToolAgentAdapter().readScratch(args);
}

/** Write one run-local scratch entry behind the execution-owned adapter. */
export function writeScratch(args: SystemToolScratchWrite): Promise<void> {
  return requireSystemToolAgentAdapter().writeScratch(args);
}

/** Promote one sub-agent scratch entry behind the execution-owned adapter. */
export function promoteScratch(
  args: SystemToolScratchPromote,
): Promise<ScratchEntry<unknown> | null> {
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
 * The user context `system.read_user_context` returns to the model. Mirrors
 * `UserContext` in `knowledge/user-context.ts`, which stays the source of
 * truth — this seam type exists so tool-runtime never imports knowledge
 * (ADR-0089). Dynamic leaves (`value`, `aliases`, `metadata`) stay `unknown`:
 * they are untyped at this boundary by design.
 */
export interface ReadUserContextResult {
  readonly profile: {
    readonly name: string;
    readonly email: string;
    readonly currentCompany: string | null;
    readonly currentRole: string | null;
    readonly currentWork: string | null;
    readonly currentLocation: string | null;
    readonly bioSummary: string | null;
    readonly identityFacts: readonly {
      readonly key: string;
      readonly value: string;
      readonly confidence: number;
    }[];
  } | null;
  readonly activeIntegrations: readonly {
    readonly provider: string;
    readonly accountLabel: string | null;
  }[];
  readonly confirmedFacts: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly confidence: number;
  }[];
  readonly preferences: readonly { readonly key: string; readonly value: unknown }[];
  readonly entities: readonly {
    readonly id: string;
    readonly kind: string;
    readonly canonicalName: string;
    readonly aliases: unknown;
    readonly metadata: unknown;
  }[];
  readonly relations: readonly {
    readonly relation: string;
    readonly fromEntityId: string;
    readonly from: string | null;
    readonly toEntityId: string;
    readonly to: string | null;
    readonly metadata: unknown;
  }[];
  readonly recentMemory: readonly { readonly kind: string; readonly preview: string }[];
}

/**
 * One web-search source inside a `system.web_search` result. Mirrors the
 * source shape in `knowledge/web-search.ts`, which stays the source of truth.
 */
export interface WebSearchResultSource {
  readonly url: string;
  readonly title?: string | undefined;
}

/**
 * One web-search hit inside a `system.web_search` result. Mirrors the hit
 * shape in `knowledge/web-search.ts`, which stays the source of truth.
 */
export interface WebSearchResultHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/**
 * The result `system.web_search` returns to the model. The evidence shapes
 * mirror `WebSearchResult` in `knowledge/web-search.ts`, which stays the
 * source of truth; the `ok`/`query` envelope is minted here, beside the
 * adapter that adds it.
 */
export interface WebSearchToolResult {
  readonly ok: true;
  readonly query: string;
  readonly answer: string;
  readonly citations: readonly WebSearchResultSource[];
  readonly results: readonly WebSearchResultHit[];
  readonly searchQueries: readonly string[];
}

/**
 * The single-sender result `system.remember` returns to the model. The
 * suppression half mirrors `RememberSenderSuppressionResult` in
 * `knowledge/standing-instructions.ts`, which stays the source of truth; the
 * `resolvedTodos` half is the task dismissal the coordinator runs after the
 * write lands.
 */
export type RememberSenderSuppressionAndDismissResult =
  | {
      readonly ok: true;
      readonly status: "remembered" | "already_exists";
      readonly factId: string;
      readonly instruction: StandingInstructionValue;
      readonly resolvedSenderEmail: string;
      /**
       * Active instructions that strictly contain, or are strictly contained
       * by, the stored target — drawn from the same row snapshot that decided
       * `status`. A concurrent nesting write can be absent on either axis: the
       * write lock reads the sender alone, the snapshot filter reads the
       * transaction timestamp rather than the lock order, and the
       * `already_exists` path returns before the lock. The field on
       * `RememberSenderSuppressionResult` states the three limits. Capped;
       * `overlapCount` carries the true total.
       */
      readonly overlaps: readonly StandingInstructionOverlap[];
      readonly overlapCount: number;
      /** Set when the caller asked for `scope:"domain"` and got one address. */
      readonly scopeNarrowing: StandingInstructionScopeNarrowing | null;
      /**
       * Inputs the write could not store because the stored target names a
       * CLASS: a `directive` the derived domain sentence supersedes, a
       * `senderLabel` the domain arm has no field for. Empty when the write
       * stored everything the model sent. The model reads this and tells the
       * user, the same way it reads `scopeNarrowing`.
       */
      readonly droppedInputs: readonly StandingInstructionDroppedInput[];
      readonly resolvedTodos: ResolveTodoResult;
    }
  | {
      readonly ok: false;
      readonly status: "needs_clarification";
      readonly reason: "invalid_sender_email";
      readonly message: string;
    };

/**
 * One sender's outcome inside a batch `system.remember` result: the
 * single-sender result, or the error a throw mid-batch produced for that
 * sender alone.
 */
export type RememberBatchEntryResult =
  | RememberSenderSuppressionAndDismissResult
  | { readonly ok: false; readonly status: "failed"; readonly message: string };

/**
 * The batch result `system.remember` returns when several senders were named.
 * Minted beside the coordinator in `runtime/adapters/system-tool-product.ts`;
 * the entries inside it are the derived single-sender result.
 *
 * UNIT SPLIT. `rememberedCount` is DISTINCT INSTRUCTION ROWS the batch wrote
 * or affirmed — several senders collapsing onto one domain instruction report
 * 1 with one entry each, because the second remember of the same target
 * collapses onto the first row instead of writing again. `clarificationCount`
 * keeps the other unit: per-sender ENTRIES that clarified, derived from the
 * ok-ENTRY count and never from `rememberedCount`, or the two units mix.
 * `ok` stays `rememberedCount > 0`, so a batch that fully collapses onto an
 * existing row still reports success.
 */
export interface RememberBatchResult {
  readonly ok: boolean;
  readonly status: "batch";
  readonly results: readonly {
    readonly senderEmail: string;
    readonly result: RememberBatchEntryResult;
  }[];
  /** Distinct `factId`s across ok entries — instruction rows, not senders. */
  readonly rememberedCount: number;
  /** Per-sender entries that clarified — entry count, never row count. */
  readonly clarificationCount: number;
  readonly failedCount: number;
}

/**
 * One standing instruction inside a `system.list_instructions` result.
 * Mirrors `StandingInstructionSummary` in
 * `knowledge/standing-instructions.ts`, which stays the source of truth.
 */
export interface StandingInstructionSummaryResult {
  readonly factId: string;
  readonly action: StandingInstructionValue["action"];
  readonly target: StandingInstructionValue["target"];
  readonly effects: StandingInstructionValue["effects"];
  readonly directive: string;
  readonly validFrom: Date;
}

/**
 * The result `system.list_instructions` returns to the model. Mirrors
 * `StandingInstructionListResult` in `knowledge/standing-instructions.ts`,
 * which stays the source of truth.
 */
export interface ListInstructionsResult {
  readonly instructions: readonly StandingInstructionSummaryResult[];
  readonly totalActive: number;
  readonly truncated: boolean;
  readonly limit: number;
}

/**
 * The result `system.forget_instruction` returns to the model. Mirrors
 * `ForgetStandingInstructionResult` in `knowledge/standing-instructions.ts`,
 * which stays the source of truth.
 */
export type ForgetInstructionResult =
  | {
      readonly ok: true;
      readonly status: "forgotten";
      readonly factId: string;
      readonly instruction: StandingInstructionValue;
    }
  | { readonly ok: false; readonly status: "not_found" };

/**
 * The result `system.edit_instruction` returns to the model. Mirrors
 * `EditStandingInstructionResult` in `knowledge/standing-instructions.ts`,
 * which stays the source of truth.
 */
export type EditInstructionResult =
  | {
      readonly ok: true;
      readonly status: "edited";
      readonly factId: string;
      readonly previousFactId: string;
      readonly instruction: StandingInstructionValue;
      /**
       * Edits the row could not take because its target names a CLASS — a
       * domain row's sentence is its target's, and the arm has no label
       * field. Empty on an address row. Without it, `edited` and `unchanged`
       * both answer a dropped request with no reason.
       */
      readonly droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | {
      readonly ok: true;
      readonly status: "unchanged";
      readonly factId: string;
      readonly instruction: StandingInstructionValue;
      /** Same reading as the `edited` arm: edits the row could not take. */
      readonly droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | { readonly ok: false; readonly status: "not_found" };

/**
 * Surface: chat.
 * Owns/hides: knowledge reads — the user-context read behind
 *   `system.read_user_context`. Hides the knowledge retrieval and its
 *   memory and entity state.
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolKnowledgeAdapter {
  readUserContext(
    args: SystemToolRequest<"system.read_user_context">,
  ): Promise<ReadUserContextResult>;
}

/**
 * Surface: chat.
 * Owns/hides: standing-instruction writes — remember, list, forget, and edit
 * behind `system.remember` and the instruction tools. Hides the knowledge
 * instruction store. Split out of the knowledge grab-bag so each port names
 * one product owner (ADR-0089 amendment 2026-09-19).
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolInstructionAdapter {
  rememberSenderSuppressionAndDismissTodos(
    args: SystemToolRequest<"system.remember">,
  ): Promise<RememberSenderSuppressionAndDismissResult | RememberBatchResult>;
  listInstructions(
    args: SystemToolRequest<"system.list_instructions">,
  ): Promise<ListInstructionsResult>;
  forgetInstruction(
    args: SystemToolRequest<"system.forget_instruction">,
  ): Promise<ForgetInstructionResult>;
  editInstruction(
    args: SystemToolRequest<"system.edit_instruction">,
  ): Promise<EditInstructionResult>;
}

/**
 * Surface: chat.
 * Owns/hides: live web search behind `system.web_search`. Hides the search
 * provider wiring. Split out of the knowledge grab-bag so each port names one
 * product owner (ADR-0089 amendment 2026-09-19).
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolWebSearchAdapter {
  webSearch(args: SystemToolRequest<"system.web_search">): Promise<WebSearchToolResult>;
}

/**
 * The result `system.resolve_todo` returns to the model. Mirrors
 * `ResolveTodosForGmailSourceResult` in `tasks/resolve.ts`, which stays the
 * source of truth — this seam type exists so tool-runtime never imports
 * tasks (ADR-0089).
 */
export type ResolveTodoResult =
  | {
      readonly ok: true;
      readonly status: "dismissed" | "not_found";
      readonly dismissedCount: number;
      readonly todoIds: readonly string[];
      readonly matchedThreadIds: readonly string[];
      readonly auditReason: string | null;
    }
  | {
      readonly ok: false;
      readonly status: "needs_clarification";
      readonly reason: "missing_source_or_sender";
      readonly message: string;
      readonly auditReason: string | null;
    };

/**
 * The result `system.suggest_todo` returns to the model. The first three
 * variants mirror `SuggestTodoResult` in `tasks/suggest.ts`, which stays the
 * source of truth; the fourth is the tool path's own already-answered guard,
 * which consults the same `readGmailThreadClosure` owner as the triage mint
 * (see `runtime/adapters/system-tool-product.ts`).
 */
export type SuggestTodoResult =
  | { readonly ok: true; readonly status: "created"; readonly todoId: string }
  | {
      readonly ok: true;
      readonly status: "merged";
      readonly todoId: string;
      readonly addedSources: number;
    }
  | {
      readonly ok: true;
      readonly status: "suppressed";
      readonly todoId: string;
      readonly reason: "done" | "dismissed";
    }
  | { readonly ok: true; readonly status: "suppressed"; readonly reason: "user_already_replied" };

/**
 * Surface: chat.
 * Owns/hides: todo suggestion and Gmail-sender todo resolution.
 * Why the seam: tool-runtime must not import tasks or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolTaskAdapter {
  resolveTodo(args: SystemToolRequest<"system.resolve_todo">): Promise<ResolveTodoResult>;
  suggestTodo(args: SystemToolRequest<"system.suggest_todo">): Promise<SuggestTodoResult>;
}

const systemToolKnowledgeAdapterPort = bootPort<SystemToolKnowledgeAdapter>(
  "system-tool knowledge adapter",
);

const systemToolInstructionAdapterPort = bootPort<SystemToolInstructionAdapter>(
  "system-tool instruction adapter",
);

const systemToolWebSearchAdapterPort = bootPort<SystemToolWebSearchAdapter>(
  "system-tool web search adapter",
);

const systemToolTaskAdapterPort = bootPort<SystemToolTaskAdapter>("system-tool task adapter");

export function registerSystemToolKnowledgeAdapter(
  adapter: SystemToolKnowledgeAdapter,
): () => void {
  return systemToolKnowledgeAdapterPort.install(adapter);
}

export function registerSystemToolInstructionAdapter(
  adapter: SystemToolInstructionAdapter,
): () => void {
  return systemToolInstructionAdapterPort.install(adapter);
}

export function registerSystemToolWebSearchAdapter(
  adapter: SystemToolWebSearchAdapter,
): () => void {
  return systemToolWebSearchAdapterPort.install(adapter);
}

export function registerSystemToolTaskAdapter(adapter: SystemToolTaskAdapter): () => void {
  return systemToolTaskAdapterPort.install(adapter);
}

export function readUserContext(
  args: SystemToolRequest<"system.read_user_context">,
): Promise<ReadUserContextResult> {
  return systemToolKnowledgeAdapterPort.read().readUserContext(args);
}

export function rememberSenderSuppressionAndDismissTodos(
  args: SystemToolRequest<"system.remember">,
): Promise<RememberSenderSuppressionAndDismissResult | RememberBatchResult> {
  return systemToolInstructionAdapterPort.read().rememberSenderSuppressionAndDismissTodos(args);
}

export function listInstructions(
  args: SystemToolRequest<"system.list_instructions">,
): Promise<ListInstructionsResult> {
  return systemToolInstructionAdapterPort.read().listInstructions(args);
}

export function forgetInstruction(
  args: SystemToolRequest<"system.forget_instruction">,
): Promise<ForgetInstructionResult> {
  return systemToolInstructionAdapterPort.read().forgetInstruction(args);
}

export function editInstruction(
  args: SystemToolRequest<"system.edit_instruction">,
): Promise<EditInstructionResult> {
  return systemToolInstructionAdapterPort.read().editInstruction(args);
}

export function webSearch(
  args: SystemToolRequest<"system.web_search">,
): Promise<WebSearchToolResult> {
  return systemToolWebSearchAdapterPort.read().webSearch(args);
}

export function resolveTodo(
  args: SystemToolRequest<"system.resolve_todo">,
): Promise<ResolveTodoResult> {
  return systemToolTaskAdapterPort.read().resolveTodo(args);
}

export function suggestTodo(
  args: SystemToolRequest<"system.suggest_todo">,
): Promise<SuggestTodoResult> {
  return systemToolTaskAdapterPort.read().suggestTodo(args);
}

/**
 * The packed result `system.search_context` returns to the model. It carries the
 * packer's truncation facts (`includedCount` / `omittedCount` / `truncated`) so
 * the model can disclose partial evidence instead of presenting an incomplete
 * read as complete. `ok` is true whenever the read ran — per-source empty and
 * failed outcomes are honest notes in `text`, because an empty read is a real
 * result, not a failed call. Typing this shape at the seam keeps the truncation
 * hazard in the type, not only in a docstring (structural-review "hazard rule").
 */
export interface ContextSearchToolResult {
  /** True whenever the read ran; the packer's per-source notes carry failures. */
  readonly ok: boolean;
  /** Bounded, cited, model-facing evidence text. */
  readonly text: string;
  /** How many cards made it into `text`. */
  readonly includedCount: number;
  /** Cards dropped by the budget or by the read's own `limit`. */
  readonly omittedCount: number;
  /** True when any card, note, or source line was left out of `text`. */
  readonly truncated: boolean;
}

/**
 * Surface:  chat.
 * Owns/hides: the cross-source evidence read the `system.search_context` tool
 *   reaches — one bounded query envelope in, packed evidence text out. Hides the
 *   `context-search` module (its registered source set, the vector/object
 *   adapters, and the packer) and its `@alfred/db` / `@alfred/corpus` reach. It
 *   returns the named `ContextSearchToolResult`, so the result shape the model
 *   consumes is owned here rather than widened to `unknown`.
 * Why the seam: tool-runtime must not import `@alfred/assistant/context-search`,
 *   whose adapters pull the database and corpus graphs into the eager tool
 *   barrel that every tool declaration imports (ADR-0101, ADR-0089).
 * Wiring: runtime/adapters/system-tool-context-search.ts installs;
 *   internal/tools/context-search.ts reads.
 * See: ADR-0101, ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolContextSearchAdapter {
  /**
   * Named `runContextSearch`, not `searchContext`: the boundary already exports
   * `searchContext` for the read verb (ADR-0101), and two same-named doors — one
   * the read, one the seam that reaches it — made the adapter import alias the
   * only clue. The forwarder keeps the same name.
   */
  runContextSearch(
    args: SystemToolRequest<"system.search_context">,
  ): Promise<ContextSearchToolResult>;
}

const systemToolContextSearchAdapterPort = bootPort<SystemToolContextSearchAdapter>(
  "system-tool context-search adapter",
);

/** Runtime composition installs the cross-source evidence read at boot. */
export function registerSystemToolContextSearchAdapter(
  adapter: SystemToolContextSearchAdapter,
): () => void {
  return systemToolContextSearchAdapterPort.install(adapter);
}

/** Read packed cross-source evidence behind the registered context-search seam. */
export function runContextSearch(
  args: SystemToolRequest<"system.search_context">,
): Promise<ContextSearchToolResult> {
  return systemToolContextSearchAdapterPort.read().runContextSearch(args);
}

/** Read bounded raw evidence from the current chat thread. */
export function readChatHistory(args: {
  userId: string;
  threadId: string;
  input: ReadChatHistoryInput;
}): Promise<ChatHistoryToolResult> {
  return requireSystemToolChatHistoryAdapter().readChatHistory(args);
}

/**
 * One readiness blocker inside a workflow tool result. The persisted problem
 * shape is contracts-owned; the code narrows to the live codes the readiness
 * module assigns (`readiness.ts`), which stays the source of truth.
 */
export type WorkflowReadinessBlocker = PersistedWorkflowReadinessProblem & {
  readonly code:
    | ToolUnavailabilityCode
    | "no_tool_surface"
    | "choose_account"
    | "resource_not_granted"
    | "trigger_not_ready"
    | "trigger_degraded";
};

/**
 * One definition problem inside a workflow failure. Mirrors
 * `WorkflowRevisionProblem` in `automation/revisions.ts`, which stays the
 * source of truth — this seam type exists so tool-runtime never imports
 * automation (ADR-0089).
 */
export interface WorkflowDefinitionProblem {
  readonly code:
    | "invalid_definition"
    | "invalid_cron"
    | "unschedulable_cron"
    | "invalid_raw_trigger"
    | "unseen_raw_kind"
    | "empty_integration_ceiling"
    | "trigger_source_not_allowed"
    | "tool_outside_ceiling"
    | "capability_outside_envelope"
    | "tool_without_capability"
    | "ambiguous_tool_capability"
    | "integration_outside_derived_ceiling";
  /** One safe sentence. Rendered on the activation card and in the blocked-draft state. */
  readonly message: string;
  /** Dotted path into the definition, when the problem belongs to one field. */
  readonly field?: string;
}

/**
 * A workflow service failure inside a tool result. Mirrors
 * `WorkflowServiceFailure` in `automation/revisions.ts`, which stays the
 * source of truth.
 */
export type WorkflowServiceFailureResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "builtin_immutable" }
  | { readonly kind: "slug_taken"; readonly slug: string }
  | { readonly kind: "no_current_revision" }
  | { readonly kind: "row_version_conflict"; readonly expected: number }
  | { readonly kind: "readiness_blocked"; readonly blockers: readonly WorkflowReadinessBlocker[] }
  | {
      readonly kind: "stale_revision";
      readonly expected: string;
      readonly actual: string;
      readonly expectedRevisionId?: string;
      readonly actualRevisionId?: string;
    }
  | { readonly kind: "validation_failed"; readonly problems: readonly WorkflowDefinitionProblem[] };

/** Shared blocked-draft shape for author and recover results. */
export interface BlockedWorkflowDraftResult {
  readonly ok: true;
  readonly status: "blocked";
  readonly workflowId: string;
  readonly revisionId: string;
  readonly readinessBlockers: readonly WorkflowReadinessBlocker[];
  readonly recovery?: WorkflowRecoveryNavigation;
}

/** The result `system.author_workflow` returns to the model. */
export type AuthorWorkflowResult =
  | {
      readonly ok: false;
      readonly status: WorkflowServiceFailureResult["kind"];
      readonly failure: WorkflowServiceFailureResult;
    }
  | (BlockedWorkflowDraftResult & {
      readonly rowVersion: number;
      readonly revisionNumber: number;
      readonly created: boolean;
    })
  | {
      readonly ok: true;
      readonly status: "ready_to_activate";
      readonly workflowId: string;
      readonly revisionId: string;
      readonly revisionNumber: number;
      readonly contentHash: string;
      readonly created: boolean;
      readonly activationProposal: ActivateWorkflowInput;
    };

/** The result `system.recover_workflow` returns to the model. */
export type RecoverWorkflowResult =
  | {
      readonly ok: false;
      readonly status: WorkflowServiceFailureResult["kind"];
      readonly failure: WorkflowServiceFailureResult;
    }
  | BlockedWorkflowDraftResult
  | {
      readonly ok: true;
      readonly status: "ready_to_activate";
      readonly workflowId: string;
      readonly revisionId: string;
      readonly activationProposal: ActivateWorkflowInput;
    };

/** The result `system.activate_workflow` returns to the model. */
export type ActivateWorkflowResult =
  | {
      readonly ok: false;
      readonly status: WorkflowServiceFailureResult["kind"];
      readonly failure: WorkflowServiceFailureResult;
    }
  | {
      readonly ok: true;
      readonly status: "activated";
      readonly workflowId: string;
      readonly revisionId: string;
      readonly revisionNumber: number;
      readonly contentHash: string;
      readonly nextRunAt: string | null;
      readonly revisedFromApprovalEdit: boolean;
    };

/**
 * Surface:  chat.
 * Owns/hides: owns the workflow-behavior door the system tools reach
 *   (`system.author_workflow` / `system.recover_workflow` /
 *   `system.activate_workflow`) — author, recover, and activate a workflow, then
 *   shape the tool result. Hides workflow authoring, revision, recovery, and
 *   readiness policy. Each method returns a named seam result, so no workflow
 *   result type crosses the seam.
 * Why the seam: it inverts tool-runtime -> workflows, so tool-runtime never imports
 *   workflows.
 * Wiring: automation/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolWorkflowAdapter {
  authorWorkflow(args: {
    userId: string;
    runId: string;
    timezone: IanaTimezone;
    input: AuthorWorkflowToolInput;
  }): Promise<AuthorWorkflowResult>;
  recoverWorkflow(args: {
    userId: string;
    workflowId: string;
    revisionId: string;
  }): Promise<RecoverWorkflowResult>;
  activateWorkflow(args: {
    userId: string;
    input: ActivateWorkflowToolInput;
    createdByRunId: string;
  }): Promise<ActivateWorkflowResult>;
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
}): Promise<AuthorWorkflowResult> {
  return requireSystemToolWorkflowAdapter().authorWorkflow(args);
}

/** Revalidate a blocked workflow draft after setup behind the registered seam. */
export function recoverWorkflow(args: {
  userId: string;
  workflowId: string;
  revisionId: string;
}): Promise<RecoverWorkflowResult> {
  return requireSystemToolWorkflowAdapter().recoverWorkflow(args);
}

/** Publish an approved workflow revision behind the registered seam. */
export function activateWorkflow(args: {
  userId: string;
  input: ActivateWorkflowToolInput;
  createdByRunId: string;
}): Promise<ActivateWorkflowResult> {
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
