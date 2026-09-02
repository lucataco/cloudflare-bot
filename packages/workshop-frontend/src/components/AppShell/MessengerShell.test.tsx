// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  useRouterState: (opts?: { select?: (state: { location: { pathname: string } }) => unknown }) => {
    const state = { location: { pathname: '/agents/bot-1' } }
    return opts?.select ? opts.select(state) : state
  },
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}))

vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('../../ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('../SiteLogo', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('../AgentRoster', () => ({
  default: () => <div data-testid="bot-roster" />,
}))
vi.mock('./CommandPalette', () => ({ default: () => null }))
vi.mock('./SidebarUtilityStrip', () => ({ default: () => null }))

import MessengerShell from './MessengerShell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MessengerShell', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
  })

  it('keeps the bot rail mounted beside thread content', () => {
    container = document.createElement('div')
    root = createRoot(container)
    act(() => root!.render(<MessengerShell><div data-testid="thread" /></MessengerShell>))

    expect(container.querySelector('[data-testid="bot-roster"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="thread"]')).not.toBeNull()
    expect(container.querySelector('main')?.classList.contains('overflow-hidden')).toBe(true)
  })
})
