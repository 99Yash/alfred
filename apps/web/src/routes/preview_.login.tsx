import { createFileRoute } from "@tanstack/react-router";
import { PreviewLoginPage } from "./-preview-login/preview-login-page";

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
