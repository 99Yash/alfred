import { z } from "zod";

/**
 * The provider-native object identity `(provider, kind, externalId)` that
 * `integration_objects` is uniquely keyed on (ADR-0062). Declared once so the
 * context-search request envelope, the evidence card, and the store read
 * signature derive from one schema instead of three agreeing-by-convention
 * literals; changing a bound or a field name is then one edit, not three
 * coordinated ones.
 *
 * `provider` is an integration slug (checked against the object-state registry
 * at the adapter boundary, not here), `kind` is a provider-declared object kind,
 * and `externalId` is the provider-native stable id as a string.
 *
 * Pure module — no Node imports (consumed across the web boundary).
 */
export const objectIdentitySchema = z.object({
  /** Integration slug — `github`, later `clickup`, `claude-code`. */
  provider: z.string().min(1).max(100),
  /** Object kind within the provider — `pull_request`, `task`. */
  kind: z.string().min(1).max(100),
  /** Provider-native stable id, as a string. */
  externalId: z.string().min(1).max(512),
});

export type ObjectIdentity = z.infer<typeof objectIdentitySchema>;
