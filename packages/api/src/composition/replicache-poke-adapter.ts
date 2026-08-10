import type { ReplicachePokeAdapter } from "@alfred/assistant/triggers";
import {
  registerReplicachePokeAdapter as registerPort,
  unregisterReplicachePokeAdapter as unregisterPort,
} from "@alfred/assistant/triggers";
import { emitReplicachePokesOverRedis } from "@alfred/assistant/realtime";

export function registerReplicachePokeAdapter(adapter?: ReplicachePokeAdapter): () => void {
  return registerPort(adapter ?? { emitReplicachePokes: emitReplicachePokesOverRedis });
}

export function unregisterReplicachePokeAdapter(): void {
  unregisterPort();
}
