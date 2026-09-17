import { describe, expect, it, vi } from 'vitest'
import source from '../public/notification-sw.js?raw'

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {}
  const state = { enabled: true, generation: 'one' }
  const close = vi.fn<() => void>()
  const focus = vi.fn<() => Promise<void>>(async () => {})
  const navigate = vi.fn<(url: string) => Promise<{ focus: typeof focus }>>(async () => ({ focus }))
  const clients = {
    claim: async () => {},
    matchAll: vi.fn<() => Promise<{ url: string; navigate: typeof navigate }[]>>(async () => [{ url: 'https://workshop.test/agents/bot#private', navigate }]),
    openWindow: vi.fn<(url: string) => Promise<void>>(async () => {}),
  }
  const registration = { showNotification: vi.fn<(title: string, options: unknown) => Promise<void>>(async () => {}), getNotifications: async () => [{ close }] }
  // A minimal async IDB read boundary. The state itself is persisted by the browser module.
  const indexedDB = { open: () => {
    const onSuccess = (name: string, callback: () => void) => { if (name === 'success') queueMicrotask(callback) }
    const request = { result: { createObjectStore() {}, close() {}, transaction: () => ({
      objectStore: () => ({ get: () => {
        return { result: { ...state }, addEventListener: onSuccess }
      } }),
      addEventListener() {},
    }) }, addEventListener: onSuccess }
    return request
  } }
  new Function('indexedDB', 'self', source)(indexedDB, {
    location: { origin: 'https://workshop.test' }, clients, registration, skipWaiting: async () => {},
    addEventListener: (event: string, handler: (event: unknown) => void) => { handlers[event] = handler },
  })
  const emit = (name: string, data: object = {}) => new Promise<void>((resolve, reject) => {
    handlers[name]({ ...data, waitUntil: (promise: Promise<void>) => promise.then(resolve, reject) })
  })
  return { state, emit, registration, clients, navigate, focus, close, handlers }
}

describe('notification-only service worker', () => {
  it('ignores all payload presentation and coalesces with a constant tag', async () => {
    const w = worker()
    await w.emit('push', { data: { json: () => ({ title: 'SECRET', body: '<script>secret</script>', url: 'https://evil.test', workspaceTitle: 'Private' }) } })
    expect(w.registration.showNotification).toHaveBeenCalledExactlyOnceWith('Attention', {
      body: 'You have a workspace update. Open Attention to review it.', tag: 'attention',
    })
    expect(w.handlers.fetch).toBeUndefined()
    expect(source).not.toMatch(/caches\.|fetch\(/)
  })

  it('fails closed on malformed JSON and the persistent logout gate', async () => {
    const w = worker()
    await w.emit('push', { data: { json: () => { throw new Error('malformed') } } })
    w.state.enabled = false
    await w.emit('push', { data: { json: () => ({}) } })
    expect(w.registration.showNotification).not.toHaveBeenCalled()
    await w.emit('notificationclick', { notification: { close: w.close, data: { url: 'https://evil.test' } } })
    expect(w.navigate).not.toHaveBeenCalled()
    expect(w.clients.openWindow).not.toHaveBeenCalled()
  })

  it('closes a notification if logout races its display', async () => {
    const w = worker()
    w.registration.showNotification.mockImplementation(async () => { w.state.enabled = false })
    await w.emit('push', { data: { json: () => ({}) } })
    expect(w.close).toHaveBeenCalledOnce()
  })

  it('navigates/focuses only the constant same-origin attention URL, dropping fragments and payload locators', async () => {
    const w = worker()
    await w.emit('notificationclick', { notification: { close: w.close, data: { url: 'javascript:alert(1)', chatId: 99 } } })
    expect(w.navigate).toHaveBeenCalledExactlyOnceWith('https://workshop.test/attention')
    expect(w.focus).toHaveBeenCalledOnce()
    expect(w.clients.openWindow).not.toHaveBeenCalled()
    w.clients.matchAll.mockResolvedValue([])
    await w.emit('notificationclick', { notification: { close: w.close } })
    expect(w.clients.openWindow).toHaveBeenCalledExactlyOnceWith('https://workshop.test/attention')
  })
})
