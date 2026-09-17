import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react'
import { CaretDown, CaretRight, Clock } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer, TaskRun, TaskRunDisposition, TaskRunEvidencePage, TaskRunSource } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'
import { formatRoutineSchedule } from './routineFormat'
import { formatFullTimestamp } from '../utils/formatTimestamp'
import { Link } from '@tanstack/react-router'
import { namedDelegationStatus } from './NamedDelegationCard'

const plainText = 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
const disclosureClass = 'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-2 text-left focus-visible:outline-2 focus-visible:outline-kumo-ring'
const sourceLabels: Record<TaskRunSource['type'], string> = {
  prompt: 'Prompt', queue: 'Queued prompt', callback: 'Callback', delegation: 'Delegation', routine: 'Routine',
}
const reasonLabels: Record<TaskRunDisposition['reason'], string> = {
  model_stop: 'Model stopped', connection: 'Connection decision needed', proposal: 'Proposal decision needed',
  human_takeover: 'Human input needed', action_approval: 'Action approval needed', user_stop: 'Stopped by user',
  workspace_paused: 'Workspace paused', execution_error: 'Execution error', step_limit: 'Step limit reached',
  unknown_tool: 'Unknown tool', output_limit: 'Output limit reached', gave_up: 'Agent gave up',
  callbacks_stalled: 'Callbacks stalled', callbacks_resolved: 'Callbacks resolved',
  history_not_actionable: 'History not actionable', model_unavailable: 'Model unavailable',
  usage_limit: 'Usage limit reached', interrupted: 'Interrupted',
}
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

// Both endpoints return values, not owned capabilities. The mounted disclosure owns only its
// requests; the workspace stub is borrowed. Refresh re-reads the loaded depth so old decisions
// do not stay stale on older pages. Each request's cleanup invalidates successes AND failures.
function useHistoryPages<Page extends { nextBeforeSequence?: number }>(
  version: string, readPage: (before?: number) => Promise<Page>,
) {
  const read = useEffectEvent(readPage)
  const [result, setResult] = useState({ pages: [] as Page[], loading: true, error: false })
  let [query, setQuery] = useState({ version, before: undefined as number | undefined, depth: 1 })
  if (query.version !== version) {
    query = { version, before: undefined, depth: Math.max(1, result.pages.length) }
    setQuery(query)
    setResult(previous => ({ ...previous, loading: true, error: false }))
  }
  useEffect(() => {
    let canceled = false
    async function load() {
      try {
        const pages: Page[] = []
        let before = query.before
        for (let i = 0; i < query.depth; i++) {
          const page = await read(before)
          if (canceled) return
          pages.push(page)
          before = page.nextBeforeSequence
          if (before === undefined) break
        }
        setResult(previous => ({ pages: query.before === undefined ? pages : [...previous.pages, ...pages], loading: false, error: false }))
      } catch {
        if (!canceled) setResult(previous => ({ ...previous, loading: false, error: true }))
      }
    }
    void load()
    return () => { canceled = true }
  }, [query])
  const next = result.pages.at(-1)?.nextBeforeSequence
  return {
    ...result,
    next,
    retry() {
      setResult(previous => ({ ...previous, loading: true, error: false }))
      setQuery({ ...query })
    },
    more() {
      if (next === undefined || result.loading || result.error) return
      setResult(previous => ({ ...previous, loading: true, error: false }))
      setQuery({ version, before: next, depth: 1 })
    },
  }
}

function PageControls({ history, noun }: {
  history: Pick<ReturnType<typeof useHistoryPages>, 'loading' | 'error' | 'next' | 'retry' | 'more'>
  noun: 'tasks' | 'evidence'
}) {
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    {history.loading && <p role="status" className="text-kumo-subtle">Loading {noun}...</p>}
    {history.error && <>
      <p role="alert" className="text-kumo-danger">Could not load {noun}. Any displayed records may be out of date.</p>
      <WorkshopButton type="button" onClick={history.retry}>Retry {noun}</WorkshopButton>
    </>}
    {!history.error && history.next !== undefined && <WorkshopButton type="button" disabled={history.loading} onClick={history.more}>
      Older {noun}
    </WorkshopButton>}
  </div>
}

