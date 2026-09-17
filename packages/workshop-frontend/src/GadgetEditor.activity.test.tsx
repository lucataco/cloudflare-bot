// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetMetadata, Overseer, WorkpiecesSubscriber, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import { inspectorStorageKey, type MessengerInspector } from './inspectorPane'
import GadgetEditor from './GadgetEditor'
import type ChatInterface from './ChatInterface'
import type GadgetCodeInterface from './GadgetCodeInterface'
import type Activity from './Activity'
import type AgentSettingsPane from './components/AgentSettingsPane'

const resizeObservers = new Map<Element, () => void>()
vi.stubGlobal('ResizeObserver', class {
  constructor(private notify: () => void) {}
  observe(element: Element) { resizeObservers.set(element, this.notify) }
  unobserve(element: Element) { resizeObservers.delete(element) }
  disconnect() {
    for (const [element, notify] of resizeObservers) {
      if (notify === this.notify) resizeObservers.delete(element)
    }
  }
})

let search: { chat?: number; pane?: string; w?: number }
const navigate = vi.fn<(options: unknown) => void>()
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({}),
  useSearch: () => search,
  useNavigate: () => navigate,
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

// Keep the real editor, thread header, menus and approval entry point. Replace the expensive
// pane contents and RPC-backed chat with small render/event probes, not a copy of the pane state.
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange, onComputerAttention, onOpenGadget }: ComponentProps<typeof ChatInterface>) => {
    useEffect(() => { onChatCountChange?.(1, true) }, [onChatCountChange])
    return <section aria-label="Chat content">
      <button onClick={onComputerAttention}>Computer attention</button>
      <button onClick={() => onOpenGadget?.(1)}>Open result</button>
    </section>
  },
}))
vi.mock('./GadgetCodeInterface', () => ({
  default: ({ onHasCodeChange }: ComponentProps<typeof GadgetCodeInterface>) => {
    useEffect(() => { onHasCodeChange?.(true) }, [onHasCodeChange])
    return <section aria-label="Code content" />
  },
}))
vi.mock('./Activity', async importOriginal => ({
  ...await importOriginal<typeof import('./Activity')>(),
  default: ({ view }: ComponentProps<typeof Activity>) => <section aria-label="Activity content">{view}</section>,
}))
vi.mock('./GadgetUI', () => ({ default: () => <section aria-label="App content" /> }))
vi.mock('./components/ComputerView', () => ({ ComputerView: () => <section aria-label="Computer content" /> }))
vi.mock('./components/SkillsList', () => ({ default: () => <section aria-label="Skills content" /> }))
vi.mock('./components/MemoryList', () => ({ default: () => <section aria-label="Memory content" /> }))
vi.mock('./components/RoutinesList', () => ({ default: () => <section aria-label="Routines content" /> }))
vi.mock('./components/AgentSettingsPane', () => ({ default: ({ isOwner, workspaceId, overseer: source }: ComponentProps<typeof AgentSettingsPane>) =>
  <section aria-label="Settings content" data-owner={isOwner} data-workspace={workspaceId} data-overseer={source === overseer.stub} /> }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))

const view = makeTestRoot()
const agent = {
  id: 'bot', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'workspace', defaultModelId: null, created: new Date(), updated: new Date(),
}
let server: ReturnType<typeof makeOverseer>
let subscriber: WorkpiecesSubscriber
let gadgets: WorkpieceSummary[]
const app: WorkpieceSummary = { id: 1, type: 'gadget', title: 'Research report' }

beforeEach(() => {
  window.localStorage.clear()
  search = { chat: 0 }
  metadata = { id: 'workspace', title: 'Workspace', role: 'build' }
  gadgets = []
  server = makeOverseer()
  Object.assign(server.overseer, {
    subscribeToWorkpieces: async (next: WorkpiecesSubscriber) => {
      subscriber = next
      for (const gadget of gadgets) next.entry(gadget)
      next.ready()
      return { [Symbol.dispose]: () => {} }
    },
    subscribeToConsoleLogs: async () => ({ [Symbol.dispose]: () => {} }),
    listHooks: async () => [],
    getGadget: () => ({ [Symbol.dispose]: () => {} }),
  })
  overseer = { stub: server.overseer }
})
afterEach(() => {
  view.cleanup()
  vi.clearAllMocks()
})

function renderEditor(messenger = true) {
  return view.render(<GadgetEditor workspaceId="workspace" messenger={messenger ? { agent } : undefined} />)
}

