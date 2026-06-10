import type { Components } from "react-markdown";
import { CitationLink } from "./citation-link";

/** True when a markdown link's `title` opts it into citation-pill rendering. */
function isCitation(title: string | undefined): boolean {
  return title === "cite" || title?.startsWith("cite:") === true;
}

/**
 * Links: citation pills for `"cite"`-titled links, otherwise a plain external
 * link that never leaks the referrer and always opens in a new tab.
 */
export const MarkdownAnchor: Components["a"] = ({
  node: _node,
  href,
  title,
  children,
  ...props
}) => {
  if (href && isCitation(title)) {
    return <CitationLink href={href}>{children}</CitationLink>;
  }
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  );
};
