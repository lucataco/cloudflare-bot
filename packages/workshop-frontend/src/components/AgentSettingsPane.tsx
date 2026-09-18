import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Input, Textarea, Select, Checkbox, useKumoToastManager } from '@cloudflare/kumo'
import type { AgentProfile, AiChatAuthorInfo, Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'
import { logRpcFailure } from '../rpcErrors'
import DelegationSettings from './DelegationSettings'
import BotProfileActions from './BotProfileActions'
import { notifyAgentsChanged } from '../agentsChanged'

export default function AgentSettingsPane({
  agent,
  authenticatedApi,
  onUpdated,
  overseer,
  workspaceId,
  isOwner = false,
}: {
  agent: AgentProfile
  authenticatedApi: RpcStub<AuthenticatedApi>
  onUpdated?: (agent: AgentProfile) => void
  overseer?: RpcStub<Overseer>
  workspaceId?: string
  isOwner?: boolean
}) {
  const toasts = useKumoToastManager()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState(agent.name)
  const [title, setTitle] = useState(agent.title)
  const [description, setDescription] = useState(agent.description)
  const [startersText, setStartersText] = useState((agent.starters ?? []).join('\n'))
  const [defaultModelId, setDefaultModelId] = useState<string | null>(agent.defaultModelId)
  const [notifyOnUpdates, setNotifyOnUpdates] = useState(agent.notifyOnUpdates ?? true)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [connectedAccounts, setConnectedAccounts] = useState<AccountEvent[]>([])
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>(agent.defaultBindings ?? [])
  const saveScope = useRef<object | null>(null)

  // A fresh metadata object is not a form reset. Reset only on identity changes or successful saves.
  useLayoutEffect(() => {
    saveScope.current = {}
    setLoading(false)
    setName(agent.name)
    setTitle(agent.title)
    setDescription(agent.description)
    setStartersText((agent.starters ?? []).join('\n'))
    setDefaultModelId(agent.defaultModelId)
    setNotifyOnUpdates(agent.notifyOnUpdates ?? true)
    setSelectedAccountIds(agent.defaultBindings ?? [])
    return () => { saveScope.current = null }
  }, [agent.id, authenticatedApi])

  useLayoutEffect(() => {
    setModels([])
    setConnectedAccounts([])
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listModels()
      .then((list: AiChatAuthorInfo[]) => { if (!cancelled) setModels(list) })
      .catch((err: unknown) => logRpcFailure('Failed to load models:', err))
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    const accounts = new Map<number, AccountEvent>()
    const subscriber = new AccountsSubscriberAdapter({
      add(event: AccountEvent) {
        if (cancelled) return
        accounts.set(event.id, event)
        setConnectedAccounts(Array.from(accounts.values()))
      },
      remove(id: number) {
        if (cancelled) return
        accounts.delete(id)
        setConnectedAccounts(Array.from(accounts.values()))
        setSelectedAccountIds(prev => prev.filter(accountId => accountId !== id))
      },
      ready() {},
    })
    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err: unknown) => {
      if (!cancelled) logRpcFailure('Failed to subscribe to connected accounts:', err)
    })
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const modelOptions = [
    { value: '', label: 'Automatic: use an available model' },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ]

  const handleSave = async () => {
    const scope = saveScope.current
    if (!scope || loading || !name.trim() || !title.trim()) return
    setLoading(true)
    try {
      const starters = startersText.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 20)
      const updated = await authenticatedApi.updateAgent(agent.id, {
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        defaultModelId,
        defaultBindings: selectedAccountIds,
        notifyOnUpdates,
        ...(starters.join('\n') !== (agent.starters ?? []).join('\n') ? { starters } : {}),
      })
      if (saveScope.current !== scope) return
      setName(updated.name)
      setTitle(updated.title)
      setDescription(updated.description)
      setStartersText((updated.starters ?? []).join('\n'))
      setDefaultModelId(updated.defaultModelId)
      setNotifyOnUpdates(updated.notifyOnUpdates ?? true)
      setSelectedAccountIds(updated.defaultBindings ?? [])
      notifyAgentsChanged()
      onUpdated?.(updated)
      toasts.add({ title: 'Bot updated', variant: 'success' })
    } catch (err) {
      if (saveScope.current !== scope) return
      logRpcFailure('Failed to update agent:', err)
      toasts.add({
        title: 'Failed to update bot',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      if (saveScope.current === scope) setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <BotProfileActions agent={agent} api={authenticatedApi} disabled={loading}
        onBusyChange={setLoading} onUpdated={updated => onUpdated?.(updated)} />
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={loading} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Job</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={loading} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Description</span>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} disabled={loading} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Suggested prompts</span>
        <Textarea
          aria-label="Suggested prompts"
          value={startersText}
          onChange={(e) => setStartersText(e.target.value)}
          rows={3}
          disabled={loading}
          placeholder="One starting prompt per line"
        />
        <span className="text-xs leading-5 text-kumo-subtle">
          Shown as suggestions in an empty thread. Selecting one only fills the composer draft; nothing runs or connects.
        </span>
      </label>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={notifyOnUpdates}
          onCheckedChange={(checked) => setNotifyOnUpdates(checked === true)}
          disabled={loading}
        />
        <span className="text-sm text-kumo-default">Notify me about this bot</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Default model</span>
        <Select
          placeholder="Automatic: use an available model"
          className="w-full text-sm"
          value={defaultModelId ?? ''}
          onValueChange={(value) => setDefaultModelId(value || null)}
          disabled={loading}
          renderValue={(id) => modelOptions.find((opt) => opt.value === id)?.label || 'Select a model'}
        >
          {modelOptions.map((option) => (
            <Select.Option key={option.value || 'automatic'} value={option.value}>
              {option.label}
            </Select.Option>
          ))}
        </Select>
        <span className="text-xs leading-5 text-kumo-subtle">
          Automatic lets chat choose a recent or available model. To send without AI, choose No AI responses in Chat settings. Routines need a specific default model.
        </span>
      </label>
      {connectedAccounts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-kumo-default">Default connections</span>
          {connectedAccounts.map((account) => (
            <label key={account.id} className="flex items-center gap-2">
              <Checkbox
                checked={selectedAccountIds.includes(account.id)}
                onCheckedChange={(checked) => {
                  setSelectedAccountIds((prev) => checked === true
                    ? [...prev, account.id]
                    : prev.filter((id) => id !== account.id))
                }}
                disabled={loading}
              />
              <span className="text-sm text-kumo-default">
                {account.description.displayName || account.vendor.displayName}
              </span>
            </label>
          ))}
        </div>
      )}
      <Button disabled={loading || !name.trim() || !title.trim()} onClick={() => { void handleSave() }}>
        {loading ? 'Saving…' : 'Save'}
      </Button>
      {isOwner && overseer && workspaceId === agent.workspaceId && <DelegationSettings
        authenticatedApi={authenticatedApi} overseer={overseer} workspaceId={workspaceId}
        sourceAgentId={agent.id} isOwner={isOwner}
      />}
    </div>
  )
}
