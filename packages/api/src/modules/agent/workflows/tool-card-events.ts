/**
 * The one place a `chat.tool` event (a live tool card) is built.
 *
 * Two surfaces publish these: the chat turn for the boss's own calls, and the
 * brief workflow for a spawned sub-agent's calls streaming into that same turn
 * (ADR-0016/0073). Both used to hand-assemble the payload literal, which made
 * every new field on `chatToolSchema` a coordination problem across N call
 * sites, and left two invariants stated only in prose:
 *
 *  1. **Whose run the event claims, and whether that run is still live.** The
 *     client keys its in-flight turn on `(messageId, runId)`, so an event
 *     carrying the CHILD's runId reads as a brand-new turn. Every top-level
 *     field must be the parent's; the child's own identity belongs in
 *     `subAgent`. And the client arms a replay-recovery barrier on the parent's
 *     `runId`, released only on the parent's terminal `chat.message/completed`,
 *     so a card republished under an ALREADY-terminal parent (on a resume or a
 *     stale-lease reclaim) arms a barrier nothing will release. A caller cannot
 *     get either wrong here: the only way to obtain a child's target is
 *     {@link subAgentToolCardTarget}, which reads `parentRunId` and refuses to
 *     mint a target unless the parent run is still open — an ungated sub-agent
 *     target is unconstructible (it carries a module-private brand the door is
 *     the sole mint of).
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
 * A brand no other module can name, minted only inside {@link subAgentToolCardTarget}
 * after it has confirmed the parent run is still open. It never reaches the wire
 * payload — the builders below assemble a fresh literal and never spread a target.
 */
const PROVEN_LIVE = Symbol("liveParentRun");
type ProvenLive = { readonly [PROVEN_LIVE]: true };

/** The three address fields every card carries — the turn's own `runId`. */
interface ToolCardAddress {
  /** The run that owns the *turn* — the parent's for a sub-agent card. */
  runId: string;
  threadId: string;
  messageId: string;
}

/**
 * The boss's own card. Its run owns the live turn it is building, so there is no
 * liveness question and no `subAgent` nesting. A boss literal is written inline
 * at the chat-turn and stream-model-turn call sites.
 */
export interface BossToolCardTarget extends ToolCardAddress {
  subAgent?: undefined;
}

/**
 * A sub-agent's nested card, PROVEN to address a still-open parent run. The
 * `PROVEN_LIVE` brand is minted only by {@link subAgentToolCardTarget}, so a
 * hand-built sub-agent target that skipped the liveness read cannot be
 * constructed outside this module.
 */
export type LiveSubAgentToolCardTarget = ToolCardAddress & {
  subAgent: NonNullable<EventPayload<"chat.tool">["subAgent"]>;
} & ProvenLive;

/**
 * The chat turn a card belongs to. `runId` / `threadId` / `messageId` are always
 * the turn's own — which for a spawned sub-agent means the PARENT's (see the
 * module note). A present `subAgent` marks the card as a child's nested step, and
 * that arm is proven-live by construction.
 */
export type ToolCardTarget = BossToolCardTarget | LiveSubAgentToolCardTarget;

/**
 * The sole door that mints a sub-agent publish target. Returns null when there is
 * nothing to publish to — the run is the boss itself (it publishes its own cards
 * from the chat workflow), or it is a child of a background parent with no chat
 * turn — OR when the parent run is no longer open.
 *
 * The parent-liveness read is folded IN here, not left to the call site, so an
 * ungated sub-agent target is unconstructible: the client arms a replay-recovery
 * barrier on the parent's `runId` and releases it only on the parent's terminal
 * `chat.message/completed`, so a card republished under an already-terminal
 * parent (on a resume or stale-lease reclaim) would arm a barrier nothing
 * releases. `isParentOpen` is injected — the DB reader lives with `getRun` in the
 * brief workflow, which keeps this module a pure payload builder — and is asked
 * only after a chat turn to publish to is confirmed.
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
