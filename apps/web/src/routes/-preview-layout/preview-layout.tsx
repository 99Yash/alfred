import { Outlet } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "~/components/app-sidebar";
import { ChatContext } from "~/components/chat-context";
import {
  PREVIEW_APPROVALS_BADGE,
  PREVIEW_CHAT_THREADS,
  PREVIEW_RECENT_THREADS,
} from "~/components/preview-fixtures";
import { SearchPalette } from "~/components/search-palette";
import { VsThemed, VsThemeProvider } from "~/components/ui/visitors";

export function PreviewLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeThread, setActiveThread] = useState<string>("morning-brief");

  // Cmd/Ctrl-K toggles the palette from anywhere inside /preview/*. Bound on
  // window so it works even when focus is in the composer or sidebar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const chatContextValue = useMemo(() => ({ activeThread, setActiveThread }), [activeThread]);

  return (
    <ChatContext.Provider value={chatContextValue}>
      <VsThemeProvider>
        <VsThemed className="min-h-dvh bg-vs-background-subtle">
          <div className="relative flex h-dvh w-full gap-1.5 overflow-hidden p-1.5">
            <AppSidebar
              onOpenSearch={() => setPaletteOpen(true)}
              activeThread={activeThread}
              threads={PREVIEW_CHAT_THREADS}
              approvalsBadge={PREVIEW_APPROVALS_BADGE}
            />
            <Outlet />
          </div>

          {paletteOpen ? (
            <SearchPalette
              onClose={() => setPaletteOpen(false)}
              recentThreads={PREVIEW_RECENT_THREADS}
            />
          ) : null}
        </VsThemed>
      </VsThemeProvider>
    </ChatContext.Provider>
  );
}
