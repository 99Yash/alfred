import { isNonEmptyString } from "@alfred/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { CodeBlock } from "./code-block";

function languageOf(className: string | undefined): string | undefined {
  if (className === undefined) return undefined;

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
    // react-markdown hands a fenced block's text to `<code>` as one string.
    const source = child.props.children;
    const code = (isNonEmptyString(source) ? source : "").replace(/\n$/, "");

    return <CodeBlock language={languageOf(child.props.className)} code={code} />;
  }

  return <pre>{children}</pre>;
};