export default function TaskHistory({ overseer, chatId, lastActive, currentRunId, workspaceId }: {
  overseer: RpcStub<Overseer>
  chatId: number
  lastActive?: Date
  currentRunId?: string
  workspaceId?: string
}) {
  const id = useId()
  // Reset before rendering a different workspace/chat, even if IDs are reused after reconnect.
  // Wrapping the borrowed stub also avoids React treating a callable stub as a state updater.
  let [scope, setScope] = useState({ overseer, chatId, open: false })
  if (scope.overseer !== overseer || scope.chatId !== chatId) {
    scope = { overseer, chatId, open: false }
    setScope(scope)
  }
  return <section aria-label="Task history" className="min-w-0 shrink-0 border-b border-kumo-line bg-kumo-base px-3 text-xs text-kumo-default sm:px-4">
    <button type="button" aria-expanded={scope.open} aria-controls={id} className={`${disclosureClass} text-kumo-subtle`}
      onClick={() => setScope({ ...scope, open: !scope.open })}>
      {scope.open ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
      <Clock size={14} aria-hidden="true" />Task history
    </button>
    {scope.open && <div id={id} role="region" aria-label="Task history records" tabIndex={0}
      className="max-h-[min(50vh,28rem)] min-w-0 overflow-y-auto overscroll-contain pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-ring">
      <RunHistory overseer={overseer} chatId={chatId} lastActive={lastActive} currentRunId={currentRunId} workspaceId={workspaceId} />
    </div>}
  </section>
}

function RunHistory({ overseer, chatId, lastActive, currentRunId, workspaceId }: Parameters<typeof TaskHistory>[0]) {
  const [refresh, setRefresh] = useState(0)
  const version = `${lastActive?.getTime()}:${currentRunId}:${refresh}`
  const history = useHistoryPages(version, async before => await overseer.listTaskRuns(chatId, before))
  const runs = history.pages.flatMap(page => page.runs)
  return <>
    <div className="flex flex-wrap items-start justify-between gap-2 py-1">
      <p className="min-w-0 flex-1 basis-48 text-kumo-subtle">Execution status is not verified task success. Accepted changes and applied actions are not proof of success.</p>
      <WorkshopButton type="button" onClick={() => setRefresh(value => value + 1)}>Refresh task history</WorkshopButton>
    </div>
    {runs.length > 0 && <ol className="divide-y divide-kumo-line">
      {runs.map(run => <RunRow key={run.id} run={run} overseer={overseer} version={version} workspaceId={workspaceId} />)}
    </ol>}
    {!history.loading && !history.error && runs.length === 0 && <p className="py-2 text-kumo-subtle">
      No recorded tasks. Older conversations may predate task history; no runs are inferred from their messages.
    </p>}
    <PageControls history={history} noun="tasks" />
  </>
}

function RunRow({ run, overseer, version, workspaceId }: { run: TaskRun; overseer: RpcStub<Overseer>; version: string; workspaceId?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const parent = run.source.type !== 'routine' ? run.source.parent : undefined
  return <li className="min-w-0 py-1">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={disclosureClass}>
      {open ? <CaretDown size={12} className="shrink-0" aria-hidden="true" /> : <CaretRight size={12} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="font-medium">{sourceLabels[run.source.type]} <span className="text-kumo-subtle">#{run.sourceSequence}</span></span>{' '}
        <time dateTime={run.startedAt.toISOString()} className="mt-0.5 block text-kumo-subtle">{formatFullTimestamp(run.startedAt)}</time>
      </span>
      <span className="shrink-0 rounded-md bg-kumo-tint px-2 py-1">{label(run.status)}</span>
    </button>
    {parent && <div className={`mb-2 space-y-1 text-kumo-subtle ${plainText}`}>
      <p>Delegated to {parent.targetName}. Parent task {parent.runId}, attempt {parent.attempt}.</p>
      {workspaceId && <div className="flex flex-wrap gap-3">
        <Link to="/workspace/$id" params={{ id: workspaceId }} search={{ chat: parent.chatId }} className="underline">Parent conversation</Link>
        <Link to="/workspace/$id" params={{ id: workspaceId }} search={{ chat: run.chatId }} className="underline">Child conversation</Link>
      </div>}
    </div>}
    {open && <div id={id} role="region" aria-label={`Evidence for task ${run.sourceSequence}`} className={`min-w-0 space-y-2 pb-2 ${plainText}`}>
      {run.reason && <p className="font-medium">{reasonLabels[run.reason]}</p>}
      {run.status === 'finished' && <p className="text-kumo-subtle">Execution ended, not a verified successful outcome.</p>}
      <p className="text-kumo-subtle">Attempt {run.attempt}. Updated <time dateTime={run.updatedAt.toISOString()}>{formatFullTimestamp(run.updatedAt)}</time>.</p>
      {run.source.type === 'routine' && <div className="text-kumo-subtle">
        <p>Routine {run.source.routineId}, revision {run.source.revision}</p>
        <p>Registration: {run.source.registrationId}</p>
        {run.source.scheduleId && <p>Schedule: {run.source.scheduleId}</p>}
        {run.source.occurrenceId && <p>Occurrence: {run.source.occurrenceId}</p>}
        {run.source.scheduledTime !== undefined && <p>Scheduled for: {formatFullTimestamp(new Date(run.source.scheduledTime))}</p>}
      </div>}
      <RunEvidence key={run.id} overseer={overseer} run={run} version={version} />
    </div>}
  </li>
}

function RunEvidence({ overseer, run, version }: { overseer: RpcStub<Overseer>; run: TaskRun; version: string }) {
  const history = useHistoryPages(version, async before => await overseer.getTaskRunEvidence(run.id, before))
  const entries = history.pages.flatMap(page => page.entries)
  return <>
    <p className="text-kumo-subtle">Recorded evidence, newest first. Decisions show their current state.</p>
    {entries.length > 0 && <ol className="space-y-2">
      {entries.map(entry => <EvidenceRecord key={entry.message.sequence} entry={entry} sourceSequence={run.sourceSequence} />)}
    </ol>}
    {!history.loading && !history.error && entries.length === 0 && <p className="text-kumo-subtle">No recorded evidence for this task.</p>}
    <PageControls history={history} noun="evidence" />
  </>
}

// Deliberately plain, inert text: no approval cards, attachment fetches, model-provided images,
// links or inferred decisions. Only the evidence endpoint's canonical fields set status labels.
function EvidenceRecord({ entry: { message, changeState }, sourceSequence }: {
  entry: TaskRunEvidencePage['entries'][number]
  sourceSequence: number
}) {
  let title: string
  let content: ReactNode
  switch (message.type) {
    case 'message':
      title = message.sequence === sourceSequence ? 'Source prompt'
        : message.author.type !== 'agent' ? 'User message'
        : message.toolCalls?.length ? 'Agent message / tool activity'
        : message.message.trim() ? 'Final response' : 'Agent message'
      content = <>
        {message.message && <p>{message.message}</p>}
        {message.toolCalls?.map(call => <p key={call.toolCallId}>Tool: {call.toolName}{call.error ? ` - ${call.error}` : ''}</p>)}
        {message.attachments?.map(attachment => <p key={attachment.id}>Attachment: {attachment.name ?? attachment.mimeType}</p>)}
      </>
      break
    case 'changes':
      title = `Changes: ${changeState === 'merged' ? 'Accepted' : changeState ? label(changeState) : 'Current state unavailable'}`
      content = <>
        {message.createdGadgets?.map(gadget => <p key={gadget.gadgetId}>Output: {gadget.title} ({gadget.bindingName})</p>)}
        {Object.entries(message.change ?? {}).flatMap(([gadget, files]) => files.map(([path, change]) => <p key={`${gadget}:${path}`}>
          App #{gadget}: {path} ({'remove' in change ? 'removed' : 'set' in change ? 'written' : 'edited'})
        </p>))}
        {message.addedBindings?.map(binding => <p key={`${binding.gadgetId}:${binding.name}`}>Binding: {binding.name} on app #{binding.gadgetId}</p>)}
      </>
      break
    case 'action': {
      const log = message.actionLog
      title = !log ? 'Action: Current state unavailable'
        : log.type === 'bindHook' ? `Hook: ${log.hookId === undefined ? 'Deleted' : log.enabled ? 'Enabled' : 'Disabled'}`
        : `${log.type === 'observation' ? 'Observation' : 'Action'}: ${log.state === 'approved' ? log.type === 'observation' ? 'Approved' : 'Applied' : label(log.state)}`
      content = log ? <>
        <p className="font-medium">{log.description.title}</p><p>{log.resourceTitle}</p><p>{log.description.description}</p>
        {log.type === 'action' && log.resolvedBy && <p>Decision by {log.resolvedBy.name}{log.autoApproved ? ' (automatic approval)' : ''}</p>}
        {log.appliedAt && <p>Last decision: {formatFullTimestamp(log.appliedAt)}</p>}
      </> : <p>Action #{message.actionId}</p>
      break
    }
    case 'namedDelegation':
      title = `Delegation: ${namedDelegationStatus(message.result)}`
      content = <><p>{message.delegation.targetName}</p><p>Parent task {message.delegation.parentRunId}</p>
        {message.result?.response && <p>{message.result.response}</p>}</>
      break
    case 'agentProposal':
      title = `${message.draft.kind === 'routine' ? 'Routine' : 'Reusable instructions'} proposal: ${label(message.state)}`
      content = <>
        <p className="font-medium">{message.draft.value.name}</p><p>{message.reason}</p>
        {message.draft.kind === 'routine' ? <>
          <p>{message.draft.value.prompt}</p><p>{formatRoutineSchedule(message.draft.value.schedule)}</p>
        </> : <><p>{message.draft.value.description}</p><p>{message.draft.value.body}</p></>}
        {message.state !== 'pending' && <p>Decision: {formatFullTimestamp(message.decidedAt)}</p>}
        {message.state === 'accepting' && <p>Creation not yet confirmed.</p>}
        {message.state === 'accepted' && <>
          <p>{message.draft.kind === 'routine' ? 'Saved paused' : 'Saved reusable instructions'} at {formatFullTimestamp(message.receipt.createdAt)}.</p>
          <p>Historical receipt, not current settings or activation.{message.receipt.missing ? ' Already deleted; not recreated.' : ''}</p>
        </>}
      </>
      break
    case 'connectionRequest':
      title = `Connection decision: ${label(message.state)}`
      content = <><p>{message.vendorName}{message.resourceTitle ? `: ${message.resourceTitle}` : ''}</p><p>{message.reason}</p></>
      break
    case 'computerHumanTakeover':
      title = `Human input: ${label(message.state)}`
      content = <p>{message.reason}</p>
      break
    case 'merge':
      title = 'Changes accepted'
      content = <p>Accepted through message #{message.mergeThrough}.</p>
      break
    case 'revert':
      title = 'Changes reverted'
      content = <p>Reverted from message #{message.revertFrom}.</p>
      break
    case 'agentCallback':
      title = message.sequence === sourceSequence ? 'Source callback' : 'Callback'
      content = <><p>{message.methodName}</p><p>{message.argsSummary}</p></>
      break
    case 'slashCommand':
      title = message.sequence === sourceSequence ? 'Source command' : 'Command'
      content = <p>/{message.request.id.commandId} {message.request.args}</p>
      break
    case 'error':
      title = 'Execution error'
      content = <p>{message.message}</p>
      break
    case 'agentNudge':
      title = 'System nudge'
      content = <p>{message.text}</p>
      break
    case 'useGadget':
      title = 'App accessed'
      break
  }
  return <li className={`min-w-0 rounded-lg border border-kumo-line bg-kumo-tint/30 p-2.5 ${plainText}`}>
    <p className="font-medium">{title}</p>
    <p className="mb-1 text-kumo-subtle">#{message.sequence} / {message.author.name} / <time dateTime={message.timestamp.toISOString()}>{formatFullTimestamp(message.timestamp)}</time></p>
    {content}
  </li>
}
