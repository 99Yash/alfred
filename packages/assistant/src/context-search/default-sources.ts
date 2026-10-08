import { createDocumentContextSource } from "./documents-source";
import { createDriveContextSource } from "./drive-source";
import { createMemoryContextSource } from "./memory-source";
import { createObjectStateContextSource } from "./object-state-source";
import { registerContextSource, type ContextSource } from "./registry";

/**
 * The built-in sources, for the composition root (#424, #425, #1078).
 * Order matters: reports render in this order, and the first source to claim an
 * expansion kind wins. Drive, the one remote source, goes last.
 * Memoized, because registering a different instance under a live id throws.
 */
const builtinSources: readonly ContextSource[] = [
  createDocumentContextSource(),
  createMemoryContextSource(),
  createObjectStateContextSource(),
  createDriveContextSource(),
];

/** Returns one disposer for all of them. */
export function registerDefaultContextSources(): () => void {
  const disposers = builtinSources.map((source) => registerContextSource(source));

  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
