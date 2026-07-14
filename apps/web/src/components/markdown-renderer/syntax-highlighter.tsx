import { PrismAsyncLight } from "react-syntax-highlighter";
import { coldarkDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

// `PrismAsyncLight` ships zero grammars by default — we register only the
// languages worth the bundle weight for an assistant that talks code, email,
// and config. `tsx` covers the whole JS/TS family; everything else is the long
// tail Alfred actually pastes (shell snippets, SQL, JSON/YAML config, diffs).
PrismAsyncLight.registerLanguage("javascript", tsx);
PrismAsyncLight.registerLanguage("js", tsx);
PrismAsyncLight.registerLanguage("jsx", tsx);
PrismAsyncLight.registerLanguage("typescript", tsx);
PrismAsyncLight.registerLanguage("ts", tsx);
PrismAsyncLight.registerLanguage("tsx", tsx);
PrismAsyncLight.registerLanguage("python", python);
PrismAsyncLight.registerLanguage("py", python);
PrismAsyncLight.registerLanguage("sql", sql);
PrismAsyncLight.registerLanguage("json", json);
PrismAsyncLight.registerLanguage("bash", bash);
PrismAsyncLight.registerLanguage("sh", bash);
PrismAsyncLight.registerLanguage("shell", bash);
PrismAsyncLight.registerLanguage("yaml", yaml);
PrismAsyncLight.registerLanguage("yml", yaml);
PrismAsyncLight.registerLanguage("css", css);
PrismAsyncLight.registerLanguage("diff", diff);
PrismAsyncLight.registerLanguage("html", markup);
PrismAsyncLight.registerLanguage("xml", markup);

interface SyntaxHighlighterProps {
  language?: string;
  code: string;
}

/**
 * Code blocks render on a FIXED dark surface regardless of the app theme —
 * same call dimension makes, and the same one ChatGPT/Claude make. A theme that
 * recolors with `.dark` is impossible here anyway: react-syntax-highlighter
 * emits inline styles, which can't respond to a CSS class. A single dark theme
 * (`coldarkDark`) keeps code legible and self-contained in both light and dark.
 *
 * `whiteSpace: pre-wrap` + `wrapLongLines` keep long lines inside the narrow
 * rail instead of forcing a horizontal scrollbar the rail has no room for.
 */
export function SyntaxHighlighter({ language, code }: SyntaxHighlighterProps) {
  return (
    <PrismAsyncLight
      // A fenced block with no language leaves `language` undefined, which makes
      // `PrismAsyncLight` throw (`Expected string for aliasOrLanguage`) and takes
      // the whole page down via the error boundary. Fall back to a plain, always-
      // safe token — an unregistered grammar just renders unhighlighted.
      language={language || "text"}
      style={coldarkDark}
      // `customStyle` is inline, so it overrides the wrapper's `[&_pre]` Tailwind
      // selectors (background/padding/margin) — the dark CodeBlock owns the chrome.
      customStyle={{
        margin: 0,
        padding: 0,
        background: "transparent",
        fontSize: "11.5px",
        lineHeight: 1.55,
      }}
      wrapLongLines
      codeTagProps={{
        style: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        },
      }}
    >
      {code}
    </PrismAsyncLight>
  );
}
