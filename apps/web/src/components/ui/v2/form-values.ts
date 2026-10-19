import { isNonEmptyString } from "@alfred/contracts";

/**
 * Trim values and drop blank ones: contracts use `.optional()`, so `""` fails
 * validation. Spread only optional fields through this.
 */
export function omitBlankStringFields<K extends string>(values: Readonly<Record<K, string>>) {
  const out: Partial<Record<K, string>> = {};

  for (const key in values) {
    // `for…in` also walks inherited keys; `Object.entries` read own keys only.
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key].trim();

    if (isNonEmptyString(value)) out[key] = value;
  }

  return out;
}
