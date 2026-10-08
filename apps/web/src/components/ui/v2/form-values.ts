import { isNonEmptyString } from "@alfred/contracts";

/**
 * Trim values and drop blank ones: contracts use `.optional()`, so `""` fails
 * validation. Spread only optional fields through this.
 */
export function omitBlankStringFields<T extends Record<string, string>>(values: T): Partial<T> {
  const entries = Object.entries(values)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => isNonEmptyString(value));

  // SAFETY: the entries keep the keys of `values`; `fromEntries` only widens them to `string`.
  return Object.fromEntries(entries) as Partial<T>;
}
