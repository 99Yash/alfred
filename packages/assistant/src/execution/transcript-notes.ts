import type { AgentTranscriptMessage } from "@alfred/contracts";

/**
 * Prefix of a runtime-authored transcript note. The chat runtime speaks to the
 * model through user-role messages that open with this marker (a finalize
 * guard's honesty note, a folded sub-agent result, the tool-loop landing note),
 * because a transcript must end in a user turn to be a legal prefill and there
 * is no tool-call id to attach a tool result to. The user never sees them; the
 * chat-turn persists only the model's reply.
 */
const SYSTEM_NOTE_PREFIX = "[system] ";

function isSystemNote(message: AgentTranscriptMessage | undefined): boolean {
  return (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(SYSTEM_NOTE_PREFIX)
  );
}

/**
 * `transcript` plus one runtime note. When the tail is already a runtime note,
 * the new text joins that message instead of following it, so the model never
 * sees two user turns in a row (providers differ on whether they merge those,
 * and the boss route can change). A real user message at the tail is never
 * merged into: the note stays a turn of its own after it.
 */
export function appendSystemNote(
  transcript: readonly AgentTranscriptMessage[],
  text: string,
): AgentTranscriptMessage[] {
  const last = transcript.at(-1);

  if (last && isSystemNote(last) && typeof last.content === "string") {
    return [
      ...transcript.slice(0, -1),
      { ...last, content: `${last.content}\n\n${SYSTEM_NOTE_PREFIX}${text}` },
    ];
  }

  return [...transcript, { role: "user", content: `${SYSTEM_NOTE_PREFIX}${text}` }];
}
