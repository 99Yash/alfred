// Client-side env vars are read via import.meta.env in the web app directly.
// This module exposes defaults for shared reference.
export const CLIENT_DEFAULTS = {
  VITE_API_URL: "http://localhost:3001",
} as const;

export type ClientDefaults = typeof CLIENT_DEFAULTS;
