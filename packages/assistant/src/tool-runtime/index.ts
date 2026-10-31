import type { ToolSet, TranscriptMessage } from "@alfred/ai";
import type {
  IntegrationSlug,
  activateWorkflowInput,
  authorWorkflowInput,
  readChatHistoryInput,
  ActivateWorkflowInput,
  AttributionActor,
  CancellationFence,
  ChatConnectNudge,
  IanaTimezone,
  IntegrationAvailabilitySnapshot,
  PersistedWorkflowReadinessProblem,
  ScratchEntry,
  SpawnSubAgentInput,
  StandingInstructionDroppedInput,
  StandingInstructionOverlap,
  StandingInstructionValue,
  StandingInstructionValueV2,
  TOOL_INPUT_SCHEMAS,
  TodoSource,
  TodoStatus,
  ToolName,
  ToolRunContext,
  ToolUnavailabilityCode,
  WakeCondition,
  WorkflowRecoveryNavigation,
  WorkflowRequiredCapability,
} from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import type { z } from "zod";
import { bootPort } from "@alfred/assistant/boot-port";
import type { ToolCallRoundAdapter } from "./internal/adapter";
import type { ChatTurnAddress, ToolEffects } from "./internal/registry";
import { runToolCallRound } from "./internal/tool-call-round";

export { withdrawToolCallApproval } from "./approval-lifecycle";

export { questionToolInput, QUESTION_TOOL_PROBE_INPUT } from "./question-contract";

// The registry map stays private to `internal/registry.ts`. `builtin-tools.ts`
// makes every production registration; `registerTool` is the fixture door.
export {
  chatTurnAddressSchema,
  liveTool,
  registerTool,
  registerTools,
  clearToolRegistryForTests,
  riskTierCountsForIntegration,
  NO_TOOL_EFFECTS,
  type ChatTurnAddress,
  type LiveChatToolExecuteContext,
  type RegisteredTool,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
} from "./internal/registry";

export { startToolLoadSpan, startToolSearchSpan } from "./internal/runtime-spans";

export {
  registerWorkflowToolCatalogSource,
  workflowToolCatalog,
  type WorkflowToolCatalog,
  type WorkflowToolCatalogSource,
  type WorkflowToolFacts,
} from "./workflow-tool-catalog";

// Approval job scheduling (ADR-0034). The workers live in execution.
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
  approvalCardKey,
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
  /** Dispatch refuses an effect once the run's fence moves past this value. */
  fence: CancellationFence;
  /**
   * The executor attempt that holds the step. An `unsafe` tool claims its call under this lease,
   * so an attempt that lost the run cannot start the effect.
   */
  attempt: number;
  /** Set only for a live chat turn. */
  chat?: ChatTurnAddress | undefined;
  /**
   * The chat thread whose full-autonomy flag the approval gate reads (ADR-0069 amendment).
   * A chat turn and its sub-agents set it. A background run never does, so it keeps every floor.
   */
  approvalThreadId?: string | undefined;
  scratchpadRunId?: string | undefined;
  /** The run's snapshot, not a live read. Every dispatch carries its own run's zone. */
  timezone: IanaTimezone;
  allowedIntegrations?: readonly IntegrationSlug[] | undefined;
  allowedTools?: readonly ToolName[] | undefined;
  requiredCapabilities?: readonly WorkflowRequiredCapability[] | undefined;
}

/** Who proposes the calls: the boss, or one sub-agent with its matching run context. */
export type ToolCallActor =
  | { caller: "boss"; runContext: ToolRunContext & { caller: "boss" } }
  | {
      caller: { subId: string };
      runContext: ToolRunContext & { caller: "sub_agent" };
    };

/** Trace caller label: `boss` or `sub:<id>`. Every span uses this one format. */
export function callerLabel(caller: ToolCallActor["caller"] | undefined): string {
  if (caller === undefined || caller === "boss") return "boss";

  return `sub:${caller.subId}`;
}

