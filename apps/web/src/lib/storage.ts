/**
 * Type-safe localStorage — the engine.
 *
 * The schema *registry* lives in `storage-schemas.ts`; this module is the
 * runtime around it. Each key's Zod schema is the single source of truth for
 * its *type* (compile-time, via `LocalStorageValue<K>`), its *validation*
 * (runtime, via `safeParse`), and its *default* (via `.default(...)`). Reads
 * always come back valid-or-default; writes refuse to persist anything that
 * doesn't match.
 *
 * Pattern from https://yashk.xyz/highlights/type-safe-local-storage-utils,
 * extended to close the three gaps that writeup calls out:
 *   1. SSR / private-mode: every DOM access is guarded (see the primitives).
 *   2. Corrupt JSON no longer recurses forever — it falls straight to default.
 *   3. Cross-tab sync via `subscribeToStorage`.
 *
 * It also tolerates the *legacy* raw-string values this module replaced (e.g.
 * the theme was stored as `dark`, not `"dark"`): a value that fails `JSON.parse`
 * is re-validated as the raw string before we fall back to the default. Keys
 * with older JSON-shaped values can add schema preprocessors for migration.
 *
 * Dynamic / per-entity keys (e.g. chat drafts keyed by thread id) don't belong
 * in the fixed registry — use the `safeGet`/`safeSet`/`safeRemove` primitives
 * directly for those.
 */

import {
  LOCAL_STORAGE_SCHEMAS,
  type LocalStorageKey,
  type LocalStorageValue,
} from "~/lib/storage-schemas";

export type { LocalStorageKey, LocalStorageValue };
export { LOCAL_STORAGE_SCHEMAS };

// ---------------------------------------------------------------------------
// Safe primitives — the only place that touches `window.localStorage`. Each is
// a no-op (or null) when storage is unavailable: server render, private mode,
// or a quota/security exception. Use these directly for dynamic keys.
// ---------------------------------------------------------------------------

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
    // Quota exceeded / private mode / disabled — storage is best-effort.
  }
}

export function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore — nothing to clean up if storage is unavailable.
  }
}

// ---------------------------------------------------------------------------
// Typed accessors for registered keys.
// ---------------------------------------------------------------------------

/** The schema-defined default for a key (its `.default(...)`). Always valid. */
function schemaDefault<K extends LocalStorageKey>(key: K): LocalStorageValue<K> {
  return LOCAL_STORAGE_SCHEMAS[key].parse(undefined) as LocalStorageValue<K>;
}

/**
 * Read a typed, validated value. Resolution order: the stored value (if valid)
 * → the caller's `defaultValue` (if valid) → the schema default. Corrupt or
 * stale stored data is logged and discarded rather than thrown.
 */
export function getLocalStorageItem<K extends LocalStorageKey>(
  key: K,
  defaultValue?: LocalStorageValue<K>,
): LocalStorageValue<K> {
  const schema = LOCAL_STORAGE_SCHEMAS[key];

  const resolveDefault = (): LocalStorageValue<K> => {
    if (defaultValue !== undefined) {
      const r = schema.safeParse(defaultValue);
      if (r.success) return r.data as LocalStorageValue<K>;
      console.error(
        `[storage] default value for "${key}" does not match its schema`,
        r.error.issues,
      );
    }
    return schemaDefault(key);
  };

  const serialized = safeGet(key);
  if (serialized === null) return resolveDefault();

  // Parse as JSON, but tolerate the legacy raw-string format (values written
  // before this module existed) by validating the raw string on parse failure.
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    candidate = serialized;
  }

  const result = schema.safeParse(candidate);
  if (result.success) return result.data as LocalStorageValue<K>;

  console.warn(
    `[storage] stored value for "${key}" is invalid — falling back to default`,
    result.error.issues,
  );
  return resolveDefault();
}

/** Write a typed value. Validates first; invalid values are logged, not stored. */
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

/** Remove a registered key. */
export function removeLocalStorageItem(key: LocalStorageKey): void {
  safeRemove(key);
}

/**
 * Subscribe to changes for a registered key made in *other* tabs (the `storage`
 * event never fires in the tab that made the change). The callback receives the
 * freshly read, validated value. Returns an unsubscribe fn; no-op on the server.
 */
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
