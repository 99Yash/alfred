import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";
import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { visit } from "unist-util-visit";
import { BriefingLink, BriefingRef } from "./briefing-link";

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

/** Component overrides for briefing markdown: entity chips + glyphed links. */
export const briefingMarkdownComponents: Components = {
  // Custom element — outside react-markdown's intrinsic-tag typing, so cast.
  "briefing-ref": BriefingRef,
  a: BriefingLink,
} as Components;
