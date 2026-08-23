import type { DbTransaction } from "@alfred/db";

/**
 * @deprecated Use DbTransaction directly. This alias was removed as part of cleanup.
 * Kept as re-export for one migration check; will be deleted once call sites update.
 */
export type { DbTransaction };
