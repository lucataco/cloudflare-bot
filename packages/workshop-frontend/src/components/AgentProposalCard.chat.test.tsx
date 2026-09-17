// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AgentProposal, AiChatMessage, AiChatMessageBody, AiChatSubscriber, AiToolCall, AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import { flushFrames, makeOverseer, makeTestRoot } from '../action-test-harness'
import ChatInterface, { buildChatDisplayEntries, getRepeatableTask } from '../ChatInterface'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
Element.prototype.scrollTo ??= () => {}
const api = vi.hoisted(() => ({
  listGatekeeperVendors: async () => [], getAiConfig: async () => null,
  getAgentByWorkspaceId: vi.fn<() => Promise<AgentProfile>>(), getGroupByWorkspaceId: async () => null,
  createRoutine: vi.fn<AuthenticatedApi['createRoutine']>(), createSkill: vi.fn<AuthenticatedApi['createSkill']>(),
}))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: null }),
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))
vi.mock('@cloudflare/kumo', async importOriginal => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})

const view = makeTestRoot()
const timestamp = new Date('2026-09-08T12:00:00Z')
const model = { type: 'agent', id: 'model', name: 'Model' } as const
const agent: AgentProfile = {
  id: 'bot', name: 'Riley', title: 'Research', description: '', defaultModelId: model.id,
  workspaceId: 'workspace', created: timestamp, updated: timestamp,
}
const proposal: AgentProposal = {
  type: 'agentProposal', proposalId: 'proposal', agentId: agent.id, agentName: agent.name, artifactId: 'routine',
  state: 'pending', reason: 'A bot-authored reason.', draft: { kind: 'routine', value: {
    name: 'Weekly notes', prompt: 'private proposed prompt', schedule: { kind: 'interval', everyMs: 60000 },
  } },
}
function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp, author: model, ...body }
}
const task: AiChatMessage = {
  ...message(0, { type: 'message', message: 'Summarize my notes.' }), author: { type: 'user', id: 'owner', name: 'Owner' },
}
const calls: AiToolCall[] = [
  { toolCallId: 'routine-call', toolName: 'proposeRoutine', input: {
    name: 'private name', reason: 'private reason', prompt: 'private prompt', schedule: { kind: 'interval', everyMs: 60000 },
  } },
  { toolCallId: 'skill-call', toolName: 'proposeSkill', input: {
    name: 'private name', reason: 'private reason', description: 'private description', body: 'private body',
  } },
]
const response = message(1, { type: 'message', message: 'Summary complete.', reasoning: 'private reasoning', toolCalls: [calls[0]] })
const followup = message(3, { type: 'message', message: '', toolCalls: [calls[1]] })
function control(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) {
  await act(async () => control(label).click())
  flushFrames()
}
async function renderChat(current = proposal, props: Partial<ComponentProps<typeof ChatInterface>> = {}) {
  api.getAgentByWorkspaceId.mockResolvedValue(agent)
  const server = makeOverseer()
  let subscriber!: AiChatSubscriber
  const accept = vi.fn<Overseer['acceptAgentProposal']>().mockResolvedValue({
    ...current, state: 'accepted', decidedAt: timestamp, receipt: { createdAt: timestamp, missing: false },
  })
  const deny = vi.fn<Overseer['denyAgentProposal']>().mockResolvedValue({ ...current, state: 'denied', decidedAt: timestamp })
  const send = vi.fn<Overseer['sendChatMessage']>().mockResolvedValue()
  Object.assign(server.overseer, {
    getChatHistory: async () => ({ messages: [task, response, message(2, current), followup] }),
    listChats: async () => [{ id: 1, title: 'Thread', started: timestamp, lastActive: timestamp }],
    listModels: async () => [model], onRpcBroken: () => {}, sendChatMessage: send,
    acceptAgentProposal: accept, denyAgentProposal: deny,
    subscribeToChat: (next: AiChatSubscriber) => { subscriber = next; return { [Symbol.dispose]: () => {} } },
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
  return { accept, deny, send, subscriber }
}
afterEach(() => { view.cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('proposal transcript integration', () => {
  it.each(['pending', 'accepting', 'accepted', 'denied'] as const)('keeps a %s proposal outside work groups and suppresses Repeat only while unresolved', state => {
    const current: AgentProposal = { ...proposal, state, decidedAt: timestamp, receipt: { createdAt: timestamp, missing: false } }
    const messages = [task, response, message(2, current), followup]
    const entries = buildChatDisplayEntries(messages, new Map())
    expect(entries.map(entry => entry.type)).toEqual(['message', 'message', 'message', 'workRun'])
    expect(entries[2]).toMatchObject({ type: 'message', message: current })
    if (entries[1].type !== 'message') throw new Error('Expected assistant row')
    expect(entries[1].toolCalls).toHaveLength(1)
    expect(entries[1].lastMessageSequence).toBe(1)
    expect(getRepeatableTask(messages)).toEqual(state === 'pending' || state === 'accepting'
      ? null : { prompt: 'Summarize my notes.', sequence: 1 })
  })

  it.each(calls)('uses bounded $toolName summaries without raw proposal inputs', call => {
    for (const count of [1, 2]) {
      const [entry] = buildChatDisplayEntries([message(1, {
        type: 'message', message: '', toolCalls: Array.from({ length: count }, (_, index) => ({ ...call, toolCallId: `${index}` })),
      })], new Map())
      if (entry.type !== 'workRun') throw new Error('Expected work row')
      const group = entry.toolCallGroups[0]
      expect(group.label).toBe(call.toolName === 'proposeRoutine'
        ? count === 1 ? 'Proposed a routine' : 'Proposed 2 routines'
        : count === 1 ? 'Proposed reusable instructions' : 'Proposed reusable instructions 2 times')
      expect(group.detailLines).toEqual([])
      expect(group.label).not.toContain('private')
    }
  })

  it.each(['pending', 'accepting'] as const)('shows %s review independently of collapsed thinking/activity and leaves continuation enabled', async state => {
    const current: AgentProposal = { ...proposal, state, decidedAt: timestamp }
    const server = await renderChat(current, { canDecideProposals: true })
    const review = control('Review')
    expect(review.closest('details')).toBeNull()
    expect(document.querySelector('details')?.open).toBe(false)
    expect(document.body.textContent).not.toContain('private proposed prompt')
    expect(document.body.textContent).not.toContain('private reasoning')
    expect(document.body.textContent).not.toContain('Repeat this')
    const activities = [...document.querySelectorAll('[aria-expanded]')].filter(element => element.textContent === 'View activity')
    expect(activities.length).toBeGreaterThan(0)
    expect(activities.every(element => element.getAttribute('aria-expanded') === 'false')).toBe(true)
    await click('Review')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('private proposed prompt')
    expect(server.accept).not.toHaveBeenCalled()
    expect(server.deny).not.toHaveBeenCalled()
    await click(state === 'pending' ? 'Cancel' : 'Close')
    const textarea = document.querySelector('textarea')!
    expect(textarea.disabled).toBe(false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Continue with the next task.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Send message')
    expect(server.send).toHaveBeenCalledTimes(1)
    expect(api.createRoutine).not.toHaveBeenCalled()
    expect(api.createSkill).not.toHaveBeenCalled()
  })

  it('defaults ChatInterface to read-only proposal decisions without hiding the review', async () => {
    const server = await renderChat()
    expect(document.body.textContent).toContain('Only the workspace owner')
    await click('Review')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Save paused routine')
    await click('Cancel')
    expect(server.accept).not.toHaveBeenCalled()
    expect(server.deny).not.toHaveBeenCalled()
  })

  it('saves through the Overseer only and reconciles the chat subscriber without enabling or resuming', async () => {
    const server = await renderChat(proposal, { canDecideProposals: true, automationPaused: true })
    await click('Review')
    await click('Save paused routine')
    expect(server.accept).toHaveBeenCalledExactlyOnceWith(proposal.proposalId)
    expect(document.body.textContent).toContain('Saved paused at')
    await act(async () => server.subscriber.message(message(2, {
      ...proposal, state: 'accepted', decidedAt: timestamp, receipt: { createdAt: timestamp, missing: true },
    })))
    flushFrames()
    expect(document.body.textContent).toContain('Already deleted; it was not recreated')
    expect(document.querySelector('textarea')!.disabled).toBe(true)
    expect(document.querySelector('textarea')!.placeholder).toContain('Automation is paused')
    expect(server.send).not.toHaveBeenCalled()
    expect(api.createRoutine).not.toHaveBeenCalled()
    expect(api.createSkill).not.toHaveBeenCalled()
  })
})
