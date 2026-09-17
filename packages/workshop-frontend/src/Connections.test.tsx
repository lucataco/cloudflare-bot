// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, BoundHookInfo, GadgetBindingInfo, GadgetClient, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import Connections from './Connections'

const toasts = vi.hoisted(() => ({ add: vi.fn<(toast: unknown) => void>() }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => toasts,
}))
vi.mock('./GatekeeperModal', () => ({ default: () => null }))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<() => void>() }))

const view = makeTestRoot()
const binding: GadgetBindingInfo = {
  name: 'DOCS', resourceTitle: 'Research docs', target: 10,
}
const hook: BoundHookInfo = {
  id: 1, gadgetId: 1, gatekeeperId: 10, resourceTitle: 'Research docs', enabled: true,
  description: { title: 'Documents changed', description: '' },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function makeGadget(id = 1) {
  return {
    getId: vi.fn<GadgetClient['getId']>().mockResolvedValue(id),
    getTitle: vi.fn<GadgetClient['getTitle']>().mockResolvedValue(`Gadget ${id}`),
    listBindings: vi.fn<GadgetClient['listBindings']>().mockResolvedValue([binding]),
    renameBinding: vi.fn<GadgetClient['renameBinding']>().mockResolvedValue(undefined),
    unbind: vi.fn<GadgetClient['unbind']>().mockResolvedValue(undefined),
    bindWithSuggestedName: vi.fn<GadgetClient['bindWithSuggestedName']>(),
    setBlueprintAnnotation: vi.fn<GadgetClient['setBlueprintAnnotation']>(),
  }
}
function makeOverseer() {
  return {
    listHooks: vi.fn<Overseer['listHooks']>().mockResolvedValue([hook, { ...hook, id: 2, gadgetId: 2, description: { title: 'Other gadget hook', description: '' } }]),
    enableHook: vi.fn<Overseer['enableHook']>().mockResolvedValue(undefined),
    disableHook: vi.fn<Overseer['disableHook']>().mockResolvedValue(undefined),
    deleteHook: vi.fn<Overseer['deleteHook']>().mockResolvedValue(undefined),
  }
}
let gadget: ReturnType<typeof makeGadget>
let overseer: ReturnType<typeof makeOverseer>
let api: Pick<AuthenticatedApi, 'listGatekeeperVendors'>
let onHasGatekeepersChange: ReturnType<typeof vi.fn>
let onConnectionsChange: ReturnType<typeof vi.fn>
let isVisible: boolean
let chatId: number | undefined
function render() {
  return view.render(<Connections {...{
    gadget, overseer, authenticatedApi: api, isVisible, chatId, onHasGatekeepersChange, onConnectionsChange,
  } as unknown as ComponentProps<typeof Connections>} />)
}
function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) {
  await act(async () => button(label).click())
}
async function focus() {
  await act(async () => window.dispatchEvent(new Event('focus')))
}
const text = () => document.body.textContent
function expectNoMutations() {
  for (const method of [gadget.renameBinding, gadget.unbind, gadget.bindWithSuggestedName,
    gadget.setBlueprintAnnotation, overseer.enableHook, overseer.disableHook, overseer.deleteHook]) {
    expect(method).not.toHaveBeenCalled()
  }
}