/** Deduplicated and sorted, so two surfaces compare by value. */
export function uniqueToolNames(toolNames: readonly ToolName[]): ToolName[] {
  return [...new Set(toolNames)].toSorted();
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
  /** Set only when the floor refused the call on connection health. */
  connectNudge?: ChatConnectNudge | undefined;
  /**
   * Set only after an approval edit: the input that ran. `call.input` stays the model's proposal,
   * so a card that names the operation reads this first.
   */
  executedInput?: unknown;
  /** Set only by the join arm: the child run it resolved. */
  joinedChildRunId?: string | undefined;
  /** The executed call's effects. Empty for a call that did not execute. */
  effects: ToolEffects;
}

export type ToolCallRoundOutcome<Call extends ProposedToolCall = ProposedToolCall> =
  | { kind: "waiting"; wake: WakeCondition; activeNames: ToolName[] }
  | {
      kind: "completed";
      transcript: TranscriptMessage[];
      calls: CompletedToolCall<Call>[];
      activeNames: ToolName[];
      reissue: boolean;
    };

/**
 * Surface:  chat.
 * Owns/hides: restore, resolve, and preload of the tool surface. Hides the
 *   credential and availability gates.
 * Why the seam: keeps the database import graph out of this eager barrel.
 * Wiring: tool-runtime/surface-adapter.ts installs; the forwarders
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
    allowedIntegrations: readonly IntegrationSlug[];
    context: ToolRunContext;
  }): Map<string, ToolName[]>;
  selectPreload(input: {
    userId: string;
    transcript: readonly TranscriptMessage[];
    allowedIntegrations: readonly IntegrationSlug[];
    activeNames: readonly ToolName[];
    context: ToolRunContext;
    availability: IntegrationAvailabilitySnapshot;
  }): Promise<SelectedToolPreload>;
}

const toolRuntimeAdapterPort = bootPort<ToolRuntimeAdapter>("tool runtime adapter");

/**
 * Surface:  chat.
 * Owns/hides: guarded dispatch of one tool-call round. Hides the dispatch module.
 *   The interface lives in ./internal/adapter.
 * Why the seam: inverts tool-runtime -> dispatch.
 * Wiring: internal/dispatch/pipeline.ts installs; executeToolCallRound reads.
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

// Raw tool input, not the branded activation type. The workflow owner re-validates it.
type AuthorWorkflowToolInput = z.infer<typeof authorWorkflowInput>;

type ActivateWorkflowToolInput = z.infer<typeof activateWorkflowInput>;

/** Everything `spawnSubAgent` needs beyond the tool input the model supplies. */
export type SpawnSubAgentRequest = Omit<SpawnSubAgentInput, "allowedIntegrations"> & {
  /** The child's cap. Internal slugs (`system`, `mcp`) carry over from the parent. */
  allowedIntegrations: readonly IntegrationSlug[];
  parentRunId: string;
  userId: string;
  parentToolCallId: string;
  /** The parent's chat turn. The child streams its trail there. */
  chat?: ChatTurnAddress | undefined;
};

export interface JoinChildRunRequest {
  parentRunId: string;
  userId: string;
  childRunId: string;
}

declare const safeToParkWakeBrand: unique symbol;

/**
 * A signal wake that carries a persisted deadline, which the join reconciler reads. Only
 * execution mints it, so no adapter can park a run without that backstop. The contract field is
 * optional (zod infers `?: string | undefined`), so the intersection, not `Required`, makes it a
 * plain `string` here.
 */
export type SafeToParkWake = Extract<WakeCondition, { kind: "signal" }> & {
  deadlineAt: string;
} & {
  readonly [safeToParkWakeBrand]: true;
};

export type AwaitSubAgentDispatchResult =
  | {
      kind: "executed";
      stagingId: null;
      toolResult: unknown;
      effects: ToolEffects;
      editedByUser: false;
    }
  | {
      kind: "parked";
      wake: SafeToParkWake;
    };

/** Mirrors `ScratchOperation` in `execution/scratchpad/index.ts` (ADR-0089). */
export type SystemToolScratchOperation =
  | { verb: "read"; key: string }
  | { verb: "write"; key: string }
  | { verb: "promote"; fromKey: string; toKey: string };

