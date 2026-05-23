import { createFileRoute } from "@tanstack/react-router";
import {
  VsThemed,
  VsThemeProvider,
  VsThemeToggle,
} from "~/components/ui/visitors";
import { AuthPanel } from "./-preview-login/auth-panel";
import { ShowcasePanel } from "./-preview-login/showcase-panel";

/**
 * Visitors-now-grammar port of `/login`. Mirrors the visitors.now sign-in
 * layout: a centered auth panel on the left (Google CTA above the OTP flow)
 * and a quiet brand showcase on the right at >=lg.
 *
 * The file name uses the trailing-underscore convention
 * (`preview_.login.tsx`) so the URL resolves to `/preview/login` but the
 * route does NOT nest under `preview.tsx` — login is a pre-shell surface
 * and should not inherit the sidebar.
 *
 * Google is rendered as the primary CTA per the long-term direction, but
 * stubbed — clicking surfaces a "coming soon" hint and focuses the email
 * field. Email-OTP remains the real, working path through `authClient`.
 */
export const Route = createFileRoute("/preview_/login")({
  component: PreviewLoginPage,
});

function PreviewLoginPage() {
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
