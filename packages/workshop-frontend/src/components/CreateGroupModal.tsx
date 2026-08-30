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
    <Dialog.Root open={visible} onOpenChange={(open: boolean) => { if (!open && !loading) onCancel() }}>
      <Dialog className="responsive-dialog !w-[min(520px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0" size="sm">
        <div className="flex flex-col border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
            Create Group
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            Create a group chat with multiple agents
          </Dialog.Description>
        </div>
        <div className="px-5 py-4">
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
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} onClick={handleCreate}>
            Create Group
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
