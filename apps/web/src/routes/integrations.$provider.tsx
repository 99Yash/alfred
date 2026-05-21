import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  getIntegrationProvider,
  getRelatedProviders,
  type IntegrationProvider,
} from "~/lib/integrations";
import { IntegrationGlyph, IntegrationIcon } from "~/lib/integration-icons";

export const Route = createFileRoute("/integrations/$provider")({
  component: IntegrationDetailPage,
});

function IntegrationDetailPage() {
  const { provider: providerId } = Route.useParams();
  const provider = getIntegrationProvider(providerId);

  if (!provider) {
    return (
      <DetailShell>
        <BackLink />
        <Card className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-950">Integration not found</p>
          <p className="max-w-md text-[12.5px] text-gray-800">
            This provider is not available in the local preview.
          </p>
        </Card>
      </DetailShell>
    );
  }

  const connected = provider.status === "connected";

  return (
    <DetailShell>
      <BackLink />

      <header className="flex items-start justify-between gap-5">
        <div className="flex min-w-0 items-start gap-3">
          <IntegrationIcon
            brand={provider.brand}
            size="md"
            connected={connected}
            title={provider.name}
          />
          <div className="min-w-0 pt-0.5">
            <h1 className="text-sm font-medium text-gray-950">{provider.name}</h1>
            <p className="mt-0.5 text-[12.5px] leading-5 text-gray-800">{provider.description}</p>
          </div>
        </div>
        <Button size="lg">{connected ? "Add Account" : "Connect"}</Button>
      </header>

      <HeroPreview provider={provider} />

      <ConnectedAccounts provider={provider} />
      <TrustNotice provider={provider} />
      <RelatedSetup provider={provider} />
      <Capabilities provider={provider} />
      <Overview provider={provider} />
    </DetailShell>
  );
}

function DetailShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[672px] px-4 py-10 sm:px-6 sm:py-16">
      <div className="md:hidden h-6" />
      <div className="space-y-9">{children}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/integrations"
      className="inline-flex items-center gap-2 text-sm text-gray-800 transition-colors hover:text-gray-1000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
    >
      <ArrowLeft size={14} />
      All integrations
    </Link>
  );
}

function HeroPreview({ provider }: { provider: IntegrationProvider }) {
  return (
    <div
      aria-hidden
      className="relative h-[200px] w-full overflow-hidden rounded-2xl border border-white/[0.06]"
      style={{
        background:
          "radial-gradient(120% 90% at 50% 110%, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 55%), radial-gradient(80% 60% at 50% 0%, rgba(255,255,255,0.04) 0%, rgba(0,0,0,0) 60%), #0a0a0a",
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage:
            "radial-gradient(60% 60% at 50% 50%, black 0%, rgba(0,0,0,0.5) 60%, transparent 100%)",
        }}
      />
      <div className="relative flex h-full items-center justify-center gap-6">
        <HeroTile brand={provider.brand} variant="side" />
        <HeroTile brand={provider.brand} variant="center" />
        <HeroTile brand={provider.brand} variant="side" />
      </div>
    </div>
  );
}

function HeroTile({
  brand,
  variant,
}: {
  brand: IntegrationProvider["brand"];
  variant: "center" | "side";
}) {
  const isCenter = variant === "center";
  return (
    <div
      className={
        isCenter
          ? "grid size-[120px] place-items-center rounded-[28px] bg-[#0d0d0d] shadow-[0_24px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-white/10"
          : "grid size-[88px] place-items-center rounded-[22px] bg-[#0d0d0d] shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-white/[0.08] opacity-90"
      }
    >
      <IntegrationGlyph brand={brand} size={isCenter ? 56 : 40} />
    </div>
  );
}

