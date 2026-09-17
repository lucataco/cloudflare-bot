// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMessageBody, Overseer, TaskRun, TaskRunEvidencePage, TaskRunPage, TaskRunSource } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../action-test-harness'
import TaskHistory from './TaskHistory'

const view = makeTestRoot()
const timestamp = new Date('2026-09-08T12:00:00Z')
const later = new Date('2026-09-08T13:00:00Z')
const author = { type: 'agent', id: 'model', name: 'Research bot' } as const
afterEach(() => { view.cleanup(); vi.restoreAllMocks() })

function run(sequence = 20, disposition: Pick<TaskRun, 'status' | 'reason'> = { status: 'finished', reason: 'model_stop' }): TaskRun {
  return {
    id: `run-${sequence}`, chatId: 1, sourceSequence: sequence, source: { type: 'prompt' },
    startedAt: timestamp, updatedAt: timestamp, attempt: 1, lastSequence: sequence + 10,
    ...disposition,
  } as TaskRun
}
function evidence(sequence: number, body: AiChatMessageBody, changeState?: TaskRunEvidencePage['entries'][number]['changeState']): TaskRunEvidencePage['entries'][number] {
  return { message: { chatId: 1, sequence, timestamp, author, runId: 'run-20', ...body }, changeState }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function server() {
  const { overseer } = makeOverseer()
  const listTaskRuns = vi.fn<Overseer['listTaskRuns']>().mockResolvedValue({ runs: [run()] })
  const getTaskRunEvidence = vi.fn<Overseer['getTaskRunEvidence']>().mockResolvedValue({ entries: [] })
  const dispose = vi.fn<() => void>()
  Object.assign(overseer, { listTaskRuns, getTaskRunEvidence, [Symbol.dispose]: dispose })
  return { overseer, listTaskRuns, getTaskRunEvidence, dispose }
}
function button(name: string, scope: ParentNode = document) {
  const matches = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .filter(node => node.textContent?.trim() === name)
  expect(matches, `button ${name}`).toHaveLength(1)
  return matches[0]
}
async function click(name: string) { await act(async () => button(name).click()) }
function row(sequence = 20) {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    .find(node => node.textContent?.includes(`#${sequence}`))
  expect(match).toBeDefined()
  return match!
}
async function expand(sequence = 20) { await act(async () => row(sequence).click()) }
function records() { return document.querySelector<HTMLElement>('[aria-label="Evidence for task 20"]')! }
async function setup(s = server(), props: Partial<ComponentProps<typeof TaskHistory>> = {}) {
  const render = (overrides: Partial<ComponentProps<typeof TaskHistory>> = {}) => view.render(
    <TaskHistory overseer={s.overseer} chatId={1} lastActive={timestamp} {...props} {...overrides} />,
  )
  await render()
  return { ...s, render }
}

describe('Task history disclosure', () => {
  it('does not query until opened, loads evidence on demand, and never disposes its borrowed workspace', async () => {
    const s = await setup()
    const toggle = button('Task history')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(s.listTaskRuns).not.toHaveBeenCalled()
    await s.render({ lastActive: later, currentRunId: 'new-run' })
    expect(s.listTaskRuns).not.toHaveBeenCalled()
    await click('Task history')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.getAttribute('tabindex')).toBe('0')
    expect(s.listTaskRuns).toHaveBeenCalledExactlyOnceWith(1, undefined)
    expect(s.getTaskRunEvidence).not.toHaveBeenCalled()
    const summary = row()
    summary.focus()
    expect(document.activeElement).toBe(summary)
    await expand()
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(summary.getAttribute('aria-controls')!)).toBe(records())
    expect(s.getTaskRunEvidence).toHaveBeenCalledExactlyOnceWith('run-20', undefined)
    await click('Task history')
    expect(records()).toBeNull()
    await s.render({ lastActive: later })
    expect(s.listTaskRuns).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(s.dispose).not.toHaveBeenCalled()
  })

  it('keeps Finished separate from success claims in final response prose', async () => {
    const s = server()
    s.getTaskRunEvidence.mockResolvedValue({ entries: [
      evidence(23, { type: 'message', message: 'Everything succeeded. The report was sent.' }),
      evidence(22, { type: 'message', message: 'Checking...', toolCalls: [{ toolCallId: 't', toolName: 'readFile', input: { filename: 'report.txt' } }] }),
      evidence(21, { type: 'message', message: '', reasoning: 'Private reasoning, not final evidence' }),
      evidence(20, { type: 'message', message: '  Send the report.\nPreserve the caveats.  ' }),
    ] })
    await setup(s)
    await click('Task history')
    expect(row().textContent).toContain('Finished')
    expect(row().textContent).not.toMatch(/success|complete/i)
    await expand()
    expect(records().textContent).toContain('Execution ended, not a verified successful outcome.')
    expect(records().textContent).toContain('Final response')
    expect(records().textContent).toContain('Everything succeeded. The report was sent.')
    expect(records().textContent).toContain('Source prompt')
    expect(records().textContent).toContain('  Send the report.\nPreserve the caveats.  ')
    expect(records().textContent).toContain('Agent message / tool activity')
    expect(records().textContent).not.toContain('Private reasoning')
    expect(records().querySelectorAll('time').length).toBeGreaterThan(0)
  })

  it.each([
    ['connection', 'Connection decision needed'], ['proposal', 'Proposal decision needed'],
    ['action_approval', 'Action approval needed'], ['human_takeover', 'Human input needed'],
  ] as const)('shows waiting for %s even with a final text response', async (reason, text) => {
    const s = server()
    s.listTaskRuns.mockResolvedValue({ runs: [run(20, { status: 'waiting', reason })] })
    s.getTaskRunEvidence.mockResolvedValue({ entries: [evidence(21, { type: 'message', message: 'All done!' })] })
    await setup(s)
    await click('Task history')
    await expand()
    expect(row().textContent).toContain('Waiting')
    expect(records().textContent).toContain(text)
    expect(records().textContent).toContain('All done!')
    expect(records().querySelector('button')).toBeNull()
  })

  it.each([
    { status: 'admitted' }, { status: 'running' }, { status: 'canceled', reason: 'workspace_paused' },
    { status: 'failed', reason: 'execution_error' }, { status: 'incomplete', reason: 'step_limit' },
  ] satisfies Pick<TaskRun, 'status' | 'reason'>[])('shows canonical $status status', async disposition => {
    const s = server()
    s.listTaskRuns.mockResolvedValue({ runs: [run(20, disposition)] })
    await setup(s)
    await click('Task history')
    expect(row().textContent?.toLowerCase()).toContain(disposition.status)
  })

  it('shows legacy absence only after a successful empty query', async () => {
    const s = server()
    const pending = deferred<TaskRunPage>()
    s.listTaskRuns.mockReturnValue(pending.promise)
    await setup(s)
    await click('Task history')
    expect(document.body.textContent).toContain('Loading tasks...')
    expect(document.body.textContent).not.toContain('No recorded tasks')
    await act(async () => pending.resolve({ runs: [] }))
    expect(document.body.textContent).toContain('Older conversations may predate task history')
    expect(document.body.textContent).not.toContain('Loading tasks...')
    expect(s.getTaskRunEvidence).not.toHaveBeenCalled()
  })

  it('renders source kinds and immutable routine admission metadata', async () => {
    const sources: TaskRunSource[] = [
      { type: 'prompt' }, { type: 'queue' }, { type: 'callback' }, { type: 'delegation' },
      { type: 'routine', routineId: 'weekly-report', revision: 4, registrationId: 'registration-7',
        scheduleId: 'schedule-8', occurrenceId: 'occurrence-9', scheduledTime: timestamp.getTime() },
    ]
    const s = server()
    s.listTaskRuns.mockResolvedValue({ runs: sources.map((source, index) => ({ ...run(20 - index), source })) })
    await setup(s)
    await click('Task history')
    for (const text of ['Prompt', 'Queued prompt', 'Callback', 'Delegation', 'Routine']) expect(document.body.textContent).toContain(text)
    await expand(16)
    for (const text of ['weekly-report, revision 4', 'registration-7', 'schedule-8', 'occurrence-9', 'Scheduled for:']) expect(document.body.textContent).toContain(text)
  })
})

