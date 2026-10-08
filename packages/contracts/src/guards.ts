/**
 * Runtime guards for `unknown` values.
 * `typeof x === "object"` is also true for arrays and `null`, so do not cast after it.
 */

import { extractEmailAddress } from "./domain";

/**
 * True only for plain objects: not `null`, arrays, Date, Map, or class instances.
 * Use it on values that are really `unknown`. On a typed value it erases the parse.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * True for any non-null object or function, so you can read a property off it.
 * Use it for errors and SDK instances, which `isRecord` rejects. Then use `Reflect.get`.
 */
export function isIndexable(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True for a 1-indexed PDF page number. Extractors produce these, not models. */
export function isValidPage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The value if it is a plain object, else `{}`. */
export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The string elements of an array, else `[]`. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Read a nested key through plain objects. `undefined` if a link is missing. Never throws.
 * Narrow the `unknown` result at the leaf.
 */
export function getPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;

  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }

  return current;
}

/** `getPath`, but only a string leaf. */
export function getStringPath(value: unknown, ...keys: string[]): string | undefined {
  const leaf = getPath(value, ...keys);

  return typeof leaf === "string" ? leaf : undefined;
}

/**
 * Read a provider id that may be a string or an integer, as a string.
 * Webhooks send ids both ways, and the columns that store them are text.
 */
export function getIdPath(value: unknown, ...keys: string[]): string | null {
  const leaf = getPath(value, ...keys);

  if (isNonEmptyString(leaf)) return leaf;

  if (typeof leaf === "number" && Number.isSafeInteger(leaf)) return String(leaf);

  return null;
}

/**
 * Make a guard from an `as const` tuple: `enumGuard(TOOL_RISK_TIERS)` narrows to `ToolRiskTier`.
 */
export function enumGuard<const T extends readonly string[]>(
  values: T,
): (value: unknown) => value is T[number] {
  const members: ReadonlySet<string> = new Set(values);

  return (value): value is T[number] => typeof value === "string" && members.has(value);
}

/**
 * The lowercase `local@domain` from a `From:`-style header, or `null`.
 * Self-mail checks (`isSelfAuthored`, the retire backfills) use this.
 * A change here moves what they drop.
 */
export function parseEmailAddress(value: string | null | undefined): string | null {
  return extractEmailAddress(value);
}

/**
 * Merge overrides onto defaults, but skip keys whose value is `undefined`.
 * A plain spread lets `{ maxAttempts: undefined }` erase the default, and nothing throws.
 * The override type allows `| undefined` on purpose, so widened shapes also fit.
 */
export function withDefaults<T extends object>(
  defaults: T,
  overrides?: { [K in keyof T]?: T[K] | undefined },
): T {
  const merged = { ...defaults };

  if (!overrides) return merged;

  // SAFETY: the parameter type pins every present key to keyof T.
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key];

    if (value !== undefined) merged[key] = value;
  }

  return merged;
}
