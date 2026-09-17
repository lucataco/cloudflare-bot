// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { Dialog } from '@cloudflare/kumo'
import type { AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import GatekeeperModal, { type GatekeeperModalProps } from './GatekeeperModal'
import type SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  auth: vi.fn<() => unknown>(), toast: vi.fn<(toast: unknown) => void>(), collect: vi.fn<() => Promise<string>>(),
  dialog: vi.fn<(props: ComponentProps<typeof Dialog.Root>) => void>(),
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: mocks.auth }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Workshop' }))
vi.mock('./useDialogSelectPortalContainer', () => ({ useDialogSelectPortalContainer: () => null }))
vi.mock('@cloudflare/kumo', () => ({
  Dialog: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Root: (props: ComponentProps<typeof Dialog.Root>) => {
      mocks.dialog(props)
      return props.open ? props.children : null
    },
    Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Close: ({ disabled }: ComponentProps<typeof Dialog.Close>) => <button aria-label="Close" disabled={disabled} />,
  }),
  useKumoToastManager: () => ({ add: mocks.toast }),
}))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => <button {...props} />,
  WorkshopIconButton: (props: ComponentProps<'button'>) => <button {...props} />,
}))

let setSelectionReady: ((ready: boolean | null) => void) | undefined
vi.mock('./SandboxedResourceConfigurator', () => ({
  default: ({ onCollectResourceUrlChange, onSelectionReadyChange, initialResourceUrl }: ComponentProps<typeof SandboxedResourceConfigurator>) => {
    useEffect(() => {
      onCollectResourceUrlChange?.(mocks.collect)
      onSelectionReadyChange?.(true)
      setSelectionReady = onSelectionReadyChange
      return () => {
        onCollectResourceUrlChange?.(null)
        onSelectionReadyChange?.(null)
        setSelectionReady = undefined
      }
    }, [onCollectResourceUrlChange, onSelectionReadyChange])
    return <div data-testid="configurator">Suggested input: {initialResourceUrl}</div>
  },
}))

