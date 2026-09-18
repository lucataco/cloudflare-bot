import ImportGrokBot from './ImportGrokBot'
import ImportAgentSeeds from './ImportAgentSeeds'
import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Textarea, Select, useKumoToastManager, Checkbox } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, AccountEvent } from '../accountsSubscriber'
import { logRpcFailure } from '../rpcErrors'
import { openOAuthPopup } from '../openOAuthPopup'
import { FIRST_BOT_SUGGESTIONS } from './botRolePresets'
import AgentAvatarPicker from './AgentAvatarPicker'
import type { AvatarImage } from '@gadgets/workshop-shared/gatekeeper'

interface CreateAgentModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: (agentId: string, workspaceId: string) => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  models: AiChatAuthorInfo[]
}

export default function CreateAgentModal({
  visible,
  onCancel,
  onSuccess,
  authenticatedApi,
  models,
}: CreateAgentModalProps) {
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
    if (!visible) {
      setName('')
      setTitle('')
      setDescription('')
      setAvatar(undefined)
      setDefaultModelId(null)
      setErrors({})
      setAdvancedOpen(false)
      setSelectedAccountIds([])
      setNotifyOnUpdates(true)
    }
  }, [visible])

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

  const handleCreate = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const agent = await authenticatedApi.createAgent(
        name.trim(),
        title.trim(),
        description.trim() || '',
        defaultModelId,
        avatar,
        selectedAccountIds,
        notifyOnUpdates
      )

      toasts.add({
        title: 'Bot created',
        description: `${agent.name} is ready to chat`,
        variant: 'success',
      })

      onSuccess(agent.id, agent.workspaceId)
    } catch (err) {
      console.error('Failed to create agent:', err)
      toasts.add({
        title: 'Failed to create bot',
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
            Create bot
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            Give your bot a job, with its own instructions and chat history.
          </Dialog.Description>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-1.5 text-sm font-medium text-kumo-default">Start with a job</p>
          <div className="flex flex-wrap gap-2">
            {FIRST_BOT_SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion.title}
                type="button"
                variant="secondary"
                size="sm"
                title={suggestion.description}
                disabled={loading}
                onClick={() => {
                  setName(suggestion.name)
                  setTitle(suggestion.title)
                  setDescription(suggestion.description)
                  setErrors({})
                }}
              >
                {suggestion.title}
              </Button>
            ))}
          </div>
        </div>

        <ImportGrokBot api={authenticatedApi} disabled={loading || !visible} onPreview={bot => {
          setName(bot.name); setTitle(bot.title); setDescription(bot.description)
        }} />
        <ImportAgentSeeds api={authenticatedApi} disabled={loading || !visible} onSuccess={onSuccess} onBusyChange={setLoading} />
        {/* Name */}
        <div>
          <label htmlFor="agent-name" className="block text-sm font-medium text-kumo-default mb-1.5">
            Name *
          </label>
          <Input
            id="agent-name"
            className="w-full"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErrors((prev) => ({ ...prev, name: '' }))
            }}
            placeholder="e.g., Riley"
            disabled={loading}
            error={errors.name}
          />
        </div>

        <AgentAvatarPicker avatar={avatar} disabled={loading} onChange={setAvatar} />

        {/* Title */}
        <div>
          <label htmlFor="agent-title" className="block text-sm font-medium text-kumo-default mb-1.5">
            Job *
          </label>
          <Input
            id="agent-title"
            className="w-full"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setErrors((prev) => ({ ...prev, title: '' }))
            }}
            placeholder="e.g., Research assistant"
            disabled={loading}
            error={errors.title}
          />
          <p className="mt-1 text-xs text-kumo-subtle">
            What this bot helps you do, shown beneath its name
          </p>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="agent-description" className="block text-sm font-medium text-kumo-default mb-1.5">
            Description
          </label>
          <Textarea
            id="agent-description"
            className="w-full"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            placeholder="What should this bot help you get done?"
            disabled={loading}
            rows={3}
          />
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={notifyOnUpdates}
              onCheckedChange={(checked) => setNotifyOnUpdates(checked === true)}
              disabled={loading}
            />
            <span className="text-sm text-kumo-default">Notify me about this bot</span>
          </label>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover transition-colors"
          >
            {advancedOpen ? '▼' : '▶'} Advanced
          </button>
        </div>
        {advancedOpen && (
          <div className="mt-4 flex flex-col gap-4 rounded-lg border border-kumo-border bg-kumo-well p-4">
            {/* Default Model */}
            <div>
              <label htmlFor="agent-model" className="block text-sm font-medium text-kumo-default mb-1.5">
                Default Model
              </label>
              <Select
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
                        <span className="text-sm text-kumo-default">{accountLabel}</span>
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

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} onClick={handleCreate}>
            Create bot
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
