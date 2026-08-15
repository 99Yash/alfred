import { SerializationError } from "./entity-row";

/**
 * The two `Date` → ISO-string conversions every synced wire shape needs.
 *
 * Two named conversions, not a `utils.ts`: `toRequiredIso` is the point where a
 * nullable column that the synced schema declares non-null becomes a SKIPPED
 * ROW rather than a failed pull, and that decision belongs to this directory.
 * No shared helper covers it — no `@alfred/*` package exports a `Date` → ISO
 * conversion, and `scripts/consolidation-rules.mjs` has no row for the idiom.
 */
export const toIso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : (d ?? null);

export function toRequiredIso(d: Date | null | undefined, field: string): string {
  const value = toIso(d);
  if (value === null) throw new SerializationError(`${field} must not be null`);
  return value;
}
