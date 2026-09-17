// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi, NamedDelegationConfig, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import DelegationSettings from './DelegationSettings'

const view = makeTestRoot()
afterEach(() => view.cleanup())
const agent: AgentProfile = { id: 'source', name: 'Source bot', title: '', description: '', defaultModelId: null,
  workspaceId: 'source-workspace', created: new Date(0), updated: new Date(0) }
const empty: NamedDelegationConfig = { revision: 0, targets: [], resources: Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `Resource ${i + 1}` })) }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === name)
  expect(found).toHaveLength(1)
  return found[0]
}
async function click(name: string) { await act(async () => button(name).click()) }
async function select(id: string) {
  await act(async () => {
    const control = document.querySelector('select')!
    control.value = id
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function resource(index: number) { return document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index - 1] }
async function setup(config = empty) {
  const getNamedDelegationConfig = vi.fn<Overseer['getNamedDelegationConfig']>().mockResolvedValue(config)
  const setNamedDelegationConfig = vi.fn<Overseer['setNamedDelegationConfig']>().mockImplementation(async targets => ({ ...config, revision: config.revision + 1, targets }))
  const listAgents = vi.fn<AuthenticatedApi['listAgents']>().mockResolvedValue([agent,
    ...Array.from({ length: 9 }, (_, i) => ({ ...agent, id: `target-${i + 1}`, name: `Target ${i + 1}`, workspaceId: `private-${i + 1}` })),
  ])
  const props = { authenticatedApi: { listAgents }, overseer: { getNamedDelegationConfig, setNamedDelegationConfig },
    sourceAgentId: agent.id, workspaceId: agent.workspaceId, isOwner: true }
  const render = (overrides: Partial<ComponentProps<typeof DelegationSettings>> = {}) => view.render(<DelegationSettings {...props} {...overrides} />)
  await render()
  return { ...props, render, getNamedDelegationConfig, setNamedDelegationConfig, listAgents }
}
async function load() { await click('Advanced: Named delegation'); await click('Load delegation settings') }

describe('source-workspace delegation settings', () => {
  it('does not read on mount/open or grant on listing; loads default none and excludes self', async () => {
    const s = await setup()
    expect(s.listAgents).not.toHaveBeenCalled()
    await click('Advanced: Named delegation')
    expect(s.getNamedDelegationConfig).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('No targets configured')
    await click('Load delegation settings')
    expect(s.listAgents).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('No targets configured')
    expect(document.querySelector('option[value="source"]')).toBeNull()
    expect(s.setNamedDelegationConfig).not.toHaveBeenCalled()
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig).toHaveBeenCalledExactlyOnceWith([], 0)
  })

  it('selects instructions/model only, then explicitly selects deterministic source resources with a limit of eight', async () => {
    const s = await setup()
    await load()
    await select('target-1')
    expect([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => !input.checked)).toBe(true)
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig).toHaveBeenLastCalledWith([{ targetAgentId: 'target-1', bindings: {} }], 0)
    for (let i = 1; i <= 8; i++) await act(async () => resource(i).click())
    expect(resource(9).disabled).toBe(true)
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig).toHaveBeenLastCalledWith([{ targetAgentId: 'target-1',
      bindings: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`RESOURCE_${i + 1}`, i + 1])),
    }], 1)
    await act(async () => resource(1).click())
    expect(resource(9).disabled).toBe(false)
  })

  it('preserves saved names and unavailable bindings, and can revoke all targets', async () => {
    const s = await setup({ ...empty, revision: 7, targets: [{ targetAgentId: 'target-1', bindings: { REPORTS: 1, OLD: 99 } }] })
    await load()
    expect(resource(1).checked).toBe(true)
    expect(document.body.textContent).toContain('Unavailable resource #99')
    await act(async () => resource(2).click())
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig).toHaveBeenLastCalledWith([{ targetAgentId: 'target-1', bindings: { REPORTS: 1, OLD: 99, RESOURCE_2: 2 } }], 7)
    await click('Remove target')
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig).toHaveBeenLastCalledWith([], 8)
  })

  it('caps configured targets at eight', async () => {
    const s = await setup()
    await load()
    for (let i = 1; i <= 8; i++) await select(`target-${i}`)
    expect(document.querySelector('select')!.disabled).toBe(true)
    await click('Save delegation settings')
    expect(s.setNamedDelegationConfig.mock.calls[0][0]).toHaveLength(8)
  })

  it('keeps a CAS failure draft and its revision until an explicit Reload, including failed reloads', async () => {
    const s = await setup()
    await load()
    await select('target-1')
    await act(async () => resource(1).click())
    s.setNamedDelegationConfig.mockRejectedValue(new Error('Revision conflict'))
    await click('Save delegation settings')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Your draft is preserved')
    expect(resource(1).checked).toBe(true)
    expect(s.getNamedDelegationConfig).toHaveBeenCalledOnce()
    s.getNamedDelegationConfig.mockRejectedValue(new Error('Offline'))
    await click('Reload delegation settings')
    expect(resource(1).checked).toBe(true)
    expect(document.body.textContent).not.toContain('No targets configured')
    s.getNamedDelegationConfig.mockResolvedValue({ ...empty, revision: 3 })
    await click('Reload delegation settings')
    expect(document.body.textContent).toContain('No targets configured')
    expect(document.body.textContent).toContain('Revision 3')
  })

  it('never interprets loading or load failure as empty, and keeps drafts across unrelated rerenders/closing', async () => {
    const s = await setup()
    const pending = deferred<NamedDelegationConfig>()
    s.getNamedDelegationConfig.mockReturnValue(pending.promise)
    await load()
    expect(document.body.textContent).not.toContain('No targets configured')
    expect(document.querySelector('select')).toBeNull()
    await act(async () => pending.reject(new Error('No access')))
    expect(document.body.textContent).toContain('Could not load')
    expect(document.body.textContent).not.toContain('No targets configured')
    s.getNamedDelegationConfig.mockResolvedValue(empty)
    await click('Load delegation settings')
    await select('target-1')
    await act(async () => resource(1).click())
    await s.render()
    await click('Advanced: Named delegation')
    await click('Advanced: Named delegation')
    expect(resource(1).checked).toBe(true)
    const reload = deferred<NamedDelegationConfig>()
    s.getNamedDelegationConfig.mockReturnValue(reload.promise)
    await click('Reload delegation settings')
    expect(resource(1).matches(':disabled')).toBe(true)
    expect(resource(1).checked).toBe(true)
    await act(async () => reload.reject(new Error('Offline')))
    expect(resource(1).checked).toBe(true)
  })

  it.each(['authenticatedApi', 'overseer', 'workspaceId', 'sourceAgentId', 'isOwner'] as const)('ignores old saves and hides/reset controls on %s changes', async key => {
    const s = await setup()
    await load()
    await select('target-1')
    const pending = deferred<NamedDelegationConfig>()
    s.setNamedDelegationConfig.mockReturnValue(pending.promise)
    await click('Save delegation settings')
    const changes = { authenticatedApi: { listAgents: s.listAgents }, overseer: { ...s.overseer },
      workspaceId: 'other-workspace', sourceAgentId: 'other-source', isOwner: false }
    await s.render({ [key]: changes[key] })
    expect(document.body.textContent).not.toContain('Target 1')
    expect(document.querySelector('section') === null).toBe(key === 'isOwner')
    if (key !== 'isOwner') {
      await load()
      await select('target-2')
    }
    await act(async () => pending.resolve({ ...empty, revision: 99, targets: [{ targetAgentId: 'target-1', bindings: {} }] }))
    expect(document.body.textContent).not.toContain('Revision 99')
    expect(document.querySelector('legend')?.textContent ?? null).toBe(key === 'isOwner' ? null : 'Configured targets (1/8)')
  })

  it('ignores stale loads including an old owner list after an auth switch', async () => {
    const s = await setup()
    const pending = deferred<AgentProfile[]>()
    s.listAgents.mockReturnValue(pending.promise)
    await load()
    const newList = vi.fn<AuthenticatedApi['listAgents']>().mockResolvedValue([])
    await s.render({ authenticatedApi: { listAgents: newList } })
    await load()
    await act(async () => pending.resolve([{ ...agent, id: 'private-old', name: 'Old owner private bot' }]))
    expect(document.body.textContent).not.toContain('Old owner private bot')
    expect(s.setNamedDelegationConfig).not.toHaveBeenCalled()
  })
})
