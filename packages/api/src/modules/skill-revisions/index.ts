// Transitional barrel: skill revisions (persistence) moved to @alfred/assistant/skills
// during 6B. Re-export for backward compatibility with @alfred/api/backend.
export { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "@alfred/assistant/skills";
export type {
  CommitRevisionArgs,
  CommitRevisionResult,
  FinalizeSkillRunArgs,
  RecordSkillRunArgs,
} from "@alfred/assistant/skills";
