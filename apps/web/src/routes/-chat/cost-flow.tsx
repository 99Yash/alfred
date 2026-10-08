import NumberFlow from "@number-flow/react";
import { costFractionDigits } from "~/lib/usage-format";

/**
 * A cost whose digits roll on change, still under reduced motion.
 * Same digits as `formatCost` ({@link costFractionDigits}). The caller draws the `$`.
 */
export function CostFlow({ value }: { value: number }) {
  return <NumberFlow value={value} format={costFractionDigits(value)} respectMotionPreference />;
}
