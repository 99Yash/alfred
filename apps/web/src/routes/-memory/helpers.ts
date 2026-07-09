import type { SyncedFact } from "@alfred/sync";

// The wire only ever carries proposed/confirmed facts (the api's internal
// 5-state lifecycle — rejected/edited/superseded — never syncs to the client),
// so derive from the synced shape rather than re-spelling or importing the
// server-side FACT_STATUSES.
type FactStatus = SyncedFact["status"];

export interface LocalFact {
  id: string;
  key: string;
  value: string;
  status: FactStatus;
  confidence: number;
  source: string;
  createdAt: string;
}
