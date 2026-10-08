import type { ReactNode } from "react";

export interface TabPillOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode | undefined;
  /** A "Soon" tag for a roadmap feature. The tab still works. */
  badge?: string | undefined;
}

/** Pair with `tabPanelId` for `aria-controls`. */
export function tabButtonId(idBase: string, value: string): string {
  return `${idBase}-tab-${value}`;
}

export function tabPanelId(idBase: string, value: string): string {
  return `${idBase}-panel-${value}`;
}
