/**
 * The one place a `chat.tool` event (a live tool card) is built.
 *
 * Two surfaces publish these: the chat turn for the boss's own calls, and the
 * brief workflow for a spawned sub-agent's calls streaming into that same turn
 * (ADR-0016/0073). Both used to hand-assemble the payload literal, which made
 * every new field on `chatToolSchema` a coordination problem across N call
 * sites, and left two invariants stated only in prose:
 *
 *  1. **Whose run the event claims.** The client keys its in-flight turn on
 *     `(messageId, runId)`, so an event carrying the CHILD's runId reads as a
 *     brand-new turn. Every top-level field must be the parent's; the child's
 *     own identity belongs in `subAgent`. A caller cannot get this wrong here
 *     because the only way to obtain a child's target is
 *     {@link subAgentToolCardTarget}, which reads `parentRunId`.
 *  2. **The identity strings are provider-supplied.** `toolName` and
 *     `toolCallId` come off the model stream, `chatToolSchema` bounds them, and
 *     `publishEvent` THROWS on a rejected payload. A model-invented 121-char
 *     tool name inside an awaited commit hook would therefore fail the whole run
 *     rather than bounce as `unknown_tool` and self-correct — exactly the
 *     ADR-0070 / #267 class. Both builders clamp instead (see
 *     {@link boundToolIdentity}).
 */

import {
  CHAT_TOOL_CALL_ID_MAX,
  CHAT_TOOL_NAME_MAX,
  type EventPayload,
} from "@alfred/contracts/events";
import type { ToolName } from "@alfred/contracts/tools";
import type { SubAgentMetadata } from "../sub-agent-metadata";
import { preview } from "./tool-preview";
import type { ToolEventOutcome } from "./tool-event-outcome";

/**
 * The chat turn a card belongs to. `runId` / `threadId` / `messageId` are always
 * the turn's own — which for a spawned sub-agent means the PARENT's (see the
 * module note). `subAgent` present marks the card as a child's nested step.
 */
export interface ToolCardTarget {
  /** The run that owns the *turn* — the parent's when `subAgent` is set. */
  runId: string;
  threadId: string;
  messageId: string;
  subAgent?: NonNullable<EventPayload<"chat.tool">["subAgent"]> | undefined;
}

/**
 * The publish target for a sub-agent run, or null when there is nothing to
 * publish to: the run is the boss itself (it publishes its own cards from the
 * chat workflow), or it is a child of a background parent with no chat turn.
 */
export function subAgentToolCardTarget(
  subAgent: SubAgentMetadata | null,
  childRunId: string,
): ToolCardTarget | null {
  if (!subAgent?.chat) return null;
  return {
    runId: subAgent.parentRunId,
    threadId: subAgent.chat.threadId,
    messageId: subAgent.chat.messageId,
    subAgent: {
      parentToolCallId: subAgent.parentToolCallId,
      subId: subAgent.subId,
      childRunId,
    },
  };
}

/**
 * Whether to publish the optimistic `started` card for this call. A tool that is
 * not on the run's active surface bounces before execute, and the client would
 * have to retract the card it just drew — so don't draw it (see
 * `.lessons/nonexecution-bounce-hidden-from-chat-ui.md`, surface 1).
 */
export function shouldPublishToolStarted(
  activeTools: readonly ToolName[],
  toolName: string,
): boolean {
  return activeTools.some((activeTool) => activeTool === toolName);
}

/**
 * `segmentIndex` orders a card against the boss's interleaved narration. A
 * child's cards are nested inside the spawn card and never enter that ordering,
 * so the field is inert for a sub-agent — pinned to 0 rather than left to drift.
 */
export const NESTED_SEGMENT_INDEX = 0;

/** Clamp the provider-supplied identity to what the wire schema accepts (note 2). */
function boundToolIdentity(call: { toolCallId: string; toolName: string }): {
  toolCallId: string;
  toolName: string;
} {
  return {
    toolCallId: call.toolCallId.slice(0, CHAT_TOOL_CALL_ID_MAX),
    toolName: call.toolName.slice(0, CHAT_TOOL_NAME_MAX),
  };
}

/** The optimistic card drawn the moment the model finishes emitting the call. */
export function toolCardStarted(
  target: ToolCardTarget,
  call: { toolCallId: string; toolName: string; input: unknown },
  segmentIndex: number,
): EventPayload<"chat.tool"> {
  return {
    runId: target.runId,
    threadId: target.threadId,
    messageId: target.messageId,
    ...boundToolIdentity(call),
    status: "started",
    argsPreview: preview(call.input),
    segmentIndex,
    ...(target.subAgent ? { subAgent: target.subAgent } : {}),
  };
}

/**
 * The card's resolution. `nonExecution` rides along so the client retracts an
 * optimistic card for a dispatcher bounce instead of showing internal plumbing
 * as a failed step; `artifactId` binds a live artifact stream to its durable row.
 */
export function toolCardTerminal(
  target: ToolCardTarget,
  call: { toolCallId: string; toolName: string },
  outcome: ToolEventOutcome,
  opts: { segmentIndex: number; artifactId?: string | undefined },
): EventPayload<"chat.tool"> {
  return {
    runId: target.runId,
    threadId: target.threadId,
    messageId: target.messageId,
    ...boundToolIdentity(call),
    status: outcome.status,
    resultPreview: outcome.resultPreview,
    ...(outcome.sanitized ? { sanitized: outcome.sanitized } : {}),
    ...(outcome.nonExecution ? { nonExecution: outcome.nonExecution } : {}),
    ...(opts.artifactId ? { artifactId: opts.artifactId } : {}),
    segmentIndex: opts.segmentIndex,
    ...(target.subAgent ? { subAgent: target.subAgent } : {}),
  };
}
