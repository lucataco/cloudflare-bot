// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentProfile, AgentRoutine, AiChatAuthorInfo, AiChatHistoryPage, AiChatMessage,
  AiChatMessageBody, AiChatMetadata, AiChatSubscriber, AuthenticatedApi, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
})
Element.prototype.scrollTo ??= () => {}

const api = vi.hoisted(() => ({
  listGatekeeperVendors: async () => [],
  getAiConfig: async () => null,
  getAgentByWorkspaceId: vi.fn<AuthenticatedApi['getAgentByWorkspaceId']>(),
  getGroupByWorkspaceId: vi.fn<AuthenticatedApi['getGroupByWorkspaceId']>(),
  listAgents: vi.fn<AuthenticatedApi['listAgents']>(),
  listRoutines: vi.fn<AuthenticatedApi['listRoutines']>(),
  createRoutine: vi.fn<AuthenticatedApi['createRoutine']>(),
  updateRoutine: vi.fn<AuthenticatedApi['updateRoutine']>(),
}))
const connection = vi.hoisted(() => ({ lost: false }))
let sessionApi: typeof api

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: sessionApi, currentUser: null }),
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => connection.lost }))
vi.mock('./FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? () => null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, Dialog: parts, DropdownMenu: parts, Popover: parts, Tooltip: Pass, useKumoToastManager: () => toasts }
})
// Form validation has its own tests; keep real store writes and server-result publication here.
vi.mock('./components/CreateRoutineModal', () => ({
  default: vi.fn<typeof CreateRoutineModal>(function MockRoutineModal({ agent: owner, initialName = '', initialPrompt = '', routine, onClose, onCreated }) {
    const { store } = useRoutineState(owner.id)
    return (
      <dialog open aria-label="Routine setup">
        <button onClick={onClose}>Cancel routine</button>
        <button onClick={async () => {
          const saved = routine
            ? await store.update(routine, {})
            : await store.create(initialName, initialPrompt, { kind: 'interval', everyMs: 3600000 }, false)
          onCreated(saved)
        }}>Confirm routine</button>
      </dialog>
    )
  }),
}))

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface, { getRepeatableTask } from './ChatInterface'
import CreateRoutineModal from './components/CreateRoutineModal'
import { useRoutineState } from './components/routineState'

const view = makeTestRoot()
const timestamp = new Date('2026-09-08T12:00:00Z')
const model: AiChatAuthorInfo = { type: 'agent', id: 'model-1', name: 'Model' }
const user: AiChatAuthorInfo = { type: 'user', id: 'user-1', name: 'Alex' }
const agent: AgentProfile = {
  id: 'bot-1', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'workspace-1', defaultModelId: model.id, created: timestamp, updated: timestamp,
}
const chat: AiChatMetadata = { id: 1, title: 'Weekly research', started: timestamp, lastActive: timestamp }
const prompt = 'Summarize the new research findings.'
const answer = 'The strongest finding is improved reliability.'

function message(sequence: number, body: AiChatMessageBody, author = model): AiChatMessage {
  return { chatId: chat.id, timestamp, sequence, author, ...body }
}
function request(sequence = 0, text = prompt): AiChatMessage {
  return message(sequence, { type: 'message', message: text }, user)
}
function response(sequence = 1, text = answer): AiChatMessage {
  return message(sequence, { type: 'message', message: text })
}
const completed = [request(), response()]
let serverRoutines: AgentRoutine[]

beforeEach(() => {
  vi.clearAllMocks()
  sessionApi = { ...api }
  serverRoutines = []
  connection.lost = false
  api.getAgentByWorkspaceId.mockResolvedValue(agent)
  api.getGroupByWorkspaceId.mockResolvedValue(null)
  api.listAgents.mockResolvedValue([agent])
  api.listRoutines.mockImplementation(async () => serverRoutines)
  api.createRoutine.mockReset()
  api.updateRoutine.mockReset()
})
afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

