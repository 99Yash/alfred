import { useState } from "react";
import { SectionPanel } from "./section-panel";
import { SidebarNav } from "./sidebar-nav";
import type { SectionId } from "./helpers";

export function PreviewSettingsPage() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <div className="flex-1 min-w-0 overflow-y-auto scroll-stable">
      <main className="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-2 mb-10 app-card-in">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-app-fg-4">
            Settings
          </h1>
          <p className="text-sm text-app-fg-3">Manage your account.</p>
        </header>

        <div className="grid gap-8 grid-cols-1 md:grid-cols-[180px_1fr]">
          <SidebarNav active={section} onChange={setSection} />
          <div key={section} className="space-y-3 app-card-in" style={{ animationDelay: "60ms" }}>
            <SectionPanel section={section} />
          </div>
        </div>
      </main>
    </div>
  );
}
