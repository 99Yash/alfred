import type { SyncedChatMessage } from "@alfred/sync";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import type { IntegrationBrand } from "~/lib/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";

export interface FollowUpSuggestion {
  id: string;
  text: string;
  brand: IntegrationBrand;
}

type PersistedToolCall = NonNullable<SyncedChatMessage["toolCalls"]>[number];

export function shouldShowStream(
  messages: readonly SyncedChatMessage[],
  stream: StreamingMessage | null,
): stream is StreamingMessage {
  return stream !== null && !messages.some((m) => m.id === stream.messageId);
}

export function buildFollowUpSuggestions(
  messages: readonly SyncedChatMessage[],
): FollowUpSuggestion[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "complete") return [];

  const tools = last.toolCalls ?? [];
  const out: FollowUpSuggestion[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const suggestion = followUpForTool(tool);
    if (!suggestion || seen.has(suggestion.text)) continue;
    out.push(suggestion);
    seen.add(suggestion.text);
  }
  return out.slice(0, 2);
}

function followUpForTool(tool: PersistedToolCall): FollowUpSuggestion | null {
  if (tool.status !== "succeeded") return null;
  // `resultPreview` is now pruned server-side into valid JSON (chat-turn's
  // `preview()`), so strict parsing succeeds for fresh rows. The prefix-scan
  // fallback below stays for historical rows persisted before that fix.
  const raw = tool.resultPreview ?? "";
  const result = parseJsonRecord(raw);

  if (tool.toolName === "github.search_pull_requests") {
    const totalCount =
      result && typeof result.totalCount === "number"
        ? result.totalCount
        : Number(/"totalCount"\s*:\s*(\d+)/.exec(raw)?.[1] ?? 0);
    const hasRows = result
      ? Array.isArray(result.pullRequests) && result.pullRequests.length > 0
      : /"pullRequests"\s*:\s*\[\s*\{/.test(raw);
    if (totalCount <= 0 || !hasRows) return null;
    return { id: "github-pr-list", text: "Show me the matching PRs.", brand: "github" };
  }

  if (tool.toolName === "calendar.list_events") {
    const hasEvents = result
      ? Array.isArray(result.events) && result.events.length > 0
      : /"events"\s*:\s*\[\s*\{/.test(raw);
    if (!hasEvents) return null;
    return {
      id: "calendar-meeting-prep",
      text: "What should I prep for my next meeting?",
      brand: "google_calendar",
    };
  }

  return null;
}
