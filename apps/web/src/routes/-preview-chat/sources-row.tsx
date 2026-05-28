import type { LucideIcon } from "lucide-react";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type ToolTone } from "./helpers";

/**
 * `sources` footer under an assistant turn. Each pill is either an integration
 * (Gmail/Calendar/…) — brand glyph on a neutral chip — or a generic internal
 * source (Memory, Contacts) — Lucide icon on a toned chip.
 */
type SourceItem =
  | {
      integration: IntegrationBrand;
      label: string;
      count: number;
      icon?: LucideIcon;
      tone?: ToolTone;
    }
  | { integration?: undefined; icon: LucideIcon; tone: ToolTone; label: string; count: number };

export function SourcesRow({ items }: { items: SourceItem[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {items.map((item) => (
        <SourcePill key={item.label} {...item} />
      ))}
    </div>
  );
}

function SourcePill(props: SourceItem) {
  const { label, count } = props;
  if (props.integration) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg h-6 px-2 text-[11px] font-medium bg-vs-bg-2 text-vs-fg-4">
        <IntegrationGlyph brand={props.integration} size={12} />
        {label}
        <span className="text-vs-fg-2 tabular-nums">{count}</span>
      </span>
    );
  }
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg h-6 px-2 text-[11px] font-medium",
        TOOL_TONE[props.tone],
      )}
    >
      <Icon size={11} />
      {label}
      <span className="text-vs-fg-2 tabular-nums">{count}</span>
    </span>
  );
}
