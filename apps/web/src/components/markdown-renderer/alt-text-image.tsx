import type { Components } from "react-markdown";
import { cn } from "~/lib/utils";

/**
 * The `img` override that turns `images="alt-text"` into a real guarantee: it
 * emits the alt text in brackets and NEVER an `<img>`, so no remote request
 * leaves the page.
 *
 * It is exported because two renderers need the identical rule.
 * {@link MarkdownRenderer} applies it through its `images` prop, and the chat
 * reply's `AssistantMarkdown` drives `ReactMarkdown` directly, so it merges
 * this into its own component registry. A second hand-written copy would let
 * one of the two surfaces keep loading remote images after the other stopped.
 *
 * The placeholder follows `tone`. Fixed white is invisible on a light app
 * surface, which the inbox Reader never hit because it renders on the dark
 * media backdrop.
 */
export function altTextImageComponents(tone: "surface" | "media" = "surface"): Components {
  return {
    img: ({ alt }) =>
      alt ? (
        <span className={cn("italic", tone === "media" ? "text-white/55" : "text-app-fg-2")}>
          [{alt}]
        </span>
      ) : null,
  };
}
