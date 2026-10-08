import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { LoginPage } from "./-login/login-page";
import { sanitizeRedirect, type LoginSearch } from "./-login/login-search";

/**
 * Google-only sign-in through Better Auth; the email allowlist runs in `@alfred/auth`.
 * `?redirect=` returns the user to where `AppShell`'s guard bounced them.
 */
export const Route = createFileRoute("/login")({
  staticData: { publicRoute: true },
  head: () => pageMeta({ title: "Sign in", path: "/login" }),
  component: LoginPage,
  validateSearch: (search): LoginSearch => ({
    redirect: sanitizeRedirect(search.redirect),
  }),
});
