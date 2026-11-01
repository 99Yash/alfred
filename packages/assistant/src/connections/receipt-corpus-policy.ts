import type { InboundEventSource } from "@alfred/contracts";

/** Maximum receipts admitted to embedding per user, source, and user-local day. */
export const INBOUND_DAILY_EMBED_CAP = 1_000;

/** Durable reason on documents skipped by this admission cap. */
export const INBOUND_DAILY_EMBED_CAP_REASON = "inbound_daily_embedding_cap";

/**
 * Provider event names whose receipts get a document but no embedding (ADR-0118 decision 8). The
 * receipt and its document stay; only the vector index skips them. A row skipped here does not
 * count toward {@link INBOUND_DAILY_EMBED_CAP}. The decision 1 predicate replaces this list in
 * the ADR-0118 slice that adds the comment and state-change rows. The predicate has no comment rows
 * before that, so it would remove the embeddings of comments.
 */
const UNEMBEDDED_RECEIPT_EVENTS = {
  // A CI job's queued/in_progress/completed state, about two thirds of all GitHub deliveries.
  github: new Set(["workflow_job"]),
} satisfies Record<InboundEventSource, ReadonlySet<string>>;

/** Durable reason on documents that {@link receiptKindEmbeds} keeps out of the index. Not a cap. */
export const RECEIPT_KIND_NOT_EMBEDDED_REASON = "receipt_kind_not_embedded";

/**
 * Whether a receipt of this kind may be embedded. Matches the event name, the part of the kind
 * before the first dot, so every action matches: `workflow_job.completed`, `workflow_job.queued`.
 */
export function receiptKindEmbeds(provider: InboundEventSource, kind: string): boolean {
  const dot = kind.indexOf(".");

  return !UNEMBEDDED_RECEIPT_EVENTS[provider].has(dot === -1 ? kind : kind.slice(0, dot));
}
