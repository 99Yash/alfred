import { createDocumentContextSource } from "./documents-source";
import { createMemoryContextSource } from "./memory-source";
import { registerContextSource, type ContextSource } from "./registry";

/**
 * The production composition helper for the built-in sources (#424).
 *
 * The boundary never imports a concrete adapter; a composition root registers
 * them. This is that one call for the two source-backed primitives that exist
 * today (ingested documents and memory), so `apps/server` names one function
 * instead of reaching into adapter files the module keeps private.
 *
 * The instances are memoized: `registerContextSource` throws when a *different*
 * instance claims a live id, so a second boot call in one process must reinstall
 * the same objects, not freshly built ones. That makes the call safe to repeat
 * and the returned disposer safe to ignore. Source-capability discovery (#466)
 * will enumerate these through the registry, not through this function.
 */
const builtinSources: readonly ContextSource[] = [
  createDocumentContextSource(),
  createMemoryContextSource(),
];

/** Register the built-in context sources; returns a disposer for all of them. */
export function registerDefaultContextSources(): () => void {
  const disposers = builtinSources.map((source) => registerContextSource(source));

  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
