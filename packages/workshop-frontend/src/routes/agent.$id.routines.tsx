import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile } from '@gadgets/workshop-shared/api'
import RoutinesList from '../components/RoutinesList'
import { useUiFeatureFlag } from '../FeatureFlagsContext'
import { useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute('/agent/$id/routines')({
  component: AgentRoutinesPage,
})

function AgentRoutinesPage() {
  const { id: agentId } = Route.useParams()
  const { authenticatedApi } = useAuthenticatedApi()
  const [agent, setAgent] = useState<AgentProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const agentShellEnabled = useUiFeatureFlag('agentShell')
  const navigate = useNavigate()

  useEffect(() => {
    if (!agentShellEnabled) {
      navigate({ to: '/' })
      return
    }

    authenticatedApi
      .listAgents()
      .then((agents: AgentProfile[]) => {
        const foundAgent = agents.find((a) => a.id === agentId)
        if (foundAgent) {
          setAgent(foundAgent)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('Failed to load agent:', err)
        setLoading(false)
      })
  }, [agentId, authenticatedApi, agentShellEnabled, navigate])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-kumo-default">Agent not found</h2>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-kumo-border p-4">
        <h1 className="text-xl font-semibold text-kumo-default">
          {agent.name} - Routines
        </h1>
        <p className="text-sm text-kumo-subtle mt-1">{agent.description}</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        <RoutinesList agent={agent} />
      </div>
    </div>
  )
}
