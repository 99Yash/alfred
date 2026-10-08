/**
 * Every localStorage key and its schema. Each schema needs a `.default(...)`.
 * A domain schema imported here must not import `lib/storage`, or it makes a cycle.
 */

import { chatModelTierSchema } from "@alfred/contracts";
import { z } from "zod";
import { replayStateSchema } from "~/lib/events/replay-state";
import { weatherSnapshotSchema } from "~/lib/weather";

export const LOCAL_STORAGE_KEY = {
  APP_THEME: "app-theme",
  CHAT_TIER: "alfred.chat.tier",
  MAYBE_AUTHED: "alfred.maybe-authed",
  ONBOARDING_COMPLETE: "alfred.onboarding-complete",
  ONBOARDING_USER_ID: "alfred.onboarding-user-id",
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
  [LOCAL_STORAGE_KEY.APP_THEME]: z.enum(["system", "dark", "light"]).default("system"),
  /** Chat tier (Auto or Deep). Local only; not synced across devices. */
  [LOCAL_STORAGE_KEY.CHAT_TIER]: chatModelTierSchema.default("standard"),
  /** First-paint "signed in" hint. Not a security boundary. */
  [LOCAL_STORAGE_KEY.MAYBE_AUTHED]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /** First-paint "onboarded" hint. Not a security boundary. */
  [LOCAL_STORAGE_KEY.ONBOARDING_COMPLETE]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /** The user the onboarding hint belongs to. */
  [LOCAL_STORAGE_KEY.ONBOARDING_USER_ID]: z.string().nullable().default(null),
  /** SSE replay cursor and run barriers. */
  [LOCAL_STORAGE_KEY.EVENT_REPLAY_STATE]: replayStateSchema,
  [LOCAL_STORAGE_KEY.CHAT_SOUND_PREFERENCE]: z
    .enum(["always", "unfocused", "mute"])
    .default("unfocused"),
  /** The one-time chime hint was shown. */
  [LOCAL_STORAGE_KEY.CHAT_NOTIFY_ONBOARDED]: z
    .preprocess((value) => (value === 1 ? true : value === 0 ? false : value), z.boolean())
    .default(false),
  /** Width in px. */
  [LOCAL_STORAGE_KEY.ARTIFACT_PANEL_WIDTH]: z.number().default(460),
  /** Width in px. */
  [LOCAL_STORAGE_KEY.SIDEBAR_WIDTH]: z.number().default(264),
  [LOCAL_STORAGE_KEY.SIDEBAR_MINIMIZED]: z.boolean().default(false),
  [LOCAL_STORAGE_KEY.SIDEBAR_COLLAPSED_GROUPS]: z.array(z.string()).default([]),
  /** `fetchedAt` is epoch ms; the default `0` reads as stale. */
  [LOCAL_STORAGE_KEY.WEATHER_CACHE]: z
    .object({ data: weatherSnapshotSchema.nullable(), fetchedAt: z.number() })
    .default({ data: null, fetchedAt: 0 }),
} as const satisfies Record<string, z.ZodDefault>;

export type LocalStorageKey = keyof typeof LOCAL_STORAGE_SCHEMAS;

export type LocalStorageValue<K extends LocalStorageKey> = z.infer<
  (typeof LOCAL_STORAGE_SCHEMAS)[K]
>;
