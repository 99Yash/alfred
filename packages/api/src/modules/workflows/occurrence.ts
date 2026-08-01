import { sha256Canonical } from "../../lib/hash";

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

/** Stable, bounded database identity for one workflow occurrence (#558). */
export function workflowOccurrenceKey(identity: WorkflowOccurrenceIdentity): string {
  return `occ_v1:${identity.kind}:${sha256Canonical(identity)}`;
}
