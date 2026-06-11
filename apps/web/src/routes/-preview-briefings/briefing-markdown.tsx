import {
  type BriefingGather,
  isBriefingReferenceKind,
  resolveBriefingReferences,
} from "@alfred/contracts";
import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { type IntegrationBrand, IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { visit } from "unist-util-visit";
import { EntityChip } from "./entity-chip";

type RemarkPlugin = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>[number];

/** Minimal mdast shape we touch — avoids pulling `mdast`/`unified` into web. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * Briefing markdown is regular GFM with one extension: the composer's opaque
 * `[[<kind>:<id>]]` reference tokens (ADR-0049). The rail and email renderers
 * resolve those against the row's synced `gather`; this plugin does the same
 * inside react-markdown so the detail page renders true markdown (headings,
 * lists, emphasis, links) AND keeps references as interactive entity chips —
 * instead of dumping the raw prose as plain text.
 *
 * Tokens are alphanumeric and never contain inline-markdown delimiters, so each
 * `[[…]]` stays inside a single mdast `text` node. We split every text node
 * through the shared contracts resolver — one resolution truth, three renderers
 * — and swap matched references for a custom `briefing-ref` element that
 * {@link briefingMarkdownComponents} maps to `EntityChip`.
 */
export function briefingRefsPlugin(gather: BriefingGather | null): RemarkPlugin {
  const plugin = () => (tree: MdNode) => {
    if (!gather) return;
    visit(tree as never, "text", (node: MdNode, index, parent: MdNode | undefined) => {
      if (!parent?.children || index === undefined || node.value === undefined) return;
      const { segments } = resolveBriefingReferences(node.value, gather);
      // Whole node is one plain span — nothing to expand.
      if (segments.length === 1 && segments[0]?.kind === "text") return;

      const replacement: MdNode[] = segments.map((segment) =>
        segment.kind === "text"
          ? { type: "text", value: segment.text }
          : {
              type: "briefingRef",
              // mdast-util-to-hast renders an unknown node carrying `data.hName`
              // as that element, with `hProperties` becoming its React props.
              data: {
                hName: "briefing-ref",
                hProperties: {
                  kind: segment.referenceKind,
                  label: segment.label,
                  ...(segment.href ? { href: segment.href } : {}),
                },
              },
            },
      );

      parent.children.splice(index, 1, ...replacement);
      // Resume past the nodes we just inserted.
      return index + replacement.length;
    });
  };
  return plugin as RemarkPlugin;
}

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
const BriefingLink: Components["a"] = ({ node: _node, href, title, children, className }) => {
  if (!href) return <span>{children}</span>;
  const brand = linkBrand(href);
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        "-mx-0.5 inline-flex items-center gap-1 whitespace-normal rounded-md px-1.5 align-middle font-medium leading-[1.2]",
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

/** Component overrides for briefing markdown: entity chips + glyphed links. */
export const briefingMarkdownComponents: Components = {
  // Custom element — outside react-markdown's intrinsic-tag typing, so cast.
  "briefing-ref": (props: { kind?: string; label?: string; href?: string }) => {
    const { kind, label, href } = props;
    if (!kind || !isBriefingReferenceKind(kind) || !label) return label ?? null;
    return <EntityChip kind={kind} label={label} href={href} />;
  },
  a: BriefingLink,
} as Components;
