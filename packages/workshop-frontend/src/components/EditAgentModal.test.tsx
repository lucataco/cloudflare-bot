// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { flushFrames, makeOverseer, makeTestRoot } from '../action-test-harness'
import EditAgentModal from './EditAgentModal'
import CreateAgentModal from './CreateAgentModal'
import AgentSettingsPane from './AgentSettingsPane'
import { readLastThread } from '../lastThread'

const navigate = vi.hoisted(() => vi.fn<(options: unknown) => Promise<void>>().mockResolvedValue(undefined))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => navigate,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return { ...actual, useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }) }
})

const view = makeTestRoot()
const agent: AgentProfile = {
  id: 'bot-1', name: 'Riley', title: 'Research assistant', description: 'Summarize weekly research.',
  workspaceId: 'workspace-1', defaultModelId: null, defaultBindings: [], notifyOnUpdates: true,
  created: new Date(0), updated: new Date(0),
}
const models: AiChatAuthorInfo[] = [
  { type: 'agent', id: 'model-1', name: 'First model' },
  { type: 'agent', id: 'model-2', name: 'Second model' },
]
const automatic = 'Automatic: use an available model'
const updateAgent = vi.fn<AuthenticatedApi['updateAgent']>()
const deleteAgent = vi.fn<AuthenticatedApi['deleteAgent']>()
const publishAgentBlueprint = vi.fn<AuthenticatedApi['publishAgentBlueprint']>()
const duplicateAgent = vi.fn<AuthenticatedApi['duplicateAgent']>()
const subscriptionDispose = vi.fn<() => void>()
const subscribeConnectedAccounts = vi.fn<AuthenticatedApi['subscribeConnectedAccounts']>()
const listGatekeeperApps = vi.fn<AuthenticatedApi['listGatekeeperApps']>()
let authenticatedApi: RpcStub<AuthenticatedApi>

beforeEach(() => {
  vi.clearAllMocks()
  updateAgent.mockReset().mockResolvedValue(agent)
  publishAgentBlueprint.mockReset().mockResolvedValue('public-id')
  duplicateAgent.mockReset().mockResolvedValue({ ...agent, id: 'copy', workspaceId: 'fresh-workspace' })
  listGatekeeperApps.mockReset().mockResolvedValue([])
  subscribeConnectedAccounts.mockReset().mockImplementation(async () => new RpcStub(new class extends RpcTarget {
    [Symbol.dispose]() { subscriptionDispose() }
  }()))
  authenticatedApi = new RpcStub(new class extends RpcTarget {
    updateAgent(...args: Parameters<AuthenticatedApi['updateAgent']>) { return updateAgent(...args) }
    deleteAgent(...args: Parameters<AuthenticatedApi['deleteAgent']>) { return deleteAgent(...args) }
    subscribeConnectedAccounts(...args: Parameters<AuthenticatedApi['subscribeConnectedAccounts']>) {
      return subscribeConnectedAccounts(...args)
    }
    async listModels() { return models }
    listGatekeeperApps(agentId?: string) { return listGatekeeperApps(agentId) }
    publishAgentBlueprint(id: string) { return publishAgentBlueprint(id) }
    duplicateAgent(id: string) { return duplicateAgent(id) }
  }() as AuthenticatedApi)
})

afterEach(() => {
  view.cleanup()
  authenticatedApi[Symbol.dispose]()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  localStorage.clear()
})

function button(label: string | RegExp) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(element => {
    const name = element.textContent?.trim() ?? ''
    return typeof label === 'string' ? name === label : label.test(name)
  })
  expect(matches, `button: ${label}`).toHaveLength(1)
  return matches[0]
}

function field(label: string) {
  const element = [...document.querySelectorAll('label')].find(candidate => candidate.textContent?.trim() === label)
  expect(element, `label: ${label}`).toBeDefined()
  const control = element!.control
  expect(control, `control for ${label}`).not.toBeNull()
  return control as HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement
}

