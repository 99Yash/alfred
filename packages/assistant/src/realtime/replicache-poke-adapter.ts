import type { ReplicachePokeAdapter } from "@alfred/assistant/triggers";
import {
  registerReplicachePokeAdapter as registerPort,
  unregisterReplicachePokeAdapter as unregisterPort,
} from "@alfred/assistant/triggers";
import { emitReplicachePokesOverRedis } from "./replicache-events";

/**
 * Install the Redis poke emitter behind the `triggers` port.
 * Public because short-lived scripts install it too: an unset port drops pokes.
 */
export function registerReplicachePokeAdapter(adapter?: ReplicachePokeAdapter): () => void {
  return registerPort(adapter ?? { emitReplicachePokes: emitReplicachePokesOverRedis });
}

export function unregisterReplicachePokeAdapter(): void {
  unregisterPort();
}
