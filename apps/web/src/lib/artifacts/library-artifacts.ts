import { SYCAMORE_BRIEF_PAGES, type ArtifactPage } from "~/lib/artifacts/artifact-pages";

// Library display taxonomy — deliberately NOT the storage `ArtifactKind`
// (`document`/`pages`/`spreadsheet`) from `@alfred/contracts`. It flattens
// kind + format into the user-facing categories the Library filter is built on
// (`presentation`/`pdf` are formats, not kinds), so it evolves independently.
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
  {
    id: "q2-hiring-readout",
    title: "Q2 hiring readout",
    type: "presentation",
    typeLabel: "Presentation",
    updatedLabel: "2 days ago",
    favourite: true,
    summary: "A generated hiring update deck with team priorities and interview pipeline notes.",
    pages: [
      {
        title: "Hiring Readout",
        kicker: "Q2 Planning",
        body: "Pipeline quality is strongest in backend and applied AI roles, with bottlenecks around final-loop scheduling and rubric consistency.",
      },
    ],
  },
  {
    id: "workspace-cost-review",
    title: "Workspace cost review",
    type: "spreadsheet",
    typeLabel: "Spreadsheet",
    updatedLabel: "Last week",
    favourite: false,
    summary:
      "A generated spreadsheet-style review of workspace usage, vendors, and renewal timing.",
    pages: [
      {
        title: "Cost Review",
        kicker: "Workspace Operations",
        body: "Vendor spend is concentrated across communication, AI tooling, and storage. Renewal risk is highest for overlapping productivity tools.",
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
