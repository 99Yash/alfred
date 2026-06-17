import { createFileRoute } from "@tanstack/react-router";
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

export function LoginPage() {
  const { redirect } = Route.useSearch();
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
