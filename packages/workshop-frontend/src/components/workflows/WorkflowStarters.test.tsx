// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AiChatMessage, AuthenticatedApi, Overseer } from '@gadgets/workshop-shared/api'
import { WORKFLOW_STARTERS } from '@gadgets/workshop-shared/workflow-starters'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
Element.prototype.scrollTo ??= () => {}

const api = vi.hoisted(() => ({
  listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>(async () => []),
  getAiConfig: vi.fn<() => Promise<null>>(async () => null),
  getAgentByWorkspaceId: vi.fn<AuthenticatedApi['getAgentByWorkspaceId']>(),
  getGroupByWorkspaceId: vi.fn<AuthenticatedApi['getGroupByWorkspaceId']>(async () => null),
  createAgent: vi.fn<AuthenticatedApi['createAgent']>(),
  createRoutine: vi.fn<AuthenticatedApi['createRoutine']>(),
  newGadget: vi.fn<AuthenticatedApi['newGadget']>(),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api, currentUser: null }),
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, Tooltip: ({ children }: { children?: React.ReactNode }) => children, useKumoToastManager: () => toasts }
})
vi.mock('../../GatekeeperModal', () => ({ default: vi.fn<typeof GatekeeperModal>(() => <></>) }))
vi.mock('../format/formatIconImage', () => ({ formatIconDataUrl: async () => undefined }))
vi.mock('../format/useOutputFormats', () => ({
  useOutputFormats: () => ({ formats: [{ blueprintId: 'document', output: { noun: 'Document', icon: 'fileText' } }], creating: null }),
}))

