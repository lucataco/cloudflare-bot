// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcStub } from 'capnweb'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AttentionItem, AttentionPage, AttentionSubscriber, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AttentionProvider, createAttentionStore, useAttention } from './AttentionContext'
import AttentionPageView from './AttentionPage'
import AttentionNav from './components/AttentionNav'
import { makeTestRoot } from './action-test-harness'

vi.mock('./PushSettingsPanel', () => ({ default: () => null }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}
const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'workspace:action:1', sourceId: 'action:1', workspaceId: 'workspace', workspaceTitle: 'My workspace',
  kind: 'action', state: 'pending', version: 1, order: 20, seen: false, updatedAt: new Date('2026-09-01T12:00:00Z'), chatId: 7,
  ...overrides,
})
const page = (entries: AttentionItem[] = [item()], overrides: Partial<AttentionPage> = {}): AttentionPage => ({
  entries, unseen: entries.filter(entry => !entry.seen).length, catchingUp: false, truncated: false, ...overrides,
})

function server() {
  const pages: ReturnType<typeof deferred<AttentionPage>>[] = []
  const mark = deferred<void>()
  const subscriptions: {
    pending: ReturnType<typeof deferred<RpcStub<{}>>>
    callback: RpcStub<AttentionSubscriber>
    handle: Pick<RpcStub<{}>, 'onRpcBroken' | typeof Symbol.dispose>
    broken: (error: unknown) => void
  }[] = []
  const dispose = vi.fn<() => void>()
  const methods = {
    subscribeAttention: vi.fn<AuthenticatedApi['subscribeAttention']>((value: RpcStub<AttentionSubscriber>) => {
      const callback = value.dup()
      const pending = deferred<RpcStub<{}>>()
      const entry = {
        pending, callback,
        broken: (_error: unknown) => {},
        handle: {
          onRpcBroken: (handler: (error: unknown) => void) => { entry.broken = handler },
          [Symbol.dispose]: vi.fn<() => void>(() => {
            dispose()
            callback[Symbol.dispose]()
            entry.broken(new Error('Handle disposed'))
          }),
        },
      }
      subscriptions.push(entry)
      void pending.promise.catch(() => callback[Symbol.dispose]())
      return pending.promise
    }),
    listAttention: vi.fn<AuthenticatedApi['listAttention']>((_cursor?: number) => {
      const next = deferred<AttentionPage>()
      pages.push(next)
      return next.promise
    }),
    markAttentionSeen: vi.fn<AuthenticatedApi['markAttentionSeen']>((_id: string, _version: number) => mark.promise),
  }
  return {
    api: methods as unknown as RpcStub<AuthenticatedApi>, methods, pages, mark, subscriptions, dispose,
    get subscription() { return subscriptions[0].pending },
    async subscribe(index = 0) {
      const { pending, handle } = subscriptions[index]
      pending.resolve(handle as RpcStub<{}>)
      await Promise.resolve()
    },
    emit: (revision: number, index = 0) => subscriptions[index].callback.changed(revision),
  }
}

