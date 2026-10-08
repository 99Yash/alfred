import type { Components } from "react-markdown";
import { CitationLink } from "./citation-link";

function isCitation(title: string | undefined): boolean {
  return title === "cite" || title?.startsWith("cite:") === true;
}

/** `"cite"`-titled links become pills; others open in a new tab with no referrer. */
export const MarkdownAnchor: NonNullable<Components["a"]> = ({
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
