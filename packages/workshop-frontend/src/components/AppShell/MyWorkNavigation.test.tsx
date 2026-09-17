// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushFrames, makeTestRoot } from '../../action-test-harness'
import MyWorkNavigation from './MyWorkNavigation'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import MessengerShell from './MessengerShell'
import UserMenu from '../UserMenu'

const auth = vi.hoisted(() => {
  // Navigation needs no RPC, including workspace creation or template import.
  const rpcAccess = vi.fn<NonNullable<ProxyHandler<object>['get']>>((_target, property) => {
    throw new Error(`Unexpected navigation RPC access: ${String(property)}`)
  })
  return {
    authenticatedApi: new Proxy({}, { get: rpcAccess }),
    rpcAccess,
    currentUser: { id: 'user', name: 'Test User' },
    isAdmin: false,
    logout: vi.fn<() => void>(),
  }
})
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => auth }))
vi.mock('../../useAvatar', () => ({ useAvatar: () => undefined }))
vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ themeMode: 'system', setThemeMode: vi.fn<(mode: string) => void>() }) }))
vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: ReactNode }) => <span>{children}</span> }))
vi.mock('../AgentRoster', () => ({ default: () => null }))
vi.mock('./CommandPalette', () => ({ default: () => null }))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const view = makeTestRoot()
const destinations = [
  ['Workspaces', '/workspaces'],
  ['Apps & documents', '/outputs'],
  ['Templates', '/blueprints'],
  ['Explore templates', '/explore'],
  ['Computers', '/computers'],
] as const

async function renderAt(node: ReactNode, pathname = '/agents/bot-1') {
  const rootRoute = createRootRoute({ component: () => node })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [pathname] }),
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null }),
    ]),
  })
  await router.load()
  await view.render(<RouterProvider router={router} />)
  return router
}

