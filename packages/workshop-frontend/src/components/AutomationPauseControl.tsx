import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export default function AutomationPauseControl({ overseer, metadata }: {
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
}) {
  const owner = !metadata.owner && metadata.role !== 'use'
  const paused = metadata.automationPaused === true
  const [confirmResume, setConfirmResume] = useState(false)
  const [busy, setBusy] = useState(false)
  const [waitingFor, setWaitingFor] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef<object | null>(null)

  useEffect(() => {
    setConfirmResume(false)
    setBusy(false)
    setWaitingFor(null)
    setError(null)
    return () => { operation.current = null }
  }, [overseer, metadata.id, owner])
  useEffect(() => { setConfirmResume(false) }, [paused])
  useEffect(() => { if (waitingFor === paused) setWaitingFor(null) }, [waitingFor, paused])

  async function change(pausedNext: boolean) {
    if (!owner || operation.current || (waitingFor !== null && waitingFor !== paused)) return
    const token = {}
    operation.current = token
    setBusy(true)
    setConfirmResume(false)
    setError(null)
    try {
      await overseer.setAutomationPaused(pausedNext)
      if (operation.current === token) setWaitingFor(pausedNext)
    } catch {
      if (operation.current === token) {
        setError('Could not confirm the automation change. It may have taken effect; it was not retried. The status shown follows workspace updates.')
        setWaitingFor(null)
      }
    } finally {
      if (operation.current === token) {
        operation.current = null
        setBusy(false)
      }
    }
  }

  if (!owner) return null
  const disabled = busy || (waitingFor !== null && waitingFor !== paused)
  return <>
    <WorkshopButton disabled={disabled} onClick={() => paused ? setConfirmResume(true) : void change(true)}>
      {paused ? 'Resume automation...' : 'Pause automation'}
    </WorkshopButton>
    {error && <p role="alert" className="max-w-sm text-xs text-kumo-danger">{error}</p>}
    <Dialog.Root open={confirmResume && paused} onOpenChange={setConfirmResume}>
      <Dialog size="sm" className="responsive-dialog !z-[1000] !top-[clamp(28px,10vh,96px)] !w-[min(460px,calc(100vw-32px))] !-translate-y-0 !max-h-[min(80vh,calc(var(--app-height)-32px))] overflow-y-auto bg-kumo-base p-5">
        <Dialog.Title className="text-base font-medium text-kumo-default">Resume automation?</Dialog.Title>
        <Dialog.Description className="mt-3 text-sm text-kumo-subtle">
          Eligible queued prompts, automatic approvals under existing grants, and future triggers may run.
          Existing bot browser grants may become usable again. Per-chat queue pauses remain in place.
        </Dialog.Description>
        <p className="mt-3 text-sm text-kumo-subtle">Canceled turns are not replayed. Scheduled occurrences while paused were skipped, not saved for catch-up.</p>
        <p className="mt-3 text-sm text-kumo-subtle">External calls already in flight may finish. Pausing does not roll back their effects.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <WorkshopButton onClick={() => setConfirmResume(false)}>Cancel</WorkshopButton>
          <WorkshopButton tone="primary" disabled={disabled} onClick={() => void change(false)}>Resume automation</WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  </>
}
