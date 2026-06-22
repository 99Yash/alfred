import { HeadContent, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { AppShell } from "~/lib/shell/app-shell";

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
