import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Pause,
  PencilSimple,
  Play,
  X,
} from '@phosphor-icons/react'
import type { ChatQueueItem, SlashCommandRequest } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './WorkshopControls'

function previewOf(message: string | SlashCommandRequest): string {
  if (typeof message === 'string') return message.trim() || '(attachment)'
  return `/${message.id.commandId}${message.args.trim() ? ` ${message.args.trim()}` : ''}`
}

export default function ChatQueueTray({
  items,
  paused,
  onCancel,
  onSteer,
  onReorder,
  onUpdate,
  onSetPaused,
}: {
  items: ChatQueueItem[]
  paused: boolean
  onCancel: (id: string) => void
  onSteer: (id: string) => void
  onReorder: (ids: string[]) => void
  onUpdate: (id: string, message: string) => void
  onSetPaused: (paused: boolean) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(true)

  if (items.length === 0 && !paused) return null

  const move = (id: string, delta: number) => {
    const ids = items.map((item) => item.id)
    const index = ids.indexOf(id)
    const next = index + delta
    if (index < 0 || next < 0 || next >= ids.length) return
    const copy = [...ids]
    const [removed] = copy.splice(index, 1)
    copy.splice(next, 0, removed)
    onReorder(copy)
  }

  const startEdit = (item: ChatQueueItem) => {
    if (typeof item.message !== 'string') return
    setEditingId(item.id)
    setDraft(item.message)
  }

  const saveEdit = () => {
    if (editingId && draft.trim()) onUpdate(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div className="border-b border-kumo-line px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-kumo-default"
        >
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          <span>
            {items.length === 0 ? 'Queue paused' : `${items.length} queued`}
          </span>
        </button>
        <WorkshopIconButton
          aria-label={paused ? 'Resume queue' : 'Pause queue'}
          title={paused ? 'Resume queue' : 'Pause queue'}
          onClick={() => onSetPaused(!paused)}
          className={paused ? '!text-kumo-brand' : undefined}
        >
          {paused ? <Play size={13} weight="fill" /> : <Pause size={13} />}
        </WorkshopIconButton>
      </div>
      {expanded && items.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {items.map((item, index) => (
            <li
              key={item.id}
              className="flex items-start gap-1 rounded-lg bg-kumo-elevated px-2 py-1.5"
            >
              <span className="mt-0.5 w-4 shrink-0 text-center text-[11px] tabular-nums text-kumo-inactive">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                {editingId === item.id ? (
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={saveEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        saveEdit()
                      }
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    rows={2}
                    className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-[12px] text-kumo-default"
                    autoFocus
                  />
                ) : (
                  <p className="m-0 truncate text-[12px] leading-4 text-kumo-default">
                    {previewOf(item.message)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0">
                <WorkshopIconButton
                  aria-label="Move up"
                  title="Move up"
                  onClick={() => move(item.id, -1)}
                  disabled={index === 0}
                  className="!h-6 !w-6"
                >
                  <ArrowUp size={11} />
                </WorkshopIconButton>
                <WorkshopIconButton
                  aria-label="Move down"
                  title="Move down"
                  onClick={() => move(item.id, 1)}
                  disabled={index === items.length - 1}
                  className="!h-6 !w-6"
                >
                  <ArrowDown size={11} />
                </WorkshopIconButton>
                {typeof item.message === 'string' && (
                  <WorkshopIconButton
                    aria-label="Edit queued message"
                    title="Edit"
                    onClick={() => startEdit(item)}
                    className="!h-6 !w-6"
                  >
                    <PencilSimple size={11} />
                  </WorkshopIconButton>
                )}
                <WorkshopIconButton
                  aria-label="Run next"
                  title="Run this next"
                  onClick={() => onSteer(item.id)}
                  className="!h-6 !w-6"
                >
                  <Play size={11} weight="fill" />
                </WorkshopIconButton>
                <WorkshopIconButton
                  aria-label="Cancel queued message"
                  title="Cancel"
                  onClick={() => onCancel(item.id)}
                  className="!h-6 !w-6"
                >
                  <X size={11} />
                </WorkshopIconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
