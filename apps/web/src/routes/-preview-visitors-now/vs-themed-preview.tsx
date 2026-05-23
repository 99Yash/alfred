import { useState } from "react";
import {
  VsButton,
  VsCard,
  VsCardHeader,
  VsDock,
  VsHeader,
  VsInput,
  VsKpi,
  VsPill,
  VsThemed,
  VsThemeToggle,
} from "~/components/ui/visitors";
import { ArrowIcon } from "./arrow-icon";
import { BookIcon } from "./book-icon";
import { DashboardIcon } from "./dashboard-icon";
import { EmptyState } from "./empty-state";
import { FilterIcon } from "./filter-icon";
import { FunnelIcon } from "./funnel-icon";
import { GaugeIcon } from "./gauge-icon";
import { GlobeIcon } from "./globe-icon";
import { SettingsIcon } from "./settings-icon";
import { SmileIcon } from "./smile-icon";

const HEADER_PILL_LEADING = (
  <span className="size-4 rounded bg-vs-purple-3" aria-hidden />
);

const HEADER_START = (
  <div className="flex items-center gap-2">
    <span className="size-7 rounded-full bg-vs-fg-4" aria-hidden />
    <VsPill chevron leading={HEADER_PILL_LEADING}>
      Alfred
    </VsPill>
  </div>
);

const HEADER_END = (
  <button
    type="button"
    className="size-8 rounded-full bg-vs-pink-4 text-white text-sm font-medium vs-press"
    aria-label="Account menu"
  >
    Y
  </button>
);

const REALTIME_PILL = <VsPill>Realtime</VsPill>;
const PERFORMANCE_PILL = <VsPill>Performance</VsPill>;

const PAGES_HEADER_TRAILING = (
  <>
    <span className="font-medium text-vs-fg-4">Top</span>
    <span>Entered</span>
    <span>Exited</span>
  </>
);

const SOURCES_HEADER_TRAILING = (
  <>
    <span className="font-medium text-vs-fg-4">Referrer</span>
    <span>Links</span>
    <span>Campaign</span>
  </>
);

