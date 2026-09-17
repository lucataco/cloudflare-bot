// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi, Group } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import { Route as AgentsRoute } from './routes/agents'
import { Route as AgentRoute } from './routes/agents_.$id'
import { Route as GroupRoute } from './routes/groups.$id'
import AgentSettingsPane from './components/AgentSettingsPane'
import type GadgetEditor from './GadgetEditor'

const context = vi.hoisted(() => ({
  api: {}, id: 'one', create: undefined as 'bot' | undefined,
  enabled: true, loading: false, navigate: vi.fn<(options: unknown) => void>(),
  settings: false,
}))
const toasts = vi.hoisted(() => ({ add: vi.fn<(toast: unknown) => void>() }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => toasts,
}))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: context.api }) }))
vi.mock('./FeatureFlagsContext', () => ({ useUiFeatureFlag: () => context }))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Gadgets' }))
vi.mock('@tanstack/react-router', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => context.navigate,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('./components/FirstBotSetup', () => ({ default: () => <h1>Create your first bot</h1> }))
vi.mock('./components/AgentRoster', () => ({ default: () => <input aria-label="Creation draft" /> }))
vi.mock('./GadgetEditor', () => ({
  default: function Editor({ workspaceId, messenger }: NonNullable<ComponentProps<typeof GadgetEditor>>) {
    // Mirror the editor's profile propagation, but mount the real settings fields.
    const [profile, setProfile] = useState(messenger?.agent)
    useEffect(() => setProfile(messenger?.agent), [messenger?.agent])
    return <section aria-label="Editor">
      {workspaceId}<input aria-label="Message draft" />
      {context.settings && profile && <AgentSettingsPane
        agent={profile} authenticatedApi={context.api as RpcStub<AuthenticatedApi>} onUpdated={setProfile}
      />}
    </section>
  },
}))

const view = makeTestRoot()
const agent: AgentProfile = {
  id: 'one', name: 'One', title: 'Research assistant', description: '', workspaceId: 'workspace-one',
  defaultModelId: null, created: new Date(0), updated: new Date(0),
}
const group: Group = {
  id: 'one', name: 'One', memberAgentIds: [], workspaceId: 'workspace-one',
  created: new Date(0), updated: new Date(0),
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function makeApi() {
  const api = {
    listAgents: vi.fn<AuthenticatedApi['listAgents']>().mockResolvedValue([]),
    listGroups: vi.fn<AuthenticatedApi['listGroups']>().mockResolvedValue([]),
    listModels: vi.fn<AuthenticatedApi['listModels']>().mockResolvedValue([]),
    updateAgent: vi.fn<AuthenticatedApi['updateAgent']>(),
    subscribeConnectedAccounts: vi.fn<() => Promise<unknown> & Disposable>(() => Object.assign(new Promise(() => {}), {
      [Symbol.dispose]: vi.fn<() => void>(),
    })),
  }
  context.api = api
  return api
}
async function render(route: { options: { component?: unknown } } = AgentsRoute) {
  const Page = route.options.component as ComponentType & { preload?: () => Promise<unknown> }
  await Page.preload?.()
  return view.render(<Page />)
}
async function retry() {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Retry')!
  expect(button).toBeDefined()
  await act(async () => button.click())
}
const text = () => document.body.textContent
const editor = () => document.querySelector('[aria-label="Editor"]')

beforeEach(() => {
  Object.assign(context, { id: 'one', create: undefined, enabled: true, loading: false, settings: false })
  vi.spyOn(AgentsRoute, 'useSearch').mockImplementation(() => ({ create: context.create }))
  vi.spyOn(AgentRoute, 'useParams').mockImplementation(() => ({ id: context.id }))
  vi.spyOn(GroupRoute, 'useParams').mockImplementation(() => ({ id: context.id }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  view.cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const description = () => document.querySelector<HTMLTextAreaElement>('textarea')!
async function save() {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Save')!
  await act(async () => button.click())
}

describe('settings drafts during metadata refresh', () => {
  beforeEach(() => {
    // The existing nested Kumo labels warn in development; keep these draft regressions focused.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  async function editDescription(value: string) {
    const input = description()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const canonical = { ...agent, name: 'Canonical name', title: 'Canonical job', description: 'Canonical description', notifyOnUpdates: false }

  it.each(['identical', 'changed'] as const)('keeps a real Description draft after focus returns %s metadata, then applies the saved values', async change => {
    const api = makeApi()
    context.settings = true
    api.listAgents.mockResolvedValue([agent])
    await render(AgentRoute)
    await editDescription('  Unsaved description  ')
    const input = description()
    api.listAgents.mockResolvedValue([{ ...agent, description: change === 'changed' ? 'Edited on another device' : agent.description }])
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.listAgents).toHaveBeenCalledTimes(2)
    expect(description()).toBe(input)
    expect(description().value).toBe('  Unsaved description  ')

    api.updateAgent.mockResolvedValue(canonical)
    await save()
    expect(api.updateAgent).toHaveBeenCalledExactlyOnceWith(agent.id, {
      name: agent.name, title: agent.title, description: 'Unsaved description',
      defaultModelId: null, defaultBindings: [], notifyOnUpdates: true,
    })
    expect(description().value).toBe(canonical.description)
    for (const [label, value] of [['Name', canonical.name], ['Job', canonical.title]]) {
      const field = [...document.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label)
      expect(field?.querySelector('input')?.value).toBe(value)
    }

    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(description().value).toBe(canonical.description)
  })

  it('applies canonical save values without needing an onUpdated callback and retains a failed-save draft', async () => {
    const api = makeApi()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={context.api as RpcStub<AuthenticatedApi>} />)
    await editDescription('Unsaved description')
    api.updateAgent.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(canonical)
    await save()
    expect(description().value).toBe('Unsaved description')
    await save()
    expect(description().value).toBe(canonical.description)
  })

  it.each(['agent', 'api'] as const)('resets on %s identity changes and ignores a former identity\'s save', async change => {
    const oldApi = makeApi()
    const pending = deferred<AgentProfile>()
    oldApi.updateAgent.mockReturnValueOnce(pending.promise)
    const onUpdated = vi.fn<(profile: AgentProfile) => void>()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={context.api as RpcStub<AuthenticatedApi>} onUpdated={onUpdated} />)
    await editDescription('Former identity draft')
    await save()
    const nextApi = change === 'api' ? makeApi() : oldApi
    const nextAgent = { ...agent, id: change === 'agent' ? 'two' : agent.id, description: 'New identity description' }
    await view.render(<AgentSettingsPane agent={nextAgent} authenticatedApi={context.api as RpcStub<AuthenticatedApi>} onUpdated={onUpdated} />)
    expect(description().value).toBe(nextAgent.description)
    expect(description().disabled).toBe(false)
    await editDescription('New identity draft')
    const nextSave = deferred<AgentProfile>()
    nextApi.updateAgent.mockReturnValueOnce(nextSave.promise)
    await save()
    await act(async () => pending.resolve(canonical))
    expect(description().value).toBe('New identity draft')
    expect(description().disabled).toBe(true)
    expect(onUpdated).not.toHaveBeenCalled()
    expect(toasts.add).not.toHaveBeenCalled()
    await act(async () => nextSave.resolve({ ...nextAgent, description: 'New saved description' }))
    expect(description().value).toBe('New saved description')
    expect(description().disabled).toBe(false)
    expect(onUpdated).toHaveBeenCalledOnce()
  })
})

describe('bots landing reads', () => {
  it.each(['listAgents', 'listGroups'] as const)('%s failure is not first-bot setup; retry verifies empty', async method => {
    const api = makeApi()
    api[method].mockRejectedValueOnce(new Error('offline'))
    await render()
    expect(text()).toContain('Could not load bots and groups.')
    expect(text()).not.toContain('Create your first bot')
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/')
    await retry()
    expect(text()).toContain('Create your first bot')
    expect(api[method]).toHaveBeenCalledTimes(2)
  })

  it.each(['listAgents', 'listGroups'] as const)('%s retries can redirect to a populated thread', async method => {
    const api = makeApi()
    api[method].mockRejectedValueOnce(new Error('offline'))
    await render()
    api.listAgents.mockResolvedValue([agent])
    await retry()
    expect(context.navigate).toHaveBeenCalledWith({ to: '/agents/$id', params: { id: 'one' }, replace: true })
    expect(text()).not.toContain('Create your first bot')
  })

  it.each(['create', 'loading', 'disabled'] as const)('does not carry verified empty across %s interruption', async change => {
    const api = makeApi()
    await render()
    expect(text()).toContain('Create your first bot')
    if (change === 'create') context.create = 'bot'
    else if (change === 'loading') context.loading = true
    else context.enabled = false
    await render()
    const pending = deferred<AgentProfile[]>()
    api.listAgents.mockReturnValueOnce(pending.promise)
    Object.assign(context, { create: undefined, loading: false, enabled: true })
    await render()
    expect(document.querySelector('[aria-label="Loading bots"]')).not.toBeNull()
    expect(text()).not.toContain('Create your first bot')
    await act(async () => pending.reject(new Error('offline')))
    expect(text()).toContain('Could not load bots and groups.')
  })

  it('discards former API reads and verified empty on API replacement', async () => {
    const old = makeApi()
    await render()
    expect(text()).toContain('Create your first bot')
    const next = makeApi()
    const pending = deferred<AgentProfile[]>()
    next.listAgents.mockReturnValueOnce(pending.promise)
    await render()
    expect(text()).not.toContain('Create your first bot')
    const newest = makeApi()
    newest.listGroups.mockRejectedValueOnce(new Error('offline'))
    await render()
    await act(async () => pending.resolve([agent]))
    expect(text()).toContain('Could not load bots and groups.')
    expect(context.navigate).not.toHaveBeenCalled()
    expect(old.listAgents).toHaveBeenCalledOnce()
  })
})

describe.each([
  { kind: 'bot', route: AgentRoute, method: 'listAgents' as const, record: agent, missing: 'Bot not found' },
  { kind: 'group', route: GroupRoute, method: 'listGroups' as const, record: group, missing: 'Group not found' },
])('$kind metadata', ({ kind, route, method, record, missing }) => {
  // The two routes have the same metadata lifecycle; each still calls its own real RPC method.
  const mount = () => render(route)
  it.each([false, true])('distinguishes failure from verified absence, then retries (found=%s)', async found => {
    const api = makeApi()
    api[method].mockRejectedValueOnce(new Error('offline'))
    await mount()
    expect(text()).toContain(`Could not load ${kind}.`)
    expect(text()).not.toContain(missing)
    expect(document.querySelector('a')?.getAttribute('href')).toBe('/agents')
    api[method].mockResolvedValue(found ? [record] as AgentProfile[] & Group[] : [])
    await retry()
    expect(found ? editor()?.textContent : text()).toContain(found ? 'workspace-one' : missing)
  })

  it('retains the editor, focus and draft across same-identity focus refresh failure and retry', async () => {
    const api = makeApi()
    api[method].mockResolvedValue([record] as AgentProfile[] & Group[])
    await mount()
    const input = document.querySelector<HTMLInputElement>('[aria-label="Message draft"]')!
    input.value = 'Keep this draft'
    input.focus()
    const pending = deferred<AgentProfile[] & Group[]>()
    api[method].mockReturnValueOnce(pending.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(document.activeElement).toBe(input)
    expect(editor()).not.toBeNull()
    await act(async () => pending.reject(new Error('offline')))
    expect(text()).toContain('Showing previously loaded details.')
    expect(text()).not.toContain(missing)
    await retry()
    expect(document.querySelector('[aria-label="Message draft"]')).toBe(input)
    expect(input.value).toBe('Keep this draft')
  })

  it.each(['route', 'api'] as const)('never renders former content after a %s identity change, ignoring late results', async change => {
    const api = makeApi()
    api[method].mockResolvedValue([record] as AgentProfile[] & Group[])
    await mount()
    const oldInput = document.querySelector('[aria-label="Message draft"]')
    const oldRefresh = deferred<AgentProfile[] & Group[]>()
    api[method].mockReturnValueOnce(oldRefresh.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
    const pending = deferred<AgentProfile[] & Group[]>()
    const nextApi = change === 'api' ? makeApi() : api
    if (change === 'route') context.id = 'two'
    nextApi[method].mockReturnValueOnce(pending.promise)
    await mount()
    expect(editor()).toBeNull()
    expect(text()).toContain(`Loading ${kind}...`)
    await act(async () => oldRefresh.resolve([record] as AgentProfile[] & Group[]))
    expect(editor()).toBeNull()
    await act(async () => pending.resolve([{ ...record, id: context.id, workspaceId: 'workspace-two' }] as AgentProfile[] & Group[]))
    expect(editor()?.textContent).toContain('workspace-two')
    expect(document.querySelector('[aria-label="Message draft"]')).not.toBe(oldInput)
  })

  it('clears confirmed missing on route change and ignores superseded focus failures', async () => {
    const api = makeApi()
    await mount()
    expect(text()).toContain(missing)
    context.id = 'two'
    const pending = deferred<AgentProfile[] & Group[]>()
    api[method].mockReturnValueOnce(pending.promise)
    await mount()
    expect(text()).not.toContain(missing)
    api[method].mockResolvedValue([{ ...record, id: 'two' }] as AgentProfile[] & Group[])
    await act(async () => window.dispatchEvent(new Event('focus')))
    await act(async () => pending.reject(new Error('late failure')))
    expect(editor()).not.toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
