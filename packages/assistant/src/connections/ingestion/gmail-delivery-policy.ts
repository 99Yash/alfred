/** Realtime polls collapse push bursts. History polls use active-job dedup instead. */
export const GMAIL_POLL_DEDUP_TTL_MS = 30_000;

/** The sweep considers every active Gmail cursor on each run. */
export const GMAIL_POLL_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Grace for delayed push delivery, measured at the start of a history poll
 * that finds an unannounced change. Poll processing time is excluded. This
 * is a delivery latency budget, not a bound on queue or provider delays.
 */
export const GMAIL_PUSH_DELIVERY_GRACE_MS = 2 * GMAIL_POLL_SWEEP_INTERVAL_MS;
