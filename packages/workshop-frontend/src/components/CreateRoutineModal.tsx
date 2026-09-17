import { useEffect, useId, useState } from 'react'
import { Checkbox, Dialog, Select } from '@cloudflare/kumo'
import type { AgentProfile, AgentRoutine, AgentRoutineSchedule } from '@gadgets/workshop-shared/api'
import { X } from '@phosphor-icons/react'
import Avatar from './Avatar'
import { WorkshopButton, WorkshopIconButton, WorkshopInput, WorkshopInputArea } from './WorkshopControls'
import { formatRoutineSchedule, ROUTINE_WEEKDAYS } from './routineFormat'
import { routineValuesEqual, sameRoutineTask, useRoutineState } from './routineState'

const TRIGGERS = [
  ['interval', 'Interval'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly'],
  ['once', 'One-time'], ['slack', 'Slack event'], ['github', 'GitHub event'],
] as const
const GITHUB_EVENTS = ['pr-opened', 'pr-merged', 'pr-comment', 'review-requested'] as const
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-kumo-default'

function localDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  const [month, day, hour, minute] = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()].map((value) => String(value).padStart(2, '0'))
  return `${date.getFullYear()}-${month}-${day}T${hour}:${minute}`
}

export default function CreateRoutineModal({
  agent,
  initialName = '',
  initialPrompt = '',
  routine,
  onClose,
  onCreated,
  onReconciled,
  statusUnverified = false,
}: {
  agent: AgentProfile
  initialName?: string
  initialPrompt?: string
  routine?: AgentRoutine
  onClose: () => void
  onCreated: (routine: AgentRoutine) => void
  /** Reconciles a failed update without closing the draft; null means status is unverified. */
  onReconciled?: (routine: AgentRoutine | null) => void
  statusUnverified?: boolean
}) {
  const { store, state } = useRoutineState(agent.id)
  const id = useId()
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [name, setName] = useState(routine?.name ?? initialName)
  const [prompt, setPrompt] = useState(routine?.prompt ?? initialPrompt)
  const [baseline, setBaseline] = useState(routine)
  const [schedule, setSchedule] = useState<AgentRoutineSchedule>(routine?.schedule ?? { kind: 'interval', everyMs: 3600000 })
  const [onceInput, setOnceInput] = useState(routine?.schedule.kind === 'once' ? localDateTime(routine.schedule.fireAt) : '')
  const [paused, setPaused] = useState(routine?.paused ?? false)
  const [reviewing, setReviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reconciledRoutine = routine && state.verified ? state.routines.find((entry) => entry.id === routine.id) : undefined
  const unverified = !!routine && !reconciledRoutine
  const checkingStatus = state.busy
  const scheduleChanged = !baseline || !routineValuesEqual(schedule, baseline.schedule)
  const trigger = schedule.kind === 'calendar' ? schedule.freq : schedule.kind

  useEffect(() => {
    if (routine && (statusUnverified || !store.getSnapshot().verified)) void store.refresh().catch(() => {})
  }, [store, routine?.id, statusUnverified])

  // Rebase untouched fields before rendering a new review; explicit edits remain a draft.
  // Comparing against the latest baseline also makes a retained, different schedule an exact patch.
  if (reconciledRoutine && reconciledRoutine !== baseline) {
    setBaseline(reconciledRoutine)
    if (baseline && !sameRoutineTask(reconciledRoutine, baseline)) {
      if (name === baseline.name) setName(reconciledRoutine.name)
      if (prompt === baseline.prompt) setPrompt(reconciledRoutine.prompt)
      if (paused === baseline.paused) setPaused(reconciledRoutine.paused)
      if (routineValuesEqual(schedule, baseline.schedule)) {
        setSchedule(reconciledRoutine.schedule)
        setOnceInput(reconciledRoutine.schedule.kind === 'once' ? localDateTime(reconciledRoutine.schedule.fireAt) : '')
      }
      setReviewing(false)
    }
  }

  const reconcile = async () => {
    if (!routine) return
    onReconciled?.(null)
    try {
      const current = (await store.refresh()).find((entry) => entry.id === routine.id)
      onReconciled?.(current ?? null)
    } catch {
      // Keep the draft and the unverified warning until a status check succeeds.
    }
  }

  const validate = () => {
    if (!name.trim()) return 'Enter a routine name.'
    if (!prompt.trim()) return 'Enter a standalone task for the bot.'
    // Name/task-only edits must not reinterpret an existing schedule (including past one-shots).
    if (!scheduleChanged && (paused || !baseline?.paused)) return null
    if (schedule.kind === 'interval' && (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 60000)) {
      return 'Enter an interval of at least 1 minute.'
    }
    if (schedule.kind === 'calendar' || schedule.kind === 'once') {
      try {
        if (!schedule.timeZone.trim()) throw new Error('Empty time zone')
        Intl.DateTimeFormat(undefined, { timeZone: schedule.timeZone }).format()
      } catch {
        return 'Enter a valid time zone, such as Europe/London or America/Los_Angeles.'
      }
    }
    if (schedule.kind === 'calendar') {
      if (!Number.isSafeInteger(schedule.interval ?? 1) || (schedule.interval ?? 1) < 1) return 'Enter a repeat interval of at least 1.'
      if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) return 'Enter a minute from 0 to 59.'
      if (schedule.freq !== 'hourly' && (schedule.hour === undefined || !Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23)) return 'Choose a valid time.'
      if (schedule.freq === 'weekly' && !schedule.byDay?.length) return 'Choose at least one weekday.'
    }
    if (schedule.kind === 'once') {
      if (!Number.isFinite(schedule.fireAt)) return 'Choose a date and time.'
      if (schedule.fireAt <= Date.now()) return 'Choose a date and time in the future.'
      if (scheduleChanged && localDateTime(schedule.fireAt) !== onceInput) return 'That local time does not exist in your time zone. Choose another time.'
    }
    if (schedule.kind === 'slack') {
      if (!schedule.channelId.trim()) return 'Enter a Slack channel ID.'
      if (schedule.matchKind === 'keyword' && !schedule.keyword?.trim()) return 'Enter a keyword.'
    }
    if (schedule.kind === 'github') {
      if (!schedule.owner.trim() || !schedule.repo.trim()) return 'Enter a GitHub owner and repository.'
      if (!schedule.events.length) return 'Choose at least one GitHub event.'
    }
    return null
  }

  const save = async () => {
    if (!reviewing || saving || unverified || checkingStatus) return
    const validationError = validate()
    setError(validationError)
    if (validationError) {
      setReviewing(false)
      return
    }
    setSaving(true)
    try {
      const saved = baseline
        ? await store.update(baseline, {
          ...(name.trim() !== baseline.name ? { name: name.trim() } : {}),
          ...(prompt.trim() !== baseline.prompt ? { prompt: prompt.trim() } : {}),
          ...(paused !== baseline.paused ? { paused } : {}),
          ...(scheduleChanged ? { schedule } : {}),
        })
        : await store.create(name.trim(), prompt.trim(), schedule, paused)
      onCreated(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the routine. Try again.')
      if (routine) {
        setReviewing(false)
        const latest = store.getSnapshot()
        onReconciled?.(latest.verified ? latest.routines.find((entry) => entry.id === routine.id) ?? null : null)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !saving && !checkingStatus) onClose() }}>
      <Dialog className="responsive-dialog !top-[clamp(28px,10vh,96px)] !flex !max-h-[min(80vh,calc(var(--app-height)-32px))] !w-[min(520px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="sm">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-kumo-line px-5 py-4">
          <div>
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              {reviewing ? 'Review routine' : routine ? 'Edit routine' : 'Create routine'}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-kumo-subtle">
              {reviewing ? 'Check the task, schedule, and starting status before saving.' : 'Give your bot a standalone task to run on a schedule or event.'}
            </Dialog.Description>
          </div>
          <WorkshopIconButton aria-label="Close routine" onClick={onClose} disabled={saving || checkingStatus}><X size={16} /></WorkshopIconButton>
        </div>
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" noValidate onSubmit={(e) => {
          e.preventDefault()
          if (reviewing || saving || unverified || checkingStatus) return
          const validationError = validate()
          setError(validationError)
          if (!validationError) setReviewing(true)
        }}>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <div className="flex items-center gap-3 rounded-lg border border-kumo-line p-3">
              <Avatar src={agent.avatar?.url} fallback={agent.name[0]?.toUpperCase()} />
              <div className="min-w-0 text-sm">
                <p className="break-words font-medium text-kumo-default">{agent.name}</p>
                <p className="break-words text-xs text-kumo-subtle">{agent.title || 'Bot'}</p>
              </div>
            </div>
            <p id={`${id}-context`} className="my-3 text-xs leading-5 text-kumo-subtle">
              Each run starts a new conversation. It does not replay attachments or context from this conversation. Include everything the bot needs in the task.
            </p>
            {reviewing ? (
              <dl className="space-y-4 text-sm">
                <div><dt className="text-kumo-subtle">Name</dt><dd className="break-words font-medium">{name.trim()}</dd></div>
                <div><dt className="text-kumo-subtle">Standalone task</dt><dd className="whitespace-pre-wrap break-words">{prompt.trim()}</dd></div>
                <div><dt className="text-kumo-subtle">Schedule</dt><dd className="break-words">{formatRoutineSchedule(schedule)}</dd></div>
                <div><dt className="text-kumo-subtle">Status after saving</dt><dd>{paused ? 'Paused - will not run until you enable it.' : schedule.kind === 'once' && schedule.fireAt <= Date.now() ? 'Time passed - choose a future time to schedule another run.' : 'Enabled - runs automatically on this schedule or event.'}</dd></div>
              </dl>
            ) : (
              <div className="space-y-4">
                <div>
                  <label id={`${id}-name-label`} htmlFor={`${id}-name`} className={LABEL_CLASS}>Routine name</label>
                  <WorkshopInput id={`${id}-name`} aria-labelledby={`${id}-name-label`} className="w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily summary" />
                </div>
                <div>
                  <label id={`${id}-prompt-label`} htmlFor={`${id}-prompt`} className={LABEL_CLASS}>Standalone task</label>
                  <WorkshopInputArea id={`${id}-prompt`} aria-labelledby={`${id}-prompt-label`} aria-describedby={`${id}-context`} className="w-full" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize new issues in the repository and highlight anything that needs my attention." />
                </div>
                <Select label="Schedule" className="w-full" value={trigger} renderValue={(value) => TRIGGERS.find(([key]) => key === value)?.[1]} onValueChange={(value) => {
                  if (!value || value === trigger) return
                  if (value === 'hourly' || value === 'daily' || value === 'weekly') {
                    const base = schedule.kind === 'calendar' ? schedule : { kind: 'calendar' as const, timeZone: browserZone, minute: 0 }
                    const next: AgentRoutineSchedule = { ...base, freq: value }
                    if (value === 'hourly') delete next.hour
                    else next.hour = schedule.kind === 'calendar' ? schedule.hour ?? 9 : 9
                    if (value === 'weekly') next.byDay = []
                    else delete next.byDay
                    setSchedule(next)
                  } else if (value === 'interval') setSchedule({ kind: 'interval', everyMs: 3600000 })
                  else if (value === 'once') {
                    setOnceInput('')
                    setSchedule({ kind: 'once', fireAt: NaN, timeZone: browserZone })
                  } else if (value === 'slack') setSchedule({ kind: 'slack', channelId: '', matchKind: 'mention' })
                  else if (value === 'github') setSchedule({ kind: 'github', owner: '', repo: '', events: ['pr-opened'] })
                }}>
                  {TRIGGERS.map(([value, label]) => <Select.Option key={value} value={value}>{label}</Select.Option>)}
                </Select>
                {schedule.kind === 'interval' && (
                  <div>
                    <label id={`${id}-interval-label`} htmlFor={`${id}-interval`} className={LABEL_CLASS}>Interval (minutes)</label>
                    <WorkshopInput id={`${id}-interval`} aria-labelledby={`${id}-interval-label`} className="w-full" type="number" min={1} step="any" value={Number.isFinite(schedule.everyMs) ? schedule.everyMs / 60000 : ''} onChange={(e) => setSchedule({ ...schedule, everyMs: e.target.value === '' ? NaN : Number(e.target.value) * 60000 })} />
                  </div>
                )}
                {schedule.kind === 'calendar' && (
                  <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label id={`${id}-repeat-label`} htmlFor={`${id}-repeat`} className={LABEL_CLASS}>Every N {schedule.freq === 'hourly' ? 'hours' : schedule.freq === 'daily' ? 'days' : 'weeks'}</label>
                        <WorkshopInput id={`${id}-repeat`} aria-labelledby={`${id}-repeat-label`} className="w-full" type="number" min={1} step={1} value={Number.isFinite(schedule.interval ?? 1) ? schedule.interval ?? 1 : ''} onChange={(e) => setSchedule({ ...schedule, interval: e.target.value === '' ? NaN : Number(e.target.value) })} />
                      </div>
                      <div>
                        <label id={`${id}-time-label`} htmlFor={`${id}-time`} className={LABEL_CLASS}>{schedule.freq === 'hourly' ? 'Minute of the hour' : 'Time'}</label>
                        {schedule.freq === 'hourly' ? (
                          <WorkshopInput id={`${id}-time`} aria-labelledby={`${id}-time-label`} className="w-full" type="number" min={0} max={59} step={1} value={Number.isFinite(schedule.minute) ? schedule.minute : ''} onChange={(e) => setSchedule({ ...schedule, minute: e.target.value === '' ? NaN : Number(e.target.value) })} />
                        ) : (
                          <WorkshopInput id={`${id}-time`} aria-labelledby={`${id}-time-label`} className="w-full" type="time" value={Number.isFinite(schedule.hour) && Number.isFinite(schedule.minute) ? `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}` : ''} onChange={(e) => {
                            const [hour, minute] = e.target.value.split(':').map(Number)
                            setSchedule({ ...schedule, hour, minute })
                          }} />
                        )}
                      </div>
                    </div>
                    {schedule.freq === 'weekly' && (
                      <fieldset>
                        <legend className={LABEL_CLASS}>Weekdays</legend>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {ROUTINE_WEEKDAYS.map(([day, label]) => (
                            <label key={day} className="flex items-center gap-2 text-sm">
                              <Checkbox checked={schedule.byDay?.includes(day) ?? false} onCheckedChange={(checked) => setSchedule({ ...schedule, byDay: checked ? [...(schedule.byDay ?? []), day] : schedule.byDay?.filter((entry) => entry !== day) })} />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    )}
                    <div>
                      <label id={`${id}-zone-label`} htmlFor={`${id}-zone`} className={LABEL_CLASS}>Time zone</label>
                      <WorkshopInput id={`${id}-zone`} aria-labelledby={`${id}-zone-label`} className="w-full" value={schedule.timeZone} onChange={(e) => setSchedule({ ...schedule, timeZone: e.target.value.trim() })} placeholder={browserZone} />
                      <p className="mt-1 text-xs text-kumo-subtle">Uses local time in this zone, including daylight saving changes.</p>
                    </div>
                  </>
                )}
                {schedule.kind === 'once' && (
                  <div>
                    <label id={`${id}-once-label`} htmlFor={`${id}-once`} className={LABEL_CLASS}>Date and time</label>
                    <WorkshopInput id={`${id}-once`} aria-labelledby={`${id}-once-label`} className="w-full" type="datetime-local" value={onceInput} onChange={(e) => {
                      setOnceInput(e.target.value)
                      setSchedule({ ...schedule, fireAt: new Date(e.target.value).getTime(), timeZone: browserZone })
                    }} />
                    <p className="mt-1 text-xs text-kumo-subtle">Time zone: {browserZone} (your browser). Choose the actual time for this run.</p>
                  </div>
                )}
                {schedule.kind === 'slack' && (
                  <>
                    <div>
                      <label id={`${id}-channel-label`} htmlFor={`${id}-channel`} className={LABEL_CLASS}>Channel ID</label>
                      <WorkshopInput id={`${id}-channel`} aria-labelledby={`${id}-channel-label`} className="w-full" value={schedule.channelId} onChange={(e) => setSchedule({ ...schedule, channelId: e.target.value })} placeholder="C1234567890" />
                    </div>
                    <Select label="Match type" className="w-full" value={schedule.matchKind} renderValue={(value) => ({ mention: 'Bot mention', keyword: 'Keyword', message: 'Any message' })[value]} onValueChange={(value) => {
                      if (value === 'mention' || value === 'keyword' || value === 'message') setSchedule({ ...schedule, matchKind: value })
                    }}>
                      <Select.Option value="mention">Bot mention</Select.Option>
                      <Select.Option value="keyword">Keyword</Select.Option>
                      <Select.Option value="message">Any message</Select.Option>
                    </Select>
                    {schedule.matchKind === 'keyword' && (
                      <div>
                        <label id={`${id}-keyword-label`} htmlFor={`${id}-keyword`} className={LABEL_CLASS}>Keyword</label>
                        <WorkshopInput id={`${id}-keyword`} aria-labelledby={`${id}-keyword-label`} className="w-full" value={schedule.keyword ?? ''} onChange={(e) => setSchedule({ ...schedule, keyword: e.target.value })} />
                      </div>
                    )}
                  </>
                )}
                {schedule.kind === 'github' && (
                  <>
                    <div>
                      <label id={`${id}-owner-label`} htmlFor={`${id}-owner`} className={LABEL_CLASS}>Owner</label>
                      <WorkshopInput id={`${id}-owner`} aria-labelledby={`${id}-owner-label`} className="w-full" value={schedule.owner} onChange={(e) => setSchedule({ ...schedule, owner: e.target.value })} />
                    </div>
                    <div>
                      <label id={`${id}-repo-label`} htmlFor={`${id}-repo`} className={LABEL_CLASS}>Repository</label>
                      <WorkshopInput id={`${id}-repo`} aria-labelledby={`${id}-repo-label`} className="w-full" value={schedule.repo} onChange={(e) => setSchedule({ ...schedule, repo: e.target.value })} />
                    </div>
                    <fieldset>
                      <legend className={LABEL_CLASS}>Events</legend>
                      <div className="space-y-2">
                        {GITHUB_EVENTS.map((event) => (
                          <label key={event} className="flex items-center gap-2 text-sm">
                            <Checkbox checked={schedule.events.includes(event)} onCheckedChange={(checked) => setSchedule({ ...schedule, events: checked ? [...schedule.events, event] : schedule.events.filter((entry) => entry !== event) })} />
                            {event}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </>
                )}
                <Select label={routine ? 'Status after saving' : 'Starting status'} className="w-full" value={paused ? 'paused' : 'enabled'} renderValue={(value) => routine ? (value === 'paused' ? 'Paused' : 'Enabled') : (value === 'paused' ? 'Starts paused' : 'Starts enabled')} onValueChange={(value) => { if (value) setPaused(value === 'paused') }}>
                  <Select.Option value="enabled">{routine ? 'Enabled' : 'Starts enabled'}</Select.Option>
                  <Select.Option value="paused">{routine ? 'Paused' : 'Starts paused'}</Select.Option>
                </Select>
              </div>
            )}
            <p className="mt-4 text-xs leading-5 text-kumo-subtle">Actions follow this workspace&apos;s existing approval rules. Enabling a routine does not grant blanket approval.</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            {error && <p role="alert" className="w-full break-words rounded-lg bg-kumo-danger-tint p-3 text-sm text-kumo-danger">{error}</p>}
            {unverified ? <p role="alert" className="w-full text-sm text-kumo-danger">Status unverified. This routine may be paused, and some changes may already be saved. Your draft is kept. Check its status before saving again.</p> : reconciledRoutine && <p role="status" className="w-full text-sm text-kumo-subtle">Current saved status: {reconciledRoutine.paused ? 'Paused' : reconciledRoutine.schedule.kind === 'once' && reconciledRoutine.schedule.fireAt <= Date.now() ? 'Time passed' : 'Active'}. Your draft is kept; review it before saving again.</p>}
            {unverified && <WorkshopButton type="button" disabled={saving || checkingStatus} onClick={reconcile}>{checkingStatus ? 'Checking status...' : 'Retry status check'}</WorkshopButton>}
            <WorkshopButton type="button" onClick={reviewing ? () => { setReviewing(false); setError(null) } : onClose} disabled={saving || checkingStatus}>{reviewing ? 'Back' : 'Cancel'}</WorkshopButton>
            {reviewing ? (
              <WorkshopButton type="button" tone="primary" disabled={saving || unverified || checkingStatus} onClick={save}>
                {saving ? 'Saving...' : paused ? (routine ? 'Save paused routine' : 'Create paused routine') : (routine ? 'Confirm and save' : 'Confirm and enable')}
              </WorkshopButton>
            ) : <WorkshopButton type="submit" tone="primary" disabled={saving || unverified || checkingStatus}>Review routine</WorkshopButton>}
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  )
}
