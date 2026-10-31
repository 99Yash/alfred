/**
 * Runtime guards for `unknown` values.
 * `typeof x === "object"` is also true for arrays and `null`, so do not cast after it.
 */

import { parseMailbox } from "./domain";
import type { JsonObject, JsonValue } from "./user-model";

/*
 * The boundary guards below gate their argument type. A guard on a value that already has a
 * closed type erases what a parse or a schema proved, so such a call does not compile.
 * `T` infers from the argument through the false branch of each parameter type. When the
 * argument is outside the domain, the parameter resolves to a marker interface that no value
 * has. The key of the marker is the error message.
 */

/** The parameter of `isRecord` and `toRecord` when the argument has a static type. */
interface TypedValueIndexTheFieldDirectly {
  readonly "isRecord takes only unknown. Index the typed field directly, or call isJsonObject on a JsonValue": never;
}

/** The parameter of a path helper when the argument has a closed type. */
interface ClosedTypeIndexTheFieldDirectly {
  readonly "The path helpers take only unknown or open JSON. Index the typed field directly": never;
}

type GuardLeaf = string | number | boolean | bigint | symbol | null | undefined;

/** The named keys of `M`, without its index signatures. */
type NamedKeys<M> = keyof {
  [K in keyof M as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: 0;
};

/** `"closed"` when a member of `V` is an object with a named key. One level deep only. */
type ShallowClosed<V> = V extends GuardLeaf
  ? never
  : V extends readonly unknown[]
    ? never
    : [NamedKeys<V>] extends [never]
      ? never
      : "closed";

/**
 * Each member of `T` as `"leaf"` (a primitive), `"open"` (an index signature or an array whose
 * values are not closed objects, `{}`, `object`) or `"closed"` (an object with a named key).
 */
type OpenShape<T> = T extends GuardLeaf
  ? "leaf"
  : T extends readonly (infer E)[]
    ? [ShallowClosed<E>] extends [never]
      ? "open"
      : "closed"
    : [NamedKeys<T>] extends [never]
      ? [ShallowClosed<T[keyof T]>] extends [never]
        ? "open"
        : "closed"
      : "closed";

/** `unknown`, `any`, `{}` and those with `null` or `undefined` pass. */
type UnknownGate<T> = unknown extends T | null | undefined
  ? unknown
  : TypedValueIndexTheFieldDirectly;

/**
 * The parameter of `isRecord` and `toRecord`. An `any` argument reads as `unknown`, so the
 * predicate still narrows it to `Record<string, unknown>`.
 */
type UnknownOnly<T> = 0 extends 1 & T
  ? unknown
  : UnknownGate<T> extends TypedValueIndexTheFieldDirectly
    ? TypedValueIndexTheFieldDirectly
    : T;

/**
 * Open JSON passes too: `JsonValue`, `JsonObject`, `Record<string, unknown>`, and a union of
 * those with primitives. A member with a named key is closed, and so is a primitive alone.
 */
type OpenGate<T> = unknown extends T | null | undefined
  ? unknown
  : "closed" extends OpenShape<T>
    ? ClosedTypeIndexTheFieldDirectly
    : "open" extends OpenShape<T>
      ? unknown
      : ClosedTypeIndexTheFieldDirectly;

/** The first parameter of a path helper. */
type OpenOnly<T> =
  OpenGate<T> extends ClosedTypeIndexTheFieldDirectly ? ClosedTypeIndexTheFieldDirectly : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

/**
 * True only for plain objects: not `null`, arrays, Date, Map, or class instances.
 * The argument must be `unknown`. A typed argument does not compile, because the guard would
 * erase its parse. Use `isJsonObject` on a `JsonValue`.
 */
export function isRecord<T>(
  value: UnknownOnly<T>,
): value is UnknownOnly<T> & Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * The object branch of a `JsonValue`, for a walker over a JSON tree.
 * It does the same runtime check as `isRecord`.
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isPlainObject(value);
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

/** True for a string with a non-whitespace character. It does not trim the value. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True for a 1-indexed PDF page number. Extractors produce these, not models. */
export function isValidPage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The value if it is a plain object, else `{}`. The argument must be `unknown`, as for `isRecord`. */
export function toRecord<T>(value: UnknownOnly<T>): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

/** The string elements of an array, else `[]`. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The value if it is a non-empty string, else `undefined`. Unlike `getStringPath`, `""` reads as absent. */
export function toNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

/** The value if it is a finite number, else `undefined`. `NaN` and `Infinity` read as absent. */
export function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a nested key through plain objects. `undefined` if a link is missing. Never throws.
 * Narrow the `unknown` result at the leaf. The argument must be `unknown` or open JSON; a
 * closed type does not compile, so index its typed field directly.
 */
export function getPath<T>(value: OpenOnly<T>, ...keys: string[]): unknown {
  return readPath(value, keys);
}

function readPath(value: unknown, keys: readonly string[]): unknown {
  let current: unknown = value;

  for (const key of keys) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }

  return current;
}

/** `getPath`, but only a string leaf. */
export function getStringPath<T>(value: OpenOnly<T>, ...keys: string[]): string | undefined {
  const leaf = readPath(value, keys);

  return typeof leaf === "string" ? leaf : undefined;
}

/**
 * A string property of any indexable value. Unlike `getStringPath`, it reads errors and
 * SDK instances, which `isRecord` rejects. `undefined` if the field is missing or not a string.
 */
export function getStringField(value: unknown, key: string): string | undefined {
  if (!isIndexable(value)) return undefined;
  const field: unknown = Reflect.get(value, key);

  return typeof field === "string" ? field : undefined;
}

/**
 * Read a provider id that may be a string or an integer, as a string.
 * Webhooks send ids both ways, and the columns that store them are text.
 */
export function getIdPath<T>(value: OpenOnly<T>, ...keys: string[]): string | null {
  const leaf = readPath(value, keys);

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
 * Make a guard from a closed table literal: `keyGuard(FACT_ONTOLOGY)` narrows to `FactKey`.
 * Precondition (as for `typedKeys`): the runtime own keys are exactly the declared keys.
 * It reads with `Object.hasOwn`, so `"toString"` and `"__proto__"` are not keys.
 * The predicate is `` `${Exclude<keyof T, symbol>}` ``, so a numeric table key
 * narrows to its string form (for a string-literal key union this is the same type).
 */
export function keyGuard<T extends object>(
  table: T,
): (value: unknown) => value is `${Exclude<keyof T, symbol>}` {
  return (value): value is `${Exclude<keyof T, symbol>}` =>
    typeof value === "string" && Object.hasOwn(table, value);
}

/**
 * The lowercase `local@domain` from a `From:`-style header, or `null`.
 * Self-mail checks (`isSelfAuthored`, the retire backfills) use this.
 * A change here moves what they drop.
 */
export function parseEmailAddress(value: string | null | undefined): string | null {
  return parseMailbox(value)?.address ?? null;
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

  for (const key in overrides) {
    // `for…in` also walks inherited keys; `Object.keys` read own keys only.
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];

    if (value !== undefined) merged[key] = value;
  }

  return merged;
}
