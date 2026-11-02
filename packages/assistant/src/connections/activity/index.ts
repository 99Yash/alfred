/** The activity record of ingested sources (ADR-0118): the GitHub reducer, its reads, and coverage. */

export {
  ACTIVITY_DELIVERY_GRACE_MS,
  ACTIVITY_SOURCE_SLUGS,
  readActivityCoverage,
  settleActivityCoverage,
  type ActivityCoverage,
  type ActivityWindow,
  type ReadFamilyHeads,
} from "./coverage";

export {
  pageGithubActivityDocuments,
  readGithubActivityDocument,
  readGithubSelf,
} from "./documents";

export { reduceGithubActivity, type GithubFamilyHead } from "./github-activity";
