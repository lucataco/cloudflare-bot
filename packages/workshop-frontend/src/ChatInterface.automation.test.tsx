// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'
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

describe('automation pause composer gating', () => {
  it.each([
    { name: 'existing conversation', selectedChatId: 1 },
    { name: 'new messenger conversation', selectedChatId: null, threadChrome: true },
    { name: 'new classic conversation', selectedChatId: null },
    { name: 'sidebar and selected conversation', selectedChatId: 1, sidebarMode: true },
  ])('blocks $name without losing any draft and restores it on resume', async ({ name: _name, ...props }) => {
    const server = makeOverseer()
    const model: AiChatAuthorInfo = { type: 'agent', id: 'model', name: 'Model' }
    const metadata: AiChatMetadata = { id: 1, title: 'Thread', started: new Date(), lastActive: new Date() }
    const sendChatMessage = vi.fn<Overseer['sendChatMessage']>(async () => {})
    const newChat = vi.fn<Overseer['newChat']>(async () => 2)
    Object.assign(server.overseer, {
      getChatHistory: async () => ({ messages: [] }),
      listChats: async () => [metadata], listModels: async () => [model],
      subscribeToChat: () => ({ [Symbol.dispose]: () => {} }), onRpcBroken: () => {},
      sendChatMessage, newChat,
    })
    const render = (automationPaused: boolean) => view.render(<ChatInterface
      workspaceId="workspace" overseer={server.overseer} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined}
      automationPaused={automationPaused} {...props}
    />)
    await render(false)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    flushFrames()
    const inputs = [...document.querySelectorAll('textarea')]
    expect(inputs.length).toBeGreaterThan(0)
    for (const [index, input] of inputs.entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, `Draft ${index}`)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await render(true)
    for (const [index, input] of inputs.entries()) {
      expect(input.isConnected).toBe(true)
      expect(input.value).toBe(`Draft ${index}`)
      expect(input.disabled).toBe(true)
      expect(input.placeholder).toContain('Automation is paused')
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[aria-label="Send message"]')) {
      expect(button.disabled).toBe(true)
      await act(async () => button.click())
    }
    expect(sendChatMessage).not.toHaveBeenCalled()
    expect(newChat).not.toHaveBeenCalled()
    await render(false)
    for (const [index, input] of inputs.entries()) {
      expect(input.isConnected).toBe(true)
      expect(input.disabled).toBe(false)
      expect(input.value).toBe(`Draft ${index}`)
    }
  })
})
