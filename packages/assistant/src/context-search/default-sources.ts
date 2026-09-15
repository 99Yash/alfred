import { createDocumentContextSource } from "./documents-source";
import { createDriveContextSource } from "./drive-source";
import { createMemoryContextSource } from "./memory-source";
import { createObjectStateContextSource } from "./object-state-source";
import { registerContextSource, type ContextSource } from "./registry";

/**
 * The production composition helper for the built-in sources (#424, #425, #1078).
 *
 * The boundary never imports a concrete adapter; a composition root registers
 * them. This is that one call for the primitives that exist today (ingested
 * documents, memory, deterministic object state, and live Drive files), so
 * `apps/server` names one function instead of reaching into adapter files the
 * module keeps private.
 *
 * Registration ORDER is load-bearing in two places, and Drive is registered
 * last for both: source reports are rendered in registration order, and two
 * sources claiming one expansion handle kind resolve to the first registered.
 * Putting the one remote source after the three local ones keeps a reader's
 * eye on the local evidence first.
 *
 * The instances are memoized: `registerContextSource` throws when a *different*
 * instance claims a live id, so a second boot call in one process must reinstall
 * the same objects, not freshly built ones. That makes the call safe to repeat
 * and the returned disposer safe to ignore. Source-capability discovery (#466)
 * enumerates these through the registry, not through this function.
 */
const builtinSources: readonly ContextSource[] = [
  createDocumentContextSource(),
  createMemoryContextSource(),
  createObjectStateContextSource(),
  createDriveContextSource(),
];

/** Register the built-in context sources; returns a disposer for all of them. */
export function registerDefaultContextSources(): () => void {
  const disposers = builtinSources.map((source) => registerContextSource(source));

  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
