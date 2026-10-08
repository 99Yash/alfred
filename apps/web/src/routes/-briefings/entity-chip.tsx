import type { BriefingReferenceKind } from "@alfred/contracts";
import { Activity } from "lucide-react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Inline reference from a resolved briefing segment (ADR-0049). The kind comes
 * from the contracts resolver, never from string splitting. Clickable only when
 * the segment has an `href`; meeting chips have none yet.
 */
export interface EntityChipProps {
  kind: BriefingReferenceKind;
  label: string;
  href?: string | undefined;
}

const TONE = {
  activity: "text-app-blue-4",
  meeting: "text-app-purple-4",
  email: "text-app-fg-4",
} satisfies Record<BriefingReferenceKind, string>;

const BASE =
  "inline-flex items-baseline gap-1 rounded font-medium align-baseline whitespace-normal";

function ChipIcon({ kind }: { kind: BriefingReferenceKind }) {
  if (kind === "email")
    return <IntegrationGlyph brand="gmail" size={12} className="translate-y-[1px] self-center" />;

  if (kind === "meeting")
    return (
      <IntegrationGlyph
        brand="google_calendar"
        size={12}
        className="translate-y-[1px] self-center"
      />
    );

  return <Activity size={12} aria-hidden className="shrink-0 translate-y-[1px] self-center" />;
}

export function EntityChip({ kind, label, href }: EntityChipProps) {
  const tone = TONE[kind];

  const inner = (
    <>
      <ChipIcon kind={kind} />
      <span>{label}</span>
    </>
  );

  if (!href) {
    return <span className={cn(BASE, tone)}>{inner}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        BASE,
        tone,
        "underline decoration-app-bg-3 underline-offset-2 transition-colors hover:decoration-current",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
      )}
    >
      {inner}
    </a>
  );
}
