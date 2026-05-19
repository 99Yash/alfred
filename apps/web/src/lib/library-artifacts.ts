export type ArtifactType = "presentation" | "document" | "spreadsheet" | "pdf";

export type LibraryArtifact = {
  id: string;
  title: string;
  type: ArtifactType;
  typeLabel: string;
  updatedLabel: string;
  favourite: boolean;
  summary: string;
  pages: ReadonlyArray<{
    title: string;
    kicker: string;
    body: string;
  }>;
};

export const LIBRARY_ARTIFACTS: ReadonlyArray<LibraryArtifact> = [
  {
    id: "morning-briefing-sample",
    title: "Morning briefing sample",
    type: "pdf",
    typeLabel: "PDF Document",
    updatedLabel: "Today",
    favourite: true,
    summary: "A compact briefing artifact with the same page-stack viewer used by chat outputs.",
    pages: [
      {
        title: "Morning Briefing",
        kicker: "Tuesday",
        body: "You have 3 meetings and 23 emails. The inbox is quiet except for two same-day replies and one contract thread that needs review before lunch.",
      },
      {
        title: "To Do",
        kicker: "Action plan",
        body: "Review the follow-up from David, approve the draft response for the pricing thread, and prepare talking points before the afternoon pipeline sync.",
      },
    ],
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
