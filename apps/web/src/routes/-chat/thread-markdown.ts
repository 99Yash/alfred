import { humanizeToolName } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";

/**
 * Serialize a thread to Markdown for the clipboard.
 *
 * This is the "take it somewhere else" path — a note, a doc, an issue — so it
 * favours a transcript that reads well over one that round-trips. Reasoning is
 * omitted (it is long, and a pasted thread is normally wanted for its answers),
 * and the tool trail collapses to one italic line naming which tools ran, using
 * the shared `humanizeToolName` so the names match what the cards showed.
 *
 * Unlike a share link, this produces a local copy with no server involvement
 * and nothing published, so it carries no redaction rules of its own — the
 * user is pasting their own data into their own destination.
 */
export function threadToMarkdown(title: string, messages: readonly SyncedChatMessage[]): string {
  const parts: string[] = [`# ${title}`, ""];

  for (const message of messages) {
    if (message.role === "user") {
      parts.push("## You", "", message.content.trim() || "_(no text)_", "");
      continue;
    }

    parts.push("## Alfred", "");

    const toolNames = [...new Set((message.toolCalls ?? []).map((call) => call.toolName))];

    if (toolNames.length > 0) {
      parts.push(`_Used ${toolNames.map(humanizeToolName).join(", ")}._`, "");
    }

    if (message.status === "failed") parts.push("_This turn failed._", "");

    if (message.content.trim()) parts.push(message.content.trim(), "");
  }

  return parts.join("\n").trimEnd() + "\n";
}
