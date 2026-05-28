import type { ReactNode } from "react";

export interface TabPillOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/** Stable id for a tab button — pair with `tabPanelId` for `aria-controls`. */
export function tabButtonId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

/** Stable id for a tab panel — set on the panel and referenced by `aria-controls`. */
export function tabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}
