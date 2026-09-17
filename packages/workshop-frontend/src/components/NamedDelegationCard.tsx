import { useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { NamedDelegationReceipt, NamedDelegationResult, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export function namedDelegationStatus(result?: NamedDelegationResult): string {
  if (result?.deleted) return result.canceled ? 'Deleted (canceled)' : 'Deleted'
  if (result?.canceled) return 'Canceled'
  if (!result?.run) return 'Current state unavailable'
  const status = result.run.status
  return status === 'finished' ? 'Execution finished (not verified task success)' : status.charAt(0).toUpperCase() + status.slice(1)
}

export default function NamedDelegationCard({ delegation, result, overseer, workspaceId }: {
  delegation: NamedDelegationReceipt
  result?: NamedDelegationResult
  overseer: Pick<Overseer, 'getNamedDelegation'>
  workspaceId?: string
}) {
  const fresh = { source: { delegation, result, overseer, workspaceId }, current: result, busy: false, error: false }
  let [state, setState] = useState(fresh)
  if (state.source.delegation !== delegation || state.source.result !== result ||
      state.source.overseer !== overseer || state.source.workspaceId !== workspaceId) {
    state = fresh
    setState(fresh)
  }
  const request = useRef<object | null>(null)
  useLayoutEffect(() => () => { request.current = null }, [state.source])
  async function refresh() {
    if (request.current) return
    const token = {}
    request.current = token
    setState(previous => ({ ...previous, busy: true, error: false }))
    try {
      const current = await overseer.getNamedDelegation(delegation.id)
      if (request.current === token) setState(previous => ({ ...previous, current }))
    } catch {
      if (request.current === token) setState(previous => ({ ...previous, error: true }))
    } finally {
      if (request.current === token) {
        request.current = null
        setState(previous => ({ ...previous, busy: false }))
      }
    }
  }
  return <section aria-label="Delegated task receipt" className="min-w-0 max-w-[860px] space-y-2 rounded-2xl border border-kumo-line bg-kumo-base p-4 text-sm [overflow-wrap:anywhere]">
    <p className="font-medium">Delegated task: {delegation.targetName}</p>
    <p role="status">{namedDelegationStatus(state.current)}</p>
    {state.current?.run?.reason && <p className="text-xs text-kumo-subtle">Reason: {state.current.run.reason.replaceAll('_', ' ')}</p>}
    {(state.current?.deleted || state.current?.canceled) && <p className="text-xs text-kumo-subtle">The receipt is retained; this child is not recreated or retried. Cancellation does not undo already dispatched effects.</p>}
    <div className="flex flex-wrap items-center gap-3 text-xs">
      {workspaceId && <Link to="/workspace/$id" params={{ id: workspaceId }} search={{ chat: delegation.parentChatId }} className="underline">Parent conversation</Link>}
      {workspaceId && !state.current?.deleted && <Link to="/workspace/$id" params={{ id: workspaceId }} search={{ chat: delegation.childChatId }} className="underline">Child conversation</Link>}
      <WorkshopButton type="button" disabled={state.busy} onClick={() => { void refresh() }}>Refresh status</WorkshopButton>
    </div>
    {state.busy && <p role="status" className="text-xs text-kumo-subtle">Refreshing child state...</p>}
    {state.error && <p role="alert" className="text-xs text-kumo-danger">Could not refresh child state. Displayed evidence may be out of date.</p>}
    {state.current?.response && <div className="space-y-1 text-xs">
      <p className="text-kumo-subtle">Latest child response (unverified task output)</p>
      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap">{state.current.response}</p>
    </div>}
  </section>
}
