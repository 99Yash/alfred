/** Maximum receipts admitted to embedding per user, source, and user-local day. */
export const INBOUND_DAILY_EMBED_CAP = 1_000;

/** Durable reason on documents skipped by this admission cap. */
export const INBOUND_DAILY_EMBED_CAP_REASON = "inbound_daily_embedding_cap";
