import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { filterMentionOptions, type MentionOption } from "../mention-options";
import type { SuggestionRenderState } from "../tiptap-composer";

export function useMentionController(): {
  suggestion: SuggestionRenderState | null;
  setSuggestion: (state: SuggestionRenderState | null) => void;
  mentionCandidates: ReadonlyArray<MentionOption>;
  visibleMentionIdx: number;
  setMentionIdx: (idx: number) => void;
  insertMention: (option: MentionOption) => void;
  suggestionKeyDownRef: MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
} {
  // Suggestion bridge: Tiptap's mention plugin pushes lifecycle into here;
  // the palette UI reads from it.
  const [suggestion, setSuggestion] = useState<SuggestionRenderState | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionCandidates = useMemo(
    () => (suggestion ? filterMentionOptions(suggestion.query) : []),
    [suggestion],
  );

  // Reset the active index when a new suggestion opens or the query changes.
  // The previous-value-during-render pattern keeps this synchronous and out
  // of an effect. `prevQuery` is only used to gate the reset, never read in
  // JSX, so a ref avoids a parallel state cell and the extra render it'd cost.
  const currentQuery = suggestion?.query ?? null;
  const prevQueryRef = useRef<string | null>(currentQuery);
  if (prevQueryRef.current !== currentQuery) {
    prevQueryRef.current = currentQuery;
    setMentionIdx(0);
  }

  // Clamp the active row at render time. If filtering shrunk the list since
  // the last keystroke, the displayed highlight lands on the last valid row
  // without an effect that loops state back through React.
  const visibleMentionIdx =
    mentionCandidates.length === 0 ? 0 : Math.min(mentionIdx, mentionCandidates.length - 1);

  const insertMention = useCallback(
    (option: MentionOption) => {
      suggestion?.command(option);
    },
    [suggestion],
  );

  // Bridge keyboard nav into the Tiptap suggestion plugin. Returning `true`
  // tells Tiptap to swallow the key so it doesn't also reach the editor.
  const suggestionKeyDownRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  suggestionKeyDownRef.current = (event) => {
    if (!suggestion || mentionCandidates.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIdx(Math.min(mentionCandidates.length - 1, visibleMentionIdx + 1));
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIdx(Math.max(0, visibleMentionIdx - 1));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const pick = mentionCandidates[visibleMentionIdx];
      if (pick) {
        event.preventDefault();
        suggestion.command(pick);
        return true;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      suggestion.dismiss();
      return true;
    }
    return false;
  };

  return {
    suggestion,
    setSuggestion,
    mentionCandidates,
    visibleMentionIdx,
    setMentionIdx,
    insertMention,
    suggestionKeyDownRef,
  };
}
