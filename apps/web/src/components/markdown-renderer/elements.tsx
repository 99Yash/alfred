import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { CodeBlock } from "./code-block";
import { CitationLink } from "./citation-link";

/**
 * Element overrides wired into ReactMarkdown's `components` map. Alfred styles
 * the common tags (h1–h6, p, ul, code, table…) through descendant selectors on
 * the renderer wrapper, so this map stays deliberately small: only the elements
 * that need *behaviour* beyond styling live here. Adding a new behavioural
 * element is a one-file, one-entry change.
 */

/** True when a markdown link's `title` opts it into citation-pill rendering. */
function isCitation(title: string | undefined): boolean {
  return title === "cite" || title?.startsWith("cite:") === true;
}

/**
 * Links: citation pills for `"cite"`-titled links, otherwise a plain external
 * link that never leaks the referrer and always opens in a new tab.
 */
const Anchor: Components["a"] = ({ node: _node, href, title, children, ...props }) => {
  if (href && isCitation(title)) {
    return <CitationLink href={href}>{children}</CitationLink>;
  }
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  );
};

/** Pull the `language-xxx` token react-markdown puts on the inner `<code>`. */
function languageOf(className: unknown): string | undefined {
  if (typeof className !== "string") return undefined;
  return /language-(\w+)/.exec(className)?.[1];
}

/**
 * Fenced/indented code: react-markdown nests the real content in a `<code>`
 * child of `<pre>`. We consume that child here and render a self-contained
 * `CodeBlock` (header + copy + highlighting) INSTEAD of a bare `<pre>`, so the
 * wrapper's `[&_pre]` styling never wraps the dark card. Inline code has no
 * `<pre>` parent, so it falls through to the wrapper's `[&_code]` styling.
 */
const Pre: Components["pre"] = ({ node: _node, children }) => {
  const child = Children.toArray(children).find((c) => isValidElement(c)) as
    | { props: { className?: string; children?: ReactNode } }
    | undefined;

  if (child) {
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    return <CodeBlock language={languageOf(child.props.className)} code={code} />;
  }

  // Defensive fallback for a `<pre>` that somehow isn't wrapping a code element.
  return <pre>{children}</pre>;
};

export const markdownComponents: Components = {
  a: Anchor,
  pre: Pre,
};
