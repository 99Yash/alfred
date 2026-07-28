import type { EventKind, EventPayload } from "@alfred/contracts/events";
import type { SyncedChatNarration } from "@alfred/sync";
import type { EventStreamFrame } from "~/lib/events/frame";
import { markChatTimingByAssistant } from "./timing";

/**
 * The client-side state machine for the in-flight assistant turn, split out of
 * `useChatStream` so its rules are executable rather than commented.
 *
 * The turn is a function of the SSE frames it has seen: `applyChatFrame` is the
 * only transition, `tickDrip` is the only projection, and both take the ref cell
 * explicitly. Nothing here touches React or the DOM, so the two invariants
 * ADR-0073 names by name — *a sub-agent frame may address an in-flight turn but
 * never create one*, and *a terminal tool card is absorbing* — are testable
 * under `node:test` without a browser.
 */

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean | undefined;
  /** Narration segment this call follows, ordering it against the narration trail. */
  segmentIndex: number;
  /**
   * Client clock at the first event seen for this call, and at its terminal
   * event (null while in flight) — the duration chip on the card. Measured at
   * event *receipt*, not on the server: it is honest about what the user
   * watched elapse, which is the only thing the chip claims.
   */
  startedTs: number;
  endedTs: number | null;
}

/**
 * A spawned sub-agent's own tool calls, nested under the spawn card.
 *
 * Keyed on `parentToolCallId` alone, which is only sound because the server
 * spawns **exactly one child per `(parentRunId, parentToolCallId)`**: see
 * `packages/api/src/modules/agent/sub-agents.ts` — `findExistingSubAgentRun`,
 * the sub-agent `dedupKey` unique index, and the 23505 fold-into-already-spawned
 * path. ADR-0073 is the addressing half of this (a child publishes into the
 * parent's address); the uniqueness half lives in that index, not in the ADR.
 *
 * If that guarantee ever stopped holding, a second child for the same
 * `parentToolCallId` would merge into the first child's trail: `subId` and
 * `childRunId` are write-once at trail creation (below), so the trail would keep
 * the first child's identity while accumulating the second's tool calls, and no
 * client comparison would notice — `streamSnapshotsEqual` deliberately does not
 * compare them (see its own note).
 */
export interface SubAgentTrail {
  /** The parent's `system.spawn_sub_agent` call this nests under. */
  parentToolCallId: string;
  /** Write-once at trail creation; a later frame for the same parent call keeps it. */
  subId: string;
  /** Write-once at trail creation; see `subId`. */
  childRunId: string;
  tools: StreamingToolCall[];
  startedTs: number;
  endedTs: number | null;
  /** Terminal outcome once the child run reports one; null while running. */
  outcome: "completed" | "failed" | "cancelled" | null;
  /**
   * The child parked — it is waiting on the user (an approval) or on a signal,
   * not working. Non-terminal: the run is still live and will reach a real
   * `outcome`. The clock keeps running (the wait is honestly part of the wall
   * time); what this corrects is the *state*, so the card stops claiming the
   * child is busy while it is actually blocked on a human.
   */
  waiting: boolean;
}

export interface StreamingMessage {
  messageId: string;
  runId: string;
  /**
   * Drip-buffered text of the current (latest) segment — the live reply,
   * eased toward the full received text for smooth typing. Closed narration
   * segments move into `narration` as later segments begin.
   */
  text: string;
  /** Closed narration segments to interleave with the tool cards in the trail. */
  narration: SyncedChatNarration[];
  /** Drip-buffered reasoning — the model's thinking, shown in the accordion. */
  reasoning: string;
  /** True while thinking is still arriving (reply hasn't started) — drives the shimmer. */
  reasoningActive: boolean;
  /** Frozen once thinking ends, in ms — drives the "Thought for Ns" label. */
  reasoningMs: number | null;
  tools: StreamingToolCall[];
  /**
   * Live trails for sub-agents spawned this turn, keyed for the client by the
   * `spawn_sub_agent` call they nest under. Separate from `tools` so a child's
   * steps never flatten into the boss's own trail.
   */
  subAgents: SubAgentTrail[];
  /** A write action is parked awaiting the user's approval. */
  awaitingApproval: boolean;
  /** Context is being condensed before the next provider call. */
  compacting: boolean;
  /** The turn finished; the durable synced message will replace this shortly. */
  done: boolean;
}

