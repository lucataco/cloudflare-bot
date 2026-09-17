// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import {
  createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi, Group } from '@gadgets/workshop-shared/api'
import { DEFAULT_UI_FEATURE_FLAGS, type UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'
import { makeTestRoot } from './action-test-harness'
import { FeatureFlagsProvider } from './FeatureFlagsContext'
import { AGENTS_CHANGED_EVENT } from './agentsChanged'
import { persistLastThread, readLastThread } from './lastThread'
import { Route as AgentsRoute } from './routes/agents'
import { Route as WorkspacesRoute } from './routes/workspaces'
import AgentRoster from './components/AgentRoster'
import CommandPalette from './components/AppShell/CommandPalette'

const auth = vi.hoisted(() => ({ api: {} }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: auth.api }) }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('./components/GadgetList', () => ({ default: () => null }))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  const toasts = { add: vi.fn<(toast: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})

const view = makeTestRoot()
const agent: AgentProfile = {
  id: 'existing-bot', name: 'Existing bot', title: 'Research assistant', description: '',
  workspaceId: 'existing-workspace', defaultModelId: null, created: new Date(0), updated: new Date(0),
}
const newAgent: AgentProfile = { ...agent, id: 'new-bot', name: 'New bot', workspaceId: 'new-workspace' }
const group: Group = {
  id: 'team', name: 'Team', workspaceId: 'team-workspace', memberAgentIds: [agent.id],
  created: new Date(0), updated: new Date(0),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function makeApi(agentShell = true) {
  const api = {
    getUiFeatureFlags: vi.fn<AuthenticatedApi['getUiFeatureFlags']>()
      .mockResolvedValue({ ...DEFAULT_UI_FEATURE_FLAGS, agentShell }),
    listAgents: vi.fn<AuthenticatedApi['listAgents']>().mockResolvedValue([agent]),
    listGroups: vi.fn<AuthenticatedApi['listGroups']>().mockResolvedValue([]),
    listModels: vi.fn<AuthenticatedApi['listModels']>().mockResolvedValue([]),
    listGadgets: vi.fn<AuthenticatedApi['listGadgets']>().mockResolvedValue([]),
    listOutputs: vi.fn<AuthenticatedApi['listOutputs']>().mockResolvedValue({ outputs: [], catchingUp: false }),
    listOwnBlueprints: vi.fn<AuthenticatedApi['listOwnBlueprints']>().mockResolvedValue([]),
    listLibraryBlueprints: vi.fn<AuthenticatedApi['listLibraryBlueprints']>().mockResolvedValue([]),
    listOutputFormats: vi.fn<AuthenticatedApi['listOutputFormats']>().mockResolvedValue([]),
    subscribeConnectedAccounts: vi.fn<() => Promise<unknown> & Disposable>(() => Object.assign(new Promise(() => {}), {
      [Symbol.dispose]: vi.fn<() => void>(),
    })),
    createAgent: vi.fn<AuthenticatedApi['createAgent']>().mockResolvedValue(newAgent),
    createGroup: vi.fn<AuthenticatedApi['createGroup']>(),
    newGadget: vi.fn<AuthenticatedApi['newGadget']>(),
    newGadgetFromBlueprint: vi.fn<AuthenticatedApi['newGadgetFromBlueprint']>(),
  }
  auth.api = api
  return api
}

// Wire the real routes as routeTree.gen.ts does, with lightweight destinations instead of editors.
async function renderAt(initialEntry: string, { shell = false, palette = false } = {}) {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const rootRoute = createRootRoute({
    component: function Layout() {
      const [open, setOpen] = useState(palette)
      return (
        <>
          {shell && <>
            <aside aria-label="Desktop bots"><AgentRoster variant="rail" /></aside>
            <aside aria-label="Mobile bots"><AgentRoster variant="rail" /></aside>
          </>}
          {palette && <CommandPalette open={open} onClose={() => setOpen(false)} />}
          <Outlet />
        </>
      )
    },
  })
  const agentsRoute = AgentsRoute.update({
    id: '/agents', path: '/agents', getParentRoute: () => rootRoute,
  } as never)
  const workspacesRoute = WorkspacesRoute.update({
    id: '/workspaces', path: '/workspaces', getParentRoute: () => rootRoute,
  } as never)
  const targets = ['/', '/agents/$id', '/groups/$id', '/blueprints', '/explore', '/outputs'].map(path => createRoute({
    getParentRoute: () => rootRoute, path, component: () => null,
  }))
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren([agentsRoute, workspacesRoute, ...targets]),
  })
  await router.load()
  await view.render(<FeatureFlagsProvider><RouterProvider router={router} /></FeatureFlagsProvider>)
  return router
}

function dialogButton(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(candidate => candidate.textContent === label)
  expect(button, `dialog button: ${label}`).toBeDefined()
  return button!
}

