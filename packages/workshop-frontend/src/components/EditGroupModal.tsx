import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Checkbox, useKumoToastManager } from '@cloudflare/kumo'
import { AgentProfile, Group } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface EditGroupModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  onDelete: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  group: Group
  agents: AgentProfile[]
}

export default function EditGroupModal({
  visible,
  onCancel,
  onSuccess,
  onDelete,
  authenticatedApi,
  group,
  agents,
}: EditGroupModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState(group.name)
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(group.memberAgentIds)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (visible) {
      setName(group.name)
      setSelectedAgentIds(group.memberAgentIds)
      setErrors({})
    }
  }, [visible, group])

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

  const handleUpdate = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      await authenticatedApi.updateGroup(group.id, {
        name: name.trim(),
        memberAgentIds: selectedAgentIds,
      })

      toasts.add({
        title: 'Group updated',
        variant: 'success',
      })

      onSuccess()
    } catch (err) {
      console.error('Failed to update group:', err)
      toasts.add({
        title: 'Failed to update group',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete ${group.name}? This will permanently delete the group and its chat history.`)) {
      return
    }

    setDeleting(true)
    try {
      await authenticatedApi.deleteGroup(group.id)

      toasts.add({
        title: 'Group deleted',
        variant: 'success',
      })

      onDelete()
    } catch (err) {
      console.error('Failed to delete group:', err)
      toasts.add({
        title: 'Failed to delete group',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={visible} onOpenChange={(open: boolean) => { if (!open && !loading && !deleting) onCancel() }}>
      <Dialog.Content title="Edit Group">
        <Dialog.Header
          title="Edit Group"
          description="Update group name and members"
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
                disabled={loading || deleting}
                error={errors.name}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-kumo-default mb-1.5">
                Members *
              </label>
              {agents.length === 0 ? (
                <p className="text-sm text-kumo-subtle">No agents available</p>
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
                        disabled={loading || deleting}
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

        <Dialog.Footer className="flex justify-between">
          <Button variant="destructive" onClick={handleDelete} loading={deleting} disabled={loading}>
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel} disabled={loading || deleting}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} onClick={handleUpdate} disabled={deleting}>
              Update Group
            </Button>
          </div>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
  )
}
