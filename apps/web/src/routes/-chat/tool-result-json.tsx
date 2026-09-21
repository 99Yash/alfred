import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";

/**
 * The last-resort panel for a tool result no evidence spec maps: the raw
 * preview, pretty-printed and lightly colored.
 *
 * Deliberately NOT the markdown `CodeBlock`. That block is a fixed dark card in
 * both themes, which is the right call for code inside a reply — it is a
 * quoted artifact and reads as one. A tool result is neither quoted nor code:
 * it sits inside the activity trail, one row below a light evidence list, and a
 * black slab there reads as a different app. So this surface takes its colors
 * from the app tokens and follows the theme like everything around it.
 *
 * The coloring is a small local tokenizer rather than the Prism highlighter for
 * the same reason: `react-syntax-highlighter` emits inline styles, which no CSS
 * variable can reach, so a themed block is impossible through it. JSON needs
 * four token classes, which is small enough to own here.
 */

/**
 * One pass over pretty-printed JSON: a string (with the `:` that would make it
 * a key), a keyword, or a number. Everything the pattern does not match —
 * braces, commas, whitespace — falls through as plain punctuation, so the
 * tokenizer can never lose input.
 */
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
      // A string followed by `:` is a key — the thing a reader scans for — so
      // it gets the strongest ink; a string value stays a value color.
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
  /** Plain text, not JSON: render it unstyled rather than tokenizing prose. */
  plain = false,
}: {
  json: string;
  plain?: boolean | undefined;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (copied) return;
    // Clipboard API rejects in insecure contexts — swallow rather than throw
    // inside a render-driven handler.
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
      {/* Capped rather than unbounded: an unmapped result can run to hundreds
          of lines, and a trail row is not the place to scroll past one. The
          cap keeps the reply below it reachable. */}
      <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap">
        {plain ? (
          <span className="text-app-fg-3">{json}</span>
        ) : (
          tokenizeJson(json).map((token, i) => (
            // A tokenizer's output has no domain identity to key by; the index
            // IS the identity here, and the list is fully re-derived whenever
            // the text changes.
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className={token.className}>
              {token.text}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}
