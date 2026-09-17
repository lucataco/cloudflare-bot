import { Link } from '@tanstack/react-router'
import { Bell } from '@phosphor-icons/react'
import { useAttention } from '../AttentionContext'

export default function AttentionNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { page, error, loading } = useAttention()
  const count = page?.unseen
  const qualifier = error ? 'updates unavailable' : loading ? 'updating' : page?.catchingUp ? 'catching up' : 'recent unseen'
  const label = `Attention${count === undefined ? '' : `, ${count} recent unseen`}${qualifier === 'recent unseen' ? '' : `, ${qualifier}`}`
  return (
    <Link to="/attention" aria-label={label} title={label} onClick={onNavigate}
      activeProps={{ className: 'bg-kumo-fill text-kumo-default' }}
      className={`relative flex items-center gap-2.5 rounded-lg text-[13px] font-medium text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-ring ${collapsed ? 'mx-auto h-10 w-10 justify-center' : 'min-h-11 px-3 md:min-h-9'}`}>
      <Bell size={17} aria-hidden="true" />
      {!collapsed && <span>Attention</span>}
      {count !== undefined && count > 0 && <span aria-hidden="true"
        className={`rounded-full bg-kumo-contrast px-1.5 text-[10px] leading-4 text-kumo-inverse ${collapsed ? 'absolute -right-1 top-0' : 'ml-auto'}`}>
        {count > 99 ? '99+' : count}
      </span>}
      {!collapsed && (error || page?.catchingUp) && <span aria-hidden="true" className="text-xs">{error ? '!' : '...'}</span>}
    </Link>
  )
}
