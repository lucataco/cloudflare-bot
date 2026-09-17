// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ComputerControlMode, ComputerSession, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import { ComputerView } from './ComputerView'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
const view = makeTestRoot()
const owner: GadgetMetadata = { id: 'workspace', title: 'Workspace', role: 'build' }
const createUrl = vi.fn<(blob: Blob) => string>()
const revokeUrl = vi.fn<(url: string) => void>()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

beforeEach(() => {
  let next = 0
  createUrl.mockImplementation(() => `blob:test-${++next}`)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))
})
afterEach(() => { view.cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })

function session() {
  const methods = {
    screenshot: vi.fn<ComputerSession['screenshot']>(async () => new Uint8Array([1, 2])),
    getState: vi.fn<ComputerSession['getState']>(async () => ({ agentId: 'bot', currentUrl: 'about:blank', lastActivityAt: new Date() })),
    navigate: vi.fn<ComputerSession['navigate']>(async () => {}),
    click: vi.fn<ComputerSession['click']>(async () => {}),
    type: vi.fn<ComputerSession['type']>(async () => {}),
    scroll: vi.fn<ComputerSession['scroll']>(async () => {}),
    key: vi.fn<ComputerSession['key']>(async () => {}),
    close: vi.fn<ComputerSession['close']>(async () => {}),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return { methods, stub: methods as unknown as RpcStub<ComputerSession> }
}

function server(initialMode: ComputerControlMode = 'disabled', metadata = owner) {
  let mode = initialMode
  let notify!: (next: GadgetMetadata) => void
  const subscriptionDispose = vi.fn<() => void>()
  const browser = session()
  const api = {
    subscribeToMetadata: vi.fn<(callback: typeof notify) => Promise<Disposable>>(async callback => {
      notify = callback
      callback(metadata)
      return { [Symbol.dispose]: subscriptionDispose }
    }),
    getComputerControl: vi.fn<Overseer['getComputerControl']>(async () => mode),
    setComputerControl: vi.fn<Overseer['setComputerControl']>(async (_agentId, next) => { mode = next }),
    getComputerSession: vi.fn<Overseer['getComputerSession']>(async () => browser.stub),
    approveComputerHumanTakeover: vi.fn<Overseer['approveComputerHumanTakeover']>(async () => {}),
  }
  const props = { agentId: 'bot', overseer: api as unknown as RpcStub<Overseer>, onClose: vi.fn<() => void>() }
  return {
    api, props, browser: browser.methods, subscriptionDispose,
    render: (extra: Partial<ComponentProps<typeof ComputerView>> = {}) => view.render(<ComputerView {...props} {...extra} />),
    emit: async (next: GadgetMetadata) => { await act(async () => notify(next)) },
    setMode: (next: ComputerControlMode) => { mode = next },
  }
}
function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) { await act(async () => button(label).click()) }
const takeover = (requestId: string): NonNullable<ComponentProps<typeof ComputerView>['pendingTakeoverRequest']> => ({
  type: 'computerHumanTakeover', requestId, state: 'pending', reason: 'Complete a step', currentUrl: 'about:blank',
  chatId: 3, sequence: 4, timestamp: new Date(), author: { type: 'agent', id: 'bot', name: 'Bot' },
})

