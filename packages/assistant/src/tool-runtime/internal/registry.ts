/**
 * The map of every tool the boss or a sub-agent can call, filled at boot.
 * `riskTier` is a UX hint, except `high`: a high-tier tool always confirms (ADR-0069).
 * The approval gate is `user_action_policies` (ADR-0034).
 */

import type {
  ActionSlug,
  HostCallOutcome,
  HostReadRefusal,
  IanaTimezone,
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  JsonValue,
  PassthroughResult,
  ResultTruncation,
  ReadEvidence,
  RiskTierCounts,
  ToolName,
  ToolRunContext,
  ToolAvailabilityResult,
  ToolReadClass,
  ToolRiskTier,
} from "@alfred/contracts";
import {
  ASK_USER_TOOL,
  buildToolName,
  CODE_RUN_TOOL,
  builtInMCPProvidersAdmittedBy,
  INTEGRATION_ACTIONS,
  INTEGRATION_DISPLAY_NAMES,
  integrationFromToolName,
  isLoadableIntegrationSlug,
  isSupportedPassthroughSlug,
  isToolRiskTier,
  joinToolInput,
  readEvidenceSchema,
  scriptSourcesSchema,
  toolNameSchema,
} from "@alfred/contracts";
import type { RedactedToolInput } from "@alfred/ai";
// Type-only: the values pull `@alfred/db` into every tool declaration. `../context` binds them.
import type { Integrations } from "@alfred/integrations";
import type { Corpus } from "@alfred/corpus";
import { logger } from "@alfred/logging";
import { z } from "zod";
import {
  QUESTION_TOOL_MODEL_PROBE_INPUT,
  QUESTION_TOOL_PROBE_INPUT,
  questionToolInput,
} from "../question-contract";
import { deriveToolDiscovery, type ResolvedDiscovery } from "./metadata-defaults";
import { passthroughEvidence, passthroughSpanFacts } from "./tools/passthrough/telemetry";
import {
  declaredStructuredRead,
  decideReadRoute,
  NOT_A_CONFIRMED_READ,
  readRouteReasonText,
  type ReadFacts,
  type ReadRoute,
} from "../read-route";

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
  callers?: readonly ("boss" | "sub_agent")[];
  requiresLiveChat?: boolean;
  /**
   * A read-only passthrough tool (ADR-0074), gated by the default-off
   * `feature.passthrough.<slug>` preference. Dispatch re-checks it so a stale surface cannot bypass it.
   */
  passthrough?: true;
  /**
   * Available only in a `code_run` run (`ToolRunContext.readPath`). Only `system.code_run`
   * declares it. The user's ADR-0124 flag (`codeModeReadPath`) decides the read path when a chat
   * run starts, and the pin rules the run (owner, 2026-11-17). So this gate reads the run context,
   * never the live flag: a flag turned off mid-run cannot strand a pinned run.
   */
  codeModeReadPath?: true;
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
 * - `"confirm"` (ADR-0113): a staged write whose card always shows, also under chat full
 *   autonomy. The user's click is the authority for what the write stores.
 */
export type ToolStagingPolicy = "staged" | "fast_path" | "join" | "question" | "confirm";

/**
 * Whether dispatch may run a call again after a crash left it started and unfinished.
 * - `"safe"`: a second run makes no second effect (a read, a set, or a provider-side key).
 * - `"unsafe"`: a second run can repeat the effect. Dispatch claims the call before `execute`,
 *   and a reclaim that finds the claim with no result asks the user before it runs it again.
 * Not `riskTier` and not `staging`: neither of them tracks whether a repeat is harmless.
 */
export type ToolReplay = "safe" | "unsafe";

/** One live chat turn: its thread, and the assistant message the turn streams into (ADR-0073). */
export const chatTurnAddressSchema = z
  .object({ threadId: z.string().min(1), messageId: z.string().min(1) })
  .strict();

export type ChatTurnAddress = z.infer<typeof chatTurnAddressSchema>;

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
  /**
   * Set only on the staged path. A `"safe"` tool whose provider has no idempotency key keeps the
   * handle of the object it made here, so a rerun of the same call finds that object.
   */
  providerRef?: ProviderRefSlot;
  userId: string;
  /**
   * Provider clients bound to this call's user, so a tool never handles a token.
   * Lazy: each client resolves its credential per request.
   */
  integrations: Integrations;
  /** Corpus reads bound to this call's user. Hits are model-facing. */
  corpus: Corpus;
  /** The user's zone, so "today" means the user's day, not the server's UTC day. */
  timezone: IanaTimezone;
  caller: "boss" | { subId: string };
  runContext: ToolRunContext;
  /** The run's tool surface when dispatch ran this call. */
  activeTools: readonly ToolName[];
  /** Set only for live-chat dispatch. A `requiresLiveChat` tool always receives it. */
  chat?: ChatTurnAddress | undefined;
  /**
   * The thread whose Full Autonomy waives a card for this run: the chat thread, or the parent
   * thread of a sub-agent. Dispatch reads the flag from it, so a route quote reads the same one.
   */
  approvalThreadId?: string | undefined;
  /** Empty or undefined means unrestricted. */
  allowedIntegrations?: readonly IntegrationSlug[] | undefined;
  /**
   * Set only by dispatch. Runs one read for a `system.code_run` script as a nested dispatch of
   * this call (ADR-0124). Every other tool ignores it.
   */
  hostRead?: HostReadDispatcher | undefined;
  /** Set only by dispatch, beside `hostRead`: the record of this call's host reads. */
  hostCalls?: HostCallLedger | undefined;
  // TODO(#286): no abort signal yet, so a network tool outlives a stopped turn until its own timeout.
}

