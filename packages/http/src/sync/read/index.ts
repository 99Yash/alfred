import { IDB_KEY_NAMES, type IDBKeys } from "@alfred/sync";
import { fetchActionPolicies } from "./action-policies";
import { fetchActionStagings } from "./action-stagings";
import { fetchArtifacts } from "./artifacts";
import { fetchBriefings } from "./briefings";
import { fetchChatAttachments, fetchChatMessages, fetchChatThreads } from "./chat";
import type { EntityFetcher } from "./entity-row";
import { fetchFacts } from "./facts";
import { fetchNotes } from "./notes";
import { fetchPreferences } from "./preferences";
import { fetchSkillRevisions, fetchSkillRuns, fetchSkills } from "./skills";
import { fetchTodos } from "./todos";
import { fetchTriageTags } from "./triage-tags";
import { fetchWorkflows } from "./workflows";

export type { EntityRow } from "./entity-row";

/**
 * Per-entity read model for Replicache pull, one file per domain.
 *
 * `satisfies Record<IDBKeys, EntityFetcher>` is load-bearing: adding a key to
 * `SYNC_MODEL` (which defines `IDBKeys`) forces a fetcher here, so server pull
 * cannot silently forget a client-visible entity. This is the ONLY place the
 * check runs, and it is the only way a fetcher becomes reachable — no domain
 * file is imported anywhere else in `src/`.
 */
export const ENTITY_FETCHERS = {
  NOTE: fetchNotes,
  FACT: fetchFacts,
  BRIEFING: fetchBriefings,
  PREFERENCE: fetchPreferences,
  SKILL: fetchSkills,
  SKILL_REVISION: fetchSkillRevisions,
  SKILL_RUN: fetchSkillRuns,
  ACTION_STAGING: fetchActionStagings,
  ACTION_POLICY: fetchActionPolicies,
  WORKFLOW: fetchWorkflows,
  TODO: fetchTodos,
  CHAT_THREAD: fetchChatThreads,
  CHAT_MESSAGE: fetchChatMessages,
  CHAT_ATTACHMENT: fetchChatAttachments,
  ARTIFACT: fetchArtifacts,
  TRIAGE_TAG: fetchTriageTags,
} satisfies Record<IDBKeys, EntityFetcher>;

// Built from `IDB_KEY_NAMES`, NOT from `Object.entries(ENTITY_FETCHERS)`: this
// map order is the patch-operation order, and `Object.entries` would take it
// from the literal above instead.
export const SYNC_ENTITIES = IDB_KEY_NAMES.map((slug) => ({
  slug,
  fetchRows: ENTITY_FETCHERS[slug],
}));
