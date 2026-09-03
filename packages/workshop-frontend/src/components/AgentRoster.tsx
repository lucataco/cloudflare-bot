import { useState, useEffect } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile, AiChatAuthorInfo, Group } from '@gadgets/workshop-shared/api'
import { Plus, User, Gear, Users } from '@phosphor-icons/react'
import CreateAgentModal from './CreateAgentModal'
import EditAgentModal from './EditAgentModal'
import CreateGroupModal from './CreateGroupModal'
import EditGroupModal from './EditGroupModal'
import { persistLastThread } from '../lastThread'
import { AGENTS_CHANGED_EVENT } from '../agentsChanged'

export default function AgentRoster({
  onAgentCreated,
  selectedAgentId: selectedAgentIdProp,
  variant = 'page',
  collapsed = false,
}: {
  onAgentCreated?: (agentId: string, workspaceId: string) => void
  selectedAgentId?: string
  variant?: 'page' | 'rail'
  collapsed?: boolean
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
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

  const routeAgentId = /^\/agents\/([^/]+)/.exec(pathname)?.[1]
  const routeGroupId = /^\/groups\/([^/]+)/.exec(pathname)?.[1]
  const selectedAgentId = selectedAgentIdProp ?? routeAgentId
  const selectedGroupId = routeGroupId
  const rail = variant === 'rail'

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

    const onAgentsChanged = () => {
      loadAgents()
      loadGroups()
    }
    window.addEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged)
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged)
  }, [authenticatedApi])

  const handleCreateAgentClick = () => {
    setCreateAgentModalVisible(true)
  }

  const handleCreateGroupClick = () => {
    setCreateGroupModalVisible(true)
  }

  const handleAgentCreated = (agentId: string, workspaceId: string) => {
    setCreateAgentModalVisible(false)
    loadAgents()
    persistLastThread({ kind: 'agent', id: agentId })
    onAgentCreated?.(agentId, workspaceId)
    if (!onAgentCreated) {
      navigate({ to: '/agents/$id', params: { id: agentId } })
    }
  }

  const handleGroupCreated = (groupId: string, workspaceId: string) => {
    setCreateGroupModalVisible(false)
    loadGroups()
    persistLastThread({ kind: 'group', id: groupId })
    onAgentCreated?.(groupId, workspaceId)
    if (!onAgentCreated) {
      navigate({ to: '/groups/$id', params: { id: groupId } })
    }
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

  const handleAgentUpdated = (updatedAgent: AgentProfile) => {
    setEditAgentModalVisible(false)
    setEditingAgent(null)
    setAgents((prevAgents) =>
      prevAgents.map((a) => (a.id === updatedAgent.id ? updatedAgent : a))
    )
  }

  const handleAgentDeleted = () => {
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

  const rowClass = (selected: boolean) =>
    `group flex items-center rounded-lg transition-colors relative ${
      collapsed ? 'justify-center px-1 py-1.5' : 'gap-3 px-3 py-2.5'
    } ${selected ? 'bg-kumo-brand/10' : 'hover:bg-kumo-well'}`

  return (
    <div className={`flex h-full flex-col ${rail ? 'bg-kumo-elevated' : 'bg-kumo-base'}`}>
      {!collapsed && (
        <div className={`flex items-center justify-between ${rail ? 'px-3 py-2' : 'border-b border-kumo-border px-4 py-3'}`}>
          <h2 className="text-sm font-semibold text-kumo-default">{rail ? 'Bots' : 'Agents'}</h2>
          <div className="flex gap-1">
            <button
              onClick={handleCreateGroupClick}
              className="rounded-lg p-1.5 text-kumo-subtle hover:bg-kumo-well hover:text-kumo-default transition-colors"
              title="Create new group"
            >
              <Users size={16} weight="bold" />
            </button>
            <button
              onClick={handleCreateAgentClick}
              className="rounded-lg p-1.5 text-kumo-subtle hover:bg-kumo-well hover:text-kumo-default transition-colors"
              title="Create new bot"
            >
              <Plus size={16} weight="bold" />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          collapsed ? null : (
            <p className="px-3 py-4 text-xs text-kumo-subtle">Loading…</p>
          )
        ) : agents.length === 0 && groups.length === 0 ? (
          collapsed ? (
            <button
              onClick={handleCreateAgentClick}
              className="mx-auto mt-2 flex h-8 w-8 items-center justify-center rounded-full bg-kumo-brand text-white"
              title="Create bot"
            >
              <Plus size={14} weight="bold" />
            </button>
          ) : rail ? (
            <p className="px-3 py-4 text-xs text-kumo-subtle">No bots yet</p>
          ) : (
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
          )
        ) : (
          <div className={`flex flex-col gap-0.5 ${collapsed ? 'p-1' : 'p-2'}`}>
            {agents.map((agent) => (
              <Link
                key={agent.id}
                to="/agents/$id"
                params={{ id: agent.id }}
                onClick={() => persistLastThread({ kind: 'agent', id: agent.id })}
                title={collapsed ? agent.name : undefined}
                className={rowClass(selectedAgentId === agent.id)}
              >
                <div className={`flex shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white ${collapsed ? 'h-8 w-8' : 'h-10 w-10'}`}>
                  {agent.avatar?.url ? (
                    <img
                      src={agent.avatar.url}
                      alt={agent.name}
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    <span className={collapsed ? 'text-[11px] font-semibold' : 'text-sm font-semibold'}>
                      {agent.name[0]?.toUpperCase()}
                    </span>
                  )}
                </div>

                {!collapsed && (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-kumo-default">{agent.name}</p>
                      <p className="truncate text-xs text-kumo-subtle">{agent.title}</p>
                    </div>
                    <button
                      onClick={(e) => handleEditAgentClick(agent, e)}
                      className="ml-auto rounded-lg p-1.5 text-kumo-subtle opacity-0 group-hover:opacity-100 hover:bg-kumo-border/50 hover:text-kumo-default transition-all"
                      title="Edit agent"
                    >
                      <Gear size={16} weight="bold" />
                    </button>
                  </>
                )}
              </Link>
            ))}

            {groups.length > 0 && (
              <>
                {!collapsed && (
                  <div className="flex items-center gap-2 px-3 py-2 mt-2">
                    <div className="h-px flex-1 bg-kumo-border" />
                    <span className="text-xs font-medium text-kumo-subtle">Groups</span>
                    <div className="h-px flex-1 bg-kumo-border" />
                  </div>
                )}
                {groups.map((group) => (
                  <Link
                    key={group.id}
                    to="/groups/$id"
                    params={{ id: group.id }}
                    onClick={() => persistLastThread({ kind: 'group', id: group.id })}
                    title={collapsed ? group.name : undefined}
                    className={rowClass(selectedGroupId === group.id)}
                  >
                    <div className={`flex shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white ${collapsed ? 'h-8 w-8' : 'h-10 w-10'}`}>
                      <Users size={collapsed ? 14 : 20} weight="bold" />
                    </div>

                    {!collapsed && (
                      <>
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
                      </>
                    )}
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

      <CreateGroupModal
        visible={createGroupModalVisible}
        onCancel={() => setCreateGroupModalVisible(false)}
        onSuccess={handleGroupCreated}
        authenticatedApi={authenticatedApi}
        agents={agents}
      />

      {editingAgent && (
        <EditAgentModal
          visible={editAgentModalVisible}
          onCancel={() => {
            setEditAgentModalVisible(false)
            setEditingAgent(null)
          }}
          onSuccess={handleAgentUpdated}
          onDelete={handleAgentDeleted}
          authenticatedApi={authenticatedApi}
          agent={editingAgent}
          models={models}
        />
      )}

      {editingGroup && (
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
