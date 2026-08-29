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

export type EntityFetchers = {
  [Slug in IDBKeys]: EntityFetcher<Slug>;
};

/**
 * Per-entity read model for Replicache pull, one file per domain.
 *
 * `satisfies EntityFetchers` is load-bearing: adding a key to `SYNC_MODEL`
 * forces a fetcher here, and each slot accepts only the fetcher for that slug.
 * Server pull therefore cannot forget an entity or pair (for example) the
 * FACT reader with NOTE. This is the only way a fetcher becomes reachable.
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
} satisfies EntityFetchers;

// Built from `IDB_KEY_NAMES`, NOT from `Object.entries(ENTITY_FETCHERS)`: this
// map order is the patch-operation order, and `Object.entries` would take it
// from the literal above instead.
export const SYNC_ENTITIES = IDB_KEY_NAMES.map((slug) => ({
  slug,
  fetchRows: ENTITY_FETCHERS[slug],
}));