interface SubAgentTrailRef extends Omit<SubAgentTrail, "tools"> {
  tools: Map<string, StreamingToolCall>;
}

interface StreamRef {
  messageId: string;
  runId: string;
  /** Received text per narration segment (full, pre-easing). */
  segments: Map<number, string>;
  /** Highest segment index seen — the current/answer segment. */
  currentSegment: number;
  /** Eased chars shown for the current segment; reset when the segment advances. */
  shown: number;
  /** Segment `shown` is counting against — guards the reset on segment change. */
  shownSegment: number;
  reasoning: string;
  reasoningShown: number;
  reasoningStartTs: number | null;
  reasoningMs: number | null;
  /** Reply text has begun — thinking for the final answer is over. */
  replyStarted: boolean;
  /** Last appended server seq for reply text; guards against replay duplicates. */
  deltaSeq: number;
  /** Last appended server seq for reasoning text; guards against replay duplicates. */
  reasoningSeq: number;
  tools: Map<string, StreamingToolCall>;
  /** Keyed by the parent's `spawn_sub_agent` toolCallId — one trail per child. */
  subAgents: Map<string, SubAgentTrailRef>;
  /**
   * childRunId → parentToolCallId, so an `agent.run` lifecycle frame (which
   * carries only the child's run id) can close the right trail.
   */
  subAgentRuns: Map<string, string>;
  awaitingApproval: boolean;
  compacting: boolean;
  done: boolean;
  /**
   * The user hit stop locally. We flip to done immediately and ignore any late
   * SSE frames for this run, so the bubble freezes the instant they click
   * instead of waiting on the worker's Redis-flag poll (~400ms) to round-trip a
   * `completed` event. The durable synced message still reconciles afterward.
   */
  stopped: boolean;
}

/**
 * The mutable cell holding at most one in-flight turn — a plain object so tests
 * need no React.
 *
 * The cell names the thread it is for, fixed at construction: `applyChatFrame`
 * checks every frame against `cell.threadId` rather than against an argument, so
 * no call site can supply the wrong thread per frame, and a cell whose lifetime
 * is one subscription cannot carry a previous thread's turn across a thread
 * change. Being an interface, `{ threadId, current: null }` still satisfies it —
 * this makes the mistake require constructing a cell that lies about itself,
 * once, rather than threading a string through every call.
 *
 * `StreamRef` is deliberately not exported: naming it here is enough for the
 * hook to declare the cell, while keeping any second consumer from declaring
 * turn state of its own. It does not make the fields unreachable through
 * `cell.current`, so this buys concentration, not enforcement.
 */
export interface ChatStreamCell {
  /** The thread every frame applied to this cell must name. Set at construction. */
  readonly threadId: string;
  current: StreamRef | null;
}

/** The cell for one thread's subscription — empty until a frame mounts a turn. */
export function createChatStreamCell(threadId: string): ChatStreamCell {
  return { threadId, current: null };
}

/**
 * The kinds whose payload names a thread, and so are subject to the hoisted
 * thread check in `applyChatFrame`.
 *
 * `ChatEventKind` is derived from the contract rather than listed, so the
 * assertion below stops compiling the moment a fifth `chat.*` kind is added
 * without being classified here. Only the `chat.*` family is asserted: the wider
 * `EventKind` union is deliberately not exhausted (see `applyChatFrame`), and
 * `artifact.delta` carries a `threadId` too but is not read by this reducer —
 * classifying it would change nothing, since a matching thread still falls
 * through to `false` at the bottom.
 */
type ChatEventKind = Extract<EventKind, `chat.${string}`>;
type ThreadScopedKind = "chat.message" | "chat.reasoning" | "chat.delta" | "chat.tool";
type AssertNever<T extends never> = T;
/** A new `chat.*` kind must be classified above — this line stops compiling first. */
type _EveryChatKindIsThreadScoped = AssertNever<Exclude<ChatEventKind, ThreadScopedKind>>;

