import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Hexagon, List, MagnifyingGlass, SidebarSimple, X } from '@phosphor-icons/react'
import TopBarNotice from '../../TopBarNotice'
import ReconnectingChip from '../ReconnectingChip'
import { useConnectionLost } from '../../RpcContext'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import AgentRoster from '../AgentRoster'
import CommandPalette from './CommandPalette'
import { OPEN_COMMAND_PALETTE_EVENT, openCommandPalette } from './commandPaletteBus'
import SidebarUtilityStrip from './SidebarUtilityStrip'

const STORAGE_KEY_COLLAPSED = 'gadgets:messenger-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_COLLAPSED) === '1'
  } catch {
    return false
  }
}

export default function MessengerShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const connectionLost = useConnectionLost()
  const siteName = useSiteName()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isThread = pathname.startsWith('/agents/') || pathname.startsWith('/groups/')
    || pathname.startsWith('/workspace/')

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try { localStorage.setItem(STORAGE_KEY_COLLAPSED, next ? '1' : '0') } catch {}
      return next
    })
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!mobileOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : menuButtonRef.current
    drawerRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false)
        return
      }
      if (e.key !== 'Tab' || !drawerRef.current) return
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === drawerRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      window.setTimeout(() => previousFocus?.focus(), 0)
    }
  }, [mobileOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    const onOpen = () => setPaletteOpen(true)
    document.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    }
  }, [])

  const rail = (
    compact: boolean,
    onToggleCollapsed: () => void,
  ) => (
    <aside
      aria-label="Bots"
      className={[
        'flex h-full flex-col border-r border-kumo-line bg-kumo-elevated',
        compact ? 'w-[56px]' : 'w-[min(320px,100vw)] md:w-[260px]',
        'shrink-0 transition-[width] duration-200 ease-out',
      ].join(' ')}
    >
      <div
        className={[
          'flex h-14 shrink-0 items-center border-b border-kumo-line',
          compact ? 'justify-center px-1.5' : 'justify-between gap-2 px-3',
        ].join(' ')}
      >
        <Link to="/" aria-label={siteName} className="flex min-w-0 items-center gap-2">
          <SiteLogo size={20} className="shrink-0">
            <Hexagon size={20} weight="bold" className="text-kumo-brand shrink-0" />
          </SiteLogo>
          {!compact && (
            <span className="truncate text-[14px] leading-5 font-semibold tracking-[-0.25px] text-kumo-default">
              {siteName}
            </span>
          )}
        </Link>
        {!compact && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => openCommandPalette()}
              aria-label="Search"
              title="Search (⌘K)"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            >
              <MagnifyingGlass size={15} />
            </button>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            >
              <SidebarSimple size={15} />
            </button>
          </div>
        )}
      </div>
      {compact && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mx-auto mt-2 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
        >
          <SidebarSimple size={15} className="rotate-180" />
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AgentRoster variant="rail" collapsed={compact} />
      </div>
      <SidebarUtilityStrip collapsed={compact} />
    </aside>
  )

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-kumo-base">
      <div className="hidden h-full md:flex">
        {rail(collapsed, toggleCollapsed)}
      </div>

      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Bots"
            tabIndex={-1}
            className="fixed inset-y-0 left-0 z-50 outline-none md:hidden"
          >
            {rail(false, () => setMobileOpen(false))}
          </div>
        </>
      )}

      <div
        className="flex min-w-0 flex-1 flex-col"
        inert={mobileOpen ? true : undefined}
        aria-hidden={mobileOpen ? true : undefined}
      >
        <div className="relative flex h-14 shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-3 md:hidden">
          <button
            type="button"
            ref={menuButtonRef}
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            className="flex h-11 w-11 items-center justify-center rounded-md text-kumo-default transition-colors hover:bg-kumo-tint"
          >
            {mobileOpen ? <X size={16} /> : <List size={16} />}
          </button>
          <TopBarNotice />
          <div className="ml-auto flex items-center gap-2">
            {connectionLost && <ReconnectingChip />}
          </div>
        </div>
        <div className="relative hidden h-0 md:block">
          <TopBarNotice />
        </div>
        <main className={`min-h-0 flex-1 ${isThread ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
