import { ShieldCheck } from "lucide-react";
import { VsCard } from "~/components/ui/visitors";
import type { IntegrationProvider } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { TrustDial } from "./trust-dial";

export function TrustNotice({ provider }: { provider: IntegrationProvider }) {
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
