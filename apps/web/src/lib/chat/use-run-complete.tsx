import { collapseWhitespace } from "@alfred/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import {
  getLocalStorageItem,
  type LocalStorageValue,
  setLocalStorageItem,
} from "~/lib/storage/storage";
import { toast } from "~/lib/toast";
import type { StreamingMessage } from "./chat-stream-state";

/** When the completion chime plays. */
export type ChatSoundPreference = LocalStorageValue<"alfred.chat.soundPreference">;

const PREF_KEY = "alfred.chat.soundPreference";

const ONBOARDED_KEY = "alfred.chat.notifyOnboarded";

const SFX_SRC = "/sounds/run-finished.mp3";

/** The toast's "Open" action fires this; `Conversation` scrolls to the bottom. */
export const SCROLL_CHAT_TO_BOTTOM_EVENT = "alfred:scroll-chat-to-bottom";

const SNIPPET_MAX = 140;

const ALFRED_TOAST_ICON = (
  <img src="/images/logo/alfred-logo.svg" alt="" className="size-4.5 rounded-[5px]" />
);

/** A one-line preview cut at a word. `null` for a turn with no text. */
function replySnippet(text: string | undefined): string | null {
  const collapsed = collapseWhitespace(text ?? "");

  if (!collapsed) return null;

  if (collapsed.length <= SNIPPET_MAX) return collapsed;
  const clipped = collapsed.slice(0, SNIPPET_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  // Cut at a word only if that keeps at least 75% of the line.
  const cut = lastSpace > SNIPPET_MAX * 0.75 ? clipped.slice(0, lastSpace) : clipped;

  return `${cut.trimEnd()}…`;
}

function getChatSoundPreference(): ChatSoundPreference {
  return getLocalStorageItem(PREF_KEY);
}

/**
 * When a turn finishes, play the chime and, if the tab is in the background, toast a preview.
 * The first finished turn ever shows a Settings hint instead. Fires once per `messageId`.
 */
export function useRunComplete(stream: StreamingMessage | null): void {
  const firedRef = useRef<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!stream?.done) return;

    if (firedRef.current === stream.messageId) return;
    firedRef.current = stream.messageId;

    const focused = typeof document !== "undefined" && document.hasFocus();
    const pref = getChatSoundPreference();

    if (pref === "always" || (pref === "unfocused" && !focused)) {
      const audio = new Audio(SFX_SRC);
      audio.volume = 0.4;
      void audio.play().catch(() => {
        /* Autoplay can be blocked before the first interaction. */
      });
    }

    // Replaces the normal card, so the first reply does not get two toasts.
    if (!getLocalStorageItem(ONBOARDED_KEY)) {
      setLocalStorageItem(ONBOARDED_KEY, true);
      toast.custom({
        message: "Alfred can notify you when a reply lands",
        description: "A chime + toast when a turn finishes while you're away. Tune it in Settings.",
        icon: ALFRED_TOAST_ICON,
        position: "bottom-right",
        duration: 8000,
        action: { label: "Settings", onClick: () => void navigate({ to: "/settings" }) },
      });

      return;
    }

    if (focused) return;
    const snippet = replySnippet(stream.text);
    toast.custom({
      message: "Alfred finished replying",
      // Markdown, so raw `**` and backticks do not show.
      description: snippet ? (
        <MarkdownRenderer size="compact" className="[&_p]:my-0">
          {snippet}
        </MarkdownRenderer>
      ) : (
        "Your turn is ready."
      ),
      icon: ALFRED_TOAST_ICON,
      position: "bottom-right",
      duration: 6000,
      action: {
        label: "Open",
        onClick: () => {
          window.focus();
          window.dispatchEvent(new CustomEvent(SCROLL_CHAT_TO_BOTTOM_EVENT));
        },
      },
    });
  }, [stream?.done, stream?.messageId, stream?.text, navigate]);
}
