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
  /** Insert a chip, or open the connect prompt for an unconnected integration. */
  pickMention: (option: MentionOption) => void;
  connectPrompt: MentionOption | null;
  /** Dismiss and start the connect flow. Shared by the button and Enter. */
  connectFromPrompt: () => void;
  backFromConnect: () => void;
  suggestionKeyDownRef: MutableRefObject<((event: KeyboardEvent) => boolean) | null>;
}

export function useMentionController(connections: MentionConnectionLookup): MentionController {
  // Tiptap's mention plugin pushes its lifecycle here; the palette reads it.
  const [suggestion, setSuggestion] = useState<SuggestionRenderState | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Here, not in the palette, so it survives keystroke re-renders.
  const [connectPrompt, setConnectPrompt] = useState<MentionOption | null>(null);

  const mentionCandidates = useMemo(
    () => (suggestion ? filterMentionOptions(suggestion.query) : []),
    [suggestion],
  );

  // Reset the index and prompt when the query changes, during render. A ref, as JSX never reads `prevQuery`.
  const currentQuery = suggestion?.query ?? null;
  const [prevQuery, setPrevQuery] = useState<string | null>(currentQuery);

  if (prevQuery !== currentQuery) {
    setPrevQuery(currentQuery);
    setMentionIdx(0);
    setConnectPrompt(null);
  }

  // Clear the prompt on close, or the next `@` opens a stale panel.
  if (suggestion === null && connectPrompt !== null) {
    setConnectPrompt(null);
  }

  // Clamp during render when filtering shrinks the list.
  const visibleMentionIdx =
    mentionCandidates.length === 0 ? 0 : Math.min(mentionIdx, mentionCandidates.length - 1);

  const pickMention = useCallback(
    (option: MentionOption) => {
      // Offer the connect fix; the dispatch floor would refuse a chip.
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

  // Return `true` to make Tiptap swallow the key.
  const suggestionKeyDownRef = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  // Synced in an effect: a render-phase ref write can leak from a discarded render.
  useEffect(() => {
    suggestionKeyDownRef.current = (event) => {
      if (!suggestion || mentionCandidates.length === 0) return false;

      // Prompt open: Enter connects (focus stays in the editor, so this is the keyboard path).
      // Arrows and Tab are held; Escape dismisses; typing returns to the list.
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
