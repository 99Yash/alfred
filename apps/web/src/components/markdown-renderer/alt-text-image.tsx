import type { Components } from "react-markdown";
import { cn } from "~/lib/utils";

/**
 * `img` override for `images="alt-text"`: prints the alt text, never an `<img>`.
 * Shared so every renderer applies the same rule. The placeholder follows `tone`.
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