const vendor: VendorDescription = { displayName: 'Example service', description: 'Test service', url: 'https://example.com' }
const resource: SupportedResource = {
  urlPattern: 'https://example.com/:project', title: 'Project', description: 'Choose a project', grantable: true,
}
const otherResource: SupportedResource = {
  urlPattern: 'https://example.com/:project/items/:item', title: 'Item', description: 'Choose an item',
}
const request: NonNullable<GatekeeperModalProps['connectionRequest']> = {
  requestId: 'request-1', vendorId: 'example', vendorName: vendor.displayName,
  resourceTitle: resource.title, resourceUrl: 'https://example.com/suggested',
  resourceUrlPattern: resource.urlPattern, reason: 'Summarize the weekly project updates',
}
const chosenUrl = 'https://example.com/chosen%20project?view=weekly#summary'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('GatekeeperModal resource review', () => {
  let root: Root
  let container: HTMLDivElement
  let subscriber: Parameters<AuthenticatedApi['subscribeConnectedAccounts']>[0]
  let props: GatekeeperModalProps
  let api: Pick<AuthenticatedApi, 'listModels' | 'listGatekeeperVendors' | 'subscribeConnectedAccounts' | 'startResourceConfigurator'>
  const newGatekeeper = vi.fn<Overseer['newGatekeeper']>()
  const getOverseer = vi.fn<GatekeeperModalProps['getOverseer']>()
  const onCreated = vi.fn<GatekeeperModalProps['onCreated']>()
  const subscriptionDispose = vi.fn<() => void>()
  const frameDispose = vi.fn<() => void>()

  function sendAccount(id: number, options: { credentialsValid?: boolean; granted?: string[] } = {}) {
    const description: AccountDescription = {
      uniqueName: `user${id}@example.com`, displayName: `Person ${id}`, avatar: { url: '' },
      grantedResourceUrlPatterns: options.granted ?? [resource.urlPattern],
    }
    subscriber.add(id, description, vendor, [resource, otherResource], options.credentialsValid ?? true, 'example')
  }

  async function render(overrides: Partial<GatekeeperModalProps> = {}) {
    props = { ...props, ...overrides }
    await act(async () => root.render(<GatekeeperModal {...props} />))
  }

  function button(label: string) {
    return Array.from(container.querySelectorAll('button')).find(el =>
      el.textContent?.trim() === label && !el.closest('[hidden]'))
  }

  async function click(label: string) {
    const target = button(label)
    expect(target, `button: ${label}`).toBeDefined()
    expect(target!.disabled).toBe(false)
    await act(async () => target!.click())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    api = {
      listModels: async () => [],
      listGatekeeperVendors: async () => [{ id: 'example', description: vendor, supportedResources: [resource, otherResource] }],
      subscribeConnectedAccounts: next => {
        subscriber = next
        sendAccount(1)
        sendAccount(2)
        const subscription = new RpcStub(new RpcTarget())
        return Object.assign(Promise.resolve(subscription), { [Symbol.dispose]() {
          subscriptionDispose()
          subscription[Symbol.dispose]()
        } })
      },
      startResourceConfigurator: vi.fn<AuthenticatedApi['startResourceConfigurator']>(async () => ({
        iframeHtml: '<p>Configurator</p>',
        ui: new RpcStub(new class extends RpcTarget { [Symbol.dispose]() { frameDispose() } }()),
      })),
    }
    mocks.auth.mockReturnValue({ authenticatedApi: api })
    mocks.collect.mockReset().mockResolvedValue(chosenUrl)
    newGatekeeper.mockReset().mockResolvedValue(null)
    getOverseer.mockReset().mockResolvedValue({ newGatekeeper } as unknown as RpcStub<Overseer>)
    onCreated.mockReset().mockResolvedValue(undefined)
    props = {
      open: true, onClose: vi.fn<() => void>(() => {
        props = { ...props, open: false }
        root.render(<GatekeeperModal {...props} />)
      }), getOverseer, onCreated,
      initialVendorId: request.vendorId, initialResourceUrl: request.resourceUrl,
      initialResourceUrlPattern: request.resourceUrlPattern, connectionRequest: request,
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('collects first and submits exactly the reviewed account and URL only on confirmation', async () => {
    const collection = deferred<string>()
    mocks.collect.mockReturnValueOnce(collection.promise)
    await render()
    await click('user2@example.comConnected Example service account')
    expect(container.textContent).toContain("Bot's stated purpose")
    expect(container.textContent).toContain(request.reason)
    expect(container.textContent).toContain('Suggested resource URL (not yet selected)')
    expect(button('Add connection')).toBeUndefined()
    await click('Review connection')
    expect(getOverseer).not.toHaveBeenCalled()
    expect(newGatekeeper).not.toHaveBeenCalled()

    await act(async () => collection.resolve(chosenUrl))
    const review = container.querySelector('[aria-label="Connection review"]')!
    expect(review.textContent).toContain('user2@example.com')
    expect(review.textContent).toContain('Person 2')
    expect(review.textContent).toContain('Example service')
    expect(review.textContent).toContain('Project')
    expect(review.textContent).toContain(chosenUrl)
    expect(review.textContent).not.toContain(request.resourceUrl)
    expect(review.textContent).toContain('It does not approve OAuth scopes')
    expect(container.querySelector('[data-testid="configurator"]')).toBeNull()
    expect(getOverseer).not.toHaveBeenCalled()

    mocks.collect.mockResolvedValue('https://example.com/not-reviewed')
    await click('Add connection')
    expect(mocks.collect).toHaveBeenCalledOnce()
    expect(newGatekeeper).toHaveBeenCalledExactlyOnceWith(2, chosenUrl)
  })

  it('cancels review without provisioning an overseer or binding', async () => {
    await render()
    await click('Review connection')
    await click('Cancel')
    expect(props.onClose).toHaveBeenCalledOnce()
    expect(getOverseer).not.toHaveBeenCalled()
    expect(newGatekeeper).not.toHaveBeenCalled()
    expect(frameDispose).toHaveBeenCalled()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('invalidates on Edit and requires a fresh review after changing account and type', async () => {
    await render({ initialVendorId: undefined })
    await click('Example serviceProject, Item')
    await click('ProjectChoose a project')
    await click('Review connection')
    await click('Edit selection')
    expect(button('Add connection')).toBeUndefined()
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).toContain(chosenUrl)
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).not.toContain(request.resourceUrl)
    await click('All connection types')
    await click('ItemChoose an item')
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).not.toContain(chosenUrl)
    await click('user2@example.comConnected Example service account')
    const editedUrl = 'https://example.com/new/items/42'
    mocks.collect.mockResolvedValueOnce(editedUrl)
    expect(newGatekeeper).not.toHaveBeenCalled()
    await click('Review connection')
    expect(container.querySelector('[aria-label="Connection review"]')!.textContent).toContain('Item')
    await click('Add connection')
    expect(newGatekeeper).toHaveBeenCalledExactlyOnceWith(2, editedUrl)
    expect(mocks.collect).toHaveBeenCalledTimes(2)
  })

  it('scopes the reviewed edit seed to the selected account and modal opening', async () => {
    await render()
    await click('Review connection')
    await click('Edit selection')
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).toContain(chosenUrl)
    await click('user2@example.comConnected Example service account')
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).toContain(request.resourceUrl)
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).not.toContain(chosenUrl)
    await click('Review connection')
    await click('Edit selection')
    await render({ open: false })
    await render({ open: true })
    expect(container.querySelector('[data-testid="configurator"]')!.textContent).toContain(request.resourceUrl)
  })

  it('blocks Escape, outside dismissal, Close and Cancel while creation is in flight', async () => {
    const pending = deferred<Awaited<ReturnType<Overseer['newGatekeeper']>>>()
    newGatekeeper.mockReturnValueOnce(pending.promise)
    await render()
    await click('Review connection')
    await click('Add connection')
    expect(newGatekeeper).toHaveBeenCalledOnce()
    expect(button('Cancel')!.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled).toBe(true)
    const dialog = mocks.dialog.mock.lastCall![0]
    expect(dialog).toMatchObject({ disablePointerDismissal: true })
    const cancel = vi.fn<() => void>()
    await act(async () => dialog.onOpenChange!(false, {
      reason: 'escape-key', event: new KeyboardEvent('keydown', { key: 'Escape' }), cancel,
      allowPropagation() {}, isCanceled: false, isPropagationAllowed: false, trigger: undefined,
      preventUnmountOnClose() {},
    }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(props.onClose).not.toHaveBeenCalled()
    await act(async () => pending.resolve(null))
    expect(button('Cancel')!.disabled).toBe(false)
  })

  it.each(['close', 'reopen', 'request', 'workspace', 'agent', 'unmount'] as const)(
    'disposes a late created capability without accepting or closing after a %s change', async change => {
      const pending = deferred<Awaited<ReturnType<Overseer['newGatekeeper']>>>()
      const dispose = vi.fn<() => void>()
      const gatekeeper = { [Symbol.dispose]: dispose } as unknown as NonNullable<Awaited<ReturnType<Overseer['newGatekeeper']>>>
      const nextCreated = vi.fn<GatekeeperModalProps['onCreated']>()
      newGatekeeper.mockReturnValueOnce(pending.promise)
      await render()
      await click('Review connection')
      await click('Add connection')
      expect(newGatekeeper).toHaveBeenCalledExactlyOnceWith(1, chosenUrl)

      if (change === 'close' || change === 'reopen') await render({ open: false })
      if (change === 'reopen') await render({ open: true, onCreated: nextCreated })
      if (change === 'request') await render({ connectionRequest: { ...request, requestId: 'request-B' }, onCreated: nextCreated })
      if (change === 'workspace') await render({ workspaceId: 'workspace-B', onCreated: nextCreated })
      if (change === 'agent') await render({ agentId: 'agent-B', onCreated: nextCreated })
      if (change === 'unmount') act(() => root.unmount())

      await act(async () => pending.resolve(gatekeeper))
      expect(onCreated).not.toHaveBeenCalled()
      expect(nextCreated).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledOnce()
    },
  )

  it('does not clear a new request creation when the old RPC finishes', async () => {
    const oldPending = deferred<Awaited<ReturnType<Overseer['newGatekeeper']>>>()
    const nextPending = deferred<Awaited<ReturnType<Overseer['newGatekeeper']>>>()
    const dispose = vi.fn<() => void>()
    const oldGatekeeper = { [Symbol.dispose]: dispose } as unknown as NonNullable<Awaited<ReturnType<Overseer['newGatekeeper']>>>
    const nextCreated = vi.fn<GatekeeperModalProps['onCreated']>().mockResolvedValue(undefined)
    newGatekeeper.mockReturnValueOnce(oldPending.promise).mockReturnValueOnce(nextPending.promise)
    await render()
    await click('Review connection')
    await click('Add connection')
    await render({ connectionRequest: { ...request, requestId: 'request-B' }, onCreated: nextCreated })
    await click('Review connection')
    await click('Add connection')
    await act(async () => oldPending.resolve(oldGatekeeper))
    expect(dispose).toHaveBeenCalledOnce()
    expect(button('Creating...')!.disabled).toBe(true)
    expect(button('Cancel')!.disabled).toBe(true)
    expect(onCreated).not.toHaveBeenCalled()
    expect(nextCreated).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    await act(async () => nextPending.resolve(null))
    expect(button('Add connection')!.disabled).toBe(false)
  })

  it('does not close a new request when the previous creation callback finishes', async () => {
    const callback = deferred<void>()
    const dispose = vi.fn<() => void>()
    const gatekeeper = { [Symbol.dispose]: dispose } as unknown as NonNullable<Awaited<ReturnType<Overseer['newGatekeeper']>>>
    newGatekeeper.mockResolvedValueOnce(gatekeeper)
    onCreated.mockReturnValueOnce(callback.promise)
    await render()
    await click('Review connection')
    await click('Add connection')
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(gatekeeper)
    await render({ connectionRequest: { ...request, requestId: 'request-B' } })
    await act(async () => callback.resolve())
    expect(props.onClose).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(button('Review connection')!.disabled).toBe(false)
  })

  it.each(['removed', 'expired', 'grant revoked'] as const)('invalidates review when the selected account is %s', async change => {
    await render()
    await click('Review connection')
    await act(async () => {
      if (change === 'removed') subscriber.remove(1)
      else sendAccount(1, change === 'expired' ? { credentialsValid: false } : { granted: [] })
    })
    expect(container.querySelector('[aria-label="Connection review"]')).toBeNull()
    expect(button('Add connection')).toBeUndefined()
    expect(newGatekeeper).not.toHaveBeenCalled()
    expect(button('Review connection')!.disabled).toBe(change === 'grant revoked')
    expect(container.querySelector('[data-testid="configurator"]') === null).toBe(change === 'grant revoked')
  })

  it.each(['cancel', 'frame change'] as const)('discards a late configurator result after %s', async change => {
    const collection = deferred<string>()
    mocks.collect.mockReturnValueOnce(collection.promise)
    await render()
    await click('Review connection')
    if (change === 'cancel') await click('Cancel')
    else await act(async () => subscriber.remove(1))
    await act(async () => collection.resolve(chosenUrl))
    expect(container.querySelector('[aria-label="Connection review"]')).toBeNull()
    expect(getOverseer).not.toHaveBeenCalled()
    expect(newGatekeeper).not.toHaveBeenCalled()
  })

  it('rechecks account validity after lazy overseer resolution, before creating the binding', async () => {
    const overseer = deferred<RpcStub<Overseer>>()
    getOverseer.mockReturnValueOnce(overseer.promise)
    await render()
    await click('Review connection')
    await click('Add connection')
    await act(async () => sendAccount(1, { granted: [] }))
    await act(async () => overseer.resolve({ newGatekeeper } as unknown as RpcStub<Overseer>))
    expect(newGatekeeper).not.toHaveBeenCalled()
  })

  it('respects configurator readiness and reports collection errors without creating', async () => {
    await render()
    await act(async () => setSelectionReady?.(false))
    expect(button('Review connection')!.disabled).toBe(true)
    await act(async () => setSelectionReady?.(true))
    mocks.collect.mockRejectedValueOnce(new Error('Choose a project first'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await click('Review connection')
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'Choose a project first', variant: 'error' })
    expect(button('Add connection')).toBeUndefined()
    expect(newGatekeeper).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves created-stub ownership (callback fails: %s)', async fails => {
    const dispose = vi.fn<() => void>()
    const gatekeeper = { [Symbol.dispose]: dispose } as unknown as NonNullable<Awaited<ReturnType<Overseer['newGatekeeper']>>>
    newGatekeeper.mockResolvedValueOnce(gatekeeper)
    if (fails) {
      onCreated.mockRejectedValueOnce(new Error('Binding callback failed'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
    }
    await render()
    await click('Review connection')
    await click('Add connection')
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(gatekeeper)
    expect(dispose).toHaveBeenCalledTimes(fails ? 1 : 0)
    expect(props.onClose).toHaveBeenCalledTimes(fails ? 0 : 1)
  })
})
