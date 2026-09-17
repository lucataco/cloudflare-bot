// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import manifest from '../public/notification-manifest.webmanifest?raw'
import { initializePwa } from './pwa'

describe('app installation', () => {
  it('retains the installed identity and exposes mobile entry points and sized icons', () => {
    const app = JSON.parse(manifest)
    expect(app.id).toBe('/attention')
    expect(app.display).toBe('standalone')
    expect(app.scope).toBe('/')
    expect(app.shortcuts.map((shortcut: {url: string}) => shortcut.url)).toEqual(['/attention', '/agents', '/computers'])
    expect(app.icons.map((icon: {sizes: string}) => icon.sizes)).toEqual(['192x192', '512x512'])
  })
  it('registers the existing worker without requesting notification permission', async () => {
    const register = vi.fn<(...args: unknown[]) => Promise<object>>().mockResolvedValue({})
    const requestPermission = vi.fn<() => void>()
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('matchMedia', () => ({matches: false}))
    vi.stubGlobal('Notification', {requestPermission})
    Object.defineProperty(navigator, 'serviceWorker', {configurable: true, value: {register}})
    initializePwa()
    expect(register).toHaveBeenCalledWith('/notification-sw.js', {scope: '/'})
    expect(requestPermission).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })
})
