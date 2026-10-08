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

// `PrismAsyncLight` has no grammars by default; register only the ones worth the bundle.
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
  language?: string | undefined;
  code: string;
}

/**
 * Fixed dark theme in both app themes: the highlighter emits inline styles,
 * which cannot follow a `.dark` class. Long lines wrap to fit the rail.
 */
export function SyntaxHighlighter({ language, code }: SyntaxHighlighterProps) {
  return (
    <PrismAsyncLight
      // An undefined language makes `PrismAsyncLight` throw and crash the page.
      language={language || "text"}
      style={coldarkDark}
      // Inline style beats the wrapper's `[&_pre]` selectors; CodeBlock owns the chrome.
      customStyle={{
        margin: 0,
        padding: 0,
        background: "transparent",
        // An ancestor sets `--md-code-fs` (chat uses 13px); the var inherits into this inline style.
        fontSize: "var(--md-code-fs, 11.5px)",
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
