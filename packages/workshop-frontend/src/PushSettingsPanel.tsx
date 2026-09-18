import { useEffect, useRef, useState } from 'react'
import type { PushSettings } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { disableBrowserPush, enableBrowserPush, pushErrorMessage, pushSupportProblem } from './browserPush'
import { localPushState, type LocalPushState } from './pushLocalState'
import { WorkshopButton } from './components/WorkshopControls'

const deliveryLabels: Record<PushSettings['devices'][number]['delivery'], string> = {
  idle: 'No transport attempt', pending: 'Transport pending', accepted: 'Accepted by push service (not confirmed delivered)', failed: 'Transport failed',
}

export default function PushSettingsPanel() {
  const { authenticatedApi: api } = useAuthenticatedApi()
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState({ api, settings: null as PushSettings | null, ownerId: '', local: undefined as LocalPushState | undefined, error: false })
  const [operation, setOperation] = useState({ api, busy: false, message: '' })
  const scope = useRef({ api, controller: new AbortController() })
  if (scope.current.api !== api) {
    scope.current.controller.abort()
    scope.current = { api, controller: new AbortController() }
  }
  useEffect(() => {
    const current = { api, controller: new AbortController() }
    scope.current = current
    return () => current.controller.abort()
  }, [api])
  useEffect(() => {
    let canceled = false
    Promise.all([api.getPushSettings(), api.whoami(), localPushState().catch(() => undefined)])
      .then(([settings, owner, local]) => {
        if (!canceled) setLoad({ api, settings, ownerId: owner.type === 'user' ? owner.id : '', local, error: false })
      }).catch(() => { if (!canceled) setLoad({ api, settings: null, ownerId: '', local: undefined, error: true }) })
    const refresh = () => setAttempt(value => value + 1)
    window.addEventListener('focus', refresh)
    return () => { canceled = true; window.removeEventListener('focus', refresh) }
  }, [api, attempt])

  const settings = load.api === api ? load.settings : null
  const local = load.api === api && load.local?.ownerId === load.ownerId ? load.local : undefined
  const thisDevice = settings?.devices.find(device => device.id === local?.deviceId)
  const enabled = local?.enabled && !!thisDevice
  const busy = operation.api === api && operation.busy
  const problem = pushSupportProblem()
  const refresh = () => setAttempt(value => value + 1)

  async function run(action: () => Promise<string>) {
    const current = scope.current
    setOperation({ api, busy: true, message: '' })
    try {
      const message = await action()
      if (!current.controller.signal.aborted) setOperation({ api, busy: false, message })
    } catch (error) {
      if (!current.controller.signal.aborted) setOperation({ api, busy: false, message: pushErrorMessage(error) })
    } finally {
      if (!current.controller.signal.aborted) refresh()
    }
  }

  return <section aria-labelledby="push-heading" className="mt-8 rounded-xl border border-kumo-line bg-kumo-elevated p-4 sm:p-5 [&_button]:min-h-11 sm:[&_button]:min-h-8">
    <h2 id="push-heading" className="text-base font-semibold text-kumo-default">Browser push</h2>
    <p className="mt-2 text-sm text-kumo-subtle">Optional background notifications on this device. Delivery depends on your browser and OS. Workspace names and details stay in the app.</p>
    <p className="mt-2 text-sm text-kumo-subtle">Each bot's existing &quot;Notify on updates&quot; setting is a separate filter. Enabling this browser does not change your bot preferences.</p>
    <p className="mt-2 text-sm text-kumo-subtle">Signing out turns notifications off locally. On shared devices, sign out rather than just closing the browser.</p>
    {problem && <p className="mt-3 text-sm text-kumo-subtle">{problem}</p>}
    {load.api === api && load.error && <p role="alert" className="mt-3 text-sm text-kumo-danger">Could not load push settings. <button className="underline" onClick={refresh}>Retry</button></p>}
    {!settings && !load.error && <p role="status" className="mt-3 text-sm text-kumo-subtle">Loading push settings...</p>}
    {settings && <>
      {!settings.available || !settings.applicationServerKey ? <p className="mt-3 text-sm text-kumo-subtle">Browser push is not configured for this deployment. Contact your administrator.</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <WorkshopButton tone="primary" disabled={busy || !!problem || !settings.available || !settings.applicationServerKey || !load.ownerId || enabled || (settings.devices.length >= 5 && !thisDevice)}
          onClick={() => void run(async () => {
            await enableBrowserPush(api, load.ownerId, settings, scope.current.controller.signal)
            return 'This browser is enrolled. Push-service acceptance does not confirm display or reading.'
          })}>{enabled ? 'Enabled in this browser' : 'Enable in this browser'}</WorkshopButton>
        <WorkshopButton disabled={busy || (!enabled && !local?.enabled)} onClick={() => void run(() => disableBrowserPush(api, load.ownerId))}>Disable in this browser</WorkshopButton>
        <WorkshopButton disabled={busy} onClick={refresh}>Refresh devices</WorkshopButton>
      </div>
      <h3 className="mt-5 text-sm font-medium text-kumo-default">Enrolled devices ({settings.devices.length}/5)</h3>
      {settings.devices.length >= 5 && <p className="mt-2 text-sm text-kumo-subtle">Five-device limit reached. Revoke a device before enrolling another.</p>}
      {settings.devices.length === 0 && <p className="mt-2 text-sm text-kumo-subtle">No devices enrolled.</p>}
      <ul className="mt-2 divide-y divide-kumo-line">
        {settings.devices.slice(0, 5).map((device, index) => <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div className="min-w-0 text-kumo-default">
            <p className="font-medium">{device.id === thisDevice?.id ? 'This browser' : `Device ${index + 1}`}</p>
            <p className="text-xs text-kumo-subtle">Enrolled {device.createdAt.toLocaleString()}</p>
            <p className="mt-1 text-xs text-kumo-subtle">{deliveryLabels[device.delivery]}</p>
          </div>
          <WorkshopButton disabled={busy} aria-label={`Revoke ${device.id === thisDevice?.id ? 'this browser' : `device ${index + 1}`}`} onClick={() => void run(async () => {
            if (device.id === thisDevice?.id) return disableBrowserPush(api, load.ownerId)
            try { await api.removePushSubscription(device.id) } catch { return 'Could not revoke this device. Check your connection and retry.' }
            return 'Device revoked. This does not change its browser permission.'
          })}>Revoke</WorkshopButton>
        </li>)}
      </ul>
    </>}
    {operation.api === api && operation.message && <p role="status" className="mt-3 text-sm text-kumo-subtle">{operation.message}</p>}
    {busy && <p role="status" className="mt-3 text-sm text-kumo-subtle">Updating browser push...</p>}
  </section>
}
