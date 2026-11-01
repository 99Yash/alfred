/** The activity record of ingested sources (ADR-0118): the GitHub reducer, its reads, and coverage. */

export { readActivityCoverage, type ActivityCoverage, type ActivityWindow } from "./coverage";

export {
  pageGithubActivityDocuments,
  readGithubActivityDocument,
  readGithubSelf,
} from "./documents";

export { reduceGithubActivity } from "./github-activity";