/**
 * Mirrors `Scratchpad` in `execution/scratchpad/index.ts` (ADR-0089): one run's scratchpad bound
 * to one writer. It owns the zone rules; `refusal` is the text dispatch returns as `invalid_input`.
 */
export interface SystemToolScratchpad {
  refusal(operation: SystemToolScratchOperation): string | null;
  read(key: string): Promise<ScratchEntry<unknown> | null>;
  write(key: string, value: unknown): Promise<ScratchEntry<unknown>>;
  promote(fromKey: string, toKey: string): Promise<ScratchEntry<unknown> | null>;
}

/** Mirrors the `spawnSubAgent` result in `execution/sub-agents.ts` (ADR-0089). */
export interface SpawnSubAgentResult {
  readonly ok: true;
  readonly status: "spawned" | "already_spawned";
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly subId: string;
}

/** Mirrors `ChildRunOutcome` in `execution/sub-agents.ts` (ADR-0089). */
export interface ChildRunOutcomeResult {
  readonly ok: boolean;
  /** True once the child reached a terminal status. */
  readonly done: boolean;
  readonly status: string;
  readonly output?: unknown;
  readonly error?: unknown;
  /** Feeds the await wait ceiling. */
  readonly runningMs?: number | undefined;
  readonly reason?: string;
}

/**
 * Surface:  chat.
 * Owns/hides: sub-agent spawn and join, and run scratch. Hides the agent runtime.
 * Why the seam: inverts tool-runtime -> execution.
 * Wiring: execution/system-tool-adapter.ts installs; internal/tools/system.ts reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolAgentAdapter {
  spawnSubAgent(args: SpawnSubAgentRequest): Promise<SpawnSubAgentResult>;
  readChildRunOutcome(args: JoinChildRunRequest): Promise<ChildRunOutcomeResult>;
  resolveAwaitSubAgent(args: JoinChildRunRequest): Promise<AwaitSubAgentDispatchResult>;
  scratchpad(args: { runId: string; writer: ToolCallActor["caller"] }): SystemToolScratchpad;
}

const systemToolAgentAdapterPort = bootPort<SystemToolAgentAdapter>("system-tool agent adapter");

/** Runtime composition installs the agent-behavior handler at boot. */
export function registerSystemToolAgentAdapter(adapter: SystemToolAgentAdapter): () => void {
  return systemToolAgentAdapterPort.install(adapter);
}

/**
 * The step identity that a dispatch claim fences on: the lease fields of the run, read only from
 * the dispatch args. Execution's `StepLease` is the same three fields of a `StepContext`.
 */
export type DispatchStepLease = Pick<ToolCallRunBase, "runId" | "attempt" | "fence">;

/**
 * Surface:  chat.
 * Owns/hides: the executor's run-ownership check under the `agent_runs` row lock. Hides the executor.
 * Why the seam: inverts tool-runtime -> execution, so a dispatch claim uses the step commit's own
 *   predicate, not a copy of it.
 * Wiring: execution/dispatch-lease-adapter.ts installs; internal/dispatch/staging-store.ts reads.
 * See: ADR-0089, ADR-0034 amendment 2026-10-31, and docs/reference/tool-runtime-map.md.
 */
export interface DispatchLeaseAdapter {
  /**
   * Run `write` in one transaction after the run lock and the ownership check. `reclaim`: another
   * attempt owns the run. `terminal`: a cancel moved the fence, or the run is terminal.
   */
  withStepLease<T>(
    lease: DispatchStepLease,
    write: (tx: DbTransaction) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; cause: "reclaim" | "terminal" }>;
}

const dispatchLeaseAdapterPort = bootPort<DispatchLeaseAdapter>("dispatch lease adapter");

/** Runtime composition installs the executor's lease check at boot. */
export function registerDispatchLeaseAdapter(adapter: DispatchLeaseAdapter): () => void {
  return dispatchLeaseAdapterPort.install(adapter);
}