describe('owner attention store', () => {
  it('subscribes once before listing and coalesces in-flight invalidations, ignoring old revisions', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    await s.subscribe()
    expect(s.methods.subscribeAttention.mock.invocationCallOrder[0]).toBeLessThan(s.methods.listAttention.mock.invocationCallOrder[0])
    await s.emit(3)
    await s.emit(4)
    await s.emit(4)
    expect(s.pages).toHaveLength(1)
    s.pages[0].resolve(page())
    await Promise.resolve()
    expect(store.getSnapshot().page).toBeNull()
    expect(s.pages).toHaveLength(2)
    s.pages[1].resolve(page([item({ version: 2 })]))
    await Promise.resolve()
    await s.emit(2)
    expect(s.pages).toHaveLength(2)
    expect(store.getSnapshot().page?.entries[0].version).toBe(2)
    stop()
    expect(s.dispose).toHaveBeenCalledOnce()
  })

  it('discards stale older pages on invalidation and refreshes only the newest page', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    await s.subscribe()
    s.pages[0].resolve(page([item()], { nextBeforeOrder: 20 }))
    await Promise.resolve()
    const older = store.loadMore()
    expect(s.methods.listAttention).toHaveBeenLastCalledWith(20)
    await s.emit(9)
    s.pages[1].resolve(page([item({ id: 'old', order: 1 })]))
    await older
    expect(s.methods.listAttention).toHaveBeenLastCalledWith(undefined)
    s.pages[2].resolve(page([item({ version: 2, order: 25 })]))
    await Promise.resolve()
    expect(store.getSnapshot().page?.entries.map(entry => entry.id)).toEqual([item().id])
    stop()
  })

  it('marks exact id/version only; a newer source response remains unseen and pending', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    await s.subscribe()
    s.pages[0].resolve(page())
    await Promise.resolve()
    const marked = store.markSeen(item())
    expect(s.methods.markAttentionSeen).toHaveBeenCalledExactlyOnceWith(item().id, 1)
    await s.emit(2)
    s.pages[1].resolve(page([item({ version: 2, order: 22 })]))
    await Promise.resolve()
    s.mark.resolve()
    await marked
    expect(store.getSnapshot().page?.entries[0]).toMatchObject({ seen: false, version: 2, state: 'pending' })
    s.pages[2].resolve(page([item({ version: 2, order: 22 })]))
    await Promise.resolve()
    stop()
  })

  it('fences late pages, marks, and subscription handles across teardown/restart', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    const mark = store.markSeen(item())
    stop()
    await s.subscribe()
    s.pages[0].resolve(page())
    s.mark.resolve()
    await mark
    expect(s.dispose).toHaveBeenCalledOnce()
    expect(store.getSnapshot().page).toBeNull()
    expect(s.pages).toHaveLength(1)
  })

  it('keeps subscription failures visible after a page succeeds and retries registration', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    s.subscription.reject(new Error('offline'))
    await Promise.resolve()
    await Promise.resolve()
    s.pages[0].resolve(page())
    await Promise.resolve()
    expect(store.getSnapshot().error).toContain('Live updates unavailable')
    store.refresh()
    expect(s.methods.subscribeAttention).toHaveBeenCalledTimes(2)
    stop()
    await s.subscribe(1)
    expect(s.dispose).toHaveBeenCalledOnce()
  })

  it.each(['handle', 'callback'] as const)('detects established %s failure without losing the owner API and retries with a full snapshot', async signal => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    await s.subscribe()
    await s.emit(100)
    s.pages[0].resolve(page())
    await Promise.resolve()
    s.pages[1].resolve(page([item()], { nextBeforeOrder: 20 }))
    await Promise.resolve()
    const older = store.loadMore()
    s.pages[2].resolve(page([item({ id: 'older', order: 10 })]))
    await older
    expect(store.getSnapshot().page?.entries).toHaveLength(2)

    if (signal === 'handle') s.subscriptions[0].broken(new Error('User DO reset'))
    else s.subscriptions[0].callback[Symbol.dispose]() // Real Cap'n Web target disposal by the native bridge.
    expect(store.getSnapshot().error).toContain('Live updates unavailable')
    expect(s.subscriptions[0].handle[Symbol.dispose]).toHaveBeenCalledOnce()
    store.refresh()
    expect(s.methods.subscribeAttention).toHaveBeenCalledTimes(2)
    expect(s.methods.listAttention).toHaveBeenLastCalledWith(undefined)
    await s.subscribe(1)
    s.pages[3].resolve(page([item({ version: 2 })]))
    await Promise.resolve()
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().page?.entries).toHaveLength(1)
    // A restarted projection may begin with a lower revision; never retain the dead feed's cursor.
    await s.emit(1, 1)
    expect(s.pages).toHaveLength(5)
    s.pages[4].resolve(page())
    await Promise.resolve()
    s.subscriptions[0].broken(new Error('Delayed old failure'))
    expect(store.getSnapshot().error).toBeNull()
    stop()
    expect(s.subscriptions[1].handle[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(store.getSnapshot().error).toBeNull() // Intentional handle/callback disposal is not failure.
    store.refresh()
    expect(s.methods.subscribeAttention).toHaveBeenCalledTimes(2)
  })

  it('fences an old callback still held by an in-flight call and disposes a late handle after callback loss', async () => {
    const s = server()
    const store = createAttentionStore(s.api)
    const stop = store.start()
    await s.subscribe()
    using delayed = s.subscriptions[0].callback.dup()
    s.pages[0].resolve(page())
    await Promise.resolve()
    s.subscriptions[0].broken(new Error('reset'))
    store.refresh()
    await delayed.changed(999)
    expect(s.pages).toHaveLength(2)
    // Lose the new native callback before its handle arrives.
    s.subscriptions[1].callback[Symbol.dispose]()
    await s.subscribe(1)
    expect(s.subscriptions[1].handle[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(store.getSnapshot().error).toContain('Live updates unavailable')
    stop()
  })
})

