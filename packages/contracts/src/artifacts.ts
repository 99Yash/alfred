import { z } from "zod";

/** Artifact shapes the boss authors and the chat sidebar renders (ADR-0075). */

/**
 * Selects the renderer. `spreadsheet` is reserved: nothing renders or builds it yet.
 * `external_file` points at a file the agent could not read, so the user opens it.
 */
export const artifactKindValues = ["document", "pages", "spreadsheet", "external_file"] as const;

export type ArtifactKind = (typeof artifactKindValues)[number];

export const artifactKindSchema = z.enum(artifactKindValues);

/** Page shape for `kind: "pages"`: `slides` is 16:9, `pdf` is portrait US Letter. */
export const artifactFormatValues = ["slides", "pdf"] as const;

export type ArtifactFormat = (typeof artifactFormatValues)[number];

export const artifactFormatSchema = z.enum(artifactFormatValues);

/** `error` can still hold partial content. */
export const artifactStatusValues = ["generating", "complete", "error"] as const;

export type ArtifactStatus = (typeof artifactStatusValues)[number];

export const artifactStatusSchema = z.enum(artifactStatusValues);

/**
 * Limit on a document's total stored markdown (ADR-0085). `.$type<>()` does not
 * check at runtime, so `write.ts` checks this by hand.
 */
export const DOCUMENT_MARKDOWN_MAX = 500_000;

/**
 * Markdown limit for one `create_artifact` or `append_artifact_section` call (ADR-0085).
 * About 75s of output, under half the 180s stream limit. The tool description,
 * not this cap, is what makes the model write in sections.
 */
export const ARTIFACT_SECTION_MAX_CHARS = 15_000;

/** One page of a `kind: "pages"` artifact: a title + body-level HTML. */
export const artifactPageSchema = z.object({
  /** Short page title, shown on the thumbnail and the page chrome. */
  title: z.string().max(200),
  /** Body-level HTML only. The renderer adds the shell, scripts, fonts, and page geometry. */
  html: z.string().max(200_000),
});

export type ArtifactPage = z.infer<typeof artifactPageSchema>;

/** Providers whose files the agent can surface inline when it can't read them. */
export const externalFileSourceValues = ["drive"] as const;

export type ExternalFileSource = (typeof externalFileSourceValues)[number];

export const externalFileSourceSchema = z.enum(externalFileSourceValues);

/** A pointer to an external file, not authored content. */
export const externalFileContentSchema = z.object({
  kind: z.literal("external_file"),
  source: externalFileSourceSchema,
  fileId: z.string(),
  /** Embeddable in a sandboxed iframe, for example Drive `/preview`. */
  previewUrl: z.url(),
  webViewLink: z.url().optional(),
  mimeType: z.string().max(255).optional(),
  /** Can differ from the artifact `title`. */
  fileName: z.string().max(500).optional(),
});

export type ExternalFileContent = z.infer<typeof externalFileContentSchema>;

/** No `spreadsheet` variant yet, so nothing can build one. */
export const artifactContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), markdown: z.string().max(DOCUMENT_MARKDOWN_MAX) }),
  z.object({ kind: z.literal("pages"), pages: z.array(artifactPageSchema).max(100) }),
  externalFileContentSchema,
]);

export type ArtifactContent = z.infer<typeof artifactContentSchema>;

/** Empty content for a freshly-created artifact of the given kind. */
export function emptyArtifactContent(kind: ArtifactKind): ArtifactContent {
  if (kind === "pages") return { kind: "pages", pages: [] };

  // `spreadsheet` has no content variant and nothing creates one.
  return { kind: "document", markdown: "" };
}
