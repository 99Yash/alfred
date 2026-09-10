import type { ArtifactContent } from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";

/**
 * Optimistic-concurrency token for full artifact-body replacements.
 *
 * Cross-turn edits must prove which complete body they were based on. Without
 * this token, a model working from omitted, truncated, or stale content could
 * silently replace the canonical row and lose everything it never saw.
 */
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
