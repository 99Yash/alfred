import type { UsageRunCategory } from "@alfred/contracts";
import { useMemo, useState } from "react";
import { AppButton, AppSegmented } from "~/components/ui/v2";
import { ActivityTable } from "./activity-table";
import { CategoryCards } from "./category-cards";
import {
  USAGE_RANGE_LABELS,
  USAGE_RANGE_PRESETS,
  resolveRangePreset,
  type UsageRangePreset,
} from "./constants";
import { OverviewStrip } from "./overview-strip";

const RANGE_ITEMS = USAGE_RANGE_PRESETS.map((preset) => ({
  value: preset,
  label: USAGE_RANGE_LABELS[preset],
}));

/** Settings → Usage over `api_call_log`. Owns the range and category state; children fetch their own data. */
export function UsageSection() {
  const [preset, setPreset] = useState<UsageRangePreset>("30d");
  const [selected, setSelected] = useState<ReadonlyArray<UsageRunCategory>>([]);

  // Fix "now" per range choice, so the query keys stay stable.
  const window = useMemo(() => {
    const { start, end } = resolveRangePreset(preset, new Date());

    return { start: start.toISOString(), end: end.toISOString() };
  }, [preset]);

  const toggleCategory = (category: UsageRunCategory) => {
    setSelected((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category],
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-app-fg-4">Usage</p>
          <p className="text-xs text-app-fg-3">What Alfred spent working on your behalf, by run.</p>
        </div>
        <AppSegmented
          value={preset}
          onValueChange={setPreset}
          items={RANGE_ITEMS}
          label="Date range"
        />
      </div>

      <OverviewStrip start={window.start} end={window.end} />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-app-fg-3">By category</p>
          {selected.length > 0 ? (
            <AppButton size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear filter
            </AppButton>
          ) : null}
        </div>
        <CategoryCards
          start={window.start}
          end={window.end}
          selected={selected}
          onToggle={toggleCategory}
        />
      </div>

      <ActivityTable start={window.start} end={window.end} categories={selected} />
    </div>
  );
}
