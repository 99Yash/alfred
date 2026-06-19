import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppShell } from "~/lib/shell/app-shell";
import { siteMeta } from "~/lib/page-meta";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: siteMeta,
  component: RootLayout,
});

export function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <HeadContent />
      <AppShell>
        <Outlet />
      </AppShell>
      <Toaster theme="dark" position="top-center" gap={10} />
    </div>
  );
}
