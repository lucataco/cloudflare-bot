import { useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile, AiChatAuthorInfo, Group } from '@gadgets/workshop-shared/api'
import { Plus, User, Gear, Users } from '@phosphor-icons/react'
import CreateAgentModal from './CreateAgentModal'
import EditAgentModal from './EditAgentModal'
import CreateGroupModal from './CreateGroupModal'
import EditGroupModal from './EditGroupModal'
import { useUiFeatureFlag } from '../featureFlags'

export default function AgentRoster({
  onAgentCreated,
  selectedAgentId,
}: {
  onAgentCreated?: (agentId: string, workspaceId: string) => void
  selectedAgentId?: string
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [createAgentModalVisible, setCreateAgentModalVisible] = useState(false)
  const [createGroupModalVisible, setCreateGroupModalVisible] = useState(false)
  const [editAgentModalVisible, setEditAgentModalVisible] = useState(false)
  const [editGroupModalVisible, setEditGroupModalVisible] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentProfile | null>(null)
  const [editingGroup, setEditingGroup] = useState<Group | null>(null)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const agentShellEnabled = useUiFeatureFlag('agentShell')

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

  const loadGroups = () => {
    if (!agentShellEnabled) return
    authenticatedApi
      .listGroups()
      .then((groupList: Group[]) => {
        setGroups(groupList)
      })
      .catch((err: unknown) => {
        console.error('Failed to load groups:', err)
      })
  }

  useEffect(() => {
    loadAgents()
    loadGroups()
    
    authenticatedApi.listModels()
      .then((modelList: AiChatAuthorInfo[]) => {
        setModels(modelList)
      })
      .catch((err: unknown) => {
        console.error('Failed to load models:', err)
      })
  }, [authenticatedApi, agentShellEnabled])

  const handleCreateAgentClick = () => {
    setCreateAgentModalVisible(true)
  }

  const handleCreateGroupClick = () => {
    setCreateGroupModalVisible(true)
  }

  const handleAgentCreated = (agentId: string, workspaceId: string) => {
    setCreateAgentModalVisible(false)
    loadAgents()
    onAgentCreated?.(agentId, workspaceId)
  }

  const handleGroupCreated = (groupId: string, workspaceId: string) => {
    setCreateGroupModalVisible(false)
    loadGroups()
    onAgentCreated?.(groupId, workspaceId)
  }

  const handleEditAgentClick = (agent: AgentProfile, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingAgent(agent)
    setEditAgentModalVisible(true)
  }

  const handleEditGroupClick = (group: Group, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditingGroup(group)
    setEditGroupModalVisible(true)
  }

  const handleAgentUpdated = () => {
    setEditAgentModalVisible(false)
    setEditingAgent(null)
    loadAgents()
  }

  const handleGroupUpdated = () => {
    setEditGroupModalVisible(false)
    setEditingGroup(null)
    loadGroups()
  }

  const handleGroupDeleted = () => {
    setEditGroupModalVisible(false)
    setEditingGroup(null)
    loadGroups()
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
      <div className="flex items-center justify-between border-b border-kumo-border px-4 py-3">
        <h2 className="text-sm font-semibold text-kumo-default">Agents</h2>
        <div className="flex gap-1">
          {agentShellEnabled && groups.length > 0 && (
            <button
              onClick={handleCreateGroupClick}
              className="rounded-lg p-1.5 text-kumo-subtle hover:bg-kumo-well hover:text-kumo-default transition-colors"
              title="Create new group"
            >
              <Users size={16} weight="bold" />
            </button>
          )}
          <button
            onClick={handleCreateAgentClick}
            className="rounded-lg p-1.5 text-kumo-subtle hover:bg-kumo-well hover:text-kumo-default transition-colors"
            title="Create new agent"
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 && groups.length === 0 ? (
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
              onClick={handleCreateAgentClick}
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

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="truncate text-sm font-medium text-kumo-default">{agent.name}</p>
                  </div>
                  <p className="truncate text-xs text-kumo-subtle">{agent.title}</p>
                </div>

                <button
                  onClick={(e) => handleEditAgentClick(agent, e)}
                  className="ml-auto rounded-lg p-1.5 text-kumo-subtle opacity-0 group-hover:opacity-100 hover:bg-kumo-border/50 hover:text-kumo-default transition-all"
                  title="Edit agent"
                >
                  <Gear size={16} weight="bold" />
                </button>
              </Link>
            ))}

            {agentShellEnabled && groups.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 mt-2">
                  <div className="h-px flex-1 bg-kumo-border" />
                  <span className="text-xs font-medium text-kumo-subtle">Groups</span>
                  <div className="h-px flex-1 bg-kumo-border" />
                </div>
                {groups.map((group) => (
                  <Link
                    key={group.id}
                    to="/workspace/$id"
                    params={{ id: group.workspaceId }}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-kumo-well transition-colors relative"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white">
                      <Users size={20} weight="bold" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-kumo-default">{group.name}</p>
                      <p className="truncate text-xs text-kumo-subtle">{group.memberAgentIds.length} members</p>
                    </div>

                    <button
                      onClick={(e) => handleEditGroupClick(group, e)}
                      className="ml-auto rounded-lg p-1.5 text-kumo-subtle opacity-0 group-hover:opacity-100 hover:bg-kumo-border/50 hover:text-kumo-default transition-all"
                      title="Edit group"
                    >
                      <Gear size={16} weight="bold" />
                    </button>
                  </Link>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <CreateAgentModal
        visible={createAgentModalVisible}
        onCancel={() => setCreateAgentModalVisible(false)}
        onSuccess={handleAgentCreated}
        authenticatedApi={authenticatedApi}
        models={models}
      />

      {agentShellEnabled && (
        <CreateGroupModal
          visible={createGroupModalVisible}
          onCancel={() => setCreateGroupModalVisible(false)}
          onSuccess={handleGroupCreated}
          authenticatedApi={authenticatedApi}
          agents={agents}
        />
      )}

      {editingAgent && (
        <EditAgentModal
          visible={editAgentModalVisible}
          onCancel={() => {
            setEditAgentModalVisible(false)
            setEditingAgent(null)
          }}
          onSuccess={handleAgentUpdated}
          authenticatedApi={authenticatedApi}
          agent={editingAgent}
          models={models}
        />
      )}

      {agentShellEnabled && editingGroup && (
        <EditGroupModal
          visible={editGroupModalVisible}
          onCancel={() => {
            setEditGroupModalVisible(false)
            setEditingGroup(null)
          }}
          onSuccess={handleGroupUpdated}
          onDelete={handleGroupDeleted}
          authenticatedApi={authenticatedApi}
          group={editingGroup}
          agents={agents}
        />
      )}
    </div>
  )
}
