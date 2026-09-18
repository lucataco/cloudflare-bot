/**
 * The bot's owner-authored starting prompts, shown in an empty thread. Selecting one only seeds the
 * composer draft; it grants no capability and sends nothing.
 */
export default function AgentStarterCards({
  starters,
  onSelect,
  disabled,
}: {
  starters: string[]
  onSelect: (starter: string) => void
  disabled?: boolean
}) {
  return (
    <section aria-label="Suggested prompts" className="w-full min-w-0 pb-2 pt-5">
      <h2 className="text-[16px] font-medium text-kumo-default">Suggested prompts</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {starters.map((starter, index) => (
          <button
            key={`${index}:${starter}`}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(starter)}
            className="min-h-11 max-w-full cursor-pointer rounded-full border border-kumo-line bg-kumo-control px-4 text-left text-[13px] leading-5 text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {starter}
          </button>
        ))}
      </div>
    </section>
  )
}
