import type { SyncedArtifact } from "@alfred/sync";

export type ArtifactType = "document" | "pdf" | "slides";

export function artifactType(artifact: SyncedArtifact): ArtifactType {
  if (artifact.kind === "document") return "document";
  return artifact.format === "slides" ? "slides" : "pdf";
}

export function artifactTypeLabel(artifact: SyncedArtifact): string {
  const type = artifactType(artifact);
  if (type === "slides") return "Slides";
  if (type === "pdf") return "PDF document";
  return "Document";
}

export function artifactMatchesType(
  artifact: SyncedArtifact,
  selectedTypes: Set<ArtifactType>,
): boolean {
  return selectedTypes.size === 0 || selectedTypes.has(artifactType(artifact));
}

export function artifactMatchesQuery(artifact: SyncedArtifact, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${artifact.title} ${artifactTypeLabel(artifact)} ${artifact.status}`
    .toLowerCase()
    .includes(needle);
}

export function formatArtifactDate(artifact: SyncedArtifact): string {
  const timestamp = artifact.updatedAt ?? artifact.createdAt;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
