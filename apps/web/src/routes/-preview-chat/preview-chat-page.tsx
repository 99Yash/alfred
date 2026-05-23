import { useEffect, useRef, useState } from "react";
import { useChatContext } from "~/components/preview/chat-context";
import { ComposerDock } from "./composer-dock";
import { ConversationPlaceholder } from "./conversation-placeholder";
import { ConversationScroll } from "./conversation-scroll";
import { findThread, useRailMode } from "./helpers";
import { RightRail } from "./right-rail";
import { ThreadTopBar } from "./thread-top-bar";

export function PreviewChatPage() {
  const { activeThread } = useChatContext();
  const [composer, setComposer] = useState("");
  const railMode = useRailMode();
  const [railOpen, setRailOpen] = useState(() => railMode === "inline");

  // When the viewport crosses the rail breakpoint, snap the rail to that
  // mode's sensible default: wide screens show it, narrow screens hide it.
  const prevModeRef = useRef(railMode);
  if (prevModeRef.current !== railMode) {
    prevModeRef.current = railMode;
    setRailOpen(railMode === "inline");
  }

  // ESC closes the overlay rail.
  useEffect(() => {
    if (railMode !== "overlay" || !railOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [railMode, railOpen]);

  const activeEntry = findThread(activeThread);

  // Sidebar + theme provider are owned by `preview.tsx`. This route only
  // contributes the main column + right rail, rendered as siblings of the
  // sidebar inside the layout's outer flex container.
  return (
    <>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ThreadTopBar
          title={activeEntry?.title ?? "New chat"}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
        />

        <ConversationScroll>
          <ConversationPlaceholder entry={activeEntry} />
        </ConversationScroll>

        <ComposerDock value={composer} onChange={setComposer} />
      </div>

      <RightRail open={railOpen} mode={railMode} onClose={() => setRailOpen(false)} />
    </>
  );
}
