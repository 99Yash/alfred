import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { authClient } from "~/lib/auth/auth-client";
import { readAuthHint } from "~/lib/auth/auth-hint";
import { pageMeta } from "~/lib/page-meta";
import { AppThemed, AppThemeProvider, AppThemeToggle } from "~/components/ui/v2";
import { AuthPanel } from "./-login/auth-panel";
import { sanitizeRedirect, type LoginSearch } from "./-login/login-search";
import { ShowcasePanel } from "./-login/showcase-panel";

/**
 * Sign-in surface. Google is the only authentication method: the panel
 * fires `authClient.signIn.social({ provider: "google" })`, which redirects
 * to Google's consent screen and back to `/api/auth/callback/google`
 * (handled by Better Auth). The single-email allowlist still applies via
 * the `user.create.before` hook in `@alfred/auth`.
 *
 * `?redirect=` carries the path a signed-out visitor was bounced from (set by
 * `AppShell`'s auth guard) so sign-in returns them there instead of `/`.
 */
export const Route = createFileRoute("/login")({
  head: () => pageMeta({ title: "Sign in", path: "/login" }),
  component: LoginPage,
  validateSearch: (search): LoginSearch => ({
    redirect: sanitizeRedirect(search.redirect),
  }),
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const isAuthed = !!session?.user;

  // Already signed in → bounce to the path they were headed for (carried in
  // `?redirect=`), or `/chat`. `/login` is chromeless, so `AppShell`'s auth
  // guard deliberately skips it; this is the inverse of the signed-in → `/chat`
  // redirect in `routes/index.tsx`. Without it, an authed visitor who lands on
  // `/login` directly just sits on the sign-in screen.
  useEffect(() => {
    if (isAuthed) void navigate({ to: redirect ?? "/chat", replace: true });
  }, [isAuthed, redirect, navigate]);

  // Confirmed authed → redirect is in flight, render nothing.
  if (isAuthed) return null;
  // Session not yet resolved → defer to the synchronous hint to avoid flashing
  // the sign-in screen at a returning signed-in user before the redirect fires
  // (same trick `routes/index.tsx` uses to suppress the landing flash).
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