function buttons(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)
}
async function click(label: string, scope: ParentNode = document) {
  const matches = buttons(label, scope)
  expect(matches, `button named ${label}`).toHaveLength(1)
  expect(matches[0].disabled).toBe(false)
  await act(async () => matches[0].click())
}
function modalProps() {
  expect(document.querySelector('dialog[aria-label="Routine setup"]')).not.toBeNull()
  const props = vi.mocked(CreateRoutineModal).mock.lastCall?.[0]
  expect(props).toBeDefined()
  return props!
}

async function renderChat({
  messages = completed,
  metadata = chat,
  history,
  props = {},
}: {
  messages?: AiChatMessage[]
  metadata?: AiChatMetadata
  history?: Promise<AiChatHistoryPage>
  props?: Partial<ComponentProps<typeof ChatInterface>>
} = {}) {
  const server = makeOverseer()
  let subscriber!: AiChatSubscriber
  let broken!: (error: Error) => void
  const onOpenGadget = vi.fn<ComponentProps<typeof ChatInterface>['onOpenGadget']>()
  const getChatHistory = vi.fn<Overseer['getChatHistory']>(() => history ?? Promise.resolve({ messages }))
  Object.assign(server.overseer, {
    getChatHistory,
    listChats: async () => [metadata],
    listModels: async () => [model],
    onRpcBroken: (callback: typeof broken) => { broken = callback },
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
  })
  const render = (overrides: Partial<ComponentProps<typeof ChatInterface>> = {}) => view.render(
    <ChatInterface
      workspaceId={agent.workspaceId}
      overseer={server.overseer}
      selectedChatId={chat.id}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={onOpenGadget}
      outputOfWorkpiece={() => undefined}
      {...props}
      {...overrides}
    />,
  )
  await render()
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  flushFrames()
  return { subscriber, broken, render, onOpenGadget, getChatHistory }
}

describe('getRepeatableTask', () => {
  it('returns the latest original user prompt and final answer sequence, not the answer', () => {
    const original = '  Compare this week with last week.\nKeep the caveats.  '
    expect(getRepeatableTask([
      ...completed, request(2, original), response(3, 'First finding.'), response(4, 'Final findings.'),
      message(5, { type: 'message', message: '', reasoning: 'Internal reasoning.' }),
    ])).toEqual({ prompt: original, sequence: 4 })
  })

  it.each([
    { name: 'empty history', messages: [] },
    { name: 'no user task', messages: [response()] },
    { name: 'no answer', messages: [request()] },
    { name: 'blank user task', messages: [request(0, ' \n '), response()] },
    { name: 'blank answer', messages: [request(), response(1, ' \n ')] },
    { name: 'reasoning and tools only', messages: [request(), message(1, {
      type: 'message', message: '', reasoning: 'Looking for evidence.',
      toolCalls: [{ toolCallId: 'read-1', toolName: 'readFile', input: { filename: 'notes.txt' } }],
    })] },
    { name: 'new unanswered task', messages: [...completed, request(2, 'Now compare the costs.')] },
    { name: 'expanded answer only', messages: [request(), message(1, {
      type: 'message', message: 'Expanded command output.', generatedBySlashCommandSequence: 0,
    })] },
  ])('does not repeat $name', ({ messages }) => {
    expect(getRepeatableTask(messages)).toBeNull()
  })

  it.each([
    message(2, { type: 'slashCommand', request: { id: { builtin: true, commandId: 'compact' }, args: '' } }, user),
    message(2, { type: 'message', message: 'Expanded command prompt.', generatedBySlashCommandSequence: 0 }, user),
  ])('does not fall back to an earlier task after a latest $type', (command) => {
    expect(getRepeatableTask([...completed, command, response(3)])).toBeNull()
  })

  it.each<AiChatMessageBody>([
    { type: 'connectionRequest', requestId: 'connection-1', vendorId: 'github', vendorName: 'GitHub', reason: 'Read issues.', state: 'pending' },
    { type: 'computerHumanTakeover', requestId: 'takeover-1', reason: 'Sign in.', currentUrl: 'https://example.com', state: 'pending' },
    { type: 'action', actionId: 7, actionLog: entry(7) },
  ])('suppresses a still-pending $type even before the latest task', (body) => {
    expect(getRepeatableTask([message(0, body), request(1), response(2)])).toBeNull()
  })

  it('allows resolved requests and approved observations', () => {
    expect(getRepeatableTask([
      message(0, { type: 'connectionRequest', requestId: 'connection-1', vendorId: 'github', vendorName: 'GitHub', reason: 'Read issues.', state: 'accepted' }),
      message(1, { type: 'computerHumanTakeover', requestId: 'takeover-1', reason: 'Sign in.', currentUrl: 'https://example.com', state: 'approved' }),
      message(2, { type: 'action', actionId: 7, actionLog: entry(7, { state: 'approved' }) }),
      request(3),
      message(4, { type: 'action', actionId: 8, actionLog: entry(8, { type: 'observation', state: 'approved' }) }),
      response(5),
    ])).toEqual({ prompt, sequence: 5 })
  })

  it('rejects an error after the answer but allows a later successful response', () => {
    const failed = [...completed, message(2, { type: 'error', message: 'Run failed.' })]
    expect(getRepeatableTask(failed)).toBeNull()
    expect(getRepeatableTask([...failed, response(3, 'Retry succeeded.')])).toEqual({ prompt, sequence: 3 })
  })

  it('returns text only, not attachment handles or bytes', () => {
    const attached = message(0, {
      type: 'message', message: prompt,
      attachments: [{ id: 'attachment-1', mimeType: 'image/png', size: 3, content: new Uint8Array([1, 2, 3]) }],
    }, user)
    expect(getRepeatableTask([attached, response()])).toEqual({ prompt, sequence: 1 })
  })
})

