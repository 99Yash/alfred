import { isRawEventType } from "@alfred/contracts";
import {
  readGithubActivityDocument,
  readGithubSelf,
  reduceGithubActivity,
} from "@alfred/assistant/connections";
import { appendObservationFamilyMember, recallLatestByKey } from "@alfred/assistant/knowledge";
import { isInboundDomainEvent, type TriggerConsumer } from "@alfred/assistant/triggers";

/**
 * The live writer of the GitHub activity record (ADR-0118 decision 1). It runs beside the
 * object-state fold on each GitHub delivery: it reads the receipt's document, reduces it, and
 * appends the row. Composition lives here because the reducer is in `connections` and the
 * observation writer is in `knowledge`.
 *
 * `propagate`: a write failure fails `ingress.deliver`, and the queue retries. The family key and
 * the evidence hash make a retry a dedup. A receipt that stays `failed` makes the coverage of its
 * window `unavailable`, so a reader does not take the missing row for a quiet window.
 */
export function githubActivityTriggerConsumer(): TriggerConsumer {
  return {
    name: "github-activity-record",
    mode: "propagate",
    async accept(event) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- GitHub is the only inbound source today, so the types match; a second source makes this filter load-bearing.
      if (!isInboundDomainEvent(event) || event.source !== "github" || isRawEventType(event.type)) {
        return;
      }

      // The receipt and its document commit in one transaction, so the document exists here.
      const doc = await readGithubActivityDocument(event.userId, event.payload.receiptId);

      if (!doc) return;
      const fact = await recallLatestByKey(event.userId, "github_username");
      const self = await readGithubSelf(event.userId, fact?.value);
      const append = reduceGithubActivity(doc, self);

      if (!append) return;
      const result = await appendObservationFamilyMember(append.row, { keepHead: append.keepHead });

      if (result.status === "kept_head" && append.otherwise) {
        await appendObservationFamilyMember(append.otherwise);
      }
    },
  };
}
