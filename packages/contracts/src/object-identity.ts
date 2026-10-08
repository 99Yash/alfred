import { z } from "zod";

/**
 * The `(provider, kind, externalId)` key of `integration_objects` (ADR-0062).
 * The adapter boundary checks `provider` against the registry, not this schema.
 */

/** Shared with the context-search key reference. */
export const objectProviderSchema = z
  .string()
  .min(1)
  .max(100)
  .describe("Integration slug that owns the object, for example `github`.");

export const objectIdentitySchema = z.object({
  /** Integration slug, such as `github`. */
  provider: objectProviderSchema,
  /** Provider object kind, such as `pull_request`. */
  kind: z
    .string()
    .min(1)
    .max(100)
    .describe("Provider-declared object kind, for example `pull_request`."),
  externalId: z
    .string()
    .min(1)
    .max(512)
    .describe("Provider-native stable id of the object, as a string."),
});

export type ObjectIdentity = z.infer<typeof objectIdentitySchema>;
