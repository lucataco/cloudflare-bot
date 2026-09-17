// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import type { AgentProfile, AiChatMessage, AiChatMessageBody, AiChatMetadata, AiChatSubscriber, AiToolCall, NamedDelegationReceipt, NamedDelegationResult, Overseer, TaskRun } from '@gadgets/workshop-shared/api'
import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface, { buildChatDisplayEntries } from './ChatInterface'
import NamedDelegationCard from './components/NamedDelegationCard'
import TaskHistory from './components/TaskHistory'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
Element.prototype.scrollTo ??= () => {}
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: null }),
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('./FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
const timestamp = new Date('2026-09-08T12:00:00Z')
const model = { type: 'agent', id: 'model', name: 'Model' } as const
const agent: AgentProfile = { id: 'source-bot', workspaceId: 'source-workspace', name: 'Source bot',
  title: 'Research', description: '', defaultModelId: model.id, created: timestamp, updated: timestamp }
const api = { listGatekeeperVendors: async () => [], getAiConfig: async () => null,
  getAgentByWorkspaceId: async () => agent, getGroupByWorkspaceId: async () => null }
const receipt: NamedDelegationReceipt = { id: 'delegation-1', parentRunId: 'parent-run', parentChatId: 1,
  parentAttempt: 1, parentSequence: 2, childChatId: 8, targetAgentId: 'target-private-bot', targetName: 'Research helper' }
const run: TaskRun = { id: receipt.id, chatId: 8, sourceSequence: 0, lastSequence: 2, startedAt: timestamp,
  updatedAt: timestamp, attempt: 1, status: 'finished', reason: 'model_stop', source: { type: 'delegation', parent: {
    runId: receipt.parentRunId, chatId: 1, attempt: 1, targetAgentId: receipt.targetAgentId, targetName: receipt.targetName,
  } } }
const result: NamedDelegationResult = { receipt, run, deleted: false, canceled: false, response: 'Unverified child response.' }
const chat: AiChatMetadata = { id: 1, title: 'Research', started: timestamp, lastActive: timestamp }
const calls: AiToolCall[] = [
  { toolCallId: 'delegate', toolName: 'delegateToBot', input: { requestId: 'private-key', targetAgentId: receipt.targetAgentId,
    title: 'private title', prompt: 'private prompt', bindingNames: ['private_binding'] }, delegationId: receipt.id },
  { toolCallId: 'read-result', toolName: 'getDelegationResult', input: { id: receipt.id }, result },
]
function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp, author: model, ...body }
}
const task: AiChatMessage = { ...message(0, { type: 'message', message: 'Summarize the findings.' }), author: { type: 'user', id: 'owner', name: 'Owner' } }
const response = message(1, { type: 'message', message: 'Summary.', reasoning: 'private reasoning', toolCalls: calls })
const view = makeTestRoot()
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() })
function render(node: ReactNode) { return view.render(<RouterContextProvider router={router}>{node}</RouterContextProvider>) }
afterEach(() => { view.cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(node => (node.getAttribute('aria-label') ?? node.textContent?.trim()) === name)
  expect(found).toHaveLength(1)
  return found[0]
}
async function click(name: string) { await act(async () => button(name).click()); flushFrames() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function renderChat(messages = [task, response, message(2, { type: 'namedDelegation', delegation: receipt, result })], metadata = chat) {
  const server = makeOverseer()
  let subscriber!: AiChatSubscriber
  const getNamedDelegation = vi.fn<Overseer['getNamedDelegation']>().mockResolvedValue(result)
  const sendChatMessage = vi.fn<Overseer['sendChatMessage']>().mockResolvedValue()
  const retryAgent = vi.fn<Overseer['retryAgent']>().mockResolvedValue()
  const stopAgent = vi.fn<Overseer['stopAgent']>().mockResolvedValue()
  Object.assign(server.overseer, {
    getChatHistory: async () => ({ messages }), listChats: async () => [metadata], listModels: async () => [model],
    onRpcBroken: () => {}, getNamedDelegation, sendChatMessage, retryAgent, stopAgent,
    subscribeToChat: (next: AiChatSubscriber) => { subscriber = next; return { [Symbol.dispose]: () => {} } },
  })
  await render(<ChatInterface workspaceId={agent.workspaceId} overseer={server.overseer} selectedChatId={1}
    onNavigateToChat={() => {}} pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
    onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}} onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  flushFrames()
  return { ...server, subscriber, getNamedDelegation, sendChatMessage, retryAgent, stopAgent }
}

describe('named delegation receipts and isolated children', () => {
  it.each(calls)('redacts typed $toolName summaries and does not claim completion', call => {
    for (const count of [1, 2]) {
      const [display] = buildChatDisplayEntries([message(1, { type: 'message', message: '',
        toolCalls: Array.from({ length: count }, (_, i) => ({ ...call, toolCallId: `${i}` })),
      })], new Map())
      if (display.type !== 'workRun') throw new Error('Expected activity')
      const group = display.toolCallGroups[0]
      expect(group.detailLines).toEqual([])
      expect(group.label).not.toMatch(/private|completed|finished|Unverified child response/)
      expect(group.label).toContain(call.toolName === 'delegateToBot' ? 'Staged' : 'Read delegated task state')
    }
  })

  it('renders canonical receipt state outside collapsed activity and reconciles deleted/canceled receipts without private bot links', async () => {
    const s = await renderChat()
    const card = document.querySelector('[aria-label="Delegated task receipt"]')!
    expect(card.textContent).toContain('Research helper')
    expect(card.textContent).toContain('Execution finished (not verified task success)')
    expect(card.closest('details')).toBeNull()
    expect(document.querySelector('details')?.open).toBe(false)
    const activities = [...document.querySelectorAll('[aria-expanded]')].filter(node => node.textContent === 'View activity')
    expect(activities.length).toBeGreaterThan(0)
    expect(activities.every(node => node.getAttribute('aria-expanded') === 'false')).toBe(true)
    expect(document.body.textContent).not.toContain('private prompt')
    expect([...card.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([
      '/workspace/source-workspace?chat=1', '/workspace/source-workspace?chat=8',
    ])
    expect(s.getNamedDelegation).not.toHaveBeenCalled()
    await act(async () => s.subscriber.message(message(2, { type: 'namedDelegation', delegation: receipt,
      result: { receipt, deleted: true, canceled: true } })))
    flushFrames()
    expect(card.textContent).toContain('Deleted (canceled)')
    expect(card.textContent).not.toContain('Execution finished')
    expect([...card.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['/workspace/source-workspace?chat=1'])
    expect([...card.querySelectorAll('button')].map(node => node.textContent)).toEqual(['Refresh status'])
    expect(document.querySelector('a[href*="target-private-bot"]')).toBeNull()
  })

  it.each(['admitted', 'running', 'waiting', 'canceled', 'failed', 'incomplete'] as const)('shows canonical %s state, not tool output completion', async status => {
    await render(<NamedDelegationCard delegation={receipt} result={{ ...result, run: { ...run, status } as TaskRun }}
      overseer={{ getNamedDelegation: vi.fn<Overseer['getNamedDelegation']>() }} workspaceId="source-workspace" />)
    expect(document.querySelector('[role="status"]')?.textContent?.toLowerCase()).toBe(status)
  })

  it('keeps absence/errors honest and invalidates old refreshes when canonical state or workspace changes', async () => {
    const pending = deferred<NamedDelegationResult>()
    const getNamedDelegation = vi.fn<Overseer['getNamedDelegation']>().mockReturnValue(pending.promise)
    const overseer = { getNamedDelegation }
    const card = (current?: NamedDelegationResult, workspaceId = 'source-workspace') => render(
      <NamedDelegationCard delegation={receipt} result={current} overseer={overseer} workspaceId={workspaceId} />)
    await card()
    expect(document.body.textContent).toContain('Current state unavailable')
    await click('Refresh status')
    expect(getNamedDelegation).toHaveBeenCalledExactlyOnceWith(receipt.id)
    await card({ receipt, canceled: true, deleted: true })
    await act(async () => pending.resolve(result))
    expect(document.body.textContent).toContain('Deleted (canceled)')
    const next = deferred<NamedDelegationResult>()
    getNamedDelegation.mockReturnValue(next.promise)
    await click('Refresh status')
    await card(undefined, 'other-workspace')
    await act(async () => next.resolve(result))
    expect(document.body.textContent).not.toContain('Unverified child response.')
    getNamedDelegation.mockRejectedValue(new Error('Offline'))
    await click('Refresh status')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh child state')
    expect(document.body.textContent).toContain('Current state unavailable')
  })

  it.each([false, true])('disables child follow-ups and hides Repeat/retry for active=%s; Stop still works', async active => {
    const s = await renderChat([task, response], { ...chat, namedDelegation: receipt, ...(active ? { activeAgent: model } : {}) })
    const textarea = document.querySelector('textarea')!
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Send follow-up instructions in parent conversation')
    expect(document.body.textContent).not.toContain('Repeat this')
    expect(button('Send message').disabled).toBe(true)
    const parent = [...document.querySelectorAll('a')].find(link => link.textContent === 'Parent conversation')!
    expect(parent.getAttribute('href')).toBe('/workspace/source-workspace?chat=1')
    if (active) {
      await click('Stop agent')
    }
    expect(s.stopAgent.mock.calls).toEqual(active ? [[1]] : [])
    await act(async () => {
      s.subscriber.metadata({ ...chat, namedDelegation: receipt })
      s.subscriber.message(message(3, { type: 'error', message: 'Execution failed.' }))
    })
    flushFrames()
    expect([...document.querySelectorAll('button')].some(node => /^(Retry|Continue|Resend)$/.test(node.textContent?.trim() ?? ''))).toBe(false)
    expect(s.sendChatMessage).not.toHaveBeenCalled()
    expect(s.retryAgent).not.toHaveBeenCalled()
  })

  it('keeps canonical pending action approval available in an isolated child', async () => {
    const s = await renderChat([task, message(1, { type: 'action', actionId: 7, actionLog: entry(7) })], { ...chat, namedDelegation: receipt })
    expect(document.querySelector('textarea')!.disabled).toBe(true)
    expect(button('Allow once').disabled).toBe(false)
    expect(button('Deny').disabled).toBe(false)
    expect(s.sendChatMessage).not.toHaveBeenCalled()
  })

  it.each(calls)('uses privacy-safe provisional $toolName labels', async call => {
    const s = await renderChat([task], { ...chat, activeAgent: model })
    await act(async () => {
      s.subscriber.stream(1, { type: 'toolCallStarted', toolCallId: call.toolCallId, toolName: call.toolName })
    })
    flushFrames()
    const activity = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('View activity'))!
    await act(async () => activity.click())
    expect(document.body.textContent).toContain(call.toolName === 'delegateToBot' ? 'Staging a delegated task' : 'Reading delegated task state')
    expect(document.body.textContent).not.toContain('private prompt')
  })

  it('puts parent task/target navigation in RunRow, leaving delegation evidence inert', async () => {
    const s = makeOverseer()
    Object.assign(s.overseer, {
      listTaskRuns: async () => ({ runs: [run] }),
      getTaskRunEvidence: async () => ({ entries: [{ message: message(2, { type: 'namedDelegation', delegation: receipt,
        result: { ...result, response: '[private](https://example.com) <img src="https://example.com/pixel">' } }) }] }),
    })
    await render(<TaskHistory overseer={s.overseer} workspaceId="source-workspace" chatId={8} />)
    await click('Task history')
    expect(document.body.textContent).toContain('Delegated to Research helper. Parent task parent-run, attempt 1.')
    expect([...document.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual([
      '/workspace/source-workspace?chat=1', '/workspace/source-workspace?chat=8',
    ])
    const disclosure = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('#0'))!
    await act(async () => disclosure.click())
    const evidence = document.querySelector('[aria-label="Evidence for task 0"]')!
    expect(evidence.textContent).toContain('Execution finished (not verified task success)')
    expect(evidence.querySelector('a, img, button, input')).toBeNull()
    expect(evidence.textContent).toContain('[private](https://example.com)')
  })
})
