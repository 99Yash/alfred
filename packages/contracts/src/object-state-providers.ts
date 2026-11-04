/**
 * The object-state providers (ADR-0062). A leaf module with no imports, so `user-model.ts` can name
 * them without an import cycle through `integration-objects.ts`.
 */
export const OBJECT_STATE_PROVIDERS = ["github", "railway", "vercel", "mcp"] as const;

export type ObjectStateProvider = (typeof OBJECT_STATE_PROVIDERS)[number];
