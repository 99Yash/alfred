import { Sparkles } from "lucide-react";
import { createElement, useEffect, useRef } from "react";
import { callToast } from "~/lib/toast";
import type { StreamingMessage } from "./use-chat-stream";

/** When the completion chime plays. Defaults to unfocused-only so it acts as a notification, not a per-reply ping. */
export type ChatSoundPreference = "always" | "unfocused" | "mute";

const PREF_KEY = "alfred.chat.soundPreference";
const SFX_SRC = "/sounds/run-finished.mp3";

export function getChatSoundPreference(): ChatSoundPreference {
  if (typeof localStorage === "undefined") return "unfocused";
  const v = localStorage.getItem(PREF_KEY);
  return v === "always" || v === "mute" || v === "unfocused" ? v : "unfocused";
}

export function setChatSoundPreference(pref: ChatSoundPreference): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(PREF_KEY, pref);
}

/**
 * Fire a completion chime + (when the tab is backgrounded) a frosted toast the
 * moment a streamed turn finishes. Ported from dimension's run-complete SFX.
 * Guards on `messageId` so it fires exactly once per turn, and respects the
 * user's sound preference. Mount once where the active stream lives.
 */
export function useRunComplete(stream: StreamingMessage | null): void {
  const firedRef = useRef<string | null>(null);

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
    // Only nudge with a toast when the user is away — no noise while they watch.
    if (!focused) {
      callToast({
        message: "Alfred finished replying",
        icon: createElement(Sparkles, { size: 14, className: "text-vs-purple-4" }),
      });
    }
  }, [stream?.done, stream?.messageId]);
}
