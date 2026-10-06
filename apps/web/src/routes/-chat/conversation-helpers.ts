import { githubSearchResultSchema, gmailSearchResultSchema } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";
import type { StreamingMessage } from "~/lib/chat/chat-stream-state";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";
import { presentTool } from "./tool-call-presentation";

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
 * Whether the live bubble should draw the bare "thinking" spinner: the turn is
 * still running and has produced nothing visible yet. Every other in-flow
 * indicator (reasoning accordion, tool trail, "Condensing conversation…") is a
 * better answer to "what is happening", so any of them present wins.
 *
 * `done` is the clause that is easy to lose. `shouldShowStream` keeps the live
 * bubble mounted until the durable row syncs in, so a turn stopped before its
 * first delta sits at `done` with no text and no tools for that whole window —
 * without this clause it spins on a finished turn.
 *
 * Deliberately blind to `narration`: closed prose is not live activity, so a
 * running turn whose cards all retracted keeps its honest spinner *under* the
 * narration rows.
 */
export function shouldShowThinkingIndicator(stream: StreamingMessage): boolean {
  return (
    !stream.done &&
    stream.text.length === 0 &&
    stream.tools.length === 0 &&
    stream.reasoning.length === 0 &&
    !stream.reasoningActive &&
    !stream.compacting &&
    !stream.awaitingCapacity
  );
}

/**
 * A short present-tense label for what the turn is doing *right now* — the copy
 * for the floating activity pill (shown when the user has scrolled up off the
 * live edge mid-turn). Mirrors the in-flow indicators: the running tool's own
 * verb when a tool is in flight, otherwise the reasoning / writing / condensing
 * state. Precedence follows what's most immediate: a tool actively running wins
 * over "writing", which wins over "thinking".
 */
export function describeActivity(stream: StreamingMessage): string {
  if (stream.compacting) return "Condensing conversation…";

  if (stream.awaitingCapacity) return "Waiting for model capacity…";
  const lastTool = stream.tools[stream.tools.length - 1];

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
  // `resultPreview` is now pruned server-side into valid JSON (chat-turn's
  // `preview()`), so strict parsing succeeds for fresh rows. The prefix-scan
  // fallback below stays for historical rows persisted before that fix.
  const raw = tool.resultPreview ?? "";
  const result = parseJsonRecord(raw);

  if (tool.toolName === "github.search") {
    // `resultPreview` is pruned server-side into valid JSON (chat-turn's
    // `preview()`), so the result schema parses fresh rows. A preview that no
    // longer parses (a historical row from before the prune fix) yields no
    // suggestion rather than a regex-mined guess.
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
    // The schema pins the current shape (`query` echo included); the array
    // fallback keeps historical rows whose preview predates the echo.
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
