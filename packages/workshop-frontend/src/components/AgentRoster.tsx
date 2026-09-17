import { useAttention } from '../AttentionContext'
import { useState, useEffect, type ReactNode } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile, AiChatAuthorInfo, Group } from '@gadgets/workshop-shared/api'
import { Plus, User, Gear, Users } from '@phosphor-icons/react'
import CreateAgentModal from './CreateAgentModal'
import EditAgentModal from './EditAgentModal'
import CreateGroupModal from './CreateGroupModal'
import EditGroupModal from './EditGroupModal'
import { persistLastThread } from '../lastThread'
import { AGENTS_CHANGED_EVENT, notifyAgentsChanged } from '../agentsChanged'
import { botInboxText, botInboxTime, useBotInboxSummaries, type BotInboxSummary } from '../botInboxSummary'

function InboxRowDetail({ name, role, summary, fallback, action }: {
  name: string
  role: string
  summary?: BotInboxSummary
  fallback: string
  action: ReactNode
}) {
  const text = summary ? botInboxText(summary) : fallback
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <p title={role} className="min-w-0 flex-1 truncate text-sm font-medium text-kumo-default">{name}</p>
        {summary && (
          <time
            dateTime={new Date(summary.timestamp).toISOString()}
            title={`${summary.kind === 'result' ? 'Result created' : summary.kind === 'reply' ? 'Reply sent' : 'Workspace activity'}: ${new Date(summary.timestamp).toLocaleString()}${summary.live ? '' : ' (snapshot, not live)'}`}
            className="shrink-0 text-[10px] text-kumo-subtle"
          >
            {botInboxTime(summary.timestamp)}
          </time>
        )}
        {action}
      </div>
      <p title={text} className="line-clamp-2 text-xs leading-5 text-kumo-subtle [overflow-wrap:anywhere]">{text}</p>
    </div>
  )
}