async function escape() {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

async function render(profile = agent) {
  const onCancel = vi.fn<() => void>()
  const onSuccess = vi.fn<(updated: AgentProfile) => void>()
  const onDelete = vi.fn<() => void>()
  function Harness() {
    const [visible, setVisible] = useState(true)
    return visible && <EditAgentModal
      visible agent={profile} models={models} authenticatedApi={authenticatedApi}
      onCancel={() => { onCancel(); setVisible(false) }}
      onSuccess={updated => { onSuccess(updated); setVisible(false) }}
      onDelete={onDelete}
    />
  }
  await view.render(<Harness />)
  flushFrames()
  return { onCancel, onSuccess, onDelete }
}

describe('EditAgentModal with real Kumo controls', () => {
  it('requires an explicit publication click and displays a usable public link', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await render()
    await act(async () => button('Share bot').click())
    expect(publishAgentBlueprint).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Anyone with the link')
    await act(async () => button('Publish public bot link').click())
    expect(publishAgentBlueprint).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(document.querySelector<HTMLInputElement>('[aria-label="Public bot link"]')?.value).toContain('/blueprint/public-id')
    await act(async () => button('Copy link').click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith(new URL('/blueprint/public-id', window.location.origin).href)
  })

  it('duplicates into the new thread, updates last-thread navigation and closes the dialog', async () => {
    const { onCancel } = await render()
    await act(async () => button('Duplicate bot').click())
    expect(duplicateAgent).toHaveBeenCalledExactlyOnceWith(agent.id)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith({ to: '/agents/$id', params: { id: 'copy' }, search: {} })
    expect(readLastThread()).toEqual({ kind: 'agent', id: 'copy' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers lifecycle and suggested connections from the main bot settings pane', async () => {
    const onUpdated = vi.fn<(profile: AgentProfile) => void>()
    updateAgent.mockResolvedValue({ ...agent, hidden: true })
    await view.render(<AgentSettingsPane agent={{ ...agent, pluginIds: ['github'] }} authenticatedApi={authenticatedApi} onUpdated={onUpdated} />)
    expect(document.body.textContent).toContain('Suggested connections: github')
    expect(button('Duplicate bot')).toBeDefined()
    await act(async () => button('Share bot').click())
    await act(async () => button('Publish public bot link').click())
    expect(publishAgentBlueprint).toHaveBeenCalledExactlyOnceWith(agent.id)
    await act(async () => button('Hide bot').click())
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ hidden: true }))
  })

  it('hides a bot without deleting its data', async () => {
    await render()
    await act(async () => button('Hide bot').click())
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(agent.id, {hidden: true})
    expect(deleteAgent).not.toHaveBeenCalled()
  })

  it('labels the populated fields and exposes the Advanced disclosure state and model label', async () => {
    await render()
    expect((field('Name *') as HTMLInputElement).value).toBe(agent.name)
    expect((field('Job *') as HTMLInputElement).value).toBe(agent.title)
    expect((field('Description') as HTMLTextAreaElement).value).toBe(agent.description)
    // Kumo Input supplies its own accessible name unless aria-labelledby overrides it.
    for (const label of ['Name *', 'Job *']) {
      expect(document.getElementById(field(label).getAttribute('aria-labelledby')!)?.textContent?.trim()).toBe(label)
    }
    const advanced = button(/Advanced$/)
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(advanced.getAttribute('aria-controls')!)).toBeNull()

    await act(async () => advanced.click())
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    const model = field('Default Model')
    expect(model.getAttribute('role')).toBe('combobox')
    expect(document.getElementById(model.getAttribute('aria-labelledby')!)?.textContent?.trim()).toBe('Default Model')
    expect(document.getElementById(advanced.getAttribute('aria-controls')!)?.contains(model)).toBe(true)
    await act(async () => advanced.click())
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(updateAgent).not.toHaveBeenCalled()
  })

  it.each(['Escape', 'Cancel'])('%s discards edits without updating and disposes the subscription', async dismissal => {
    const { onCancel, onSuccess, onDelete } = await render()
    await act(async () => {
      const name = field('Name *')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Unsaved name')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((field('Name *') as HTMLInputElement).value).toBe('Unsaved name')
    if (dismissal === 'Escape') await escape()
    else await act(async () => button('Cancel').click())

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    expect(updateAgent).not.toHaveBeenCalled()
    expect(deleteAgent).not.toHaveBeenCalled()
    expect(subscribeConnectedAccounts).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it.each([null, models[1].id])('shows and saves the existing default model %s without substituting another model', async defaultModelId => {
    const profile = { ...agent, defaultModelId }
    updateAgent.mockResolvedValue(profile)
    const { onCancel, onSuccess } = await render(profile)
    await act(async () => button(/Advanced$/).click())
    expect.soft(field('Default Model').textContent).toBe(defaultModelId === null ? automatic : models[1].name)
    expect(updateAgent).not.toHaveBeenCalled()

    await act(async () => button('Save Changes').click())
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(agent.id, {
      name: agent.name, title: agent.title, description: agent.description,
      avatar: null, defaultModelId, defaultBindings: [], notifyOnUpdates: true,
    })
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(profile)
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('blocks dismissal while saving and keeps the subscription until the successful close', async () => {
    let resolve!: (updated: AgentProfile) => void
    updateAgent.mockReturnValue(new Promise<AgentProfile>(done => { resolve = done }))
    const { onCancel, onSuccess } = await render()
    await act(async () => button(/Advanced$/).click())
    const dialog = document.querySelector('[role="dialog"]')!
    await act(async () => button('Save Changes').click())

    expect(updateAgent).toHaveBeenCalledOnce()
    for (const label of ['Name *', 'Job *', 'Description', 'Default Model']) expect(field(label).disabled).toBe(true)
    for (const label of ['Cancel', 'Delete bot']) expect(button(label).disabled).toBe(true)
    expect(button(/Advanced$/).disabled).toBe(true)
    await act(async () => button('Cancel').click())
    await escape()
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(subscriptionDispose).not.toHaveBeenCalled()

    await act(async () => resolve(agent))
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith(agent)
    expect(onCancel).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })
})

describe('automatic model wording across bot settings', () => {
  it('embeds delegation only for the owner source workspace and never calls its RPC on ordinary saves', async () => {
    // Deliberately lacks delegation methods: normal profile settings must still work.
    const { overseer } = makeOverseer()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner />)
    expect(button('Advanced: Named delegation').getAttribute('aria-expanded')).toBe('false')
    await act(async () => button('Save').click())
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(agent.id, {
      name: agent.name, title: agent.title, description: agent.description,
      defaultModelId: null, defaultBindings: [], notifyOnUpdates: true,
    })
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner={false} />)
    expect(document.querySelector('[aria-label="Named delegation"]')).toBeNull()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId="other-workspace" isOwner />)
    expect(document.querySelector('[aria-label="Named delegation"]')).toBeNull()
  })

  it('saves edited suggested prompts and sends none when untouched', async () => {
    const { overseer } = makeOverseer()
    updateAgent.mockResolvedValue({ ...agent, starters: ['Plan my day', 'Summarize my week'] })
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner />)
    await act(async () => button('Save').click())
    expect(updateAgent).toHaveBeenLastCalledWith(agent.id, expect.not.objectContaining({ starters: expect.anything() }))
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Suggested prompts"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      .call(textarea, 'Plan my day\n\n  Summarize my week  ')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await act(async () => button('Save').click())
    expect(updateAgent).toHaveBeenLastCalledWith(agent.id, expect.objectContaining({
      starters: ['Plan my day', 'Summarize my week'],
    }))
  })

  it("links an owner to the bot's per-agent apps and hides them from others", async () => {
    listGatekeeperApps.mockResolvedValue([{ id: 'context', title: 'Context & Skills' }])
    const { overseer } = makeOverseer()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner />)
    flushFrames()
    expect(listGatekeeperApps).toHaveBeenCalledWith(agent.id)
    expect(document.querySelector<HTMLAnchorElement>('a[href="/gatekeepers/context?agentId=bot-1"]')?.textContent)
      .toBe('Context & Skills')
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner={false} />)
    flushFrames()
    expect(document.querySelector('a[href^="/gatekeepers/"]')).toBeNull()
  })

  it('offers the photo picker in the settings pane and saves a removal', async () => {
    const withAvatar = { ...agent, avatar: { url: 'data:image/png;base64,AQID' } }
    updateAgent.mockResolvedValue({ ...withAvatar, avatar: undefined })
    const { overseer } = makeOverseer()
    await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={agent.workspaceId} isOwner />)
    expect(button('Add photo')).toBeDefined()

    view.cleanup()
    await view.render(<AgentSettingsPane agent={withAvatar} authenticatedApi={authenticatedApi} overseer={overseer}
      workspaceId={withAvatar.workspaceId} isOwner />)
    await act(async () => button('Remove').click())
    await act(async () => button('Save').click())
    expect(updateAgent).toHaveBeenLastCalledWith(withAvatar.id, expect.objectContaining({ avatar: null }))
  })

  it.each(['create dialog', 'settings pane'])('uses the same Automatic label in the %s', async surface => {
    if (surface === 'create dialog') {
      await view.render(<CreateAgentModal visible models={models} authenticatedApi={authenticatedApi} onCancel={() => {}} onSuccess={() => {}} />)
      await act(async () => button(/Advanced$/).click())
    } else {
      await view.render(<AgentSettingsPane agent={agent} authenticatedApi={authenticatedApi} />)
    }
    expect(document.querySelector('[role="combobox"]')?.textContent).toBe(automatic)
    expect(updateAgent).not.toHaveBeenCalled()
  })
})
