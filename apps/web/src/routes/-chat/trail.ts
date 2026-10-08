import { isQuestionApproval, SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";
import type { SyncedChatNarration } from "@alfred/sync";
import type { ToolCallView } from "./tool-call-presentation";

export type TrailItem =
  | { kind: "narration"; key: string; text: string }
  // One row per run of identical calls, with a `2×` badge. Grouped on (toolName, `foldClass`),
  // so a failure never hides in a success's count. An in-flight call joins its run.
  | { kind: "tool"; key: string; tools: ToolCallView[] };

/**
 * `started` and `succeeded` share `ok`, so a streaming call ticks the run's count in place.
 * `failed` is its own class. `ToolCallCard` reads failure with `some`, so a mixed row still shows it.
 */
export function foldClass(status: ToolCallView["status"]): "failed" | "ok" {
  return status === "failed" ? "failed" : "ok";
}

/**
 * Order narration and tool calls by `segmentIndex`: each segment's narration, then its tools.
 * Identical consecutive calls fold into one row.
 * This is the trail's whole emptiness rule. Narration and cards are independent, so neither may gate the other.
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
        foldClass(head.status) === foldClass(tool.status) &&
        // Never fold spawns or questions (ADR-0099): each owns its own trail or answers.
        tool.toolName !== SPAWN_SUB_AGENT_TOOL &&
        !isQuestionApproval(tool.toolName)
      ) {
        prev.tools.push(tool);
      } else {
        items.push({ kind: "tool", key: tool.toolCallId, tools: [tool] });
      }
    }
  }

  return items;
}
