import { SYCAMORE_BRIEF_PAGES, type ArtifactPage } from "~/lib/artifact-pages";

export type ArtifactType = "presentation" | "document" | "spreadsheet" | "pdf";

export type LibraryArtifact = {
  id: string;
  title: string;
  type: ArtifactType;
  typeLabel: string;
  updatedLabel: string;
  favourite: boolean;
  summary: string;
  pages: ReadonlyArray<ArtifactPage>;
};

export const LIBRARY_ARTIFACTS: ReadonlyArray<LibraryArtifact> = [
  {
    id: "morning-briefing-sample",
    title: "Morning briefing sample",
    type: "pdf",
    typeLabel: "PDF Document",
    updatedLabel: "Today",
    favourite: true,
    summary:
      "The archived Sycamore research PDF, rendered from Dimension's captured iframe srcdoc pages.",
    pages: SYCAMORE_BRIEF_PAGES,
  },
  {
    id: "weekly-pipeline-notes",
    title: "Weekly pipeline notes",
    type: "document",
    typeLabel: "Document",
    updatedLabel: "Yesterday",
    favourite: false,
    summary: "A generated document preview for the Library card and standalone reader.",
    pages: [
      {
        title: "Pipeline Notes",
        kicker: "Summary",
        body: "Open enterprise conversations are clustered around security review, implementation timing, and stakeholder alignment.",
      },
    ],
  },
];

export function getArtifact(id: string): LibraryArtifact | undefined {
  return LIBRARY_ARTIFACTS.find((artifact) => artifact.id === id);
}

export function matchesArtifact(artifact: LibraryArtifact, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${artifact.title} ${artifact.typeLabel} ${artifact.summary}`
    .toLowerCase()
    .includes(needle);
}

export function artifactMatchesType(artifact: LibraryArtifact, selectedTypes: Set<ArtifactType>) {
  return selectedTypes.size === 0 || selectedTypes.has(artifact.type);
}
