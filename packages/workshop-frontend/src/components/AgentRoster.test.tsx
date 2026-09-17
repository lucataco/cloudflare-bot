// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi, Group } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import AgentRoster from './AgentRoster'

const auth = vi.hoisted(() => ({ api: {} }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: auth.api }) }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn<() => void>(),
  useRouterState: () => '/agents/bot',
  Link: ({ to, params, children, ...props }: { to: string; params: { id: string }; children: ReactNode }) =>
    <a href={to.replace('$id', params.id)} {...props}>{children}</a>,
}))
vi.mock('./CreateAgentModal', () => ({ default: () => null }))
vi.mock('./EditAgentModal', () => ({ default: ({ visible, agent }: { visible: boolean; agent: AgentProfile }) =>
  visible ? <dialog open aria-label="Edit bot">{agent.name}</dialog> : null }))
vi.mock('./CreateGroupModal', () => ({ default: () => null }))
vi.mock('./EditGroupModal', () => ({ default: ({ visible, group }: { visible: boolean; group: Group }) =>
  visible ? <dialog open aria-label="Edit group">{group.name}</dialog> : null }))

const view = makeTestRoot()
const created = new Date('2026-09-01T12:00:00Z')
const updated = new Date('2026-09-08T12:00:00Z')
const agent: AgentProfile = {
  id: 'bot', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'bot-workspace', defaultModelId: null, created, updated,
}
const group: Group = {
  id: 'team', name: 'Research team', workspaceId: 'group-workspace', memberAgentIds: ['bot'], created, updated,
}
function makeApi() {
  return {
    listAgents: vi.fn<AuthenticatedApi['listAgents']>().mockResolvedValue([agent]),
    listGroups: vi.fn<AuthenticatedApi['listGroups']>().mockResolvedValue([group]),
    listModels: vi.fn<AuthenticatedApi['listModels']>().mockResolvedValue([]),
    listGadgets: vi.fn<AuthenticatedApi['listGadgets']>().mockResolvedValue([
      { id: agent.workspaceId, title: agent.name, created, lastActive: created },
      { id: group.workspaceId, title: group.name, created, lastActive: created },
    ]),
    listOutputs: vi.fn<AuthenticatedApi['listOutputs']>().mockResolvedValue({
      catchingUp: false,
      outputs: [{
        workspaceId: group.workspaceId, workpieceId: 1, title: 'Team report', workspaceTitle: group.name,
        created, lastActive: updated,
      }],
    }),
  }
}
afterEach(() => { view.cleanup(); vi.restoreAllMocks() })

