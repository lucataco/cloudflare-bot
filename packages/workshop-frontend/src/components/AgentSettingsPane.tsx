import { useEffect, useState } from 'react'
import { Button, Input, Textarea, Select, Checkbox, useKumoToastManager } from '@cloudflare/kumo'
import type { AgentProfile, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, type AccountEvent } from '../accountsSubscriber'
import { logRpcFailure } from '../rpcErrors'

export default function AgentSettingsPane({
  agent,
  authenticatedApi,
  onUpdated,
}: {
  agent: AgentProfile
  authenticatedApi: RpcStub<AuthenticatedApi>
  onUpdated?: (agent: AgentProfile) => void
}) {
  const toasts = useKumoToastManager()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState(agent.name)
  const [title, setTitle] = useState(agent.title)
  const [description, setDescription] = useState(agent.description)
  const [defaultModelId, setDefaultModelId] = useState<string | null>(agent.defaultModelId)
  const [notifyOnUpdates, setNotifyOnUpdates] = useState(agent.notifyOnUpdates ?? true)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [connectedAccounts, setConnectedAccounts] = useState<AccountEvent[]>([])
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>(agent.defaultBindings ?? [])

  useEffect(() => {
    setName(agent.name)
    setTitle(agent.title)
    setDescription(agent.description)
    setDefaultModelId(agent.defaultModelId)
    setNotifyOnUpdates(agent.notifyOnUpdates ?? true)
    setSelectedAccountIds(agent.defaultBindings ?? [])
  }, [agent])

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
    { value: '', label: 'Human only (no AI)' },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ]

  const handleSave = async () => {
    if (!name.trim() || !title.trim()) return
    setLoading(true)
    try {
      const updated = await authenticatedApi.updateAgent(agent.id, {
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        defaultModelId,
        defaultBindings: selectedAccountIds,
        notifyOnUpdates,
      })
      onUpdated?.(updated)
      toasts.add({ title: 'Bot updated', variant: 'success' })
    } catch (err) {
      logRpcFailure('Failed to update agent:', err)
      toasts.add({
        title: 'Failed to update bot',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={loading} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={loading} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-kumo-default">Description</span>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} disabled={loading} />
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
          className="w-full text-sm"
          value={defaultModelId ?? ''}
          onValueChange={(value) => setDefaultModelId(value || null)}
          disabled={loading}
          renderValue={(id) => modelOptions.find((opt) => opt.value === id)?.label || 'Select a model'}
        >
          {modelOptions.map((option) => (
            <Select.Option key={option.value || 'human'} value={option.value}>
              {option.label}
            </Select.Option>
          ))}
        </Select>
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
    </div>
  )
}
