import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Check, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { VsButton, VsCard } from "~/components/ui/visitors";
import {
  getIntegrationProvider,
  getRelatedProviders,
  type IntegrationProvider,
} from "~/lib/integrations";
import { IntegrationGlyph, IntegrationIcon } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /integrations/$provider.
 *
 * Same IA + same data as the legacy detail page, rebuilt in visitors grammar:
 *   - Theme-aware (light + dark) via VsThemed
 *   - VsCard surfaces with `vs-elevated` shadows
 *   - Soft chip capabilities (matching dimension's chip cluster)
 *   - vs-card-in staggered entrance
 *
 * Compare:
 *   /integrations/$provider           → dimension grammar (dark, dense)
 *   /preview/integrations/$provider   → visitors-now grammar
 */
export const Route = createFileRoute("/preview/integrations/$provider")({
  component: PreviewIntegrationDetailPage,
});

function PreviewIntegrationDetailPage() {
  const { provider: providerId } = Route.useParams();
  const provider = getIntegrationProvider(providerId);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-[700px] px-4 sm:px-6 py-10 sm:py-14">
        <BackLink />
        {provider ? <ProviderDetail provider={provider} /> : <NotFound />}
      </main>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/preview/integrations"
      className={cn(
        "inline-flex items-center gap-2 rounded-lg h-8 -ml-1 px-2 text-sm",
        "text-vs-fg-3 hover:text-vs-fg-4 hover:bg-vs-bg-a2 transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
      )}
    >
      <ArrowLeft size={14} />
      All integrations
    </Link>
  );
}

function NotFound() {
  return (
    <VsCard className="mt-8 flex flex-col items-center gap-2 px-6 py-12 text-center vs-card-in">
      <p className="text-sm font-medium text-vs-fg-4">Integration not found</p>
      <p className="max-w-md text-[12.5px] text-vs-fg-3">
        This provider is not available in the local preview.
      </p>
    </VsCard>
  );
}

