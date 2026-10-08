import type { AgentTranscriptMessage } from "@alfred/contracts";

/**
 * Marks a runtime note to the model. It is a user-role message because the transcript must end
 * in a user turn and there is no tool call to answer. The user never sees it.
 */
const SYSTEM_NOTE_PREFIX = "[system] ";

function isSystemNote(
  message: AgentTranscriptMessage | undefined,
): message is AgentTranscriptMessage & { content: string } {
  return (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(SYSTEM_NOTE_PREFIX)
  );
}

/**
 * Join a runtime note at the tail instead of adding a second user turn; providers treat two
 * differently.
 * A real user message is never merged into.
 */
export function appendSystemNote(
  transcript: readonly AgentTranscriptMessage[],
  text: string,
): AgentTranscriptMessage[] {
  const last = transcript.at(-1);

  if (last && isSystemNote(last)) {
    return [
      ...transcript.slice(0, -1),
      { ...last, content: `${last.content}\n\n${SYSTEM_NOTE_PREFIX}${text}` },
    ];
  }

  return [...transcript, { role: "user", content: `${SYSTEM_NOTE_PREFIX}${text}` }];
}