async function mount(messenger = true) {
  await renderEditor(messenger)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [entry(1)] })
  flushFrames()
}

function control(label: string, root: ParentNode = document) {
  const matches = [...root.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(matches, `control named ${label}`).toHaveLength(1)
  return matches[0]
}
async function click(label: string, root: ParentNode = document) {
  await act(async () => { control(label, root).click() })
}
async function more(label: string) {
  await click('More')
  await click(label)
}
function activity() {
  return document.querySelector('[aria-label="Activity content"]')
}
function chatPane() {
  return document.querySelector('[aria-label="Chat content"]')!.parentElement!.parentElement!.parentElement!
}
function desktopHeader() {
  return control('Close activity').parentElement!.parentElement!
}
function hasPaneContent(label: string) {
  const element = document.querySelector(`[aria-label="${label}"]`)
    ?? [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
  return !!element && element.closest('.hidden') === null
}

describe('messenger Activity pane', () => {
  it('passes current workspace ownership to delegation settings, never collaborator or stale workspace flags', async () => {
    search = { chat: 0, pane: 'settings' }
    await mount()
    const settings = document.querySelector('[aria-label="Settings content"]')!
    expect(settings.getAttribute('data-owner')).toBe('true')
    expect(settings.getAttribute('data-workspace')).toBe('workspace')
    expect(settings.getAttribute('data-overseer')).toBe('true')
    metadata = { ...metadata, owner: { id: 'owner', type: 'user', name: 'Owner' } }
    await renderEditor()
    expect(settings.getAttribute('data-owner')).toBe('false')
    metadata = { id: 'old-workspace', title: 'Old workspace', role: 'build' }
    await renderEditor()
    expect(settings.getAttribute('data-owner')).toBe('false')
  })

  it('shows a labelled desktop header and all working tabs without an inspector selected', async () => {
    await mount()
    await more('Activity history')
    expect(activity()?.textContent).toBe('history')
    const header = desktopHeader()
    expect(header.querySelector('[title="Activity"]')).not.toBeNull()
    expect(header.classList.contains('md:flex')).toBe(true)
    expect(header.classList.contains('!hidden')).toBe(false)
    expect(control('Needs approval: 1 request')).toBeDefined()
    for (const [label, value] of [['Needs review1', 'review'], ['Auto-approval', 'auto'], ['History', 'history']]) {
      await click(label, header)
      expect(activity()?.textContent).toBe(value)
      expect(control(label, header).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('has a labelled phone header, all working tabs, and a back-to-chat control', async () => {
    await mount()
    await more('Activity history')
    const header = control('Back to chat').parentElement!
    expect(header.classList.contains('md:hidden')).toBe(true)
    expect(header.querySelector('[title="Activity"]')).not.toBeNull()
    const tabs = header.nextElementSibling!
    expect(tabs.classList.contains('md:hidden')).toBe(true)
    for (const [label, value] of [['Needs review1', 'review'], ['Auto-approval', 'auto'], ['History', 'history']]) {
      await click(label, tabs)
      expect(activity()?.textContent).toBe(value)
      expect(control(label, tabs).getAttribute('aria-pressed')).toBe('true')
    }
    await click('Back to chat')
    expect(activity()).toBeNull()
    expect(chatPane().classList.contains('max-md:hidden')).toBe(false)
  })

  const inspectors: [MessengerInspector, string, string][] = [
    ['gadget', 'App preview', 'App content'], ['computer', 'Computer', 'Computer content'],
    ['files', 'Results', 'Research report'], ['skills', 'Skills', 'Skills content'],
    ['memory', 'Memory', 'Memory content'], ['routines', 'Routines', 'Routines content'],
    ['settings', 'Bot settings', 'Settings content'],
  ]
  it.each(inspectors)('replaces %s with Activity and replaces Activity on reselecting it', async (pane, label, content) => {
    gadgets = [app]
    window.localStorage.setItem(inspectorStorageKey(agent.id), pane)
    await mount()
    await more('Activity history')
    expect(activity()?.textContent).toBe('history')
    expect(window.localStorage.getItem(inspectorStorageKey(agent.id))).toBe('none')
    expect(hasPaneContent(content)).toBe(false)
    expect(document.querySelector('[aria-label="Results"]')?.getAttribute('aria-pressed')).toBe('false')
    if (pane === 'files') await click(label)
    else await more(label)
    expect(activity()).toBeNull()
    expect(hasPaneContent(content)).toBe(true)
    if (pane === 'files') await click(label)
    else await more(label)
    expect(activity()).toBeNull()
    expect(chatPane().classList.contains('max-md:hidden')).toBe(false)
  })

  it.each(['Close activity', 'Back to chat'])('%s returns to chat even after an app, without restoring stale Activity', async close => {
    gadgets = [app]
    await mount()
    await click('Open result')
    await more('Activity history')
    await click(close)
    expect(activity()).toBeNull()
    expect(chatPane().classList.contains('max-md:hidden')).toBe(false)
    expect(window.localStorage.getItem(inspectorStorageKey(agent.id))).toBe('none')
    await more('Bot settings')
    expect(document.querySelector('[aria-label="Settings content"]')).not.toBeNull()
    expect(activity()).toBeNull()
  })

  it('keeps the explicit approval entry point opening Needs review, replacing settings', async () => {
    await mount()
    await more('Bot settings')
    await click('Needs approval: 1 request')
    await click('Review details')
    expect(activity()?.textContent).toBe('review')
    expect(document.querySelector('[aria-label="Settings content"]')).toBeNull()
    expect(control('Needs review1', desktopHeader()).getAttribute('aria-pressed')).toBe('true')
  })

  it.each(['computer attention', 'open result', 'created result', 'URL inspector', 'URL result'])('replaces Activity on %s', async path => {
    gadgets = [app]
    await mount()
    await more('Activity history')
    if (path === 'computer attention') await click('Computer attention')
    if (path === 'open result') await click('Open result')
    if (path === 'created result') {
      await act(async () => { subscriber.entry({ ...app, id: 2, chatId: 0 }) })
    }
    if (path === 'URL inspector' || path === 'URL result') {
      search = path === 'URL inspector' ? { ...search, pane: 'settings' } : { ...search, w: 1 }
      await renderEditor()
    }
    expect(activity()).toBeNull()
    const content = path === 'computer attention' ? 'Computer content'
      : path === 'URL inspector' ? 'Settings content' : 'App content'
    expect(document.querySelector(`[aria-label="${content}"]`)).not.toBeNull()
    expect(chatPane().classList.contains('max-md:hidden')).toBe(true)
  })
})

describe('classic editor Activity', () => {
  it('still restores the previous app on close, retaining its desktop tabs', async () => {
    gadgets = [app]
    await mount(false)
    await click('Open result')
    const activityButton = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Activity')!
    await act(async () => { activityButton.click() })
    expect(activity()?.textContent).toBe('review')
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Back to chat')).toBe(false)
    await click('Close activity')
    expect(activity()).toBeNull()
    const header = control('Close app pane').parentElement!.parentElement!
    expect(header.classList.contains('!hidden')).toBe(false)
    expect(control('Code', header)).toBeDefined()
    expect(control('Connections', header)).toBeDefined()
    expect(document.querySelector('[aria-label="App content"]')!.closest('.hidden')).toBeNull()
  })
})

describe('editor split geometry and Results', () => {
  const widthStorageKey = 'gadgets:workshop:chatWidth'
  const viewportWidth = window.innerWidth
  let bounds: { left: number; width: number }

  beforeEach(() => {
    bounds = { left: 260, width: 1180 }
    window.innerWidth = 1440
    window.localStorage.setItem(widthStorageKey, '420')
    search.pane = 'files'
    gadgets = [app]
    // jsdom has no layout. Measure the real editor body and divider against a movable shell.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('cursor-col-resize')) {
        const chat = this.previousElementSibling as HTMLElement
        return new DOMRect(bounds.left + Number.parseFloat(chat.style.width), 56, 1, 700)
      }
      if (this.querySelector(':scope > .cursor-col-resize')) {
        return new DOMRect(bounds.left, 56, bounds.width, 700)
      }
      return new DOMRect()
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    window.innerWidth = viewportWidth
  })

  function divider() { return chatPane().nextElementSibling as HTMLDivElement }
  function inspectorPane() { return divider().nextElementSibling as HTMLDivElement }
  function width() { return Number.parseFloat(chatPane().style.width) }
  async function mountSplit(messenger = true) {
    await mount(messenger)
    const captured = new Set<number>()
    Object.assign(divider(), {
      setPointerCapture: vi.fn<(id: number) => void>(id => { captured.add(id) }),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: vi.fn<(id: number) => void>(id => { captured.delete(id) }),
    })
  }
  async function pointer(type: string, clientX: number, pointerId = 7) {
    await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, clientX })
      Object.defineProperty(event, 'pointerId', { value: pointerId })
      divider().dispatchEvent(event)
    })
  }
  function resize(left: number, availableWidth: number) {
    bounds = { left, width: availableWidth }
    act(() => { resizeObservers.get(chatPane().parentElement!)!() })
  }

  it.each([-7, 0, 8])('moves only the pointer delta when grabbed %ipx inside the hit area', async offset => {
    await mountSplit()
    const start = bounds.left + width() + offset
    await pointer('pointerdown', start)
    expect(divider().setPointerCapture).toHaveBeenCalledWith(7)
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')
    await pointer('pointermove', start + 1)
    expect(width()).toBe(421)
    await pointer('pointerup', start + 2)
    expect(width()).toBe(422)
    expect(inspectorPane().style.width).toBe('calc(100% - 423px)')
    expect(window.localStorage.getItem(widthStorageKey)).toBe('422')
    expect(divider().releasePointerCapture).toHaveBeenCalledWith(7)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    await pointer('pointermove', start + 100)
    await pointer('pointerup', start + 100)
    expect(width()).toBe(422)
    expect(window.localStorage.getItem(widthStorageKey)).toBe('422')
  })

  it('uses current container bounds if its offset changes during capture', async () => {
    await mountSplit()
    await pointer('pointerdown', bounds.left + 420 + 5)
    // Position-only changes do not notify ResizeObserver.
    bounds.left = 72
    await pointer('pointermove', bounds.left + 421 + 5)
    expect(width()).toBe(421)
    bounds.left = 40
    await pointer('pointerup', bounds.left + 422 + 5)
    expect(width()).toBe(422)
  })

  it('keeps the last width on cancel, releases capture, and ignores other pointers', async () => {
    await mountSplit()
    await pointer('pointerdown', bounds.left + 425)
    await pointer('pointermove', bounds.left + 505)
    expect(width()).toBe(500)
    await pointer('pointermove', 0, 8)
    await pointer('pointercancel', 0, 8)
    expect(width()).toBe(500)
    expect(document.body.style.cursor).toBe('col-resize')
    await pointer('pointercancel', 0)
    expect(width()).toBe(500)
    expect(window.localStorage.getItem(widthStorageKey)).toBe('500')
    expect(divider().hasPointerCapture(7)).toBe(false)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    await pointer('pointermove', 0)
    expect(width()).toBe(500)
  })

  it.each([
    [1180, 280, 779], [821, 280, 420], [681, 280, 280],
    [600, 599 * 280 / 680, 599 * 280 / 680],
    [240, 239 * 280 / 680, 239 * 280 / 680],
  ])('fits both panes in a %ipx container, excluding the divider', async (available, min, max) => {
    bounds.width = available
    await mountSplit()
    await pointer('pointerdown', bounds.left + width())
    await pointer('pointermove', 0)
    expect(width()).toBeCloseTo(min)
    await pointer('pointerup', 4000)
    expect(width()).toBeCloseTo(max)
    // CSSOM simplifies calc(), including rounding its fractional pixel values.
    expect(Number(inspectorPane().style.width.match(/- ([\d.]+)px/)?.[1])).toBeCloseTo(width() + 1)
    expect(width()).toBeGreaterThan(0)
    expect(available - width() - 1).toBeGreaterThanOrEqual(Math.min(400, (available - 1) * 400 / 680))
  })

  it('reclamps on container-only resize and restores the preference after phone layout', async () => {
    await mountSplit()
    await pointer('pointerdown', bounds.left + 420)
    await pointer('pointerup', bounds.left + 700)
    resize(260, 900)
    expect(width()).toBe(499)
    resize(0, 390)
    expect(width()).toBeCloseTo(389 * 280 / 680)
    expect(chatPane().classList.contains('max-md:hidden')).toBe(true)
    expect(divider().classList.contains('max-md:hidden')).toBe(true)
    expect(inspectorPane().classList.contains('max-md:!w-full')).toBe(true)
    resize(260, 1180)
    expect(width()).toBe(700)
    expect(window.localStorage.getItem(widthStorageKey)).toBe('700')
    await click('Close')
    resize(260, 750)
    await click('Results')
    expect(width()).toBe(349)
    const body = chatPane().parentElement!
    view.unmount()
    expect(resizeObservers.has(body)).toBe(false)
  })

  it('reclamps when the sidebar expands and uses its collapsed offset on the next drag', async () => {
    bounds = { left: 56, width: 1000 }
    window.innerWidth = 1056
    window.localStorage.setItem(widthStorageKey, '580')
    await mountSplit()
    expect(width()).toBe(580)
    resize(260, 796)
    expect(width()).toBe(395)
    resize(56, 1000)
    expect(width()).toBe(580)
    await pointer('pointerdown', 56 + 580 + 6)
    await pointer('pointerup', 56 + 581 + 6)
    expect(width()).toBe(581)
  })

  it('applies the same container geometry in the classic editor', async () => {
    await mountSplit(false)
    await click('Open result')
    await pointer('pointerdown', bounds.left + 420 + 3)
    await pointer('pointermove', bounds.left + 421 + 3)
    expect(width()).toBe(421)
    await pointer('pointerup', 4000)
    expect(width()).toBe(779)
  })

  it.each(['Document', 'Spreadsheet'])('scrolls %s preview tabs separately from pinned controls in a narrow pane', async noun => {
    window.innerWidth = 768
    bounds = { left: 260, width: 508 }
    gadgets = [{ ...app, title: 'A long research report title', output: {
      id: noun.toLowerCase(), noun, plural: `${noun}s`, icon: 'fileText',
    } }]
    search.pane = 'gadget'
    await mountSplit()
    expect(width()).toBeCloseTo(507 * 280 / 680)
    const pinned = control('Close app pane').parentElement!
    const header = pinned.parentElement!
    const tabs = control(noun, header).parentElement!
    expect(tabs.parentElement).toBe(header)
    expect(tabs.classList.contains('min-w-0')).toBe(true)
    expect(tabs.classList.contains('overflow-x-auto')).toBe(true)
    expect(pinned.classList.contains('flex-shrink-0')).toBe(true)
    expect([...tabs.children].map(tab => tab.textContent)).toEqual([noun, 'Code', 'Connections'])
    expect([...tabs.children].every(tab => tab.classList.contains('shrink-0') && tab.classList.contains('whitespace-nowrap'))).toBe(true)
    for (const label of ['Export output', 'Enter full screen', 'Close app pane']) {
      expect(pinned.contains(control(label, header))).toBe(true)
      expect(tabs.contains(control(label, header))).toBe(false)
    }
    for (const label of ['Code', 'Connections', noun]) {
      await click(label, tabs)
      expect(control(label, tabs).getAttribute('aria-pressed')).toBe('true')
      expect(tabs.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
    }
    resize(56, 712)
    expect(control(noun, tabs).getAttribute('aria-pressed')).toBe('true')
    await click('Enter full screen', pinned)
    expect(document.querySelector('[role="dialog"][aria-label="App full screen"]')).not.toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role="dialog"][aria-label="App full screen"]')).toBeNull()
    await click('Close app pane', pinned)
    expect(chatPane().classList.contains('max-md:hidden')).toBe(false)
  })

  it('keeps a long Results list in a bounded scroller with a current, selectable row', async () => {
    gadgets = Array.from({ length: 80 }, (_, index) => ({ ...app, id: index + 1, title: `Result ${index + 1}` }))
    search.w = 40
    await mountSplit()
    // Opening ?w= first previews the app; return to Results to inspect its selection.
    await click('Results')
    let scroller = inspectorPane().querySelector<HTMLElement>('.overflow-y-auto')!
    const current = control('Result 40', scroller)
    expect(scroller.classList.contains('h-full')).toBe(true)
    expect(scroller.classList.contains('overflow-y-auto')).toBe(true)
    expect(scroller.parentElement!.classList.contains('min-h-0')).toBe(true)
    expect(scroller.parentElement!.classList.contains('overflow-hidden')).toBe(true)
    expect(scroller.querySelectorAll('button')).toHaveLength(80)
    expect(scroller.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(current.getAttribute('aria-current')).toBe('page')
    expect(control('Result 80', scroller).hasAttribute('aria-current')).toBe(false)
    expect([...scroller.children].every(row => row.classList.contains('shrink-0'))).toBe(true)
    await click('Result 80', scroller)
    const navigation = navigate.mock.lastCall![0] as { search: (previous: typeof search) => typeof search }
    search = navigation.search(search)
    expect(search.w).toBe(80)
    await renderEditor()
    expect(document.querySelector('[aria-label="App content"]')!.closest('.hidden')).toBeNull()
    await click('Results')
    scroller = inspectorPane().querySelector<HTMLElement>('.overflow-y-auto')!
    expect(control('Result 80', scroller).getAttribute('aria-current')).toBe('page')
    expect(control('Result 40', scroller).hasAttribute('aria-current')).toBe(false)
  })
})
