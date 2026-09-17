// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'

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

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    // Keep real menus and dialogs so focus handoffs are exercised.
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})
vi.mock('./GatekeeperModal', async () => {
  const { Dialog } = await import('@cloudflare/kumo')
  return {
    default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
      <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose() }}>
        <Dialog>
          <Dialog.Title>Connected resource picker</Dialog.Title>
          <Dialog.Description>Choose a connected resource.</Dialog.Description>
          <Dialog.Close render={<button>Close picker</button>} />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Match the real picker's autofocus. */}
          <input aria-label="Search resources" autoFocus />
        </Dialog>
      </Dialog.Root>
    ),
  }
})
vi.mock('./AddModelModal', () => ({
  default: ({ visible }: { visible: boolean }) => visible
    ? <dialog open aria-label="Add model dialog" />
    : null,
}))
vi.mock('./FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: false, loading: false }),
  useUiFeatureFlags: () => ({ flags: {}, loading: false }),
}))
vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: {
      listGatekeeperVendors: async () => [],
      getAiConfig: async () => null,
      getAgentByWorkspaceId: async () => null,
      getGroupByWorkspaceId: async () => null,
    },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface, { ChatInput } from './ChatInterface'

const view = makeTestRoot()
const models: AiChatAuthorInfo[] = [
  { type: 'agent', id: 'model-a', name: 'Model A' },
  { type: 'agent', id: 'model-b', name: 'Model B' },
]
const onModelChange = vi.fn<(id: string | null) => void>()
const onToggleThinkingTraces = vi.fn<() => void>()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function control(label: string) {
  const matches = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"], summary')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(matches, `control named ${label}`).toHaveLength(1)
  return matches[0]
}

