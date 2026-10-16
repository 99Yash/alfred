import { db } from "@alfred/db";
import { userPreferences } from "@alfred/db/schemas";
import { type IanaTimezone } from "@alfred/contracts";

import { firstValidTimezone, TIMEZONE_PREFERENCE_KEYS } from "@alfred/assistant/time";
import { featureFlagsFrom, type FeatureFlags } from "./flags";
import {
  deletePreferenceRow,
  readPreferenceRows,
  rowToPref,
  setPreferenceArgsSchema,
  upsertPreference,
  type PreferenceExecutor,
  type PreferenceRow,
  type SetPreferenceArgs,
} from "./preferences";

interface PreferenceView {
  rows: readonly PreferenceRow[];
  byKey: ReadonlyMap<string, PreferenceRow>;
}

/**
 * One user's settings, bound once. The first read verb loads every preference row of the user
 * in ONE query; every later read verb on the same bind derives from that load. So the flags and
 * the zone in one flow cost one SELECT. A write through the bind drops the loaded view, so the
 * next read on the bind reads again and sees the write.
 *
 * Freshness: the loaded view never expires. Bind per request, per workflow step, or per job
 * item, and let the bind go out of scope with it. Never hold a bind at module scope or across a
 * long loop over many units of work: it would serve a stale zone or flag forever
 * (`pnpm check` rejects a module-scope bind). When a flow must see a change that another module
 * writes during the flow, take a new bind after that write.
 *
 * `exec` is `db()` by default. Pass a Replicache push `tx` to read and write inside that
 * transaction; the writes then commit or roll back with it.
 */
export function settings({ userId, exec }: { userId: string; exec?: PreferenceExecutor }) {
  // `db()` at call time, never at bind time, so a bind does not pin a pool at module init.
  const executor = (): PreferenceExecutor => exec ?? db();
  let view: Promise<PreferenceView> | undefined;

  function load(): Promise<PreferenceView> {
    if (view) return view;

    const pending = readPreferenceRows(executor(), userId).then((rows) => ({
      rows,
      byKey: new Map(rows.map((row) => [row.key, row])),
    }));

    view = pending;
    // A failed load is not kept: the next read retries, as each uncached read did before.
    pending.catch(() => {
      if (view === pending) view = undefined;
    });

    return pending;
  }

  return {
    /** The row for `key`, or `null` when the user never set it. */
    async get(key: string): Promise<PreferenceRow | null> {
      return (await load()).byKey.get(key) ?? null;
    },

    /** Every row of the user, ordered by key ascending. */
    async all(): Promise<readonly PreferenceRow[]> {
      return (await load()).rows;
    },

    /** The user's zone: `timezone`, then legacy `briefing.timezone`, then UTC (ADR-0082). */
    async timezone(): Promise<IanaTimezone> {
      const { byKey } = await load();

      return firstValidTimezone(TIMEZONE_PREFERENCE_KEYS.map((key) => byKey.get(key)?.value));
    },

    /** Every Settings > Features toggle, with its contract default when unset. */
    async flags(): Promise<FeatureFlags> {
      const { byKey } = await load();

      return featureFlagsFrom((key) => byKey.get(key));
    },

    /** Validates, then upserts. Last write wins and `row_version` goes up for Replicache. */
    async set(
      key: string,
      value: SetPreferenceArgs["value"],
      options?: Pick<SetPreferenceArgs, "source">,
    ): Promise<PreferenceRow> {
      const parsed = setPreferenceArgsSchema.parse({ userId, key, value, source: options?.source });
      const [row] = await upsertPreference(executor(), parsed).returning();

      view = undefined;

      if (!row) throw new Error("[settings] set returned no row");

      return rowToPref(row);
    },

    /** Reverts `key` to its default. `false` when the user had no row for it. */
    async delete(key: string): Promise<boolean> {
      const removed = await deletePreferenceRow(executor(), userId, key).returning({
        id: userPreferences.id,
      });

      view = undefined;

      return removed.length > 0;
    },
  };
}

/** A bound {@link settings} handle. Pass it down a flow so every read shares one load. */
export type UserSettings = ReturnType<typeof settings>;
