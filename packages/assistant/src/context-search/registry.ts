import type { ContextSource } from "./types";

const registeredSources = new Map<string, ContextSource>();

/**
 * Register a read-only evidence source. A composition root calls this at boot
 * (#424+); the boundary itself never imports a concrete source.
 *
 * Installing the same instance again is a no-op, so a repeat boot call in one
 * process does not throw. Installing a different instance under a live id
 * throws — a duplicate id is a bug, not a reconfiguration. Returns a disposer
 * that clears the slot only while it still holds this exact source.
 */
export function registerContextSource(source: ContextSource): () => void {
  const existing = registeredSources.get(source.id);

  if (existing === source) return () => {};

  if (existing !== undefined) {
    throw new Error(`A context search source is already registered for id "${source.id}"`);
  }

  registeredSources.set(source.id, source);

  return () => {
    if (registeredSources.get(source.id) === source) registeredSources.delete(source.id);
  };
}

/** Registered sources, in registration order. The future manifest reader (#466) enumerates them here. */
export function listContextSources(): readonly ContextSource[] {
  return [...registeredSources.values()];
}
