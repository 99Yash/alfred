/**
 * Manifest door for the Replicache poke port. The lifecycle lives in
 * `@alfred/assistant/realtime`; `scripts/check-module-architecture.mjs` needs
 * this directory to export the pair.
 */
export {
  registerReplicachePokeAdapter,
  unregisterReplicachePokeAdapter,
} from "@alfred/assistant/realtime";
