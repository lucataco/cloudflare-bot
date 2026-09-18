import { notifyAgentsChanged } from '../agentsChanged'
import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Textarea, Select, useKumoToastManager, Checkbox } from '@cloudflare/kumo'
import { AgentProfile, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, AccountEvent } from '../accountsSubscriber'
import { logRpcFailure } from '../rpcErrors'
import { openOAuthPopup } from '../openOAuthPopup'
import BotProfileActions from './BotProfileActions'
import AgentAvatarPicker from './AgentAvatarPicker'
import type { AvatarImage } from '@gadgets/workshop-shared/gatekeeper'

interface EditAgentModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: (updatedAgent: AgentProfile) => void
  onDelete: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  agent: AgentProfile
  models: AiChatAuthorInfo[]
}

export default function EditAgentModal({
  visible,
  onCancel,
  onSuccess,
  onDelete,
  authenticatedApi,
  agent,
  models,
}: EditAgentModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<AvatarImage | undefined>(undefined)
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [connectedAccounts, setConnectedAccounts] = useState<AccountEvent[]>([])
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([])
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [notifyOnUpdates, setNotifyOnUpdates] = useState(true)

  useEffect(() => {
    if (visible) {
      setName(agent.name)
      setTitle(agent.title)
      setDescription(agent.description)
      setAvatar(agent.avatar)
      setDefaultModelId(agent.defaultModelId)
      setSelectedAccountIds(agent.defaultBindings ?? [])
      setNotifyOnUpdates(agent.notifyOnUpdates ?? true)
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible, agent])

  // Subscribe to connected accounts
  useEffect(() => {
    let cancelled = false
    const accounts = new Map<number, AccountEvent>()

    const subscriber = new AccountsSubscriberAdapter({
      add(event: AccountEvent) {
        if (!cancelled) {
          accounts.set(event.id, event)
          setConnectedAccounts(Array.from(accounts.values()))
        }
      },
      remove(id: number) {
        if (!cancelled) {
          accounts.delete(id)
          setConnectedAccounts(Array.from(accounts.values()))
          setSelectedAccountIds(prev => prev.filter(accountId => accountId !== id))
        }
      },
      ready() {},
    })

    const subscription = authenticatedApi.subscribeConnectedAccounts(subscriber)
    subscription.catch((err) => {
      if (cancelled) return
      logRpcFailure('Failed to subscribe to connected accounts:', err)
    })

    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
    }
  }, [authenticatedApi])

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!name.trim()) {
      newErrors.name = 'Bot name is required'
    }

    if (!title.trim()) {
      newErrors.title = 'Bot job is required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSave = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const updatedAgent = await authenticatedApi.updateAgent(agent.id, {
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        avatar: avatar ?? null,
        defaultModelId,
        defaultBindings: selectedAccountIds,
        notifyOnUpdates,
      })

      toasts.add({
        title: 'Bot updated',
        description: `${name} has been updated`,
        variant: 'success',
      })

      notifyAgentsChanged()
      onSuccess(updatedAgent)
    } catch (err) {
      console.error('Failed to update agent:', err)
      toasts.add({
        title: 'Failed to update bot',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete ${agent.name}? This will permanently delete the bot and all its chat history.`)) {
      return
    }

    setLoading(true)
    try {
      await authenticatedApi.deleteAgent(agent.id)

      toasts.add({
        title: 'Bot deleted',
        description: `${agent.name} has been deleted`,
        variant: 'success',
      })

      onDelete()
    } catch (err) {
      console.error('Failed to delete agent:', err)
      toasts.add({
        title: 'Failed to delete bot',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  // An unset profile default allows the chat composer to choose an available model.
  const modelOptions = [
    { value: '', label: 'Automatic: use an available model' },
    ...models.map((model) => ({
      value: model.id,
      label: model.name,
    })),
  ]

  return (
    <Dialog.Root open={visible} onOpenChange={(open: boolean) => { if (!open && !loading) onCancel() }}>
      <Dialog className="responsive-dialog !top-[clamp(28px,10vh,96px)] !flex !max-h-[min(80vh,calc(var(--app-height)-32px))] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="sm">
        <div className="flex shrink-0 flex-col border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
            Edit bot
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            Update {agent.name}'s settings
          </Dialog.Description>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-4">
        {visible && <BotProfileActions agent={agent} api={authenticatedApi} disabled={loading}
          onBusyChange={setLoading} onUpdated={onSuccess} onDuplicated={onCancel} />}
        {/* Name */}
        <div>
          <label id="edit-agent-name-label" htmlFor="edit-agent-name" className="block text-sm font-medium text-kumo-default mb-1.5">
            Name *
          </label>
          <Input
            id="edit-agent-name"
            aria-labelledby="edit-agent-name-label"
            className="w-full"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErrors((prev) => ({ ...prev, name: '' }))
            }}
            disabled={loading}
            error={errors.name}
          />
        </div>

        <AgentAvatarPicker avatar={avatar} disabled={loading} onChange={setAvatar} />

        {/* Title */}
        <div>
          <label id="edit-agent-title-label" htmlFor="edit-agent-title" className="block text-sm font-medium text-kumo-default mb-1.5">
            Job *
          </label>
          <Input
            id="edit-agent-title"
            aria-labelledby="edit-agent-title-label"
            className="w-full"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setErrors((prev) => ({ ...prev, title: '' }))
            }}
            disabled={loading}
            error={errors.title}
          />
          <p className="mt-1 text-xs text-kumo-subtle">
            What this bot helps you do, shown beneath its name
          </p>
        </div>

        <div>
          <label htmlFor="edit-agent-description" className="block text-sm font-medium text-kumo-default mb-1.5">
            Description
          </label>
          <Textarea
            id="edit-agent-description"
            className="w-full"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            disabled={loading}
            rows={3}
          />
        </div>

        <div>
          <Checkbox
            label="Notify me about this bot"
            checked={notifyOnUpdates}
            onCheckedChange={(checked) => setNotifyOnUpdates(checked === true)}
            disabled={loading}
          />
        </div>

        <div>
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="edit-agent-advanced"
            disabled={loading}
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover transition-colors"
          >
            {advancedOpen ? '▼' : '▶'} Advanced
          </button>
        </div>
        {advancedOpen && (
          <div id="edit-agent-advanced" className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
            {/* Default Model */}
            <div>
              <label id="edit-agent-model-label" htmlFor="edit-agent-model" className="block text-sm font-medium text-kumo-default mb-1.5">
                Default Model
              </label>
              <Select
                id="edit-agent-model"
                aria-labelledby="edit-agent-model-label"
                className="w-full text-sm"
                placeholder="Automatic: use an available model"
                value={defaultModelId ?? ''}
                onValueChange={(value) => setDefaultModelId(value || null)}
                disabled={loading}
                renderValue={(id) => modelOptions.find((opt) => opt.value === id)?.label || 'Select a model'}
              >
                {modelOptions.map((option) => (
                  <Select.Option key={option.value} value={option.value}>
                    {option.label}
                  </Select.Option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-kumo-subtle">
                Automatic lets chat choose a recent or available model. To send without AI, choose No AI responses in Chat settings. Routines need a specific default model.
              </p>
            </div>

            {/* Connected Accounts */}
            {connectedAccounts.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-kumo-default mb-1.5">
                  Connected accounts
                </label>
                <p className="text-xs text-kumo-subtle mb-2">
                  Select which connected accounts this bot can access. Empty means no accounts.
                </p>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto mb-2">
                  {connectedAccounts.map((account) => {
                    const vendorsByAccountId = new Map<number, string>()
                    connectedAccounts.forEach(acc => vendorsByAccountId.set(acc.id, acc.vendor.displayName))
                    
                    const samVendorAccounts = connectedAccounts.filter(acc => acc.vendor.displayName === account.vendor.displayName)
                    const accountLabel = samVendorAccounts.length > 1
                      ? `${account.vendor.displayName} (${account.description.displayName || account.description.uniqueName || `Account ${account.id}`})`
                      : account.vendor.displayName
                    
                    return (
                      <label key={account.id} className="flex items-center gap-2 p-2 rounded hover:bg-kumo-border/20 cursor-pointer">
                        <Checkbox
                          aria-labelledby={`edit-agent-account-${account.id}`}
                          checked={selectedAccountIds.includes(account.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedAccountIds(prev => [...prev, account.id])
                            } else {
                              setSelectedAccountIds(prev => prev.filter(id => id !== account.id))
                            }
                          }}
                          disabled={loading}
                        />
                        <span id={`edit-agent-account-${account.id}`} className="text-sm text-kumo-default">{accountLabel}</span>
                      </label>
                    )
                  })}
                </div>
                {connectedAccounts.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {Array.from(new Set(connectedAccounts.map(acc => acc.vendor.displayName)))
                      .map(vendorName => {
                        const vendorId = connectedAccounts.find(acc => acc.vendor.displayName === vendorName)?.vendorId
                        return vendorId ? (
                          <Button
                            key={vendorId}
                            size="sm"
                            variant="secondary"
                            onClick={async () => {
                              try {
                                setConnectingVendor(vendorId)
                                const result = await authenticatedApi.connectAccount(vendorId)
                                openOAuthPopup(result.url)
                                toasts.add({
                                  title: `Switch identity in the popup to connect a different ${vendorName} account`,
                                  variant: 'success',
                                })
                              } catch (error) {
                                logRpcFailure('Failed to start account connection:', error)
                                toasts.add({ title: 'Failed to start connection', variant: 'error' })
                              } finally {
                                setConnectingVendor(null)
                              }
                            }}
                            disabled={loading || connectingVendor === vendorId}
                          >
                            Add another {vendorName} account
                          </Button>
                        ) : null
                      })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Button
            variant="secondary"
            onClick={handleDelete}
            disabled={loading}
            className="!text-kumo-danger hover:!bg-kumo-danger/10"
          >
            Delete bot
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} onClick={handleSave}>
              Save Changes
            </Button>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