export default function AgentRoster({
  onAgentCreated,
  createAgentModalOpen,
  onCreateAgentCancel,
  selectedAgentId: selectedAgentIdProp,
  variant = 'page',
  collapsed = false,
}: {
  onAgentCreated?: (agentId: string, workspaceId: string) => void
  createAgentModalOpen?: boolean
  onCreateAgentCancel?: () => void
  selectedAgentId?: string
  variant?: 'page' | 'rail'
  collapsed?: boolean
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const attention = useAttention()
  const [showHidden, setShowHidden] = useState(false)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [roster, setRoster] = useState<{
    api: typeof authenticatedApi
    agents: AgentProfile[]
    groups: Group[]
    models: AiChatAuthorInfo[]
    error: boolean
  } | null>(null)
  const [reload, setReload] = useState(0)
  const loading = roster?.api !== authenticatedApi
  const agents = !loading && roster ? roster.agents : []
  const groups = !loading && roster ? roster.groups : []
  const models = !loading && roster ? roster.models : []
  const inbox = useBotInboxSummaries(authenticatedApi)
  const summaryFallback = inbox.status === 'loading' ? 'Loading activity...'
    : inbox.status === 'error' ? 'Activity unavailable' : 'Open to see replies'
  const [createAgentModalVisible, setCreateAgentModalVisible] = useState(false)
  const [createGroupModalVisible, setCreateGroupModalVisible] = useState(false)
  const [editAgentModalVisible, setEditAgentModalVisible] = useState(false)
  const [editGroupModalVisible, setEditGroupModalVisible] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentProfile | null>(null)
  const [editingGroup, setEditingGroup] = useState<Group | null>(null)

  const routeAgentId = /^\/agents\/([^/]+)/.exec(pathname)?.[1]
  const routeGroupId = /^\/groups\/([^/]+)/.exec(pathname)?.[1]
  const selectedAgentId = selectedAgentIdProp ?? routeAgentId
  const selectedGroupId = routeGroupId
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId)
  const replyTimestamp = selectedAgent?.roster?.lastReply?.timestamp
  useEffect(() => {
    if (!selectedAgentId || routeAgentId !== selectedAgentId || replyTimestamp === undefined) return
    let acknowledged = false
    let pending = false
    const markVisibleReplyRead = () => {
      if (document.hidden || acknowledged || pending) return
      pending = true
      void authenticatedApi.markAgentRead(selectedAgentId, replyTimestamp)
        .then(() => { acknowledged = true })
        .catch(() => {})
        .finally(() => { pending = false })
    }
    markVisibleReplyRead()
    document.addEventListener('visibilitychange', markVisibleReplyRead)
    window.addEventListener('focus', markVisibleReplyRead)
    return () => {
      document.removeEventListener('visibilitychange', markVisibleReplyRead)
      window.removeEventListener('focus', markVisibleReplyRead)
    }
  }, [authenticatedApi, selectedAgentId, routeAgentId, replyTimestamp])
  const rail = variant === 'rail'

  const reloadRoster = () => setReload(value => value + 1)

  useEffect(() => {
    let cancelled = false
    // Keep late responses and the previous account's roster out of a new auth scope.
    void Promise.allSettled([
      authenticatedApi.listAgents(), authenticatedApi.listGroups(), authenticatedApi.listModels(),
    ]).then(([agentList, groupList, modelList]) => {
      if (cancelled) return
      setRoster({
        api: authenticatedApi,
        agents: agentList.status === 'fulfilled' ? agentList.value : [],
        groups: groupList.status === 'fulfilled' ? groupList.value : [],
        models: modelList.status === 'fulfilled' ? modelList.value : [],
        error: agentList.status === 'rejected' || groupList.status === 'rejected',
      })
    })
    return () => { cancelled = true }
  }, [authenticatedApi, reload, attention.revision])

  useEffect(() => {
    const onAgentsChanged = () => setReload(value => value + 1)
    window.addEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged)
    return () => window.removeEventListener(AGENTS_CHANGED_EVENT, onAgentsChanged)
  }, [])

  useEffect(() => {
    setShowHidden(false)
    setCreateAgentModalVisible(false)
    setCreateGroupModalVisible(false)
    setEditAgentModalVisible(false)
    setEditGroupModalVisible(false)
    setEditingAgent(null)
    setEditingGroup(null)
  }, [authenticatedApi])

  const handleCreateAgentClick = () => {
    setCreateAgentModalVisible(true)
  }

  const handleCreateGroupClick = () => {
    setCreateGroupModalVisible(true)
  }

  const handleAgentCreated = (agentId: string, workspaceId: string) => {
    setCreateAgentModalVisible(false)
    notifyAgentsChanged()
    persistLastThread({ kind: 'agent', id: agentId })
    onAgentCreated?.(agentId, workspaceId)
    if (!onAgentCreated) {
      navigate({ to: '/agents/$id', params: { id: agentId } })
    }
  }

  const handleGroupCreated = (groupId: string, workspaceId: string) => {
    setCreateGroupModalVisible(false)
    reloadRoster()
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
    setRoster(previous => previous?.api === authenticatedApi ? {
      ...previous,
      agents: previous.agents.map(agent => agent.id === updatedAgent.id ? updatedAgent : agent),
    } : previous)
  }

  const handleAgentDeleted = () => {
    setEditAgentModalVisible(false)
    setEditingAgent(null)
    reloadRoster()
  }

  const handleGroupUpdated = () => {
    setEditGroupModalVisible(false)
    setEditingGroup(null)
    reloadRoster()
  }

  const handleGroupDeleted = () => {
    setEditGroupModalVisible(false)
    setEditingGroup(null)
    reloadRoster()
  }

  if (loading) {
    return (
      <div role="status" aria-label="Loading bots" className="flex h-full items-center justify-center">
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
          <h2 className="text-sm font-semibold text-kumo-default">Bots</h2>
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
        {roster?.error && (
          <button onClick={reloadRoster} title="Retry loading bots and groups" className="px-3 py-4 text-xs text-kumo-subtle">
            {collapsed ? 'Retry' : 'Could not load all bots and groups. Retry'}
          </button>
        )}
        {agents.length === 0 && groups.length === 0 ? (
          roster?.error ? null :
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
                <p className="text-sm font-medium text-kumo-default">No bots yet</p>
                <p className="mt-1 text-xs text-kumo-subtle">
                  Create your first bot to get started
                </p>
              </div>
              <button
                onClick={handleCreateAgentClick}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-kumo-brand-hover transition-colors"
              >
                <Plus size={12} weight="bold" />
                Create bot
              </button>
            </div>
          )
        ) : (
          <div className={`flex flex-col gap-0.5 ${collapsed ? 'p-1' : 'p-2'}`}>
            {agents.some(agent => agent.hidden) && !collapsed && <button aria-expanded={showHidden} className="min-h-10 px-3 py-2 text-left text-xs text-kumo-subtle" onClick={() => setShowHidden(!showHidden)}>{showHidden ? 'Hide hidden bots' : 'Show hidden bots'}</button>}
            {agents.filter(agent => showHidden || !agent.hidden).map((agent) => (
              <Link
                key={agent.id}
                to="/agents/$id"
                params={{ id: agent.id }}
                onClick={() => persistLastThread({ kind: 'agent', id: agent.id })}
                title={collapsed ? `${agent.name} · ${agent.roster?.presence ?? 'idle'}: ${agent.roster?.lastReply?.text ?? (inbox.summaries.has(agent.workspaceId) ? botInboxText(inbox.summaries.get(agent.workspaceId)!) : summaryFallback)}` : undefined}
                className={rowClass(selectedAgentId === agent.id)}
              >
                <div role="img" aria-label={`${agent.name}: ${agent.roster?.presence ?? 'idle'}`} data-presence={agent.roster?.presence ?? 'idle'} title={agent.roster?.presence ?? 'idle'} className={`bot-avatar relative flex shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white ${collapsed ? 'h-8 w-8' : 'h-10 w-10'}`}>
                  {agent.avatar?.url ? (
                    <img
                      src={agent.avatar.url}
                      alt=""
                      className="h-full w-full rounded-full object-cover"
                    />
                  ) : (
                    <span className={collapsed ? 'text-[11px] font-semibold' : 'text-sm font-semibold'}>
                      {agent.name[0]?.toUpperCase()}
                    </span>
                  )}
                </div>

                {!!agent.roster?.unreadCount && <span aria-label={`${agent.roster.unreadCount} unread updates`} className="absolute left-1 top-0 rounded-full bg-kumo-brand px-1.5 text-[10px] font-semibold text-white">{agent.roster.unreadCount > 99 ? '99+' : agent.roster.unreadCount}</span>}
                {!collapsed && (
                  <InboxRowDetail name={`${agent.name}${agent.hidden ? ' (hidden)' : ''}`} role={agent.title} summary={agent.roster?.lastReply ? { kind: 'reply', ...agent.roster.lastReply, live: true } : inbox.summaries.get(agent.workspaceId)} fallback={summaryFallback}
                    action={
                      <><span className="text-[10px] capitalize text-kumo-subtle">{agent.roster?.presence ?? 'idle'}</span><button
                        onClick={(e) => handleEditAgentClick(agent, e)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-kumo-subtle transition-opacity hover:bg-kumo-tint hover:text-kumo-default focus-visible:opacity-100 md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                        aria-label="Edit bot"
                        title="Edit bot"
                      >
                        <Gear size={14} />
                      </button></>
                    }
                  />
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
                    title={collapsed ? `${group.name}: ${inbox.summaries.has(group.workspaceId) ? botInboxText(inbox.summaries.get(group.workspaceId)!) : summaryFallback}` : undefined}
                    className={rowClass(selectedGroupId === group.id)}
                  >
                    <div className={`flex shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white ${collapsed ? 'h-8 w-8' : 'h-10 w-10'}`}>
                      <Users size={collapsed ? 14 : 20} weight="bold" />
                    </div>

                    {!collapsed && (
                      <InboxRowDetail name={group.name} role={`${group.memberAgentIds.length} members`} summary={inbox.summaries.get(group.workspaceId)} fallback={summaryFallback}
                        action={
                          <button
                            onClick={(e) => handleEditGroupClick(group, e)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-kumo-subtle transition-opacity hover:bg-kumo-tint hover:text-kumo-default focus-visible:opacity-100 md:h-6 md:w-6 md:opacity-0 md:group-hover:opacity-100"
                            aria-label="Edit group"
                            title="Edit group"
                          >
                            <Gear size={14} />
                          </button>
                        }
                      />
                    )}
                  </Link>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <CreateAgentModal
        visible={createAgentModalOpen ?? createAgentModalVisible}
        onCancel={() => {
          setCreateAgentModalVisible(false)
          onCreateAgentCancel?.()
        }}
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
