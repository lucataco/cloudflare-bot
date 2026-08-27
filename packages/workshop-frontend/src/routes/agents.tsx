import { createFileRoute, redirect } from '@tanstack/react-router'
import AgentRoster from '../components/AgentRoster'
import { useDocumentTitle } from '../useDocumentTitle'
import { DEFAULT_UI_FEATURE_FLAGS } from '@gadgets/workshop-shared/feature-flags'

/**
 * Agent roster page - shows when agentShell feature flag is enabled.
 * This replaces the workspace-centric home with a Bot/Agent-centric messenger UI.
 */
export const Route = createFileRoute('/agents')({
  component: AgentsPage,
  beforeLoad: () => {
    // For now, always allow access to this route
    // In production, would check the feature flag here
    // But since flags are loaded async, we handle the redirect in the index route
  },
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
