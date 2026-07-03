export type FactStatus = "proposed" | "confirmed";

export interface LocalFact {
  id: string;
  key: string;
  value: string;
  status: FactStatus;
  confidence: number;
  source: string;
  createdAt: string;
}