describe('ChatInterface Repeat wiring', () => {
  it('opens the latest task with the chat title and cancels without creating anything', async () => {
    const latestPrompt = 'Compare the findings with last week.'
    await renderChat({ messages: [...completed, request(2, latestPrompt), response(3)] })
    expect(buttons('Repeat this...')).toHaveLength(1)
    expect(CreateRoutineModal).not.toHaveBeenCalled()
    expect(api.createRoutine).not.toHaveBeenCalled()
    await click('Repeat this...')
    expect(modalProps()).toEqual({
      agent, initialName: chat.title, initialPrompt: latestPrompt,
      onClose: expect.any(Function), onCreated: expect.any(Function),
    })
    expect(api.getAgentByWorkspaceId).toHaveBeenCalledWith(agent.workspaceId)
    expect(api.createRoutine).not.toHaveBeenCalled()
    expect(document.querySelector('article')).toBeNull()
    await click('Cancel routine')
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain('Routine saved.')
    expect(api.createRoutine).not.toHaveBeenCalled()
  })

  it('passes no attachments and uses the actual saved routine for its editable, pausable receipt', async () => {
    const attached = message(0, {
      type: 'message', message: prompt,
      attachments: [{ id: 'attachment-1', name: 'evidence.txt', mimeType: 'text/plain', size: 42 }],
    }, user)
    await renderChat({ messages: [attached, response()] })
    expect(document.body.textContent).toContain('evidence.txt')
    await click('Repeat this...')
    const props = modalProps()
    expect(props).toEqual({
      agent, initialName: chat.title, initialPrompt: prompt,
      onClose: expect.any(Function), onCreated: expect.any(Function),
    })
    expect(api.createRoutine).not.toHaveBeenCalled()
    const saved: AgentRoutine = {
      id: 'server-routine-42', name: 'Confirmed research review', prompt: 'Check the public research feed.',
      schedule: { kind: 'interval', everyMs: 7200000 }, paused: false, hookId: 42,
      created: timestamp, updated: timestamp,
    }
    api.createRoutine.mockImplementation(async () => {
      serverRoutines = [saved]
      return saved
    })
    await click('Confirm routine')
    expect(api.createRoutine).toHaveBeenCalledExactlyOnceWith(
      agent.id, chat.title, prompt, { kind: 'interval', everyMs: 3600000 }, false,
    )
    expect(api.listRoutines).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(document.querySelector('dialog')).toBeNull()
    const receipt = document.querySelector('article[aria-label="Confirmed research review"]')!
    expect(receipt).not.toBeNull()
    expect(receipt.textContent).toContain(saved.prompt)
    expect(receipt.textContent).toContain('Every 2 hours')
    expect(receipt.textContent).toContain('Active')
    expect(receipt.textContent).not.toContain('evidence.txt')
    expect(receipt.textContent).not.toContain(answer)
    expect(document.body.textContent).toContain('Routine saved. Manage it here or in Routines.')

    api.listRoutines.mockClear()
    await click('Edit', receipt)
    expect(api.listRoutines).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(modalProps().routine).toBe(saved)
    expect(modalProps().agent).toEqual(agent)
    const edited = { ...saved, name: 'Edited server routine', prompt: 'Check the feed and summarize new results.' }
    api.updateRoutine.mockImplementationOnce(async () => {
      serverRoutines = [edited]
      return edited
    })
    api.listRoutines.mockClear()
    await click('Confirm routine')
    expect(api.listRoutines).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(api.updateRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, saved.id, {})
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.querySelector('article')?.getAttribute('aria-label')).toBe(edited.name)
    expect(document.querySelector('article')?.textContent).toContain(edited.prompt)
    api.updateRoutine.mockImplementationOnce(async () => {
      const paused = { ...edited, paused: true }
      serverRoutines = [paused]
      return paused
    })
    api.listRoutines.mockClear()
    await click('Pause', document.querySelector('article')!)
    expect(api.listRoutines).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(api.updateRoutine.mock.calls).toEqual([
      [agent.id, saved.id, {}],
      [agent.id, saved.id, { paused: true }],
    ])
    expect(document.querySelector('article')?.textContent).toContain('Paused')
    expect(buttons('Resume', document.querySelector('article')!)).toHaveLength(1)
    // ChatInterface records the modal's result, never creates a second routine itself.
    expect(api.createRoutine).toHaveBeenCalledTimes(1)
  })

  it('keeps chat B\'s repeat draft open when chat A\'s pending creation finishes', async () => {
    let finish!: (routine: AgentRoutine) => void
    const pending = new Promise<AgentRoutine>(resolve => { finish = resolve })
    api.createRoutine.mockImplementation(async () => {
      const saved = await pending
      serverRoutines = [saved]
      return saved
    })
    const { subscriber, render } = await renderChat()
    await click('Repeat this...')
    const draftA = modalProps()
    await click('Confirm routine')
    expect(api.createRoutine).toHaveBeenCalledTimes(1)
    expect(document.querySelector('article')).toBeNull()

    const chatB = { ...chat, id: 2, title: 'Cost comparison' }
    const promptB = 'Compare the costs of the available options.'
    await act(async () => {
      subscriber.metadata(chatB)
      subscriber.message({ ...request(0, promptB), chatId: chatB.id })
      subscriber.message({ ...response(1, 'The second option costs less.'), chatId: chatB.id })
    })
    flushFrames()
    await render({ selectedChatId: chatB.id })
    expect(document.querySelector('dialog')).toBeNull()
    await click('Repeat this...')
    expect(modalProps()).toMatchObject({ initialName: chatB.title, initialPrompt: promptB })
    const dialogB = document.querySelector('dialog')

    const savedA: AgentRoutine = {
      id: 'late-routine-a', name: 'Saved research routine', prompt,
      schedule: { kind: 'interval', everyMs: 3600000 }, paused: false,
      created: timestamp, updated: timestamp,
    }
    await act(async () => finish(savedA))
    expect(document.querySelector('dialog')).toBe(dialogB)
    expect(modalProps()).toMatchObject({ initialName: chatB.title, initialPrompt: promptB })
    expect(document.querySelector('article')).toBeNull()
    expect(document.body.textContent).not.toContain('Routine saved.')
    await act(async () => draftA.onClose())
    expect(document.querySelector('dialog')).toBe(dialogB)

    await click('Cancel routine')
    await render({ selectedChatId: chat.id })
    const receipts = document.querySelectorAll('article')
    expect(receipts).toHaveLength(1)
    expect(receipts[0].getAttribute('aria-label')).toBe(savedA.name)
    expect(receipts[0].textContent).toContain(savedA.prompt)
    expect(receipts[0].textContent).toContain('Active')
    expect(document.body.textContent).toContain('Routine saved. Manage it here or in Routines.')
    expect(api.createRoutine).toHaveBeenCalledTimes(1)
  })

  it.each<{ name: string; metadata: AiChatMetadata }>([
    { name: 'active', metadata: { ...chat, activeAgent: model } },
    { name: 'queued but idle', metadata: { ...chat, queue: [{
      id: 'queue-1', position: 0, message: 'Next task.', modelId: model.id, created: timestamp,
    }] } },
  ])('hides Repeat while $name and restores it when idle with an empty queue', async ({ metadata }) => {
    const { subscriber } = await renderChat({ metadata })
    expect(document.body.textContent).toContain(answer)
    expect(buttons('Repeat this...')).toHaveLength(0)
    await act(async () => subscriber.metadata({ ...chat, queue: [] }))
    expect(buttons('Repeat this...')).toHaveLength(1)
  })

  it('hides Repeat in a group even with a selected member and matching workspace', async () => {
    api.getGroupByWorkspaceId.mockResolvedValue({
      id: 'group-1', name: 'Research team', memberAgentIds: [agent.id], workspaceId: agent.workspaceId,
      created: timestamp, updated: timestamp,
    })
    await renderChat()
    expect(api.listAgents).toHaveBeenCalled()
    expect(document.body.textContent).toContain(answer)
    expect(buttons('Repeat this...')).toHaveLength(0)
  })

  it.each([
    { name: 'no bot profile', profile: null },
    { name: 'another workspace owner', profile: { ...agent, workspaceId: 'other-workspace' } },
    { name: 'no default model', profile: { ...agent, defaultModelId: null } },
  ])('hides Repeat for $name even with a completed model response', async ({ profile }) => {
    api.getAgentByWorkspaceId.mockResolvedValue(profile)
    await renderChat()
    expect(document.body.textContent).toContain(answer)
    expect(buttons('Repeat this...')).toHaveLength(0)
    expect(CreateRoutineModal).not.toHaveBeenCalled()
  })

  it('hides Repeat on connection loss or a broken chat subscription', async () => {
    const { render, broken } = await renderChat()
    expect(buttons('Repeat this...')).toHaveLength(1)
    connection.lost = true
    await render()
    expect(buttons('Repeat this...')).toHaveLength(0)
    connection.lost = false
    await render()
    expect(buttons('Repeat this...')).toHaveLength(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await act(async () => broken(new Error('Connection closed.')))
    expect(warn).toHaveBeenCalled()
    expect(document.body.textContent).toContain(answer)
    expect(buttons('Repeat this...')).toHaveLength(0)
  })

  it('waits for history to load even if subscription replay has delivered an answer', async () => {
    let finish!: (page: AiChatHistoryPage) => void
    const history = new Promise<AiChatHistoryPage>(resolve => { finish = resolve })
    const { subscriber, getChatHistory } = await renderChat({ history })
    expect(getChatHistory).toHaveBeenCalledWith(chat.id)
    await act(async () => { completed.forEach(record => subscriber.message(record)) })
    flushFrames()
    expect(buttons('Repeat this...')).toHaveLength(0)
    await act(async () => finish({ messages: completed }))
    expect(buttons('Repeat this...')).toHaveLength(1)
  })

  it('withdraws Repeat when the run fails after a durable answer', async () => {
    const { subscriber } = await renderChat()
    expect(buttons('Repeat this...')).toHaveLength(1)
    await act(async () => subscriber.message(message(2, { type: 'error', message: 'Model request failed.' })))
    flushFrames()
    expect(document.body.textContent).toContain(answer)
    expect(document.body.textContent).toContain('Model request failed.')
    expect(buttons('Repeat this...')).toHaveLength(0)
  })

  it('does not turn a provisional streamed answer into a repeatable result', async () => {
    const { subscriber } = await renderChat({ messages: [request()], metadata: { ...chat, activeAgent: model } })
    await act(async () => subscriber.stream(chat.id, { type: 'textDelta', delta: answer }))
    flushFrames()
    expect(document.body.textContent).toContain(answer)
    expect(buttons('Repeat this...')).toHaveLength(0)
    await act(async () => subscriber.metadata(chat))
    expect(buttons('Repeat this...')).toHaveLength(0)
    await act(async () => subscriber.message(response()))
    flushFrames()
    expect(buttons('Repeat this...')).toHaveLength(1)
  })
})

