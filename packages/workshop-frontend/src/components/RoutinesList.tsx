import { useState, useEffect, useEffectEvent } from 'react'
import type { AgentRoutine, AgentProfile } from '@gadgets/workshop-shared/api'
import { Plus, Pause, Play, Trash, Clock, PencilSimple } from '@phosphor-icons/react'
import CreateRoutineModal from './CreateRoutineModal'
import DeleteConfirmationDialog from './DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'
import { formatRoutineSchedule } from './routineFormat'
import { useRoutineState } from './routineState'

/** Controlled routine display, shared by the list and the conversation's creation receipt. */
export function RoutineCard({ agent, routine: receipt, onUpdated, onDeleted, verifyOnMount = true }: {
  agent: AgentProfile
  routine: AgentRoutine
  onUpdated: (routine: AgentRoutine) => void
  onDeleted?: (routine: AgentRoutine) => void
  /** Receipts verify by default; the list supplies its already-shared list read. */
  verifyOnMount?: boolean
}) {
  const { store, state } = useRoutineState(agent.id)
  const current = state.routines.find((entry) => entry.id === receipt.id)
  const routine = current ?? receipt
  const [editing, setEditing] = useState(false)
  const [confirmEnable, setConfirmEnable] = useState<AgentRoutine | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = acting || state.busy
  const statusUnverified = !state.verified
  const removed = state.verified && !current
  const timePassed = routine.schedule.kind === 'once' && routine.schedule.fireAt <= Date.now()
  const status = statusUnverified ? 'Status unverified' : removed ? 'Removed' : routine.paused ? 'Paused' : timePassed ? 'Time passed' : 'Active'

  const notifyUpdated = useEffectEvent(() => {
    if (current && current !== receipt) onUpdated(current)
  })
  useEffect(() => { if (state.verified) notifyUpdated() }, [current, state.verified])
  useEffect(() => {
    if (verifyOnMount) void store.refresh().catch(() => {})
  }, [store, receipt.id, verifyOnMount])

  const checkStatus = async (openEditor = false) => {
    if (busy) return
    setActing(true)
    setError(null)
    setConfirmEnable(null)
    try {
      const found = (await store.refresh()).find((entry) => entry.id === routine.id)
      if (!found) throw new Error('This routine no longer exists.')
      if (openEditor) setEditing(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the routine. Try again.')
    } finally {
      setActing(false)
    }
  }

  const changePaused = async (paused: boolean, expected: AgentRoutine) => {
    if (busy || statusUnverified || removed) return
    if (!paused && expected.schedule.kind === 'once' && expected.schedule.fireAt <= Date.now()) {
      setError('Choose a future date and time in Edit before enabling this routine.')
      setConfirmEnable(null)
      return
    }
    setActing(true)
    setError(null)
    try {
      await store.update(expected, { paused })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the routine status. Try again.')
    } finally {
      setConfirmEnable(null)
      setActing(false)
    }
  }

  const deleteRoutine = async () => {
    if (busy) return
    setActing(true)
    setError(null)
    try {
      await store.delete(routine)
      onDeleted?.(routine)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the routine. Try again.')
    } finally {
      setConfirmDelete(false)
      setActing(false)
    }
  }

  return (
    <article aria-label={routine.name} className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-medium text-kumo-default">{routine.name}</h3>
          <p className="mt-0.5 break-words text-xs text-kumo-subtle">{agent.name}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${status === 'Active' ? 'bg-kumo-success-tint text-kumo-success' : 'bg-kumo-tint text-kumo-subtle'}`}>{status}</span>
      </div>
      <p className="mt-2 break-words text-xs leading-5 text-kumo-subtle">{formatRoutineSchedule(routine.schedule)}</p>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-kumo-default">{routine.prompt}</p>
      {timePassed && <p className="mt-2 text-xs text-kumo-subtle">The scheduled time has passed. Edit to choose a future run; this is not a completion receipt.</p>}
      {!removed && <div className="mt-3 flex flex-wrap items-center gap-2">
        <WorkshopButton disabled={busy || !!confirmEnable} onClick={() => checkStatus(true)} className="gap-1.5"><PencilSimple size={14} />Edit</WorkshopButton>
        {statusUnverified ? <WorkshopButton disabled={busy || editing} onClick={() => checkStatus()}>{busy ? 'Checking status...' : 'Retry status check'}</WorkshopButton> : !timePassed && <WorkshopButton disabled={busy || !!confirmEnable} onClick={() => {
          if (routine.paused) { setError(null); setConfirmEnable(routine) }
          else void changePaused(true, routine)
        }} className="gap-1.5">{routine.paused ? <Play size={14} /> : <Pause size={14} />}{routine.paused ? 'Resume' : 'Pause'}</WorkshopButton>}
        {onDeleted && <WorkshopIconButton aria-label={`Delete ${routine.name}`} danger disabled={busy || !!confirmEnable || statusUnverified} onClick={() => setConfirmDelete(true)}><Trash size={16} /></WorkshopIconButton>}
      </div>}
      {confirmEnable && (
        <div className="mt-3 rounded-lg bg-kumo-tint p-3 text-sm">
          <p className="font-medium">Enable this routine?</p>
          <p className="mt-1 text-xs leading-5 text-kumo-subtle">{agent.name} will run this task automatically on the schedule above. Actions follow this workspace&apos;s existing approval rules, not blanket approval.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <WorkshopButton disabled={busy} onClick={() => { setConfirmEnable(null); setError(null) }}>Cancel</WorkshopButton>
            <WorkshopButton tone="primary" disabled={busy || statusUnverified || removed} onClick={() => changePaused(false, confirmEnable)}>{busy ? 'Enabling...' : 'Confirm and enable'}</WorkshopButton>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-kumo-danger-tint p-3 text-sm text-kumo-danger">{error}</p>}
      {statusUnverified && <p role="alert" className="mt-3 text-sm text-kumo-danger">This routine may be paused, and its details may have changed. Retry the status check or edit the draft; pause/resume is unavailable until its status is verified.</p>}
      {editing && <CreateRoutineModal agent={agent} routine={routine} onClose={() => setEditing(false)} onCreated={() => setEditing(false)} />}
      {confirmDelete && <DeleteConfirmationDialog open title={`Delete "${routine.name}"?`} description="This routine will stop running and be removed. Existing conversations are kept." isDeleting={busy} onOpenChange={setConfirmDelete} onConfirm={deleteRoutine} />}
    </article>
  )
}

export default function RoutinesList({ agent }: { agent: AgentProfile }) {
  const { store, state } = useRoutineState(agent.id)
  const { routines, error } = state
  const [createModalVisible, setCreateModalVisible] = useState(false)

  useEffect(() => {
    setCreateModalVisible(false)
    void store.refresh().catch(() => {})
  }, [store])

  return (
    <div className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-kumo-default">Routines</h2>
        <WorkshopButton tone="primary" disabled={state.busy || !state.verified} onClick={() => setCreateModalVisible(true)} className="gap-1.5"><Plus size={16} />Create routine</WorkshopButton>
      </div>
      {error && <div><p role="alert" className="mb-3 text-sm text-kumo-danger">{error}</p><WorkshopButton disabled={state.busy} onClick={() => { void store.refresh().catch(() => {}) }}>Try again</WorkshopButton></div>}
      {state.busy && routines.length === 0 ? <p role="status" className="py-8 text-center text-sm text-kumo-subtle">Loading routines...</p> : state.verified && routines.length === 0 ? (
        <div className="py-8 text-center text-kumo-subtle">
          <Clock size={32} className="mx-auto mb-2" />
          <p className="text-sm font-medium">No routines yet</p>
          <p className="mt-1 text-xs">Give {agent.name} a task to run on a schedule.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {routines.map((routine) => <RoutineCard key={routine.id} agent={agent} routine={routine} verifyOnMount={false} onUpdated={() => {}} onDeleted={() => {}} />)}
        </div>
      )}
      {createModalVisible && <CreateRoutineModal agent={agent} onClose={() => setCreateModalVisible(false)} onCreated={() => setCreateModalVisible(false)} />}
    </div>
  )
}