/**
 * The thread a frame names, or `null` for a kind that names none.
 *
 * The single reader of `payload.threadId` in this module: a payload that drops
 * or renames the field fails to compile here instead of at each arm that used to
 * spell the comparison for itself.
 */
function frameThreadId(frame: EventStreamFrame): string | null {
  switch (frame.kind) {
    case "chat.message":
    case "chat.reasoning":
    case "chat.delta":
    case "chat.tool":
      return frame.payload.threadId;
    default:
      return null;
  }
}

/**
 * Whether a sub-agent's `chat.tool` event belongs to the turn currently on
 * screen. It must be able to *address* the in-flight turn but never *create*
 * one: a child outlives its parent turn (cancelling a run does not cascade to
 * its children, and a spawn need never be awaited), so a late child event can
 * arrive while a completely different turn is streaming. Mounting a fresh
 * stream ref for it would blank that turn's bubble and reset its delta seq.
 */
export function subAgentEventAddressesStream<
  T extends { messageId: string; runId: string; stopped: boolean },
>(current: T | null, event: { messageId: string; runId: string }): current is T {
  if (!current || current.stopped) return false;
  return current.messageId === event.messageId && current.runId === event.runId;
}

export function applyStreamingToolEvent(
  tools: Map<string, StreamingToolCall>,
  event: EventPayload<"chat.tool">,
  now: number = Date.now(),
): void {
  if (event.nonExecution) {
    tools.delete(event.toolCallId);
    return;
  }

  const previous = tools.get(event.toolCallId);
  // A terminal card is absorbing. `started` can arrive *after* it — the same
  // batch is re-dispatched on resume/reclaim and republishes its `started`, and
  // SSE frames are not ordered — and un-freezing the card would restart the
  // clock and flip a finished step back to a spinner.
  if (event.status === "started" && previous && previous.endedTs !== null) return;
  tools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    argsPreview: event.argsPreview ?? previous?.argsPreview,
    resultPreview: event.resultPreview ?? previous?.resultPreview,
    sanitized: event.sanitized ?? previous?.sanitized,
    segmentIndex: event.segmentIndex ?? previous?.segmentIndex ?? 0,
    startedTs: previous?.startedTs ?? now,
    // A terminal event freezes the clock; a repeated terminal event (replay)
    // keeps the first one so the chip doesn't drift upward on reconnect.
    endedTs: event.status === "started" ? null : (previous?.endedTs ?? now),
  });
}

/**
 * Return the in-flight stream state for `messageId`, creating it if needed.
 * The `chat.message` "started" event normally mounts this, but on a fresh
 * thread the navigation `/chat` → `/chat/<id>` reopens the SSE stream and
 * "started" can fire in that gap (the bus has no replay). Initializing from
 * the first event of any kind — reasoning, delta, or tool — keeps the turn
 * from rendering blank when "started" is missed. A different `messageId`
 * or `runId` means a new turn, so we reset.
 */
function ensureStreamRef(cell: ChatStreamCell, messageId: string, runId: string): StreamRef {
  const existing = cell.current;
  if (existing && existing.messageId === messageId && existing.runId === runId) return existing;
  const fresh: StreamRef = {
    messageId,
    runId,
    segments: new Map(),
    currentSegment: 0,
    shown: 0,
    shownSegment: 0,
    reasoning: "",
    reasoningShown: 0,
    reasoningStartTs: null,
    reasoningMs: null,
    replyStarted: false,
    deltaSeq: 0,
    reasoningSeq: 0,
    tools: new Map(),
    subAgents: new Map(),
    subAgentRuns: new Map(),
    awaitingApproval: false,
    compacting: false,
    done: false,
    stopped: false,
  };
  cell.current = fresh;
  return fresh;
}

