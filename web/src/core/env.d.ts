/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = always use the built-in mock data instead of the Worker API. */
  readonly VITE_MOCK?: string;
}
