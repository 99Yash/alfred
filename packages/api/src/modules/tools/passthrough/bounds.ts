/**
 * Payload bounding for the general read-only passthrough tier.
 *
 * The bounding pipeline itself now lives in `@alfred/contracts`
 * ({@link boundPassthroughBody}) because it is shared, browser-safe, and
 * composes primitives that already live there — the same job is done by the raw
 * MCP client (epic #271), so a stable primitive must not sit inside this
 * product tier. This module re-exports it so the passthrough tier's public
 * surface is unchanged.
 */

export {
  boundPassthroughBody,
  PASSTHROUGH_MAX_ARRAY_ITEMS,
  PASSTHROUGH_MAX_BODY_BYTES,
  type BoundedPassthroughBody,
} from "@alfred/contracts";
