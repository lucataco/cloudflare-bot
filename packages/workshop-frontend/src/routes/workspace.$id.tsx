import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import GadgetEditor from '../GadgetEditor'
import { useAuthenticatedApi } from '../AuthContext'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { persistLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'

type GadgetSearch = {
  chat?: number
  w?: number
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

export const Route = createFileRoute('/workspace/$id')({
  component: WorkspacePage,
  validateSearch: (search: Record<string, unknown>): GadgetSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
  }),
})

function WorkspacePage() {
  const { id } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled: agentShell, loading } = useUiFeatureFlag('agentShell')
  const [passthrough, setPassthrough] = useState(!agentShell && !loading)

  useEffect(() => {
    if (loading) return
    if (!agentShell) {
      setPassthrough(true)
      return
    }
    let cancelled = false
    Promise.all([
      authenticatedApi.getAgentByWorkspaceId(id),
      authenticatedApi.getGroupByWorkspaceId(id),
    ]).then(([agent, group]) => {
      if (cancelled) return
      if (agent) {
        persistLastThread({ kind: 'agent', id: agent.id })
        navigate({
          to: '/agents/$id',
          params: { id: agent.id },
          search,
          replace: true,
        })
        return
      }
      if (group) {
        persistLastThread({ kind: 'group', id: group.id })
        navigate({
          to: '/groups/$id',
          params: { id: group.id },
          search,
          replace: true,
        })
        return
      }
      setPassthrough(true)
    }).catch((err: unknown) => {
      logRpcFailure('Failed to resolve workspace thread:', err)
      if (!cancelled) setPassthrough(true)
    })
    return () => { cancelled = true }
  }, [agentShell, authenticatedApi, id, loading, navigate, search])

  if (!passthrough) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <GadgetEditor />
}
