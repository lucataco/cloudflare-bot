import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PushSettings } from '@gadgets/workshop-shared/api'
import { localPushState } from './pushLocalState'

const lockName = 'gadgets-browser-push'
const workerPath = '/notification-sw.js'
const invalidEnrollmentApis = new WeakSet<RpcStub<AuthenticatedApi>>()

/** Complete cleanup, distinct from the warnings that must survive an auth UI teardown. */
export const PUSH_DISABLED_MESSAGE = 'Notifications are off in this browser.'

/** Revoke this auth scope synchronously, including enrollment calls already holding a duplicate. */
export function invalidatePushEnrollment(api: RpcStub<AuthenticatedApi>): void {
  invalidEnrollmentApis.add(api)
}

class PushSetupError extends Error {}

/** Only messages authored here may be shown; browser/RPC errors can quote secret endpoints. */
export function pushErrorMessage(error: unknown): string {
  return error instanceof PushSetupError ? error.message : 'Could not update browser push. Check your connection and retry.'
}

export function pushSupportProblem(): string | undefined {
  if (!window.isSecureContext) return 'Browser push needs HTTPS (or localhost).'
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window) || !('locks' in navigator)) {
    return 'This browser does not support browser push here. On iPhone or iPad, add this site to your Home Screen and open the installed app (iOS 16.4 or later).'
  }
  if (!('indexedDB' in window)) return 'Browser storage is required to safely enable notifications. Allow site storage and try again.'
  if (Notification.permission === 'denied') return 'Notifications are blocked. Allow notifications for this site in browser settings, then try again.'
}

async function registration() {
  if (!('serviceWorker' in navigator)) return undefined
  const result = await navigator.serviceWorker.getRegistration('/')
  const worker = result?.active ?? result?.waiting ?? result?.installing
  return worker && new URL(worker.scriptURL).pathname === workerPath ? result : undefined
}

async function bounded<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Notification operation timed out.')), 5000) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Disable the persistent display gate first, even if the push service or owner RPC is offline. */
export async function disableBrowserPush(api?: RpcStub<AuthenticatedApi>, ownerId?: string): Promise<string> {
  // Retain the capability across logout, which immediately disposes the auth hook's reference.
  let owned: RpcStub<AuthenticatedApi> | undefined
  let localDisabled = false
  let complete = true
  let deviceId: string | undefined
  try { if (api && 'serviceWorker' in navigator) owned = api.dup() } catch { complete = false }
  try {
    try {
      await localPushState(current => {
        deviceId = !ownerId || current?.ownerId === ownerId ? current?.deviceId : undefined
        return { ...current, enabled: false, generation: crypto.randomUUID() }
      })
      localDisabled = true
    } catch { complete = false }

    const remove = deviceId && owned
      ? bounded(owned.removePushSubscription(deviceId)).catch(() => { complete = false })
      : Promise.resolve()
    const unsubscribe = async () => {
      try {
        const reg = await bounded(registration())
        if (!reg) return
        await bounded(reg.getNotifications({ tag: 'attention' }))
          .then(notifications => notifications.forEach(notification => notification.close()))
          .catch(() => { complete = false })
        try {
          const subscription = await bounded(reg.pushManager.getSubscription())
          if (subscription && !await bounded(subscription.unsubscribe())) complete = false
        } catch { complete = false }
        // Fail closed if persistence failed: remove this worker rather than leave its old opt-in.
        if (!localDisabled) localDisabled = await bounded(reg.unregister())
      } catch { complete = false }
    }
    await Promise.all([remove, 'locks' in navigator
      ? navigator.locks.request(lockName, { signal: AbortSignal.timeout(5000) }, unsubscribe).catch(() => { complete = false })
      : unsubscribe()])
    if (!localDisabled) return 'Could not confirm local notifications are off. Block notifications in browser settings on this shared device.'
    return complete ? PUSH_DISABLED_MESSAGE : 'Notifications are off locally. Browser unsubscribe or device revocation could not be confirmed; block notifications in browser settings on shared devices, or retry cleanup.'
  } finally { owned?.[Symbol.dispose]() }
}

/** Account changes only turn push off. Reconnects and browser/tab closure never turn it on or off. */
export async function reconcilePushOwner(ownerId: string, api: RpcStub<AuthenticatedApi>, isCurrent: () => boolean) {
  if (!('indexedDB' in window)) return
  const current = await localPushState()
  if (isCurrent() && current?.ownerId && current.ownerId !== ownerId) return disableBrowserPush(api, ownerId)
}

