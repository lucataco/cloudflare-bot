import { useLayoutEffect, useRef, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AgentProposal, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'
import { formatRoutineSchedule } from './routineFormat'

export default function AgentProposalCard({ proposal, overseer, chatId, canDecideProposals = false }: {
  proposal: AgentProposal
  overseer: Pick<RpcStub<Overseer>, 'acceptAgentProposal' | 'denyAgentProposal'>
  chatId: number
  /** Display hint only; the Overseer enforces ownership. */
  canDecideProposals?: boolean
}) {
  const fresh = {
    // RPC stubs are callable: keep the borrowed overseer inside an object, never bare in state.
    source: { overseer, chatId, proposalId: proposal.proposalId, agentId: proposal.agentId,
      artifactId: proposal.artifactId, canDecideProposals },
    result: null as AgentProposal | null,
    dialog: null as object | null,
    busy: null as 'accept' | 'deny' | null,
    error: null as string | null,
    unconfirmed: false,
  }
  let [review, setReview] = useState(fresh)
  if (review.source.overseer !== overseer || review.source.chatId !== chatId ||
      review.source.proposalId !== proposal.proposalId || review.source.agentId !== proposal.agentId ||
      review.source.artifactId !== proposal.artifactId || review.source.canDecideProposals !== canDecideProposals) {
    review = fresh
    setReview(fresh)
  }

  // Subscriber decisions win; a confirmed RPC receipt bridges a lagging pending/accepting row.
  const current = proposal.state === 'accepted' || proposal.state === 'denied' ? proposal
    : review.result?.state === 'accepted' ? review.result
    : proposal.state === 'accepting' ? proposal : review.result ?? proposal
  const missing = current.state === 'accepted' && (current.receipt.missing ||
    (review.result?.state === 'accepted' && review.result.receipt.missing))
  const terminal = current.state === 'accepted' || current.state === 'denied'
  const saving = !terminal && (current.state === 'accepting' || review.unconfirmed || review.busy === 'accept')
  const request = useRef<object | null>(null)
  const latest = useRef({ source: review.source, proposal: current })
  useLayoutEffect(() => {
    latest.current = { source: review.source, proposal: current }
  })
  useLayoutEffect(() => () => { request.current = null }, [review.source])

  async function decide(decision: 'accept' | 'deny') {
    if (!canDecideProposals || request.current || terminal || (decision === 'deny' && saving)) return
    const token = {}
    request.current = token
    const { source, dialog } = review
    const stillHere = () => request.current === token && latest.current.source === source
    setReview(previous => ({ ...previous, busy: decision, error: null }))
    try {
      const result = await (decision === 'accept'
        ? overseer.acceptAgentProposal(proposal.proposalId)
        : overseer.denyAgentProposal(proposal.proposalId))
      if (!stillHere()) return
      const state = latest.current.proposal.state
      if (state === 'denied' || (state === 'accepted' && result.state !== 'accepted')) return
      if (result.proposalId !== source.proposalId || result.agentId !== source.agentId ||
          result.artifactId !== source.artifactId || result.draft.kind !== proposal.draft.kind ||
          result.state === 'pending' || (state === 'accepting' && result.state === 'denied')) {
        throw new Error('Proposal decision was not confirmed')
      }
      setReview(previous => ({ ...previous, result, unconfirmed: false,
        // Closing/reopening review is a new dialog, even for the same proposal.
        dialog: state !== 'accepted' && previous.dialog === dialog && result.state !== 'accepting' ? null : previous.dialog,
      }))
    } catch {
      if (!stillHere() || latest.current.proposal.state === 'accepted' || latest.current.proposal.state === 'denied') return
      setReview(previous => ({ ...previous, unconfirmed: previous.unconfirmed || decision === 'accept',
        error: decision === 'accept'
          ? 'Saving is not yet confirmed. Use Finish saving to safely retry this same proposal.'
          : 'Could not confirm denial. You can retry Deny.',
      }))
    } finally {
      if (stillHere()) {
        request.current = null
        setReview(previous => ({ ...previous, busy: null }))
      }
    }
  }

  const routine = current.draft.kind === 'routine'
  const saveLabel = routine ? 'Save paused routine' : 'Save reusable instructions'
  const status = current.state === 'accepted'
    ? `${routine ? 'Saved paused' : 'Saved reusable instructions'} at ${current.receipt.createdAt.toLocaleString()}`
    : current.state === 'denied' ? `Denied at ${current.decidedAt.toLocaleString()}`
    : saving ? 'Saving not yet confirmed' : 'Needs approval'
  const safety = routine
    ? 'Saves a paused routine. No schedule is enabled. Each run starts a new conversation; attachments and chat-only connections are not copied. Enable it separately in Manage routines after checking its connections.'
    : 'Saves reusable instructions for future turns, starting with the next turn, not the current run.'
  const receiptNote = `This records what was saved, not its current settings.${missing ? ' Already deleted; it was not recreated.' : ''}`
  const plainText = 'whitespace-pre-wrap break-words [overflow-wrap:anywhere]'

  return (
    <section aria-label={`${routine ? 'Routine' : 'Reusable instructions'} proposal`} className="w-full min-w-0 max-w-[600px] rounded-xl border border-kumo-line bg-kumo-base p-4 text-sm text-kumo-default">
      <p className="text-xs font-medium text-kumo-subtle">{routine ? 'Routine proposal' : 'Reusable instructions proposal'}</p>
      <h3 className={`mt-1 font-medium ${plainText}`}>{current.draft.value.name}</h3>
      <p className={`mt-2 text-xs text-kumo-subtle ${plainText}`}>Suggested by {current.agentName}</p>
      <p className="mt-2 text-xs font-medium text-kumo-subtle">Why the bot suggested this</p>
      <p className={`mt-1 ${plainText}`}>{current.reason}</p>
      <p role="status" className="mt-3 font-medium">{status}</p>
      {current.state === 'accepted' && <p className="mt-1 text-xs text-kumo-subtle">
        {receiptNote}
      </p>}
      {!terminal && <p className="mt-2 text-xs text-kumo-subtle">{safety}</p>}
      {!terminal && !canDecideProposals && <p className="mt-2 text-xs text-kumo-subtle">Only the workspace owner can save or deny this proposal.</p>}
      {review.error && !terminal && !review.dialog && <p role="alert" className="mt-2 text-kumo-danger">{review.error}</p>}
      <Dialog.Root open={review.dialog !== null} onOpenChange={open => {
        setReview(previous => ({ ...previous, dialog: open ? {} : null }))
      }}>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Dialog.Trigger render={<WorkshopButton type="button">{terminal ? 'View proposal' : 'Review'}</WorkshopButton>} />
          {canDecideProposals && !terminal && !saving && <WorkshopButton type="button" disabled={review.busy !== null} onClick={() => { void decide('deny') }}>
            {review.busy === 'deny' ? 'Denying...' : 'Deny'}
          </WorkshopButton>}
          {canDecideProposals && current.state === 'accepted' && <a
            href={`/agents/${encodeURIComponent(current.agentId)}?pane=${routine ? 'routines' : 'skills'}`}
            className="text-kumo-link underline underline-offset-2"
          >{routine ? 'Manage routines' : 'Manage instructions'}</a>}
        </div>
        <Dialog size="sm" className="responsive-dialog !top-[clamp(28px,10vh,96px)] !flex !max-h-[min(80vh,calc(var(--app-height)-32px))] !w-[min(600px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0">
          <div className="shrink-0 border-b border-kumo-line px-5 py-4">
            <Dialog.Title className="text-[15px] font-medium">{routine ? 'Review routine proposal' : 'Review reusable instructions'}</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-kumo-subtle">Check exactly what will be saved. The bot's suggestions do not grant additional access.</Dialog.Description>
          </div>
          <div role="region" aria-label="Proposal details" tabIndex={0} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-ring">
            <dl className="space-y-3 text-sm">
              <div><dt className="font-medium">Name</dt><dd className={plainText}>{current.draft.value.name}</dd></div>
              {current.draft.kind === 'routine' ? <>
                <div><dt className="font-medium">Task to repeat</dt><dd className={plainText}>{current.draft.value.prompt}</dd></div>
                <div><dt className="font-medium">Schedule</dt><dd className={plainText}>{formatRoutineSchedule(current.draft.value.schedule)}</dd></div>
                <div><dt className="sr-only">Exact schedule fields</dt><dd><details>
                  <summary className="cursor-pointer text-xs text-kumo-subtle">Technical schedule details</summary>
                  <pre className={`mt-2 rounded-lg bg-kumo-tint p-3 text-xs ${plainText}`}>{JSON.stringify(current.draft.value.schedule, null, 2)}</pre>
                </details></dd></div>
              </> : <>
                <div><dt className="font-medium">When to use</dt><dd className={plainText}>{current.draft.value.description}</dd></div>
                <div><dt className="font-medium">Instructions</dt><dd className={plainText}>{current.draft.value.body}</dd></div>
              </>}
              <div><dt className="font-medium">Why the bot suggested this</dt><dd className={plainText}>{current.reason}</dd></div>
            </dl>
            <p className="text-sm">{safety}</p>
            <p className="text-xs text-kumo-subtle">Saving grants no connections or bindings, enables no schedule, and does not resume the bot or change workspace pause or approval settings.</p>
          </div>
          <div aria-busy={review.busy !== null} className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            <p role="status" className="w-full text-sm">{status}</p>
            {current.state === 'accepted' && <p className="w-full text-xs text-kumo-subtle">{receiptNote}</p>}
            {review.error && !terminal && <p role="alert" className="w-full break-words text-sm text-kumo-danger">{review.error}</p>}
            <Dialog.Close render={<WorkshopButton type="button">{review.busy || terminal || saving ? 'Close' : 'Cancel'}</WorkshopButton>} />
            {canDecideProposals && !terminal && <WorkshopButton type="button" tone="primary" disabled={review.busy !== null} onClick={() => { void decide('accept') }}>
              {review.busy === 'accept' ? 'Saving...' : saving ? 'Finish saving' : saveLabel}
            </WorkshopButton>}
          </div>
        </Dialog>
      </Dialog.Root>
    </section>
  )
}