describe('attention page and auth scope', () => {
  const view = makeTestRoot()
  beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
  afterEach(() => { view.cleanup(); vi.restoreAllMocks() })

  async function renderPage(s: ReturnType<typeof server>) {
    const rootRoute = createRootRoute({ component: () => <AttentionProvider api={s.api}><AttentionNav /><AttentionPageView /></AttentionProvider> })
    const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/attention'] }), routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null }),
    ]) })
    await router.load()
    await view.render(<RouterProvider router={router} />)
  }

  it('shares the provider across badge/page, preserves source/seen labels, and opens canonical chat without marking', async () => {
    const s = server()
    await renderPage(s)
    await act(async () => {
      await s.subscribe()
      s.pages[0].resolve(page([item({ seen: true }), item({ id: 'unseen', order: 10 })], { catchingUp: true, truncated: true }))
    })
    expect(s.methods.subscribeAttention).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Source: PendingSeen')
    expect(document.body.textContent).toContain('Source: PendingUnseen')
    expect(document.body.textContent).toContain('Catching up:')
    expect(document.body.textContent).toContain('Retention limit:')
    expect(document.querySelector('a[aria-label*="1 recent unseen"]')).not.toBeNull()
    const open = [...document.querySelectorAll('a')].find(link => link.textContent?.trim() === 'Open')!
    expect(open.getAttribute('href')).toBe('/workspace/workspace?chat=7')
    expect(s.methods.markAttentionSeen).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('button')].map(button => button.textContent)).not.toContain('Approve')
    await act(async () => {
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click()
      s.pages[1].resolve(page([], { catchingUp: true, truncated: true }))
    })
    expect(document.body.textContent).toContain('No recent items to show.')
    expect(document.body.textContent).toContain('not a complete inventory')
  })

  it('shows unavailable on page and badge after established callback disposal; Retry reinstalls the feed', async () => {
    const s = server()
    await renderPage(s)
    await act(async () => { await s.subscribe(); s.pages[0].resolve(page()) })
    await act(async () => { s.subscriptions[0].callback[Symbol.dispose]() })
    expect(document.querySelector('a[aria-label*="updates unavailable"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Live updates unavailable')
    await act(async () => {
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click()
      await s.subscribe(1)
      s.pages[1].resolve(page([item({ version: 2 })]))
    })
    expect(document.querySelector('a[aria-label*="updates unavailable"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(s.methods.subscribeAttention).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(s.dispose).toHaveBeenCalledTimes(2)
  })

  it('never shows another auth scope\'s late response', async () => {
    const first = server()
    const next = server()
    function Probe() { const state = useAttention(); return <p>{state.page?.entries[0]?.workspaceTitle ?? 'loading'}</p> }
    await view.render(<AttentionProvider api={first.api}><Probe /></AttentionProvider>)
    await view.render(<AttentionProvider api={next.api}><Probe /></AttentionProvider>)
    await act(async () => { await first.subscribe(); first.pages[0].resolve(page()) })
    expect(document.body.textContent).toBe('loading')
    expect(first.dispose).toHaveBeenCalledOnce()
    await act(async () => { await next.subscribe(); next.pages[0].resolve(page([item({ workspaceTitle: 'New owner' })])) })
    expect(document.body.textContent).toBe('New owner')
  })
})
