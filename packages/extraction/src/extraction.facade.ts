import { getContentFormat, type ContentFormat } from "@alfred/contracts";
import {
  DOOR_LIMITS,
  FORMAT_REGISTRY,
  type ExtractionDoor,
  type MediaExtractionResult,
  type MediaExtractor,
} from "./media-extraction";

/**
 * The unified door-bound extraction entry point. One callable binds a door
 * once and hands back a mime-aware extractor already wired to that door's
 * limits, format registry, and factory, so a call site reads as one
 * continuous thought:
 *
 *   extraction({ door: "gmailAttachment" }).extract({ mime, bytes })
 *
 * In production the bind happens once per ingest job and the loop reuses
 * the same instance — each format client is lazily built and memoized, so
 * a second `extract` for the same MIME reuses the SAME extractor.
 *
 * Design properties:
 *
 *   1. The door binds at the *root*, not per call. Binding is cheap and holds
 *      no bytes — each format is a lazily-built extractor over the door's
 *      limits, so the root carries no lifetime rule.
 *
 *   2. Each format is a memoized lazy getter: touching `pdf` builds only
 *      the PDF extractor, and touching it twice yields the SAME extractor.
 *      The memo covers CLIENT CONSTRUCTION only — no bytes are cached.
 *
 *   3. It is GENERIC over two `satisfies`-pinned tables: `FORMAT_REGISTRY`
 *      (format → factory) and `DOOR_LIMITS` (format × door limits), both
 *      declared ONCE in `media-extraction.ts`. Adding a format is one
 *      registry entry plus one `DOOR_LIMITS` row; `extraction()` needs no
 *      second place.
 *
 * The discipline that keeps this from drifting into a pass-through facade:
 * each call hides the full `mime → format → gate → limits → factory` chain.
 * The caller never names `ContentFormat`, never checks `getContentFormat`,
 * never reads limits, and never handles a factory miss — `null` from
 * `forMime` is the only signal for an unsupported (or gated) MIME, and
 * `extract` maps that to `null` so the ingest loop can `continue`.
 */

export interface ExtractionOptions {
  /** Which ingest policy door owns the limits (chat, fetch, gmail). */
  door: ExtractionDoor;
}

export interface Extraction {
  /**
   * Extract text from bytes for a MIME type under the bound door.
   * Returns `null` when the MIME has no `contentFormat` (e.g. pass-through
   * images) — the caller should skip
   * without embedding. Otherwise returns the normalized
   * `MediaExtractionResult` (extracted / needs_ocr / encrypted / invalid /
   * limit_exceeded) so the ingest loop can handle each case uniformly.
   */
  extract(args: { mime: string; bytes: Uint8Array }): Promise<MediaExtractionResult | null>;

  /**
   * Resolve a MIME type to its door-bound extractor, or `null` when the MIME
   * is not extractable. The returned extractor is memoized per format —
   * calling twice for `application/pdf` yields the SAME function.
   * Use this when you need the extractor handle itself (e.g. to inject in
   * tests) rather than the one-shot `extract`.
   */
  forMime(mime: string): MediaExtractor | null;

  /** True when this MIME has an extractable format under the bound door. */
  isSupported(mime: string): boolean;

  /**
   * True when the declared size exceeds the door's `maxBytes` for this MIME's
   * format. Use as a pre-fetch hint to avoid a `getAttachment` round-trip for
   * an obviously over-limit part. Returns false for unsupported MIMEs.
   */
  wouldExceed(mime: string, byteLength: number): boolean;

  /** The door this instance is bound to. */
  readonly door: ExtractionDoor;
}

export function extraction(options: ExtractionOptions): Extraction {
  const cache = new Map<ContentFormat, MediaExtractor>();

  function getExtractor(format: ContentFormat): MediaExtractor {
    const cached = cache.get(format);
    if (cached) return cached;
    const entry = FORMAT_REGISTRY[format];
    const extractor = entry.factory(DOOR_LIMITS[format][options.door]);
    cache.set(format, extractor);
    return extractor;
  }

  function resolveFormat(mime: string): ContentFormat | null {
    return getContentFormat(mime);
  }

  function resolveMime(mime: string): MediaExtractor | null {
    const format = resolveFormat(mime);
    if (!format) return null;
    return getExtractor(format);
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
      const format = resolveFormat(mime);
      if (!format) return false;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
      const maxBytes = DOOR_LIMITS[format][options.door].maxBytes;
      return byteLength > maxBytes;
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
