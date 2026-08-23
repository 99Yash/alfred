import type { ReactNode } from "react";

export interface TabPillOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode | undefined;
  /**
   * Short marker after the label — used for a "Soon" tag on a tab whose
   * feature is on the roadmap rather than shipped. The tab still works and
   * still shows its panel; the tag only stops the panel from reading as a
   * claim about today.
   */
  badge?: string | undefined;
}

/** Stable id for a tab button — pair with `tabPanelId` for `aria-controls`. */
export function tabButtonId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

/** Stable id for a tab panel — set on the panel and referenced by `aria-controls`. */
export function tabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}
