/**
 * The one builder of a reader's evidence (ADR-0124 amendment 2026-11-18). Each reference comes
 * with the item that the reader delivered, and this module hashes the item, so no reader can skip
 * the hash of an item (memory.md section 7).
 */

import {
  toReadEvidence,
  type ReadCoverage,
  type ReadEvidence,
  type ReadEvidenceRef,
  type ReadEvidenceRefDraft,
} from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";

/** One item that a read delivered, and the reference that names it. */
export interface DeliveredItem {
  ref: ReadEvidenceRefDraft;
  /** The item as the reader returned it: a row, a hit, a card block, or a whole response. */
  item: unknown;
}

export function itemEvidence(
  items: readonly DeliveredItem[],
  coverage?: ReadCoverage,
): ReadEvidence {
  return toReadEvidence(
    items.map(({ ref, item }): ReadEvidenceRef => ({ ...ref, hash: sha256Canonical(item) })),
    coverage,
  );
}
