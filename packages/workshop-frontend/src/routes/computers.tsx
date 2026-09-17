import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { AgentProfile } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/computers')({ component: ComputersPage })

function ComputersPage() {
  useDocumentTitle('Computers')
  const { authenticatedApi } = useAuthenticatedApi()
  const [load, setLoad] = useState<{ api: typeof authenticatedApi; agents?: AgentProfile[]; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let canceled = false
    setLoad({ api: authenticatedApi })
    authenticatedApi.listAgents().then(agents => {
      if (!canceled) setLoad({ api: authenticatedApi, agents })
    }).catch(() => { if (!canceled) setLoad({ api: authenticatedApi, error: 'Could not load computers.' }) })
    return () => { canceled = true }
  }, [authenticatedApi, attempt])
  const current = load?.api === authenticatedApi ? load : undefined
  return <div className="mx-auto max-w-2xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">Computers</h1>
    <p className="text-sm text-kumo-subtle">Choose a bot to view its computer or take control. Browser access is configured separately for each bot.</p>
    {!current?.agents && !current?.error && <p role="status">Loading computers…</p>}
    {current?.error && <p role="alert">{current.error} <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {current?.agents?.length === 0 && <Link to="/agents">Create a bot to get started</Link>}
    {current?.agents?.map(agent => <Link key={agent.id} to="/agents/$id" params={{ id: agent.id }} search={{ pane: 'computer' }} className="block rounded-xl border border-kumo-line p-4 hover:bg-kumo-tint">
      <strong>{agent.name}</strong><p className="text-sm text-kumo-subtle">{agent.title}</p>
    </Link>)}
  </div>
}
