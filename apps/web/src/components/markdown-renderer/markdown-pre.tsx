import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { CodeBlock } from "./code-block";

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
export const MarkdownPre: Components["pre"] = ({ node: _node, children }) => {
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
