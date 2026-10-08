import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppThemed, AppThemeProvider, AppThemeToggle } from "~/components/ui/v2";
import { authClient } from "~/lib/auth/auth-client";
import { getLocalStorageItem, LOCAL_STORAGE_KEY } from "~/lib/storage/storage";
import { AuthPanel } from "./auth-panel";
import { ShowcasePanel } from "./showcase-panel";

export function LoginPage() {
  const { redirect } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const isAuthed = !!session?.user;

  // Signed in: go to the target path or `/chat`.
  useEffect(() => {
    if (isAuthed) void navigate({ to: redirect ?? "/chat", replace: true });
  }, [isAuthed, redirect, navigate]);

  // The redirect is in flight.
  if (isAuthed) return null;

  // Do not flash sign-in at a returning user before the redirect.
  if (isPending && getLocalStorageItem(LOCAL_STORAGE_KEY.MAYBE_AUTHED)) return null;

  return (
    <AppThemeProvider>
      <AppThemed className="relative min-h-dvh bg-app-background-subtle">
        <div className="absolute top-3 right-3 z-50">
          <AppThemeToggle />
        </div>
        <main className="grid min-h-dvh lg:grid-cols-2">
          <AuthPanel redirect={redirect} />
          <ShowcasePanel />
        </main>
      </AppThemed>
    </AppThemeProvider>
  );
}
