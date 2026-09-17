// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode, type ComponentProps } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProposal, Overseer } from '@gadgets/workshop-shared/api'
import { flushFrames, makeTestRoot } from '../action-test-harness'
import AgentProposalCard from './AgentProposalCard'
import { formatRoutineSchedule } from './routineFormat'

const view = makeTestRoot()
const createdAt = new Date('2026-09-08T10:15:00Z')
const decidedAt = new Date('2026-09-08T10:14:00Z')
const routine: AgentProposal = {
  type: 'agentProposal', proposalId: 'proposal-1', agentId: 'bot/1', agentName: 'Riley', artifactId: 'routine-1',
  reason: '  Bot rationale\n<img src="https://example.com/reason.png">\n', state: 'pending',
  draft: { kind: 'routine', value: {
    name: '  Daily review  ', prompt: '  Read the project notes.\n\nSummarize any changes.\n',
    schedule: { kind: 'calendar', freq: 'weekly', interval: 2, byDay: ['MO', 'FR'], hour: 9, minute: 7, timeZone: 'America/New_York' },
  } },
}
const skill: AgentProposal = {
  ...routine, proposalId: 'proposal-skill', artifactId: 'skill-1',
  draft: { kind: 'skill', value: {
    name: 'Meeting follow-up', description: '  After a meeting\nwith open questions.\n',
    body: '    Keep indentation.\n\n![image](https://example.com/image.png)\n<script>alert(1)</script>\n[click](javascript:alert(1))\n',
  } },
}
const accepted = (proposal: AgentProposal = routine, missing = false): AgentProposal => ({
  ...proposal, state: 'accepted', decidedAt, receipt: { createdAt, missing },
})
const accepting = (proposal: AgentProposal = routine): AgentProposal => ({ ...proposal, state: 'accepting', decidedAt })
const denied = (proposal: AgentProposal = routine): AgentProposal => ({ ...proposal, state: 'denied', decidedAt })

const dispose = new Set<() => void>()
function server(proposal = routine) {
  const accept = vi.fn<Overseer['acceptAgentProposal']>().mockResolvedValue(accepted(proposal))
  const deny = vi.fn<Overseer['denyAgentProposal']>().mockResolvedValue(denied(proposal))
  const disposed = vi.fn<() => void>()
  const overseer = new RpcStub(new class extends RpcTarget {
    acceptAgentProposal(id: string) { return accept(id) }
    denyAgentProposal(id: string) { return deny(id) }
    [Symbol.dispose]() { disposed() }
  }())
  dispose.add(() => overseer[Symbol.dispose]())
  return { overseer, accept, deny, disposed }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function button(label: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent) === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}
