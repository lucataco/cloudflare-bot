import { Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'
import { safeExternalUrl } from '../utils/safeExternalUrl'

interface AutoApproveConfirmDialogProps {
  open: boolean
  actionKind: ActionKind
  gatekeeperId: number
  resourceTitle: string
  resourceUrl?: string
  isProcessing?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * Confirmation for enabling auto-approval of an action type on a connection. Enabling is a standing
 * policy change for eligible matching pending and future actions, not just the displayed request.
 */
export default function AutoApproveConfirmDialog({
  open,
  actionKind,
  gatekeeperId,
  resourceTitle,
  resourceUrl,
  isProcessing = false,
  onOpenChange,
  onConfirm,
}: AutoApproveConfirmDialogProps) {
  const url = safeExternalUrl(resourceUrl)
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isProcessing) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="responsive-dialog !z-[1000] !w-[min(440px,calc(100vw-32px))] max-h-[85dvh] overflow-y-auto bg-kumo-base p-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Allow this category automatically?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              This is a standing rule for this connection and action category throughout this
              workspace, across all chats and apps. It is not limited to one action.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!min-h-11 !min-w-11"
                disabled={isProcessing}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="space-y-3 px-5 py-4 text-[13px] leading-5 text-kumo-subtle">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt>Action category</dt>
            <dd className="m-0 break-words font-medium text-kumo-default">{actionKind.label}</dd>
            <dt>Connection</dt>
            <dd className="m-0 min-w-0 break-words text-kumo-default">
              {resourceTitle || 'Connection title unavailable'}
              <span className="block text-kumo-subtle">Connection #{gatekeeperId}</span>
              {url && <a href={url} target="_blank" rel="noopener noreferrer" className="block break-all underline">{url}</a>}
            </dd>
          </dl>
          <p>Eligible matching pending and future actions may run without asking, including requests
            already waiting for review. Only actions the connection marks as auto-approvable qualify.</p>
          <p>Revoke this rule in <strong>Activity &gt; Auto-approval</strong>. Revoking it does not undo
            actions that have already run.</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <Dialog.Close
            render={(props) => (
              <WorkshopButton {...props} className="!min-h-11" disabled={isProcessing}>
                Cancel
              </WorkshopButton>
            )}
          />
          <WorkshopButton
            tone="primary"
            onClick={onConfirm}
            disabled={isProcessing}
            className="!min-h-11 min-w-[64px]"
          >
            {isProcessing ? 'Enabling...' : 'Enable auto-approval'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