/**
 * Apply one validated SSE frame to the turn.
 *
 * Returns whether the view must be re-projected — exactly the branches that
 * scheduled an animation frame when this lived inside the hook. A branch that
 * drops a frame (a stale seq, a child event addressed to a turn that has since
 * been replaced, an `agent.run` for a run we never mapped) returns `false`, so
 * the caller can leave the rAF loop parked instead of spinning at 60fps through
 * an approval wait.
 *
 * The union is wider than the six kinds a chat turn reads, so the unhandled
 * kinds (`inbox.updated`, `artifact.delta`, …) fall through to `false` by
 * design; this is not an exhaustiveness gap.
 *
 * The thread check is hoisted above the kind dispatch and runs unconditionally,
 * so an arm added later inherits it instead of having to remember it. The two
 * kinds that name no thread (`agent.run`, `approval.requested`) pass it and then
 * resolve only against a ref that already exists — they cannot mount one.
 */
export function applyChatFrame(
  cell: ChatStreamCell,
  frame: EventStreamFrame,
  now: number = Date.now(),
): boolean {
  const named = frameThreadId(frame);
  if (named !== null && named !== cell.threadId) return false;

  if (frame.kind === "chat.message") {
    const p = frame.payload;
    if (p.phase === "started") {
      ensureStreamRef(cell, p.messageId, p.runId);
      markChatTimingByAssistant(p.messageId, "stream_started_event", undefined, {
        threadId: cell.threadId,
        runId: p.runId,
      });
      return true;
    }
    const r = cell.current;
    if (!r || r.messageId !== p.messageId || r.runId !== p.runId) return false;
    if (p.phase === "compaction_started" || p.phase === "compaction_finished") {
      r.compacting = p.phase === "compaction_started";
      return true;
    }
    if (p.phase === "completed") {
      markChatTimingByAssistant(p.messageId, "completion_event", undefined, {
        threadId: cell.threadId,
        runId: p.runId,
        summarize: true,
      });
      r.done = true;
      r.awaitingApproval = false;
      r.compacting = false;
      return true;
    }
    // `phase` is a closed four-member enum, so this is unreachable — the payload
    // was parsed by this build's own schema. It is here so that adding a member
    // (`failed`, `cancelled`, …) fails to compile rather than falling into the
    // completion branch and silently tearing down a live bubble.
    const _exhaustive: never = p.phase;
    return _exhaustive;
  }

  if (frame.kind === "chat.reasoning") {
    const p = frame.payload;
    // Mount before the stop check so it applies to the ref this frame names:
    // a late frame for a stopped run is dropped, a frame for a new
    // (messageId, runId) is a new turn and mounts fresh.
    const r = ensureStreamRef(cell, p.messageId, p.runId);
    if (r.stopped) return false;
    if (p.seq <= r.reasoningSeq) return false;
    r.reasoningSeq = p.seq;
    if (r.reasoningStartTs === null) r.reasoningStartTs = now;
    r.reasoning += p.text;
    markChatTimingByAssistant(
      p.messageId,
      "first_reasoning_frame",
      { seq: p.seq, chars: p.text.length, totalReasoningChars: r.reasoning.length },
      { threadId: cell.threadId, runId: p.runId },
    );
    markChatTimingByAssistant(
      p.messageId,
      "last_reasoning_frame",
      { seq: p.seq, chars: p.text.length, totalReasoningChars: r.reasoning.length },
      { threadId: cell.threadId, runId: p.runId, repeat: "update", log: false },
    );
    return true;
  }

  if (frame.kind === "chat.delta") {
    const p = frame.payload;
    const r = ensureStreamRef(cell, p.messageId, p.runId);
    if (r.stopped) return false;
    if (p.seq <= r.deltaSeq) return false;
    r.deltaSeq = p.seq;
    // First reply token: thinking for the answer is over — freeze its duration.
    if (!r.replyStarted) {
      r.replyStarted = true;
      if (r.reasoningStartTs !== null && r.reasoningMs === null) {
        r.reasoningMs = now - r.reasoningStartTs;
      }
    }
    // Append to this delta's segment. A higher segment means the prior
    // segment just closed (the model wrote it before a tool step) — it
    // drops into the narration trail and this becomes the live reply.
    const segment = p.segmentIndex ?? 0;
    r.segments.set(segment, (r.segments.get(segment) ?? "") + p.text);
    if (segment > r.currentSegment) r.currentSegment = segment;
    const detail = {
      seq: p.seq,
      chars: p.text.length,
      totalTextChars: r.segments.get(segment)?.length ?? 0,
    };
    markChatTimingByAssistant(p.messageId, "first_delta_frame", detail, {
      threadId: cell.threadId,
      runId: p.runId,
    });
    markChatTimingByAssistant(p.messageId, "last_delta_frame", detail, {
      threadId: cell.threadId,
      runId: p.runId,
      repeat: "update",
      log: false,
    });
    return true;
  }

  if (frame.kind === "chat.tool") {
    const p = frame.payload;
    // A spawned sub-agent's call nests under the `spawn_sub_agent` card that
    // started it rather than joining the boss's own trail. The event
    // deliberately carries the parent's runId/messageId (see
    // `chatToolSubAgentSchema`) — but it resolves against the turn already
    // on screen and never mounts one, because a child can outlive its
    // parent turn and must not hijack whatever is streaming now.
    if (p.subAgent) {
      const current = cell.current;
      if (!subAgentEventAddressesStream(current, p)) return false;
      const { parentToolCallId, subId, childRunId } = p.subAgent;
      const existing = current.subAgents.get(parentToolCallId);
      // A bounce retracts a card; with no trail there is nothing to retract,
      // and drawing an empty container for it would be worse than silence.
      if (!existing && p.nonExecution) return false;
      const trail = existing ?? {
        parentToolCallId,
        subId,
        childRunId,
        tools: new Map<string, StreamingToolCall>(),
        startedTs: now,
        endedTs: null,
        outcome: null,
        waiting: false,
      };
      applyStreamingToolEvent(trail.tools, p, now);
      current.subAgents.set(parentToolCallId, trail);
      current.subAgentRuns.set(childRunId, parentToolCallId);
      return true;
    }
    const r = ensureStreamRef(cell, p.messageId, p.runId);
    if (r.stopped) return false;
    applyStreamingToolEvent(r.tools, p, now);
    // A retraction changed the trail, so the view still has to re-project —
    // it just has no timing mark to record.
    if (p.nonExecution) return true;
    markChatTimingByAssistant(
      p.messageId,
      "first_tool_event",
      { toolName: p.toolName, status: p.status },
      { threadId: cell.threadId, runId: p.runId },
    );
    markChatTimingByAssistant(
      p.messageId,
      "last_tool_event",
      { toolName: p.toolName, status: p.status },
      { threadId: cell.threadId, runId: p.runId, repeat: "update", log: false },
    );
    return true;
  }

  if (frame.kind === "agent.run") {
    // A child run's own lifecycle. `chat.tool` says what a sub-agent did but
    // never that it is finished or that it stalled, so both come from here —
    // the executor already publishes these for every run, children included.
    // Frames for the parent run and for unrelated background runs fall
    // through: only a runId we mapped from a child's tool event reaches a
    // trail. The payload carries no `threadId` at all, which is what makes it
    // structurally incapable of mounting a turn.
    const p = frame.payload;
    const r = cell.current;
    if (!r || r.stopped) return false;
    const parentToolCallId = r.subAgentRuns.get(p.runId);
    if (!parentToolCallId) return false;
    const trail = r.subAgents.get(parentToolCallId);
    // Terminal is absorbing: a later frame for a landed child changes nothing.
    if (!trail || trail.outcome !== null) return false;
    if (p.phase === "completed" || p.phase === "failed" || p.phase === "cancelled") {
      trail.outcome = p.phase;
      trail.endedTs = now;
      trail.waiting = false;
      return true;
    }
    if (p.phase === "interrupted") {
      // The child parked — most often on an approval, so the time from here
      // is the user's, not the agent's. The card stops claiming it is busy.
      trail.waiting = true;
      return true;
    }
    // Any other frame from a parked child means it is moving again. Note
    // `resumed` is in the enum but nothing publishes it: a resuming run
    // emits `step_started`, so this clears on activity rather than on a
    // phase name. A non-terminal phase for a child that was never parked
    // changes nothing on screen.
    if (!trail.waiting) return false;
    trail.waiting = false;
    return true;
  }

  if (frame.kind === "approval.requested") {
    const p = frame.payload;
    const r = cell.current;
    if (!r || r.stopped || p.runId !== r.runId) return false;
    r.awaitingApproval = true;
    markChatTimingByAssistant(
      r.messageId,
      "approval_requested",
      { approvalId: p.approvalId },
      { threadId: cell.threadId, runId: r.runId },
    );
    return true;
  }

  return false;
}

