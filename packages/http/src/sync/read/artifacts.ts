import { artifacts, type Artifact } from "@alfred/db/schemas";
import { desc, eq } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

/** Most-recent agent-produced artifacts synced per user (ADR-0075). */
const ARTIFACT_PULL_LIMIT = 200;

// Agent-produced artifacts (ADR-0075). Flat per-user pull bounded to the most
// recent ARTIFACT_PULL_LIMIT; the sidebar filters by threadId client-side. A
// `generating` row syncs too (content may still be null) so the sidebar can
// render the placeholder while the boss authors.
export const fetchArtifacts = syncEntity<"ARTIFACT", Artifact>("ARTIFACT", {
  query: (tx, userId) =>
    tx
      .select()
      .from(artifacts)
      .where(eq(artifacts.userId, userId))
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(ARTIFACT_PULL_LIMIT),
  map: (a) => a,
});
