import { createFileRoute } from "@tanstack/react-router";
import { VsThemed, VsThemeProvider, VsThemeToggle } from "~/components/ui/visitors";
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
  component: LoginPage,
});

function LoginPage() {
  return (
    <VsThemeProvider>
      <VsThemed className="relative min-h-dvh bg-vs-background-subtle">
        <div className="absolute top-3 right-3 z-50">
          <VsThemeToggle />
        </div>
        <div className="grid min-h-dvh lg:grid-cols-2">
          <AuthPanel />
          <ShowcasePanel />
        </div>
      </VsThemed>
    </VsThemeProvider>
  );
}