/** One read that a `system.code_run` script asks for (ADR-0124). */
export interface HostReadRequest {
  toolName: ToolName;
  input: unknown;
  /**
   * `run`'s one-based request order. The ledger and the span read it. The nested call's id does
   * not: a restart can give the same position to a different request (see `dispatchHostRead`).
   */
  requestIndex: number;
}

/**
 * The nested call behind a host read, for the evidence record. `input` is the parsed input with
 * the tool's secret redaction, or null when the input did not parse.
 */
export interface HostReadCall {
  callId: string;
  toolName: ToolName;
  input: JsonValue | null;
  /** The nested staging row, when the call wrote one. */
  stagingId: string | null;
}

/**
 * `call` is absent only when the request did not reach dispatch (bad guest arguments).
 * `evidence` is the reader's own statement, live or replayed from its staging row.
 */
export type HostReadOutcome =
  | {
      kind: "executed";
      value: JsonValue;
      /** The UTF-8 bytes of `value`'s JSON, measured one time for the delivery cap and the record. */
      bytes: number;
      call: HostReadCall;
      evidence: ReadEvidence | undefined;
    }
  | {
      kind: "refused";
      refusal: HostReadRefusal;
      message: string;
      call: HostReadCall | undefined;
    };

export type HostReadDispatcher = (request: HostReadRequest) => Promise<HostReadOutcome>;

/**
 * One host call of a `system.code_run` script, as the record keeps it (ADR-0124 amendment
 * 2026-11-18). `unfinished`: the read had not settled when the script ended. `tool_error`: it
 * executed and returned `ok: false`.
 */
export interface HostCallEntry {
  index: number;
  path: string;
  kind: HostCallOutcome;
  ms: number;
  /** The nested call. Absent when the request did not reach dispatch, or dispatch threw. */
  call: HostReadCall | undefined;
  /** The refusal text that the guest got, or the host's note for a read that threw. */
  message: string | undefined;
  /** The reader's references and coverage. Absent when the read did not deliver a value. */
  evidence: ReadEvidence | undefined;
  /** `sha256Canonical` of the value that the guest got. Null when the read did not deliver. */
  contentHash: string | null;
  /**
   * The JSON bytes of the result that the nested staging row saved (ADR-0124 amendment 2026-11-18
   * (b): the storage bound is measured). Null when the read saved no result: a `fast_path` read,
   * or a refusal.
   */
  savedBytes: number | null;
}

/** How a host call settled. The ledger adds the index, the path, and the duration. */
export type HostCallSettlement = Omit<HostCallEntry, "index" | "path" | "ms">;

/**
 * The host calls of one `system.code_run` call. Dispatch makes it and commits its rows with the
 * parent result, so only the execution whose result wins keeps its record. The sandbox host adds
 * an entry when the guest asks for a read and settles it when the read ends.
 */
export interface HostCallLedger {
  /** Add an `unfinished` entry. The returned function settles it one time. */
  begin(index: number, path: string): (settlement: HostCallSettlement) => void;
  /** Stop the ledger and return its entries in request order. A later settlement is ignored. */
  freeze(): readonly HostCallEntry[];
}

/** The call's `action_stagings.provider_ref`. It outlives a crash, so a rerun reads it. */
export interface ProviderRefSlot {
  /** The handle that an earlier attempt of this call kept, or null. */
  read(): Promise<string | null>;
  /** Keep `ref` when no attempt kept a handle first. Returns the kept handle. */
  record(ref: string): Promise<string>;
}

/** The context minus the binds that `toolExecuteContext` in `../context` derives. */
export type ToolExecuteContextFields = Omit<ToolExecuteContext, "integrations" | "corpus">;

/** The context that a `requiresLiveChat: true` tool's `execute` receives. */
export type LiveChatToolExecuteContext = ToolExecuteContext & { chat: ChatTurnAddress };

/**
 * The typed side data a call hands back beside its model-facing output. Dispatch persists it with
 * the result in one write, so a replay returns what the live call did. Nothing reads an effect
 * from the output.
 */
export const toolEffectsSchema = z.object({
  /** A tool the round folds into the next turn's surface. */
  activation: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("load"), name: toolNameSchema }),
      // Ranked, available, non-`mcp.call` hits. The round applies `run.allowedTools`.
      z.object({ kind: z.literal("search_fold"), names: z.array(toolNameSchema) }),
    ])
    .optional(),
  /** The artifact an `artifact_mutation` call wrote. */
  artifactId: z.string().min(1).optional(),
  /**
   * What a read delivered, as the reader states it: its evidence references and its coverage
   * (ADR-0124 amendment 2026-11-18). A Code Mode script's evidence record reads it, and a replay
   * keeps the references of the saved result.
   */
  evidence: readEvidenceSchema.optional(),
  /** The web pages of a `system.code_run` script, for the chat sources strip. */
  scriptSources: scriptSourcesSchema.optional(),
});

