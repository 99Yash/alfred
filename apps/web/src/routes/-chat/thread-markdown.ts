import { humanizeToolName } from "@alfred/contracts";
import type { SyncedChatMessage } from "@alfred/sync";

/**
 * Thread as Markdown for the clipboard. Reasoning is left out; tools become one italic line.
 * A local copy, not a publish, so no redaction rules apply.
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