async function click(label: string) {
  await act(async () => {
    const element = control(label)
    element.click()
    // Native details dispatches its toggle event in a later task.
    if (element.tagName === 'SUMMARY') await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function renderComposer(props: Partial<ComponentProps<typeof ChatInput>> = {}) {
  return view.render(
    <ChatInput
      createCapsuleGatekeeper={async () => null}
      getOverseer={() => makeOverseer().overseer}
      onSend={() => {}}
      isAgentActive={false}
      models={models}
      selectedModel="model-a"
      onModelChange={onModelChange}
      onToggleThinkingTraces={onToggleThinkingTraces}
      botName="Research bot"
      {...props}
    />,
  )
}

describe('ChatInput presentation', () => {
  it.each([false, true])('addresses the bot and preserves queue/blocked overrides (newChat=%s)', async (newChat) => {
    await renderComposer({ newChat })
    const textarea = document.querySelector('textarea')!
    expect(textarea.placeholder).toBe('Message Research bot...')
    expect(textarea.disabled).toBe(false)

    await renderComposer({ newChat, isAgentActive: true })
    expect(textarea.placeholder).toBe('Send to queue\u2026')
    expect(textarea.disabled).toBe(false)

    await renderComposer({ newChat, isAgentActive: true, blockedReason: 'Approve the pending action first.' })
    expect(textarea.placeholder).toBe('Approve the pending action first.')
    expect(textarea.disabled).toBe(true)
    expect((control('Send message') as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([undefined, 'Choose a project'])('opens file and resource flows from Add (attachLabel=%s)', async (attachLabel) => {
    await renderComposer({ attachLabel })
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const openFilePicker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})
    expect(control('Add').textContent?.trim()).toBe('Add')
    expect(control('Add').getAttribute('aria-label')).toBe('Add')
    expect(document.querySelector('[role="menuitem"]')).toBeNull()

    await click('Add')
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()))
      .toEqual(['Upload file', attachLabel ?? 'Choose connected resource'])
    await act(async () => {
      control('Upload file').click()
      // Must stay in the click's user gesture, not wait for menu dismissal.
      expect(openFilePicker).toHaveBeenCalledTimes(1)
    })
    expect(control('Add').getAttribute('aria-expanded')).toBe('false')

    await click('Add')
    await click(attachLabel ?? 'Choose connected resource')
    await act(async () => { flushFrames() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connected resource picker')
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Search resources"]'))
    await click('Close picker')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it.each([false, true])('hands keyboard focus to the resource picker and restores it on Escape (animated=%s)', async (animated) => {
    await renderComposer()
    const trigger = control('Add')
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => { flushFrames() })
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(control('Choose connected resource'))
    let finishClosing!: () => void
    const closing = new Promise<void>(resolve => { finishClosing = resolve })
    if (animated) {
      Object.defineProperty(document.querySelector('[role="menu"]')!, 'getAnimations', {
        value: () => [{ finished: closing }],
      })
    }
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => { flushFrames() })
    expect(document.querySelector('[role="dialog"]') !== null).toBe(!animated)
    if (animated) {
      await act(async () => { finishClosing() })
      await act(async () => { flushFrames() })
    }
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search resources"]')!
    expect(search).not.toBeNull()
    expect(document.activeElement).toBe(search)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => { flushFrames() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => { flushFrames() })
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => { flushFrames() })
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens settings from the keyboard without changing models and only selects explicit choices', async () => {
    await renderComposer()
    const trigger = control('Chat settings')
    expect(trigger.textContent?.trim()).toBe('Chat settings')
    expect(trigger.getAttribute('aria-label')).toBe('Chat settings')
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.textContent).toContain('Model & usage')
    // The selected-model summary is separate from the selectable Model A item.
    expect(menu.textContent?.match(/Model A/g)).toHaveLength(2)
    expect(onModelChange).not.toHaveBeenCalled()
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onModelChange).not.toHaveBeenCalled()

    await click('Chat settings')
    await click('Model B')
    expect(onModelChange.mock.calls).toEqual([['model-b']])
    await renderComposer({ selectedModel: 'model-b' })
    await click('Chat settings')
    await click('No AI responses')
    expect(onModelChange.mock.calls).toEqual([['model-b'], [null]])
    await renderComposer({ selectedModel: null })
    expect(control('Chat settings').textContent?.trim()).toBe('No AI responses')
  })

  it.each([{ availableModels: models }, { availableModels: [] }])('offers Add a model without changing the selection: $availableModels', async ({ availableModels }) => {
    await renderComposer({ models: availableModels, selectedModel: availableModels.length ? 'model-a' : null })
    expect(control('Chat settings').textContent?.trim()).toBe(availableModels.length ? 'Chat settings' : 'Set up AI')
    await click('Chat settings')
    await click('Add a model')
    expect(document.querySelector('dialog[aria-label="Add model dialog"]')).not.toBeNull()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it.each([true, false])('puts the thinking preference in settings, not Add (shown=%s)', async (showThinkingTraces) => {
    await renderComposer({ showThinkingTraces })
    await click('Add')
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('thinking')
    await click('Add')
    await click('Chat settings')
    await click(showThinkingTraces ? 'Hide thinking details' : 'Show thinking details')
    expect(onToggleThinkingTraces).toHaveBeenCalledTimes(1)
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it.each([
    { usage: { totalTokens: 12345, totalCost: 0.125 }, tokens: '12,345 tokens', cost: '$0.1250' },
    { usage: { totalTokens: 0, totalCost: 0 }, tokens: '0 tokens', cost: '$0.0000' },
    { usage: { totalTokens: 0 }, tokens: '0 tokens', cost: undefined },
    { usage: { totalCost: 0 }, tokens: undefined, cost: '$0.0000' },
    { usage: {}, tokens: undefined, cost: undefined },
    { usage: undefined, tokens: undefined, cost: undefined },
  ])('shows only known usage inside settings: $usage', async ({ usage, tokens, cost }) => {
    await renderComposer({ usage })
    expect(document.body.textContent).not.toMatch(/tokens|\$/)
    await click('Chat settings')
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Model & usage')
    expect(menu.textContent?.match(/[\d,]+ tokens|\$\d+\.\d{4}/g) ?? [])
      .toEqual([tokens, cost].filter(value => value !== undefined))
    expect(menu.textContent?.includes('tokens')).toBe(tokens !== undefined)
    expect(menu.textContent?.includes('$')).toBe(cost !== undefined)
    expect(menu.textContent).not.toMatch(/undefined|NaN/)
    expect(onModelChange).not.toHaveBeenCalled()
  })
})

async function renderTranscript() {
  const server = makeOverseer()
  const timestamp = new Date('2026-09-08T12:00:00Z')
  const base = { chatId: 1, timestamp, author: models[0] }
  const pending = entry(7)
  const messages: AiChatMessage[] = [
    { ...base, sequence: 0, type: 'message', message: 'I checked the files.', reasoning: 'Compare both versions carefully.', toolCalls: [
      { toolCallId: 'read-a', toolName: 'readFile', input: { filename: 'alpha.ts' } },
      { toolCallId: 'read-b', toolName: 'readFile', input: { filename: 'beta.ts' } },
    ] },
    { ...base, sequence: 1, type: 'action', actionId: pending.id, actionLog: pending },
    { ...base, sequence: 2, type: 'message', message: 'I checked the source.', toolCalls: [
      { toolCallId: 'read-source', toolName: 'readFile', input: { filename: 'source.ts' } },
    ] },
    { ...base, sequence: 3, type: 'action', actionId: 8, actionLog: entry(8, {
      type: 'observation', state: 'approved', resourceTitle: 'Reference notes', resourceUrl: 'https://example.com/reference',
      description: { title: 'Reference lookup', description: 'Evidence from the connected source.' },
    }) },
  ]
  const metadata: AiChatMetadata = {
    id: 1, title: 'Research thread', started: timestamp, lastActive: timestamp, totalTokens: 42, totalCost: 0.5,
  }
  const approveAction = vi.fn<Overseer['approveAction']>(async () => {})
  const rejectAction = vi.fn<Overseer['rejectAction']>(async () => {})
  Object.assign(server.overseer, {
    getChatHistory: async () => ({ messages }),
    listChats: async () => [metadata],
    listModels: async () => models,
    onRpcBroken: () => {},
    subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
    approveAction,
    rejectAction,
  })
  await view.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer}
      selectedChatId={1}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [pending] })
  flushFrames()
  return { approveAction, rejectAction }
}

describe('ChatInterface transcript presentation', () => {
  it('keeps reasoning and activity closed until requested, with source links still reachable', async () => {
    await renderTranscript()
    expect(document.body.textContent).toContain('I checked the files.')
    const summary = control('Thinking details')
    const details = summary.closest('details')!
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.textContent).not.toContain('Compare both versions carefully.')
    await click('Thinking details')
    await vi.waitFor(() => expect(details.textContent).toContain('Compare both versions carefully.'))
    expect(details.open).toBe(true)
    await click('Thinking details')
    await vi.waitFor(() => expect(details.textContent).not.toContain('Compare both versions carefully.'))

    expect(control('View activity').getAttribute('aria-expanded')).toBe('false')
    expect(control('View activity & sources').getAttribute('aria-expanded')).toBe('false')
    expect(document.body.textContent).not.toMatch(/Read 2 files|alpha\.ts|beta\.ts|Reference notes/)
    await click('View activity')
    expect(control('View activity').getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toContain('Read 2 files')
    expect(document.body.textContent).toContain('alpha.ts')
    expect(document.body.textContent).toContain('beta.ts')
    await click('View activity')
    expect(document.body.textContent).not.toContain('Read 2 files')

    await click('View activity & sources')
    expect(document.body.textContent).toContain('Read source.ts, read 1 resource')
    await click('Read Reference lookup')
    const source = document.querySelector<HTMLAnchorElement>('a[href="https://example.com/reference"]')!
    expect(source.textContent).toBe('Reference notes')
    expect(source.rel).toContain('noopener')
    expect(document.body.textContent).toContain('Evidence from the connected source.')
  })

  it('moves selected-chat usage into settings instead of leaving an external usage row', async () => {
    await renderTranscript()
    expect(document.body.textContent).not.toContain('42 tokens')
    expect(document.body.textContent).not.toContain('$0.5000')
    await click('Chat settings')
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('42 tokens')
    expect(menu.textContent).toContain('$0.5000')
  })

  it.each(['Allow once', 'Deny'])('keeps %s actionable independently of collapsed activity', async (decision) => {
    const { approveAction, rejectAction } = await renderTranscript()
    expect(control('View activity').getAttribute('aria-expanded')).toBe('false')
    expect(control('View activity & sources').getAttribute('aria-expanded')).toBe('false')
    const approval = control(decision) as HTMLButtonElement
    expect(approval.disabled).toBe(false)
    expect(approval.closest('details')).toBeNull()
    await click(decision)
    expect(decision === 'Allow once' ? approveAction : rejectAction).toHaveBeenCalledWith(7)
    expect(decision === 'Allow once' ? rejectAction : approveAction).not.toHaveBeenCalled()
    expect(control('View activity').getAttribute('aria-expanded')).toBe('false')
  })
})