/** The executor's lease check. Throws when no adapter is installed, so a claim fails closed. */
export function dispatchLease(): DispatchLeaseAdapter {
  return dispatchLeaseAdapterPort.read();
}

/** A bounded excerpt. The truncation facts stop a cut excerpt from reading as complete. */
export interface ChatHistoryExcerpt {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

export interface ChatHistoryMessageEvidence {
  readonly kind: "message";
  readonly id: string;
  readonly role: string;
  readonly createdAt: string;
  readonly content: ChatHistoryExcerpt;
  readonly toolCallIds: readonly string[];
}

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

/** `system.read_chat_history` result. Errors return as `error`, never a throw. */
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
 * Owns/hides: the `system.read_chat_history` read. Hides chat retrieval.
 * Why the seam: inverts tool-runtime -> chat.
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

export function spawnSubAgent(args: SpawnSubAgentRequest): Promise<SpawnSubAgentResult> {
  return requireSystemToolAgentAdapter().spawnSubAgent(args);
}

export function readChildRunOutcome(args: {
  parentRunId: string;
  userId: string;
  childRunId: string;
}): Promise<ChildRunOutcomeResult> {
  return requireSystemToolAgentAdapter().readChildRunOutcome(args);
}

export function resolveAwaitSubAgent(
  args: JoinChildRunRequest,
): Promise<AwaitSubAgentDispatchResult> {
  return requireSystemToolAgentAdapter().resolveAwaitSubAgent(args);
}

/** The calling run's scratchpad, bound to the caller as its writer. */
export function scratchpad(args: {
  runId: string;
  writer: ToolCallActor["caller"];
}): SystemToolScratchpad {
  return requireSystemToolAgentAdapter().scratchpad(args);
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

/** Mirrors `UserContext` in `knowledge/user-context.ts` (ADR-0089). */
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

/** Mirrors the source shape in `knowledge/web-search.ts`. */
export interface WebSearchResultSource {
  readonly url: string;
  readonly title?: string | undefined;
}

/** Mirrors the hit shape in `knowledge/web-search.ts`. */
export interface WebSearchResultHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/** `WebSearchResult` from `knowledge/web-search.ts` plus the `ok`/`query` envelope. */
export interface WebSearchToolResult {
  readonly ok: true;
  readonly query: string;
  readonly answer: string;
  readonly citations: readonly WebSearchResultSource[];
  readonly results: readonly WebSearchResultHit[];
  readonly searchQueries: readonly string[];
}

/** One related instruction. Mirrors `RelatedStandingInstruction`. */
export interface RelatedInstructionResult {
  readonly instructionId: string;
  readonly factId: string;
  readonly directive: string;
  readonly relation: StandingInstructionOverlap["relation"] | "same" | "overlaps";
}

/** A `system.remember` refusal. Nothing was stored. Mirrors `StandingInstructionCaptureRefusal`. */
export type RememberInstructionRefusal =
  | {
      readonly ok: false;
      readonly status: "invalid_sender";
      readonly sender: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: "unknown_instruction" | "invalid_resolution";
      readonly instructionId: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: "stale_revision";
      readonly instructionId: string;
      readonly expectedRevision: number | null;
      readonly currentRevision: number;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: "invalid_exception";
      readonly exceptionOf: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly status: "conflict";
      readonly conflicts: readonly RelatedInstructionResult[];
      readonly conflictCount: number;
      readonly message: string;
    };

/**
 * The `system.remember` result: `SaveStandingInstructionResult` from
 * `knowledge/standing-instructions.ts`, plus the todo sweep over the named senders when the
 * instruction blocks todo suggestions. `null`: no sweep ran.
 */
export type RememberInstructionResult =
  | {
      readonly ok: true;
      readonly status: "remembered" | "revised" | "already_exists";
      readonly factId: string;
      readonly instruction: StandingInstructionValueV2;
      /** Active instructions that name the same, a wider, a narrower, or an overlapping sender. Capped. */
      readonly related: readonly RelatedInstructionResult[];
      readonly relatedCount: number;
      readonly resolvedTodos:
        | ResolveTodoBySourceResult
        | { readonly ok: false; readonly status: "sweep_failed"; readonly message: string }
        | null;
    }
  | RememberInstructionRefusal;

/** Mirrors `StandingInstructionSummary` in `knowledge/standing-instructions.ts`. */
export interface StandingInstructionSummaryResult {
  readonly factId: string;
  readonly schemaVersion: 1 | 2;
  readonly instruction: StandingInstructionValueV2;
  readonly validFrom: Date;
}

/** Mirrors `StandingInstructionListResult` in `knowledge/standing-instructions.ts`. */
export interface ListInstructionsResult {
  readonly instructions: readonly StandingInstructionSummaryResult[];
  readonly totalActive: number;
  readonly truncated: boolean;
  readonly limit: number;
}

/** Mirrors `ForgetStandingInstructionResult` in `knowledge/standing-instructions.ts`. */
export type ForgetInstructionResult =
  | {
      readonly ok: true;
      readonly status: "forgotten";
      readonly factId: string;
      readonly instruction: StandingInstructionValueV2;
    }
  | { readonly ok: false; readonly status: "not_found" };

/** Mirrors `EditStandingInstructionResult` in `knowledge/standing-instructions.ts`. */
export type EditInstructionResult =
  | {
      readonly ok: true;
      readonly status: "edited";
      readonly factId: string;
      readonly previousFactId: string;
      readonly instruction: StandingInstructionValue;
      /** Edits a domain row cannot take. Empty on an address row. */
      readonly droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | {
      readonly ok: true;
      readonly status: "unchanged";
      readonly factId: string;
      readonly instruction: StandingInstructionValue;
      readonly droppedInputs: readonly StandingInstructionDroppedInput[];
    }
  | { readonly ok: false; readonly status: "not_found" }
  | {
      readonly ok: false;
      readonly status: "revise_with_remember";
      readonly instructionId: string;
      readonly message: string;
    };

/**
 * Surface: chat.
 * Owns/hides: the `system.read_user_context` read. Hides knowledge retrieval.
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
 * Owns/hides: remember, list, forget, and edit of standing instructions.
 *   Hides the instruction store.
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolInstructionAdapter {
  rememberInstructionAndDismissTodos(
    args: SystemToolRequest<"system.remember">,
  ): Promise<RememberInstructionResult>;
  /** The refusal capture would return for this input now, before the card. Writes nothing. */
  checkInstruction(
    args: SystemToolRequest<"system.remember">,
  ): Promise<RememberInstructionRefusal | null>;
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
 * Owns/hides: `system.web_search`. Hides the search provider.
 * Why the seam: tool-runtime must not import knowledge or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolWebSearchAdapter {
  webSearch(args: SystemToolRequest<"system.web_search">): Promise<WebSearchToolResult>;
}

/** Mirrors `ResolveTodosByIdsResult` in `tasks/resolve.ts` (ADR-0089). */
export interface ResolveTodoByIdsResult {
  readonly ok: true;
  readonly status: "dismissed" | "not_live" | "not_found";
  readonly dismissedCount: number;
  readonly todoIds: readonly string[];
  readonly skipped: readonly (
    | { readonly todoId: string; readonly reason: "not_found" }
    | { readonly todoId: string; readonly reason: "not_live"; readonly status: TodoStatus }
  )[];
  readonly auditReason: string | null;
}

/** Mirrors `ListTodosResult` in `tasks/list.ts` (ADR-0089). */
export interface ListTodosResult {
  readonly todos: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: TodoStatus;
    readonly dueDate: string | null;
    readonly sources: readonly TodoSource[];
    readonly sourceCount: number;
    readonly creatorActor: AttributionActor | null;
  }[];
  readonly status: SystemToolRequest<"system.list_todos">["input"]["status"];
  readonly limit: number;
  readonly truncated: boolean;
}

/** `kind: "gmail_sender"` mirrors `ResolveTodosForGmailSourceResult` in `tasks/resolve.ts` (ADR-0089). */
export type ResolveTodoResult = ResolveTodoBySourceResult | ResolveTodoByIdsResult;

export type ResolveTodoBySourceResult =
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
 * The first three arms mirror `SuggestTodoResult` in `tasks/suggest.ts`. The
 * fourth is the tool path's already-replied guard.
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
 * Owns/hides: the todo list read, todo suggestion, and todo resolution by Gmail source or id.
 * Why the seam: tool-runtime must not import tasks or create a module cycle.
 * Wiring: runtime/adapters/system-tool-product.ts installs; internal/tools/system.ts reads.
 */
export interface SystemToolTaskAdapter {
  listTodos(args: SystemToolRequest<"system.list_todos">): Promise<ListTodosResult>;
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

export function rememberInstructionAndDismissTodos(
  args: SystemToolRequest<"system.remember">,
): Promise<RememberInstructionResult> {
  return systemToolInstructionAdapterPort.read().rememberInstructionAndDismissTodos(args);
}

export function checkInstruction(
  args: SystemToolRequest<"system.remember">,
): Promise<RememberInstructionRefusal | null> {
  return systemToolInstructionAdapterPort.read().checkInstruction(args);
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

export function listTodos(args: SystemToolRequest<"system.list_todos">): Promise<ListTodosResult> {
  return systemToolTaskAdapterPort.read().listTodos(args);
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

/** `system.search_context` result. The truncation facts let the model disclose a partial read. */
export interface ContextSearchToolResult {
  /** True whenever the read ran. Per-source failures are notes in `text`. */
  readonly ok: boolean;
  readonly text: string;
  readonly includedCount: number;
  /** Cards dropped by the budget or by the read's own `limit`. */
  readonly omittedCount: number;
  readonly truncated: boolean;
}

/**
 * Surface:  chat.
 * Owns/hides: the `system.search_context` read. Hides the `context-search` module.
 * Why the seam: `@alfred/assistant/context-search` pulls the database and corpus
 *   graphs, which must stay out of this eager barrel.
 * Wiring: runtime/adapters/system-tool-context-search.ts installs;
 *   internal/tools/context-search.ts reads.
 * See: ADR-0101, ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface SystemToolContextSearchAdapter {
  /** Not `searchContext`: that name is the read verb itself (ADR-0101). */
  runContextSearch(
    args: SystemToolRequest<"system.search_context">,
  ): Promise<ContextSearchToolResult>;
}

const systemToolContextSearchAdapterPort = bootPort<SystemToolContextSearchAdapter>(
  "system-tool context-search adapter",
);

export function registerSystemToolContextSearchAdapter(
  adapter: SystemToolContextSearchAdapter,
): () => void {
  return systemToolContextSearchAdapterPort.install(adapter);
}

export function runContextSearch(
  args: SystemToolRequest<"system.search_context">,
): Promise<ContextSearchToolResult> {
  return systemToolContextSearchAdapterPort.read().runContextSearch(args);
}

export function readChatHistory(args: {
  userId: string;
  threadId: string;
  input: ReadChatHistoryInput;
}): Promise<ChatHistoryToolResult> {
  return requireSystemToolChatHistoryAdapter().readChatHistory(args);
}

/** A persisted readiness problem, narrowed to the codes `automation/readiness.ts` assigns. */
export type WorkflowReadinessBlocker = PersistedWorkflowReadinessProblem & {
  readonly code:
    | ToolUnavailabilityCode
    | "no_tool_surface"
    | "choose_account"
    | "resource_not_granted"
    | "trigger_not_ready"
    | "trigger_degraded";
};

/** Mirrors `WorkflowRevisionProblem` in `automation/revisions.ts` (ADR-0089). */
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
  /** One sentence safe to show the user. */
  readonly message: string;
  /** Dotted path into the definition. */
  readonly field?: string;
}

/** Mirrors `WorkflowServiceFailure` in `automation/revisions.ts`. */
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

export interface BlockedWorkflowDraftResult {
  readonly ok: true;
  readonly status: "blocked";
  readonly workflowId: string;
  readonly revisionId: string;
  readonly readinessBlockers: readonly WorkflowReadinessBlocker[];
  readonly recovery?: WorkflowRecoveryNavigation;
}

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
 * Owns/hides: author, recover, and activate a workflow. Hides revision and
 *   readiness policy.
 * Why the seam: inverts tool-runtime -> workflows.
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

export function registerSystemToolWorkflowAdapter(adapter: SystemToolWorkflowAdapter): () => void {
  return systemToolWorkflowAdapterPort.install(adapter);
}

export function authorWorkflow(args: {
  userId: string;
  runId: string;
  timezone: IanaTimezone;
  input: AuthorWorkflowToolInput;
}): Promise<AuthorWorkflowResult> {
  return requireSystemToolWorkflowAdapter().authorWorkflow(args);
}

/** Revalidate a blocked workflow draft after setup. */
export function recoverWorkflow(args: {
  userId: string;
  workflowId: string;
  revisionId: string;
}): Promise<RecoverWorkflowResult> {
  return requireSystemToolWorkflowAdapter().recoverWorkflow(args);
}

/** Publish an approved workflow revision. */
export function activateWorkflow(args: {
  userId: string;
  input: ActivateWorkflowToolInput;
  createdByRunId: string;
}): Promise<ActivateWorkflowResult> {
  return requireSystemToolWorkflowAdapter().activateWorkflow(args);
}

/** Restore a persisted surface against today's tool catalog. */
export function restoreToolSurface(source: ToolSurfaceSource): ToolName[] {
  return requireToolRuntimeAdapter().restore(source);
}

/** Project names that already passed the load-time gates. Throws before boot. */
export function resolveToolSurface(input: {
  activeNames: readonly ToolName[];
  context: ToolRunContext;
}): ResolvedToolSurface {
  return requireToolRuntimeAdapter().resolve(input);
}

export function toolNamesForIntegrations(integrations: readonly string[]): ToolName[] {
  return requireToolRuntimeAdapter().namesForIntegrations(integrations);
}

/** Executable tool names for a run, grouped by integration slug and sorted. */
export function availableToolNamesByIntegration(input: {
  availability: IntegrationAvailabilitySnapshot;
  allowedIntegrations: readonly IntegrationSlug[];
  context: ToolRunContext;
}): Map<string, ToolName[]> {
  return requireToolRuntimeAdapter().availableToolNamesByIntegration(input);
}

export function selectToolPreload(input: {
  userId: string;
  transcript: readonly TranscriptMessage[];
  allowedIntegrations: readonly IntegrationSlug[];
  activeNames: readonly ToolName[];
  context: ToolRunContext;
  availability: IntegrationAvailabilitySnapshot;
}): Promise<SelectedToolPreload> {
  return requireToolRuntimeAdapter().selectPreload(input);
}

/** Run one tool round, or return its durable wait. */
export function executeToolCallRound<Call extends ProposedToolCall>(input: {
  calls: readonly Call[];
  transcript: readonly TranscriptMessage[];
  run: ToolCallRun;
  activeNames: readonly ToolName[];
  onCallStarted?:
    | ((call: Call, activeNames: readonly ToolName[]) => void | Promise<void>)
    | undefined;
}): Promise<ToolCallRoundOutcome<Call>> {
  return runToolCallRound(input, requireToolCallRoundAdapter(), restoreToolSurface);
}

/** The shared-state lane whose calls run in model order, or `null` for none. */
export function toolExecutionLane(
  toolName: string,
): ReturnType<ToolCallRoundAdapter["executionLane"]> {
  return requireToolCallRoundAdapter().executionLane(toolName);
}

/** How a tool's streamed artifact input lands, or `null` when it does not stream. */
export function artifactStreamMode(
  toolName: string,
): ReturnType<ToolCallRoundAdapter["artifactStreamMode"]> {
  return requireToolCallRoundAdapter().artifactStreamMode(toolName);
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
