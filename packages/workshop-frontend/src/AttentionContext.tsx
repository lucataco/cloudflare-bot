import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AttentionItem, AttentionPage, AttentionSubscriber, AuthenticatedApi } from '@gadgets/workshop-shared/api'

type Snapshot = {
  revision: number
  page: AttentionPage | null
  loading: boolean
  paging: boolean
  error: string | null
  marking: ReadonlySet<string>
}

const empty: Snapshot = { revision: -1, page: null, loading: true, paging: false, error: null, marking: new Set() }
const markKey = (item: AttentionItem) => JSON.stringify([item.id, item.version])

/** One store belongs to the authenticated shell, not to individual bots or navigation consumers. */
export function createAttentionStore(api: RpcStub<AuthenticatedApi>) {
  let snapshot = empty
  const listeners = new Set<() => void>()
  let generation = 0
  let revision = -1
  let invalidation = 0
  let active = false
  let inFlight = false
  let refreshPending = false
  let subscription: RpcStub<{}> | undefined
  let subscriptionError = false
  let subscriptionGeneration = 0
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }

  async function list(older = false) {
    if (!active || inFlight) return
    const cursor = older ? snapshot.page?.nextBeforeOrder : undefined
    if (older && cursor === undefined) return
    const session = generation
    const request = invalidation
    inFlight = true
    refreshPending = false
    publish({ loading: !older, paging: older, error: subscriptionError ? 'Live updates unavailable. Retry to reconnect.' : null })
    try {
      const page = await api.listAttention(cursor)
      if (!active || generation !== session || invalidation !== request) return
      // Older pages never replace a newer source version already on screen.
      const entries = new Map(snapshot.page?.entries.map(item => [item.id, item]))
      if (!older) entries.clear()
      for (const item of page.entries) {
        const current = entries.get(item.id)
        if (!current || item.version > current.version) entries.set(item.id, item)
      }
      publish({ page: { ...page, entries: [...entries.values()].toSorted((a, b) => b.order - a.order) } })
    } catch {
      if (active && generation === session && invalidation === request) {
        publish({ error: 'Could not load recent attention. Previously loaded items may be out of date.' })
      }
    } finally {
      if (active && generation === session) {
        inFlight = false
        publish({ loading: false, paging: false })
        if (refreshPending) void list()
      }
    }
  }

  function refresh() {
    if (!active) return
    ++invalidation
    refreshPending = true
    if (!inFlight) void list()
  }

  function subscribe() {
    const session = generation
    const attempt = ++subscriptionGeneration
    revision = -1
    const current = () => active && generation === session && subscriptionGeneration === attempt
    const fail = () => {
      if (!current()) return
      // Fence callbacks before disposal: releasing the handle can synchronously release our target.
      ++subscriptionGeneration
      subscriptionError = true
      const broken = subscription
      subscription = undefined
      broken?.[Symbol.dispose]()
      publish({ error: 'Live updates unavailable. Retry to reconnect.' })
    }
    class Subscriber extends RpcTarget implements AttentionSubscriber {
      changed(nextRevision: number) {
        if (!current() || nextRevision <= revision) return
        revision = nextRevision
        publish({ revision })
        refresh()
      }

      [Symbol.dispose]() {
        // A native bridge may release its callback on DO reset without closing the WebSocket.
        fail()
      }
    }
    // Passing a local stub gives the RPC its own reference; this reference is ours to release.
    using subscriber = new RpcStub(new Subscriber())
    api.subscribeAttention(subscriber).then(result => {
      if (!current()) result[Symbol.dispose]()
      else {
        subscription = result
        result.onRpcBroken(fail)
      }
    }).catch(fail)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start() {
      active = true
      ++generation
      revision = -1
      subscriptionError = false
      inFlight = false
      snapshot = empty
      subscribe() // Register before listing, including on reconnect; revisions are not a replay log.
      refresh()
      return () => {
        active = false
        ++generation
        subscription?.[Symbol.dispose]()
        subscription = undefined
      }
    },
    refresh() {
      if (!active) return
      if (subscriptionError) {
        subscriptionError = false
        subscribe()
      }
      refresh()
    },
    loadMore: () => list(true),
    async markSeen(item: AttentionItem) {
      const key = markKey(item)
      if (!active || snapshot.marking.has(key)) return
      const session = generation
      publish({ marking: new Set([...snapshot.marking, key]) })
      try {
        await api.markAttentionSeen(item.id, item.version)
        // Re-list, never optimistically mutate the source or mark a newer version seen.
        if (active && generation === session) refresh()
      } catch {
        if (active && generation === session) publish({ error: 'Could not mark this version seen. Try again.' })
      } finally {
        if (active && generation === session) {
          const marking = new Set(snapshot.marking)
          marking.delete(key)
          publish({ marking })
        }
      }
    },
  }
}

type Store = ReturnType<typeof createAttentionStore>
const AttentionContext = createContext<Store | null>(null)
const noSubscribe = () => () => {}
const getEmpty = () => empty

export function AttentionProvider({ api, children }: { api: RpcStub<AuthenticatedApi>; children: ReactNode }) {
  const [owned, setOwned] = useState(() => ({ api, store: createAttentionStore(api) }))
  if (owned.api !== api) setOwned({ api, store: createAttentionStore(api) })
  useEffect(() => owned.store.start(), [owned.store])
  return <AttentionContext.Provider value={owned.store}>{children}</AttentionContext.Provider>
}

export function useAttention() {
  const store = useContext(AttentionContext)
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? getEmpty)
  return { ...state, store, isMarking: (item: AttentionItem) => state.marking.has(markKey(item)) }
}
