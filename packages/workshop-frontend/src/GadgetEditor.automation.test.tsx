// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetMetadata, Overseer, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { makeOverseer, makeTestRoot, flushFrames } from './action-test-harness'
import GadgetEditor from './GadgetEditor'
import type ChatInterface from './ChatInterface'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({}), useSearch: () => ({ chat: 0 }), useNavigate: () => () => {},
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
vi.mock('./AuthContext', () => {
  const authenticatedApi = { whoami: async () => null }
  return { useAuthenticatedApi: () => ({ authenticatedApi }) }
})
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false }))
let overseer: { stub: RpcStub<Overseer> }
let metadata: GadgetMetadata
vi.mock('./useWorkspaceOpen', () => ({
  useWorkspaceOpen: () => ({ overseer, metadata, error: null, connectionLost: false }),
}))
vi.mock('./ChatInterface', () => ({
  default: ({ automationPaused, onChatCountChange }: ComponentProps<typeof ChatInterface>) => {
    useEffect(() => { onChatCountChange?.(1, true) }, [onChatCountChange])
    return <section aria-label="Chat content" data-paused={automationPaused === true} />
  },
}))
vi.mock('./GadgetCodeInterface', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./GadgetUseView', () => ({ default: () => <section aria-label="Use-only view" /> }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))

const view = makeTestRoot()
const agent = {
  id: 'bot', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'workspace', defaultModelId: null, created: new Date(), updated: new Date(),
}
let server: ReturnType<typeof makeOverseer>
const setAutomationPaused = vi.fn<Overseer['setAutomationPaused']>(async () => {})
beforeEach(() => {
  window.localStorage.clear()
  metadata = { id: 'workspace', title: 'Workspace', role: 'build' }
  server = makeOverseer()
  Object.assign(server.overseer, {
    subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
      subscriber.ready()
      return { [Symbol.dispose]: () => {} }
    },
    subscribeToConsoleLogs: async () => ({ [Symbol.dispose]: () => {} }),
    listHooks: async () => [], setAutomationPaused,
  })
  overseer = { stub: server.overseer }
})
afterEach(() => { view.cleanup(); vi.clearAllMocks() })

function render(messenger = true) {
  return view.render(<GadgetEditor workspaceId="workspace" messenger={messenger ? { agent } : undefined} />)
}
async function mount(messenger = true) {
  await render(messenger)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  flushFrames()
}
function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) { await act(async () => button(label).click()) }

describe('editor automation integration', () => {
  it.each([true, false])('connects header pause and a persistent banner with confirmed resume to metadata (messenger=%s)', async messenger => {
    await mount(messenger)
    await click('Pause automation')
    expect(setAutomationPaused).toHaveBeenCalledExactlyOnceWith(true)
    expect(document.querySelector('[aria-label="Chat content"]')?.getAttribute('data-paused')).toBe('false')
    metadata = { ...metadata, automationPaused: true }
    await render(messenger)
    const banner = [...document.querySelectorAll('[role="status"]')].find(node => node.textContent?.includes('Automation paused'))!
    expect(banner).toBeDefined()
    expect(banner.textContent).toContain('In-flight external calls may finish')
    expect(banner.contains(button('Resume automation...'))).toBe(true)
    expect(document.querySelector('[aria-label="Chat content"]')?.getAttribute('data-paused')).toBe('true')
    await click('Resume automation...')
    await click('Cancel')
    expect(setAutomationPaused).toHaveBeenCalledOnce()
    await click('Resume automation...')
    await click('Resume automation')
    expect(setAutomationPaused).toHaveBeenLastCalledWith(false)
    expect(banner.isConnected).toBe(true)
    metadata = { ...metadata, automationPaused: false }
    await render(messenger)
    expect(banner.isConnected).toBe(false)
    expect(document.querySelector('[aria-label="Chat content"]')?.getAttribute('data-paused')).toBe('false')
  })

  it('shows a build collaborator the live paused banner and blocked composer but no pause or resume authority', async () => {
    metadata = { ...metadata, owner: { id: 'owner', name: 'Owner', type: 'user' } }
    await mount()
    expect(document.body.textContent).not.toContain('Pause automation')
    metadata = { ...metadata, automationPaused: true }
    await render()
    expect(document.body.textContent).toContain('Automation paused')
    expect(document.querySelector('[aria-label="Chat content"]')?.getAttribute('data-paused')).toBe('true')
    expect(document.body.textContent).not.toContain('Resume automation')
    expect(setAutomationPaused).not.toHaveBeenCalled()
  })

  it('does not give a use-only viewer controls even if owner metadata is absent', async () => {
    metadata = { ...metadata, role: 'use', automationPaused: true }
    await render()
    expect(document.querySelector('[aria-label="Use-only view"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Resume automation')
    expect(setAutomationPaused).not.toHaveBeenCalled()
  })
})
