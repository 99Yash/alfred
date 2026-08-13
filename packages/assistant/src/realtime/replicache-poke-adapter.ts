import type { ReplicachePokeAdapter } from "@alfred/assistant/triggers";
import {
  registerReplicachePokeAdapter as registerPort,
  unregisterReplicachePokeAdapter as unregisterPort,
} from "@alfred/assistant/triggers";
import { emitReplicachePokesOverRedis } from "./replicache-events";

/**
 * Install the concrete Replicache poke emitter behind the `triggers` port, so a
 * producer emits pokes without importing this transport.
 *
 * The default lives in `realtime` because `realtime` owns the Redis emitter it
 * installs. Every long-lived process gets it through the assistant runtime, but
 * short-lived operational scripts install it directly — an enqueued run can emit
 * a poke, and an unset port drops it — so this stays a public `realtime` name
 * rather than a private runtime adapter.
 */
export function registerReplicachePokeAdapter(adapter?: ReplicachePokeAdapter): () => void {
  return registerPort(adapter ?? { emitReplicachePokes: emitReplicachePokesOverRedis });
}

export function unregisterReplicachePokeAdapter(): void {
  unregisterPort();
}
