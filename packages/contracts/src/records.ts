/**
 * Typed views of a const table's keys and entries, and records built over a closed key list.
 * `Object.keys` / `Object.entries` / `Object.fromEntries` type their keys as `string`, so a
 * caller that needs the key union would otherwise assert it at each site.
 */

/**
 * The keys of a CLOSED object literal, typed as its key union.
 *
 * Precondition: `record` is a non-indexed literal (`{ … } as const`, `{ … } satisfies …`) whose
 * runtime keys are exactly its declared keys. TypeScript lets a wider object reach a narrower
 * type, so do not pass a value that came through a structural parameter or from outside.
 * Use `Object.keys` there and narrow each key with a guard.
 */
export function typedKeys<T extends object>(record: T): Extract<keyof T, string>[] {
  // SAFETY: the precondition says `record` is a closed literal, so `Object.keys` returns exactly
  // its string keys. This is the one place that states it.
  return Object.keys(record) as Extract<keyof T, string>[];
}

/** The entries of a CLOSED object literal, each key paired with its value type. Same precondition as {@link typedKeys}. */
export function typedEntries<T extends object>(
  record: T,
): { [K in Extract<keyof T, string>]: [K, T[K]] }[Extract<keyof T, string>][] {
  return typedKeys(record).map((key) => [key, record[key]]);
}

/**
 * A record with one entry per key of `keys`, in key order. Use it in place of
 * `Object.fromEntries(keys.map(…)) as Record<K, V>`.
 */
export function recordFromKeys<K extends string, V>(
  keys: readonly K[],
  project: (key: K, index: number) => V,
): Record<K, V> {
  // SAFETY: the entries come from `keys` one to one, so the record has exactly the keys `K`.
  // `Object.fromEntries` types its keys as `string`, which erases that.
  return Object.fromEntries(keys.map((key, index) => [key, project(key, index)])) as Record<K, V>;
}

/**
 * One field of each entry of a CLOSED object literal, keyed as the literal is, with each value
 * keeping its own key's type. Same precondition as {@link typedKeys}.
 * `pluckField(SOURCES, "rank")` gives `{ gmail: 2; user: 0; … }`.
 */
export function pluckField<T extends object, F extends keyof T[keyof T]>(
  record: T,
  field: F,
): { readonly [K in Extract<keyof T, string>]: T[K][F & keyof T[K]] } {
  // SAFETY: the value under each key K is `record[K][field]`, so it is `T[K][F]`. `recordFromKeys`
  // types every value as the union over all keys; a per-key mapped type cannot be built otherwise.
  return recordFromKeys(typedKeys(record), (key) => record[key][field]) as {
    readonly [K in Extract<keyof T, string>]: T[K][F & keyof T[K]];
  };
}

/**
 * True when `record` has an own entry for every key in `keys`. Use it to close a record that a
 * loop filled one key at a time: declare it `Partial<Record<K, V>>`, fill it, then check it here.
 * It reads keys with `Object.hasOwn`, so a lazy getter does not run.
 */
export function hasEveryKey<K extends string, V>(
  record: Partial<Record<K, V>>,
  keys: readonly K[],
): record is Record<K, V> {
  return keys.every((key) => Object.hasOwn(record, key));
}