describe('Canonical evidence', () => {
  it('uses current change/action/connection/human states and inert proposal receipts, never model claims or local replay', async () => {
    const s = server()
    const proposal = {
      type: 'agentProposal', proposalId: 'proposal-1', agentId: 'bot-1', agentName: 'Research bot',
      artifactId: 'routine-1', reason: 'A useful recurring task.',
      draft: { kind: 'routine', value: { name: 'Weekly report', prompt: 'Summarize findings.', schedule: { kind: 'interval', everyMs: 3600000 } } },
    } as const
    s.getTaskRunEvidence.mockResolvedValue({ entries: [
      evidence(40, { type: 'merge', mergeThrough: 39, commits: [] }),
      evidence(39, { type: 'changes', createdGadgets: [{ gadgetId: 1, title: 'Draft output', bindingName: 'REPORT' }] }, 'proposed'),
      evidence(38, { type: 'changes', change: { 1: [['report.txt', { set: 'report' }]] } }, 'merged'),
      evidence(37, { type: 'changes' }, 'reverted'),
      evidence(36, { type: 'changes' }),
      evidence(35, { type: 'action', actionId: 1, actionLog: entry(1, { description: {
        title: 'Send report', description: '![tracking](https://example.com/image.png) <img src="https://example.com/raw.png">', implementsRevert: true,
      } }) }),
      evidence(34, { type: 'action', actionId: 2, actionLog: entry(2, { state: 'approved', appliedAt: later, resolvedBy: { type: 'user', id: 'owner', name: 'Owner' } }) }),
      evidence(33, { type: 'action', actionId: 3, actionLog: entry(3, { state: 'rejected' }) }),
      evidence(32, { type: 'action', actionId: 4 }),
      evidence(31, { type: 'action', actionId: 5, actionLog: entry(5, { type: 'bindHook', state: 'approved', enabled: false, hookId: 8 }) }),
      evidence(30, { type: 'action', actionId: 6, actionLog: entry(6, { type: 'observation', state: 'approved' }) }),
      evidence(29, { ...proposal, state: 'accepted', decidedAt: timestamp, receipt: { createdAt: timestamp, missing: true } }),
      evidence(28, { ...proposal, proposalId: 'p-2', state: 'accepting', decidedAt: timestamp }),
      evidence(27, { ...proposal, proposalId: 'p-3', state: 'pending' }),
      evidence(26, { ...proposal, proposalId: 'p-4', state: 'denied', decidedAt: timestamp, draft: { kind: 'skill', value: { name: 'Write briefs', description: 'When writing reports', body: 'Keep caveats.' } } }),
      evidence(25, { type: 'connectionRequest', requestId: 'c-1', vendorId: 'github', vendorName: 'GitHub', reason: 'Read issues', state: 'accepted' }),
      evidence(24, { type: 'connectionRequest', requestId: 'c-2', vendorId: 'github', vendorName: 'GitHub', reason: 'Read issues', state: 'denied' }),
      evidence(23, { type: 'connectionRequest', requestId: 'c-3', vendorId: 'github', vendorName: 'GitHub', reason: 'Read issues', state: 'pending' }),
      evidence(22, { type: 'computerHumanTakeover', requestId: 'h-1', reason: 'Sign in', currentUrl: 'https://example.com', state: 'approved' }),
      evidence(21, { type: 'computerHumanTakeover', requestId: 'h-2', reason: 'Confirm payment', currentUrl: 'https://example.com', state: 'pending' }),
    ] })
    await setup(s)
    await click('Task history')
    await expand()
    for (const text of [
      'Changes: Proposed', 'Changes: Accepted', 'Changes: Reverted', 'Changes: Current state unavailable', 'Draft output', 'report.txt',
      'Action: Pending', 'Action: Applied', 'Action: Rejected', 'Action: Current state unavailable', 'Decision by Owner',
      'Hook: Disabled', 'Observation: Approved', 'Routine proposal: Accepted', 'Saved paused', 'Historical receipt, not current settings or activation.',
      'Already deleted; not recreated.', 'Routine proposal: Accepting', 'Creation not yet confirmed.', 'Routine proposal: Pending',
      'Reusable instructions proposal: Denied', 'Keep caveats.', 'Connection decision: Accepted', 'Connection decision: Denied',
      'Connection decision: Pending', 'Human input: Approved', 'Human input: Pending',
    ]) expect(records().textContent).toContain(text)
    expect(records().querySelector('button, a, input, img, iframe, script')).toBeNull()
    expect(document.querySelector('link[rel="preload"][as="image"]')).toBeNull()
  })
})

