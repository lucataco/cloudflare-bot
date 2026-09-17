import InstallApp from '../InstallApp'
import DesktopNotifications from '../DesktopNotifications'
import { Link, useRouterState } from '@tanstack/react-router'
import { Desktop, Moon, Plug, Sun } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import { useTheme } from '../../ThemeContext'
import type { ThemeMode } from '../../theme'
import MyWorkNavigation from './MyWorkNavigation'
import AttentionNav from '../AttentionNav'

const THEME_SEQUENCE: ThemeMode[] = ['system', 'light', 'dark']

function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(mode) + 1) % THEME_SEQUENCE.length]
}

function ThemeModeButton() {
  const { themeMode, setThemeMode } = useTheme()
  const nextMode = nextThemeMode(themeMode)

  return (
    <Tooltip
      content={`Switch to ${nextMode}`}
      render={(
        <button
          type="button"
          aria-label={`Switch to ${nextMode} theme`}
          onClick={() => setThemeMode(nextMode)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {themeMode === 'system' ? (
            <Desktop size={15} />
          ) : themeMode === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
        </button>
      )}
    />
  )
}

export default function SidebarUtilityStrip({ collapsed = false, showWorkNavigation = false, onNavigate }: {
  collapsed?: boolean
  showWorkNavigation?: boolean
  onNavigate?: () => void
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const connectedAccountsActive = pathname === '/gatekeepers' || pathname.startsWith('/gatekeepers/')
  return (
    <div
      className={[
        // Keep the roster usable and all navigation reachable on short screens.
        'min-h-12 max-h-[60%] overflow-y-auto border-t border-kumo-line bg-kumo-elevated py-2',
        collapsed ? 'px-1.5' : 'px-2',
      ].join(' ')}
    >
      <InstallApp collapsed={collapsed} />
      <DesktopNotifications collapsed={collapsed} />
      <AttentionNav collapsed={collapsed} onNavigate={onNavigate} />
      <Link to="/auto-review" aria-label="Auto-review rules" title="Auto-review rules" onClick={onNavigate}
        className="flex min-h-10 items-center rounded-lg px-3 text-sm text-kumo-subtle hover:bg-kumo-tint">
        {collapsed ? '✓' : 'Auto-review rules'}
      </Link>
      {showWorkNavigation && <MyWorkNavigation collapsed={collapsed} onNavigate={onNavigate} />}
      <Link
        to="/gatekeepers"
        aria-label="Connected accounts"
        title={collapsed ? 'Connected accounts' : undefined}
        aria-current={connectedAccountsActive ? 'page' : undefined}
        onClick={onNavigate}
        className={[
          'flex items-center gap-2.5 rounded-lg text-[13px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-ring',
          collapsed ? 'mx-auto h-10 w-10 justify-center' : 'h-11 px-3 md:h-9',
          connectedAccountsActive ? 'bg-kumo-fill text-kumo-default' : '',
        ].join(' ')}
      >
        <Plug size={17} aria-hidden="true" />
        {!collapsed && <span>Connected accounts</span>}
      </Link>
      <div className={collapsed ? 'mt-2 flex flex-col items-center gap-2' : 'mt-2 flex items-center justify-between border-t border-kumo-line px-2 pt-2'}>
        <ThemeModeButton />
        <UserMenu />
      </div>
    </div>
  )
}
