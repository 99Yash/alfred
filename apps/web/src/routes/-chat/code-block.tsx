import { Check, Copy } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "~/lib/utils";

for (const [name, lang] of [
  ["js", tsx],
  ["jsx", tsx],
  ["ts", tsx],
  ["tsx", tsx],
  ["python", python],
  ["py", python],
  ["bash", bash],
  ["sh", bash],
  ["shell", bash],
  ["json", json],
  ["sql", sql],
  ["css", css],
  ["yaml", yaml],
  ["yml", yaml],
  ["html", markup],
  ["xml", markup],
] as const) {
  SyntaxHighlighter.registerLanguage(name, lang);
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    [],
  );
  const onCopy = () => {
    if (copied) return;
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null;
          setCopied(false);
        }, 1500);
      },
      () => {
        /* clipboard can fail in insecure contexts — no-op */
      },
    );
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      className="flex size-6 items-center justify-center rounded text-app-fg-3 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4"
    >
      {copied ? <Check size={13} className="text-app-green-4" /> : <Copy size={13} />}
    </button>
  );
}

/** Pull the raw text + language out of the `<code>` child react-markdown nests in `<pre>`. */
function extract(children: ReactNode): { code: string; language?: string } {
  const node = Children.toArray(children).find((c) => isValidElement(c));
  if (!isValidElement(node)) return { code: String(children ?? "") };
  const props = node.props as { className?: string; children?: ReactNode };
  const match = /language-([\w-]+)/.exec(props.className ?? "");
  const code = String(props.children ?? "").replace(/\n$/, "");
  return { code, language: match?.[1] };
}

/** `pre` renderer for assistant markdown: a header (language + copy) over a highlighted body. */
export function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const { code, language } = extract(children);
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-app-fg-a1/50 bg-[#0b0b0f]">
      <div className="flex items-center justify-between border-b border-app-fg-a1/40 px-3 py-1">
        <span className="font-mono text-[11px] lowercase text-app-fg-3">{language ?? "text"}</span>
        <CopyButton code={code} />
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "12px",
          fontSize: 13,
        }}
        codeTagProps={{ className: "font-mono" }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

/** `code` renderer: inline code only — fenced blocks are handled by `CodeBlock` via `pre`. */
export function InlineCode({ className, children, ...rest }: ComponentPropsWithoutRef<"code">) {
  return (
    <code className={cn(className)} {...rest}>
      {children}
    </code>
  );
}