function control(label: string, scope: ParentNode = document) {
  const matches = [...scope.querySelectorAll<HTMLElement>('button, a, [role="menuitem"]')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(matches, `unique control: ${label}`).toHaveLength(1)
  return matches[0]
}

async function click(label: string, scope: ParentNode = document) {
  await act(async () => { control(label, scope).click() })
  await act(async () => { flushFrames() })
}

async function key(element: Element, value: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
  await act(async () => { flushFrames() })
}

beforeEach(() => {
  auth.isAdmin = false
  vi.clearAllMocks()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  view.cleanup()
  localStorage.removeItem('gadgets:messenger-sidebar-collapsed')
  vi.restoreAllMocks()
})

describe('My work navigation', () => {
  it('opens an inline disclosure with four real links, without a menu or nested buttons', async () => {
    await renderAt(<MyWorkNavigation collapsed={false} />)
    const nav = document.querySelector('nav[aria-label="My work"]')!
    const trigger = control('My work')
    const links = document.getElementById(trigger.getAttribute('aria-controls')!)!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(links.hidden).toBe(true)

    await click('My work')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(links.hidden).toBe(false)
    expect(nav.contains(links)).toBe(true)
    expect([...links.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')]))
      .toEqual(destinations)
    expect(document.querySelector('[role="menu"], [role="dialog"], button a, a button, button button')).toBeNull()
    expect(nav.querySelector('[aria-current]')).toBeNull()

    await click('My work')
    expect(links.hidden).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('auto-expands for work routes and details, marking only the actual destination current', async () => {
    const router = await renderAt(<MyWorkNavigation collapsed={false} />, '/outputs')
    const trigger = control('My work')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(control('Apps & documents').getAttribute('aria-current')).toBe('page')

    for (const [label, path] of [
      ...destinations, ['Templates', '/blueprint/template-1'], ['Workspaces', '/workspace/workspace-1'],
    ]) {
      await click('My work')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      await act(async () => { await router.navigate({ href: path }) })
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect([...document.querySelectorAll('[aria-current="page"]')]).toEqual([control(label)])
    }

    for (const path of ['/blueprints-extra', '/workspaces-extra', '/gatekeepers/context']) {
      await act(async () => { await router.navigate({ href: path }) })
      expect(document.querySelector('[aria-current]')).toBeNull()
    }
  })

  it('navigates every inline link and invokes onNavigate even for the current route', async () => {
    const onNavigate = vi.fn<() => void>()
    const router = await renderAt(<MyWorkNavigation collapsed={false} onNavigate={onNavigate} />, '/workspaces')
    for (const [index, [label, path]] of destinations.entries()) {
      await click(label)
      expect(router.state.location.pathname).toBe(path)
      expect(onNavigate).toHaveBeenCalledTimes(index + 1)
    }
    await click('Computers')
    expect(onNavigate).toHaveBeenCalledTimes(destinations.length + 1)
    expect(document.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
    expect(auth.rpcAccess).not.toHaveBeenCalled()
  })

  it('offers the same destinations from a single compact Kumo menu and closes on selection', async () => {
    const onNavigate = vi.fn<() => void>()
    const router = await renderAt(<MyWorkNavigation collapsed onNavigate={onNavigate} />, '/workspaces')
    const trigger = control('My work')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(document.querySelector('nav, a, [role="menu"]')).toBeNull()

    for (const [index, [label, path]] of destinations.entries()) {
      await click('My work')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
      expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()))
        .toEqual(destinations.map(([name]) => name))
      expect(document.querySelector('[role="dialog"], button button, button a, a button')).toBeNull()
      await click(label)
      expect(router.state.location.pathname).toBe(path)
      expect(onNavigate).toHaveBeenCalledTimes(index + 1)
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.querySelector('[role="menu"]')).toBeNull()
    }
    expect(auth.rpcAccess).not.toHaveBeenCalled()
  })

  it('opens and selects a compact destination entirely with the keyboard', async () => {
    const onNavigate = vi.fn<() => void>()
    const router = await renderAt(<MyWorkNavigation collapsed onNavigate={onNavigate} />)
    const trigger = control('My work')
    act(() => trigger.focus())
    await key(trigger, 'ArrowDown')
    expect(document.activeElement).toBe(control('Workspaces'))
    await key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(control('Apps & documents'))
    await key(document.activeElement!, 'Enter')
    expect(router.state.location.pathname).toBe('/outputs')
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(auth.rpcAccess).not.toHaveBeenCalled()
  })

  it('dismisses the compact menu with Escape and restores focus without navigating', async () => {
    const onNavigate = vi.fn<() => void>()
    const router = await renderAt(<MyWorkNavigation collapsed onNavigate={onNavigate} />)
    const trigger = control('My work')
    act(() => trigger.focus())
    await key(trigger, 'ArrowDown')
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    await key(document.activeElement!, 'Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(router.state.location.pathname).toBe('/agents/bot-1')
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('Sidebar utilities and profile menu', () => {
  it('omits My work by default and labels Connected accounts, active on index and management routes only', async () => {
    const router = await renderAt(<SidebarUtilityStrip />, '/gatekeepers')
    const accounts = control('Connected accounts')
    expect(accounts.tagName).toBe('A')
    expect(accounts.textContent).toBe('Connected accounts')
    expect(accounts.getAttribute('href')).toBe('/gatekeepers')
    expect(document.querySelector('nav[aria-label="My work"], button[aria-label="My work"]')).toBeNull()
    expect(accounts.getAttribute('aria-current')).toBe('page')
    await act(async () => { await router.navigate({ to: '/gatekeepers/$appId', params: { appId: 'context' } }) })
    expect(accounts.getAttribute('aria-current')).toBe('page')
    for (const path of ['/gatekeepers-extra', '/outputs']) {
      await act(async () => { await router.navigate({ href: path }) })
      expect(accounts.hasAttribute('aria-current')).toBe(false)
    }
  })

  it('keeps compact Connected accounts an accessible icon link and forwards all navigation callbacks', async () => {
    const onNavigate = vi.fn<() => void>()
    const router = await renderAt(<SidebarUtilityStrip collapsed showWorkNavigation onNavigate={onNavigate} />, '/gatekeepers')
    const accounts = control('Connected accounts')
    expect(accounts.tagName).toBe('A')
    expect(accounts.textContent).toBe('')
    expect(accounts.getAttribute('title')).toBe('Connected accounts')
    expect(accounts.getAttribute('aria-current')).toBe('page')
    expect(accounts.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('button a, a button, button button')).toBeNull()
    await click('Connected accounts')
    expect(router.state.location.pathname).toBe('/gatekeepers')
    expect(onNavigate).toHaveBeenCalledOnce()
    await click('My work')
    await click('Templates')
    expect(router.state.location.pathname).toBe('/blueprints')
    expect(onNavigate).toHaveBeenCalledTimes(2)
    await click('Connected accounts')
    expect(router.state.location.pathname).toBe('/gatekeepers')
    expect(onNavigate).toHaveBeenCalledTimes(3)
    expect(auth.rpcAccess).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves profile, providers, sign out and authorized admin, with no work links (admin=%s)', async isAdmin => {
    auth.isAdmin = isAdmin
    const router = await renderAt(<UserMenu />)
    await click('Open profile menu')
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()))
      .toEqual(['Profile', 'Providers', ...(isAdmin ? ['Admin'] : []), 'Sign out'])
    for (const [label, path] of [
      ['Profile', '/profile'], ['Providers', '/providers'], ...(isAdmin ? [['Admin', '/admin']] : []),
    ]) {
      await click(label)
      expect(router.state.location.pathname).toBe(path)
      expect(auth.logout).not.toHaveBeenCalled()
      expect(document.querySelector('[role="menu"]')).toBeNull()
      await click('Open profile menu')
    }
    await click('Sign out')
    expect(auth.logout).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"], [role="dialog"]')).toBeNull()
    expect(auth.rpcAccess).not.toHaveBeenCalled()
  })
})

it('keeps the 56px desktop rail compact but mobile links inline, closing the real drawer even on same-route clicks', async () => {
  localStorage.setItem('gadgets:messenger-sidebar-collapsed', '1')
  const router = await renderAt(<MessengerShell><div>Thread content</div></MessengerShell>)
  const desktopRail = document.querySelector('aside')!
  expect(desktopRail.classList.contains('w-[56px]')).toBe(true)
  expect(control('My work', desktopRail).getAttribute('aria-haspopup')).toBe('menu')

  for (const [label, path] of [...destinations, ['Connected accounts', '/gatekeepers']]) {
    const previousPath = router.state.location.pathname
    for (let repeat = 0; repeat < 2; repeat++) {
      await click('Open menu')
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      const drawer = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Bots"]')!
      expect(drawer.getAttribute('aria-modal')).toBe('true')
      const trigger = control('My work', drawer)
      if (trigger.getAttribute('aria-expanded') === 'false') await click('My work', drawer)
      expect(drawer.querySelectorAll('nav[aria-label="My work"] a')).toHaveLength(destinations.length)
      expect(document.querySelector('[role="menu"], button a, a button, button button')).toBeNull()
      const link = control(label, drawer)
      expect(link.tagName).toBe('A')
      expect(link.closest('[hidden]')).toBeNull()
      // The second click must close through onNavigate, not the pathname effect.
      expect(router.state.location.pathname).toBe(repeat ? path : previousPath)
      expect(link.getAttribute('aria-current')).toBe(repeat ? 'page' : null)
      await click(label, drawer)
      expect(router.state.location.pathname).toBe(path)
      expect(document.querySelector('[role="dialog"], [role="menu"]')).toBeNull()
      expect(control('Open menu')).toBeDefined()
    }
  }
  expect(auth.rpcAccess).not.toHaveBeenCalled()
})
