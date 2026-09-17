import { useId, useRef, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import type { AgentProfile } from '@gadgets/workshop-shared/api'
import { X } from '@phosphor-icons/react'
import { WorkshopButton, WorkshopIconButton, WorkshopInput, WorkshopInputArea } from './WorkshopControls'

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
  const id = useId()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (creatingRef.current) return
    setError(null)

    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!description.trim()) {
      setError('When to use is required')
      return
    }
    if (!body.trim()) {
      setError('Instructions are required')
      return
    }

    creatingRef.current = true
    setCreating(true)
    try {
      // Keep Markdown indentation and line breaks in the instructions intact.
      await authenticatedApi.createSkill(agent.id, name.trim(), description.trim(), body)
      onCreated()
    } catch (err) {
      console.error('Failed to create skill:', err)
      setError(err instanceof Error ? err.message : 'Failed to create skill')
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open, details) => {
      if (creatingRef.current) details.cancel()
      else if (!open) onClose()
    }}>
      <Dialog className="responsive-dialog !top-[clamp(28px,10vh,96px)] !flex !max-h-[min(80vh,calc(var(--app-height)-32px))] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="sm">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-kumo-line px-5 py-4">
          <div>
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Create skill
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-kumo-subtle">
              Give your bot reusable instructions for a task you do often.
            </Dialog.Description>
          </div>
          <Dialog.Close disabled={creating} render={
            <WorkshopIconButton type="button" aria-label="Close skill"><X size={16} /></WorkshopIconButton>
          } />
        </div>

        <form onSubmit={handleSubmit} noValidate aria-busy={creating} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <label id={`${id}-name-label`} htmlFor={`${id}-name`} className="mb-1.5 block text-sm font-medium text-kumo-default">
                Name
              </label>
              <WorkshopInput
                id={`${id}-name`}
                aria-labelledby={`${id}-name-label`}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
                className="w-full"
                placeholder="Meeting follow-up"
              />
            </div>

            <div>
              <label id={`${id}-description-label`} htmlFor={`${id}-description`} className="mb-1.5 block text-sm font-medium text-kumo-default">
                When to use
              </label>
              <WorkshopInputArea
                id={`${id}-description`}
                aria-labelledby={`${id}-description-label`}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={creating}
                className="w-full"
                rows={2}
                placeholder="Use this skill after a meeting to turn notes into clear next steps."
              />
            </div>

            <div>
              <label id={`${id}-body-label`} htmlFor={`${id}-body`} className="mb-1.5 block text-sm font-medium text-kumo-default">
                Instructions
              </label>
              <WorkshopInputArea
                id={`${id}-body`}
                aria-labelledby={`${id}-body-label`}
                aria-describedby={`${id}-body-help`}
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={creating}
                className="w-full"
                rows={7}
                placeholder={'1. Summarize the main decisions.\n2. List next steps with owners and due dates.\n3. Flag anything that needs clarification.'}
              />
              <p id={`${id}-body-help`} className="mt-1 text-xs text-kumo-subtle">
                Write the steps your bot should follow. Markdown formatting is optional.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            {error && <p role="alert" className="w-full break-words rounded-lg bg-kumo-danger-tint p-3 text-sm text-kumo-danger">{error}</p>}
            <Dialog.Close disabled={creating} render={<WorkshopButton type="button">Cancel</WorkshopButton>} />
            <WorkshopButton type="submit" tone="primary" disabled={creating}>
              {creating ? 'Creating...' : 'Create skill'}
            </WorkshopButton>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
