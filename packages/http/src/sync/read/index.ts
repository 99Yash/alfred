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

/** `satisfies EntityFetchers` forces one fetcher per `SYNC_MODEL` key, each matched to its slug. */
export const ENTITY_FETCHERS = {
  note: fetchNotes,
  fact: fetchFacts,
  briefing: fetchBriefings,
  pref: fetchPreferences,
  skill: fetchSkills,
  skillrev: fetchSkillRevisions,
  skillrun: fetchSkillRuns,
  actionstaging: fetchActionStagings,
  actionpolicy: fetchActionPolicies,
  workflow: fetchWorkflows,
  todo: fetchTodos,
  chatthread: fetchChatThreads,
  chatmsg: fetchChatMessages,
  chatatt: fetchChatAttachments,
  artifact: fetchArtifacts,
  triagetag: fetchTriageTags,
} satisfies EntityFetchers;

// Order is patch order, so build from `IDB_KEY_NAMES`, not `Object.entries`.
export const SYNC_ENTITIES = IDB_KEY_NAMES.map((slug) => ({
  slug,
  fetchRows: ENTITY_FETCHERS[slug],
}));
