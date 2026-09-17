// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, AiChatMetadata, AuthenticatedApi, GadgetMetadataWithTimestamps, OutputSummary } from '@gadgets/workshop-shared/api'
import { entry, makeTestRoot } from './action-test-harness'
import { botInboxText, botInboxTime, summarizeBotInbox, useBotInboxSummaries, usePublishBotInboxSummary } from './botInboxSummary'

const connection = vi.hoisted(() => ({ lost: false }))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => connection.lost }))

const view = makeTestRoot()
const publisher = makeTestRoot()
const author = { type: 'agent', id: 'model', name: 'Bot' } as const
const date = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, minutes))
const chat = (over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id: 1, title: 'Thread', started: date(0), lastActive: date(1), ...over,
})
const reply = (text: string, minutes = 1): AiChatMessage => ({
  type: 'message', message: text, author, chatId: 1, sequence: minutes, timestamp: date(minutes),
})
const workspace = (id: string): GadgetMetadataWithTimestamps => ({
  id, title: 'Workspace', created: date(0), lastActive: date(30),
})
const output = (title: string, minutes: number): OutputSummary => ({
  workspaceId: 'workspace', workpieceId: minutes, title, workspaceTitle: 'Workspace',
  created: date(minutes), lastActive: date(30),
})
function makeApi(workspaces = [workspace('workspace')], outputs: OutputSummary[] = []) {
  return {
    listGadgets: vi.fn<AuthenticatedApi['listGadgets']>().mockResolvedValue(workspaces),
    listOutputs: vi.fn<AuthenticatedApi['listOutputs']>().mockResolvedValue({ outputs, catchingUp: false }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type Api = ReturnType<typeof makeApi>
let snapshot: ReturnType<typeof useBotInboxSummaries>
function Probe({ api }: { api: Api | null }) {
  snapshot = useBotInboxSummaries(api)
  return <>{[...snapshot.summaries].map(([id, summary]) => <p key={id}>{botInboxText(summary)}</p>)}</>
}
const source = {}
function Publish({ api, chats, messages, ready = true, workspaceId = 'workspace', session = source }: {
  api: Api | null
  chats: AiChatMetadata[]
  messages: Map<number, AiChatMessage[]>
  ready?: boolean
  workspaceId?: string
  session?: object
}) {
  usePublishBotInboxSummary(api, workspaceId, session, chats, messages, ready, 0)
  return null
}

afterEach(() => {
  publisher.cleanup()
  view.cleanup()
  connection.lost = false
})

describe('bot inbox summaries', () => {
  it('prioritizes approval, working, proposed changes, then actual durable replies', () => {
    const pending: AiChatMessage = {
      type: 'connectionRequest', requestId: 'request', vendorId: 'vendor', vendorName: 'Vendor',
      reason: 'Private request detail', state: 'pending', author, chatId: 1, sequence: 2, timestamp: date(2),
    }
    const messages = new Map([[1, [reply('A durable reply'), pending]]])
    expect(summarizeBotInbox([chat({ activeAgent: author, hasProposedChanges: true })], messages)?.text).toBe('Needs approval')
    pending.state = 'accepted'
    expect(summarizeBotInbox([chat({ activeAgent: author, hasProposedChanges: true })], messages)?.text).toBe('Working')
    expect(summarizeBotInbox([chat({ hasProposedChanges: true })], messages)?.text).toBe('Changes to review')
    expect(summarizeBotInbox([chat()], messages)).toMatchObject({ kind: 'reply', text: 'A durable reply', timestamp: date(1).getTime() })
  })

  it('ignores prompts, reasoning-only/tool-only messages, sparse slots and other chats', () => {
    const messages = new Map([[1, [
      reply('  Actual\n reply  '), undefined,
      { ...reply('User prompt', 2), author: { ...author, type: 'user' as const } },
      { ...reply('', 3), reasoning: 'Private reasoning' },
      { ...reply('Generated skill prompt', 4), generatedBySlashCommandSequence: 1 },
      { ...reply('Different chat', 5), chatId: 2 },
    ]]])
    expect(summarizeBotInbox([chat()], messages)?.text).toBe('Actual reply')
    expect(summarizeBotInbox([chat()], new Map([[1, [reply('x'.repeat(1000))]]]))?.text).toHaveLength(180)
  })

  it.each(['pending', 'accepting', 'accepted', 'denied'] as const)('recognizes %s proposals without summarizing their instructions or reason', (state) => {
    const proposal: AiChatMessage = {
      type: 'agentProposal', proposalId: 'proposal', agentId: 'bot', agentName: 'Bot', artifactId: 'skill',
      reason: 'Private rationale', draft: { kind: 'skill', value: {
        name: 'Private name', description: 'Private usage', body: 'Private instructions',
      } },
      chatId: 1, sequence: 2, timestamp: date(2), author,
      state, decidedAt: date(2), receipt: { createdAt: date(2), missing: false },
    }
    const summary = summarizeBotInbox([chat({ activeAgent: author })], new Map([[1, [reply('Reply'), proposal]]]))!
    expect(summary.text).toBe(state === 'pending' || state === 'accepting' ? 'Needs approval' : 'Working')
    expect(JSON.stringify(summary)).not.toContain('Private')
  })

  it('counts real pending actions and human takeover, not the meaningless state on hook entries', () => {
    const action: AiChatMessage = {
      type: 'action', actionId: 1, actionLog: entry(1), author, chatId: 1, sequence: 1, timestamp: date(1),
    }
    const takeover: AiChatMessage = {
      type: 'computerHumanTakeover', requestId: 'takeover', reason: 'Sign in', currentUrl: 'https://example.com',
      state: 'pending', author, chatId: 1, sequence: 2, timestamp: date(2),
    }
    const hook: AiChatMessage = {
      ...action, actionLog: {
        ...entry(2), type: 'bindHook', enabled: false, description: { title: 'Hook', description: '' },
      },
    }
    for (const message of [action, takeover]) {
      expect(summarizeBotInbox([chat()], new Map([[1, [message]]]))?.text).toBe('Needs approval')
    }
    action.actionLog!.state = 'approved'
    takeover.state = 'approved'
    expect(summarizeBotInbox([chat()], new Map([[1, [action, takeover, hook]]]))?.text).toBe('Chat: Thread')
  })

  it('considers other loaded chats in this workspace without borrowing another workspace', () => {
    const messages = new Map([[1, [reply('Earlier reply')]], [2, [{ ...reply('Latest reply', 4), chatId: 2 }]]])
    expect(summarizeBotInbox([chat(), chat({ id: 2 })], messages)?.text).toBe('Latest reply')
    expect(summarizeBotInbox([chat({ id: 3, hasProposedChanges: true })], messages)?.text).toBe('Changes to review')
    expect(summarizeBotInbox([], messages)).toBeUndefined()
  })

  it('uses the latest conversation title when no reply is loaded, without inventing a completion state', () => {
    const summary = summarizeBotInbox([
      chat({ title: 'Older conversation', lastActive: date(1) }),
      chat({ id: 2, title: '  Done: 3 unread messages\nreview  ', lastActive: date(5) }),
    ], new Map())
    expect(summary).toMatchObject({ kind: 'activity', text: 'Chat: Done: 3 unread messages review', timestamp: date(5).getTime() })
    expect(summarizeBotInbox([chat({ title: '  ' })], new Map())?.text).toBe('Workspace activity')
  })

  it('adds known conversation context without rewriting boilerplate or burying approval status', () => {
    const summary = summarizeBotInbox([chat({ title: 'Compare laptop models' })], new Map([[1, [reply('Based on current information, here is the comparison.')]]]))!
    expect(summary.context).toBe('Compare laptop models')
    expect(botInboxText(summary)).toBe('Compare laptop models: Based on current information, here is the comparison.')
    expect(botInboxText({ ...summary, live: false })).toBe('Last seen: Compare laptop models: Based on current information, here is the comparison.')
    expect(botInboxText({ ...summary, kind: 'status', text: 'Needs approval' })).toBe('Needs approval: Compare laptop models')
  })

  it('omits the server placeholder title but does not filter authored reply text', () => {
    const summary = summarizeBotInbox([chat({ title: 'New Chat' })], new Map([[1, [reply('New Chat: the actual reply.')]]]))!
    expect(summary.context).toBeUndefined()
    expect(botInboxText(summary)).toBe('New Chat: the actual reply.')
  })

  it('retains the title belonging to the selected reply or status across multiple chats', () => {
    const chats = [chat({ title: 'First task' }), chat({ id: 2, title: 'Second task' })]
    const messages = new Map([[1, [reply('First answer')]], [2, [{ ...reply('Second answer', 2), chatId: 2 }]]])
    expect(summarizeBotInbox(chats, messages)).toMatchObject({ text: 'Second answer', context: 'Second task' })
    expect(summarizeBotInbox([{ ...chats[0], activeAgent: author }, chats[1]], messages))
      .toMatchObject({ text: 'Working', context: 'First task' })
  })

  it('publishes title-only changes without another RPC and preserves that context when stale', async () => {
    const api = makeApi()
    const messages = new Map([[1, [reply('The same reply')]]])
    await view.render(<Probe api={api} />)
    await publisher.render(<Publish api={api} chats={[chat({ title: 'First title' })]} messages={messages} />)
    expect(document.body.textContent).toContain('First title: The same reply')
    await publisher.render(<Publish api={api} chats={[chat({ title: 'Renamed task' })]} messages={messages} />)
    expect(document.body.textContent).toContain('Renamed task: The same reply')
    expect(document.body.textContent).not.toContain('First title')
    publisher.unmount()
    expect(document.body.textContent).toContain('Last seen: Renamed task: The same reply')
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
  })

  it('retains an indexed workspace title when the loaded conversation has no title', async () => {
    const api = makeApi([{ ...workspace('workspace'), title: 'Project notes' }])
    await view.render(<Probe api={api} />)
    expect(document.body.textContent).toContain('Last seen: Workspace: Project notes')
    await publisher.render(<Publish api={api} chats={[chat({ title: '' })]} messages={new Map()} />)
    expect(snapshot.summaries.get('workspace')).toMatchObject({ text: 'Workspace: Project notes', timestamp: date(1).getTime(), live: true })
    const unnamed = makeApi([{ ...workspace('workspace'), title: ' ' }])
    await view.render(<Probe api={unnamed} />)
    expect(document.body.textContent).toContain('Last seen: Workspace activity')
  })

  it('shares one bulk snapshot, selects results by creation not workspace activity, and never sweeps/polls', async () => {
    const api = makeApi([workspace('workspace')], [output('Newest result', 8), output('Older result', 2)])
    api.listOutputs.mockResolvedValue({ outputs: [output('Newest result', 8), output('Older result', 2)], catchingUp: true })
    await view.render(<StrictMode><Probe api={api} /><Probe api={api} /></StrictMode>)
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
    expect(snapshot.summaries.get('workspace')).toEqual({
      kind: 'result', text: 'Result: Newest result', timestamp: date(8).getTime(), live: false,
    })
    expect(document.body.textContent).toContain('Last seen: Result: Newest result')
    view.unmount()
    await view.render(<Probe api={api} />)
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
  })

  it('publishes without RPC and marks cached status on unmount, disconnect, and reconnect until metadata refreshes', async () => {
    const api = makeApi()
    const chats = [chat({ activeAgent: author })]
    const messages = new Map([[1, [reply('Done')]]])
    const renderPublisher = (session = source) => publisher.render(<Publish api={api} chats={chats} messages={messages} session={session} />)
    await renderPublisher()
    expect(api.listGadgets).not.toHaveBeenCalled()
    expect(api.listOutputs).not.toHaveBeenCalled()
    await view.render(<Probe api={api} />)
    expect(snapshot.summaries.get('workspace')?.live).toBe(true)
    connection.lost = true
    await renderPublisher()
    expect(document.body.textContent).toContain('Last seen: Working')
    connection.lost = false
    await renderPublisher()
    expect(snapshot.summaries.get('workspace')?.live).toBe(false)
    const reconnected = {}
    await renderPublisher(reconnected)
    expect(snapshot.summaries.get('workspace')?.live).toBe(false)
    await publisher.render(<Publish api={api} chats={[...chats]} messages={messages} session={reconnected} />)
    expect(snapshot.summaries.get('workspace')?.live).toBe(true)
    publisher.unmount()
    expect(document.body.textContent).toContain('Last seen: Working')
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
  })

  it('does not let a delayed bulk snapshot overwrite open-workspace signals; newer results beat older replies', async () => {
    const api = makeApi()
    const bulk = deferred<GadgetMetadataWithTimestamps[]>()
    api.listGadgets.mockReturnValue(bulk.promise)
    api.listOutputs.mockResolvedValue({ outputs: [output('Recent result', 10)], catchingUp: false })
    await view.render(<Probe api={api} />)
    expect(snapshot.status).toBe('loading')
    const messages = new Map([[1, [reply('Old reply', 1)]]])
    await publisher.render(<Publish api={api} chats={[chat({ hasProposedChanges: true })]} messages={messages} />)
    await act(async () => bulk.resolve([workspace('workspace')]))
    expect(snapshot.summaries.get('workspace')?.text).toBe('Changes to review')
    await publisher.render(<Publish api={api} chats={[chat()]} messages={messages} />)
    expect(snapshot.summaries.get('workspace')?.text).toBe('Result: Recent result')
    await publisher.render(<Publish api={api} chats={[chat()]} messages={new Map([[1, [reply('Newest reply', 20)]]])} />)
    expect(snapshot.summaries.get('workspace')?.text).toBe('Newest reply')
  })

  it('isolates auth scopes and rejects a mounted chat cache crossing an auth boundary', async () => {
    const first = makeApi()
    const second = makeApi()
    const messages = new Map([[1, [reply('Account one private reply')]]])
    await publisher.render(<Publish api={first} chats={[chat()]} messages={messages} />)
    await view.render(<Probe api={first} />)
    expect(document.body.textContent).toContain('Account one private reply')
    await publisher.render(<Publish api={second} chats={[chat()]} messages={messages} />)
    await view.render(<Probe api={second} />)
    expect(document.body.textContent).not.toContain('Account one private reply')
    await view.render(<Probe api={null} />)
    expect(snapshot.summaries.size).toBe(0)
    await publisher.render(<Publish api={null} chats={[chat()]} messages={messages} />)
    expect(second.listGadgets).toHaveBeenCalledTimes(1)
  })

  it('ignores late results from a previous account, handles failures, and preserves partial indexed facts', async () => {
    const first = makeApi()
    const delayed = deferred<Awaited<ReturnType<AuthenticatedApi['listOutputs']>>>()
    first.listOutputs.mockReturnValue(delayed.promise)
    await view.render(<Probe api={first} />)
    const second = makeApi()
    second.listGadgets.mockRejectedValue(new Error('offline'))
    second.listOutputs.mockRejectedValue(new Error('offline'))
    await view.render(<Probe api={second} />)
    await act(async () => delayed.resolve({ outputs: [output('Private result', 8)], catchingUp: false }))
    expect(snapshot.status).toBe('error')
    expect(snapshot.summaries.size).toBe(0)
    const partial = makeApi()
    partial.listOutputs.mockRejectedValue(new Error('offline'))
    await view.render(<Probe api={partial} />)
    expect(snapshot.status).toBe('error')
    expect(snapshot.summaries.get('workspace')).toMatchObject({ text: 'Workspace: Workspace', live: false })
  })

  it('formats absolute timestamps without a ticking relative-age label', () => {
    const timestamp = date(4)
    expect(botInboxTime(timestamp.getTime(), date(30))).toBe(timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    expect(botInboxTime(timestamp.getTime(), new Date(2027, 0, 1))).toContain('2026')
  })
})
