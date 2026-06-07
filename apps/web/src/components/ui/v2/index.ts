/**
 * App-grammar primitives. Lives alongside the existing
 * dimension-grammar primitives in apps/web/src/components/ui — opt-in
 * per surface by wrapping a subtree in the `.app` class.
 *
 * See ./README.md and archive/visitors-now/design-notes.md.
 */

export { AppButton } from "./button";
export type { AppButtonVariant, AppButtonSize } from "./button";

export { AppCard } from "./card";

export { AppPill } from "./pill";

export { AppInput } from "./input";

export { AppSwitch } from "./switch";

export { AppTextarea } from "./textarea";
export type { AppTextareaVariant } from "./textarea";

export { AppSegmented } from "./segmented";
export type { AppSegmentedItem } from "./segmented";

export { AppSelect } from "./select";
export type { AppSelectOption } from "./select";

export { AppDateTimePicker } from "./date-time-picker";

export { AppThemeProvider, useAppTheme } from "./theme";
export type { AppThemeMode } from "./theme";
export { AppThemed } from "./themed";
export { AppThemeToggle } from "./theme-toggle";
