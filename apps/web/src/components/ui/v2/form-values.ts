import { isNonEmptyString } from "@alfred/contracts";

/**
 * Normalize a form's string values for a request body.
 *
 * A form represents an untouched optional field as `""`, but a contract writes
 * that field as `.optional()`, so an empty string is a validation failure
 * rather than an omission. Trim every value and drop the ones that trim to
 * nothing, so the key is absent instead of empty.
 *
 * Construction sites keep their required fields explicit and spread only the
 * optional ones through this, so the body still typechecks without a cast:
 *
 *     const body: McpAddServerBody = {
 *       endpointUrl: value.endpointUrl.trim(),
 *       ...omitBlankStringFields({ label: value.label }),
 *     };
 */
export function omitBlankStringFields<T extends Record<string, string>>(values: T): Partial<T> {
  const entries = Object.entries(values)
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => isNonEmptyString(value));

  // SAFETY: `entries` keeps exactly the keys of `values`, so the reconstructed
  // object is a partial over the same key set; `Object.fromEntries` widens the
  // key type to `string`.
  return Object.fromEntries(entries) as Partial<T>;
}
