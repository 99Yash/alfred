import { createContext, use, type ReactNode } from "react";

/**
 * Marks the subtree that renders a PUBLISHED transcript — the signed-out
 * `/c/$slug` page (ADR-0102) — so every markdown surface under it stops
 * loading remote images.
 *
 * The reason is the same one behind `images="alt-text"` in the inbox Reader
 * (#294), but it bites harder here. A published page is opened by strangers,
 * and a `![](https://tracker/…)` that the model or the owner wrote into the
 * transcript would fire one request per visitor, from the visitor's own IP, to
 * a host the owner never vetted. The snapshot cannot strip the markdown — the
 * text IS the conversation — so the RENDERER refuses instead, and the alt text
 * stays on the page so the reader still sees that an image was meant to be
 * there.
 *
 * This is a context and not a prop because three markdown surfaces render on
 * that page and two of them sit two components below `MessageBubble`:
 * `AssistantMarkdown` (the reply), `ChatProse` (reasoning and narration), and
 * `MarkdownRenderer` (an artifact body). Threading a prop through would mean
 * four new parameters on components the owner's chat also uses, and any one of
 * them left unthreaded is a silent leak.
 *
 * The default is `false`, so the owner's own chat is unaffected and a surface
 * added later is safe only inside the provider. That default is the right way
 * round: a new markdown surface on the public page must be wrapped to be safe,
 * which is a visible omission, rather than being safe until someone remembers
 * to opt in.
 */
const PublishedTranscriptContext = createContext(false);

/** Wrap the published transcript. Everything inside renders alt text, not images. */
export function PublishedTranscript({ children }: { children: ReactNode }) {
  return (
    <PublishedTranscriptContext.Provider value={true}>
      {children}
    </PublishedTranscriptContext.Provider>
  );
}

/**
 * How the markdown surface below should treat images. Feed it straight into
 * `MarkdownRenderer`'s `images` prop, or into `altTextImageComponents` when the
 * surface drives `ReactMarkdown` itself.
 */
export function useMarkdownImageMode(): "render" | "alt-text" {
  return use(PublishedTranscriptContext) ? "alt-text" : "render";
}
