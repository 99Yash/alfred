import type { ReplicachePokeAdapter } from "@alfred/assistant/triggers";
import {
  registerReplicachePokeAdapter as registerPort,
  unregisterReplicachePokeAdapter as unregisterPort,
} from "@alfred/assistant/triggers";
import { emitReplicachePokes as concrete } from "../events/replicache-events";

export function registerReplicachePokeAdapter(adapter?: ReplicachePokeAdapter): () => void {
  return registerPort(adapter ?? { emitReplicachePokes: concrete });
}

export function unregisterReplicachePokeAdapter(): void {
  unregisterPort();
}