describe('browser grants and real Kumo consent', () => {
  it('does not launch by default, cancels without RPC, and starts human control only explicitly', async () => {
    const s = server()
    await s.render()
    expect(s.api.getComputerControl).toHaveBeenCalledWith('bot')
    expect(s.api.getComputerSession).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Browser access is disabled')
    await click('Allow bot control...')
    const dialog = document.querySelector('[role="dialog"]')!
    for (const token of ['responsive-dialog', '!top-[clamp(28px,10vh,96px)]', '!-translate-y-0', '!max-h-[min(80vh,calc(var(--app-height)-32px))]', 'overflow-y-auto']) {
      expect(dialog.classList.contains(token)).toBe(true)
    }
    expect(dialog.textContent).toContain('full browser reads and writes')
    expect(dialog.textContent).toContain('signed-in websites')
    expect(dialog.textContent).toContain('without per-action or per-origin approvals')
    expect(dialog.textContent).toContain('Closing this view does not revoke it')
    await click('Cancel')
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
    expect(s.api.getComputerSession).not.toHaveBeenCalled()
    await click('Start browser for me')
    expect(s.api.setComputerControl).toHaveBeenCalledExactlyOnceWith('bot', 'human')
    expect(s.api.getComputerSession).toHaveBeenCalledExactlyOnceWith('bot')
    expect(s.api.setComputerControl.mock.invocationCallOrder[0]).toBeLessThan(s.api.getComputerSession.mock.invocationCallOrder[0])
    expect(s.browser.screenshot).toHaveBeenCalledOnce()
  })

  it.each(['build', 'use'] as const)('denies browser RPCs to a %s collaborator', async role => {
    const s = server('agent', { ...owner, role, owner: { id: 'other', name: 'Owner', type: 'user' } })
    await s.render()
    expect(document.body.textContent).toContain('Only the workspace owner')
    expect(s.api.getComputerControl).not.toHaveBeenCalled()
    expect(s.api.getComputerSession).not.toHaveBeenCalled()
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
  })

  it('fails closed for a use role even with owner omitted, and drops access on live owner changes', async () => {
    const s = server('human', { ...owner, role: 'use' })
    await s.render()
    expect(s.api.getComputerControl).not.toHaveBeenCalled()
    await s.emit(owner)
    expect(s.api.getComputerSession).toHaveBeenCalledOnce()
    await s.emit({ ...owner, owner: { id: 'other', name: 'Owner', type: 'user' } })
    expect(s.browser[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:test-1')
    expect(document.querySelector('canvas')).toBeNull()
  })

  it('keeps enabled bot mode owner-readable but blocks all canvas and navigation writes until takeover', async () => {
    const s = server('agent')
    await s.render()
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
    expect(s.browser.screenshot).toHaveBeenCalledOnce()
    const canvas = document.querySelector('canvas')!
    expect(canvas.tabIndex).toBe(-1)
    expect(button('Go').disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Browser URL"]')!.disabled).toBe(true)
    await act(async () => {
      canvas.click()
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true }))
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    for (const method of [s.browser.click, s.browser.scroll, s.browser.type, s.browser.key, s.browser.navigate]) expect(method).not.toHaveBeenCalled()
    await click('Refresh screenshot')
    expect(s.browser.screenshot).toHaveBeenCalledTimes(2)
    await click('Take control')
    expect(s.api.setComputerControl).toHaveBeenCalledExactlyOnceWith('bot', 'human')
    expect(document.querySelector('canvas')!.tabIndex).toBe(0)
    await click('Go')
    expect(s.browser.navigate).toHaveBeenCalledWith('about:blank')
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 360))
    await act(async () => document.querySelector('canvas')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 30 })))
    expect(s.browser.click).toHaveBeenCalledWith(40, 60)
    await act(async () => document.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' })))
    expect(s.browser.type).toHaveBeenCalledWith('x')
    await act(async () => document.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
    expect(s.browser.key).toHaveBeenCalledWith('Enter')
    await act(async () => document.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 })))
    expect(s.browser.scroll).toHaveBeenCalledWith(0, 10)
  })

  it('closes only the view, while immediate disable revokes without clearing website sessions', async () => {
    const s = server('human')
    await s.render({ embedded: true })
    await click('Close view')
    expect(s.props.onClose).toHaveBeenCalledOnce()
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
    expect(s.browser.close).not.toHaveBeenCalled()
    const pending = deferred<void>()
    s.api.setComputerControl.mockImplementationOnce(() => pending.promise)
    await click('Disable browser access')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(s.api.setComputerControl).toHaveBeenCalledWith('bot', 'disabled')
    expect(document.querySelector('canvas')).toBeNull()
    expect(s.browser[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:test-1')
    s.setMode('disabled')
    await act(async () => pending.resolve())
    expect(document.body.textContent).toContain('does not erase cookies or sign you out')
    expect(s.browser.close).not.toHaveBeenCalled()
  })

  it('requires consent before granting bot access and only then approves the exact pending request', async () => {
    const s = server('human')
    const pending = deferred<void>()
    s.api.setComputerControl.mockImplementationOnce(() => pending.promise)
    await s.render({ pendingTakeoverRequest: takeover('request-7') })
    await click('Allow bot control and continue...')
    await click('Cancel')
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    await click('Allow bot control and continue...')
    await act(async () => { const confirm = button('Allow bot control'); confirm.click(); confirm.click() })
    expect(s.api.setComputerControl).toHaveBeenCalledExactlyOnceWith('bot', 'agent')
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    s.setMode('agent')
    await act(async () => pending.resolve())
    expect(s.api.approveComputerHumanTakeover).toHaveBeenCalledExactlyOnceWith('request-7')
  })

  it('invalidates consent on pending request changes and never approves a replacement during a grant', async () => {
    const s = server('human')
    await s.render({ pendingTakeoverRequest: takeover('old') })
    await click('Allow bot control and continue...')
    await s.render({ pendingTakeoverRequest: takeover('new') })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
    const pending = deferred<void>()
    s.api.setComputerControl.mockImplementationOnce(() => pending.promise)
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    await s.render({ pendingTakeoverRequest: takeover('newer') })
    s.setMode('agent')
    await act(async () => pending.resolve())
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not retried')
  })

  it.each([false, true])('requires fresh continuation consent after pause/resume during a grant (batched=%s)', async batched => {
    const s = server('human')
    const pending = deferred<void>()
    s.api.setComputerControl.mockImplementationOnce(() => {
      s.setMode('agent')
      return pending.promise
    })
    await s.render({ pendingTakeoverRequest: takeover('request-7') })
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    if (batched) {
      const notify = s.api.subscribeToMetadata.mock.calls[0][0]
      await act(async () => {
        // Both notifications and the grant response arrive before React can render the pause.
        notify({ ...owner, automationPaused: true })
        notify({ ...owner, automationPaused: false })
        pending.resolve()
      })
    } else {
      await s.emit({ ...owner, automationPaused: true })
      await s.emit({ ...owner, automationPaused: false })
      await act(async () => pending.resolve())
    }
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    expect(s.api.setComputerControl).toHaveBeenCalledExactlyOnceWith('bot', 'agent')
    expect(s.api.getComputerControl).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Bot control allowed')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Confirm again to continue this request')
    await click('Allow bot control and continue...')
    await click('Cancel')
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    expect(s.api.setComputerControl).toHaveBeenCalledOnce()
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    expect(s.api.approveComputerHumanTakeover).toHaveBeenCalledExactlyOnceWith('request-7')
    expect(s.api.setComputerControl.mock.calls).toEqual([['bot', 'agent'], ['bot', 'agent']])
  })

  it('re-reads uncertain grant responses without retry or automatic launch and preserves the error', async () => {
    const s = server()
    s.api.setComputerControl.mockImplementationOnce(async () => {
      s.setMode('agent')
      throw new Error('response lost')
    })
    await s.render()
    await click('Allow bot control...')
    await click('Allow bot control')
    expect(s.api.setComputerControl).toHaveBeenCalledOnce()
    expect(s.api.getComputerControl).toHaveBeenCalledTimes(2)
    expect(s.api.getComputerSession).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Bot control allowed')
    await click('Refresh screenshot')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not retried')
  })

  it('reflects live pause updates, invalidates open consent, and permits owner human use while paused', async () => {
    const s = server('human')
    await s.render()
    await click('Allow bot control...')
    await s.emit({ ...owner, automationPaused: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(button('Allow bot control...').disabled).toBe(true)
    expect(button('Go').disabled).toBe(false)
    await click('Go')
    expect(s.browser.navigate).toHaveBeenCalledOnce()
    await s.emit({ ...owner, automationPaused: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
  })

  it('re-reads human control on a new takeover request without making a grant', async () => {
    const s = server('agent')
    await s.render()
    s.setMode('human')
    await s.render({ pendingTakeoverRequest: takeover('new') })
    expect(s.api.getComputerControl).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('You control the browser')
    expect(button('Go').disabled).toBe(false)
    expect(s.api.setComputerControl).not.toHaveBeenCalled()
  })

  it('does not approve after a rejected grant, and preserves approval failures without replaying either mutation', async () => {
    const s = server('human')
    await s.render({ pendingTakeoverRequest: takeover('pending') })
    expect(s.api.getComputerControl).toHaveBeenCalledOnce()
    s.api.setComputerControl.mockRejectedValueOnce(new Error('Agent browser access is blocked because this workspace has observed sensitive data'))
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('You can still use human control')
    s.api.approveComputerHumanTakeover.mockRejectedValueOnce(new Error('response lost'))
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    expect(s.api.approveComputerHumanTakeover).toHaveBeenCalledExactlyOnceWith('pending')
    expect(s.api.setComputerControl).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Bot control allowed')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not retried')
  })

  it('never logs or displays typed text quoted in a failed browser response', async () => {
    const s = server('human')
    await s.render()
    const errorLog = vi.spyOn(console, 'error')
    const infoLog = vi.spyOn(console, 'log')
    s.browser.type.mockRejectedValueOnce(new Error('private typed text'))
    await act(async () => document.querySelector('canvas')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' })))
    expect(errorLog).not.toHaveBeenCalled()
    expect(infoLog).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('private typed text')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('may have completed')
    expect(s.browser.type).toHaveBeenCalledOnce()
  })
})

describe('browser async scopes and disposal', () => {
  it('ignores old mode results after an agent switch', async () => {
    const s = server()
    const pending = deferred<ComputerControlMode>()
    s.api.getComputerControl.mockImplementationOnce(() => pending.promise)
    await s.render()
    await s.render({ agentId: 'other-bot' })
    await act(async () => pending.resolve('agent'))
    expect(s.api.getComputerSession).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Browser access is disabled')
  })

  it.each(['unmount', 'agent switch', 'disable'] as const)('disposes a late session on %s without reading it', async how => {
    const s = server('human')
    const pending = deferred<RpcStub<ComputerSession>>()
    s.api.getComputerSession.mockImplementationOnce(() => pending.promise)
    await s.render()
    if (how === 'unmount') view.unmount()
    if (how === 'agent switch') { s.setMode('disabled'); await s.render({ agentId: 'other-bot' }) }
    if (how === 'disable') await click('Disable browser access')
    await act(async () => pending.resolve(s.browser as unknown as RpcStub<ComputerSession>))
    expect(s.browser[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(s.browser.screenshot).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('revokes every replaced URL and ignores late screenshots after disable', async () => {
    const s = server('human')
    await s.render()
    await click('Refresh screenshot')
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:test-1')
    const pending = deferred<Uint8Array>()
    s.browser.screenshot.mockImplementationOnce(() => pending.promise)
    await click('Refresh screenshot')
    await click('Disable browser access')
    expect(revokeUrl).toHaveBeenCalledWith('blob:test-2')
    await act(async () => pending.resolve(new Uint8Array([3])))
    expect(createUrl).toHaveBeenCalledTimes(2)
    expect(document.querySelector('canvas')).toBeNull()
    view.unmount()
    expect(s.subscriptionDispose).toHaveBeenCalledOnce()
    expect(s.browser[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('revokes the currently displayed URL on unmount and does not create one for a late screenshot', async () => {
    const s = server('human')
    await s.render()
    const pending = deferred<Uint8Array>()
    s.browser.screenshot.mockImplementationOnce(() => pending.promise)
    await click('Refresh screenshot')
    view.unmount()
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:test-1')
    await act(async () => pending.resolve(new Uint8Array([3])))
    expect(createUrl).toHaveBeenCalledOnce()
    expect(s.browser[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('disposes late metadata subscriptions and rejects stale metadata after reconnect', async () => {
    const old = server('human')
    const pending = deferred<{ [Symbol.dispose]: () => void }>()
    let notify!: (metadata: GadgetMetadata) => void
    old.api.subscribeToMetadata.mockImplementationOnce(callback => { notify = callback; return pending.promise })
    await old.render()
    const next = server()
    await next.render()
    await act(async () => { notify(owner); pending.resolve({ [Symbol.dispose]: old.subscriptionDispose }) })
    expect(old.subscriptionDispose).toHaveBeenCalledOnce()
    expect(old.api.getComputerControl).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Browser access is disabled')
  })

  it('does not approve or read old mode when a grant completes after switching agents', async () => {
    const s = server('human')
    const pending = deferred<void>()
    s.api.setComputerControl.mockImplementationOnce(() => pending.promise)
    await s.render({ pendingTakeoverRequest: takeover('old') })
    await click('Allow bot control and continue...')
    await click('Allow bot control')
    s.setMode('disabled')
    await s.render({ agentId: 'other-bot' })
    const reads = s.api.getComputerControl.mock.calls.length
    await act(async () => pending.resolve())
    expect(s.api.approveComputerHumanTakeover).not.toHaveBeenCalled()
    expect(s.api.getComputerControl).toHaveBeenCalledTimes(reads)
    expect(document.body.textContent).toContain('Browser access is disabled')
  })
})