function expectNoCreation(api: ReturnType<typeof makeApi>) {
  expect(api.createAgent).not.toHaveBeenCalled()
  expect(api.createGroup).not.toHaveBeenCalled()
  expect(api.newGadget).not.toHaveBeenCalled()
  expect(api.newGadgetFromBlueprint).not.toHaveBeenCalled()
}

afterEach(() => {
  view.cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('bot creation intent', () => {
  it('opens only the route-local dialog ahead of the last bot without creating or prefilling from search', async () => {
    const api = makeApi()
    persistLastThread({ kind: 'agent', id: agent.id })
    const router = await renderAt('/agents?create=bot&name=Injected', { shell: true })

    expect(router.state.location.pathname).toBe('/agents')
    expect(router.state.matches.at(-1)?.search).toMatchObject({ create: 'bot' })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector<HTMLInputElement>('#agent-name')?.value).toBe('')
    expect(document.querySelector('h1')?.textContent).not.toBe('Create your first bot')
    expect(readLastThread()).toEqual({ kind: 'agent', id: agent.id })
    expectNoCreation(api)
  })

  it.each(['true', '1', 'agent', 'Bot', '%5B%22bot%22%5D', '%7B%22type%22%3A%22bot%22%7D'])(
    'does not accept create=%s as creation intent', async (value) => {
      const api = makeApi()
      const router = await renderAt(`/agents?create=${value}`)
      expect(router.state.location.pathname).toBe(`/agents/${agent.id}`)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expectNoCreation(api)
    },
  )

  it('keeps plain empty /agents on FirstBotSetup without auto-creating', async () => {
    const api = makeApi()
    api.listAgents.mockResolvedValue([])
    const router = await renderAt('/agents')
    expect(router.state.location.pathname).toBe('/agents')
    expect(document.querySelector('h1')?.textContent).toBe('Create your first bot')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expectNoCreation(api)
  })

  it('offers recovery of hidden bots instead of first-bot onboarding when every bot is hidden', async () => {
    const api = makeApi()
    api.listAgents.mockResolvedValue([{ ...agent, hidden: true }])
    const router = await renderAt('/agents')
    expect(router.state.location.pathname).toBe('/agents')
    expect(document.body.textContent).not.toContain('Create your first bot')
    const show = [...document.querySelectorAll('button')].find(button => button.textContent === 'Show hidden bots')!
    expect(show).toBeDefined()
    await act(async () => show.click())
    expect(document.querySelector(`a[href="/agents/${agent.id}"]`)).not.toBeNull()
    expectNoCreation(api)
  })

  it.each(['agent', 'group', 'missing'] as const)('preserves the plain /agents last-thread choice: %s', async (kind) => {
    const api = makeApi()
    const other = { ...agent, id: 'other-bot' }
    api.listAgents.mockResolvedValue([other, agent])
    api.listGroups.mockResolvedValue([group])
    persistLastThread(kind === 'group' ? { kind, id: group.id } : {
      kind: 'agent', id: kind === 'missing' ? 'deleted-bot' : agent.id,
    })
    const router = await renderAt('/agents')
    expect(router.state.location.pathname).toBe(kind === 'group' ? `/groups/${group.id}`
      : `/agents/${kind === 'missing' ? other.id : agent.id}`)
    expect(router.history.length).toBe(1)
    expectNoCreation(api)
  })

  it.each([false, true])('cancel replaces with plain /agents before normal landing (empty=%s)', async (empty) => {
    const api = makeApi()
    if (empty) api.listAgents.mockResolvedValue([])
    const router = await renderAt('/agents?create=bot&other=discard')
    const pending = deferred<AgentProfile[]>()
    api.listAgents.mockReturnValueOnce(pending.promise)
    await act(async () => dialogButton('Cancel').click())

    expect(router.state.location.pathname).toBe('/agents')
    expect(router.state.location.search).toEqual({})
    expect(router.history.length).toBe(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expectNoCreation(api)

    await act(async () => pending.resolve(empty ? [] : [agent]))
    expect(router.state.location.pathname).toBe(empty ? '/agents' : `/agents/${agent.id}`)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('h1')?.textContent).toBe(empty ? 'Create your first bot' : undefined)
  })

  it('submits only on confirmation, replaces with the new bot, and refreshes sibling rosters', async () => {
    const api = makeApi()
    const dispatch = vi.spyOn(window, 'dispatchEvent')
    const router = await renderAt('/agents?create=bot&other=discard', { shell: true })
    await act(async () => dialogButton('Create bot').click())
    expectNoCreation(api)
    await act(async () => {
      for (const [id, value] of [['agent-name', 'New bot'], ['agent-title', 'Research assistant']]) {
        const input = document.getElementById(id)!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    expectNoCreation(api)
    api.listAgents.mockResolvedValue([agent, newAgent])
    await act(async () => dialogButton('Create bot').click())

    expect(api.createAgent).toHaveBeenCalledOnce()
    expect(api.createAgent.mock.calls[0].slice(0, 3)).toEqual(['New bot', 'Research assistant', ''])
    expect(router.state.location.pathname).toBe(`/agents/${newAgent.id}`)
    expect(router.state.location.search).toEqual({})
    expect(router.history.length).toBe(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(readLastThread()).toEqual({ kind: 'agent', id: newAgent.id })
    expect(dispatch.mock.calls.filter(([event]) => event.type === AGENTS_CHANGED_EVENT)).toHaveLength(1)
    expect(document.querySelectorAll(`aside a[href="/agents/${newAgent.id}"]`)).toHaveLength(2)
  })

  it.each([true, false])('waits for flags before opening or redirecting (agentShell=%s)', async (agentShell) => {
    const api = makeApi()
    const flags = deferred<UiFeatureFlags>()
    api.getUiFeatureFlags.mockReturnValue(flags.promise)
    const router = await renderAt('/agents?create=bot')
    expect(router.state.location.pathname).toBe('/agents')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(api.listAgents).not.toHaveBeenCalled()

    await act(async () => flags.resolve({ ...DEFAULT_UI_FEATURE_FLAGS, agentShell }))
    expect(router.state.location.pathname).toBe(agentShell ? '/agents' : '/')
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(agentShell ? 1 : 0)
    expect(router.state.location.search).toEqual(agentShell ? { create: 'bot' } : {})
    expect(router.history.length).toBe(1)
    expect(api.listAgents).toHaveBeenCalledTimes(agentShell ? 1 : 0)
    expectNoCreation(api)
  })

  it.each(['existing', 'empty', 'error'])('ignores a late %s landing response once intent is active', async (result) => {
    const api = makeApi()
    const pending = deferred<AgentProfile[]>()
    api.listAgents.mockReturnValueOnce(pending.promise)
    const router = await renderAt('/agents')
    await act(async () => router.navigate({ to: '/agents', search: { create: 'bot' } }))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      if (result === 'error') pending.reject(new Error('offline'))
      else pending.resolve(result === 'empty' ? [] : [agent])
    })
    expect(router.state.location.pathname).toBe('/agents')
    expect(router.state.location.search).toEqual({ create: 'bot' })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(readLastThread()).toBeNull()
    expectNoCreation(api)
  })
})

describe('bot creation entry points', () => {
  it('keeps a shell roster\'s own create/cancel controls local without route intent', async () => {
    const api = makeApi()
    const router = await renderAt('/workspaces', { shell: true })
    await act(async () => document.querySelector<HTMLButtonElement>('aside [title="Create new bot"]')!.click())
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await act(async () => dialogButton('Cancel').click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(router.state.location.pathname).toBe('/workspaces')
    expect(router.state.location.search).toEqual({})
    expectNoCreation(api)
  })

  it.each([true, false])('Workspaces links to explicit creation only in agentShell=%s', async (agentShell) => {
    const api = makeApi(agentShell)
    const router = await renderAt('/workspaces')
    const link = document.querySelector<HTMLAnchorElement>('header a')!
    expect(link.textContent).toBe(agentShell ? 'Create bot' : 'Create workspace')
    expect(link.getAttribute('href')).toBe(agentShell ? '/agents?create=bot' : '/')
    await act(async () => link.click())
    expect(router.state.location.pathname).toBe(agentShell ? '/agents' : '/')
    expect(router.state.location.search).toEqual(agentShell ? { create: 'bot' } : {})
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(agentShell ? 1 : 0)
    expectNoCreation(api)
  })

  it.each([true, false])('CommandPalette labels and routes creation for agentShell=%s', async (agentShell) => {
    const api = makeApi(agentShell)
    // jsdom has no layout or scrolling, but the real palette scrolls its active action into view.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
    const router = await renderAt('/workspaces', { palette: true })
    const label = agentShell ? 'Create bot' : 'New workspace'
    expect(document.querySelector('[aria-label="Command palette"]')?.textContent).toContain(label)
    await act(async () => dialogButton(label).click())
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull()
    expect(router.state.location.pathname).toBe(agentShell ? '/agents' : '/')
    expect(router.state.location.search).toEqual(agentShell ? { create: 'bot' } : {})
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(agentShell ? 1 : 0)
    expectNoCreation(api)
  })

  it.each([
    ['Workspaces', '/workspaces'],
    ['Apps & documents', '/outputs'],
    ['Templates', '/blueprints'],
    ['Explore templates', '/explore'],
  ])('CommandPalette keeps the My work destination %s at %s', async (label, path) => {
    const api = makeApi(false)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
    const router = await renderAt('/', { palette: true })
    expect([...document.querySelectorAll('[aria-label="Command palette"] button')].map(button => button.textContent))
      .toEqual(['New workspace', 'Workspaces', 'Templates', 'Explore templates', 'Apps & documents'])
    await act(async () => dialogButton(label).click())
    expect(router.state.location.pathname).toBe(path)
    expect(router.state.location.search).toEqual({})
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expectNoCreation(api)
  })
})
