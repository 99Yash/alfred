import NumberFlow from "@number-flow/react";
import { costFractionDigits } from "~/lib/usage-format";

/**
 * A cost figure whose digits roll when the value changes — the thread total
 * ticking up as turns land, a streaming turn's spend climbing live. Same
 * thresholds as `formatCost` (via {@link costFractionDigits}), so the flow
 * lands on the exact figures the tooltips quote. Static when the value never
 * changes, and still under `prefers-reduced-motion`.
 *
 * The `$` stays outside, in the caller's faint ink, matching the static
 * readouts this replaces.
 */
export function CostFlow({ value }: { value: number }) {
  return <NumberFlow value={value} format={costFractionDigits(value)} respectMotionPreference />;
}