function ProviderDetail({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";

  return (
    <div className="mt-6 space-y-10">
      <DetailHeader provider={provider} connected={connected} />
      <HeroPreview provider={provider} />
      <ConnectedAccounts provider={provider} connected={connected} />
      <TrustNotice provider={provider} />
      <RelatedSetup provider={provider} />
      <Capabilities provider={provider} />
      <Overview provider={provider} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header — brand icon + name + description + primary CTA                     */
/* -------------------------------------------------------------------------- */

function DetailHeader({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  return (
    <header className="flex items-start justify-between gap-4 vs-card-in">
      <div className="flex min-w-0 items-start gap-3">
        <IntegrationIcon
          brand={provider.brand}
          size="md"
          connected={connected}
          title={provider.name}
        />
        <div className="min-w-0 pt-0.5">
          <h1 className="text-base font-medium text-vs-fg-4 tracking-tight">{provider.name}</h1>
          <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">{provider.description}</p>
        </div>
      </div>
      <VsButton variant="white" size="lg">
        {connected ? "Add Account" : "Connect"}
      </VsButton>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero — 3 tiles of the same brand, like dimension's collage                  */
/* -------------------------------------------------------------------------- */

function HeroPreview({ provider }: { provider: IntegrationProvider }) {
  const isMono = MONOCHROME_BRANDS.has(provider.brand);

  return (
    <div
      aria-hidden
      className={cn(
        "relative h-[200px] w-full overflow-hidden rounded-3xl vs-card-in",
        "bg-vs-bg-2",
      )}
      style={{ animationDelay: "60ms" }}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-50 dark:opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--vs-bg-a2) 1px, transparent 1px), linear-gradient(to bottom, var(--vs-bg-a2) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(60% 60% at 50% 50%, black 0%, rgba(0,0,0,0.5) 60%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 110%, var(--vs-purple-2) 0%, transparent 55%)",
        }}
      />
      <div className="relative flex h-full items-center justify-center gap-6">
        <HeroTile brand={provider.brand} variant="side" rotate={-4} isMono={isMono} />
        <HeroTile brand={provider.brand} variant="center" isMono={isMono} />
        <HeroTile brand={provider.brand} variant="side" rotate={4} isMono={isMono} />
      </div>
    </div>
  );
}

function HeroTile({
  brand,
  variant,
  rotate = 0,
  isMono,
}: {
  brand: IntegrationProvider["brand"];
  variant: "center" | "side";
  rotate?: number;
  isMono: boolean;
}) {
  const isCenter = variant === "center";
  return (
    <div
      className={cn(
        "grid place-items-center bg-vs-bg-1 transition-transform",
        isCenter ? "size-[120px] rounded-[26px]" : "size-[88px] rounded-[22px] opacity-90",
        "shadow-[var(--vs-shadow-elevated)]",
        isMono && "text-vs-fg-4",
      )}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <IntegrationGlyph
        brand={brand}
        size={isCenter ? 52 : 38}
        colorOverride={isMono ? "var(--vs-fg-4)" : undefined}
      />
    </div>
  );
}

const MONOCHROME_BRANDS = new Set<IntegrationProvider["brand"]>(["github"]);

/* -------------------------------------------------------------------------- */
/* Connected account row                                                       */
/* -------------------------------------------------------------------------- */

function ConnectedAccounts({
  provider,
  connected,
}: {
  provider: IntegrationProvider;
  connected: boolean;
}) {
  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "120ms" }}>
      <SectionHeading>Connected</SectionHeading>

      <VsCard padded={false} className="overflow-hidden">
        <div className="grid grid-cols-3 gap-4 px-4 pt-3 pb-2 border-b border-vs-bg-3/60">
          <ColumnLabel>Account</ColumnLabel>
          <ColumnLabel>Date</ColumnLabel>
          <ColumnLabel>Status</ColumnLabel>
        </div>

        {connected ? (
          <div className="grid grid-cols-3 items-center gap-4 px-4 py-3">
            <p className="min-w-0 truncate text-sm text-vs-fg-4 font-medium">
              {MOCK_ACCOUNT_FOR_BRAND[provider.brand]}
            </p>
            <p className="text-sm text-vs-fg-3 tabular-nums">{MOCK_CONNECTED_DATE}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-vs-fg-3">
                <span className="size-1.5 rounded-full bg-vs-green-4" aria-hidden />
                Active
              </span>
              <VsButton variant="ghost" size="sm">
                Disconnect
              </VsButton>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4 text-[12.5px] text-vs-fg-2">No account connected yet.</div>
        )}
      </VsCard>
    </section>
  );
}

const MOCK_CONNECTED_DATE = "March 15, 2026";

const MOCK_ACCOUNT_FOR_BRAND: Record<IntegrationProvider["brand"], string> = {
  collaborators: "—",
  github: "99Yash",
  gmail: "yashgourav@gmail.com",
  google_calendar: "yashgourav@gmail.com",
  google_drive: "yashgourav@gmail.com",
  google_docs: "yashgourav@gmail.com",
  google_sheets: "yashgourav@gmail.com",
  google_slides: "yashgourav@gmail.com",
  linear: "yash@oliv.ai",
  slack: "Alfred workspace",
  web: "—",
};

/* -------------------------------------------------------------------------- */
/* Trust notice — shield icon + body, with the rotating dial accent           */
/* -------------------------------------------------------------------------- */

function TrustNotice({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="vs-card-in" style={{ animationDelay: "180ms" }}>
      <VsCard padded={false} className="relative overflow-hidden">
        <div className="flex items-start gap-3 p-4 pr-32">
          <span
            aria-hidden
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-xl",
              "bg-vs-purple-1 text-vs-purple-4",
            )}
          >
            <ShieldCheck size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-vs-fg-4">{provider.trust.title}</h2>
            <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">{provider.trust.body}</p>
          </div>
        </div>
        <TrustDial />
      </VsCard>
    </section>
  );
}

