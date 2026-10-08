import { createContext, use, type ReactNode } from "react";

/**
 * Marks the public `/c/$slug` transcript (ADR-0102), so markdown under it shows alt text, not remote images.
 * Else a tracker image fires one request per visitor, from the visitor's IP (see #294).
 * A context, not a prop: three markdown surfaces render there, some deep below `MessageBubble`.
 * Default `false`, so a new surface on the public page must be wrapped.
 */
const PublishedTranscriptContext = createContext(false);

/** Everything inside renders alt text, not images. */
export function PublishedTranscript({ children }: { children: ReactNode }) {
  return (
    <PublishedTranscriptContext.Provider value={true}>
      {children}
    </PublishedTranscriptContext.Provider>
  );
}

/** Pass to `MarkdownRenderer`'s `images`, or to `altTextImageComponents` when using `ReactMarkdown` directly. */
export function useMarkdownImageMode(): "render" | "alt-text" {
  return use(PublishedTranscriptContext) ? "alt-text" : "render";
}
