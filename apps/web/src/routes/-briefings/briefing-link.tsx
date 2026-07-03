import { isBriefingReferenceKind } from "@alfred/contracts";
import type { Components } from "react-markdown";
import { type IntegrationBrand, IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { EntityChip } from "./entity-chip";

/**
 * Map a link's host to a brand glyph so briefing prose links read as the thing
 * they point at (a GitHub PR, a Gmail thread, a doc) rather than a bare URL.
 * Recognised SaaS hosts get their mark; any other web link gets the globe;
 * non-http links (mailto/tel) and in-app relative links get nothing.
 */
function linkBrand(href: string): IntegrationBrand | null {
  let url: URL;
  try {
    // Fake base resolves relative hrefs without throwing; flagged via the host.
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
 * Briefing link: an inline reference dressed in the same language as
 * `EntityChip` rather than the renderer's default purple link tone. A leading
 * brand glyph names the destination; the label sits in primary ink with a quiet
 * underline that wakes to full contrast on hover. `px` gives the token a little
 * breathing room and `rounded` lets the hover tint read as a soft pill.
 *
 * `!text-app-fg-4` overrides the wrapper's `[&_a]` color baseline — the only
 * property we wrestle from the shared renderer; the glyph carries the brand
 * color, so the text stays neutral and legible inside the sentence.
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

/**
 * Renders a composer reference token (`[[<kind>:<id>]]`, ADR-0049) as an
 * {@link EntityChip}. Mapped onto the custom `briefing-ref` element that
 * {@link briefingMarkdownComponents} wires into react-markdown. Unknown kinds or
 * missing labels collapse to the bare label (or nothing) rather than a chip.
 */
export function BriefingRef({
  kind,
  label,
  href,
}: {
  kind?: string;
  label?: string;
  href?: string;
}) {
  if (!kind || !isBriefingReferenceKind(kind) || !label) return label ?? null;
  return <EntityChip kind={kind} label={label} href={href} />;
}
