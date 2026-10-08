import type { Components } from "react-markdown";
import { MarkdownAnchor } from "./markdown-anchor";
import { MarkdownPre } from "./markdown-pre";

/** ReactMarkdown overrides, only for tags that need behavior. Styling lives in the wrapper's selectors. */

export const markdownComponents: Components = {
  a: MarkdownAnchor,
  pre: MarkdownPre,
};
