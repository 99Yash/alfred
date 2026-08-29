import { artifacts, type Artifact } from "@alfred/db/schemas";
import { syncedArtifactSchema, type SyncedArtifact } from "@alfred/sync";
import { desc, eq } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

/** Most-recent agent-produced artifacts synced per user (ADR-0075). */
const ARTIFACT_PULL_LIMIT = 200;

// `storageKey` is server-only (R2 seam) — zod strips it. `content` may be null
// on a freshly-created `generating` row; schema defaults null.
const serializeArtifact = defineSerializer<Artifact, SyncedArtifact>(syncedArtifactSchema);

// Agent-produced artifacts (ADR-0075). Flat per-user pull bounded to the most
// recent ARTIFACT_PULL_LIMIT; the sidebar filters by threadId client-side. A
// `generating` row syncs too (content may still be null) so the sidebar can
// render the placeholder while the boss authors.
export const fetchArtifacts = defineFetcher<Artifact>({
  slug: "ARTIFACT",
  query: (tx, userId) =>
    tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.userId, userId))
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(ARTIFACT_PULL_LIMIT),
  idOf: (a) => a.id,
  versionOf: (a) => a.rowVersion,
  serialize: serializeArtifact,
});
