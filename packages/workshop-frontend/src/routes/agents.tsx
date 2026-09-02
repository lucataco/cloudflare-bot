import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AgentProfile, Group } from '@gadgets/workshop-shared/api'
import FirstBotSetup from '../components/FirstBotSetup'
import { useDocumentTitle } from '../useDocumentTitle'
import { useAuthenticatedApi } from '../AuthContext'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { persistLastThread, readLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'

export const Route = createFileRoute('/agents')({
  component: AgentsPage,
})

function AgentsPage() {
  useDocumentTitle('Bots')
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled: agentShellEnabled, loading: flagsLoading } = useUiFeatureFlag('agentShell')
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    if (flagsLoading) return
    if (!agentShellEnabled) {
      navigate({ to: '/', replace: true })
      return
    }

    let cancelled = false
    Promise.all([authenticatedApi.listAgents(), authenticatedApi.listGroups()])
      .then(([agents, groups]: [AgentProfile[], Group[]]) => {
        if (cancelled) return
        if (agents.length === 0 && groups.length === 0) {
          setEmpty(true)
          return
        }
        const last = readLastThread()
        if (last?.kind === 'agent' && agents.some((agent) => agent.id === last.id)) {
          navigate({ to: '/agents/$id', params: { id: last.id }, replace: true })
          return
        }
        if (last?.kind === 'group' && groups.some((group) => group.id === last.id)) {
          navigate({ to: '/groups/$id', params: { id: last.id }, replace: true })
          return
        }
        const firstAgent = agents[0]
        if (firstAgent) {
          persistLastThread({ kind: 'agent', id: firstAgent.id })
          navigate({ to: '/agents/$id', params: { id: firstAgent.id }, replace: true })
          return
        }
        const firstGroup = groups[0]
        if (firstGroup) {
          persistLastThread({ kind: 'group', id: firstGroup.id })
          navigate({ to: '/groups/$id', params: { id: firstGroup.id }, replace: true })
        }
      })
      .catch((err: unknown) => {
        logRpcFailure('Failed to load agents:', err)
        if (!cancelled) setEmpty(true)
      })
    return () => { cancelled = true }
  }, [authenticatedApi, agentShellEnabled, flagsLoading, navigate])

  if (empty) {
    return (
      <FirstBotSetup
        onCreated={(agentId) => {
          persistLastThread({ kind: 'agent', id: agentId })
          navigate({ to: '/agents/$id', params: { id: agentId } })
        }}
      />
    )
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