const creations = message(1, {
  type: 'changes',
  createdGadgets: [
    { gadgetId: 41, title: 'Research brief', bindingName: 'BRIEF' },
    { gadgetId: 87, title: 'Research tracker', bindingName: 'TRACKER' },
  ],
})
const resultMessages = [request(), creations, response(2)]
const outputOfWorkpiece = vi.fn<ComponentProps<typeof ChatInterface>['outputOfWorkpiece']>(id => id === 41
  ? { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }
  : undefined)

describe('ChatInterface result cards', () => {
  it('labels drafts by output format, falls back to App, and previews the exact gadget ID', async () => {
    const { onOpenGadget } = await renderChat({ messages: resultMessages, props: { outputOfWorkpiece } })
    for (const [label, id] of [['Preview document: Research brief', 41], ['Preview app: Research tracker', 87]] as const) {
      expect(buttons(label)).toHaveLength(1)
      expect(buttons(label)[0].textContent).toContain('Draft ready')
      expect(buttons(label)[0].textContent).not.toContain('Saved')
      expect(outputOfWorkpiece).toHaveBeenCalledWith(id)
      await click(label)
    }
    expect(onOpenGadget.mock.calls).toEqual([[41], [87]])
  })

  it('keeps accepted creations as Saved cards and opens the exact gadget ID', async () => {
    const { subscriber, onOpenGadget } = await renderChat({ messages: resultMessages, props: { outputOfWorkpiece } })
    expect(buttons('Preview document: Research brief')).toHaveLength(1)
    await act(async () => subscriber.message(message(3, {
      type: 'merge', mergeThrough: 2, commits: [], epochBoundary: true,
    }, user)))
    flushFrames()
    for (const label of ['Open document: Research brief', 'Open app: Research tracker']) {
      expect(buttons(label)).toHaveLength(1)
      expect(buttons(label)[0].textContent).toContain('Saved')
      expect(buttons(label)[0].textContent).not.toContain('Draft ready')
      await click(label)
    }
    expect(buttons('Preview document: Research brief')).toHaveLength(0)
    expect(buttons('Preview app: Research tracker')).toHaveLength(0)
    expect(onOpenGadget.mock.calls).toEqual([[41], [87]])
  })

  it('removes reverted creation cards without removing the answer', async () => {
    const { subscriber, onOpenGadget } = await renderChat({ messages: resultMessages, props: { outputOfWorkpiece } })
    expect(buttons('Preview document: Research brief')).toHaveLength(1)
    await act(async () => subscriber.message(message(3, { type: 'revert', revertFrom: 1 }, user)))
    flushFrames()
    expect(document.querySelector('button[aria-label^="Preview "]')).toBeNull()
    expect(document.querySelector('button[aria-label^="Open "]')).toBeNull()
    expect(document.body.textContent).toContain(answer)
    expect(onOpenGadget).not.toHaveBeenCalled()
  })
})

describe('ChatInterface action previews', () => {
  it('does not load external images or preloads when a rejected action is expanded', async () => {
    await renderChat({ messages: [request(), message(1, {
      type: 'action', actionId: 7, actionLog: entry(7, {
        state: 'rejected',
        description: {
          title: 'Send report', implementsRevert: false,
          description: 'Rejected report details.\n\n![Report preview](https://tracker.example/preview.png)\n\n'
            + '<img src="https://tracker.example/raw.png"><link rel="preload" as="image" href="https://tracker.example/preload.png">\n\n'
            + '[Read documentation](https://example.com/docs)',
        },
      }),
    })] })
    const toggle = buttons('Send reportDenied')[0]
    expect(toggle).toBeDefined()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).not.toContain('Rejected report details.')
    await click('Send reportDenied')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('Rejected report details.')
    expect(document.body.textContent).toContain('[Image omitted: Report preview]')
    expect(document.querySelector('a[href="https://example.com/docs"]')?.textContent).toBe('Read documentation')
    // React can hoist image preloads into head, so inspect the whole document, not just the card.
    expect(document.querySelector('img, link[rel="preload"][as="image"], link[rel="prefetch"]')).toBeNull()
  })
})
