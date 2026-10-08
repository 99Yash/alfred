import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { SyntaxHighlighter } from "./syntax-highlighter";

interface CodeBlockProps {
  language?: string | undefined;
  code: string;
}

/** Dark code card with a language label and copy. Theme-independent; see `syntax-highlighter.tsx`. */
export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (copied) return;
    // Clipboard rejects in insecure contexts; do not throw from a handler.
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div
      data-type="code-block"
      className={cn(
        "not-prose my-2 overflow-hidden rounded-lg",
        "border border-white/10 bg-[#111317]",
        "shadow-[0_0_0_0.5px_rgba(0,0,0,0.4)]",
      )}
    >
      <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] px-2.5 py-1">
        <span className="font-mono text-[10.5px] tracking-wide text-white/45 lowercase">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          className={cn(
            "grid size-6 place-items-center rounded-md",
            "text-white/55 transition-colors",
            "hover:bg-white/10 hover:text-white/90",
            "focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none",
          )}
        >
          <span className="relative grid size-3.5 place-items-center">
            <Copy
              size={13}
              className={cn(
                "absolute transition-opacity duration-150",
                copied ? "opacity-0" : "opacity-100",
              )}
            />
            <Check
              size={13}
              className={cn(
                "absolute transition-opacity duration-150",
                copied ? "opacity-100" : "opacity-0",
              )}
            />
          </span>
        </button>
      </div>
      <div className="px-3 py-2.5">
        <SyntaxHighlighter language={language} code={code} />
      </div>
    </div>
  );
}
