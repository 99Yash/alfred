import { useState } from "react";
import type { SectionId } from "./helpers";
import { SectionPanel } from "./section-panel";
import { SidebarNav } from "./sidebar-nav";

export function SettingsPage() {
  const [section, setSection] = useState<SectionId>("user");

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="app-card-in mb-10 space-y-2 text-center">
          <h1 className="text-[36px] leading-[44px] font-medium tracking-tight text-app-fg-4">
            Settings
          </h1>
          <p className="text-sm text-app-fg-3">Manage your account.</p>
        </header>

        <div className="grid grid-cols-1 gap-8 md:grid-cols-[180px_1fr]">
          <SidebarNav active={section} onChange={setSection} />
          <div key={section} className="app-card-in space-y-3" style={{ animationDelay: "60ms" }}>
            <SectionPanel section={section} />
          </div>
        </div>
      </main>
    </div>
  );
}