/** Called only by the Enable button. Request permission before awaiting anything (user gesture). */
export async function enableBrowserPush(api: RpcStub<AuthenticatedApi>, ownerId: string, settings: PushSettings, signal: AbortSignal): Promise<string> {
  const canceled = () => signal.aborted || invalidEnrollmentApis.has(api)
  if (canceled()) throw new PushSetupError('Notification setup was canceled. Sign in again to enable notifications.')
  const problem = pushSupportProblem()
  if (problem) throw new PushSetupError(problem)
  if (!settings.available || !settings.applicationServerKey) throw new PushSetupError('Browser push is not configured for this deployment. Contact your administrator.')
  const permission = Notification.requestPermission()
  const generation = crypto.randomUUID()
  const owned = api.dup()
  let previousDevice: string | undefined
  try {
    await localPushState(current => {
      previousDevice = current?.ownerId === ownerId ? current.deviceId : undefined
      return { enabled: false, generation, ownerId, deviceId: previousDevice }
    })
    return await navigator.locks.request(lockName, async () => {
      let subscription: PushSubscription | null = null
      let deviceId: string | undefined
      const check = async () => {
        const current = await localPushState()
        if (canceled() || current?.generation !== generation) throw new PushSetupError('Notification setup was canceled. Enable again when ready.')
      }
      try {
        if (await permission !== 'granted') throw new PushSetupError('Notifications were not allowed. Change this site\'s notification permission in browser settings to enable them.')
        await check()
        const reg = await bounded(navigator.serviceWorker.register(workerPath, { scope: '/' }))
        // ready has no timeout and can wait forever after a failed install, so bound it.
        await bounded(navigator.serviceWorker.ready)
        await check()
        const old = await bounded(reg.pushManager.getSubscription())
        if (old && !await bounded(old.unsubscribe())) throw new PushSetupError('Could not replace the previous browser subscription. Try disabling notifications first.')
        if (previousDevice) await bounded(owned.removePushSubscription(previousDevice))
        await check()
        const base64 = settings.applicationServerKey!.replace(/-/g, '+').replace(/_/g, '/')
        const key = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
        subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        await check()
        const data = subscription.toJSON()
        if (!data.endpoint || !data.keys?.p256dh || !data.keys.auth) throw new Error('Browser subscription keys are unavailable.')
        // A timeout must not strand a late receipt; its own capability survives this operation.
        const receiptApi = owned.dup()
        let abandoned = false
        const pending = Promise.resolve(receiptApi.registerPushSubscription({ endpoint: data.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } }))
          .then(async receipt => {
            if (abandoned) await bounded(receiptApi.removePushSubscription(receipt.id)).catch(() => {})
            return receipt
          }).finally(() => receiptApi[Symbol.dispose]())
        let receipt: { id: string }
        try { receipt = await bounded(pending) } catch (error) { abandoned = true; throw error }
        deviceId = receipt.id
        await check()
        const saved = await localPushState(current => current?.generation === generation && !canceled()
          ? { enabled: true, generation, ownerId, deviceId }
          : current ?? { enabled: false, generation: crypto.randomUUID() })
        if (!saved?.enabled || saved.generation !== generation) throw new PushSetupError('Notification setup was canceled. Enable again when ready.')
        return receipt.id
      } catch (error) {
        await Promise.allSettled([
          subscription ? bounded(subscription.unsubscribe()) : Promise.resolve(),
          deviceId ? bounded(owned.removePushSubscription(deviceId)) : Promise.resolve(),
        ])
        // Do not overwrite a newer enrollment or logout from another tab.
        await localPushState(current => current?.generation === generation
          ? { ...current, enabled: false, deviceId: deviceId ?? previousDevice }
          : current ?? { enabled: false, generation }).catch(() => {})
        // Browser/RPC exceptions can contain subscription endpoints. Never surface or log them.
        if (error instanceof PushSetupError) throw error
        // eslint-disable-next-line preserve-caught-error -- Causes can contain secret push endpoints/keys.
        throw new PushSetupError('Could not enable browser push. No local display was enabled. Check browser permissions, available device slots, and connection, then retry.')
      }
    })
  } finally { owned[Symbol.dispose]() }
}
