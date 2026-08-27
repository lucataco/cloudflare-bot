import { useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { Plus, User, Gear } from '@phosphor-icons/react'
import CreateAgentModal from './CreateAgentModal'
import EditAgentModal from './EditAgentModal'

/**
 * Agent roster sidebar component. Shows the list of agent profiles in a messenger-like UI.
 * Each agent is a named persistent teammate with their own chat history.
 */
export default function AgentRoster({
  onAgentCreated,
  selectedAgentId,
}: {
  onAgentCreated?: (agentId: string, workspaceId: string) => void
  selectedAgentId?: string
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [createModalVisible, setCreateModalVisible] = useState(false)
  const [editModalVisible, setEditModalVisible] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentProfile | null>(null)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])

  const loadAgents = () => {
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
  }

  useEffect(() => {
    loadAgents()
    
    // Load models for the create modal
    authenticatedApi.listModels()
      .then((modelList: AiChatAuthorInfo[]) => {
        setModels(modelList)
      })
      .catch((err: unknown) => {
        console.error('Failed to load models:', err)
      })
  }, [authenticatedApi])

  const handleCreateClick = () => {
    setCreateModalVisible(true)
  }

  const handleAgentCreated = (agentId: string, workspaceId: string) => {
    setCreateModalVisible(false)
    loadAgents()
    onAgentCreated?.(agentId, workspaceId)
  }

  const handleEditClick = (agent: AgentProfile, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingAgent(agent)
    setEditModalVisible(true)
  }

  const handleAgentUpdated = () => {
    setEditModalVisible(false)
    setEditingAgent(null)
    loadAgents()
  }

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
          onClick={handleCreateClick}
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
              onClick={handleCreateClick}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-kumo-brand-hover transition-colors"
            >
              <Plus size={12} weight="bold" />
              Create agent
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 p-2">
            {agents.map((agent) => (
              <Link
                key={agent.id}
                to="/workspace/$id"
                params={{ id: agent.workspaceId }}
                className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors relative ${
                  selectedAgentId === agent.id
                    ? 'bg-kumo-brand/10'
                    : 'hover:bg-kumo-well'
                }`}
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

                {/* Edit button */}
                <button
                  onClick={(e) => handleEditClick(agent, e)}
                  className="ml-auto rounded-lg p-1.5 text-kumo-subtle opacity-0 group-hover:opacity-100 hover:bg-kumo-border/50 hover:text-kumo-default transition-all"
                  title="Edit agent"
                >
                  <Gear size={16} weight="bold" />
                </button>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Create Agent Modal */}
      <CreateAgentModal
        visible={createModalVisible}
        onCancel={() => setCreateModalVisible(false)}
        onSuccess={handleAgentCreated}
        authenticatedApi={authenticatedApi}
        models={models}
      />

      {/* Edit Agent Modal */}
      {editingAgent && (
        <EditAgentModal
          visible={editModalVisible}
          onCancel={() => {
            setEditModalVisible(false)
            setEditingAgent(null)
          }}
          onSuccess={handleAgentUpdated}
          authenticatedApi={authenticatedApi}
          agent={editingAgent}
          models={models}
        />
      )}
    </div>
  )
}
