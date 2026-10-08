import { sha256Canonical } from "./hash";

export type WorkflowOccurrenceIdentity =
  | {
      kind: "cron";
      workflowId: string;
      revisionId: string | null;
      scheduledFor: string;
    }
  | {
      kind: "event";
      workflowId: string;
      provider: string;
      eventId: string;
    }
  | { kind: "manual"; workflowId: string; requestId: string }
  | {
      kind: "replay";
      workflowId: string;
      requestId: string;
      replayOfRunId: string;
      revisionChoice: "original" | "latest";
    };

/** Stable key for one workflow occurrence. The hash keeps it short. */
export function workflowOccurrenceKey(identity: WorkflowOccurrenceIdentity): string {
  return `occ_v1:${identity.kind}:${sha256Canonical(identity)}`;
}
