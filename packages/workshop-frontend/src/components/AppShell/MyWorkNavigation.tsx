import { useEffect, useId, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { Blueprint, CaretDown, Compass, FolderOpen, SquaresFour, Stack } from '@phosphor-icons/react'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../menuStyles'

const DESTINATIONS = [
  { to: '/workspaces', label: 'Workspaces', icon: SquaresFour, detailPrefix: '/workspace/' },
  { to: '/outputs', label: 'Apps & documents', icon: Stack },
  { to: '/blueprints', label: 'Templates', icon: Blueprint, detailPrefix: '/blueprint/' },
  { to: '/explore', label: 'Explore templates', icon: Compass },
  { to: '/computers', label: 'Computers', icon: SquaresFour },
] as const

export default function MyWorkNavigation({ collapsed, onNavigate }: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const linksId = useId()
  const activeDestination = DESTINATIONS.find((item) => pathname === item.to ||
    ('detailPrefix' in item && pathname.startsWith(item.detailPrefix)))
  const [expanded, setExpanded] = useState(!!activeDestination)

  useEffect(() => {
    if (activeDestination) setExpanded(true)
  }, [activeDestination])

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenu.Trigger render={
          <button
            type="button"
            aria-label="My work"
            title="My work"
            className={`mx-auto flex h-10 w-10 items-center justify-center rounded-lg text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-ring ${activeDestination ? 'bg-kumo-fill text-kumo-default' : ''}`}
          >
            <FolderOpen size={17} aria-hidden="true" />
          </button>
        } />
        <DropdownMenu.Content side="right" align="end" collisionPadding={12} className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
          {DESTINATIONS.map((item) => (
            <DropdownMenu.Item
              key={item.to}
              icon={item.icon}
              selected={item === activeDestination}
              onClick={() => { void navigate({ to: item.to }); onNavigate?.() }}
              className={MENU_ITEM}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    )
  }

  // Inline links stay inside the mobile drawer's focus trap, unlike a portaled submenu.
  return (
    <nav aria-label="My work">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={linksId}
        onClick={() => setExpanded((value) => !value)}
        className={`flex h-11 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring md:h-9 ${activeDestination ? 'text-kumo-default' : ''}`}
      >
        <FolderOpen size={17} aria-hidden="true" />
        My work
        <CaretDown size={13} aria-hidden="true" className={`ml-auto ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <div id={linksId} hidden={!expanded} className="ml-5 border-l border-kumo-line pl-2">
        {DESTINATIONS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-current={item === activeDestination ? 'page' : undefined}
            className={`flex min-h-11 items-center rounded-lg px-3 text-[13px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring md:min-h-9 ${item === activeDestination ? 'bg-kumo-tint font-medium text-kumo-default' : ''}`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
