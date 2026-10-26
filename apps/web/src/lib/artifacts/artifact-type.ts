import { typedEntries, type ArtifactKind, type ExternalFileSource } from "@alfred/contracts";
import type { SyncedArtifact } from "@alfred/sync";
import { FileText, Layers, type LucideIcon } from "lucide-react";

/** One Library type per artifact. `pages` splits on `format`; a null format reads as pdf. */
export type ArtifactType = "document" | "slides" | "pdf" | "spreadsheet" | "external_file";

export function artifactType(artifact: Pick<SyncedArtifact, "kind" | "format">): ArtifactType {
  switch (artifact.kind) {
    case "document":
      return "document";
    case "pages":
      return artifact.format === "slides" ? "slides" : "pdf";
    case "spreadsheet":
      return "spreadsheet";
    case "external_file":
      return "external_file";
    default: {
      const _exhaustive: never = artifact.kind;

      throw new Error(`Unhandled artifact kind: ${String(_exhaustive)}`);
    }
  }
}

/** Singular label, and the plural the Library filter offers. `plural: null` = no filter option. */
const ARTIFACT_TYPE_DISPLAY = {
  document: { label: "Document", plural: "Documents" },
  slides: { label: "Slides", plural: "Slides" },
  pdf: { label: "PDF document", plural: "PDF Documents" },
  // Reserved kind: nothing builds a spreadsheet, so the filter would always be empty.
  spreadsheet: { label: "Spreadsheet", plural: null },
  external_file: { label: "File", plural: "Files" },
} as const satisfies Record<ArtifactType, { label: string; plural: string | null }>;

/** A new source fails to compile here until it has a label. */
export const EXTERNAL_FILE_SOURCE_LABEL = {
  drive: "Google Drive",
} as const satisfies Record<ExternalFileSource, string>;

/** "Google Drive file" for a Drive pointer; the table label for every other artifact. */
export function artifactTypeLabel(
  artifact: Pick<SyncedArtifact, "kind" | "format" | "content">,
): string {
  if (artifact.content?.kind === "external_file") {
    return `${EXTERNAL_FILE_SOURCE_LABEL[artifact.content.source]} file`;
  }

  return ARTIFACT_TYPE_DISPLAY[artifactType(artifact)].label;
}

/** Library filter options in table order, without the types that have no plural. */
export const ARTIFACT_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: ArtifactType; label: string }> =
  typedEntries(ARTIFACT_TYPE_DISPLAY).flatMap(([value, { plural }]) =>
    plural === null ? [] : [{ value, label: plural }],
  );

/** The chat and viewer kind icon. A new kind fails to compile here until it has an icon. */
export const ARTIFACT_KIND_ICON = {
  document: FileText,
  pages: Layers,
  spreadsheet: FileText,
  external_file: FileText,
} as const satisfies Record<ArtifactKind, LucideIcon>;
