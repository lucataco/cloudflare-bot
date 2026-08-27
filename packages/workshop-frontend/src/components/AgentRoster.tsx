import { useState, useEffect } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile } from '@gadgets/workshop-shared/api'
import { Plus, User } from '@phosphor-icons/react'

/**
 * Agent roster sidebar component. Shows the list of agent profiles in a messenger-like UI.
 * Each agent is a named persistent teammate with their own chat history.
 */
export default function AgentRoster() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authenticatedApi
      .listAgents()
      .then((agentList: AgentProfile[]) => {
        setAgents(agentList)
        setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('Failed to load agents:', err)
        setLoading(false)
      })
  }, [authenticatedApi])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kumo-border px-4 py-3">
        <h2 className="text-sm font-semibold text-kumo-default">Agents</h2>
        <button
          onClick={() => {
            // TODO: Open create agent modal
            console.log('Create new agent')
          }}
          className="rounded-lg p-1.5 text-kumo-subtle hover:bg-kumo-well hover:text-kumo-default transition-colors"
          title="Create new agent"
        >
          <Plus size={16} weight="bold" />
        </button>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <div className="rounded-full bg-kumo-well p-3">
              <User size={24} weight="light" className="text-kumo-subtle" />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">No agents yet</p>
              <p className="mt-1 text-xs text-kumo-subtle">
                Create your first AI teammate to get started
              </p>
            </div>
            <button
              onClick={() => {
                // TODO: Open create agent modal
                console.log('Create first agent')
              }}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-kumo-brand-hover transition-colors"
            >
              <Plus size={12} weight="bold" />
              Create agent
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 p-2">
            {agents.map((agent) => (
              <a
                key={agent.id}
                href={`/workspace/${agent.workspaceId}`}
                className="group flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-kumo-well transition-colors"
              >
                {/* Avatar */}
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white">
                  {agent.avatar?.url ? (
                    <img
                      src={agent.avatar.url}
                      alt={agent.name}
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-sm font-semibold">{agent.name[0]?.toUpperCase()}</span>
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="truncate text-sm font-medium text-kumo-default">{agent.name}</p>
                  </div>
                  <p className="truncate text-xs text-kumo-subtle">{agent.title}</p>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
