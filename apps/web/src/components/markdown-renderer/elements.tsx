import type { Components } from "react-markdown";
import { MarkdownAnchor } from "./markdown-anchor";
import { MarkdownPre } from "./markdown-pre";

/**
 * Element overrides wired into ReactMarkdown's `components` map. Alfred styles
 * the common tags (h1–h6, p, ul, code, table…) through descendant selectors on
 * the renderer wrapper, so this map stays deliberately small: only the elements
 * that need *behaviour* beyond styling live here. Adding a new behavioural
 * element is a one-file, one-entry change.
 */

export const markdownComponents: Components = {
  a: MarkdownAnchor,
  pre: MarkdownPre,
};
