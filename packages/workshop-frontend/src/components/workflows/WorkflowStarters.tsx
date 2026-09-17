import { useId, useRef } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { Lightbulb } from '@phosphor-icons/react'
import { WORKFLOW_STARTERS, type WorkflowStarter } from '@gadgets/workshop-shared/workflow-starters'

type Props = {
  onSelect: (starter: WorkflowStarter) => void
  disabled?: boolean
}

export function WorkflowStarterCards({ onSelect, disabled }: Props) {
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} className="w-full min-w-0 py-5">
      <h2 id={`${id}-title`} className="text-[16px] font-medium text-kumo-default">Start with a task</h2>
      <p id={`${id}-hint`} className="mt-1 text-[13px] leading-5 text-kumo-subtle">
        Add an idea to your draft, then edit and send when ready. Nothing runs or connects until you ask.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {WORKFLOW_STARTERS.map(starter => (
          <button
            key={starter.id}
            type="button"
            disabled={disabled}
            aria-labelledby={`${id}-${starter.id}`}
            aria-describedby={`${id}-${starter.id}-description ${id}-hint`}
            onClick={() => onSelect(starter)}
            className="min-h-11 min-w-0 cursor-pointer rounded-xl border border-kumo-line bg-kumo-control p-4 text-left transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span id={`${id}-${starter.id}`} className="block text-[14px] font-medium leading-5 text-kumo-default">{starter.title}</span>
            <span id={`${id}-${starter.id}-description`} className="mt-2 block text-[13px] leading-5 text-kumo-subtle">{starter.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function WorkflowStarterMenu({ onSelect, disabled }: Props) {
  const selection = useRef<WorkflowStarter | null>(null)
  return (
    <DropdownMenu onOpenChangeComplete={open => {
      if (open || !selection.current) return
      const starter = selection.current
      selection.current = null
      // Let the menu restore focus before the composer focuses its draft.
      onSelect(starter)
    }}>
      <DropdownMenu.Trigger render={
        <button type="button" disabled={disabled} className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring disabled:cursor-not-allowed disabled:opacity-50">
          <Lightbulb size={16} aria-hidden="true" />
          Task ideas
        </button>
      } />
      <DropdownMenu.Content collisionPadding={16} className="themed-floating-shadow-lg !z-[1100] w-72 max-w-[calc(100vw-32px)] max-h-[70dvh] overflow-y-auto rounded-2xl border border-kumo-line bg-kumo-base p-1">
        <DropdownMenu.Group>
          <DropdownMenu.Label className="px-3 py-2 text-[12px] font-normal leading-5 text-kumo-subtle">Add to your draft. Review before sending.</DropdownMenu.Label>
          {WORKFLOW_STARTERS.map(starter => (
            <DropdownMenu.Item key={starter.id} onClick={() => { selection.current = starter }} className="!h-auto min-h-11 whitespace-normal rounded-xl !px-3 !py-2 text-[13px] leading-5 text-kumo-subtle data-highlighted:bg-kumo-tint data-highlighted:text-kumo-default">
              {starter.title}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
