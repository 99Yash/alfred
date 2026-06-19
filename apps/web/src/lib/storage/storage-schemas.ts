/**
 * The localStorage schema registry — the single, easily-accessed place that
 * declares every known key and its shape. The engine (`lib/storage`) reads from
 * here; features import the typed accessors from `lib/storage`, not this file.
 *
 * One home per schema:
 *   - A schema that describes a *domain entity* (used beyond storage) lives in
 *     its domain module and is *referenced* here — e.g. `weatherSnapshotSchema`
 *     from `lib/weather`. That module must not import `lib/storage`, or the
 *     registry → domain → storage chain becomes an import cycle.
 *   - A schema for a value that exists *only* as a persisted preference
 *     (theme, auth hint, sound) has no other home — it's declared inline here.
 *
 * Every schema MUST carry a `.default(...)` so reads have a guaranteed fallback
 * and never return `undefined`.
 */

import { z } from "zod";
import { weatherSnapshotSchema } from "~/lib/weather";

export const LOCAL_STORAGE_SCHEMAS = {
  /** App theme preference (see `components/ui/v2/theme`). */
  "app-theme": z.enum(["system", "dark", "light"]).default("system"),
  /**
   * Best-effort "is the visitor signed in" hint for first paint. A UX hint,
   * never a security boundary (see `lib/auth-hint`).
   */
  "alfred.maybe-authed": z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /**
   * Best-effort "this user has finished onboarding" hint for first paint, so a
   * returning user's authed routes render immediately instead of blanking
   * behind the session → onboarding round-trip chain. A UX hint, never a
   * security boundary (see `lib/onboarding-hint`).
   */
  "alfred.onboarding-complete": z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /** When the run-complete chime plays (see `lib/chat/use-run-complete`). */
  "alfred.chat.soundPreference": z.enum(["always", "unfocused", "mute"]).default("unfocused"),
  /**
   * Last weather snapshot, cached across reloads so the rail paints without a
   * fetch (see `hooks/use-weather`). `fetchedAt` is epoch-ms; the default's `0`
   * reads as already-stale, so an empty cache resolves to "no snapshot".
   */
  "alfred.weather.cache": z
    .object({ data: weatherSnapshotSchema.nullable(), fetchedAt: z.number() })
    .default({ data: null, fetchedAt: 0 }),
} as const satisfies Record<string, z.ZodDefault>;

export type LocalStorageKey = keyof typeof LOCAL_STORAGE_SCHEMAS;
export type LocalStorageValue<K extends LocalStorageKey> = z.infer<
  (typeof LOCAL_STORAGE_SCHEMAS)[K]
>;
