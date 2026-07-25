/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SENTRY_DSN?: string | undefined;
  readonly VITE_POSTHOG_KEY?: string | undefined;
  readonly VITE_POSTHOG_HOST?: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