function TrustDial() {
  return (
    <svg
      aria-hidden
      className={cn(
        "pointer-events-none absolute -right-3 top-1/2 size-28 -translate-y-1/2",
        "opacity-90 text-vs-purple-3",
      )}
      viewBox="0 0 96 96"
      fill="none"
    >
      <defs>
        <radialGradient id="vsTrustDialGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="46" fill="url(#vsTrustDialGlow)" />
      {Array.from({ length: 36 }).map((_, i) => {
        const angle = (i / 36) * Math.PI * 2;
        const inner = 30;
        const outer = i % 9 === 0 ? 40 : 36;
        const x1 = 48 + Math.cos(angle) * inner;
        const y1 = 48 + Math.sin(angle) * inner;
        const x2 = 48 + Math.cos(angle) * outer;
        const y2 = 48 + Math.sin(angle) * outer;
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeOpacity={i % 9 === 0 ? 0.55 : 0.35}
            strokeWidth={i % 9 === 0 ? 1.5 : 0.8}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="48" cy="48" r="24" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" />
      <circle cx="48" cy="48" r="14" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1" />
      <circle cx="48" cy="48" r="3" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Related setup — sibling integrations (e.g. Google suite)                    */
/* -------------------------------------------------------------------------- */

function RelatedSetup({ provider }: { provider: IntegrationProvider }) {
  const related = getRelatedProviders(provider);
  if (related.length === 0) return null;

  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "240ms" }}>
      <div>
        <SectionHeading>Complete your Google setup</SectionHeading>
        <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">
          To access Docs, Slides, and Sheets, connect each integration.
        </p>
      </div>
      <div className="space-y-2">
        {related.map((item, idx) => (
          <Link
            key={item.id}
            to="/preview/integrations/$provider"
            params={{ provider: item.id }}
            className={cn(
              "vs-card-in flex items-center gap-3 rounded-2xl bg-vs-bg-1 px-3 py-2.5",
              "shadow-[var(--vs-shadow-elevated)] transition-shadow vs-press",
              "hover:shadow-[var(--vs-shadow-elevated-hover)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
            )}
            style={{ animationDelay: `${260 + idx * 40}ms` }}
          >
            <IntegrationIcon brand={item.brand} size="md" title={item.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-vs-fg-4">{item.name}</p>
              <p className="truncate text-[12.5px] text-vs-fg-3">{item.description}</p>
            </div>
            <span
              className={cn(
                "inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium",
                "bg-vs-bg-2 text-vs-fg-4 ring-1 ring-vs-bg-3",
              )}
            >
              {item.actionLabel}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Capabilities — dimension's pill cluster                                     */
/* -------------------------------------------------------------------------- */

function Capabilities({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "300ms" }}>
      <SectionHeading>Capabilities</SectionHeading>
      <div className="flex flex-wrap gap-2">
        {provider.capabilities.map((capability) => (
          <CapabilityChip key={capability}>{capability}</CapabilityChip>
        ))}
      </div>
    </section>
  );
}

function CapabilityChip({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full h-8 pl-2 pr-3.5",
        "bg-vs-bg-1 ring-1 ring-vs-bg-3 text-[12.5px] font-medium text-vs-fg-4",
        "shadow-[var(--vs-shadow-elevated)]",
      )}
    >
      <span
        aria-hidden
        className="grid size-5 place-items-center rounded-md bg-vs-purple-1 text-vs-purple-4"
      >
        <Check size={11} strokeWidth={2.5} />
      </span>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Overview — prose                                                            */
/* -------------------------------------------------------------------------- */

function Overview({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="space-y-4 pb-8 vs-card-in" style={{ animationDelay: "360ms" }}>
      <SectionHeading>Overview</SectionHeading>
      <p className="text-[12.5px] leading-5 text-vs-fg-3">{provider.overview.body}</p>
      <div>
        <h3 className="text-sm font-medium text-vs-fg-4">{provider.overview.heading}</h3>
        <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">{provider.overview.detail}</p>
      </div>
      {provider.overview.extraHeading && provider.overview.extraDetail ? (
        <div>
          <h3 className="text-sm font-medium text-vs-fg-4">{provider.overview.extraHeading}</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">
            {provider.overview.extraDetail}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-medium text-vs-fg-4">{children}</h2>;
}

function ColumnLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
      {children}
    </span>
  );
}
