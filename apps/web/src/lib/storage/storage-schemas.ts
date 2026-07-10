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

import { chatModelTierSchema } from "@alfred/contracts";
import { z } from "zod";
import { replayStateSchema } from "~/lib/events/replay-state";
import { weatherSnapshotSchema } from "~/lib/weather";

/** Runtime names for every registered localStorage entry. */
export const LOCAL_STORAGE_KEY = {
  APP_THEME: "app-theme",
  CHAT_TIER: "alfred.chat.tier",
  MAYBE_AUTHED: "alfred.maybe-authed",
  ONBOARDING_COMPLETE: "alfred.onboarding-complete",
  EVENT_REPLAY_STATE: "alfred.events.replayAnchor",
  CHAT_SOUND_PREFERENCE: "alfred.chat.soundPreference",
  CHAT_NOTIFY_ONBOARDED: "alfred.chat.notifyOnboarded",
  ARTIFACT_PANEL_WIDTH: "alfred:artifact-panel-width",
  SIDEBAR_WIDTH: "alfred:sidebar-width",
  SIDEBAR_MINIMIZED: "alfred:sidebar-minimized",
  SIDEBAR_COLLAPSED_GROUPS: "alfred:sidebar-collapsed-groups",
  WEATHER_CACHE: "alfred.weather.cache",
} as const;

export const LOCAL_STORAGE_SCHEMAS = {
  /** App theme preference (see `components/ui/v2/theme`). */
  [LOCAL_STORAGE_KEY.APP_THEME]: z.enum(["system", "dark", "light"]).default("system"),
  /**
   * Chat model-tier preference (Auto vs Deep), sticky across reloads and thread
   * switches. Single-user, so it's a local preference — no synced user-row field
   * yet (a multi-device follow-up). Derives its shape from the contract's
   * `chatModelTierSchema` so it can never drift from the server-side tier union.
   */
  [LOCAL_STORAGE_KEY.CHAT_TIER]: chatModelTierSchema.default("standard"),
  /**
   * Best-effort "is the visitor signed in" hint for first paint. A UX hint,
   * never a security boundary (see `lib/auth-hint`).
   */
  [LOCAL_STORAGE_KEY.MAYBE_AUTHED]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /**
   * Best-effort "this user has finished onboarding" hint for first paint, so a
   * returning user's authed routes render immediately instead of blanking
   * behind the session → onboarding round-trip chain. A UX hint, never a
   * security boundary (see `lib/onboarding-hint`).
   */
  [LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /**
   * Replay state for the SSE event stream. `cursor` advances monotonically;
   * active chat runs retain their own earlier recovery barriers. The numeric
   * preprocess in `replayStateSchema` migrates the original scalar anchor.
   */
  [LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE]: replayStateSchema,
  /** When the run-complete chime plays (see `lib/chat/use-run-complete`). */
  [LOCAL_STORAGE_KEY.CHAT_SOUND_PREFERENCE]: z
    .enum(["always", "unfocused", "mute"])
    .default("unfocused"),
  /**
   * Has the user seen the one-time "Alfred can notify you when a reply lands"
   * card? Shown once on the first finished turn, then never again (see
   * `lib/chat/use-run-complete`).
   */
  [LOCAL_STORAGE_KEY.CHAT_NOTIFY_ONBOARDED]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /** Inline chat artifact panel width in px (see `routes/-chat/use-artifact-panel`). */
  [LOCAL_STORAGE_KEY.ARTIFACT_PANEL_WIDTH]: z.number().default(460),
  /** Expanded app sidebar width in px (see `lib/shell/app-sidebar`). */
  [LOCAL_STORAGE_KEY.SIDEBAR_WIDTH]: z.number().default(264),
  /** Whether the inline app sidebar is collapsed to the icon rail. */
  [LOCAL_STORAGE_KEY.SIDEBAR_MINIMIZED]: z.boolean().default(false),
  /** Collapsed thread group labels in the app sidebar. */
  [LOCAL_STORAGE_KEY.SIDEBAR_COLLAPSED_GROUPS]: z.array(z.string()).default([]),
  /**
   * Last weather snapshot, cached across reloads so the rail paints without a
   * fetch (see `hooks/use-weather`). `fetchedAt` is epoch-ms; the default's `0`
   * reads as already-stale, so an empty cache resolves to "no snapshot".
   */
  [LOCAL_STORAGE_KEY.WEATHER_CACHE]: z
    .object({ data: weatherSnapshotSchema.nullable(), fetchedAt: z.number() })
    .default({ data: null, fetchedAt: 0 }),
} as const satisfies Record<string, z.ZodDefault>;

export type LocalStorageKey = keyof typeof LOCAL_STORAGE_SCHEMAS;
export type LocalStorageValue<K extends LocalStorageKey> = z.infer<
  (typeof LOCAL_STORAGE_SCHEMAS)[K]
>;
