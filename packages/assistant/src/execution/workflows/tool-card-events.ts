/**
 * The one builder for `chat.tool` events (live tool cards), for the boss and its sub-agents
 * (ADR-0073).
 *
 * A sub-agent card carries the parent's `runId`: the client keys the turn on it.
 * It also must not publish under a finished parent, or it arms a client replay barrier nothing
 * releases.
 * The tool name and call id come from the model, and `publishEvent` throws on an over-long one,
 * so the builders clamp them instead of failing the run.
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
 * Only {@link subAgentToolCardTarget} mints it, after it checks the parent is open. Never on the
 * wire.
 */
const PROVEN_LIVE = Symbol("liveParentRun");

type ProvenLive = { readonly [PROVEN_LIVE]: true };

interface ToolCardAddress {
  /** The run that owns the turn: the parent for a sub-agent card. */
  runId: string;
  threadId: string;
  messageId: string;
}

export interface BossToolCardTarget extends ToolCardAddress {
  subAgent?: undefined;
}

/** A sub-agent card whose parent was open. Only {@link subAgentToolCardTarget} can build one. */
export type LiveSubAgentToolCardTarget = ToolCardAddress & {
  subAgent: NonNullable<EventPayload<"chat.tool">["subAgent"]>;
} & ProvenLive;

export type ToolCardTarget = BossToolCardTarget | LiveSubAgentToolCardTarget;

/**
 * The publish target for a sub-agent's cards, or null if there is no chat turn
 * or the parent run has finished. `isParentOpen` is injected to keep this module DB-free.
 */
export async function subAgentToolCardTarget(
  subAgent: SubAgentMetadata | null,
  childRunId: string,
  userId: string,
  isParentOpen: (parentRunId: string, userId: string) => Promise<boolean>,
): Promise<LiveSubAgentToolCardTarget | null> {
  if (!subAgent?.chat) return null;

  if (!(await isParentOpen(subAgent.parentRunId, userId))) return null;

  return {
    runId: subAgent.parentRunId,
    threadId: subAgent.chat.threadId,
    messageId: subAgent.chat.messageId,
    subAgent: {
      parentToolCallId: subAgent.parentToolCallId,
      subId: subAgent.subId,
      childRunId,
    },
    [PROVEN_LIVE]: true,
  };
}

/** A tool not on the active surface bounces before it runs, so do not draw a card for it. */
export function shouldPublishToolStarted(
  activeTools: readonly ToolName[],
  toolName: string,
): boolean {
  return activeTools.some((activeTool) => activeTool === toolName);
}

/** Sub-agent cards nest inside the spawn card, so their narration order is unused. */
export const NESTED_SEGMENT_INDEX = 0;

function boundToolIdentity(call: { toolCallId: string; toolName: string }) {
  return {
    toolCallId: call.toolCallId.slice(0, CHAT_TOOL_CALL_ID_MAX),
    toolName: call.toolName.slice(0, CHAT_TOOL_NAME_MAX),
  };
}

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
    argsPreview: preview(call.input).text,
    segmentIndex,
    ...(target.subAgent ? { subAgent: target.subAgent } : {}),
  };
}

/** `nonExecution` makes the client remove the card instead of showing a bounce as a failed step. */
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
    ...(outcome.resultTruncated ? { resultTruncated: outcome.resultTruncated } : {}),
    ...(outcome.sanitized ? { sanitized: outcome.sanitized } : {}),
    ...(outcome.nonExecution ? { nonExecution: outcome.nonExecution } : {}),
    ...(outcome.connectNudge ? { connectNudge: outcome.connectNudge } : {}),
    ...(opts.artifactId ? { artifactId: opts.artifactId } : {}),
    segmentIndex: opts.segmentIndex,
    ...(target.subAgent ? { subAgent: target.subAgent } : {}),
  };
}