/**
 * Optimistic stop: freeze the eased buffers at what is currently shown and flip
 * to done, so the composer swaps back to the send button this frame. `stopped`
 * makes `applyChatFrame` drop any further frames for this run, so the bubble
 * doesn't keep typing while the server finalizes in the background.
 *
 * Returns whether anything changed — `false` when nothing is in flight or the
 * turn was already stopped. The truncation and the `done` flip live here
 * together so the freeze and the state it freezes cannot drift. The freeze has
 * to re-anchor before it slices, or a delta that advanced the segment since the
 * last animation frame leaves it cutting the live segment to the *previous*
 * segment's length; `anchorEasedSegment` hands back the segment, its text and
 * its counter as one matched triple, so the slice below can only be written
 * with all three in step. Reaching past it to `ref.shown` still compiles — see
 * that function's own note.
 *
 * A segment the deltas already closed stays in the projected `narration` in
 * full: closing it was the delta's doing, not the stop's. So a stop landing in
 * that window freezes the live bubble at zero characters with the prose the
 * user saw carried in `narration` instead. Whether that reaches the screen is
 * the consumer's call, and today it is conditional: `conversation.tsx:596`
 * renders the trail only inside `{stream.tools.length > 0 …}`, so a turn with
 * no tool cards shows none of it. That render gate is pre-existing coupling
 * this freeze cannot reach.
 */
