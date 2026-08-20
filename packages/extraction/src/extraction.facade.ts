import { getContentFamily, type ContentFamily } from "@alfred/contracts";
import {
  createMediaExtractor,
  extractionLimitsFor,
  type ExtractionDoor,
  type MediaExtractionResult,
  type MediaExtractor,
} from "./media-extraction";

/**
 * The unified door-bound extraction entry point. One callable binds a door
 * once and hands back a mime-aware extractor already wired to that door's
 * limits, family registry, and factory, so a call site reads as one
 * continuous thought:
 *
 *   extraction({ door: "gmailAttachment" }).extract({ mime, bytes })
 *
 * In production the bind happens once per ingest job and the loop reuses
 * the same instance — each family client is lazily built and memoized, so
 * a second `extract` for the same MIME reuses the SAME extractor.
 *
 * Design properties:
 *
 *   1. The door binds at the *root*, not per call. Binding is cheap and holds
 *      no bytes — each family is a lazily-built extractor over the door's
 *      limits, so the root carries no lifetime rule.
 *
 *   2. Each family is a memoized lazy getter: touching `pdf` builds only
 *      the PDF extractor, and touching it twice yields the SAME extractor.
 *      The memo covers CLIENT CONSTRUCTION only — no bytes are cached.
 *
 *   3. It is GENERIC over the family registry: the factory map and the
 *      door × family limit matrix are declared ONCE in `media-extraction.ts`,
 *      and `satisfies` makes a missing cell a type error. Adding a family
 *      is one entry in each registry; `extraction()` needs no second place.
 *
 * The discipline that keeps this from drifting into a pass-through facade:
 * each call hides the full `mime → family → limits → factory` chain. The
 * caller never names `ContentFamily`, never checks `getContentFamily`,
 * never reads `extractionLimitsFor`, and never handles a factory miss —
 * `null` from `forMime` is the only signal for an unsupported MIME, and
 * `extract` maps that to `null` so the ingest loop can `continue`.
 */

export interface ExtractionOptions {
  /** Which ingest policy door owns the limits (chat, fetch, gmail). */
  door: ExtractionDoor;
}

export interface Extraction {
  /**
   * Extract text from bytes for a MIME type under the bound door.
   * Returns `null` when the MIME is outside the whitelist or has no
   * `contentFamily` (e.g. pass-through images) — the caller should skip
   * without embedding. Otherwise returns the normalized
   * `MediaExtractionResult` (extracted / needs_ocr / encrypted / invalid /
   * limit_exceeded) so the ingest loop can handle each case uniformly.
   */
  extract(args: { mime: string; bytes: Uint8Array }): Promise<MediaExtractionResult | null>;

  /**
   * Resolve a MIME type to its door-bound extractor, or `null` when the MIME
   * is not extractable. The returned extractor is memoized per family —
   * calling twice for `application/pdf` yields the SAME function.
   * Use this when you need the extractor handle itself (e.g. to inject in
   * tests) rather than the one-shot `extract`.
   */
  forMime(mime: string): MediaExtractor | null;

  /** True when this MIME has an extractable family under the bound door. */
  isSupported(mime: string): boolean;

  /**
   * True when the declared size exceeds the door's `maxBytes` for this MIME's
   * family. Use as a pre-fetch hint to avoid a `getAttachment` round-trip for
   * an obviously over-limit part. Returns false for unsupported MIMEs.
   */
  wouldExceed(mime: string, byteLength: number): boolean;

  /** The door this instance is bound to. */
  readonly door: ExtractionDoor;
}

export function extraction(options: ExtractionOptions): Extraction {
  const cache = new Map<ContentFamily, MediaExtractor>();

  function getExtractor(family: ContentFamily): MediaExtractor {
    const cached = cache.get(family);
    if (cached) return cached;
    const extractor = createMediaExtractor(options.door, family);
    cache.set(family, extractor);
    return extractor;
  }

  function resolveMime(mime: string): MediaExtractor | null {
    const family = getContentFamily(mime);
    if (!family) return null;
    return getExtractor(family);
  }

  return {
    door: options.door,
    isSupported(mime: string): boolean {
      return resolveMime(mime) !== null;
    },
    forMime(mime: string): MediaExtractor | null {
      return resolveMime(mime);
    },
    wouldExceed(mime: string, byteLength: number): boolean {
      const family = getContentFamily(mime);
      if (!family) return false;
      if (byteLength <= 0) return false;
      const limits = extractionLimitsFor(options.door, family);
      return byteLength > limits.maxBytes;
    },
    async extract(args: {
      mime: string;
      bytes: Uint8Array;
    }): Promise<MediaExtractionResult | null> {
      const extractor = resolveMime(args.mime);
      if (!extractor) return null;
      return extractor(args.bytes);
    },
  };
}
