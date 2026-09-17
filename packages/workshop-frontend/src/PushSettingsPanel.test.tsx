// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PushSettings } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import PushSettingsPanel from './PushSettingsPanel'
import { disableBrowserPush, enableBrowserPush, pushSupportProblem } from './browserPush'

const auth = vi.hoisted(() => ({ api: null as RpcStub<AuthenticatedApi> | null }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: auth.api }) }))
vi.mock('./browserPush', () => ({
  pushSupportProblem: vi.fn<() => string | undefined>(() => undefined),
  pushErrorMessage: () => 'Could not update browser push.',
  enableBrowserPush: vi.fn<typeof enableBrowserPush>(async () => 'new-device'),
  disableBrowserPush: vi.fn<typeof disableBrowserPush>(async () => 'Notifications are off in this browser.'),
}))
vi.mock('./pushLocalState', () => ({ localPushState: async () => ({ enabled: true, ownerId: 'owner', deviceId: 'local-device', generation: 'one' }) }))

function server(devices: PushSettings['devices'] = []) {
  const methods = {
    getPushSettings: vi.fn<AuthenticatedApi['getPushSettings']>(async () => ({ available: true, applicationServerKey: 'public-key', devices })),
    whoami: async () => ({ type: 'user', id: 'owner', name: 'Owner' }),
    removePushSubscription: vi.fn<AuthenticatedApi['removePushSubscription']>(async (_id: string) => {}),
  }
  return { api: methods as unknown as RpcStub<AuthenticatedApi>, methods }
}
const device = (id: string): PushSettings['devices'][number] => ({ id, createdAt: new Date('2026-09-01T12:00:00Z'), delivery: 'accepted' })
const view = makeTestRoot()
async function click(text: string) {
  await act(async () => {
    const button = [...document.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent) === text)
    expect(button).toBeDefined()
    button!.click()
  })
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => view.cleanup())

describe('push settings panel', () => {
  it('has explicit enrollment, a separate bot preference explanation, and truthful device receipts', async () => {
    const s = server([device('other-device')])
    auth.api = s.api
    await view.render(<PushSettingsPanel />)
    expect(enableBrowserPush).not.toHaveBeenCalled()
    expect(disableBrowserPush).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('separate filter')
    expect(document.body.textContent).toContain('not confirmed delivered')
    await click('Enable in this browser')
    expect(enableBrowserPush).toHaveBeenCalledWith(s.api, 'owner', expect.objectContaining({ applicationServerKey: 'public-key' }), expect.any(AbortSignal))
    await click('Revoke device 1')
    expect(s.methods.removePushSubscription).toHaveBeenCalledExactlyOnceWith('other-device')
  })

  it('disables locally when revoking this browser and offers no more than five device buttons', async () => {
    const s = server([device('local-device'), ...[1, 2, 3, 4].map(id => device(String(id)))])
    auth.api = s.api
    await view.render(<PushSettingsPanel />)
    expect(document.querySelectorAll('button[aria-label^="Revoke"]')).toHaveLength(5)
    expect(document.body.textContent).toContain('Five-device limit')
    await click('Revoke this browser')
    expect(disableBrowserPush).toHaveBeenCalledExactlyOnceWith(s.api, 'owner')
    expect(s.methods.removePushSubscription).not.toHaveBeenCalled()
  })

  it('shows static revoke errors without exposing RPC messages', async () => {
    const s = server([device('other-device')])
    s.methods.removePushSubscription.mockRejectedValue(new Error('secret endpoint'))
    auth.api = s.api
    await view.render(<PushSettingsPanel />)
    await click('Revoke device 1')
    expect(document.body.textContent).toContain('Could not revoke this device.')
    expect(document.body.textContent).not.toContain('secret endpoint')
  })

  it('discards settings from a replaced auth scope', async () => {
    const first = server()
    let resolve!: (settings: PushSettings) => void
    first.methods.getPushSettings.mockReturnValue(new Promise(yes => { resolve = yes }))
    auth.api = first.api
    await view.render(<PushSettingsPanel />)
    const second = server()
    second.methods.getPushSettings.mockResolvedValue({ available: false, devices: [] })
    auth.api = second.api
    await view.render(<PushSettingsPanel />)
    await act(async () => { resolve({ available: true, applicationServerKey: 'old-owner-key', devices: [device('old-owner-device')] }) })
    expect(document.body.textContent).toContain('not configured')
    expect(document.body.textContent).not.toContain('Device 1')
    expect(enableBrowserPush).not.toHaveBeenCalled()
  })

  it('keeps unsupported/denied instructions visible instead of toasting or prompting', async () => {
    auth.api = server().api
    vi.mocked(pushSupportProblem).mockReturnValueOnce('Notifications are blocked. Allow them in browser settings.')
    await view.render(<PushSettingsPanel />)
    // Loading causes a second render, so use a persistent problem for the settled state.
    vi.mocked(pushSupportProblem).mockReturnValue('Notifications are blocked. Allow them in browser settings.')
    await view.render(<PushSettingsPanel />)
    expect(document.body.textContent).toContain('browser settings')
    expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Enable in this browser')?.disabled).toBe(true)
    expect(enableBrowserPush).not.toHaveBeenCalled()
    vi.mocked(pushSupportProblem).mockReturnValue(undefined)
  })
})
