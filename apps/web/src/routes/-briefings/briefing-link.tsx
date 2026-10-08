import { isBriefingReferenceKind } from "@alfred/contracts";
import type { Components } from "react-markdown";
import { type IntegrationBrand, IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { EntityChip } from "./entity-chip";

/** Brand glyph for a link's host; globe for other web links; null for mailto, tel, and relative links. */
function linkBrand(href: string): IntegrationBrand | null {
  let url: URL;

  try {
    // The fake base lets relative hrefs parse; the host marks them.
    url = new URL(href, "http://_relative_");
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");

  if (host === "_relative_") return null;

  if (host === "github.com" || host.endsWith(".github.com")) return "github";

  if (host === "mail.google.com") return "gmail";

  if (host === "calendar.google.com") return "google_calendar";

  if (host === "drive.google.com") return "google_drive";

  if (host === "docs.google.com") {
    if (url.pathname.startsWith("/spreadsheets")) return "google_sheets";

    if (url.pathname.startsWith("/presentation")) return "google_slides";

    return "google_docs";
  }

  if (host === "linear.app") return "linear";

  if (host.endsWith("slack.com")) return "slack";

  return "web";
}

/**
 * A briefing link styled like `EntityChip`: brand glyph, neutral ink, quiet underline.
 * `!text-app-fg-4` beats the renderer's `[&_a]` color.
 */
export const BriefingLink: Components["a"] = ({
  node: _node,
  href,
  title,
  children,
  className,
}) => {
  if (!href) return <span>{children}</span>;
  const brand = linkBrand(href);

  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "-mx-0.5 inline-flex items-center gap-1 rounded-md px-1.5 align-middle leading-[1.2] font-medium whitespace-normal",
        "!text-app-fg-4 !no-underline",
        "bg-app-bg-3/50 transition-colors duration-150",
        "hover:bg-app-bg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        className,
      )}
    >
      {brand ? <IntegrationGlyph brand={brand} size={13} /> : null}
      <span>{children}</span>
    </a>
  );
};

/** Render a `briefing-ref` token (ADR-0049) as an {@link EntityChip}. Unknown kinds fall back to the label. */
export function BriefingRef({
  kind,
  label,
  href,
}: {
  kind?: string | undefined;
  label?: string | undefined;
  href?: string | undefined;
}) {
  if (!kind || !isBriefingReferenceKind(kind) || !label) return label ?? null;

  return <EntityChip kind={kind} label={label} href={href} />;
}
