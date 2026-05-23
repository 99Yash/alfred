import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChatContext } from "~/components/preview/chat-context";
import { PreviewSidebar } from "~/components/preview/preview-sidebar";
import { SearchPalette } from "~/components/preview/search-palette";
import { VsThemed, VsThemeProvider } from "~/components/ui/visitors";

/**
 * Shared layout for all `/preview/*` in-app surfaces.
 *
 * Previously each preview page owned its own sidebar (chat) or none at all
 * (integrations / workflows / settings) — meaning the user lost navigation
 * context every time they jumped between surfaces. This layout fixes that:
 * a single sidebar is mounted once, all children render into an Outlet
 * alongside it, and the cmd-K palette is registered globally.
 *
 * Sits at `/preview` (TanStack flat-route convention: `preview.tsx` is the
 * parent of `preview.chat.tsx`, etc). Bare `/preview` redirects to
 * `/preview/chat`.
 *
 * Right rail (today panel) stays inside `preview.chat.tsx` — only chat
 * needs it.
 */
export const Route = createFileRoute("/preview")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/preview" || location.pathname === "/preview/") {
      throw redirect({ to: "/preview/chat" });
    }
  },
  component: PreviewLayout,
});

function PreviewLayout() {
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

  return (
    <ChatContext.Provider value={{ activeThread, setActiveThread }}>
      <VsThemeProvider>
        <VsThemed className="min-h-dvh bg-vs-background-subtle">
          <div className="relative flex h-dvh w-full gap-1.5 overflow-hidden p-1.5">
            <PreviewSidebar
              onOpenSearch={() => setPaletteOpen(true)}
              activeThread={activeThread}
            />
            <Outlet />
          </div>

          <SearchPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </VsThemed>
      </VsThemeProvider>
    </ChatContext.Provider>
  );
}
