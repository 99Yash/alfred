import { useEffect, useMemo, useState } from "react";
import { useChatContext } from "~/components/chat-context";
import { useRightRail, useShellThreadViewModel } from "~/lib/shell/app-shell";
import type { RailData } from "~/routes/-chat/rail/rail-data";
import { RightRail } from "~/routes/-chat/rail/right-rail";
import { useRailMode } from "~/routes/-chat/rail/use-rail-mode";
import { ComposerDock } from "./composer-dock";
import { ConversationPlaceholder } from "./conversation-placeholder";
import { ConversationScroll } from "./conversation-scroll";
import { findThread, INBOX, MEETINGS, TODOS } from "./helpers";
import { ThreadTopBar } from "./thread-top-bar";
import { PREVIEW_SHELL_THREADS } from "./preview-fixtures";

/* Demo rail data. The real `/chat` passes `EMPTY_RAIL_DATA`. */
const PREVIEW_RAIL_DATA: RailData = {
  todos: TODOS,
  todoSuggestions: [
    { label: "Draft reply to Sycamore", detail: "Pull last 3 sends · summarize asks" },
    { label: "Tag newsletters as Later", detail: "12 threads from this morning" },
  ],
  inbox: INBOX,
  meetings: MEETINGS,
  meetingLookahead: [
    { label: "Mon · Board prep with Priya", detail: "09:30 · 60m" },
    { label: "Tue · Vendor demo", detail: "14:00 · 45m" },
  ],
  latestBriefing: {
    id: "brf_preview",
    slot: "morning",
    briefingDate: new Date().toISOString().slice(0, 10),
    runAt: new Date().toISOString(),
    subject: "Morning briefing — Friday",
  },
};

export function PreviewChatPage() {
  useShellThreadViewModel(PREVIEW_SHELL_THREADS);
  const { activeThread } = useChatContext();
  const [composer, setComposer] = useState("");
  const railMode = useRailMode();
  const [railOpen, setRailOpen] = useState(() => railMode === "inline");

  // On a breakpoint change, reset the rail: shown when wide, hidden when narrow.
  const [prevMode, setPrevMode] = useState(railMode);

  if (prevMode !== railMode) {
    setPrevMode(railMode);
    setRailOpen(railMode === "inline");
  }

  useEffect(() => {
    if (railMode !== "overlay" || !railOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };

    window.addEventListener("keydown", handler);

    return () => window.removeEventListener("keydown", handler);
  }, [railMode, railOpen]);

  const activeEntry = findThread(activeThread);

  // Register the rail with AppShell, as `/chat` does. Memoized so the effect does not refire.
  const railNode = useMemo(
    () => (
      <RightRail
        open={railOpen}
        mode={railMode}
        onClose={() => setRailOpen(false)}
        data={PREVIEW_RAIL_DATA}
      />
    ),
    [railOpen, railMode],
  );

  useRightRail(railNode);

  return (
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
  );
}
