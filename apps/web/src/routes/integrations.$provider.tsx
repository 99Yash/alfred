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
import { IntegrationIcon } from "~/lib/integration-icons";

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

function ConnectedAccounts({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";

  return (
    <section aria-labelledby="connected-accounts-title" className="space-y-3">
      <h2 id="connected-accounts-title" className="text-sm font-medium text-gray-1000">
        Connected
      </h2>
      <div className="overflow-hidden rounded-2xl border border-white/[0.06]">
        <div className="grid grid-cols-[1fr_0.8fr_0.7fr_auto] gap-4 border-b border-white/[0.06] px-4 py-3 text-sm text-gray-950">
          <div>Connected</div>
          <div>Date</div>
          <div>Status</div>
          <div className="sr-only">Actions</div>
        </div>
        <div className="grid grid-cols-[1fr_0.8fr_0.7fr_auto] items-center gap-4 px-4 py-4 text-[12.5px] text-gray-800">
          <div className="min-w-0">
            <p className="truncate text-gray-950">{connected ? "Connected account" : "-"}</p>
            <p className="truncate text-[11.5px]">{connected ? "Workspace" : ""}</p>
          </div>
          <div>{connected ? "Mar 17, 2026" : "-"}</div>
          <div className="inline-flex items-center gap-1.5">
            {connected ? <span className="size-1.5 rounded-full bg-emerald-400" /> : null}
            {connected ? "Active" : "Not connected"}
          </div>
          <div>
            {connected ? (
              <Button variant="destructive" size="sm">
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustNotice({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="flex gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <span
        aria-hidden
        className="frost-icon-tile grid size-9 shrink-0 place-items-center rounded-xl text-gray-900"
      >
        <ShieldCheck size={17} />
      </span>
      <div>
        <h2 className="text-sm font-medium text-gray-1000">{provider.trust.title}</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-gray-800">{provider.trust.body}</p>
      </div>
    </section>
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
