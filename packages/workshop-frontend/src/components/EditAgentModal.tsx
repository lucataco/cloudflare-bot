import { useState, useEffect } from 'react'
import { Dialog, Button, Input, TextArea, Select, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AgentProfile, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

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

  // Initialize form with agent data when modal opens
  useEffect(() => {
    if (visible) {
      setName(agent.name)
      setTitle(agent.title)
      setDescription(agent.description)
      setDefaultModelId(agent.defaultModelId)
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible, agent])

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
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open && !loading) onCancel()
      }}
      title="Edit Agent"
      description={`Update ${agent.name}'s settings`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSave()
        }}
        className="flex flex-col gap-4"
      >
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
          <TextArea
            id="edit-agent-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={loading}
            rows={3}
          />
        </div>

        {/* Advanced Settings */}
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          trigger={
            <button
              type="button"
              className="text-sm font-medium text-kumo-brand hover:text-kumo-brand-hover transition-colors"
            >
              {advancedOpen ? '▼' : '▶'} Advanced
            </button>
          }
        >
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
          </div>
        </Collapsible>

        {/* Actions */}
        <div className="flex justify-between gap-2 pt-2">
          <Button
            variant="secondary"
            onClick={handleDelete}
            disabled={loading}
            className="!text-kumo-danger hover:!bg-kumo-danger/10"
          >
            Delete Agent
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Save Changes
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