describe('AgentRoster inbox rows', () => {
  it('keeps replies unread while the tab is hidden and acknowledges the displayed version on return', async () => {
    let hidden = true
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const api = { ...makeApi(), markAgentRead: vi.fn<AuthenticatedApi['markAgentRead']>().mockResolvedValue(undefined) }
    api.listAgents.mockResolvedValue([{ ...agent, roster: {
      presence: 'done', unreadCount: 1, lastReply: { text: 'Ready to review', timestamp: updated.getTime() },
    } }])
    auth.api = api
    await view.render(<AgentRoster variant="rail" collapsed />)
    expect(api.markAgentRead).not.toHaveBeenCalled()
    expect(document.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Research bot: done')
    hidden = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.markAgentRead).toHaveBeenCalledExactlyOnceWith(agent.id, updated.getTime())
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.markAgentRead).toHaveBeenCalledOnce()
    view.cleanup()
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(api.markAgentRead).toHaveBeenCalledOnce()
  })

  it('shows persisted presence and unread replies and restores hidden bots on demand', async () => {
    const api = { ...makeApi(), markAgentRead: vi.fn<AuthenticatedApi['markAgentRead']>().mockResolvedValue(undefined) }
    api.listAgents.mockResolvedValue([{...agent, roster: {presence: 'working', unreadCount: 2, lastReply: {text: 'Draft ready', timestamp: updated.getTime()}}},
      {...agent, id: 'hidden', name: 'Hidden bot', hidden: true}])
    auth.api = api
    await view.render(<AgentRoster variant="rail" />)
    expect(document.querySelector('[data-presence="working"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="2 unread updates"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Draft ready')
    expect(api.markAgentRead).toHaveBeenCalledWith('bot', updated.getTime())
    expect(document.querySelector('a[href="/agents/hidden"]')).toBeNull()
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Show hidden bots')!.click())
    expect(document.querySelector('a[href="/agents/hidden"]')).not.toBeNull()
  })

  it('keeps bot/group navigation and maps activity by workspace, not profile or group members', async () => {
    const api = makeApi()
    auth.api = api
    await view.render(<AgentRoster variant="rail" />)
    const bot = document.querySelector<HTMLAnchorElement>('a[href="/agents/bot"]')!
    const team = document.querySelector<HTMLAnchorElement>('a[href="/groups/team"]')!
    expect(bot.textContent).toContain('Last seen: Workspace: Research bot')
    expect(bot.textContent).not.toContain('Team report')
    expect(team.textContent).toContain('Last seen: Result: Team report')
    expect(bot.querySelector('[title="Research assistant"]')).not.toBeNull()
    expect(team.querySelector('[title="1 members"]')).not.toBeNull()
    expect(bot.querySelector('time')?.dateTime).toBe(created.toISOString())
    expect(team.querySelector('time')?.dateTime).toBe(created.toISOString())
    expect(team.querySelector('time')?.title).toContain('not live')
    expect(document.body.textContent).not.toMatch(/unread/i)
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
    expect(api.listOutputs).toHaveBeenCalledTimes(1)
    await view.render(<AgentRoster variant="rail" collapsed />)
    expect(document.querySelector('a[href="/groups/team"]')?.getAttribute('title')).toContain('Team report')
    expect(document.querySelector('time')).toBeNull()
    expect(api.listGadgets).toHaveBeenCalledTimes(1)
  })

  it('shows activity failure honestly without using profile updated as a timestamp', async () => {
    const api = makeApi()
    api.listGadgets.mockRejectedValue(new Error('offline'))
    api.listOutputs.mockRejectedValue(new Error('offline'))
    auth.api = api
    await view.render(<AgentRoster />)
    expect(document.body.textContent).toContain('Activity unavailable')
    expect(document.querySelector('time')).toBeNull()
    expect(document.body.textContent).not.toContain('No bots yet')
  })

  it.each([
    ['bot', '/agents/bot', 'Research bot'],
    ['group', '/groups/team', 'Research team'],
  ])('keeps %s editing separate from row navigation', async (kind, href, name) => {
    auth.api = makeApi()
    await view.render(<AgentRoster variant="rail" />)
    const row = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!
    const button = row.querySelector<HTMLButtonElement>(`button[aria-label="Edit ${kind}"]`)!
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { button.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(true)
    expect(document.querySelector(`dialog[aria-label="Edit ${kind}"]`)?.textContent).toBe(name)
    expect(row.querySelector('time')?.dateTime).toBe(created.toISOString())
  })

  it('does not show the previous auth scope while loading a new roster and distinguishes list failure from empty', async () => {
    auth.api = makeApi()
    await view.render(<AgentRoster />)
    const next = makeApi()
    let reject!: (error: Error) => void
    next.listAgents.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    next.listGroups.mockResolvedValue([])
    next.listOutputs.mockResolvedValue({ outputs: [], catchingUp: false })
    next.listGadgets.mockResolvedValue([])
    auth.api = next
    await view.render(<AgentRoster />)
    expect(document.querySelector('[aria-label="Loading bots"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Team report')
    expect(document.body.textContent).not.toContain('Research bot')
    await act(async () => reject(new Error('offline')))
    expect(document.body.textContent).toContain('Could not load all bots and groups. Retry')
    expect(document.body.textContent).not.toContain('No bots yet')
    next.listAgents.mockResolvedValue([])
    await act(async () => document.querySelector<HTMLButtonElement>('[title="Retry loading bots and groups"]')!.click())
    expect(document.body.textContent).toContain('No bots yet')
  })
})
