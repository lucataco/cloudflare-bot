// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi, PublicApi, PushSettings } from '@gadgets/workshop-shared/api'
import type { LocalPushState } from './pushLocalState'
import { disableBrowserPush, enableBrowserPush, invalidatePushEnrollment, pushErrorMessage, pushSupportProblem, reconcilePushOwner } from './browserPush'
import { useAuth } from './useAuth'
import { AuthProvider } from './AuthContext'
import PushSettingsPanel from './PushSettingsPanel'
import { makeTestRoot } from './action-test-harness'

const storage = vi.hoisted(() => ({ value: undefined as LocalPushState | undefined }))
vi.mock('./pushLocalState', () => ({ localPushState: async (update?: (state: LocalPushState | undefined) => LocalPushState) => {
  if (update) storage.value = update(storage.value)
  return storage.value
} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}

function fixture() {
  const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => 'granted')
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('indexedDB', {})
  const unsubscribe = vi.fn<() => Promise<boolean>>(async () => true)
  const subscription = { unsubscribe, toJSON: () => ({ endpoint: 'https://push.example/secret', keys: { p256dh: 'browser-public-key', auth: 'secret-auth' } }) }
  const subscribe = vi.fn<(options: PushSubscriptionOptionsInit) => Promise<typeof subscription>>(async () => subscription)
  const close = vi.fn<() => void>()
  const registration = {
    active: { scriptURL: 'https://workshop.test/notification-sw.js' },
    pushManager: { subscribe, getSubscription: vi.fn<() => Promise<typeof subscription | null>>(async () => null) },
    getNotifications: vi.fn<() => Promise<{ close: typeof close }[]>>(async () => [{ close }]), unregister: vi.fn<() => Promise<boolean>>(async () => true),
  }
  const register = vi.fn<() => Promise<typeof registration>>(async () => registration)
  vi.stubGlobal('navigator', {
    serviceWorker: { register, ready: Promise.resolve(registration), getRegistration: async () => registration },
    locks: { request: async (_name: string, optionsOrCallback: unknown, callback?: () => unknown) =>
      callback ? callback() : (optionsOrCallback as () => unknown)() },
  })
  const api = {
    registerPushSubscription: vi.fn<AuthenticatedApi['registerPushSubscription']>(async () => ({ id: 'this-device' })),
    removePushSubscription: vi.fn<AuthenticatedApi['removePushSubscription']>(async () => {}),
    dup: () => api,
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { api: api as unknown as RpcStub<AuthenticatedApi>, methods: api, registration, subscription, subscribe, unsubscribe, register, requestPermission, close }
}
const settings: PushSettings = { available: true, applicationServerKey: 'AQID', devices: [] }

describe('explicit browser push', () => {
  beforeEach(() => { storage.value = undefined })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('does no enrollment on support checks or owner reconciliation; enrolls only on explicit enable', async () => {
    const f = fixture()
    expect(pushSupportProblem()).toBeUndefined()
    await reconcilePushOwner('owner', f.api, () => true)
    expect(f.register).not.toHaveBeenCalled()
    expect(f.requestPermission).not.toHaveBeenCalled()
    await enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)
    expect(f.requestPermission).toHaveBeenCalledOnce()
    expect(f.register).toHaveBeenCalledExactlyOnceWith('/notification-sw.js', { scope: '/' })
    expect(f.subscribe.mock.calls[0][0]).toMatchObject({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) })
    expect(f.methods.registerPushSubscription).toHaveBeenCalledExactlyOnceWith(f.subscription.toJSON())
    expect(storage.value).toMatchObject({ enabled: true, ownerId: 'owner', deviceId: 'this-device' })
    expect(JSON.stringify(storage.value)).not.toContain('secret')
  })

  it('explains denied, unsupported, and unconfigured without requesting permission', async () => {
    const f = fixture()
    Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true })
    await expect(enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)).rejects.toThrow('browser settings')
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true })
    await expect(enableBrowserPush(f.api, 'owner', { ...settings, available: false }, new AbortController().signal)).rejects.toThrow('not configured')
    vi.stubGlobal('PushManager', undefined)
    vi.stubGlobal('navigator', {})
    expect(pushSupportProblem()).toContain('Home Screen')
    expect(f.requestPermission).not.toHaveBeenCalled()
  })

  it('cleans up and keeps display disabled after registration fails without leaking endpoint errors', async () => {
    const f = fixture()
    f.methods.registerPushSubscription.mockRejectedValue(new Error('https://push.example/secret'))
    await expect(enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)).rejects.toThrow('Could not enable browser push.')
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(storage.value?.enabled).toBe(false)
    expect(pushErrorMessage(new Error('Notifications were not allowed: https://push.example/secret'))).not.toContain('secret')
  })

  it('leaves display off when service-worker registration fails, without creating a push subscription', async () => {
    const f = fixture()
    f.register.mockRejectedValue(new Error('worker registration failed'))
    await expect(enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)).rejects.toThrow('Could not enable browser push.')
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(storage.value?.enabled).toBe(false)
    expect(f.methods[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('revokes a receipt arriving after the RPC deadline and releases its owned capability', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const receipt = deferred<{ id: string }>()
    f.methods.registerPushSubscription.mockReturnValue(receipt.promise)
    const result = enableBrowserPush(f.api, 'owner', settings, new AbortController().signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.methods.registerPushSubscription).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toBeInstanceOf(Error)
    expect(storage.value?.enabled).toBe(false)
    receipt.resolve({ id: 'late-receipt' })
    await vi.waitFor(() => expect(f.methods.removePushSubscription).toHaveBeenCalledWith('late-receipt'))
    expect(f.methods[Symbol.dispose]).toHaveBeenCalledTimes(2)
  })

  it('logout disables before failing revocation/unsubscribe and closes existing notifications', async () => {
    const f = fixture()
    storage.value = { enabled: true, ownerId: 'owner', deviceId: 'this-device', generation: 'old' }
    f.registration.pushManager.getSubscription.mockResolvedValue(f.subscription)
    f.methods.removePushSubscription.mockImplementation(async () => { expect(storage.value?.enabled).toBe(false); throw new Error('offline') })
    f.unsubscribe.mockRejectedValue(new Error('offline'))
    expect(await disableBrowserPush(f.api)).toContain('off locally')
    expect(f.methods.removePushSubscription).toHaveBeenCalledWith('this-device')
    expect(f.close).toHaveBeenCalledOnce()
    expect(storage.value?.enabled).toBe(false)
    expect(f.requestPermission).not.toHaveBeenCalled()
  })

  it('revokes a late enrollment after logout and never reopens the local gate', async () => {
    const f = fixture()
    const receipt = deferred<{ id: string }>()
    f.methods.registerPushSubscription.mockReturnValue(receipt.promise)
    const enabled = enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)
    const rejected = enabled.catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.methods.registerPushSubscription).toHaveBeenCalledOnce())
    await disableBrowserPush(f.api)
    receipt.resolve({ id: 'late-device' })
    expect(await rejected).toBeInstanceOf(Error)
    expect((await rejected as Error).message).toContain('canceled')
    expect(f.methods.removePushSubscription).toHaveBeenCalledWith('late-device')
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(storage.value?.enabled).toBe(false)
  })

  it('still disables locally and unsubscribes when the auth capability and notification enumeration fail', async () => {
    const f = fixture()
    f.methods.dup = () => { throw new Error('disposed') }
    f.registration.getNotifications.mockRejectedValue(new Error('permission denied'))
    f.registration.pushManager.getSubscription.mockResolvedValue(f.subscription)
    storage.value = { enabled: true, ownerId: 'owner', deviceId: 'this-device', generation: 'old' }
    await disableBrowserPush(f.api)
    expect(storage.value.enabled).toBe(false)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('clears a previous owner but not the same owner on reconnect or a stale identity response', async () => {
    const f = fixture()
    storage.value = { enabled: true, ownerId: 'first', deviceId: 'first-device', generation: 'old' }
    await reconcilePushOwner('first', f.api, () => true)
    expect(storage.value.enabled).toBe(true)
    await reconcilePushOwner('second', f.api, () => false)
    expect(storage.value.enabled).toBe(true)
    await reconcilePushOwner('second', f.api, () => true)
    expect(storage.value.enabled).toBe(false)
    // The new account's capability cannot revoke an old owner's receipt.
    expect(f.methods.removePushSubscription).not.toHaveBeenCalled()
  })

  it('rejects an invalidated scope before permission/storage work and fences an already-running enrollment', async () => {
    const f = fixture()
    const receipt = deferred<{ id: string }>()
    f.methods.registerPushSubscription.mockReturnValue(receipt.promise)
    const pending = enableBrowserPush(f.api, 'owner', settings, new AbortController().signal).catch((error: unknown) => error)
    await vi.waitFor(() => expect(f.methods.registerPushSubscription).toHaveBeenCalledOnce())
    invalidatePushEnrollment(f.api)
    // Invalidation is synchronous; no IDB write or component unmount is needed to block another call.
    await expect(enableBrowserPush(f.api, 'owner', settings, new AbortController().signal)).rejects.toThrow('canceled')
    expect(f.requestPermission).toHaveBeenCalledOnce()
    receipt.resolve({ id: 'old-scope-device' })
    expect(await pending).toBeInstanceOf(Error)
    expect(storage.value?.enabled).toBe(false)
    expect(f.methods.removePushSubscription).toHaveBeenCalledWith('old-scope-device')
    const next = fixture()
    await enableBrowserPush(next.api, 'new-owner', settings, new AbortController().signal)
    expect(storage.value).toMatchObject({ enabled: true, ownerId: 'new-owner' })
  })

  it('unmounts enrollment immediately on logout, retains only the cleanup capability, and shows late cleanup failure', async () => {
    const f = fixture()
    const view = makeTestRoot()
    let rejectRemoval!: (error: unknown) => void
    f.methods.removePushSubscription.mockReturnValue(new Promise((_resolve, reject) => { rejectRemoval = reject }))
    f.registration.pushManager.getSubscription.mockResolvedValue(f.subscription)
    storage.value = { enabled: true, generation: 'old', ownerId: 'owner', deviceId: 'this-device' }
    // Actual Cap'n Web reference counting: logout must release its reference, not cleanup's dup.
    class Owner extends RpcTarget {
      async whoami() { return { type: 'user', id: 'owner', name: 'Owner' } }
      async amIAdmin() { return false }
      async getPushSettings() { return settings }
      registerPushSubscription(data: Parameters<AuthenticatedApi['registerPushSubscription']>[0]) { return f.methods.registerPushSubscription(data) }
      removePushSubscription(id: string) { return f.methods.removePushSubscription(id) }
      [Symbol.dispose]() { f.methods[Symbol.dispose]() }
    }
    const api = new RpcStub(new Owner()) as unknown as RpcStub<AuthenticatedApi>
    const publicApi = { authenticate: () => api } as unknown as RpcStub<PublicApi>
    let auth!: ReturnType<typeof useAuth>
    function App() {
      auth = useAuth(publicApi)
      return auth.isAuthenticated && auth.authenticatedApi
        ? <AuthProvider authenticatedApi={auth.authenticatedApi} onLogout={auth.logout}><PushSettingsPanel /></AuthProvider>
        : <output>{auth.pushCleanupNotice ?? 'Signed out'}</output>
    }
    localStorage.setItem('authToken', 'synthetic-token')
    try {
      await view.render(<App />)
      expect(document.body.textContent).toContain('Enable in this browser')
      let logout: Promise<void> | undefined
      await act(async () => { logout = auth.logout() })
      expect(auth.isAuthenticated).toBe(false)
      expect(document.body.textContent).not.toContain('Enable in this browser')
      await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce())
      expect(storage.value?.enabled).toBe(false)
      expect(f.methods.removePushSubscription).toHaveBeenCalledWith('this-device')
      expect(f.methods[Symbol.dispose]).not.toHaveBeenCalled()
      // The local gate is off and the browser lock is free, but the revoke RPC is still pending.
      await expect(enableBrowserPush(api, 'owner', settings, new AbortController().signal)).rejects.toThrow('canceled')
      expect(f.requestPermission).not.toHaveBeenCalled()
      expect(storage.value?.enabled).toBe(false)
      await act(async () => { rejectRemoval(new Error('offline')); await logout })
      expect(document.body.textContent).toContain('Browser unsubscribe or device revocation could not be confirmed')
      expect(f.methods[Symbol.dispose]).toHaveBeenCalledOnce()
      expect(storage.value?.enabled).toBe(false)
    } finally {
      view.cleanup()
      localStorage.removeItem('authToken')
    }
  })
})