beforeEach(() => {
  gadget = makeGadget()
  overseer = makeOverseer()
  api = { listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>().mockResolvedValue([]) }
  onHasGatekeepersChange = vi.fn<(hasGatekeepers: boolean) => void>()
  onConnectionsChange = vi.fn<() => void>()
  isVisible = true
  chatId = undefined
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('connection reads', () => {
  it.each([false, true])('initial error has inline read-only retry, not empty (populated=%s)', async populated => {
    gadget.listBindings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(populated ? [binding] : [])
    overseer.listHooks.mockResolvedValue([])
    await render()
    expect(text()).toContain('Could not load connections.')
    expect(text()).not.toContain('No connected resources')
    expect(onHasGatekeepersChange).not.toHaveBeenCalled()
    expect(toasts.add).not.toHaveBeenCalled()
    expect(button('Connect resource').disabled).toBe(true)
    await click('Retry')
    expect(text()).toContain(populated ? 'Research docs' : 'No connected resources')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(gadget.listBindings).toHaveBeenCalledTimes(2)
    expect(overseer.listHooks).toHaveBeenCalledTimes(2)
    expect(onHasGatekeepersChange).toHaveBeenCalledExactlyOnceWith(populated)
    expectNoMutations()
  })

  it('retains rows on refresh error, marks them stale, disables writes, and retries only reads', async () => {
    await render()
    expect(text()).not.toContain('Other gadget hook')
    const pending = deferred<GadgetBindingInfo[]>()
    gadget.listBindings.mockReturnValueOnce(pending.promise)
    await click('Refresh')
    expect(text()).toContain('Research docs')
    expect(text()).toContain('Documents changed')
    expect(button('Delete connection').disabled).toBe(true)
    await act(async () => pending.reject(new Error('offline')))
    expect(text()).toContain('Showing previously loaded connections; these may be out of date.')
    expect(text()).toContain('Research docs')
    expect(text()).toContain('Documents changed')
    expect(button('Delete connection').disabled).toBe(true)
    expect(button('Delete hook').disabled).toBe(true)
    expect(onHasGatekeepersChange).toHaveBeenCalledExactlyOnceWith(true)
    await click('Retry')
    expect(button('Delete connection').disabled).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expectNoMutations()
  })

  it('preserves a focused rename draft through focus/visibility refresh and retry', async () => {
    await render()
    await click('Edit name used in code')
    const input = document.querySelector<HTMLInputElement>('[aria-label="Binding name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'MY_DRAFT')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    })
    const pending = deferred<GadgetBindingInfo[]>()
    gadget.listBindings.mockReturnValueOnce(pending.promise)
    await focus()
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('MY_DRAFT')
    expect(button('Save').disabled).toBe(true)
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expectNoMutations()
    await act(async () => pending.reject(new Error('offline')))
    expect(document.activeElement).toBe(input)
    await click('Retry')
    isVisible = false
    await render()
    isVisible = true
    await render()
    expect(document.querySelector('[aria-label="Binding name"]')).toBe(input)
    expect(input.value).toBe('MY_DRAFT')
    expect(button('Save').disabled).toBe(false)
    expectNoMutations()
  })

  it.each(['success', 'failure'] as const)('ignores an older %s after a newer load completes', async result => {
    const pending = deferred<GadgetBindingInfo[]>()
    gadget.listBindings.mockReturnValueOnce(pending.promise)
    await render()
    gadget.listBindings.mockResolvedValue([{ ...binding, resourceTitle: 'Fresh docs' }])
    await focus()
    await act(async () => {
      if (result === 'success') pending.resolve([])
      else pending.reject(new Error('late failure'))
    })
    expect(text()).toContain('Fresh docs')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(onHasGatekeepersChange).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each(['gadget', 'chat'] as const)('clears old rows, drafts and errors for a different %s scope', async change => {
    await render()
    await click('Edit name used in code')
    const old = gadget
    const oldRead = deferred<GadgetBindingInfo[]>()
    old.listBindings.mockReturnValueOnce(oldRead.promise)
    await focus()
    const pending = deferred<GadgetBindingInfo[]>()
    if (change === 'gadget') gadget = makeGadget(2)
    else chatId = 42
    gadget.listBindings.mockReturnValueOnce(pending.promise)
    await render()
    expect(text()).not.toContain('Research docs')
    expect(document.querySelector('[aria-label="Binding name"]')).toBeNull()
    expect(text()).toContain('Loading connections...')
    await act(async () => oldRead.resolve([binding]))
    expect(text()).not.toContain('Research docs')
    await act(async () => pending.reject(new Error('new scope offline')))
    expect(text()).toContain('Could not load connections.')
    expect(text()).not.toContain('Showing previously loaded')
    expect(text()).not.toContain('Research docs')
    gadget.listBindings.mockResolvedValue([{ ...binding, resourceTitle: 'New scoped docs' }])
    await click('Retry')
    expect(text()).toContain('New scoped docs')
    expect(gadget.listBindings).toHaveBeenLastCalledWith(chatId)
    expect(text()).toContain(change === 'gadget' ? 'Other gadget hook' : 'Documents changed')
    expectNoMutations()
  })

  it.each(['overseer', 'api'] as const)('waits for the derived gadget after %s replacement, including focus/visibility events', async change => {
    await render()
    const oldGadget = gadget
    const pending = deferred<GadgetBindingInfo[]>()
    oldGadget.listBindings.mockReturnValueOnce(pending.promise)
    await focus()
    if (change === 'overseer') overseer = makeOverseer()
    else api = { listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>().mockResolvedValue([]) }
    await render()
    expect(text()).not.toContain('Research docs')
    expect(text()).toContain('Waiting for connections to reconnect...')
    await focus()
    isVisible = false
    await render()
    isVisible = true
    await render()
    expect(oldGadget.listBindings).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve([binding]))
    expect(text()).not.toContain('Research docs')
    gadget = makeGadget()
    gadget.listBindings.mockResolvedValue([])
    await render()
    expect(text()).toContain('No connected resources')
    expect(gadget.listBindings).toHaveBeenCalledOnce()
  })

  it('does not replay a successful delete when its following refresh fails', async () => {
    await render()
    await click('Delete connection')
    gadget.listBindings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
    await click('Delete')
    expect(text()).toContain('Showing previously loaded connections')
    expect(gadget.unbind).toHaveBeenCalledExactlyOnceWith('DOCS')
    expect(onConnectionsChange).toHaveBeenCalledOnce()
    expect(onHasGatekeepersChange).toHaveBeenCalledExactlyOnceWith(true)
    await click('Retry')
    expect(text()).toContain('No connected resources')
    expect(gadget.unbind).toHaveBeenCalledOnce()
    expect(onConnectionsChange).toHaveBeenCalledOnce()
  })

  it('does not let an old mutation completion refresh or dismiss a new gadget draft', async () => {
    await render()
    await click('Delete connection')
    const old = gadget
    const pending = deferred<void>()
    old.unbind.mockReturnValueOnce(pending.promise)
    await click('Delete')
    gadget = makeGadget(2)
    await render()
    await click('Edit name used in code')
    await act(async () => pending.resolve())
    expect(document.querySelector('[aria-label="Binding name"]')).not.toBeNull()
    expect(old.listBindings).toHaveBeenCalledOnce()
    expect(gadget.listBindings).toHaveBeenCalledOnce()
    expect(onConnectionsChange).not.toHaveBeenCalled()
  })
})
