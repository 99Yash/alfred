import {
  registerReplicachePokeAdapter as registerPort,
  unregisterReplicachePokeAdapter as unregisterPort,
} from "@alfred/assistant/triggers";
import { emitReplicachePokes as concrete } from "../events/replicache-events";

export function registerReplicachePokeAdapter() {
  return registerPort({
    emitReplicachePokes: concrete,
  });
}

export function unregisterReplicachePokeAdapter() {
  unregisterPort();
}
