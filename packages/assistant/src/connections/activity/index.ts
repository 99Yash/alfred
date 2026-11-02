/** The activity record of ingested sources (ADR-0118): the GitHub reducer, its reads, and coverage. */

export {
  ACTIVITY_SOURCE_SLUGS,
  arrivalWindowOf,
  readActivityCoverage,
  settleActivityCoverage,
  type ActivityCoverage,
  type ActivityWindow,
  type SilenceEvidence,
  type UnsettledActivityCoverage,
} from "./coverage";

export {
  pageGithubActivityDocuments,
  readGithubActivityDocument,
  readGithubSelf,
} from "./documents";

export { reduceGithubActivity, type GithubFamilyHead } from "./github-activity";

export type { ReadFamilyHeads } from "./github-coverage";
