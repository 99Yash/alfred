import type { BriefingReferenceKind } from "@alfred/contracts";
import { Activity } from "lucide-react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";

/**
 * Typed inline reference rendered from a resolved briefing segment (ADR-0049).
 * One component, variant by `BriefingReferenceKind` for icon/tone. The kind
 * comes from the contracts resolver (`referenceKind` on the segment), never
 * from local string splitting. Interactive iff the resolved segment carries an
 * `href` — v1 hrefs are external (Gmail thread / provider URL); meeting chips
 * are always static (the calendar gather carries no event link yet).
 *
 * Email and meeting chips render the vendor brand mark (Gmail / Google
 * Calendar); activity chips keep a toned lucide glyph since the segment carries
 * no specific provider.
 */
export interface EntityChipProps {
  kind: BriefingReferenceKind;
  label: string;
  href?: string;
}

const TONE: Record<BriefingReferenceKind, string> = {
  activity: "text-app-blue-4",
  meeting: "text-app-purple-4",
  email: "text-app-fg-4",
};

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
