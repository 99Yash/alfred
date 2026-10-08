import { type BriefingGather, resolveBriefingReferences } from "@alfred/contracts";
import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { visit } from "unist-util-visit";
import { BriefingLink, BriefingRef } from "./briefing-link";

type RemarkPlugin = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>[number];

/** The mdast fields we touch, so web needs no `mdast`/`unified` import. */
interface MdNode {
  type: string;
  value?: string | undefined;
  children?: MdNode[] | undefined;
  data?: Record<string, unknown> | undefined;
}

/**
 * Turn the composer's `[[<kind>:<id>]]` tokens (ADR-0049) into `briefing-ref`
 * elements, which {@link briefingMarkdownComponents} renders as `EntityChip`.
 * Tokens never contain markdown delimiters, so each stays in one `text` node.
 * Uses the shared contracts resolver, like the rail and email renderers.
 */
export function briefingRefsPlugin(gather: BriefingGather | null): RemarkPlugin {
  const plugin = () => (tree: MdNode) => {
    if (!gather) return;
    // SAFETY: the briefing tree is structurally the mdast tree `visit` expects.
    visit(tree as never, "text", (node: MdNode, index, parent: MdNode | undefined) => {
      if (!parent?.children || index === undefined || node.value === undefined) return;
      const { segments } = resolveBriefingReferences(node.value, gather);

      if (segments.length === 1 && segments[0]?.kind === "text") return;

      const replacement: MdNode[] = segments.map((segment) =>
        segment.kind === "text"
          ? { type: "text", value: segment.text }
          : {
              type: "briefingRef",
              // mdast-util-to-hast renders an unknown node with `data.hName` as that element.
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

      return index + replacement.length;
    });
  };

  // SAFETY: the transformer above has the remark-plugin signature.
  return plugin as RemarkPlugin;
}

export const briefingMarkdownComponents: Components =
  // SAFETY: `briefing-ref` is a custom element outside react-markdown's intrinsic tag typing.
  {
    "briefing-ref": BriefingRef,
    a: BriefingLink,
  } as Components;
