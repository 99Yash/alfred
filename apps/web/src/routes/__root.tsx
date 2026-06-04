import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppShell } from "~/lib/app-shell";
import { siteMeta } from "~/lib/page-meta";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: siteMeta,
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <HeadContent />
      <AppShell>
        <Outlet />
      </AppShell>
    </div>
  );
}
