/** Production app primitives. Legacy versions live in ../legacy for the styleguide. See ./README.md. */

export { AppButton } from "./button";

export { AppCard } from "./card";

export { AppPill } from "./pill";

export { AppInput } from "./input";

export { AppSwitch } from "./switch";

export { AppTextarea } from "./textarea";

export { AppSegmented } from "./segmented";

export type { AppSegmentedItem } from "./segmented";

export { AppSelect } from "./select";

export type { AppSelectOption } from "./select";

export { AppField, AppFieldError } from "./field";

// `useAppForm` is deliberately NOT re-exported here. The shell imports this
// barrel eagerly, and `./form` pulls `@tanstack/react-form`, so a re-export
// put the whole form engine in the entry chunk. Form consumers import
// `~/components/ui/v2/form` directly (see ./README.md).

export { AppModal } from "./modal";

export { omitBlankStringFields } from "./form-values";

export { AppDateTimePicker } from "./date-time-picker";

export { AppThemeProvider, useAppTheme } from "./theme";

export { AppThemed } from "./themed";

export { AppThemeToggle } from "./theme-toggle";

export {
  appMenuDangerItemClass,
  appMenuItemClass,
  appMenuSeparatorClass,
  appMenuSurfaceClass,
} from "./menu";