import ChatInterface, { ChatInput } from '../../ChatInterface'
import GatekeeperModal from '../../GatekeeperModal'
import { flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { readComposerDraft, writeComposerDraft } from '../../composerDraft'
import { WorkflowStarterCards } from './WorkflowStarters'

const view = makeTestRoot()
const timestamp = new Date('2026-09-08T12:00:00Z')
const model = { type: 'agent', id: 'model-1', name: 'Model' } as const
const bot: AgentProfile = {
  id: 'bot-1', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'workspace-1', defaultModelId: model.id, created: timestamp, updated: timestamp,
}

beforeEach(() => { api.getAgentByWorkspaceId.mockResolvedValue(bot) })
afterEach(() => {
  view.cleanup()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function control(label: string) {
  const elements = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
  const matches = elements.filter(element => {
    const labelledBy = element.getAttribute('aria-labelledby')
    return (element.getAttribute('aria-label') ?? (labelledBy ? document.getElementById(labelledBy)?.textContent : element.textContent?.trim())) === label
  })
  expect(matches, `control named ${label}`).toHaveLength(1)
  return matches[0]
}
async function click(label: string) {
  await act(async () => control(label).click())
  flushFrames()
}
async function pressKey(key: string) {
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  flushFrames()
}
function textarea() { return document.querySelector('textarea')! }
async function typeDraft(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
  flushFrames()
}

async function renderComposer(props: Partial<ComponentProps<typeof ChatInput>> = {}) {
  const server = makeOverseer()
  const uploadChatAttachment = vi.fn<Overseer['uploadChatAttachment']>(async () => ({ id: 'attachment-1', mimeType: 'text/plain', size: 5 }))
  const deleteChatAttachment = vi.fn<Overseer['deleteChatAttachment']>(async () => {})
  Object.assign(server.overseer, { uploadChatAttachment, deleteChatAttachment })
  const calls = {
    onSend: vi.fn<ComponentProps<typeof ChatInput>['onSend']>(),
    onModelChange: vi.fn<ComponentProps<typeof ChatInput>['onModelChange']>(),
    createCapsuleGatekeeper: vi.fn<ComponentProps<typeof ChatInput>['createCapsuleGatekeeper']>(async () => null),
    getOverseer: vi.fn<ComponentProps<typeof ChatInput>['getOverseer']>(() => server.overseer),
    uploadChatAttachment, deleteChatAttachment,
  }
  const render = (overrides: Partial<ComponentProps<typeof ChatInput>> = {}) => view.render(
    <ChatInput {...calls} isAgentActive={false} models={[model]} selectedModel={model.id} botName={bot.name} {...props} {...overrides} />,
  )
  await render()
  flushFrames()
  vi.clearAllMocks()
  const expectNoRpcOrSend = () => {
    for (const call of [...Object.values(api), ...Object.values(calls)]) expect(call).not.toHaveBeenCalled()
  }
  return { ...calls, render, expectNoRpcOrSend }
}

async function renderThread(selectedChatId: number | null, messages: AiChatMessage[] = []) {
  const server = makeOverseer()
  const calls = {
    getChatHistory: vi.fn<Overseer['getChatHistory']>(async () => ({ messages })),
    listChats: vi.fn<Overseer['listChats']>(async () => selectedChatId === null ? [] : [{ id: selectedChatId, title: 'Research', started: timestamp, lastActive: timestamp }]),
    listModels: vi.fn<Overseer['listModels']>(async () => [model]),
    onRpcBroken: vi.fn<() => void>(),
    subscribeToChat: vi.fn<() => Disposable>(() => ({ [Symbol.dispose]: () => {} })),
    newChat: vi.fn<Overseer['newChat']>(),
    sendChatMessage: vi.fn<Overseer['sendChatMessage']>(),
    newGatekeeper: vi.fn<Overseer['newGatekeeper']>(),
  }
  Object.assign(server.overseer, calls)
  const onNavigateToChat = vi.fn<ComponentProps<typeof ChatInterface>['onNavigateToChat']>()
  const render = (chatId = selectedChatId) => view.render(
    <ChatInterface workspaceId={bot.workspaceId} overseer={server.overseer} selectedChatId={chatId}
      threadChrome onNavigateToChat={onNavigateToChat} pendingConsoleLogCount={0} consoleLogPreview=""
      consoleLogSeverity="info" onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />,
  )
  await render()
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  flushFrames()
  vi.clearAllMocks()
  const expectNoRpcOrSend = () => {
    for (const call of [...Object.values(api), ...Object.values(calls), onNavigateToChat]) expect(call).not.toHaveBeenCalled()
  }
  return { render, expectNoRpcOrSend }
}

describe('workflow starters', () => {
  describe.each([null, 1])('empty bot thread (chat=%s)', chatId => {
    it.each(WORKFLOW_STARTERS)('prefills $id without RPC, sending, or navigation', async starter => {
      const { expectNoRpcOrSend } = await renderThread(chatId)
      expect(document.querySelectorAll('section[aria-labelledby] button')).toHaveLength(3)
      for (const idea of WORKFLOW_STARTERS) expect(control(idea.title)).toBeDefined()
      await click(starter.title)
      expect(textarea().value).toBe(starter.prompt)
      expect(document.activeElement).toBe(textarea())
      expect(textarea().selectionStart).toBe(starter.prompt.length)
      expectNoRpcOrSend()
    })
  })

  it.each(WORKFLOW_STARTERS)('offers $id in an existing conversation without forcing cards or calling RPC', async starter => {
    const { expectNoRpcOrSend } = await renderThread(1, [{
      chatId: 1, sequence: 0, timestamp, author: model, type: 'message', message: 'Existing conversation.',
    }])
    expect(document.body.textContent).not.toContain('Start with a task')
    expect(document.body.textContent).toContain('Existing conversation.')
    await click('Task ideas')
    await click(starter.title)
    expect(textarea().value).toBe(starter.prompt)
    expect(document.activeElement).toBe(textarea())
    expectNoRpcOrSend()
  })

  it('appends repeated card selections and does not reapply a seed after leaving the thread', async () => {
    const { render, expectNoRpcOrSend } = await renderThread(1)
    await typeDraft('  Keep my original notes.\n')
    await click(WORKFLOW_STARTERS[0].title)
    await click(WORKFLOW_STARTERS[0].title)
    expect(textarea().value).toBe(`  Keep my original notes.\n\n\n${WORKFLOW_STARTERS[0].prompt}\n\n${WORKFLOW_STARTERS[0].prompt}`)
    expectNoRpcOrSend()
    await render(2)
    await render(1)
    flushFrames()
    expect(textarea().value).toBe('')
  })

  it('preserves text, selected tokens, and a staged attachment when appending from the menu', async () => {
    const draftStorageKey = 'workflow-test'
    writeComposerDraft(draftStorageKey, {
      version: 1, text: '/compact Document notes',
      command: { position: 0, length: 8, choice: { selection: { builtin: true, commandId: 'compact' }, name: 'compact', description: 'Compact', providerLabel: 'Workshop' } },
      formats: [{ position: 9, length: 8, noun: 'Document', icon: 'fileText' }],
    })
    const composer = await renderComposer({ draftStorageKey })
    await click('Add')
    await click('Choose connected resource')
    const modal = vi.mocked(GatekeeperModal).mock.calls.findLast(([props]) => props.open)![0]
    const capsule = {
      getId: async () => 42,
      describe: async () => ({ title: 'Meeting notes', url: 'https://example.com/notes' }),
      getCreationSpec: async () => ({ vendorId: 'test' }),
      [Symbol.dispose]: () => {},
    } as unknown as Parameters<NonNullable<typeof modal.onCreated>>[0]
    await act(async () => { await modal.onCreated?.(capsule) })
    flushFrames()
    const attachment = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(attachment, 'arrayBuffer', { value: async () => new TextEncoder().encode('notes').buffer })
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { value: [attachment], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(composer.uploadChatAttachment).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Remove attachment"]')).not.toBeNull()
    const original = textarea().value
    const tokens = [...document.querySelectorAll('[data-token-start]')].map(node => node.outerHTML)
    expect(tokens).toHaveLength(3)
    const stored = readComposerDraft(draftStorageKey)!
    vi.clearAllMocks()
    await click('Task ideas')
    await click(WORKFLOW_STARTERS[1].title)
    expect(textarea().value).toBe(`${original}\n\n${WORKFLOW_STARTERS[1].prompt}`)
    expect([...document.querySelectorAll('[data-token-start]')].map(node => node.outerHTML)).toEqual(tokens)
    expect(document.querySelectorAll('[aria-label="Remove attachment"]')).toHaveLength(1)
    expect(readComposerDraft(draftStorageKey)).toEqual({ ...stored, text: `${stored.text}\n\n${WORKFLOW_STARTERS[1].prompt}` })
    composer.expectNoRpcOrSend()
  })

  it.each([false, true])('supports keyboard selection and focus after menu dismissal (animated=%s)', async animated => {
    const composer = await renderComposer()
    const trigger = control('Task ideas')
    act(() => trigger.focus())
    await pressKey('ArrowDown')
    expect(document.activeElement).toBe(control(WORKFLOW_STARTERS[0].title))
    await pressKey('ArrowDown')
    await pressKey('ArrowDown')
    expect(document.activeElement).toBe(control(WORKFLOW_STARTERS[2].title))
    let finish!: () => void
    if (animated) {
      const finished = new Promise<void>(resolve => { finish = resolve })
      Object.defineProperty(document.querySelector('[role="menu"]')!, 'getAnimations', { value: () => [{ finished }] })
    }
    await pressKey('Enter')
    expect(textarea().value).toBe(animated ? '' : WORKFLOW_STARTERS[2].prompt)
    if (animated) {
      await act(async () => finish())
      flushFrames()
    }
    expect(textarea().value).toBe(WORKFLOW_STARTERS[2].prompt)
    expect(document.activeElement).toBe(textarea())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    composer.expectNoRpcOrSend()
    await click('Task ideas')
    await pressKey('Escape')
    expect(document.activeElement).toBe(trigger)
    expect(textarea().value).toBe(WORKFLOW_STARTERS[2].prompt)
    composer.expectNoRpcOrSend()
  })

  it('keeps cards named, described, focusable, and stacked on small screens', async () => {
    await view.render(<WorkflowStarterCards onSelect={() => {}} />)
    for (const starter of WORKFLOW_STARTERS) {
      const card = control(starter.title) as HTMLButtonElement
      expect(card.type).toBe('button')
      expect(card.tabIndex).toBe(0)
      act(() => card.focus())
      expect(document.activeElement).toBe(card)
      const description = card.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')
      expect(description).toContain(starter.description)
      expect(description).toContain('edit and send when ready')
      expect(card.className).toContain('min-h-11')
      expect(card.className).toContain('focus-visible:outline-2')
      expect(card.parentElement!.className).toContain('grid-cols-1')
      expect(card.parentElement!.className).toContain('sm:grid-cols-3')
    }
  })

  it('retains format choices in Add and existing replace-seed behavior', async () => {
    const composer = await renderComposer({ newChat: true, offerFormats: true })
    await click('Add')
    expect(control('Document')).toBeDefined()
    expect(control('Upload file')).toBeDefined()
    expect(control('Choose connected resource')).toBeDefined()
    await click('Document')
    expect(document.querySelectorAll('[data-token-start]')).toHaveLength(1)
    await composer.render({ seedText: 'Existing home suggestion', seedNonce: 1 })
    flushFrames()
    expect(textarea().value).toBe('Existing home suggestion')
    expect(document.querySelectorAll('[data-token-start]')).toHaveLength(0)
    expect(composer.onSend).not.toHaveBeenCalled()
  })

  it('disables ideas while the composer is blocked and does not offer them outside bot chats', async () => {
    const composer = await renderComposer({ blockedReason: 'Review the pending action.' })
    expect((control('Task ideas') as HTMLButtonElement).disabled).toBe(true)
    await click('Task ideas')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    composer.expectNoRpcOrSend()
    await composer.render({ botName: undefined })
    expect(document.body.textContent).not.toContain('Task ideas')
  })
})