export function applyOptimisticStop(cell: ChatStreamCell): boolean {
  const r = cell.current;
  if (!r || r.stopped) return false;
  // Freeze the live segment at what's shown *of it* so the bubble stops typing.
  const eased = anchorEasedSegment(r);
  r.segments.set(eased.segment, eased.text.slice(0, eased.shown));
  r.reasoning = r.reasoning.slice(0, r.reasoningShown);
  r.stopped = true;
  r.done = true;
  r.awaitingApproval = false;
  r.compacting = false;
  return true;
}

/** A few chars per animation frame, proportional so a big backlog catches up. */
function ease(shown: number, full: number): number {
  return shown < full ? Math.min(full, shown + Math.max(2, Math.ceil((full - shown) / 8))) : shown;
}

/**
 * Re-anchor the eased counter to the live segment and hand back the segment it
 * now describes, its received text, and the chars already shown of it.
 *
 * `shown` counts against `shownSegment` only, and `applyChatFrame` advances
 * `currentSegment` without touching either — so between a segment-advancing
 * delta and the next animation frame, `shown` describes a strictly earlier
 * segment. Both readers (`tickDrip`, `applyOptimisticStop`) take the counter
 * off the return value; the write-back in `tickDrip` is the only other mention
 * of `ref.shown` in the file, so no read of it is currently unanchored. That is
 * a property of the two call sites, not something a type enforces — a third
 * reader that helps itself to `ref.shown` compiles fine and is wrong in the
 * same invisible window. When the segment advances the counter restarts at 0:
 * the new segment eases in from the start, the prior one having moved into the
 * narration trail.
 */
function anchorEasedSegment(ref: StreamRef): { segment: number; text: string; shown: number } {
  if (ref.shownSegment !== ref.currentSegment) {
    ref.shownSegment = ref.currentSegment;
    ref.shown = 0;
  }
  return {
    segment: ref.shownSegment,
    text: ref.segments.get(ref.shownSegment) ?? "",
    shown: ref.shown,
  };
}

/**
 * Advance the drip buffers one animation frame, then project the view.
 *
 * There is no way to obtain a `StreamingMessage` without the easing having run
 * first — that ordering used to be a comment. `caughtUp` is true once both
 * eased counters have reached their received text, which is the caller's signal
 * to stop scheduling frames: later SSE frames restart the loop.
 *
 * Returns `null` when nothing is mounted, so the caller never has to read
 * `cell.current` to find out — the cell's identity stays the only thing about it
 * a consumer needs to know.
 */
