import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { CodeBlock } from "./code-block";

function languageOf(className: unknown): string | undefined {
  if (typeof className !== "string") return undefined;

  return /language-(\w+)/.exec(className)?.[1];
}

/**
 * Replace `<pre><code>` with a `CodeBlock`, so the wrapper's `[&_pre]` styles
 * never touch the card. Inline code has no `<pre>` and keeps `[&_code]`.
 */
export const MarkdownPre: NonNullable<Components["pre"]> = ({ node: _node, children }) => {
  // SAFETY: isValidElement narrows to an element whose props carry className/children.
  const child = Children.toArray(children).find((c) => isValidElement(c)) as
    | { props: { className?: string; children?: ReactNode } }
    | undefined;

  if (child) {
    const code = String(child.props.children ?? "").replace(/\n$/, "");

    return <CodeBlock language={languageOf(child.props.className)} code={code} />;
  }

  return <pre>{children}</pre>;
};
