import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Textarea, Select, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

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
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setName('')
      setTitle('')
      setDescription('')
      setDefaultModelId(null)
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

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

  const handleCreate = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const agent = await authenticatedApi.createAgent(
        name.trim(),
        title.trim(),
        description.trim() || '',
        defaultModelId,
      )

      toasts.add({
        title: 'Agent created',
        description: `${agent.name} is ready to chat`,
        variant: 'success',
      })

      onSuccess(agent.id, agent.workspaceId)
    } catch (err) {
      console.error('Failed to create agent:', err)
      toasts.add({
        title: 'Failed to create agent',
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
      <Dialog.Content title="Create Agent">
        <Dialog.Header
          title="Create Agent"
          description="Create a new AI teammate with its own personality and chat history"
        />
        <Dialog.Body>
      <div className="flex flex-col gap-4">
        {/* Name */}
        <div>
          <label htmlFor="agent-name" className="block text-sm font-medium text-kumo-default mb-1.5">
            Name *
          </label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErrors((prev) => ({ ...prev, name: '' }))
            }}
            placeholder="e.g., Research Assistant"
            disabled={loading}
            error={errors.name}
          />
        </div>

        {/* Title */}
        <div>
          <label htmlFor="agent-title" className="block text-sm font-medium text-kumo-default mb-1.5">
            Title *
          </label>
          <Input
            id="agent-title"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setErrors((prev) => ({ ...prev, title: '' }))
            }}
            placeholder="e.g., Code & Documentation Expert"
            disabled={loading}
            error={errors.title}
          />
          <p className="mt-1 text-xs text-kumo-subtle">
            A short subtitle shown beneath the name
          </p>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="agent-description" className="block text-sm font-medium text-kumo-default mb-1.5">
            Description
          </label>
          <Textarea
            id="agent-description"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            placeholder="What does this agent do? What's its personality?"
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
              <label htmlFor="agent-model" className="block text-sm font-medium text-kumo-default mb-1.5">
                Default Model
              </label>
              <Select
                id="agent-model"
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
          </div>
        )}
      </div>
        </Dialog.Body>

        {/* Actions */}
        <Dialog.Footer>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} onClick={handleCreate}>
            Create Agent
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
