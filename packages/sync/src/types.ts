export interface SyncedNote {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
  rowVersion: number;
}

/**
 * What the client gets per `user_preferences` row.
 *
 * The client store keys preferences by the user-facing `key`
 * (`tone`, `briefing.delivery_hour`, …) rather than the row id —
 * `(userId, key)` is the natural primary key on the server side and
 * keeping the same on the client makes the optimistic upsert a single
 * `tx.set`, no read-then-write.
 */
export interface SyncedPreference {
  /** The user-facing preference key — also used as the CVR id. */
  key: string;
  userId: string;
  value: unknown;
  source: Record<string, unknown>;
  rowVersion: number;
}

/** What the client gets per `user_facts` row. */
export interface SyncedFact {
  id: string;
  userId: string;
  key: string;
  value: unknown;
  confidence: number;
  /** proposed | confirmed — only these two land in the client snapshot. */
  status: "proposed" | "confirmed";
  /** Provenance frozen as a record so the UI can render "alfred learned this from <doc>". */
  source: Record<string, unknown>;
  /** ISO 8601 timestamps. */
  validFrom: string;
  validUntil: string | null;
  supersedesId: string | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string | null;
}
