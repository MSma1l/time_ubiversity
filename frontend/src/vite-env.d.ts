/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute API origin; empty means same-origin (nginx proxies /api). */
  readonly VITE_API_URL?: string
  /** Dev server only: Telegram user id sent as X-Dev-Telegram-Id (backend ALLOW_DEV_AUTH=true). */
  readonly VITE_DEV_TELEGRAM_ID?: string
  /** "true" enables the local demo mode (sample data, no sync) in a production build. */
  readonly VITE_DEMO_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
