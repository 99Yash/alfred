import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SectionPanel } from "./-preview-settings/section-panel";
import { SidebarNav } from "./-preview-settings/sidebar-nav";
import type { SectionId } from "./-preview-settings/helpers";

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
export const Route = createFileRoute("/preview/settings")({
  component: PreviewSettingsPage,
});

function PreviewSettingsPage() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-2 mb-10 vs-card-in">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-vs-fg-4">Settings</h1>
          <p className="text-sm text-vs-fg-3">Manage your account.</p>
        </header>

        <div className="grid gap-8 grid-cols-1 md:grid-cols-[180px_1fr]">
          <SidebarNav active={section} onChange={setSection} />
          <div key={section} className="space-y-3 vs-card-in" style={{ animationDelay: "60ms" }}>
            <SectionPanel section={section} />
          </div>
        </div>

        <footer className="mt-16 flex items-center justify-center text-xs text-vs-fg-2 gap-2">
          <span>Comparing against</span>
          <Link to="/settings" className="font-medium text-vs-fg-3 hover:text-vs-fg-4">
            /settings
          </Link>
        </footer>
      </main>
    </div>
  );
}