describe('Paging and refresh isolation', () => {
  it('pages newest-first using exclusive cursors including zero, and refreshes all loaded run/evidence pages', async () => {
    const s = server()
    s.listTaskRuns.mockResolvedValueOnce({ runs: [run(20)], nextBeforeSequence: 20 })
      .mockResolvedValueOnce({ runs: [run(0)] })
    s.getTaskRunEvidence.mockResolvedValueOnce({ entries: [evidence(23, { type: 'action', actionId: 1, actionLog: entry(1) })], nextBeforeSequence: 0 })
      .mockResolvedValueOnce({ entries: [evidence(0, { type: 'message', message: 'Older source text' })] })
    const { render } = await setup(s)
    await click('Task history')
    await click('Older tasks')
    expect(s.listTaskRuns.mock.calls).toEqual([[1, undefined], [1, 20]])
    expect([...document.querySelectorAll('button[aria-expanded]')].slice(1).map(node => node.textContent?.match(/#\d+/)?.[0])).toEqual(['#20', '#0'])
    await expand()
    await click('Older evidence')
    expect(s.getTaskRunEvidence.mock.calls).toEqual([['run-20', undefined], ['run-20', 0]])
    expect(records().textContent!.indexOf('Action: Pending')).toBeLessThan(records().textContent!.indexOf('Older source text'))
    s.listTaskRuns.mockImplementation(async (_chat, before) => before === undefined
      ? { runs: [run(20, { status: 'waiting', reason: 'proposal' })], nextBeforeSequence: 20 } : { runs: [run(0)] })
    s.getTaskRunEvidence.mockImplementation(async (_run, before) => before === undefined
      ? { entries: [evidence(23, { type: 'action', actionId: 1, actionLog: entry(1, { state: 'approved' }) })], nextBeforeSequence: 0 }
      : { entries: [evidence(0, { type: 'message', message: 'Refreshed older text' })] })
    await render({ lastActive: later })
    expect(row().textContent).toContain('Waiting')
    expect(records().textContent).toContain('Action: Applied')
    expect(records().textContent).toContain('Refreshed older text')
    expect(records().textContent).not.toContain('Older source text')
    expect(s.listTaskRuns.mock.calls.slice(2)).toEqual([[1, undefined], [1, 20]])
    expect(s.getTaskRunEvidence.mock.calls.slice(2)).toEqual([['run-20', undefined], ['run-20', 0]])
    const count = s.listTaskRuns.mock.calls.length
    await render({ lastActive: new Date(later) })
    expect(s.listTaskRuns).toHaveBeenCalledTimes(count)
    await render({ lastActive: later, currentRunId: 'new-admission' })
    expect(s.listTaskRuns).toHaveBeenCalledTimes(count + 2)
  })

  it.each(['tasks', 'evidence'] as const)('distinguishes %s errors from empty, retains pages and retries the failed cursor', async noun => {
    const s = server()
    if (noun === 'tasks') s.listTaskRuns.mockRejectedValueOnce(new Error('offline'))
    else s.getTaskRunEvidence.mockRejectedValueOnce(new Error('offline'))
    await setup(s)
    await click('Task history')
    if (noun === 'evidence') await expand()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(`Could not load ${noun}`)
    expect(document.body.textContent).not.toContain(`No recorded ${noun}`)
    await click(`Retry ${noun}`)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain(noun === 'evidence' ? 'No recorded evidence' : 'Finished')
    if (noun === 'tasks') s.listTaskRuns.mockResolvedValueOnce({ runs: [run()], nextBeforeSequence: 20 })
    else s.getTaskRunEvidence.mockResolvedValueOnce({ entries: [evidence(21, { type: 'message', message: 'Retained evidence' })], nextBeforeSequence: 21 })
    await click('Refresh task history')
    if (noun === 'tasks') s.listTaskRuns.mockRejectedValueOnce(new Error('paging failed'))
    else s.getTaskRunEvidence.mockRejectedValueOnce(new Error('paging failed'))
    await click(`Older ${noun}`)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(`Could not load ${noun}`)
    expect(document.body.textContent).toContain(noun === 'tasks' ? 'Finished' : 'Retained evidence')
    if (noun === 'tasks') s.listTaskRuns.mockResolvedValueOnce({ runs: [] })
    await click(`Retry ${noun}`)
    const calls = noun === 'tasks' ? s.listTaskRuns.mock.calls : s.getTaskRunEvidence.mock.calls
    expect(calls.at(-1)).toEqual(calls.at(-2))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('ignores stale %s after explicit refresh overtakes pending run and evidence pages', async settle => {
    const s = server()
    const oldRuns = deferred<TaskRunPage>()
    const oldEvidence = deferred<TaskRunEvidencePage>()
    s.listTaskRuns.mockResolvedValueOnce({ runs: [run()], nextBeforeSequence: 20 }).mockReturnValueOnce(oldRuns.promise)
    s.getTaskRunEvidence.mockReturnValueOnce(oldEvidence.promise).mockResolvedValue({ entries: [evidence(24, { type: 'message', message: 'Fresh evidence' })] })
    await setup(s)
    await click('Task history')
    await expand()
    await click('Older tasks')
    await click('Refresh task history')
    expect(records().textContent).toContain('Fresh evidence')
    await act(async () => {
      if (settle === 'resolve') {
        oldRuns.resolve({ runs: [run(0)] })
        oldEvidence.resolve({ entries: [evidence(21, { type: 'message', message: 'Stale evidence' })] })
      } else {
        oldRuns.reject(new Error('old run failure'))
        oldEvidence.reject(new Error('old evidence failure'))
      }
    })
    expect(records().textContent).toContain('Fresh evidence')
    expect(document.body.textContent).not.toContain('Stale evidence')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect([...document.querySelectorAll('button[aria-expanded]')].some(node => node.textContent?.includes('#0'))).toBe(false)
  })

  it.each(['chat', 'workspace', 'close'] as const)('isolates pending pages across %s changes and reused run IDs', async change => {
    const s = server()
    const old = deferred<TaskRunEvidencePage>()
    s.getTaskRunEvidence.mockReturnValueOnce(old.promise)
    const { render } = await setup(s)
    await click('Task history')
    await expand()
    const replacement = server()
    replacement.getTaskRunEvidence.mockResolvedValue({ entries: [evidence(22, { type: 'message', message: 'New workspace evidence' })] })
    if (change === 'close') await click('Task history')
    else await render(change === 'chat' ? { chatId: 2 } : { overseer: replacement.overseer })
    expect(button('Task history').getAttribute('aria-expanded')).toBe('false')
    expect(records()).toBeNull()
    await click('Task history')
    await expand()
    await act(async () => old.resolve({ entries: [evidence(21, { type: 'message', message: 'Old scope evidence' })] }))
    expect(document.body.textContent).not.toContain('Old scope evidence')
    expect(records().textContent).toContain(change === 'workspace' ? 'New workspace evidence' : 'No recorded evidence')
    expect(s.listTaskRuns).toHaveBeenLastCalledWith(change === 'chat' ? 2 : 1, undefined)
    expect(s.dispose).not.toHaveBeenCalled()
    expect(replacement.dispose).not.toHaveBeenCalled()
  })

  it('discards a closed run request, does not bleed into another run, and invalidates requests on unmount', async () => {
    const s = server()
    s.listTaskRuns.mockResolvedValue({ runs: [run(20), run(10)] })
    const old = deferred<TaskRunEvidencePage>()
    const unmounted = deferred<TaskRunEvidencePage>()
    s.getTaskRunEvidence.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ entries: [evidence(11, { type: 'message', message: 'Other run' })] })
      .mockReturnValueOnce(unmounted.promise)
    await setup(s)
    await click('Task history')
    await expand(20)
    await expand(20)
    await expand(10)
    await act(async () => old.reject(new Error('closed run failed')))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Other run')
    await expand(20)
    view.unmount()
    await act(async () => unmounted.resolve({ entries: [evidence(25, { type: 'message', message: 'Unmounted evidence' })] }))
    expect(document.body.textContent).not.toContain('Unmounted evidence')
    expect(s.dispose).not.toHaveBeenCalled()
  })
})
