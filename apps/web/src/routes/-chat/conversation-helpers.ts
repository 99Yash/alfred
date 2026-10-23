import { githubSearchResultSchema, gmailSearchResultSchema } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import type { StreamingMessage } from "~/lib/chat/chat-stream-state";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";
import { presentTool, visibleTools } from "./tool-call-presentation";

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

/**
 * Show the bare spinner while running with nothing visible yet, or while a hidden call runs.
 * Check `done`: the live bubble stays mounted until sync, so a turn stopped early would spin when finished.
 * Ignores `narration`: closed prose is not live activity.
 */
export function shouldShowThinkingIndicator(stream: StreamingMessage): boolean {
  if (stream.done || stream.text.length > 0 || stream.compacting || stream.awaitingCapacity) {
    return false;
  }

  // No row draws a hidden call, so the spinner is the only sign of it.
  const last = stream.tools.at(-1);

  if (last?.status === "started" && visibleTools([last]).length === 0) return true;

  return (
    visibleTools(stream.tools).length === 0 &&
    stream.reasoning.length === 0 &&
    !stream.reasoningActive
  );
}

/** Label for the floating activity pill: the running tool's verb, else writing, else thinking. */
export function describeActivity(stream: StreamingMessage): string {
  if (stream.compacting) return "Condensing conversation…";

  if (stream.awaitingCapacity) return "Waiting for model capacity…";
  // A hidden running step falls through to the writing/thinking label.
  const lastTool = visibleTools(stream.tools).at(-1);

  if (lastTool && lastTool.status === "started") return `${presentTool(lastTool).running}…`;

  if (stream.text.length > 0) return "Responding…";

  if (stream.reasoningActive) return "Thinking…";

  return "Working…";
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

  return out.slice(0, 5);
}

function followUpForTool(tool: PersistedToolCall): FollowUpSuggestion | null {
  if (tool.status !== "succeeded") return null;
  // Fresh previews are valid JSON (`preview()`); the prefix scan is for old rows.
  const raw = tool.resultPreview ?? "";
  const result = parseJsonRecord(raw);

  if (tool.toolName === "github.search") {
    // Old rows that do not parse give no suggestion, not a regex guess.
    const parsed = githubSearchResultSchema.safeParse(result);

    if (!parsed.success) return null;

    if (parsed.data.totalCount <= 0 || parsed.data.items.length === 0) return null;

    return { id: "github-pr-list", text: "Show me the matching results.", brand: "github" };
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

  if (tool.toolName === "gmail.search") {
    // The array fallback is for old rows that predate the `query` echo.
    const parsed = gmailSearchResultSchema.safeParse(result);
    const fallback = result && Array.isArray(result.messages) ? result.messages : [];
    const messages = parsed.success ? parsed.data.messages : fallback;

    if (messages.length === 0) return null;

    return { id: "gmail-draft-reply", text: "Draft a reply to one of these.", brand: "gmail" };
  }

  if (tool.toolName === "system.web_search") {
    return { id: "web-go-deeper", text: "Go deeper on this.", brand: "web" };
  }

  return null;
}
