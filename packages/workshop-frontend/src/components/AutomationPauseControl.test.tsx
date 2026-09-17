// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import AutomationPauseControl from './AutomationPauseControl'
import BotThreadHeader from './BotThreadHeader'

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
const view = makeTestRoot()
const owner: GadgetMetadata = { id: 'workspace', title: 'Workspace', role: 'build' }
afterEach(() => { view.cleanup(); vi.clearAllMocks() })

function server() {
  const setAutomationPaused = vi.fn<Overseer['setAutomationPaused']>(async () => {})
  const getAutomationPaused = vi.fn<Overseer['getAutomationPaused']>(async () => false)
  const overseer = { setAutomationPaused, getAutomationPaused } as unknown as RpcStub<Overseer>
  return {
    setAutomationPaused, getAutomationPaused,
    render: (metadata = owner) => view.render(<BotThreadHeader
      inspector="none" onInspectorChange={() => {}} onOpenActivity={() => {}} overseer={null} reconnecting={false}
      automationControl={<AutomationPauseControl overseer={overseer} metadata={metadata} />}
    />),
  }
}
function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) { await act(async () => button(label).click()) }

describe('owner automation pause and real Kumo resume consent', () => {
  it('pauses directly from the header, blocks duplicates, and waits for metadata rather than optimistic state or polling', async () => {
    const s = server()
    let resolve!: () => void
    s.setAutomationPaused.mockImplementationOnce(() => new Promise<void>(accept => { resolve = accept }))
    await s.render()
    await act(async () => { const pause = button('Pause automation'); pause.click(); pause.click() })
    expect(s.setAutomationPaused).toHaveBeenCalledExactlyOnceWith(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => resolve())
    expect(button('Pause automation').disabled).toBe(true)
    await s.render({ ...owner, automationPaused: true })
    expect(button('Resume automation...').disabled).toBe(false)
    expect(s.getAutomationPaused).not.toHaveBeenCalled()
    // A later change from another owner tab is authoritative too.
    await s.render({ ...owner, automationPaused: false })
    expect(button('Pause automation').disabled).toBe(false)
  })

  it('describes resume consequences, sends no RPC on cancel, and resumes only on confirmation', async () => {
    const s = server()
    await s.render({ ...owner, automationPaused: true })
    await click('Resume automation...')
    const dialog = document.querySelector('[role="dialog"]')!
    for (const token of ['responsive-dialog', '!top-[clamp(28px,10vh,96px)]', '!-translate-y-0', '!max-h-[min(80vh,calc(var(--app-height)-32px))]', 'overflow-y-auto']) {
      expect(dialog.classList.contains(token)).toBe(true)
    }
    expect(dialog.textContent).toContain('queued prompts')
    expect(dialog.textContent).toContain('automatic approvals under existing grants')
    expect(dialog.textContent).toContain('future triggers may run')
    expect(dialog.textContent).toContain('Existing bot browser grants')
    expect(dialog.textContent).toContain('Canceled turns are not replayed')
    expect(dialog.textContent).toContain('skipped, not saved for catch-up')
    expect(dialog.textContent).toContain('already in flight may finish')
    expect(dialog.textContent).toContain('does not roll back')
    await click('Cancel')
    expect(s.setAutomationPaused).not.toHaveBeenCalled()
    await click('Resume automation...')
    await act(async () => { const confirm = button('Resume automation'); confirm.click(); confirm.click() })
    expect(s.setAutomationPaused).toHaveBeenCalledExactlyOnceWith(false)
    expect(button('Resume automation...').disabled).toBe(true)
    await s.render({ ...owner, automationPaused: false })
    expect(button('Pause automation').disabled).toBe(false)
  })

  it.each([
    { ...owner, owner: { id: 'other', name: 'Owner', type: 'user' as const } },
    { ...owner, role: 'use' as const },
  ])('offers no mutating controls for non-owner metadata %o', async metadata => {
    const s = server()
    await s.render(metadata)
    expect(document.body.textContent).not.toContain('Pause automation')
    await s.render({ ...metadata, automationPaused: true })
    expect(document.body.textContent).not.toContain('Resume automation')
    expect(s.setAutomationPaused).not.toHaveBeenCalled()
  })

  it('cancels consent when paused metadata or owner authority changes', async () => {
    const s = server()
    await s.render({ ...owner, automationPaused: true })
    await click('Resume automation...')
    await s.render({ ...owner, automationPaused: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await s.render({ ...owner, automationPaused: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click('Resume automation...')
    await s.render({ ...owner, automationPaused: true, role: 'use' })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(s.setAutomationPaused).not.toHaveBeenCalled()
  })

  it('preserves uncertain errors without retry and follows later metadata updates', async () => {
    const s = server()
    s.setAutomationPaused.mockRejectedValueOnce(new Error('lost response'))
    await s.render()
    await click('Pause automation')
    expect(s.setAutomationPaused).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('may have taken effect')
    await s.render({ ...owner, automationPaused: true })
    expect(button('Resume automation...').disabled).toBe(false)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not retried')
    expect(s.getAutomationPaused).not.toHaveBeenCalled()
  })

  it('ignores late responses from a replaced workspace capability', async () => {
    const old = server()
    let reject!: (error: Error) => void
    old.setAutomationPaused.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    await old.render()
    await click('Pause automation')
    const next = server()
    await next.render({ ...owner, id: 'other-workspace' })
    await act(async () => reject(new Error('old failure')))
    expect(button('Pause automation').disabled).toBe(false)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    await click('Pause automation')
    expect(next.setAutomationPaused).toHaveBeenCalledExactlyOnceWith(true)
  })
})