export type ToolEffects = Readonly<z.infer<typeof toolEffectsSchema>>;

export const NO_TOOL_EFFECTS: ToolEffects = Object.freeze({});

/** Live-only facts for the call's span. Never persisted, never replayed. */
export interface ToolSpanFacts {
  passthroughTruncation?: { truncation: ResultTruncation; succeeded: boolean };
  /** Primitive, PII-free metadata for the span. `system.code_run` sets it (ADR-0124 rows). */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** What a bound call returns. `output` is free-form; dispatch sanitizes it into a `JsonValue`. */
export interface ToolExecution {
  output: unknown;
  effects: ToolEffects;
  spanFacts: ToolSpanFacts;
}

type ExecuteContextFor<L extends boolean> = [L] extends [true]
  ? LiveChatToolExecuteContext
  : ToolExecuteContext;

/**
 * The shared tool declaration: every field whose meaning and type are the same
 * for a passthrough tool and any other tool. The two `liveTool` arms extend it
 * and declare only `availability`, `execute`, and `effects` themselves. It takes
 * no `L`: no shared field uses the live-chat literal.
 */
export interface ToolArgsCommon<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
> {
  integration: I;
  action: A;
  /** `high` always confirms (ADR-0069). Lower tiers are UX hints. */
  riskTier: ToolRiskTier;
  /**
   * The effective tier from validated input (ADR-0088). Must be side-effect free.
   * `BoundToolCall.effectiveRiskTier` clamps a downgrade unless `riskTierDowngradeReason` is set.
   */
  resolveRiskTier?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<ToolRiskTier>;
  /** Permits a downgrade below `riskTier`. Requires `resolveRiskTier`. */
  riskTierDowngradeReason?: string;
  /**
   * The integration whose policy rule governs this call, when the input names it and the tool
   * name does not: `mcp.call` on a built-in server follows its provider's rule. Absent: the
   * rule of the tool's own integration. Must be side-effect free.
   */
  resolvePolicyIntegration?: (
    input: z.infer<S>,
    ctx: ToolExecuteContext,
  ) => Promise<IntegrationSlug>;
  /** Defaults to `"staged"`. */
  staging?: ToolStagingPolicy;
  /** No default: every tool states it. `fast_path`, `join`, and `question` must be `"safe"`. */
  replay: ToolReplay;
  /**
   * A host function of `system.code_run` (ADR-0124). Alfred's declaration that the tool only
   * reads and that its output is structured data, the two route facts of the amendment of
   * 2026-11-18. `riskTier: "no_risk"` does not say this, because some `no_risk` tools write.
   * The value is the read class (ADR-0130 decision 1): `secret` when some valid input can return
   * a value that gives access, else `ordinary`. Under `gated`, an `ordinary` read has no card.
   * `registerTool` checks the arms.
   */
  codeModeRead?: ToolReadClass;
  /**
   * The result of a read holds text from outside Alfred and the model: a connected service, the
   * web, or the user's synced data. Only such a stored result is a source of a URL for
   * `system.fetch_url` (ADR-0130 decision 3). Leave it out for a read of what Alfred or the
   * model wrote: chat history, scratch, memory, todos, and a script's own return value.
   * Requires a read: `codeModeRead`, or `resolveReadFacts` for a call that reads by its input.
   */
  outsideText?: true;
  /** Calls in the same live-chat lane execute in model order. */
  executionLane?: "artifact_mutation";
  /**
   * How the streamed `markdown` input of an `artifact_mutation` tool lands while the model
   * writes it: `replace` is the whole body, `append` a new section. Absent: no live stream.
   */
  artifactStream?: "replace" | "append";
  /**
   * Required for `fast_path` on a non-`system` tool, illegal otherwise.
   * Only `system` resolves to autonomy; every other integration defaults to `gated`,
   * so a fast path there skips a real approval at every risk tier.
   */
  policyGateWaiver?: string;
  description: string;
  discovery?: ToolDiscoveryMetadata;
  inputSchema: S;
  /**
   * The narrower schema the model sees, for a field only the runtime writes
   * (`answers` on `system.ask_user`, ADR-0099). Must be a subset of `inputSchema`.
   */
  modelInputSchema?: z.ZodType;
  /**
   * A refusal that depends on who calls, which the schema cannot express. Dispatch runs it on
   * parsed input before any staging or execute, and returns a non-null text as `invalid_input`.
   * Must be side-effect free and must not throw. The rule's owner supplies the text.
   */
  refuseInput?: (input: z.infer<S>, ctx: ToolExecuteContext) => string | null;
  /**
   * A refusal that depends on stored state, for a gated tool. Dispatch runs it only for a fresh
   * proposal, before the call has a staging row, and returns a non-null text as `invalid_input`.
   * A replay or a resume of the same call skips it: the state it read can change after the
   * write, and the saved result must still replay. Must be side-effect free.
   */
  refuseProposal?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<string | null>;
  /**
   * For a tool that reads or writes by its input (`mcp.call`): the read authority and the
   * declared output of this call, from durable state (ADR-0124 amendment 2026-11-18). The route
   * decision reads them. A `codeModeRead` tool must not declare this hook, because its flag
   * already declares both facts. Must be side-effect free.
   */
  resolveReadFacts?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<ReadFacts>;
  /**
   * The fields that only the server writes, bound when the call is proposed (`mcp.call` binds its
   * catalog revision, ADR-0088 amendment 2026-11-18). Dispatch runs it on the caller's input after
   * the parse and before every decision, so the refusals, the tier, the read facts, the hashes,
   * and the staging row all read the one bound input. A saved staging input already holds the
   * fields, so a resume does not run it. The result must parse against `inputSchema`. A
   * `modelInputSchema` must leave the fields out, so the model never writes them.
   */
  bindServerFields?: (input: z.infer<S>, ctx: ToolExecuteContext) => Promise<z.infer<S>>;
  /**
   * Scrub secrets before the input reaches a trace or a staging row (#293).
   * Must be pure and keep the shape. The hash and `execute` see the raw input.
   */
  redactInput?: (input: z.infer<S>) => z.infer<S>;
}

/**
 * `L` is the literal `requiresLiveChat` flag, so a live-chat tool's `execute` gets `ctx.chat`.
 * `O` is the output `execute` returns, so `effects` reads it typed. Declare it
 * after `execute`: TypeScript infers `O` from the first of them.
 *
 * A passthrough tool cannot use this interface: `passthrough` is `never` here, so
 * `availability: { passthrough: true }` is a compile error. Declare it with
 * {@link PassthroughToolArgs} instead, whose `execute` must return the
 * `runRestPassthrough` envelope and whose span facts `bind()` derives.
 */
export interface LiveToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  L extends boolean = false,
  O = unknown,
> extends ToolArgsCommon<I, A, S> {
  availability?: ToolAvailabilityMetadata & { requiresLiveChat?: L; passthrough?: never };
  /** Receives parsed input. A throw is recorded by the dispatcher. */
  execute: (input: z.infer<S>, ctx: ExecuteContextFor<L>) => Promise<O>;
  /**
   * The side data a consumer acts on (see {@link ToolEffects}). Pure. Runs once on the live
   * output; a replay reads the persisted copy.
   */
  effects?: (output: O) => ToolEffects;
  /** Live-only span metadata from the typed output. Pure. Never persisted or replayed. */
  spanFacts?: (output: O) => ToolSpanFacts;
  /**
   * What one read delivered: a reference and a hash for each item, and the coverage (ADR-0124
   * amendment 2026-11-18). A `codeModeRead` tool and `mcp.call` must declare it, and `liveTool`
   * throws without it. A reader with no item returns `itemEvidence([])`. Pure. Build it with
   * `itemEvidence`. `"returned_by_execute"`: `execute` returns `readResult(output, evidence)`,
   * because the ids are not in the model-facing output.
   */
  readEvidence?: ((output: O, input: z.infer<S>) => ReadEvidence) | "returned_by_execute";
}

/**
 * A reader's output and its evidence, for a reader whose ids are not in the model-facing output.
 * `bind()` gives `output` to the model and `evidence` to the record.
 */
export class ReadResult<O = unknown> {
  constructor(
    readonly output: O,
    readonly evidence: ReadEvidence,
  ) {}
}

export function readResult<O>(output: O, evidence: ReadEvidence): ReadResult<O> {
  return new ReadResult(output, evidence);
}

/**
 * The args for a read-only passthrough tool (ADR-0074). Extends
 * {@link ToolArgsCommon} with the three fields that differ:
 * `availability.passthrough` is `true`, so `execute` must return the
 * `runRestPassthrough` envelope and `bind()` derives the truncation span facts
 * from it. There is no per-tool hook to forget. A shared base by `extends`
 * keeps the `liveTool` overload check relating `L`; an `Omit` of the args
 * would break it (TS2394).
 */
export interface PassthroughToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  L extends boolean = false,
> extends ToolArgsCommon<I, A, S> {
  availability: ToolAvailabilityMetadata & { requiresLiveChat?: L; passthrough: true };
  /** Receives parsed input. A throw is recorded by the dispatcher. */
  execute: (input: z.infer<S>, ctx: ExecuteContextFor<L>) => Promise<PassthroughResult>;
  /**
   * The side data a consumer acts on (see {@link ToolEffects}). Pure. Runs once on the live
   * output; a replay reads the persisted copy.
   */
  effects?: (output: PassthroughResult) => ToolEffects;
}

/**
 * One call of one tool, after its input parsed. It holds the typed input, so each hook runs on
 * the one parse that {@link RegisteredTool.bind} did. The registry is heterogeneous, so the
 * input type is erased only at this interface, never inside a hook.
 */
export interface BoundToolCall {
  tool: RegisteredTool;
  /** The parsed input. The hashes, the scope check, and the staging row read it. */
  input: unknown;
  /** See {@link LiveToolArgs.refuseInput}. `null` when the tool declares no refusal. */
  refusal: (ctx: ToolExecuteContext) => string | null;
  /**
   * See {@link ToolArgsCommon.bindServerFields}: this call with its server fields bound, parsed
   * again. `null` when the tool declares no bind.
   */
  bindServerFields: ((ctx: ToolExecuteContext) => Promise<ToolInputBinding>) | null;
  /**
   * The effect and output facts of the route decision (ADR-0124 amendment 2026-11-18): a
   * `codeModeRead` tool's declaration, else {@link LiveToolArgs.resolveReadFacts}, else no
   * confirmed read.
   */
  readFacts: (ctx: ToolExecuteContext) => Promise<ReadFacts>;
  /** See {@link LiveToolArgs.refuseProposal}. `null` when the tool declares none. */
  proposalRefusal: ((ctx: ToolExecuteContext) => Promise<string | null>) | null;
  /**
   * Resolves the tier for this call (ADR-0088). The static tier when the tool has no
   * `resolveRiskTier`. A resolver result that is not a tier fails closed to the static tier.
   * A downgrade below it is clamped unless the tool declares `riskTierDowngradeReason`. Each
   * read runs `resolveRiskTier` again, and a resolver can read remote state, so read it one
   * time for each decision.
   */
  effectiveRiskTier: (ctx: ToolExecuteContext) => Promise<ToolRiskTier>;
  /** See {@link ToolArgsCommon.resolvePolicyIntegration}. The tool's integration when it declares none. */
  policyIntegration: (ctx: ToolExecuteContext) => Promise<IntegrationSlug>;
  /**
   * See {@link LiveToolArgs.redactInput}. The input itself when the tool declares no redactor.
   * The only value the trace sinks (`ToolSpanInput`, `DispatchRejectionInput`) take.
   */
  redactedInput: () => RedactedToolInput;
  /** See {@link LiveToolArgs.execute}. A throw is recorded by the dispatcher. */
  execute: (ctx: ToolExecuteContext) => Promise<ToolExecution>;
}

/** The result of {@link RegisteredTool.bind}: a bound call, or the reason the input did not parse. */
export type ToolInputBinding =
  | { success: true; call: BoundToolCall }
  | { success: false; error: z.ZodError };

export interface RegisteredTool {
  name: ToolName;
  integration: IntegrationSlug;
  action: string;
  riskTier: ToolRiskTier;
  /** Whether the tool declares {@link LiveToolArgs.resolveRiskTier}, so its tier depends on input. */
  resolvesRiskTier: boolean;
  /** See {@link LiveToolArgs.riskTierDowngradeReason}. */
  riskTierDowngradeReason?: string | undefined;
  /** Whether the tool declares {@link ToolArgsCommon.resolvePolicyIntegration}, so its policy rule depends on input. */
  resolvesPolicyIntegration: boolean;
  /** See {@link ToolStagingPolicy}. Resolved from the optional declaration. */
  staging: ToolStagingPolicy;
  /** See {@link ToolReplay}. */
  replay: ToolReplay;
  /** See {@link ToolArgsCommon.codeModeRead}. */
  codeModeRead: boolean;
  /** The class of a `codeModeRead` tool, else `undefined`. See {@link ToolArgsCommon.codeModeRead}. */
  readClass: ToolReadClass | undefined;
  /** See {@link ToolArgsCommon.outsideText}. */
  outsideText: boolean;
  /** Shared-state lane that tool-runtime serializes during a live chat round. */
  executionLane?: "artifact_mutation" | undefined;
  /** See {@link LiveToolArgs.artifactStream}. */
  artifactStream?: "replace" | "append" | undefined;
  /** See {@link LiveToolArgs.policyGateWaiver}. */
  policyGateWaiver?: string | undefined;
  description: string;
  discovery: ResolvedDiscovery;
  availability?: ToolAvailabilityMetadata | undefined;
  inputSchema: z.ZodType;
  /** Falls back to `inputSchema`, so it is always set. */
  modelInputSchema: z.ZodType;
  /** Parse raw input through `inputSchema` one time. Every per-call hook is on the result. */
  bind: (input: unknown) => ToolInputBinding;
}

/**
 * Whether an allowlist admits the tool. `mcp` names the transport, so `mcp` on a list admits
 * nothing. Workflow authoring still writes it for an `mcp.call` step, so such a workflow fails
 * activation (ADR-0125 item 6, an accepted gap). The `mcp.*` tools pass when a listed integration has a built-in MCP server, and the
 * tools then reach only the servers of those integrations (`mcpServerIdsAdmittedBy`).
 */
function allowlistAdmits(tool: RegisteredTool, allowed: ReadonlySet<IntegrationSlug>): boolean {
  if (tool.integration === "mcp") return builtInMCPProvidersAdmittedBy([...allowed]).length > 0;

  return allowed.has(tool.integration);
}

function evaluateRunContextGates(
  tool: RegisteredTool,
  allowed: ReadonlySet<IntegrationSlug>,
  context: ToolRunContext,
): ToolAvailabilityResult {
  if (tool.integration !== "system" && allowed.size > 0 && !allowlistAdmits(tool, allowed)) {
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

  return evaluateReadPath(tool, context);
}

/**
 * ADR-0124 decision 1: a run has one read path. In a `code_run` run, `decideReadRoute` sends each
 * call to a script or keeps it direct. In every other run, `system.code_run` is absent. The
 * nested dispatch of a script read runs as `code_run_host`, so the read passes.
 *
 * This gate is the static half of the decision: it hides a declared read that no call can meet
 * with a card, because its route is always the script. Dispatch decides each other call with its
 * live approval (`refuseMisroutedRead` in the pipeline).
 */
function evaluateReadPath(tool: RegisteredTool, context: ToolRunContext): ToolAvailabilityResult {
  const route = staticReadRoute(tool);

  if (route?.route === "script" && context.readPath === "code_run") {
    return {
      available: false,
      code: "wrong_caller",
      reason: `In this chat, ${tool.name} runs only inside system.code_run. ${readRouteReasonText(route)} Call it there as ${tool.name}(input).`,
    };
  }

  // `not_allowed`, so search never offers it: this run reads through its direct tools.
  if (tool.availability?.codeModeReadPath && context.readPath !== "code_run") {
    return {
      available: false,
      code: "not_allowed",
      reason: "Only a chat that reads through scripts can use this tool.",
    };
  }

  return { available: true };
}

/**
 * The route of every call of `tool`, when no input and no live policy can change it: a declared
 * read that never meets a card. `null` when dispatch must decide each call.
 */
function staticReadRoute(tool: RegisteredTool): ReadRoute | null {
  if (tool.readClass === undefined || toolCanWaitForApproval(tool)) return null;

  return decideReadRoute(declaredStructuredRead(tool.readClass), false);
}

/**
 * Whether any call of `tool` can meet an approval card. `fast_path` and `join` return before the
 * gate. The `high` tier, a dynamic tier, and a dynamic rule can always gate. Otherwise a `system`
 * tool resolves to autonomy, and an `ordinary` declared read runs with no card under `gated` too
 * (ADR-0130 decision 1). Every other tool has a policy rule that the user can set to Gated.
 */
export function toolCanWaitForApproval(tool: RegisteredTool): boolean {
  if (tool.staging === "fast_path" || tool.staging === "join") return false;

  if (tool.riskTier === "high" || tool.resolvesRiskTier || tool.resolvesPolicyIntegration) {
    return true;
  }

  return tool.integration !== "system" && tool.readClass !== "ordinary";
}

/** Whether connection state can change this tool's availability result. */
export function readsAvailabilitySnapshot(tool: RegisteredTool): boolean {
  return tool.availability?.passthrough === true || isLoadableIntegrationSlug(tool.integration);
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
  allowed: ReadonlySet<IntegrationSlug>,
  context: ToolRunContext,
): ToolAvailabilityResult {
  const contextResult = evaluateRunContextGates(tool, allowed, context);

  if (!contextResult.available) return contextResult;

  return evaluateSnapshotGates(snapshot, tool);
}

/** Evaluate one tool and lazily read connection state only when it can matter. */
export async function resolveToolAvailability(args: {
  tool: RegisteredTool;
  allowed: ReadonlySet<IntegrationSlug>;
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
  allowedIntegrations: readonly IntegrationSlug[],
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
  allowedIntegrations: readonly IntegrationSlug[],
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
 * Whether these args declare the passthrough tier. Narrowing through
 * `availability?.passthrough === true` stops at `availability`, so the union of the two
 * `liveTool` arms needs this predicate to reach the passthrough arm.
 */
function isPassthroughToolArgs<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  O,
>(
  args: LiveToolArgs<I, A, S, boolean, O> | PassthroughToolArgs<I, A, S, boolean>,
): args is PassthroughToolArgs<I, A, S, boolean> {
  return args.availability?.passthrough === true;
}

/** `mcp.call` is not a `codeModeRead` tool (it also writes), but a script reads through it. */
const MCP_CALL_TOOL_NAME = "mcp.call" satisfies ToolName;

const TOOL_RISK_RANK = {
  no_risk: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const satisfies Record<ToolRiskTier, number>;

/**
 * Clamp a `resolveRiskTier` result (ADR-0088). A downgrade needs a declared
 * `riskTierDowngradeReason`; otherwise it is clamped to the static tier.
 */
function clampResolvedRiskTier(
  tool: RegisteredTool,
  resolved: unknown,
  runId: string,
): ToolRiskTier {
  // The resolver type is `Promise<ToolRiskTier>`, but nothing enforces that at
  // runtime, so a resolver can hand back a non-tier (ADR-0088). Fail closed to
  // the static tier. This checks only the resolver result, so the input is
  // still parsed one time.
  if (!isToolRiskTier(resolved)) {
    logger.warn(
      {
        event: "tool_risk_tier_invalid",
        toolName: tool.name,
        staticRiskTier: tool.riskTier,
        resolvedRiskTier: resolved,
        runId,
      },
      "Ignored invalid resolved tool risk tier",
    );

    return tool.riskTier;
  }

  const staticRank = TOOL_RISK_RANK[tool.riskTier];
  const resolvedRank = TOOL_RISK_RANK[resolved];

  if (resolvedRank >= staticRank) return resolved;

  if (!tool.riskTierDowngradeReason) {
    logger.warn(
      {
        event: "tool_risk_tier_downgrade_clamped",
        toolName: tool.name,
        staticRiskTier: tool.riskTier,
        attemptedRiskTier: resolved,
        runId,
      },
      "Clamped undeclared tool risk-tier downgrade",
    );

    return tool.riskTier;
  }

  logger.info(
    {
      event: "tool_risk_tier_downgrade",
      toolName: tool.name,
      staticRiskTier: tool.riskTier,
      resolvedRiskTier: resolved,
      reason: tool.riskTierDowngradeReason,
      runId,
    },
    "Applied reviewed tool risk-tier downgrade",
  );

  return resolved;
}

/** The brand's only mint. `bind` calls it on the redactor's output, or on the input when there is none. */
function markRedacted(value: unknown): RedactedToolInput {
  // SAFETY: the only caller passes the tool's redactor output, or the input of a tool with no redactor.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand's only mint, over redacted input
  return value as RedactedToolInput;
}

/** Build a registry entry. Call `registerTool` at boot to register it. */
export function liveTool<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  L extends boolean = false,
>(args: PassthroughToolArgs<I, A, S, L>): RegisteredTool;
export function liveTool<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  L extends boolean = false,
  O = unknown,
>(args: LiveToolArgs<I, A, S, L, O>): RegisteredTool;
// `L = boolean` resolves `execute` to the plain context, so the body needs no cast.
export function liveTool<
  I extends IntegrationSlug,
  A extends ActionSlug<I> & string,
  S extends z.ZodType,
  O,
>(args: LiveToolArgs<I, A, S, boolean, O> | PassthroughToolArgs<I, A, S, boolean>): RegisteredTool {
  const name = buildToolName(args.integration, args.action);

  const {
    redactInput,
    resolveRiskTier,
    resolvePolicyIntegration,
    refuseInput,
    refuseProposal,
    resolveReadFacts,
    bindServerFields,
  } = args;

  if (resolveReadFacts && args.codeModeRead !== undefined) {
    throw new Error(
      `[tools] '${name}' is a codeModeRead tool, so it must not declare resolveReadFacts`,
    );
  }

  // A script read with no evidence declaration would run with no references, coverage, or
  // stated reason. A passthrough read gets its evidence from `bind()`.
  if (
    (args.codeModeRead !== undefined || name === MCP_CALL_TOOL_NAME) &&
    !isPassthroughToolArgs(args) &&
    !args.readEvidence
  ) {
    throw new Error(`[tools] '${name}' is a script read, so it must declare readEvidence`);
  }

  // The model must not write a server field, so the schema it sees must leave the fields out.
  if (bindServerFields && !args.modelInputSchema) {
    throw new Error(`[tools] '${name}' declares bindServerFields without a modelInputSchema`);
  }

  // Only a read result can be outside text. A write result can echo the model's own input.
  if (args.outsideText && args.codeModeRead === undefined && !resolveReadFacts) {
    throw new Error(`[tools] '${name}' declares outsideText, but it is not a declared read`);
  }

  // Only a gated call writes a staging row, so on any other policy the check would never run.
  if (refuseProposal && (args.staging === "fast_path" || args.staging === "join")) {
    throw new Error(
      `[tools] '${name}' declares refuseProposal on staging='${args.staging}', which never stages`,
    );
  }

  const tool: RegisteredTool = {
    name,
    integration: args.integration,
    action: args.action,
    riskTier: args.riskTier,
    resolvesRiskTier: resolveRiskTier !== undefined,
    riskTierDowngradeReason: args.riskTierDowngradeReason,
    resolvesPolicyIntegration: resolvePolicyIntegration !== undefined,
    staging: args.staging ?? "staged",
    replay: args.replay,
    codeModeRead: args.codeModeRead !== undefined,
    readClass: args.codeModeRead,
    outsideText: args.outsideText === true,
    executionLane: args.executionLane,
    artifactStream: args.artifactStream,
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
    bind: (raw) => {
      const parsed = args.inputSchema.safeParse(raw);

      if (!parsed.success) return { success: false, error: parsed.error };

      const input = parsed.data;

      // Effects and span facts come from the raw typed output, one time, before dispatch
      // sanitizes it. The predicate narrows `args` to the passthrough arm, so `output` is
      // the `runRestPassthrough` envelope and the ADR-0074 truncation facts derive here
      // with no per-tool hook.
      const runExecution = async (ctx: ToolExecuteContext): Promise<ToolExecution> => {
        if (isPassthroughToolArgs(args)) {
          const output = await args.execute(input, ctx);

          return {
            output,
            effects: {
              ...args.effects?.(output),
              evidence: passthroughEvidence(name, input, output),
            },
            spanFacts: passthroughSpanFacts(output),
          };
        }

        const output = await args.execute(input, ctx);
        const declared = args.readEvidence;

        if (declared === "returned_by_execute") {
          if (!(output instanceof ReadResult)) {
            throw new Error(`[tools] '${name}' declares returned evidence, and execute gave none`);
          }

          return {
            output: output.output,
            effects: { ...args.effects?.(output), evidence: output.evidence },
            spanFacts: args.spanFacts?.(output) ?? {},
          };
        }

        const effects = args.effects?.(output) ?? NO_TOOL_EFFECTS;

        return {
          output,
          effects: declared ? { ...effects, evidence: declared(output, input) } : effects,
          spanFacts: args.spanFacts?.(output) ?? {},
        };
      };

      return {
        success: true,
        call: {
          tool,
          input,
          refusal: (ctx) => refuseInput?.(input, ctx) ?? null,
          bindServerFields: bindServerFields
            ? async (ctx) => tool.bind(await bindServerFields(input, ctx))
            : null,
          readFacts: async (ctx) => {
            if (args.codeModeRead !== undefined) return declaredStructuredRead(args.codeModeRead);

            return resolveReadFacts ? resolveReadFacts(input, ctx) : NOT_A_CONFIRMED_READ;
          },
          proposalRefusal: refuseProposal ? (ctx) => refuseProposal(input, ctx) : null,
          effectiveRiskTier: async (ctx) =>
            resolveRiskTier
              ? clampResolvedRiskTier(tool, await resolveRiskTier(input, ctx), ctx.runId)
              : tool.riskTier,
          policyIntegration: async (ctx) =>
            resolvePolicyIntegration ? resolvePolicyIntegration(input, ctx) : tool.integration,
          redactedInput: () => markRedacted(redactInput ? redactInput(input) : input),
          execute: async (ctx) => {
            if (args.availability?.requiresLiveChat !== true) {
              return runExecution(ctx);
            }

            const { chat } = ctx;

            // The dispatch gate keys on `interaction`, and the one live-chat builder (`chatToolRunIdentity`)
            // sets `interaction` and `chat` together. A direct call or a builder that splits them gets here.
            if (!chat) throw new Error(`[tools] '${name}' requires a live chat turn`);

            return runExecution({ ...ctx, chat });
          },
        },
      };
    },
  };

  return tool;
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

  if (tool.artifactStream !== undefined && tool.executionLane !== "artifact_mutation") {
    throw new Error(
      `[tools] '${tool.name}' declares artifactStream without executionLane='artifact_mutation'`,
    );
  }

  if (tool.riskTierDowngradeReason !== undefined) {
    if (!tool.resolvesRiskTier) {
      throw new Error(
        `[tools] '${tool.name}' declares riskTierDowngradeReason without resolveRiskTier`,
      );
    }

    if (tool.riskTierDowngradeReason.trim().length === 0) {
      throw new Error(`[tools] '${tool.name}' declares an empty riskTierDowngradeReason`);
    }
  }

  // These arms write no staging row, so no claim can stop a second run.
  if (tool.replay !== "safe" && tool.staging !== "staged" && tool.staging !== "confirm") {
    throw new Error(
      `[tools] '${tool.name}' declares staging='${tool.staging}' with replay='${tool.replay}' — ` +
        "only a staged or confirm call has a row to claim, so every other arm must be replay-safe",
    );
  }

  // ADR-0124: a script runs a host read with no card, so the read must have no effect to repeat
  // and must not be an arm that parks or forces a card.
  if (tool.codeModeRead) {
    const parks =
      tool.staging === "join" || tool.staging === "question" || tool.staging === "confirm";

    if (tool.replay !== "safe" || tool.riskTier === "high" || parks || tool.executionLane) {
      throw new Error(
        `[tools] '${tool.name}' declares codeModeRead but is not a plain read ` +
          `(replay='${tool.replay}', riskTier='${tool.riskTier}', staging='${tool.staging}'` +
          `${tool.executionLane ? `, executionLane='${tool.executionLane}'` : ""})`,
      );
    }
  }

  if (tool.availability?.codeModeReadPath && tool.name !== CODE_RUN_TOOL) {
    throw new Error(`[tools] only 'system.code_run' may declare availability.codeModeReadPath`);
  }

  // `fast_path` skips the approval gate, so refuse both halves of `toolRequiresApproval`: the
  // `high` tier, and a `gated` policy (ADR-0130 decision 1).
  if (tool.staging === "fast_path") {
    // A dynamic `resolveRiskTier` can return `high`.
    if (tool.riskTier === "high" || tool.resolvesRiskTier) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='fast_path' but can require approval ` +
          `(riskTier='${tool.riskTier}'${tool.resolvesRiskTier ? ", dynamic resolveRiskTier" : ""}) — ` +
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

  // ADR-0113. The card is the confirmation, so a person on a live thread must see it.
  if (tool.staging === "confirm") {
    if (tool.integration !== "system") {
      throw new Error(
        `[tools] '${tool.name}' declares staging='confirm' on integration='${tool.integration}' — ` +
          "the confirm arm is only defined for 'system' tools",
      );
    }

    if (tool.availability?.requiresLiveChat !== true) {
      throw new Error(
        `[tools] '${tool.name}' declares staging='confirm' but does not require a live chat — ` +
          "declare availability: { requiresLiveChat: true }, so the user sees the card",
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
function topLevelPropertyNames(schema: z.ZodType): string[] | null {
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
    [...REGISTRY.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
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
