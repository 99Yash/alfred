import { SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
import type { SyncedChatNarration } from "@alfred/sync";
import type { ToolCallView } from "./tool-call-presentation";

export type TrailItem =
  | { kind: "narration"; key: string; text: string }
  // One row per *run* of identical calls: a `gmail.search` and a follow-up
  // `gmail.search` collapse into one card with a `2×` badge, so a turn that
  // pages the same source a few times doesn't read as N near-identical rows.
  // Grouped on (toolName, status) so a failure never hides under a success's
  // count — a fail then a retry-success stay two distinct rows.
  | { kind: "tool"; key: string; tools: ToolCallView[] };

/**
 * Weave the model's narration lines and its tool calls into one ordered trail.
 * Both carry a `segmentIndex`: segment N's narration precedes the tools the
 * model called in step N. Within a segment, the narration line comes first,
 * then its tools in arrival order — mirroring how the turn actually streamed.
 * Consecutive calls to the same tool with the same status fold into one row
 * (carrying every call) so repeated reads collapse to a single badged card;
 * narration or a different tool/status between them breaks the run.
 *
 * This is the whole emptiness rule for the activity trail: a turn draws a trail
 * iff this returns a row. The two channels are independent by construction — a
 * segment closes on a later `chat.delta`, never on a tool event, and a
 * `nonExecution` dispatch retracts its card outright — so "has narration" does
 * not imply "has a card", and neither channel may gate the other.
 */
export function buildTrail(
  tools: ToolCallView[],
  narration: readonly SyncedChatNarration[],
): TrailItem[] {
  const toolsBySegment = new Map<number, ToolCallView[]>();
  for (const tool of tools) {
    const seg = tool.segmentIndex ?? 0;
    const list = toolsBySegment.get(seg) ?? [];
    list.push(tool);
    toolsBySegment.set(seg, list);
  }
  const narrationBySegment = new Map<number, string>();
  for (const segment of narration) narrationBySegment.set(segment.index, segment.text);

  const segments = Array.from(
    new Set([...toolsBySegment.keys(), ...narrationBySegment.keys()]),
  ).toSorted((a, b) => a - b);
  const items: TrailItem[] = [];
  for (const seg of segments) {
    const text = narrationBySegment.get(seg);
    if (text && text.trim().length > 0) {
      items.push({ kind: "narration", key: `narration-${seg}`, text });
    }
    for (const tool of toolsBySegment.get(seg) ?? []) {
      const prev = items[items.length - 1];
      const head = prev?.kind === "tool" ? prev.tools[0] : undefined;
      if (
        prev?.kind === "tool" &&
        head &&
        head.toolName === tool.toolName &&
        head.status === tool.status &&
        // Never fold spawns together: each one owns a distinct sub-agent trail,
        // and a folded "2×" row could only ever host one of them.
        tool.toolName !== SPAWN_SUB_AGENT_TOOL
      ) {
        prev.tools.push(tool);
      } else {
        items.push({ kind: "tool", key: tool.toolCallId, tools: [tool] });
      }
    }
  }
  return items;
}
