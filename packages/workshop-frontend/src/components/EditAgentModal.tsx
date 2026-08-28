import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Textarea, Select, Collapsible, useKumoToastManager, Checkbox } from '@cloudflare/kumo'
import { AgentProfile, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { AccountsSubscriberAdapter, AccountEvent } from '../accountsSubscriber'
import { logRpcFailure } from '../rpcErrors'

interface EditAgentModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  agent: AgentProfile
  models: AiChatAuthorInfo[]
}

export default function EditAgentModal({
  visible,
  onCancel,
  onSuccess,
  authenticatedApi,
  agent,
  models,
}: EditAgentModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [connectedAccounts, setConnectedAccounts] = useState<AccountEvent[]>([])
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([])
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)

  // Initialize form with agent data when modal opens
  useEffect(() => {
    if (visible) {
      setName(agent.name)
      setTitle(agent.title)
      setDescription(agent.description)
      setDefaultModelId(agent.defaultModelId)
      setSelectedAccountIds(agent.defaultBindings ?? [])
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
      newErrors.name = 'Agent name is required'
    }

    if (!title.trim()) {
      newErrors.title = 'Agent title is required'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSave = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      await authenticatedApi.updateAgent(agent.id, {
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        defaultModelId,
        defaultBindings: selectedAccountIds,
      })

      toasts.add({
        title: 'Agent updated',
        description: `${name} has been updated`,
        variant: 'success',
      })

      onSuccess()
    } catch (err) {
      console.error('Failed to update agent:', err)
      toasts.add({
        title: 'Failed to update agent',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete ${agent.name}? This will permanently delete the agent and all its chat history.`)) {
      return
    }

    setLoading(true)
    try {
      await authenticatedApi.deleteAgent(agent.id)

      toasts.add({
        title: 'Agent deleted',
        description: `${agent.name} has been deleted`,
        variant: 'success',
      })

      onSuccess()
    } catch (err) {
      console.error('Failed to delete agent:', err)
      toasts.add({
        title: 'Failed to delete agent',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  // Build model options: include "Human only" and all configured models
  const modelOptions = [
    { value: '', label: 'Human only (no AI)' },
    ...models.map((model) => ({
      value: model.id,
      label: model.name,
    })),
  ]

  return (
    <Dialog open={visible} onOpenChange={(open: boolean) => { if (!open && !loading) onCancel() }}>
      <Dialog.Content title="Edit Agent">
        <Dialog.Header
          title="Edit Agent"
          description={`Update ${agent.name}'s settings`}
        />
        <Dialog.Body>
      <div className="flex flex-col gap-4">
        {/* Name */}
        <div>
          <label htmlFor="edit-agent-name" className="block text-sm font-medium text-kumo-default mb-1.5">
            Name *
          </label>
          <Input
            id="edit-agent-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErrors((prev) => ({ ...prev, name: '' }))
            }}
            disabled={loading}
            error={errors.name}
          />
        </div>

        {/* Title */}
        <div>
          <label htmlFor="edit-agent-title" className="block text-sm font-medium text-kumo-default mb-1.5">
            Title *
          </label>
          <Input
            id="edit-agent-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setErrors((prev) => ({ ...prev, title: '' }))
            }}
            disabled={loading}
            error={errors.title}
          />
          <p className="mt-1 text-xs text-kumo-subtle">
            A short subtitle shown beneath the name
          </p>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="edit-agent-description" className="block text-sm font-medium text-kumo-default mb-1.5">
            Description
          </label>
          <Textarea
            id="edit-agent-description"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            disabled={loading}
            rows={3}
          />
        </div>

        {/* Advanced Settings */}
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
              <label htmlFor="edit-agent-model" className="block text-sm font-medium text-kumo-default mb-1.5">
                Default Model
              </label>
              <Select
                id="edit-agent-model"
                value={defaultModelId ?? ''}
                onValueChange={(value) => setDefaultModelId(value || null)}
                disabled={loading}
              >
                <Select.Trigger placeholder="Select a model">
                  {modelOptions.find((opt) => opt.value === (defaultModelId ?? ''))?.label || 'Select a model'}
                </Select.Trigger>
                <Select.Content>
                  {modelOptions.map((option) => (
                    <Select.Item key={option.value} value={option.value}>
                      {option.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
              <p className="mt-1 text-xs text-kumo-subtle">
                The AI model this agent uses by default. You can override it per message.
              </p>
            </div>

            {/* Connected Accounts */}
            {connectedAccounts.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-kumo-default mb-1.5">
                  Connected Accounts
                </label>
                <p className="text-xs text-kumo-subtle mb-2">
                  Select which connected accounts this agent can access. Empty means no accounts.
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
                                window.open(result.url, '_blank', 'noopener,noreferrer')
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
        </Dialog.Body>

        {/* Actions */}
        <Dialog.Footer>
          <Button
            variant="secondary"
            onClick={handleDelete}
            disabled={loading}
            className="!text-kumo-danger hover:!bg-kumo-danger/10"
          >
            Delete Agent
          </Button>
          <div className="flex gap-2 ml-auto">
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} onClick={handleSave}>
              Save Changes
            </Button>
          </div>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
