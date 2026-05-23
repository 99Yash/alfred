import { createFileRoute, redirect } from "@tanstack/react-router";
import { PreviewLayout } from "./-preview-layout/preview-layout";

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
