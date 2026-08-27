import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import AgentRoster from '../components/AgentRoster'
import { useDocumentTitle } from '../useDocumentTitle'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile } from '@gadgets/workshop-shared/api'

/**
 * Agent roster page - shows when agentShell feature flag is enabled.
 * This replaces the workspace-centric home with a Bot/Agent-centric messenger UI.
 */
export const Route = createFileRoute('/agents')({
  component: AgentsPage,
})

function AgentsPage() {
  useDocumentTitle('Agents')
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const [firstLoad, setFirstLoad] = useState(true)

  // On first load with zero agents, show the create form immediately via the roster's empty state
  // When an agent is created or if agents exist, open the first one's workspace
  useEffect(() => {
    if (!firstLoad) return

    authenticatedApi.listAgents()
      .then((agents: AgentProfile[]) => {
        setFirstLoad(false)
        if (agents.length > 0) {
          // Open the first agent's workspace
          navigate({ to: '/workspace/$id', params: { id: agents[0].workspaceId } })
        }
        // If zero agents, stay on this page and the empty state will show the create button
      })
      .catch((err: unknown) => {
        console.error('Failed to load agents:', err)
        setFirstLoad(false)
      })
  }, [authenticatedApi, firstLoad, navigate])

  const handleAgentCreated = (agentId: string, workspaceId: string) => {
    // Navigate to the newly created agent's workspace
    navigate({ to: '/workspace/$id', params: { id: workspaceId } })
  }
  
  if (firstLoad) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-kumo-border">
        <AgentRoster onAgentCreated={handleAgentCreated} />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-kumo-default">Select an agent</h2>
          <p className="mt-2 text-sm text-kumo-subtle">
            Choose an agent from the sidebar to start chatting
          </p>
        </div>
      </div>
    </div>
  )
}