async function click(label: string) {
  await act(async () => { button(label).click() })
  flushFrames()
}
function field(label: string) {
  const term = [...document.querySelectorAll('dt')].find(element => element.textContent === label)!
  expect(term).toBeDefined()
  return term.nextElementSibling!
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
function render(api: ReturnType<typeof server>, proposal = routine, props: Partial<ComponentProps<typeof AgentProposalCard>> = {}) {
  return view.render(<StrictMode><AgentProposalCard proposal={proposal} overseer={api.overseer} chatId={1} canDecideProposals {...props} /></StrictMode>)
}
afterEach(() => {
  view.cleanup()
  for (const release of dispose) release()
  dispose.clear()
  vi.restoreAllMocks()
})

describe('AgentProposalCard with real Kumo review and callable Capnweb stubs', () => {
  it.each([routine, skill])('opens exact $draft.kind fields without any RPC or active content', async proposal => {
    const api = server(proposal)
    await render(api, proposal)
    expect(typeof api.overseer).toBe('function')
    expect(document.body.textContent).toContain('Suggested by Riley')
    expect(document.body.textContent).toContain('Why the bot suggested this')
    expect(document.body.textContent).toContain('Needs approval')
    expect(document.querySelector('dd')).toBeNull()
    await click('Review')
    expect(field('Name').textContent).toBe(proposal.draft.value.name)
    expect(field('Why the bot suggested this').textContent).toBe(proposal.reason)
    const fields = proposal.draft.kind === 'routine' ? [
      ['Task to repeat', proposal.draft.value.prompt],
      ['Schedule', formatRoutineSchedule(proposal.draft.value.schedule)],
    ] : [['When to use', proposal.draft.value.description], ['Instructions', proposal.draft.value.body]]
    for (const [label, value] of fields) expect(field(label).textContent).toBe(value)
    expect(button(proposal.draft.kind === 'routine' ? 'Save paused routine' : 'Save reusable instructions').disabled).toBe(false)
    expect(dialog().textContent).toContain(proposal.draft.kind === 'routine' ? 'No schedule is enabled' : 'starting with the next turn, not the current run')
    expect(dialog().textContent).toContain('Saving grants no connections or bindings')
    expect(dialog().textContent).toContain('does not resume the bot')
    expect(dialog().querySelectorAll('img, script, a, iframe')).toHaveLength(0)
    expect(field('Name').classList.contains('whitespace-pre-wrap')).toBe(true)
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
    await click('Cancel')
    expect(dialog()).toBeNull()
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })

  it('keeps exact schedule fields available in a collapsed technical disclosure', async () => {
    const api = server()
    await render(api)
    await click('Review')
    const details = dialog().querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => { details.querySelector('summary')!.click() })
    expect(details.open).toBe(true)
    expect(details.querySelector('pre')?.textContent).toBe(JSON.stringify(
      routine.draft.kind === 'routine' ? routine.draft.value.schedule : undefined, null, 2))
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })

  it('fits mobile, labels review, scrolls only the body and restores trigger focus', async () => {
    const api = server()
    await render(api)
    const trigger = button('Review')
    await act(async () => { trigger.focus(); trigger.click() })
    flushFrames()
    const panel = dialog()
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe('Review routine proposal')
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toContain('exactly what will be saved')
    for (const token of ['responsive-dialog', '!top-[clamp(28px,10vh,96px)]', '!-translate-y-0',
      '!w-[min(600px,calc(100vw-32px))]', '!max-h-[min(80vh,calc(var(--app-height)-32px))]', 'overflow-hidden', 'bg-kumo-base']) {
      expect(panel.classList.contains(token)).toBe(true)
    }
    const scroll = panel.querySelector<HTMLElement>('[role="region"][aria-label="Proposal details"]')!
    expect(scroll.tabIndex).toBe(0)
    await act(async () => { scroll.focus() })
    expect(document.activeElement).toBe(scroll)
    expect(scroll.contains(field('Task to repeat'))).toBe(true)
    expect(scroll.contains(button('Save paused routine'))).toBe(false)
    expect(button('Save paused routine').parentElement?.classList.contains('shrink-0')).toBe(true)
    expect(panel.contains(document.activeElement)).toBe(true)
    await click('Cancel')
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['Escape', 'backdrop'])('dismisses review with %s without deciding', async dismissal => {
    const api = server()
    await render(api)
    await click('Review')
    await act(async () => {
      if (dismissal === 'Escape') {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      } else {
        const backdrop = document.querySelector<HTMLElement>('[role="presentation"][data-open]')!
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
          if (type.startsWith('pointer')) Object.assign(event, { pointerType: 'mouse' })
          backdrop.dispatchEvent(event)
        }
      }
    })
    flushFrames()
    expect(dialog()).toBeNull()
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('defaults to read-only for collaborators (owner hint %s)', async canDecideProposals => {
    const api = server()
    for (const proposal of [routine, accepting(), accepted()]) {
      await render(api, proposal, { canDecideProposals })
      await click(proposal.state === 'accepted' ? 'View proposal' : 'Review')
      expect(field('Name').textContent).toBe(routine.draft.value.name)
      expect([...document.querySelectorAll('button')].map(element => element.textContent).join(' ')).not.toMatch(/Save paused routine|Finish saving|Deny/)
      expect(document.querySelector('a')).toBeNull()
      await click(proposal.state === 'pending' ? 'Cancel' : 'Close')
    }
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })

  it.each([routine, skill])('saves $draft.kind only on explicit confirmation using exactly the proposal ID', async proposal => {
    const api = server(proposal)
    await render(api, proposal)
    await click('Review')
    await click(proposal.draft.kind === 'routine' ? 'Save paused routine' : 'Save reusable instructions')
    expect(api.accept).toHaveBeenCalledExactlyOnceWith(proposal.proposalId)
    expect(api.deny).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(document.body.textContent).toContain(`${proposal.draft.kind === 'routine' ? 'Saved paused' : 'Saved reusable instructions'} at ${createdAt.toLocaleString()}`)
    expect(document.body.textContent).toContain('This records what was saved, not its current settings')
    expect(document.body.textContent).not.toMatch(/Active|Enabled/)
    const link = document.querySelector('a')!
    expect(link.textContent).toBe(proposal.draft.kind === 'routine' ? 'Manage routines' : 'Manage instructions')
    expect(link.getAttribute('href')).toBe(`/agents/bot%2F1?pane=${proposal.draft.kind === 'routine' ? 'routines' : 'skills'}`)
    // A lagging subscriber row does not erase the RPC receipt or show decision controls again.
    await render(api, { ...proposal })
    expect(document.body.textContent).toContain(createdAt.toLocaleString())
    view.unmount()
    expect(api.disposed).not.toHaveBeenCalled() // The parent owns the borrowed capability.
  })

  it('denies only explicitly, guards double clicks and never saves', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.deny.mockReturnValue(pending.promise)
    await render(api)
    await act(async () => { const deny = button('Deny'); deny.click(); deny.click() })
    expect(api.deny).toHaveBeenCalledExactlyOnceWith(routine.proposalId)
    expect(button('Denying...').disabled).toBe(true)
    await act(async () => pending.resolve(denied()))
    expect(document.body.textContent).toContain(`Denied at ${decidedAt.toLocaleString()}`)
    expect(api.accept).not.toHaveBeenCalled()
    expect(document.querySelector('a')).toBeNull()
  })

  it('guards simultaneous accept/deny and duplicate confirms before React rerenders', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    const deny = button('Deny')
    await click('Review')
    await act(async () => { const save = button('Save paused routine'); save.click(); save.click(); deny.click() })
    expect(api.accept).toHaveBeenCalledExactlyOnceWith(routine.proposalId)
    expect(api.deny).not.toHaveBeenCalled()
    expect(button('Saving...').disabled).toBe(true)
    await act(async () => pending.resolve(accepted()))
    expect(dialog()).toBeNull()
  })

  it.each([routine, skill])('recovers an accepting $draft.kind only with manual Finish saving, never denying', async proposal => {
    const api = server(proposal)
    await render(api, accepting(proposal))
    expect(document.body.textContent).toContain('Saving not yet confirmed')
    expect([...document.querySelectorAll('button')].some(element => element.textContent === 'Deny')).toBe(false)
    await click('Review')
    expect(button('Finish saving').disabled).toBe(false)
    expect(api.accept).not.toHaveBeenCalled()
    await click('Close')
    expect(api.accept).not.toHaveBeenCalled()
    await click('Review')
    await click('Finish saving')
    expect(api.accept).toHaveBeenCalledExactlyOnceWith(proposal.proposalId)
    expect(api.deny).not.toHaveBeenCalled()
  })

  it('keeps a lost save unconfirmed and requires explicit, safe retry even before a subscriber update', async () => {
    const api = server()
    api.accept.mockRejectedValueOnce(new Error('RPC disconnected'))
    await render(api)
    await click('Review')
    await click('Save paused routine')
    expect(dialog().textContent).toContain('Saving is not yet confirmed')
    expect(document.body.textContent).not.toContain('Saved paused at')
    expect(button('Finish saving').disabled).toBe(false)
    await click('Close')
    await render(api)
    expect(api.accept).toHaveBeenCalledTimes(1)
    expect([...document.querySelectorAll('button')].some(element => element.textContent === 'Deny')).toBe(false)
    await click('Review')
    await click('Finish saving')
    expect(api.accept.mock.calls).toEqual([[routine.proposalId], [routine.proposalId]])
    expect(document.body.textContent).toContain('Saved paused at')
  })

  it('allows explicit denial retry after failure, without claiming a decision or retrying on open', async () => {
    const api = server()
    api.deny.mockRejectedValueOnce(new Error('offline'))
    await render(api)
    await click('Deny')
    expect(document.body.textContent).toContain('Could not confirm denial')
    expect(document.body.textContent).toContain('Needs approval')
    await click('Review')
    await click('Cancel')
    expect(api.deny).toHaveBeenCalledTimes(1)
    await click('Deny')
    expect(api.deny.mock.calls).toEqual([[routine.proposalId], [routine.proposalId]])
  })

  it('reconciles accepting subscriber progress with the matching RPC receipt', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    await click('Review')
    await click('Save paused routine')
    await render(api, accepting())
    await act(async () => pending.resolve(accepted(routine, true)))
    expect(dialog()).toBeNull()
    expect(document.body.textContent).toContain('Already deleted; it was not recreated')
    await render(api, accepted())
    expect(document.body.textContent).toContain('Already deleted; it was not recreated')
    expect(api.accept).toHaveBeenCalledTimes(1)
  })

  it('retains deletion reported by a matching RPC receipt after the subscriber accepts first', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api, accepting())
    await click('Review')
    await click('Finish saving')
    await render(api, accepted())
    const open = dialog()
    await act(async () => pending.resolve(accepted(routine, true)))
    expect(dialog()).toBe(open)
    expect(open.textContent).toContain('Already deleted; it was not recreated')
    expect(api.accept).toHaveBeenCalledExactlyOnceWith(routine.proposalId)
  })

  it('keeps an accepting RPC response unconfirmed without automatic retries or denial', async () => {
    const api = server()
    api.accept.mockResolvedValueOnce(accepting())
    await render(api)
    await click('Review')
    await click('Save paused routine')
    expect(dialog().textContent).toContain('Saving not yet confirmed')
    expect(button('Finish saving').disabled).toBe(false)
    await click('Close')
    await render(api)
    expect([...document.querySelectorAll('button')].some(element => element.textContent === 'Deny')).toBe(false)
    expect(api.accept).toHaveBeenCalledTimes(1)
    await click('Review')
    await click('Finish saving')
    expect(api.accept.mock.calls).toEqual([[routine.proposalId], [routine.proposalId]])
  })

  it.each([accepted(routine, true), denied()])('does not overwrite a terminal subscriber decision ($state) with a late response', async terminal => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    await click('Review')
    await click('Save paused routine')
    await render(api, terminal)
    await click('Close')
    await click('View proposal')
    const reopened = dialog()
    await act(async () => pending.resolve(accepted()))
    expect(dialog()).toBe(reopened)
    expect(document.body.textContent).toContain(terminal.state === 'denied' ? 'Denied at' : 'Already deleted; it was not recreated')
    expect([...reopened.querySelectorAll('button')].map(element => element.textContent)).toEqual(['Close'])
  })

  it('does not close a reopened review when its previous save returns', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    await click('Review')
    await click('Save paused routine')
    await click('Close')
    await click('Review')
    const reopened = dialog()
    await act(async () => pending.resolve(accepted()))
    expect(dialog()).toBe(reopened)
    expect(reopened.textContent).toContain('Saved paused at')
  })

  it.each(['proposal', 'chat', 'overseer', 'owner'] as const)('discards late decisions after the %s identity changes', async identity => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    await click('Review')
    await click('Save paused routine')
    const nextApi = identity === 'overseer' ? server() : api
    const nextProposal = identity === 'proposal' ? skill : routine
    await render(nextApi, nextProposal, {
      chatId: identity === 'chat' ? 2 : 1, canDecideProposals: identity !== 'owner',
    })
    expect(dialog()).toBeNull()
    await click('Review')
    const nextDialog = dialog()
    await act(async () => pending.resolve(accepted()))
    expect(dialog()).toBe(nextDialog)
    expect(document.body.textContent).not.toContain('Saved paused at')
    expect(document.body.textContent).toContain('Needs approval')
  })

  it('ignores a response from an unmounted card, even after remounting the same proposal', async () => {
    const api = server()
    const pending = deferred<AgentProposal>()
    api.accept.mockReturnValue(pending.promise)
    await render(api)
    await click('Review')
    await click('Save paused routine')
    view.unmount()
    await render(api)
    await click('Review')
    const nextDialog = dialog()
    await act(async () => pending.resolve(accepted()))
    expect(dialog()).toBe(nextDialog)
    expect(document.body.textContent).not.toContain('Saved paused at')
  })

  it.each(['proposalId', 'agentId', 'artifactId'] as const)('rejects an RPC receipt with mismatched %s', async fieldName => {
    const api = server()
    api.accept.mockResolvedValue({ ...accepted(), [fieldName]: 'different' })
    await render(api)
    await click('Review')
    await click('Save paused routine')
    expect(dialog()).not.toBeNull()
    expect(document.body.textContent).not.toContain('Saved paused at')
    expect(button('Finish saving').disabled).toBe(false)
  })

  it.each([routine, skill])('renders persisted $draft.kind receipts without fetching live state or recreating deleted artifacts', async proposal => {
    const api = server(proposal)
    await render(api, accepted(proposal, true))
    expect(document.body.textContent).toContain(createdAt.toLocaleString())
    expect(document.body.textContent).toContain('Already deleted; it was not recreated')
    expect(document.body.textContent).not.toMatch(/Active|Enabled/)
    await click('View proposal')
    expect([...dialog().querySelectorAll('button')].map(element => element.textContent)).toEqual(['Close'])
    await click('Close')
    expect(api.accept).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })
})
