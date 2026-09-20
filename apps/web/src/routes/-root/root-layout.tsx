import { HeadContent, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";
import {
  continueAfterAuthorization,
  isAuthorizationReturnTab,
} from "~/lib/integrations/authorization-tab";
import { AppShell } from "~/lib/shell/app-shell";

export function RootLayout() {
  if (isAuthorizationReturnTab()) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#101216] px-6 text-white">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-medium">Return to Alfred</h1>
          <p className="mt-4 text-sm leading-6 text-white/70">
            Authorization has returned to Alfred. You can close this tab and check the connection in
            your original tab.
          </p>
          <button
            className="mt-8 rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-[#101216]"
            onClick={continueAfterAuthorization}
            type="button"
          >
            Continue in this tab
          </button>
        </div>
      </main>
    );
  }

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
