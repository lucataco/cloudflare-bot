import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AgentProfile, Group } from '@gadgets/workshop-shared/api'
import FirstBotSetup from '../components/FirstBotSetup'
import AgentRoster from '../components/AgentRoster'
import { useDocumentTitle } from '../useDocumentTitle'
import { useAuthenticatedApi } from '../AuthContext'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { persistLastThread, readLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'
import { WorkshopButton } from '../components/WorkshopControls'

export const Route = createFileRoute('/agents')({
  component: AgentsPage,
  validateSearch: (search: Record<string, unknown>): { create?: 'bot' } => ({
    create: search.create === 'bot' ? 'bot' : undefined,
  }),
})

function AgentsPage() {
  useDocumentTitle('Bots')
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled: agentShellEnabled, loading: flagsLoading } = useUiFeatureFlag('agentShell')
  const createBot = Route.useSearch().create === 'bot'
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState({
    api: authenticatedApi, createBot, agentShellEnabled, flagsLoading,
    status: 'loading' as 'loading' | 'empty' | 'hidden' | 'error',
  })
  // Invalidate before rendering, including when creation intent or flag loading interrupts a read.
  if (load.api !== authenticatedApi || load.createBot !== createBot
    || load.agentShellEnabled !== agentShellEnabled || load.flagsLoading !== flagsLoading) {
    setLoad({ api: authenticatedApi, createBot, agentShellEnabled, flagsLoading, status: 'loading' })
  }

  useEffect(() => {
    if (flagsLoading) return
    if (!agentShellEnabled) {
      navigate({ to: '/', search: {}, replace: true })
      return
    }
    if (createBot) return

    let cancelled = false
    setLoad(current => ({ ...current, status: 'loading' }))
    Promise.all([authenticatedApi.listAgents(), authenticatedApi.listGroups()])
      .then(([agents, groups]: [AgentProfile[], Group[]]) => {
        if (cancelled) return
        if (agents.length === 0 && groups.length === 0) {
          setLoad(current => ({ ...current, status: 'empty' }))
          return
        }
        agents = agents.filter(agent => !agent.hidden)
        if (agents.length === 0 && groups.length === 0) {
          setLoad(current => ({ ...current, status: 'hidden' }))
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
        if (cancelled) return
        logRpcFailure('Failed to load agents:', err)
        setLoad(current => ({ ...current, status: 'error' }))
      })
    return () => { cancelled = true }
  }, [authenticatedApi, agentShellEnabled, flagsLoading, createBot, navigate, attempt])

  if (!flagsLoading && agentShellEnabled && createBot) {
    return (
      <AgentRoster
        createAgentModalOpen
        onCreateAgentCancel={() => navigate({ to: '/agents', search: {}, replace: true })}
        onAgentCreated={(agentId) => navigate({
          to: '/agents/$id', params: { id: agentId }, search: {}, replace: true,
        })}
      />
    )
  }

  if (!flagsLoading && agentShellEnabled && load.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <p role="alert" className="text-sm text-kumo-subtle">Could not load bots and groups.</p>
        <WorkshopButton onClick={() => setAttempt(value => value + 1)}>Retry</WorkshopButton>
        <Link to="/" search={{}} className="text-sm text-kumo-link">Back to home</Link>
      </div>
    )
  }

  if (!flagsLoading && agentShellEnabled && load.status === 'empty') {
    return (
      <FirstBotSetup
        onCreated={(agentId) => {
          persistLastThread({ kind: 'agent', id: agentId })
          navigate({ to: '/agents/$id', params: { id: agentId } })
        }}
      />
    )
  }

  if (!flagsLoading && agentShellEnabled && load.status === 'hidden') {
    return <AgentRoster />
  }

  return (
    <div role="status" aria-label="Loading bots" className="flex h-full items-center justify-center">
      <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
