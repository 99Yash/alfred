/**
 * The named door the runtime-adapter manifest lists for the Replicache poke port.
 *
 * The lifecycle pair itself lives in `@alfred/assistant/realtime`, which owns the
 * Redis emitter it installs and is reachable by the operational scripts that
 * install the same default without starting a runtime. This file exists because
 * `scripts/check-module-architecture.mjs` pairs every manifest row with a
 * lifecycle pair that this directory exports.
 */
export {
  registerReplicachePokeAdapter,
  unregisterReplicachePokeAdapter,
} from "@alfred/assistant/realtime";
