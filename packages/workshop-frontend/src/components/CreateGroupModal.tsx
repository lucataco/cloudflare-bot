import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Checkbox, useKumoToastManager } from '@cloudflare/kumo'
import { AgentProfile } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface CreateGroupModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: (groupId: string, workspaceId: string) => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  agents: AgentProfile[]
}

export default function CreateGroupModal({
  visible,
  onCancel,
  onSuccess,
  authenticatedApi,
  agents,
}: CreateGroupModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!visible) {
      setName('')
      setSelectedAgentIds([])
      setErrors({})
    }
  }, [visible])

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!name.trim()) {
      newErrors.name = 'Group name is required'
    }

    if (selectedAgentIds.length === 0) {
      newErrors.members = 'Select at least one agent'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleCreate = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const group = await authenticatedApi.createGroup(
        name.trim(),
        selectedAgentIds
      )

      toasts.add({
        title: 'Group created',
        description: `${group.name} is ready`,
        variant: 'success',
      })

      onSuccess(group.id, group.workspaceId)
    } catch (err) {
      console.error('Failed to create group:', err)
      toasts.add({
        title: 'Failed to create group',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={visible} onOpenChange={(open: boolean) => { if (!open && !loading) onCancel() }}>
      <Dialog.Content title="Create Group">
        <Dialog.Header
          title="Create Group"
          description="Create a group chat with multiple agents"
        />
        <Dialog.Body>
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="group-name" className="block text-sm font-medium text-kumo-default mb-1.5">
                Group Name *
              </label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setErrors((prev) => ({ ...prev, name: '' }))
                }}
                placeholder="e.g., Engineering Team"
                disabled={loading}
                error={errors.name}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-kumo-default mb-1.5">
                Members *
              </label>
              {agents.length === 0 ? (
                <p className="text-sm text-kumo-subtle">No agents available. Create an agent first.</p>
              ) : (
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                  {agents.map((agent) => (
                    <label key={agent.id} className="flex items-center gap-2 p-2 rounded hover:bg-kumo-border/20 cursor-pointer">
                      <Checkbox
                        checked={selectedAgentIds.includes(agent.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedAgentIds(prev => [...prev, agent.id])
                            setErrors((prev) => ({ ...prev, members: '' }))
                          } else {
                            setSelectedAgentIds(prev => prev.filter(id => id !== agent.id))
                          }
                        }}
                        disabled={loading}
                      />
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kumo-brand text-white text-xs font-semibold">
                          {agent.avatar?.url ? (
                            <img
                              src={agent.avatar.url}
                              alt={agent.name}
                              className="h-full w-full rounded-full object-cover"
                            />
                          ) : (
                            agent.name[0]?.toUpperCase()
                          )}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm text-kumo-default">{agent.name}</span>
                          <span className="text-xs text-kumo-subtle">{agent.title}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {errors.members && (
                <p className="mt-1 text-xs text-kumo-error">{errors.members}</p>
              )}
            </div>
          </div>
        </Dialog.Body>

        <Dialog.Footer>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} onClick={handleCreate}>
            Create Group
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
