import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { FormatGlyph } from './format/FormatVisuals'

export default function InspectorFilesPane({
  gadgets,
  selectedId,
  onSelect,
}: {
  gadgets: WorkpieceSummary[]
  selectedId: WorkpieceId | null
  onSelect: (id: WorkpieceId) => void
}) {
  if (gadgets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="m-0 text-[13px] leading-[18px] text-kumo-subtle">
          No results yet. Ask the bot to create an app or document and it will show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto p-2">
      {gadgets.map((gadget) => {
        const selected = gadget.id === selectedId
        return (
          <button
            key={gadget.id}
            type="button"
            onClick={() => onSelect(gadget.id)}
            aria-current={selected ? 'page' : undefined}
            className={`flex w-full shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
              selected ? 'bg-kumo-brand/10' : 'hover:bg-kumo-well'
            }`}
          >
            <FormatGlyph output={gadget.output} size="md" className="shrink-0 text-kumo-subtle" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">
              {gadget.title || 'Untitled'}
            </span>
            {gadget.chatId !== undefined && (
              <span className="text-[11px] text-kumo-inactive">Draft</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
