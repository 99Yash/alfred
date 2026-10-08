/**
 * Typed localStorage over the registry in `storage-schemas.ts`. Reads return a valid
 * value or the default; writes reject invalid values. Per-entity keys use `safeGet` and friends.
 * Pattern: https://yashk.xyz/highlights/type-safe-local-storage-utils
 */

import {
  LOCAL_STORAGE_KEY,
  LOCAL_STORAGE_SCHEMAS,
  type LocalStorageKey,
  type LocalStorageValue,
} from "~/lib/storage/storage-schemas";

export type { LocalStorageKey, LocalStorageValue };

export { LOCAL_STORAGE_KEY, LOCAL_STORAGE_SCHEMAS };

// The only code that touches `window.localStorage`. Each is a no-op when storage is unavailable.

export function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best effort.
  }
}

export function safeRemove(key: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}

function schemaDefault<K extends LocalStorageKey>(key: K): LocalStorageValue<K> {
  // SAFETY: each key's registered schema outputs `LocalStorageValue<key>`.
  return LOCAL_STORAGE_SCHEMAS[key].parse(undefined) as LocalStorageValue<K>;
}

/** The stored value, else a valid `defaultValue`, else the schema default. Never throws. */
export function getLocalStorageItem<K extends LocalStorageKey>(
  key: K,
  defaultValue?: LocalStorageValue<K>,
): LocalStorageValue<K> {
  const schema = LOCAL_STORAGE_SCHEMAS[key];

  const resolveDefault = (): LocalStorageValue<K> => {
    if (defaultValue !== undefined) {
      const r = schema.safeParse(defaultValue);

      if (r.success) {
        // SAFETY: same per-key schema contract as schemaDefault above.
        return r.data as LocalStorageValue<K>;
      }

      console.error(
        `[storage] default value for "${key}" does not match its schema`,
        r.error.issues,
      );
    }

    return schemaDefault(key);
  };

  const serialized = safeGet(key);

  if (serialized === null) return resolveDefault();

  // Old values were raw strings (`dark`, not `"dark"`), so retry the raw string when JSON fails.
  let candidate: unknown;

  try {
    candidate = JSON.parse(serialized);
  } catch {
    candidate = serialized;
  }

  const result = schema.safeParse(candidate);

  if (result.success) {
    // SAFETY: same per-key schema contract as schemaDefault above.
    return result.data as LocalStorageValue<K>;
  }

  console.warn(
    `[storage] stored value for "${key}" is invalid — falling back to default`,
    result.error.issues,
  );

  return resolveDefault();
}

/** Logs and skips an invalid value. */
export function setLocalStorageItem<K extends LocalStorageKey>(
  key: K,
  value: LocalStorageValue<K>,
): void {
  const result = LOCAL_STORAGE_SCHEMAS[key].safeParse(value);

  if (!result.success) {
    console.error(`[storage] refusing to write invalid value for "${key}"`, result.error.issues);

    return;
  }

  safeSet(key, JSON.stringify(result.data));
}

/** Changes from other tabs only: the `storage` event never fires in the writing tab. */
export function subscribeToStorage<K extends LocalStorageKey>(
  key: K,
  onChange: (value: LocalStorageValue<K>) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handler = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    onChange(getLocalStorageItem(key));
  };

  window.addEventListener("storage", handler);

  return () => window.removeEventListener("storage", handler);
}
