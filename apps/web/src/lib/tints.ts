/** Pastel tile classes, one `bg-app-{tone}-1 text-app-{tone}-4` pair per tone. */
export const APP_TINTS = {
  sky: "bg-app-sky-1 text-app-sky-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  purple: "bg-app-purple-1 text-app-purple-4",
  green: "bg-app-green-1 text-app-green-4",
  pink: "bg-app-pink-1 text-app-pink-4",
  orange: "bg-app-orange-1 text-app-orange-4",
} as const;

export type AppTint = keyof typeof APP_TINTS;
