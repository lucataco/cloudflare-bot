import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { AgentProfile } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import GadgetEditor from '../GadgetEditor'
import { persistLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'
import { useDocumentTitle } from '../useDocumentTitle'
import { WorkshopButton } from '../components/WorkshopControls'

type ThreadSearch = {
  chat?: number
  w?: number
  pane?: string
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

/**
 * Flat `/agents/$id` thread. The filename uses a trailing underscore so this is not nested
 * inside the `/agents` roster/redirect page.
 */
export const Route = createFileRoute('/agents_/$id')({
  component: AgentThreadPage,
  validateSearch: (search: Record<string, unknown>): ThreadSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
    pane: typeof search.pane === 'string' ? search.pane : undefined,
  }),
})

function AgentThreadPage() {
  const { id } = Route.useParams()
  const { authenticatedApi } = useAuthenticatedApi()
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState({
    api: authenticatedApi, id, agent: null as AgentProfile | null,
    status: 'loading' as 'loading' | 'ready' | 'error',
  })
  const sameIdentity = load.api === authenticatedApi && load.id === id
  if (!sameIdentity) {
    setLoad({ api: authenticatedApi, id, agent: null, status: 'loading' })
  }
  const agent = sameIdentity ? load.agent : null

  useDocumentTitle(agent?.name)

  useEffect(() => {
    let request = 0
    persistLastThread({ kind: 'agent', id })
    const refresh = () => {
      const current = ++request
      setLoad(previous => ({ ...previous, status: 'loading' }))
      authenticatedApi.listAgents()
        .then((agents: AgentProfile[]) => {
          if (current !== request) return
          setLoad({ api: authenticatedApi, id, agent: agents.find(item => item.id === id) ?? null, status: 'ready' })
        })
        .catch((err: unknown) => {
          if (current !== request) return
          logRpcFailure('Failed to load agent:', err)
          setLoad(previous => ({ ...previous, status: 'error' }))
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { ++request; window.removeEventListener('focus', refresh) }
  }, [authenticatedApi, id, attempt])

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        {load.status === 'loading' ? (
          <p role="status" className="text-sm text-kumo-subtle">Loading bot...</p>
        ) : load.status === 'error' ? (
          <p role="alert" className="text-sm text-kumo-subtle">Could not load bot.</p>
        ) : <p className="text-sm text-kumo-subtle">Bot not found</p>}
        {load.status === 'error' && <WorkshopButton onClick={() => setAttempt(value => value + 1)}>Retry</WorkshopButton>}
        <Link to="/agents" search={{}} className="text-sm text-kumo-link">Back to bots</Link>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {load.status !== 'ready' && <div className="flex items-center gap-3 px-4 py-2 text-sm text-kumo-subtle">
        <p role={load.status === 'error' ? 'alert' : 'status'}>
          {load.status === 'error' ? 'Could not refresh bot. Showing previously loaded details.' : 'Refreshing bot...'}
        </p>
        <WorkshopButton disabled={load.status === 'loading'} onClick={() => setAttempt(value => value + 1)}>Retry</WorkshopButton>
      </div>}
      <div className="min-h-0 flex-1">
        <GadgetEditor workspaceId={agent.workspaceId} messenger={{ agent }} />
      </div>
    </div>
  )
}