export function tickDrip(
  cell: ChatStreamCell,
): { snapshot: StreamingMessage; caughtUp: boolean } | null {
  const ref = cell.current;
  if (!ref) return null;
  const eased = anchorEasedSegment(ref);
  const shown = ease(eased.shown, eased.text.length);
  ref.reasoningShown = ease(ref.reasoningShown, ref.reasoning.length);
  ref.shown = shown;
  const narration: SyncedChatNarration[] = [];
  for (const [index, text] of ref.segments) {
    if (index < ref.currentSegment && text.trim().length > 0) narration.push({ index, text });
  }
  narration.sort((a, b) => a.index - b.index);
  return {
    snapshot: {
      messageId: ref.messageId,
      runId: ref.runId,
      text: eased.text.slice(0, shown),
      narration,
      reasoning: ref.reasoning.slice(0, ref.reasoningShown),
      reasoningActive: ref.reasoning.length > 0 && !ref.replyStarted && !ref.done,
      reasoningMs: ref.reasoningMs,
      tools: [...ref.tools.values()],
      subAgents: [...ref.subAgents.values()].map((trail) => ({
        ...trail,
        tools: [...trail.tools.values()],
      })),
      awaitingApproval: ref.awaitingApproval,
      compacting: ref.compacting,
      done: ref.done,
    },
    caughtUp: shown >= eased.text.length && ref.reasoningShown >= ref.reasoning.length,
  };
}

/**
 * Whether two projections would render identically — the push gate for the
 * animation loop, so it runs on every frame and only compares what can move.
 *
 * A trail's `subId`, `childRunId` and `startedTs` are deliberately excluded:
 * they are write-once at trail creation and never change, so comparing them is
 * dead work 60 times a second. That is sound only because the server spawns
 * exactly one child per `(parentRunId, parentToolCallId)` — see `SubAgentTrail`
 * for the guarantee and for what a second child would silently do here.
 */
export function streamSnapshotsEqual(a: StreamingMessage | null, b: StreamingMessage): boolean {
  if (!a) return false;
  if (
    a.messageId !== b.messageId ||
    a.runId !== b.runId ||
    a.text !== b.text ||
    a.reasoning !== b.reasoning ||
    a.reasoningActive !== b.reasoningActive ||
    a.reasoningMs !== b.reasoningMs ||
    a.awaitingApproval !== b.awaitingApproval ||
    a.compacting !== b.compacting ||
    a.done !== b.done ||
    a.tools.length !== b.tools.length ||
    a.subAgents.length !== b.subAgents.length ||
    a.narration.length !== b.narration.length
  ) {
    return false;
  }
  for (let i = 0; i < a.subAgents.length; i += 1) {
    const left = a.subAgents[i]!;
    const right = b.subAgents[i]!;
    if (
      left.parentToolCallId !== right.parentToolCallId ||
      left.outcome !== right.outcome ||
      left.waiting !== right.waiting ||
      left.endedTs !== right.endedTs ||
      !toolListsEqual(left.tools, right.tools)
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.narration.length; i += 1) {
    const left = a.narration[i]!;
    const right = b.narration[i]!;
    if (left.index !== right.index || left.text !== right.text) return false;
  }
  return toolListsEqual(a.tools, b.tools);
}

/**
 * Field-wise comparison of two tool lists. `startedTs` is deliberately excluded
 * — it is assigned once on first sight and never changes, so comparing it would
 * only cost cycles; `endedTs` moves exactly once (with `status`) and is covered
 * by the status check.
 */
function toolListsEqual(a: StreamingToolCall[], b: StreamingToolCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.toolCallId !== right.toolCallId ||
      left.toolName !== right.toolName ||
      left.status !== right.status ||
      left.argsPreview !== right.argsPreview ||
      left.resultPreview !== right.resultPreview ||
      left.sanitized !== right.sanitized ||
      left.segmentIndex !== right.segmentIndex
    ) {
      return false;
    }
  }
  return true;
}
