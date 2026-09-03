import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getIntegrationPage } from "~/lib/integrations/integrations";
import type { MentionConnectionLookup } from "../mention-connection";
import { filterMentionOptions, type MentionOption } from "../mention-options";
import type { SuggestionRenderState } from "../tiptap-composer";

interface MentionController {
  suggestion: SuggestionRenderState | null;
  setSuggestion: (state: SuggestionRenderState | null) => void;
  mentionCandidates: ReadonlyArray<MentionOption>;
  visibleMentionIdx: number;
  setMentionIdx: (idx: number) => void;
  /** Commit a picked row — inserts a chip, or opens the connect prompt for
   * an unconnected-but-connectable integration instead of a dead chip. */
  pickMention: (option: MentionOption) => void;
  /** The unconnected integration awaiting its connect CTA, if any. */
  connectPrompt: MentionOption | null;
  /** Commit the open prompt's primary action: dismiss the palette and hand
   * off to the provider's connect flow. Shared by the panel button (pointer)
   * and Enter (keyboard) so both paths stay one implementation. */
  connectFromPrompt: () => void;
  backFromConnect: () => void;
  suggestionKeyDownRef: MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
}

export function useMentionController(connections: MentionConnectionLookup): MentionController {
  // Suggestion bridge: Tiptap's mention plugin pushes lifecycle into here;
  // the palette UI reads from it.
  const [suggestion, setSuggestion] = useState<SuggestionRenderState | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Drill-in state for "connect this integration first". Kept here rather
  // than in the palette so it survives palette re-renders driven by keystrokes.
  const [connectPrompt, setConnectPrompt] = useState<MentionOption | null>(null);
  const mentionCandidates = useMemo(
    () => (suggestion ? filterMentionOptions(suggestion.query) : []),
    [suggestion],
  );

  // Reset the active index and any drill-in when a new suggestion opens or
  // the query changes. The previous-value-during-render pattern keeps this
  // synchronous and out of an effect. `prevQuery` is only used to gate the
  // reset, never read in JSX, so a ref avoids a parallel state cell and the
  // extra render it'd cost.
  const currentQuery = suggestion?.query ?? null;
  const [prevQuery, setPrevQuery] = useState<string | null>(currentQuery);
  if (prevQuery !== currentQuery) {
    setPrevQuery(currentQuery);
    setMentionIdx(0);
    setConnectPrompt(null);
  }
  // The popup closing must also tear down the drill-in, or the next `@`
  // would reopen straight into a stale connect panel.
  if (suggestion === null && connectPrompt !== null) {
    setConnectPrompt(null);
  }

  // Clamp the active row at render time. If filtering shrunk the list since
  // the last keystroke, the displayed highlight lands on the last valid row
  // without an effect that loops state back through React.
  const visibleMentionIdx =
    mentionCandidates.length === 0 ? 0 : Math.min(mentionIdx, mentionCandidates.length - 1);

  const pickMention = useCallback(
    (option: MentionOption) => {
      // Unconnected-but-connectable: offer the fix, don't insert a chip the
      // dispatch floor would only refuse. Everything else inserts as before.
      if (connections(option.value) === "connectable") {
        setConnectPrompt(option);
        return;
      }
      suggestion?.command(option);
    },
    [connections, suggestion],
  );

  const navigate = useNavigate();
  const connectFromPrompt = useCallback(() => {
    if (!connectPrompt) return;
    const page = getIntegrationPage(connectPrompt.value);
    setConnectPrompt(null);
    suggestion?.dismiss();
    if (page) {
      void navigate({ to: "/integrations/$slug", params: { slug: page.slug } });
    }
  }, [connectPrompt, suggestion, navigate]);

  const backFromConnect = useCallback(() => setConnectPrompt(null), []);

  // Bridge keyboard nav into the Tiptap suggestion plugin. Returning `true`
  // tells Tiptap to swallow the key so it doesn't also reach the editor.
  const suggestionKeyDownRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  // Mirror the handler into the ref in an effect, not during render: a
  // render-phase ref write can leak if React discards the render, and Tiptap
  // only invokes this on a keydown (post-commit), so the timing is equivalent.
  useEffect(() => {
    suggestionKeyDownRef.current = (event) => {
      if (!suggestion || mentionCandidates.length === 0) return false;
      // While the connect drill-in is up, list nav keys have nothing to move
      // to. Enter commits the panel's primary action — without this a
      // keyboard user could read "Connect Gmail" but never activate it, since
      // Tab is held and focus stays in the editor. Arrows/Tab are held so
      // they can't navigate or submit through the overlay; Escape dismisses;
      // typing (or Backspace) edits the query and drops the user back onto
      // the filtered list via the query-change reset above.
      if (connectPrompt) {
        if (event.key === "Enter") {
          event.preventDefault();
          connectFromPrompt();
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          suggestion.dismiss();
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab") {
          event.preventDefault();
          return true;
        }
        return false;
      }
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
          pickMention(pick);
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
  }, [
    suggestion,
    mentionCandidates,
    visibleMentionIdx,
    setMentionIdx,
    connectPrompt,
    pickMention,
    connectFromPrompt,
  ]);

  return {
    suggestion,
    setSuggestion,
    mentionCandidates,
    visibleMentionIdx,
    setMentionIdx,
    pickMention,
    connectPrompt,
    connectFromPrompt,
    backFromConnect,
    suggestionKeyDownRef,
  };
}
