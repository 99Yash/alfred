import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Plus, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, DialogClose, DialogContent } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  CATEGORY_ORDER,
  INTEGRATION_PROVIDERS,
  matchesIntegration,
  type IntegrationProvider,
} from "~/lib/integrations";
import { IntegrationIcon } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";

export function ConnectToolsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const sections = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      providers: INTEGRATION_PROVIDERS.filter(
        (provider) => provider.category === category && matchesIntegration(provider, query),
      ),
    })).filter((section) => section.providers.length > 0);
  }, [query]);
  const connectedCount = INTEGRATION_PROVIDERS.filter(
    (provider) => provider.status === "connected",
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect your tools"
        description="Choose the apps Alfred can read, write, and act on."
        className="max-w-[760px] rounded-[28px]"
        overlayClassName="bg-black/70"
      >
        <div className="border-b border-white/[0.07] px-5 pb-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-3">
              <div className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.045] px-2.5 text-[12px] text-gray-800">
                <ShieldCheck size={13} className="text-emerald-300" />
                {connectedCount} connected
              </div>
              <Input
                variant="search"
                leading={<Search size={14} />}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tools"
                aria-label="Search tools"
                className="!h-10"
              />
            </div>
            <DialogClose asChild>
              <Link
                to="/integrations"
                className={cn(
                  "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium",
                  "bg-white text-black transition-[background-color,transform]",
                  "hover:bg-white/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25",
                )}
              >
                Open integrations
                <ArrowRight size={14} />
              </Link>
            </DialogClose>
          </div>
        </div>

        <div className="minimal-scrollbar max-h-[520px] overflow-y-auto px-5 py-4">
          {sections.length > 0 ? (
            <div className="space-y-5">
              {sections.map((section) => (
                <section key={section.category} className="space-y-2.5">
                  <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-gray-700">
                    {section.category}
                  </h3>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {section.providers.map((provider) => (
                      <ProviderDialogRow key={provider.id} provider={provider} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="grid min-h-[220px] place-items-center text-center">
              <div>
                <p className="text-sm font-medium text-gray-950">No matching tools</p>
                <p className="mt-1 text-[12.5px] text-gray-700">
                  Try searching for Gmail, Calendar, Drive, Slack, or Linear.
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderDialogRow({ provider }: { provider: IntegrationProvider }) {
  const connected = provider.status === "connected";
  const soon = provider.status === "soon";
  const content = (
    <>
      <IntegrationIcon
        brand={provider.brand}
        connected={connected}
        size="md"
        title={provider.name}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-950">{provider.name}</p>
        <p className="truncate text-[12.5px] text-gray-700">{provider.description}</p>
      </div>
      <span
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium",
          connected
            ? "bg-emerald-400/10 text-emerald-200"
            : soon
              ? "bg-white/[0.045] text-gray-700"
              : "bg-white/[0.065] text-gray-900 group-hover:bg-white/[0.09]",
        )}
      >
        {connected ? <Check size={13} /> : !soon ? <Plus size={13} /> : null}
        {provider.actionLabel}
      </span>
    </>
  );

  if (soon) {
    return (
      <div className="flex min-h-[64px] items-center gap-3 rounded-2xl border border-white/[0.055] bg-white/[0.025] px-3 py-2.5 opacity-70">
        {content}
      </div>
    );
  }

  return (
    <DialogClose asChild>
      <Link
        to="/integrations/$provider"
        params={{ provider: provider.id }}
        className={cn(
          "group flex min-h-[64px] items-center gap-3 rounded-2xl border border-white/[0.055] bg-white/[0.025] px-3 py-2.5",
          "transition-colors hover:bg-white/[0.05]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600/35",
        )}
      >
        {content}
      </Link>
    </DialogClose>
  );
}
