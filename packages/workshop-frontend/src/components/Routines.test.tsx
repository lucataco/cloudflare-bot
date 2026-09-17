// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AgentRoutine, AgentRoutineSchedule, AuthenticatedApi } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.hoisted(() => ({
  createRoutine: vi.fn<AuthenticatedApi['createRoutine']>(),
  updateRoutine: vi.fn<AuthenticatedApi['updateRoutine']>(),
  deleteRoutine: vi.fn<AuthenticatedApi['deleteRoutine']>(),
  listRoutines: vi.fn<AuthenticatedApi['listRoutines']>(),
}))

let sessionApi: typeof api
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: sessionApi }) }))
vi.mock('@cloudflare/kumo', () => ({
  Dialog: Object.assign(({ children, ...props }: ComponentProps<'dialog'>) => <dialog open {...props}>{children}</dialog>, {
    Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
    Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Close: () => null,
  }),
  Select: Object.assign(({ children, label, value, onValueChange }: {
    children: ReactNode; label: string; value: string; onValueChange: (value: string) => void
  }) => <label>{label}<select value={value} onChange={(e) => onValueChange(e.target.value)}>{children}</select></label>, {
    Option: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
  }),
  Checkbox: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) => <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.target.checked)} />,
}))
vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => <button type="button" {...props}>{children}</button>,
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => <button type="button" {...props}>{children}</button>,
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
  WorkshopInputArea: (props: ComponentProps<'textarea'>) => <textarea {...props} />,
}))

import CreateRoutineModal from './CreateRoutineModal'
import RoutinesList, { RoutineCard } from './RoutinesList'
import { formatRoutineSchedule } from './routineFormat'

const agent: AgentProfile = {
  id: 'bot-1', name: 'Riley', title: 'Research assistant', description: '', defaultModelId: null,
  workspaceId: 'workspace-1', created: new Date(0), updated: new Date(0),
}
function record(schedule: AgentRoutineSchedule = { kind: 'interval', everyMs: 5400000 }): AgentRoutine {
  return { id: 'routine-1', name: 'Daily summary', prompt: 'Summarize new issues.', schedule, paused: true, created: new Date(0), updated: new Date(0) }
}