function ConnectedAccounts({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";

  return (
    <section aria-labelledby="connected-accounts-title" className="space-y-4">
      <h2 id="connected-accounts-title" className="text-sm font-medium text-gray-1000">
        Connected
      </h2>
      {connected ? (
        <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-center gap-x-4 gap-y-3 px-1">
          <div className="text-[11.5px] uppercase tracking-[0.04em] text-gray-700">Connected</div>
          <div className="text-[11.5px] uppercase tracking-[0.04em] text-gray-700">Date</div>
          <div className="text-[11.5px] uppercase tracking-[0.04em] text-gray-700">Status</div>
          <div aria-hidden />

          <p className="min-w-0 truncate text-sm text-gray-1000">Connected account</p>
          <p className="text-sm text-gray-800 tabular-nums">Mar 17, 2026</p>
          <p className="inline-flex items-center gap-1.5 text-sm text-gray-800">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
            Active
          </p>
          <Button variant="destructive" size="sm">
            Disconnect
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 px-1 text-[11.5px] uppercase tracking-[0.04em] text-gray-700">
            <div>Connected</div>
            <div>Date</div>
            <div>Status</div>
          </div>
          <p className="px-1 text-[12.5px] text-gray-700">No account connected yet.</p>
        </>
      )}
    </section>
  );
}

function TrustNotice({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="relative flex items-start gap-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 pr-32">
      <span
        aria-hidden
        className="frost-icon-tile grid size-9 shrink-0 place-items-center rounded-xl text-gray-900"
      >
        <ShieldCheck size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium text-gray-1000">{provider.trust.title}</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-gray-800">{provider.trust.body}</p>
      </div>
      <TrustDial />
    </section>
  );
}

function TrustDial() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute -right-3 top-1/2 size-28 -translate-y-1/2 opacity-70"
      viewBox="0 0 96 96"
      fill="none"
    >
      <defs>
        <radialGradient id="trustDialGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgb(120,119,198)" stopOpacity="0.25" />
          <stop offset="60%" stopColor="rgb(120,119,198)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="rgb(120,119,198)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="48" r="46" fill="url(#trustDialGlow)" />
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
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={i % 9 === 0 ? 1.5 : 0.8}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="48" cy="48" r="24" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
      <circle cx="48" cy="48" r="14" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
      <circle cx="48" cy="48" r="3" fill="rgba(255,255,255,0.6)" />
    </svg>
  );
}

function RelatedSetup({ provider }: { provider: IntegrationProvider }) {
  const related = getRelatedProviders(provider);
  if (related.length === 0) return null;

  return (
    <section aria-labelledby="related-integrations-title" className="space-y-3">
      <div>
        <h2 id="related-integrations-title" className="text-sm font-medium text-gray-1000">
          Complete your Google Setup
        </h2>
        <p className="mt-1 text-[12.5px] leading-5 text-gray-800">
          To access Google Docs, Slides, and Sheets, connect the respective integrations.
        </p>
      </div>
      <div className="space-y-1">
        {related.map((item) => (
          <Link
            key={item.id}
            to="/integrations/$provider"
            params={{ provider: item.id }}
            className="flex items-center gap-3 rounded-2xl p-3 text-gray-800 transition-colors hover:bg-[#181818] hover:text-gray-900 focus-visible:bg-[#181818] focus-visible:outline-none"
          >
            <IntegrationIcon brand={item.brand} size="md" title={item.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-950">{item.name}</p>
              <p className="truncate text-[12.5px]">{item.description}</p>
            </div>
            <span className="inline-flex h-8 items-center rounded-full bg-white/[0.05] px-3.5 text-sm font-medium">
              {item.actionLabel}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Capabilities({ provider }: { provider: IntegrationProvider }) {
  return (
    <section aria-labelledby="capabilities-title" className="space-y-4">
      <h2 id="capabilities-title" className="text-base font-medium text-gray-1000">
        Capabilities
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {provider.capabilities.map((capability) => (
          <li
            key={capability}
            className="inline-flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-[12.5px] text-gray-850"
          >
            <CheckCircle2 size={14} className="text-emerald-300" />
            {capability}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Overview({ provider }: { provider: IntegrationProvider }) {
  return (
    <section aria-labelledby="overview-title" className="space-y-4 pb-8">
      <h2 id="overview-title" className="text-base font-medium text-gray-1000">
        Overview
      </h2>
      <p className="text-[12.5px] leading-5 text-gray-800">{provider.overview.body}</p>
      <div>
        <h3 className="text-sm font-medium text-gray-950">{provider.overview.heading}</h3>
        <p className="mt-1 text-[12.5px] leading-5 text-gray-800">{provider.overview.detail}</p>
      </div>
      {provider.overview.extraHeading && provider.overview.extraDetail ? (
        <div>
          <h3 className="text-sm font-medium text-gray-950">{provider.overview.extraHeading}</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-gray-800">
            {provider.overview.extraDetail}
          </p>
        </div>
      ) : null}
    </section>
  );
}
