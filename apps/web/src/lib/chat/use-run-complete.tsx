import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import {
  getLocalStorageItem,
  type LocalStorageValue,
  setLocalStorageItem,
} from "~/lib/storage/storage";
import { toast } from "~/lib/toast";
import type { StreamingMessage } from "./use-chat-stream";

/** When the completion chime plays. Defaults to unfocused-only so it acts as a notification, not a per-reply ping. */
export type ChatSoundPreference = LocalStorageValue<"alfred.chat.soundPreference">;

const PREF_KEY = "alfred.chat.soundPreference";
const ONBOARDED_KEY = "alfred.chat.notifyOnboarded";
const SFX_SRC = "/sounds/run-finished.mp3";

/**
 * Fired by the finish toast's "Open" action so the live conversation can jump
 * back to the bottom. A decoupled window event keeps the hook from having to
 * thread a scroll ref up out of `Conversation` (which listens for it).
 */
export const SCROLL_CHAT_TO_BOTTOM_EVENT = "alfred:scroll-chat-to-bottom";

/** Longest reply preview we'll show in the toast before eliding. */
const SNIPPET_MAX = 140;

/**
 * Distil the streamed reply into a one-line preview: collapse whitespace, trim,
 * and elide on a word boundary. Returns `null` when the turn closed with no
 * text (tool-only / artifact-only), so the caller can fall back to a subtitle.
 */
function replySnippet(text: string | undefined): string | null {
  const collapsed = text?.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= SNIPPET_MAX) return collapsed;
  const clipped = collapsed.slice(0, SNIPPET_MAX);
  const lastSpace = clipped.lastIndexOf(" ");
  // Prefer a word boundary, but don't claw back more than ~a quarter of the line.
  const cut = lastSpace > SNIPPET_MAX * 0.75 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}

function getChatSoundPreference(): ChatSoundPreference {
  return getLocalStorageItem(PREF_KEY);
}

/**
 * Fire a completion chime + (when the tab is backgrounded) a frosted card the
 * moment a streamed turn finishes — title, a preview of the reply, and an
 * "Open" action that brings the thread back to the live edge. Ported and grown
 * from dimension's run-complete SFX.
 *
 * The very first finished turn instead shows a one-time card pointing at
 * Settings, so the user learns the chime exists and can tune when it plays.
 *
 * Guards on `messageId` so it fires exactly once per turn, and respects the
 * user's sound preference. Mount once where the active stream lives.
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
      // Create inline so the element's lifecycle doesn't outlive the play.
      const audio = new Audio(SFX_SRC);
      audio.volume = 0.4;
      void audio.play().catch(() => {
        /* autoplay may be blocked until first interaction — ignore */
      });
    }

    // First finished turn ever: teach the chime + point at the control. Shown
    // regardless of focus (it's informational), and it stands in for the normal
    // finish card so the user isn't double-toasted on their first reply.
    if (!getLocalStorageItem(ONBOARDED_KEY)) {
      setLocalStorageItem(ONBOARDED_KEY, true);
      toast.custom({
        message: "Alfred can notify you when a reply lands",
        description: "A chime + toast when a turn finishes while you're away. Tune it in Settings.",
        icon: <span className="text-[15px] leading-none">✨</span>,
        position: "bottom-right",
        duration: 8000,
        action: { label: "Settings", onClick: () => void navigate({ to: "/settings" }) },
      });
      return;
    }

    // Steady state: only nudge with the card when the user is away — no noise
    // while they watch the reply stream in.
    if (focused) return;
    const snippet = replySnippet(stream.text);
    toast.custom({
      message: "Alfred finished replying",
      // Render the preview as markdown so emphasis/code/links land formatted
      // rather than leaking raw `**`, backticks, etc. The snippet is already a
      // single collapsed line, so compact block rhythm reads as one tidy row.
      description: snippet ? (
        <MarkdownRenderer size="compact" className="[&_p]:my-0">
          {snippet}
        </MarkdownRenderer>
      ) : (
        "Your turn is ready."
      ),
      icon: <span className="text-[15px] leading-none">✨</span>,
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
