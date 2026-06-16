import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { AppThemed, AppThemeProvider, AppThemeToggle } from "~/components/ui/v2";
import { AuthPanel } from "./-login/auth-panel";
import { ShowcasePanel } from "./-login/showcase-panel";

/**
 * Sign-in surface. Google is the only authentication method — the panel
 * fires `authClient.signIn.social({ provider: "google" })`, which redirects
 * to Google's consent screen and back to `/api/auth/callback/google`
 * (handled by Better Auth). The single-email allowlist still applies via
 * the `user.create.before` hook in `@alfred/auth`.
 */
export const Route = createFileRoute("/login")({
  head: () => pageMeta({ title: "Sign in", path: "/login" }),
  component: LoginPage,
});

export function LoginPage() {
  return (
    <AppThemeProvider>
      <AppThemed className="relative min-h-dvh bg-app-background-subtle">
        <div className="absolute top-3 right-3 z-50">
          <AppThemeToggle />
        </div>
        {/* `<main>` is the page's primary landmark — the login form + showcase
         * are the whole page (this route renders chromeless, so it must supply
         * its own main, unlike authed routes which get one from the shell). */}
        <main className="grid min-h-dvh lg:grid-cols-2">
          <AuthPanel />
          <ShowcasePanel />
        </main>
      </AppThemed>
    </AppThemeProvider>
  );
}
