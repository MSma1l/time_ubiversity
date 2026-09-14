type TelegramBackButton = { show(): void, hide(): void, onClick(callback: () => void): void, offClick(callback: () => void): void }

type TelegramWebApp = {
  initData: string
  initDataUnsafe?: { user?: { first_name?: string, last_name?: string } }
  version?: string
  ready(): void
  expand(): void
  isVersionAtLeast?(version: string): boolean
  setHeaderColor?(color: string): void
  setBackgroundColor?(color: string): void
  disableVerticalSwipes?(): void
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void
  BackButton?: TelegramBackButton
}

declare global { interface Window { Telegram?: { WebApp?: TelegramWebApp } } }

const APP_BACKGROUND = '#f8fafc'

/** The SDK script defines `Telegram.WebApp` even in a plain browser; only a signed initData means we run inside Telegram. */
function telegramApp() {
  const app = window.Telegram?.WebApp
  return app?.initData ? app : undefined
}

const supports = (app: TelegramWebApp, version: string) => app.isVersionAtLeast?.(version) ?? false

export function initializeTelegram() {
  const app = telegramApp()
  if (!app) return
  try {
    app.ready()
    app.expand()
    if (supports(app, '6.1')) { app.setHeaderColor?.(APP_BACKGROUND); app.setBackgroundColor?.(APP_BACKGROUND) }
    // Lets modal panels scroll without the swipe-down gesture closing the Mini App.
    if (supports(app, '7.7')) app.disableVerticalSwipes?.()
  } catch (error) {
    console.warn('Telegram WebApp initialization failed', error)
  }
}

export type SessionMode = 'telegram' | 'dev' | 'demo' | 'none'
export type Session = { mode: SessionMode, name: string }

/**
 * - telegram: opened inside Telegram (signed initData), data is synced with the API.
 * - dev: local development with VITE_DEV_TELEGRAM_ID (backend ALLOW_DEV_AUTH=true).
 * - demo: sample data, never synced — only on the Vite dev server or an explicit VITE_DEMO_MODE=true build.
 * - none: production build opened outside Telegram; the app asks the user to open it from the bot.
 */
export function detectSession(devTelegramId: string): Session {
  const app = telegramApp()
  if (app) return { mode: 'telegram', name: app.initDataUnsafe?.user?.first_name ?? '' }
  if (devTelegramId) return { mode: 'dev', name: 'Developer' }
  if (import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true') return { mode: 'demo', name: 'Alex' }
  return { mode: 'none', name: '' }
}

/** Native Telegram confirm popup when available; `window.confirm` is unreliable inside mobile Telegram WebViews. */
export function confirmAction(message: string): Promise<boolean> {
  const app = telegramApp()
  if (app?.showConfirm && supports(app, '6.2')) {
    return new Promise((resolve) => {
      try { app.showConfirm?.(message, (confirmed) => resolve(Boolean(confirmed))) } catch { resolve(window.confirm(message)) }
    })
  }
  return Promise.resolve(window.confirm(message))
}

export function telegramBackButton() {
  const app = telegramApp()
  return app?.BackButton && supports(app, '6.1') ? app.BackButton : undefined
}