export function VsThemedPreview() {
  const [active, setActive] = useState<string>("dashboard");
  return (
    <VsThemed className="min-h-dvh">
      <div className="fixed top-3 right-3 z-50">
        <VsThemeToggle />
      </div>
      <VsHeader start={HEADER_START} end={HEADER_END} />

      <main className="mx-auto max-w-[720px] px-4 pt-[88px] pb-24">
        {/* Period selector + filter */}
        <div className="flex items-center justify-between mb-4">
          <VsPill chevron>Today</VsPill>
          <button
            type="button"
            className="size-8 inline-flex items-center justify-center rounded-full text-vs-fg-3 vs-elevated bg-vs-bg-1 vs-press"
            aria-label="Filters"
          >
            <FilterIcon />
          </button>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-4 mb-2">
          <VsKpi label="People" dot="purple" value="1" delta="+100%" deltaTone="green" />
          <VsKpi label="Views" dot="sky" value="1" delta="+100%" deltaTone="green" />
          <VsKpi label="Bounced" value="0%" delta="0%" deltaTone="neutral" />
          <VsKpi label="Duration" value="0m 0s" delta="0%" deltaTone="neutral" />
        </div>

        {/* Hero chart placeholder */}
        <div className="relative h-[280px] mb-8">
          <svg viewBox="0 0 720 280" className="w-full h-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="vs-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#918df6" stopOpacity="0.32" />
                <stop offset="100%" stopColor="#918df6" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0,260 L260,255 L420,250 L500,180 L540,40 L720,30 L720,280 L0,280 Z" fill="url(#vs-area)" />
            <path d="M0,260 L260,255 L420,250 L500,180 L540,40 L720,30" stroke="#918df6" strokeWidth="2" fill="none" />
          </svg>
          <div className="absolute inset-x-0 bottom-0 flex justify-between text-[11px] text-vs-fg-2 px-1">
            <span>00:00</span>
            <span>10:00</span>
            <span>23:00</span>
          </div>
        </div>

        {/* Card grid */}
        <div className="grid grid-cols-2 gap-4">
          <VsCard>
            <VsCardHeader title="1 person in the last 30m" trailing={REALTIME_PILL} />
            <div className="flex items-end gap-1 h-12 mt-2">
              {Array.from({ length: 40 }).map((_, i) => (
                <span
                  key={i}
                  className={
                    i >= 32
                      ? "w-1.5 rounded-full bg-vs-purple-4"
                      : "w-1.5 rounded-full bg-vs-purple-1"
                  }
                  style={{ height: i >= 32 ? `${30 + (i - 32) * 4}px` : "6px" }}
                  aria-hidden
                />
              ))}
            </div>
          </VsCard>

          <VsCard>
            <VsCardHeader title="Experience Score" trailing={PERFORMANCE_PILL} />
            <div className="flex items-center gap-3">
              <span className="size-12 rounded-full border border-vs-bg-3 inline-flex items-center justify-center text-vs-fg-2">
                …
              </span>
              <div>
                <div className="text-sm font-medium text-vs-fg-4">Collecting</div>
                <div className="text-xs text-vs-fg-2 mt-0.5">We are still collecting data for this period.</div>
              </div>
            </div>
          </VsCard>

          <VsCard>
            <VsCardHeader title="Pages" trailing={PAGES_HEADER_TRAILING} />
            <EmptyState icon={<BookIcon />} caption="No pages found" />
          </VsCard>

          <VsCard>
            <VsCardHeader title="Sources" trailing={SOURCES_HEADER_TRAILING} />
            <div className="rounded-lg bg-vs-bg-2 px-3 h-9 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-vs-fg-4">
                <ArrowIcon />
                Direct
              </span>
              <span className="tabular-nums text-vs-fg-3">1</span>
            </div>
          </VsCard>
        </div>

        {/* Settings-style row example */}
        <div className="mt-8 grid grid-cols-[180px_1fr] gap-8">
          <nav className="flex flex-col gap-1 text-sm text-vs-fg-3">
            {["General", "Usage", "Team", "Integrations", "Security", "API"].map((label, i) => (
              <button
                key={label}
                type="button"
                aria-current={i === 0 ? "page" : undefined}
                className="px-3 h-9 rounded-full inline-flex items-center text-left hover:bg-vs-bg-a2 hover:text-vs-fg-4 [&[aria-current=page]]:bg-vs-bg-2 [&[aria-current=page]]:text-vs-fg-4"
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex flex-col gap-4">
            <VsCard>
              <VsCardHeader title="Project name" />
              <p className="text-sm text-vs-fg-3 mb-3 -mt-3">The name of your project.</p>
              <VsInput defaultValue="Alfred" />
              <div className="flex items-center justify-between mt-3 text-xs text-vs-fg-2">
                <span>Maximum of 30 characters</span>
                <VsButton size="sm" disabled>
                  Save
                </VsButton>
              </div>
            </VsCard>

            <VsCard>
              <VsCardHeader title="Project token" />
              <p className="text-sm text-vs-fg-3 mb-3 -mt-3">A unique token assigned to your project.</p>
              <VsInput readOnly defaultValue="1e8a7887-a321-431e-bae1-c0a037971c85" />
              <div className="flex items-center justify-between mt-3 text-xs text-vs-fg-2">
                <span>Used to identify your project</span>
                <VsButton size="sm">Copy</VsButton>
              </div>
            </VsCard>

            <VsCard>
              <VsCardHeader title="Danger zone" />
              <p className="text-sm text-vs-fg-3 mb-3 -mt-3">
                Permanently delete your project. This action is practically immediate, and cannot be undone.
              </p>
              <div className="flex items-center justify-between text-xs text-vs-fg-2">
                <span>Proceed with caution</span>
                <VsButton size="sm" variant="destructive">
                  Delete
                </VsButton>
              </div>
            </VsCard>
          </div>
        </div>
      </main>

      <VsDock
        items={[
          { id: "dashboard", icon: <DashboardIcon />, label: "Dashboard", onClick: () => setActive("dashboard") },
          { id: "people", icon: <SmileIcon />, label: "People", onClick: () => setActive("people") },
          { id: "performance", icon: <GaugeIcon />, label: "Performance", onClick: () => setActive("performance") },
          { id: "funnels", icon: <FunnelIcon />, label: "Funnels", onClick: () => setActive("funnels") },
          { id: "settings", icon: <SettingsIcon />, label: "Settings", onClick: () => setActive("settings") },
          { id: "realtime", icon: <GlobeIcon />, label: "Realtime", onClick: () => setActive("realtime"), badge: 1 },
        ]}
        activeId={active}
      />
    </VsThemed>
  );
}
