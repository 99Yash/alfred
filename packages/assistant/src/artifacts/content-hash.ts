import type { ArtifactContent } from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";

/** Concurrency token for full-body replacement, so an edit from a stale or partial view cannot erase content. */
export function artifactContentHash(content: ArtifactContent | null): string {
  return sha256Canonical(content);
}

/** Allow same-run edits, otherwise require an exact hash of the current body. */
export function artifactReplacementMatchesBase(input: {
  currentContent: ArtifactContent | null;
  rowRunId: string | null;
  editingRunId: string;
  baseContentHash?: string | undefined;
}): boolean {
  if (input.rowRunId === input.editingRunId) return true;

  return (
    input.baseContentHash !== undefined &&
    input.baseContentHash === artifactContentHash(input.currentContent)
  );
}
