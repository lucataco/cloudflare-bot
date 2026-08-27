import { createFileRoute } from '@tanstack/react-router'
import AgentRoster from '../components/AgentRoster'
import { useDocumentTitle } from '../useDocumentTitle'

/**
 * Agent roster page - shows when agentShell feature flag is enabled.
 * This replaces the workspace-centric home with a Bot/Agent-centric messenger UI.
 */
export const Route = createFileRoute('/agents')({
  component: AgentsPage,
})

function AgentsPage() {
  useDocumentTitle('Agents')
  
  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-kumo-border">
        <AgentRoster />
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
