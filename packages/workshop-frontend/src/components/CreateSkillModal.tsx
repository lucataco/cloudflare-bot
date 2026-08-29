import { useState } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile } from '@gadgets/workshop-shared/api'
import { X } from '@phosphor-icons/react'

export default function CreateSkillModal({
  agent,
  onClose,
  onCreated,
}: {
  agent: AgentProfile
  onClose: () => void
  onCreated: () => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!description.trim()) {
      setError('Description is required')
      return
    }
    if (!body.trim()) {
      setError('Body is required')
      return
    }

    setCreating(true)
    try {
      await authenticatedApi.createSkill(agent.id, name, description, body)
      onCreated()
    } catch (err) {
      console.error('Failed to create skill:', err)
      setError(err instanceof Error ? err.message : 'Failed to create skill')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-kumo-surface border border-kumo-border rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-kumo-border">
          <h2 className="text-lg font-semibold text-kumo-default">Create Skill</h2>
          <button
            onClick={onClose}
            className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
              placeholder="debug-workflow"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Description (when to use)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default min-h-[60px]"
              placeholder="Use this skill when debugging issues"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Body (recipe markdown)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default min-h-[200px] font-mono text-sm"
              placeholder="1. Check logs&#10;2. Verify configuration&#10;3. Test with minimal example"
            />
          </div>

          {error && (
            <div className="text-sm text-kumo-danger-default bg-kumo-danger-surface p-2 rounded">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-kumo-default bg-kumo-surface-hover border border-kumo-border rounded hover:bg-kumo-border"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-sm font-medium text-kumo-on-brand bg-kumo-brand rounded hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
