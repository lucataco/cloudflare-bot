import { useSyncExternalStore } from 'react'
import type { AgentRoutine, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'

type RoutineApi = Pick<AuthenticatedApi, 'listRoutines' | 'createRoutine' | 'updateRoutine' | 'deleteRoutine'>
type Snapshot = { routines: AgentRoutine[]; verified: boolean; busy: boolean; error: string | null }

/** Compares persisted JSON-like values, including schedule fields this editor does not expose. */
export function routineValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const left = Object.entries(a).filter(([, value]) => value !== undefined)
  const right = Object.entries(b).filter(([, value]) => value !== undefined)
  return left.length === right.length && left.every(([key, value]) =>
    right.some(([otherKey, otherValue]) => key === otherKey && routineValuesEqual(value, otherValue)))
}

/** Ignores bookkeeping changes that cannot alter the task the user reviewed. */
export function sameRoutineTask(a: AgentRoutine, b: AgentRoutine): boolean {
  return a.name === b.name && a.prompt === b.prompt && a.paused === b.paused && routineValuesEqual(a.schedule, b.schedule)
}

// The API capability scopes both data and uncertainty to one authenticated session. Nothing is
// persisted to browser storage; remounting a receipt cannot replace an unknown result with its prop.
const sessions = new WeakMap<RoutineApi, Map<string, ReturnType<typeof createRoutineStore>>>()

function createRoutineStore(api: RoutineApi, agentId: string) {
  let snapshot: Snapshot = { routines: [], verified: false, busy: false, error: null }
  let reading: Promise<AgentRoutine[]> | null = null
  const listeners = new Set<() => void>()
  const publish = (next: Snapshot) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  const refresh = (): Promise<AgentRoutine[]> => {
    if (reading) return reading
    if (snapshot.busy) return Promise.reject(new Error('A routine update is in progress. Try again.'))
    publish({ ...snapshot, verified: false, busy: true, error: null })
    reading = Promise.resolve().then(() => api.listRoutines(agentId)).then((routines) => {
      publish({ routines, verified: true, busy: false, error: null })
      return routines
    }).catch((err: unknown) => {
      publish({ ...snapshot, verified: false, busy: false, error: err instanceof Error ? err.message : 'Could not verify routines. Try again.' })
      throw err
    }).finally(() => { reading = null })
    return reading
  }

  // Serialize writes within this bot, and never let a pre-write list response overwrite a result.
  const write = async <T,>(operation: () => Promise<T>, apply: (result: T) => AgentRoutine[]) => {
    if (snapshot.busy) throw new Error('A routine update is in progress. Try again.')
    const verified = snapshot.verified
    publish({ ...snapshot, verified: false, busy: true, error: null })
    try {
      const result = await operation()
      publish({ routines: apply(result), verified, busy: false, error: null })
      return result
    } catch (err) {
      publish({ ...snapshot, verified: false, busy: false })
      // A rejected update can already have persisted edited fields and paused the routine.
      await refresh().catch(() => {})
      throw err
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    create: (...args: Parameters<AuthenticatedApi['createRoutine']> extends [string, ...infer Rest] ? Rest : never) =>
      write(() => api.createRoutine(agentId, ...args), (saved) => [...snapshot.routines, saved]),
    update: async (expected: AgentRoutine, updates: Parameters<AuthenticatedApi['updateRoutine']>[2]) => {
      const current = (await refresh()).find((entry) => entry.id === expected.id)
      if (!current) throw new Error('This routine no longer exists.')
      if (!sameRoutineTask(current, expected)) throw new Error('This routine changed elsewhere. Review its latest saved values before trying again.')
      return write(() => api.updateRoutine(agentId, expected.id, updates), (saved) => snapshot.routines.map((entry) => entry.id === saved.id ? saved : entry))
    },
    delete: async (expected: AgentRoutine) => {
      const current = (await refresh()).find((entry) => entry.id === expected.id)
      if (!current || !sameRoutineTask(current, expected)) throw new Error('This routine changed elsewhere. Check its latest status before deleting it.')
      return write(() => api.deleteRoutine(agentId, expected.id), () => snapshot.routines.filter((entry) => entry.id !== expected.id))
    },
  }
}

/** One shared list read and authoritative snapshot per bot, isolated by authenticated capability. */
export function useRoutineState(agentId: string) {
  const { authenticatedApi } = useAuthenticatedApi()
  let agents = sessions.get(authenticatedApi)
  if (!agents) { agents = new Map(); sessions.set(authenticatedApi, agents) }
  let store = agents.get(agentId)
  if (!store) { store = createRoutineStore(authenticatedApi, agentId); agents.set(agentId, store) }
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { store, state }
}
