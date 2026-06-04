import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/lib/page-meta";
import { PreviewSettingsPage } from "./-preview-settings/preview-settings-page";

/**
 * Visitors-now-grammar port of /settings.
 *
 * Same six sections (User, Billing, Plan, Features, Preferences, Referrals)
 * with the same form behavior wired to authClient.useSession() + signOut().
 *
 * What changed vs the dimension version
 * - One big PanelCard → many atomic VsCards (visitors.now's settings page
 *   uses one card per setting: project name, token, currency, public stats,
 *   delete — each is its own surface). Reads cleaner; small surfaces feel
 *   purposeful.
 * - Sidebar nav: dimension's left-bar accent rail → visitors-now active fill
 *   (bg-vs-bg-2) and icon brightening.
 * - Heading-display gradient title → plain ink heading.
 */
export const Route = createFileRoute("/settings")({
  head: () => pageMeta({ title: "Settings", path: "/settings" }),
  component: PreviewSettingsPage,
});