let root: Root
let container: HTMLDivElement
let serverRoutines: AgentRoutine[]
beforeEach(() => {
  vi.resetAllMocks()
  sessionApi = { ...api }
  serverRoutines = []
  api.listRoutines.mockImplementation(async () => serverRoutines)
  api.updateRoutine.mockImplementation(async (_agentId, id, updates) => {
    const saved = { ...serverRoutines.find((routine) => routine.id === id)!, ...updates }
    serverRoutines = serverRoutines.map((routine) => routine.id === id ? saved : routine)
    return saved
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => root.render(node))
}
async function click(text: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll('button')].find((entry) => entry.textContent === text)
  expect(button, `button ${text}`).toBeDefined()
  await act(async () => button!.click())
}
function field(label: string) {
  const element = [...container.querySelectorAll('label')].find((entry) => entry.textContent?.startsWith(label))
  expect(element, `field ${label}`).toBeDefined()
  return (element!.htmlFor ? document.getElementById(element!.htmlFor) : element!.querySelector('input, textarea, select')) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}
async function fill(label: string, value: string) {
  const input = field(label)
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function check(label: string) {
  await act(async () => field(label).click())
}
async function modal(props: Partial<ComponentProps<typeof CreateRoutineModal>> = {}) {
  if (props.routine) serverRoutines = [props.routine]
  const onCreated = vi.fn<(routine: AgentRoutine) => void>()
  const onClose = vi.fn<() => void>()
  await render(<CreateRoutineModal agent={agent} initialName="Weekly review" initialPrompt="Review all open issues." onCreated={onCreated} onClose={onClose} {...props} />)
  return { onCreated, onClose }
}

async function receipt(initialRoutine: AgentRoutine) {
  serverRoutines = [initialRoutine]
  const onUpdated = vi.fn<(routine: AgentRoutine) => void>()
  function Receipt() {
    const [routine, setRoutine] = useState(initialRoutine)
    return <RoutineCard agent={agent} routine={routine} onUpdated={(saved) => { setRoutine(saved); onUpdated(saved) }} />
  }
  await render(<Receipt />)
  return onUpdated
}

describe('routine form', () => {
  it('prefills the task, shows the bot and context warning, and sends nothing before confirmation', async () => {
    const saved = { ...record(), name: 'Server name', paused: false, hookId: 42 }
    api.createRoutine.mockResolvedValue(saved)
    const { onCreated } = await modal()
    expect(field('Routine name').value).toBe('Weekly review')
    expect(field('Standalone task').value).toBe('Review all open issues.')
    expect(container.textContent).toContain('Riley')
    expect(container.textContent).toContain('does not replay attachments or context')
    await fill('Interval (minutes)', '90')
    await click('Review routine')
    expect(container.textContent).toContain('Every 1 hour 30 minutes')
    expect(container.textContent).toContain('existing approval rules')
    expect(api.createRoutine).not.toHaveBeenCalled()
    // Submitting the review form (e.g. Enter) is not the explicit confirm action.
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(api.createRoutine).not.toHaveBeenCalled()
    await click('Confirm and enable')
    expect(api.createRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, 'Weekly review', 'Review all open issues.', { kind: 'interval', everyMs: 5400000 }, false)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it.each(['', '0', '-1', '0.5'])('rejects invalid interval %j instead of clamping it', async (minutes) => {
    await modal()
    await fill('Interval (minutes)', minutes)
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('at least 1 minute')
    expect(api.createRoutine).not.toHaveBeenCalled()
  })

  it('requires a name and standalone task', async () => {
    await modal({ initialName: '', initialPrompt: '' })
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('name')
    await fill('Routine name', 'Review')
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('standalone task')
    expect(api.createRoutine).not.toHaveBeenCalled()
  })

  it('validates weekdays and time zone and creates the exact weekly schedule paused', async () => {
    api.createRoutine.mockResolvedValue(record())
    await modal()
    await fill('Schedule', 'weekly')
    expect(field('Time zone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('weekday')
    await check('Monday')
    await check('Thursday')
    await fill('Time zone', 'Not/AZone')
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('valid time zone')
    await fill('Time zone', '')
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('valid time zone')
    await fill('Time zone', 'Asia/Tokyo')
    await fill('Time', '17:35')
    await fill('Every N weeks', '2')
    await fill('Starting status', 'paused')
    await click('Review routine')
    expect(container.textContent).toContain('Every 2 weeks on Monday, Thursday at 17:35 (Asia/Tokyo)')
    expect(api.createRoutine).not.toHaveBeenCalled()
    await click('Create paused routine')
    expect(api.createRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, 'Weekly review', 'Review all open issues.', {
      kind: 'calendar', freq: 'weekly', interval: 2, byDay: ['MO', 'TH'], hour: 17, minute: 35, timeZone: 'Asia/Tokyo',
    }, true)
  })

  it.each(['hourly', 'daily'] as const)('creates an exact %s calendar rule', async (freq) => {
    api.createRoutine.mockResolvedValue(record())
    await modal()
    await fill('Schedule', freq)
    await fill('Time zone', 'Europe/London')
    if (freq === 'hourly') {
      await fill('Minute of the hour', '15')
    } else await fill('Time', '09:15')
    await click('Review routine')
    await click('Confirm and enable')
    expect(api.createRoutine.mock.calls[0][3]).toEqual({ kind: 'calendar', freq, timeZone: 'Europe/London', minute: 15, ...(freq === 'daily' ? { hour: 9 } : {}) })
  })

  it.each(['', '-1', '60', '1.5'])('rejects invalid hourly minute %j', async (minute) => {
    await modal()
    await fill('Schedule', 'hourly')
    await fill('Minute of the hour', minute)
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('0 to 59')
    expect(api.createRoutine).not.toHaveBeenCalled()
  })

  it('requires an explicit future one-time datetime in the browser zone', async () => {
    api.createRoutine.mockResolvedValue(record())
    await modal()
    await fill('Schedule', 'once')
    expect(field('Date and time').value).toBe('')
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Choose a date and time')
    await fill('Date and time', '2020-01-01T09:00')
    await click('Review routine')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('future')
    const local = `${new Date().getFullYear() + 1}-06-18T14:25`
    await fill('Date and time', local)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(container.textContent).toContain(`Time zone: ${zone}`)
    await click('Review routine')
    expect(api.createRoutine).not.toHaveBeenCalled()
    await click('Confirm and enable')
    expect(api.createRoutine.mock.calls[0][3]).toEqual({ kind: 'once', fireAt: new Date(local).getTime(), timeZone: zone })
  })

  it('revalidates a one-time date after review and before activation', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await modal()
    await fill('Schedule', 'once')
    const future = new Date(now + 86400000)
    const local = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}T12:30`
    await fill('Date and time', local)
    await click('Review routine')
    clock.mockReturnValue(now + 172800000)
    await click('Confirm and enable')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('future')
    expect(api.createRoutine).not.toHaveBeenCalled()
  })

  it('allows returning from review and cancelling without any RPC', async () => {
    const { onClose } = await modal()
    await click('Review routine')
    await click('Back')
    expect(field('Routine name').value).toBe('Weekly review')
    await click('Cancel')
    expect(onClose).toHaveBeenCalledOnce()
    expect(api.createRoutine).not.toHaveBeenCalled()
    expect(api.updateRoutine).not.toHaveBeenCalled()
  })

  it('shows save errors and lets the user retry the reviewed values', async () => {
    api.createRoutine.mockRejectedValueOnce(new Error('Scheduler unavailable')).mockResolvedValueOnce(record())
    const { onCreated } = await modal()
    await click('Review routine')
    await click('Confirm and enable')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Scheduler unavailable')
    expect(onCreated).not.toHaveBeenCalled()
    await click('Confirm and enable')
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it.each<AgentRoutineSchedule>([
    { kind: 'calendar', freq: 'weekly', byDay: ['TU', 'FR'], interval: 3, hour: 11, minute: 17, timeZone: 'Asia/Tokyo' },
    { kind: 'slack', channelId: 'C123', matchKind: 'keyword', keyword: 'deploy' },
    { kind: 'github', owner: 'cloudflare', repo: 'workers', events: ['pr-merged', 'review-requested'] },
    { kind: 'once', fireAt: 1234567890, timeZone: 'America/New_York' },
  ])('preserves paused state and omits untouched $kind schedules on task/name edits', async (schedule) => {
    const persisted = { ...schedule, jitter: 1234, futureOption: { keep: true } }
    const routine = record(persisted)
    const saved = { ...routine, name: 'Renamed', prompt: 'New standalone task.', updated: new Date(123) }
    api.updateRoutine.mockResolvedValue(saved)
    const { onCreated } = await modal({ routine })
    expect(field('Routine name').value).toBe(routine.name)
    expect(field('Status after saving').value).toBe('paused')
    await fill('Routine name', 'Renamed')
    await fill('Standalone task', 'New standalone task.')
    await click('Review routine')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    await click('Save paused routine')
    expect(api.updateRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, routine.id, { name: 'Renamed', prompt: 'New standalone task.' })
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(saved)
  })

  it('retains optional and unknown calendar fields when changing just the time', async () => {
    const schedule = { kind: 'calendar', freq: 'weekly', byDay: ['WE'], interval: 4, hour: 9, minute: 0, timeZone: 'Europe/Paris', jitter: 900 } as const
    const routine = record({ ...schedule, byDay: [...schedule.byDay] })
    api.updateRoutine.mockResolvedValue(routine)
    await modal({ routine })
    await fill('Time', '10:45')
    await click('Review routine')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls[0][2].schedule).toEqual({ ...schedule, hour: 10, minute: 45 })
  })

  it.each<AgentRoutineSchedule>([
    { kind: 'slack', channelId: 'C123', matchKind: 'keyword', keyword: 'deploy' },
    { kind: 'github', owner: 'cloudflare', repo: 'workers', events: ['pr-merged'] },
  ])('can edit $kind triggers without discarding the other trigger fields', async (schedule) => {
    const persisted = { ...schedule, jitter: 5 }
    const routine = record(persisted)
    api.updateRoutine.mockResolvedValue(routine)
    await modal({ routine })
    if (schedule.kind === 'slack') await fill('Keyword', 'release')
    else await fill('Repository', 'agents')
    await click('Review routine')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls[0][2].schedule).toEqual({ ...routine.schedule, ...(schedule.kind === 'slack' ? { keyword: 'release' } : { repo: 'agents' }) })
  })

  it('requires review before enabling a paused edit', async () => {
    const routine = record()
    api.updateRoutine.mockResolvedValue({ ...routine, paused: false })
    await modal({ routine })
    await fill('Status after saving', 'enabled')
    await click('Review routine')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    await click('Confirm and save')
    expect(api.updateRoutine.mock.calls[0][2]).toEqual({ paused: false })
  })

  it('reconciles a failed update without calling the successful-save callback or dirtying an untouched schedule', async () => {
    const routine = { ...record(), paused: false }
    const current = { ...routine, name: 'Renamed', schedule: { ...routine.schedule } }
    serverRoutines = [routine]
    api.updateRoutine.mockImplementationOnce(async () => { serverRoutines = [current]; throw new Error('Response lost') }).mockResolvedValueOnce(current)
    const onCreated = vi.fn<(routine: AgentRoutine) => void>()
    const onReconciled = vi.fn<(routine: AgentRoutine | null) => void>()
    function Editor() {
      const [saved, setSaved] = useState(routine)
      return <CreateRoutineModal agent={agent} routine={saved} onClose={() => {}} onCreated={onCreated} onReconciled={(value) => {
        onReconciled(value)
        if (value) setSaved(value)
      }} />
    }
    await render(<Editor />)
    await fill('Routine name', 'Renamed')
    await click('Review routine')
    await click('Confirm and save')

    expect(api.listRoutines).toHaveBeenCalledTimes(3)
    expect(onReconciled).toHaveBeenCalledExactlyOnceWith(current)
    expect(onCreated).not.toHaveBeenCalled()
    expect(field('Routine name').value).toBe('Renamed')
    expect(container.textContent).toContain('Current saved status: Active')

    await click('Review routine')
    await click('Confirm and save')
    expect(api.updateRoutine.mock.calls[1][2]).toEqual({})
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(current)
  })
})

describe('routine card and list', () => {
  it.each([true, false])('reconciles status update errors without optimistic status changes (paused=%s)', async (paused) => {
    const current = { ...record(), paused }
    api.updateRoutine.mockRejectedValue(new Error('Connection lost'))
    api.listRoutines.mockResolvedValue([current])
    const onUpdated = vi.fn<(routine: AgentRoutine) => void>()
    await render(<RoutineCard agent={agent} routine={{ ...record(), paused }} onUpdated={onUpdated} />)
    await click(paused ? 'Resume' : 'Pause')
    expect(api.updateRoutine).toHaveBeenCalledTimes(paused ? 0 : 1)
    if (paused) {
      await click('Confirm and enable')
    }
    expect(api.updateRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, 'routine-1', { paused: !paused })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection lost')
    expect(container.textContent).toContain(paused ? 'Paused' : 'Active')
    expect(api.listRoutines).toHaveBeenCalledTimes(3)
    expect(onUpdated).toHaveBeenLastCalledWith(current)
  })

  it('returns actual server records for pause and resume, with a cancellable enable confirmation', async () => {
    const active = { ...record(), paused: false, hookId: 77 }
    const paused = { ...active, paused: true, updated: new Date(123) }
    api.updateRoutine.mockResolvedValueOnce(active).mockResolvedValueOnce(paused)
    const onUpdated = await receipt(record())
    await click('Resume')
    await click('Cancel')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    await click('Resume')
    expect(container.textContent).toContain('existing approval rules')
    await click('Confirm and enable')
    expect(onUpdated).toHaveBeenNthCalledWith(1, active)
    expect(container.textContent).toContain('Active')
    serverRoutines = [active]
    await click('Pause')
    expect(onUpdated).toHaveBeenNthCalledWith(2, paused)
    expect(container.textContent).toContain('Paused')
  })

  it('owns the edit modal and forwards its saved record', async () => {
    const routine = record()
    const saved = { ...routine, prompt: 'Changed task' }
    serverRoutines = [routine]
    api.updateRoutine.mockResolvedValue(saved)
    const onUpdated = vi.fn<(routine: AgentRoutine) => void>()
    await render(<RoutineCard agent={agent} routine={routine} onUpdated={onUpdated} />)
    await click('Edit')
    await fill('Standalone task', 'Changed task')
    await click('Review routine')
    await click('Save paused routine')
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(saved)
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('keeps the edit draft open after replacement fails, then shows persisted paused edits after cancel', async () => {
    const active = { ...record(), paused: false }
    const persisted = { ...record({ kind: 'interval', everyMs: 7200000 }), name: 'Edited summary', prompt: 'Edited task', paused: true }
    api.updateRoutine.mockImplementation(async () => { serverRoutines = [persisted]; throw new Error('Could not register replacement schedule') })
    const onUpdated = await receipt(active)
    await click('Edit')
    await fill('Routine name', 'Edited summary')
    await fill('Standalone task', 'Edited task')
    await fill('Interval (minutes)', '120')
    await click('Review routine')
    await click('Confirm and save')

    expect(api.listRoutines).toHaveBeenCalledTimes(4)
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(persisted)
    expect(container.querySelector('dialog')).not.toBeNull()
    expect(field('Routine name').value).toBe('Edited summary')
    expect(field('Standalone task').value).toBe('Edited task')
    expect(field('Interval (minutes)').value).toBe('120')
    expect(field('Status after saving').value).toBe('paused')
    expect(container.textContent).toContain('Current saved status: Paused')
    await click('Cancel')
    expect(container.querySelector('dialog')).toBeNull()
    expect(container.querySelector('h3')?.textContent).toBe('Edited summary')
    expect(container.textContent).toContain('Edited task')
    expect(container.textContent).toContain('Every 2 hours')
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).not.toContain('Active')
  })

  it('marks a failed edit unverified when reconciliation fails, blocks stale toggles, and recovers via a status check', async () => {
    const active = { ...record(), paused: false }
    const persisted = { ...record({ kind: 'interval', everyMs: 7200000 }), prompt: 'Persisted task' }
    api.updateRoutine.mockImplementation(async () => {
      serverRoutines = [persisted]
      api.listRoutines.mockRejectedValueOnce(new Error('Disconnected'))
      throw new Error('Could not enable replacement')
    })
    const onUpdated = await receipt(active)
    await click('Edit')
    await fill('Standalone task', 'Persisted task')
    await fill('Interval (minutes)', '120')
    await click('Review routine')
    await click('Confirm and save')
    expect(onUpdated).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Status unverified')
    expect(container.textContent).toContain('may be paused')
    expect(container.textContent).not.toContain('Active')
    expect(field('Standalone task').value).toBe('Persisted task')
    await click('Review routine')
    expect(api.updateRoutine).toHaveBeenCalledOnce()
    await click('Cancel')

    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Edit', 'Retry status check'])
    await click('Retry status check')
    expect(api.listRoutines).toHaveBeenCalledTimes(5)
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(persisted)
    expect(container.textContent).not.toContain('Status unverified')
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).toContain('Persisted task')
    expect(container.textContent).toContain('Every 2 hours')
  })

  it('recovers status inside the open editor without replacing the draft or saving it', async () => {
    const active = { ...record(), paused: false }
    const persisted = { ...record(), name: 'Server name', prompt: 'Server task' }
    api.updateRoutine.mockImplementation(async () => {
      serverRoutines = [persisted]
      api.listRoutines.mockRejectedValueOnce(new Error('Disconnected'))
      throw new Error('Save failed')
    })
    const onUpdated = await receipt(active)
    await click('Edit')
    await fill('Routine name', 'Draft name')
    await fill('Standalone task', 'Draft task')
    await fill('Interval (minutes)', '120')
    await click('Review routine')
    await click('Confirm and save')
    await click('Retry status check', container.querySelector('dialog')!)
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(persisted)
    expect(field('Routine name').value).toBe('Draft name')
    expect(field('Standalone task').value).toBe('Draft task')
    expect(field('Interval (minutes)').value).toBe('120')
    expect(container.textContent).toContain('Current saved status: Paused')
    expect(container.querySelector('h3')?.textContent).toBe('Server name')
    expect(api.updateRoutine).toHaveBeenCalledOnce()
    await click('Cancel')
    expect(container.textContent).toContain('Server task')
    expect(container.textContent).not.toContain('Draft task')
  })

  it('treats a failed status update as unverified until an authoritative read succeeds, including after reopening Edit', async () => {
    const active = { ...record(), paused: false }
    const persisted = { ...record(), prompt: 'Authoritative task' }
    api.updateRoutine.mockImplementation(async () => {
      serverRoutines = [persisted]
      api.listRoutines.mockRejectedValueOnce(new Error('Disconnected'))
      throw new Error('Connection lost')
    })
    const onUpdated = await receipt(active)
    await click('Pause')
    expect(container.textContent).toContain('Status unverified')
    expect(container.textContent).not.toContain('Active')
    expect(onUpdated).not.toHaveBeenCalled()
    await click('Edit')
    expect(api.updateRoutine).toHaveBeenCalledOnce()
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(persisted)
    expect(field('Standalone task').value).toBe('Authoritative task')
    expect(field('Status after saving').value).toBe('paused')
    await click('Cancel')
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).toContain('Authoritative task')
    expect(container.textContent).not.toContain('Status unverified')
    await click('Resume')
    expect(api.updateRoutine).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Confirm and enable')
  })

  it('reopens a failed replacement from the verified two-hour paused record, then sends the exact newly reviewed hour', async () => {
    const original = { ...record({ kind: 'interval', everyMs: 3600000 }), paused: false }
    const persisted = { ...record({ kind: 'interval', everyMs: 7200000 }), name: 'Persisted name', prompt: 'Persisted task' }
    api.updateRoutine.mockImplementationOnce(async () => {
      serverRoutines = [persisted]
      api.listRoutines.mockRejectedValueOnce(new Error('Status unavailable'))
      throw new Error('Replacement failed')
    })
    await receipt(original)
    await click('Edit')
    await fill('Interval (minutes)', '120')
    await click('Review routine')
    await click('Confirm and save')
    await click('Cancel')
    expect(container.textContent).toContain('Status unverified')
    await click('Edit')
    expect(field('Interval (minutes)').value).toBe('120')
    expect(field('Routine name').value).toBe('Persisted name')
    expect(field('Standalone task').value).toBe('Persisted task')
    expect(field('Status after saving').value).toBe('paused')
    await fill('Interval (minutes)', '60')
    await click('Review routine')
    expect(container.querySelector('dialog')?.textContent).toContain('Every 1 hour')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls[1][2]).toEqual({ schedule: { kind: 'interval', everyMs: 3600000 } })
    expect(serverRoutines[0]).toEqual({ ...persisted, schedule: { kind: 'interval', everyMs: 3600000 } })
  })

  it('rebases a standalone stale modal after verification instead of reviewing a schedule the patch will not save', async () => {
    const stale = { ...record({ kind: 'interval', everyMs: 3600000 }), paused: false }
    const current = record({ kind: 'interval', everyMs: 7200000 })
    api.listRoutines.mockResolvedValue([current])
    api.updateRoutine.mockResolvedValue(current)
    await modal({ routine: stale, statusUnverified: true })
    expect(field('Interval (minutes)').value).toBe('120')
    expect(field('Status after saving').value).toBe('paused')
    await click('Review routine')
    expect(container.textContent).toContain('Every 2 hours')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls[0][2]).toEqual({})
  })

  it('retains an explicitly edited schedule across reconciliation and compares it to the latest saved schedule', async () => {
    const original = { ...record({ kind: 'interval', everyMs: 3600000 }), paused: false }
    const persisted = record({ kind: 'interval', everyMs: 7200000 })
    api.updateRoutine.mockImplementationOnce(async () => { serverRoutines = [persisted]; throw new Error('Replacement failed') })
    await receipt(original)
    await click('Edit')
    await fill('Interval (minutes)', '90')
    await click('Review routine')
    await click('Confirm and save')
    expect(field('Interval (minutes)').value).toBe('90')
    expect(field('Status after saving').value).toBe('paused')
    await click('Review routine')
    expect(container.querySelector('dialog')?.textContent).toContain('Every 1 hour 30 minutes')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls[1][2]).toEqual({ schedule: { kind: 'interval', everyMs: 5400000 } })
  })

  it('synchronizes a list pause into a separate stale receipt before editing without re-enabling or overwriting other fields', async () => {
    const stale = { ...record(), paused: false }
    serverRoutines = [{ ...stale, name: 'Latest name', prompt: 'Latest task', schedule: { kind: 'interval', everyMs: 7200000 } }]
    const onUpdated = vi.fn<(routine: AgentRoutine) => void>()
    await render(<>
      <section aria-label="Receipt"><RoutineCard agent={agent} routine={stale} onUpdated={onUpdated} /></section>
      <section aria-label="List"><RoutinesList agent={agent} /></section>
    </>)
    expect(api.listRoutines).toHaveBeenCalledOnce()
    const receiptSurface = container.querySelector('[aria-label="Receipt"]')!
    const listSurface = container.querySelector('[aria-label="List"]')!
    await click('Pause', listSurface)
    expect(receiptSurface.textContent).toContain('Paused')
    expect(receiptSurface.textContent).not.toContain('Active')
    await click('Edit', receiptSurface)
    expect(field('Routine name').value).toBe('Latest name')
    expect(field('Standalone task').value).toBe('Latest task')
    expect(field('Interval (minutes)').value).toBe('120')
    expect(field('Status after saving').value).toBe('paused')
    await fill('Routine name', 'Renamed only')
    await click('Review routine')
    await click('Save paused routine')
    expect(api.updateRoutine.mock.calls.map((call) => call[2])).toEqual([{ paused: true }, { name: 'Renamed only' }])
    expect(serverRoutines[0]).toMatchObject({ name: 'Renamed only', prompt: 'Latest task', paused: true, schedule: { kind: 'interval', everyMs: 7200000 } })
    expect(listSurface.textContent).toContain('Renamed only')
    expect(onUpdated).toHaveBeenLastCalledWith(serverRoutines[0])
  })

  it('rejects a stale reviewed save when preflight discovers an external pause and task change', async () => {
    const active = { ...record(), paused: false }
    await receipt(active)
    await click('Edit')
    await fill('Routine name', 'My draft name')
    await click('Review routine')
    serverRoutines = [{ ...active, prompt: 'External task', paused: true }]
    await click('Confirm and save')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    expect(container.textContent).toContain('changed elsewhere')
    expect(field('Routine name').value).toBe('My draft name')
    expect(field('Standalone task').value).toBe('External task')
    expect(field('Status after saving').value).toBe('paused')
    await click('Review routine')
    await click('Save paused routine')
    expect(api.updateRoutine).toHaveBeenCalledExactlyOnceWith(agent.id, active.id, { name: 'My draft name' })
    expect(serverRoutines[0].paused).toBe(true)
    expect(serverRoutines[0].prompt).toBe('External task')
  })

  it('blocks stale status-dependent actions when their verification fails', async () => {
    const active = { ...record(), paused: false }
    await receipt(active)
    api.listRoutines.mockRejectedValue(new Error('Offline'))
    await click('Pause')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Status unverified')
    expect(container.textContent).not.toContain('Active')
    await click('Edit')
    expect(container.querySelector('dialog')).toBeNull()
    expect(api.updateRoutine).not.toHaveBeenCalled()
  })

  it('does not invert a stale Pause into Resume when verification finds the routine already paused', async () => {
    const active = { ...record(), paused: false }
    await receipt(active)
    serverRoutines = [{ ...active, paused: true }]
    await click('Pause')
    expect(api.updateRoutine).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Paused')
    expect(container.textContent).toContain('changed elsewhere')
  })

  it('keeps uncertainty across receipt unmounts and deduplicates a remount status read', async () => {
    const stale = { ...record(), paused: false }
    api.updateRoutine.mockImplementationOnce(async () => {
      serverRoutines = [{ ...stale, paused: true }]
      api.listRoutines.mockRejectedValueOnce(new Error('Disconnected'))
      throw new Error('Update failed')
    })
    await receipt(stale)
    await click('Pause')
    expect(container.textContent).toContain('Status unverified')
    await render(null)
    let finish!: (routines: AgentRoutine[]) => void
    api.listRoutines.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const calls = api.listRoutines.mock.calls.length
    const onUpdated = vi.fn<(routine: AgentRoutine) => void>()
    await render(<>
      <RoutineCard agent={agent} routine={stale} onUpdated={onUpdated} />
      <RoutineCard agent={agent} routine={stale} onUpdated={onUpdated} />
      <RoutinesList agent={agent} />
    </>)
    expect(api.listRoutines).toHaveBeenCalledTimes(calls + 1)
    expect(container.textContent).toContain('Status unverified')
    expect(container.textContent).not.toContain('Active')
    expect([...container.querySelectorAll('button')].filter((button) => button.textContent === 'Pause' || button.textContent === 'Resume')).toHaveLength(0)
    await act(async () => finish(serverRoutines))
    expect(container.textContent).not.toContain('Status unverified')
    expect(container.querySelectorAll('article')).toHaveLength(3)
    expect(api.listRoutines).toHaveBeenCalledTimes(calls + 1)
    expect(onUpdated).toHaveBeenLastCalledWith(serverRoutines[0])
  })

  it('isolates routine snapshots by authenticated API session', async () => {
    const oldRoutine = { ...record(), name: 'Private to previous session', paused: false }
    await receipt(oldRoutine)
    await render(null)
    sessionApi = { ...api }
    api.listRoutines.mockRejectedValue(new Error('New session offline'))
    await render(<RoutineCard agent={agent} routine={{ ...record(), name: 'New session receipt' }} onUpdated={() => {}} />)
    expect(container.textContent).not.toContain('Private to previous session')
    expect(container.textContent).toContain('Status unverified')
    expect(container.textContent).not.toContain('Active')
  })

  it('does not claim a passed one-time routine is active or completed, or offer resume', async () => {
    const routine = { ...record({ kind: 'once', fireAt: 1, timeZone: 'UTC' }), paused: false }
    serverRoutines = [routine]
    await render(<RoutineCard agent={agent} routine={routine} onUpdated={vi.fn<(routine: AgentRoutine) => void>()} />)
    expect(container.textContent).toContain('Time passed')
    expect(container.textContent).not.toContain('Active')
    expect(container.textContent).not.toContain('Completed')
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Edit'])
  })

  it('makes list errors visible and retries', async () => {
    api.listRoutines.mockRejectedValueOnce(new Error('Could not connect')).mockResolvedValueOnce([record()])
    await render(<RoutinesList agent={agent} />)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not connect')
    await click('Try again')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('Every 1 hour 30 minutes')
  })

  it('ignores an old agent list response after switching bots', async () => {
    let resolveOld!: (routines: AgentRoutine[]) => void
    api.listRoutines.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve })).mockResolvedValueOnce([{ ...record(), name: 'New bot routine' }])
    await render(<RoutinesList agent={agent} />)
    await render(<RoutinesList agent={{ ...agent, id: 'bot-2' }} />)
    await act(async () => resolveOld([record()]))
    expect(container.textContent).toContain('New bot routine')
    expect(container.textContent).not.toContain('Daily summary')
  })
})

describe('routine schedule summaries', () => {
  it.each([
    [60000, 'Every 1 minute'], [5400000, 'Every 1 hour 30 minutes'],
    [90061001, 'Every 1 day 1 hour 1 minute 1 second 1 millisecond'],
  ])('does not round %s milliseconds', (everyMs, expected) => {
    expect(formatRoutineSchedule({ kind: 'interval', everyMs })).toBe(expected)
  })

  it('shows calendar interval, weekdays, time, and timezone', () => {
    expect(formatRoutineSchedule({ kind: 'calendar', freq: 'weekly', interval: 2, byDay: ['MO', 'FR'], hour: 9, minute: 5, timeZone: 'America/New_York' })).toBe('Every 2 weeks on Monday, Friday at 09:05 (America/New_York)')
    expect(formatRoutineSchedule({ kind: 'calendar', freq: 'hourly', interval: 3, minute: 25, timeZone: 'UTC' })).toBe('Every 3 hours at minute 25 (UTC)')
    expect(formatRoutineSchedule({ kind: 'once', fireAt: 1800000000000, timeZone: 'Asia/Tokyo' })).toContain('(Asia/Tokyo)')
  })
})
