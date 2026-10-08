import { getContentFormat, type ContentFormat } from "@alfred/contracts";
import { DOOR_LIMITS, type ExtractionDoor } from "./constants";
import {
  FORMAT_REGISTRY,
  type MediaExtractionResult,
  type MediaExtractor,
} from "./media-extraction";

export interface ExtractionOptions {
  /** The ingest path whose limits apply. */
  door: ExtractionDoor;
}

export interface Extraction {
  /** `null` when the MIME has no extractable format (for example images). The caller skips it. */
  extract(args: { mime: string; bytes: Uint8Array }): Promise<MediaExtractionResult | null>;

  /** The extractor for a MIME, or `null`. One instance per format. */
  forMime(mime: string): MediaExtractor | null;

  isSupported(mime: string): boolean;

  /** Check a declared size before a fetch, to skip a download that is too large. False for unsupported MIMEs. */
  wouldExceed(mime: string, byteLength: number): boolean;

  readonly door: ExtractionDoor;
}

/**
 * Bind a door once, then extract by MIME:
 * `extraction({ door: "gmailAttachment" }).extract({ mime, bytes })`.
 * Builds each format's extractor on first use. It caches extractors, not bytes.
 * A new format needs a `FORMAT_REGISTRY` entry and a `DOOR_LIMITS` row.
 */
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
