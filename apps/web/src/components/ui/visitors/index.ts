/**
 * Visitors-now-grammar primitives. Lives alongside the existing
 * dimension-grammar primitives in apps/web/src/components/ui — opt-in
 * per surface by wrapping a subtree in the `.vs` class.
 *
 * See ./README.md and archive/visitors-now/design-notes.md.
 */

export { VsButton } from "./button";
export type { VsButtonVariant, VsButtonSize } from "./button";

export { VsCard } from "./card";

export { VsPill } from "./pill";

export { VsInput } from "./input";

export { VsSwitch } from "./switch";

export { VsTextarea } from "./textarea";
export type { VsTextareaVariant } from "./textarea";

export { VsSegmented } from "./segmented";
export type { VsSegmentedItem } from "./segmented";

export { VsThemeProvider, useVsTheme } from "./theme";
export type { VsThemeMode } from "./theme";
export { VsThemed } from "./themed";
export { VsThemeToggle } from "./theme-toggle";
