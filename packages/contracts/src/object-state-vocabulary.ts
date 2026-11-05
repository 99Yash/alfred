/**
 * The object-state vocabulary that `user-model.ts` names (ADR-0062). A leaf module with no imports,
 * so `user-model.ts` can name it without an import cycle through `integration-objects.ts`.
 */
export const OBJECT_STATE_PROVIDERS = ["github", "railway", "vercel", "mcp"] as const;

export type ObjectStateProvider = (typeof OBJECT_STATE_PROVIDERS)[number];

/**
 * How a key that an adapter reads from text finds its object. `prefix` is for an abbreviated sha,
 * which an exact lookup on the 40-hex key cannot find.
 */
export const OBJECT_KEY_MATCHES = ["exact", "prefix"] as const;

export type ObjectKeyMatch = (typeof OBJECT_KEY_MATCHES)[number];
