import { useEffect, useRef } from 'react'
import { telegramBackButton } from './telegram'

/** Open dialogs, bottom-most first. Telegram BackButton and Escape always close the top-most one. */
const openDialogs: Array<{ close: () => void }> = []

function closeTopDialog() {
  openDialogs[openDialogs.length - 1]?.close()
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && openDialogs.length) { event.preventDefault(); closeTopDialog() }
}

let controlsAttached = false

function syncControls() {
  const shouldAttach = openDialogs.length > 0
  if (shouldAttach === controlsAttached) return
  controlsAttached = shouldAttach
  const backButton = telegramBackButton()
  if (shouldAttach) {
    document.addEventListener('keydown', onKeyDown)
    backButton?.onClick(closeTopDialog)
    backButton?.show()
  } else {
    document.removeEventListener('keydown', onKeyDown)
    backButton?.offClick(closeTopDialog)
    backButton?.hide()
  }
}

/** Registers a modal: Escape / Telegram BackButton close it, focus moves into it and is restored afterwards. */
export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const containerRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const entry = { close: () => closeRef.current() }
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openDialogs.push(entry)
    syncControls()
    containerRef.current?.focus()
    return () => {
      const index = openDialogs.indexOf(entry)
      if (index >= 0) openDialogs.splice(index, 1)
      syncControls()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  return containerRef
}
