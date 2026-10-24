/**
 * Model-tier picker. The `tier` goes with each turn; the server maps it through `route`.
 * `route` is in server-only `@alfred/ai`; keep it out of web (`pnpm check:web-boundaries`).
 */
import type { ChatModelTier } from "@alfred/contracts";
import { useAppTheme } from "~/components/ui/v2";
import type { AppResolvedTheme } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";
import { TIER_OPTIONS, tierOption } from "./model-tier-options";
import { PickerChevron, PickerMenu, PickerMenuItem } from "./picker-menu";
import { pickerTriggerClass, pickerTriggerNeutralClass } from "./picker-menu-classes";

// A distinct mark per tier, light and dark variants (public/images/logo/alfred-logo{,-pro}-{light,dark}.svg).
const TIER_MARK = {
  standard: {
    light: "/images/logo/alfred-logo-light.svg",
    dark: "/images/logo/alfred-logo-dark.svg",
  },
  deep: {
    light: "/images/logo/alfred-logo-pro-light.svg",
    dark: "/images/logo/alfred-logo-pro-dark.svg",
  },
} satisfies Record<ChatModelTier, Record<AppResolvedTheme, string>>;

export function ModelTierPicker({
  value,
  onChange,
  disabled,
}: {
  value: ChatModelTier;
  onChange: (value: ChatModelTier) => void;
  disabled?: boolean | undefined;
}) {
  const { resolved } = useAppTheme();
  const selected = tierOption(value);

  return (
    <PickerMenu
      label="Model tier"
      value={value}
      tip="Choose how hard Alfred thinks"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className={cn(pickerTriggerClass, pickerTriggerNeutralClass)}
        >
          <img src={TIER_MARK[selected.value][resolved]} alt="" className="size-[18px] shrink-0" />
          {selected.label}
          <PickerChevron />
        </button>
      }
    >
      {TIER_OPTIONS.map((option) => (
        <PickerMenuItem
          key={option.value}
          value={option.value}
          label={option.label}
          description={option.description}
          icon={
            <img
              src={TIER_MARK[option.value][resolved]}
              alt=""
              className="mt-0.5 size-7 shrink-0"
            />
          }
          onSelect={() => onChange(option.value)}
        />
      ))}
    </PickerMenu>
  );
}
