// The web app reads `import.meta.env` directly. These are only the defaults.
export const CLIENT_DEFAULTS = {
  VITE_API_URL: "http://localhost:3001",
} as const;

export type ClientDefaults = typeof CLIENT_DEFAULTS;
