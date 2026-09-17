import { useSyncExternalStore } from 'react'

type InstallPrompt = Event & { prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }> }
let prompt: InstallPrompt | null = null
let installed = false
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Capture install availability before authentication finishes. No notification permission is requested. */
export function initializePwa() {
  installed = window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && navigator.standalone === true)
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    prompt = event as InstallPrompt
    changed()
  })
  window.addEventListener('appinstalled', () => { installed = true; prompt = null; changed() })
  if ('serviceWorker' in navigator && window.isSecureContext) {
    void navigator.serviceWorker.register('/notification-sw.js', { scope: '/' }).catch(() => {})
  }
}

export function useAppInstall() {
  const available = useSyncExternalStore(subscribe, () => installed ? 'installed' : prompt ? 'prompt' : 'manual')
  return {
    available,
    async install() {
      const current = prompt
      prompt = null
      changed()
      if (current) await current.prompt()
    },
  }
}
