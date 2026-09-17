// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMetadata, AiChatSubscriber, Overseer } from '@gadgets/workshop-shared/api'
import { makeOverseer, makeTestRoot, flushFrames } from './action-test-harness'
import ChatInterface from './ChatInterface'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
Element.prototype.scrollTo ??= () => {}
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
vi.mock('./AuthContext', () => {
  const context = {
    currentUser: null,
    authenticatedApi: {
      listGatekeeperVendors: async () => [], getAiConfig: async () => null,
      getAgentByWorkspaceId: async () => null, getGroupByWorkspaceId: async () => null,
    },
  }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('./FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))

const view = makeTestRoot()
afterEach(() => { view.cleanup(); vi.restoreAllMocks() })

describe('ChatInterface task history wiring', () => {
  it.each([
    { name: 'classic chat', threadChrome: false, sidebarMode: false },
    { name: 'bot thread', threadChrome: true, sidebarMode: false },
    { name: 'sidebar chat', threadChrome: false, sidebarMode: true },
  ])('is lazy in $name and refreshes from live metadata only while open', async ({ name: _name, ...props }) => {
    const server = makeOverseer()
    const timestamp = new Date('2026-09-08T12:00:00Z')
    const metadata: AiChatMetadata = { id: 1, title: 'Research', started: timestamp, lastActive: timestamp }
    let subscriber!: AiChatSubscriber
    const listTaskRuns = vi.fn<Overseer['listTaskRuns']>().mockResolvedValue({ runs: [] })
    Object.assign(server.overseer, {
      getChatHistory: async () => ({ messages: [] }), listChats: async () => [metadata], listModels: async () => [],
      subscribeToChat: (next: AiChatSubscriber) => { subscriber = next; return { [Symbol.dispose]: () => {} } },
      onRpcBroken: () => {}, listTaskRuns,
    })
    await view.render(<ChatInterface
      workspaceId="workspace" overseer={server.overseer} selectedChatId={1} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} {...props}
    />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    flushFrames()
    const toggle = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === 'Task history')!
    expect(toggle).toBeDefined()
    expect(listTaskRuns).not.toHaveBeenCalled()
    await act(async () => toggle.click())
    expect(listTaskRuns).toHaveBeenCalledExactlyOnceWith(1, undefined)
    const admitted = { ...metadata, currentRunId: 'run-1' }
    await act(async () => subscriber.metadata(admitted))
    flushFrames()
    expect(listTaskRuns).toHaveBeenCalledTimes(2)
    const stopped = { ...admitted, lastActive: new Date(timestamp.getTime() + 1000) }
    await act(async () => subscriber.metadata(stopped))
    flushFrames()
    expect(listTaskRuns).toHaveBeenCalledTimes(3)
    await act(async () => toggle.click())
    await act(async () => subscriber.metadata({ ...stopped, lastActive: new Date(timestamp.getTime() + 2000) }))
    flushFrames()
    expect(listTaskRuns).toHaveBeenCalledTimes(3)
    expect(document.querySelector('textarea')).not.toBeNull()
  })
})
