import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

/**
 * Last-resort panel: the raw preview, pretty-printed and colored with app tokens.
 * Not `CodeBlock`, which is a dark card in both themes.
 * Not Prism: `react-syntax-highlighter` emits inline styles that CSS variables cannot theme.
 */

/** A string (with an optional key `:`), a keyword, or a number. Unmatched text passes through as punctuation. */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

interface JsonToken {
  text: string;
  className: string;
}

function tokenizeJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;

  for (const match of json.matchAll(JSON_TOKEN)) {
    const start = match.index;

    if (start > last) tokens.push({ text: json.slice(last, start), className: "text-app-fg-2" });
    const [whole, string, colon, keyword, number] = match;

    if (string !== undefined) {
      // Keys get the strongest ink.
      tokens.push(
        colon
          ? { text: string, className: "font-medium text-app-fg-4" }
          : { text: string, className: "text-app-green-4" },
      );

      if (colon) tokens.push({ text: colon, className: "text-app-fg-2" });
    } else if (keyword !== undefined) {
      tokens.push({ text: keyword, className: "text-app-purple-4" });
    } else if (number !== undefined) {
      tokens.push({ text: number, className: "text-app-blue-4" });
    }

    last = start + whole.length;
  }

  if (last < json.length) tokens.push({ text: json.slice(last), className: "text-app-fg-2" });

  return tokens;
}

export function ToolResultJson({
  json,
  /** Plain text: do not tokenize. */
  plain = false,
}: {
  json: string;
  plain?: boolean | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (copied) return;
    // Clipboard rejects in insecure contexts; swallow it.
    navigator.clipboard.writeText(json).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="group/json relative overflow-hidden rounded-lg bg-app-bg-a1">
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy result"}
        title={copied ? "Copied" : "Copy result"}
        className={cn(
          "absolute top-1.5 right-1.5 z-10 grid size-6 place-items-center rounded-md",
          "bg-app-bg-2 text-app-fg-2 opacity-0 transition-[opacity,color] duration-150",
          "group-hover/json:opacity-100 focus-visible:opacity-100",
          "hover:text-app-fg-4 focus-visible:ring-2 focus-visible:ring-app-fg-2 focus-visible:outline-none",
        )}
      >
        <span className="relative grid size-3.5 place-items-center">
          <Copy
            size={12}
            aria-hidden
            className={cn("absolute transition-opacity duration-150", copied && "opacity-0")}
          />
          <Check
            size={12}
            aria-hidden
            className={cn(
              "absolute text-app-green-4 transition-opacity duration-150",
              copied ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
      </button>
      {/* Capped so a long result does not push the reply out of reach. */}
      <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap">
        {plain ? (
          <span className="text-app-fg-3">{json}</span>
        ) : (
          tokenizeJson(json).map((token, i) => (
            // Tokens have no identity, and the list re-derives when the text changes.
            <span key={i} className={token.className}>
              {token.text}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}
