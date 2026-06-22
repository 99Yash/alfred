import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppThemed, AppThemeProvider, AppThemeToggle } from "~/components/ui/v2";
import { authClient } from "~/lib/auth/auth-client";
import { readAuthHint } from "~/lib/auth/auth-hint";
import { AuthPanel } from "./auth-panel";
import { ShowcasePanel } from "./showcase-panel";

export function LoginPage() {
  const { redirect } = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const isAuthed = !!session?.user;

  // Already signed in: bounce to the path they were headed for, or `/chat`.
  useEffect(() => {
    if (isAuthed) void navigate({ to: redirect ?? "/chat", replace: true });
  }, [isAuthed, redirect, navigate]);

  // Confirmed authed -> redirect is in flight, render nothing.
  if (isAuthed) return null;
  // Session not yet resolved: defer to the synchronous hint to avoid flashing
  // the sign-in screen at a returning signed-in user before redirect fires.
  if (isPending && readAuthHint()) return null;

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
