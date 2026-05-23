/**
 * Visitors-now-grammar primitives. Lives alongside the existing
 * dimension-grammar primitives in apps/web/src/components/ui — opt-in
 * per surface by wrapping a subtree in the `.vs` class.
 *
 * See ./README.md and archive/visitors-now/design-notes.md.
 */

export { VsButton } from "./button";
export type { VsButtonVariant, VsButtonSize } from "./button";

export { VsCard, VsCardHeader } from "./card";

export { VsPill } from "./pill";

export { VsKpi } from "./kpi";

export { VsDock } from "./dock";
export type { VsDockItem } from "./dock";

export { VsHeader } from "./header";

export { VsInput } from "./input";

export { VsSwitch } from "./switch";

export { VsTextarea } from "./textarea";
export type { VsTextareaVariant } from "./textarea";

export { VsSegmented } from "./segmented";
export type { VsSegmentedItem } from "./segmented";

export { VsThemeProvider, useVsTheme, VsThemed, VsThemeToggle } from "./theme";
export type { VsThemeMode } from "./theme";
