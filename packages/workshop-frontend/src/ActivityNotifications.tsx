import { useEffect, useState } from 'react'
import { Popover } from '@cloudflare/kumo'
import { ArrowRight, Pulse } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { CountBadge } from './components/CountBadge'
import { AlwaysApproveButton, ResolveButton } from './components/ResolveButton'
import AutoApproveConfirmDialog from './components/AutoApproveConfirmDialog'
import { WorkshopButton } from './components/WorkshopControls'
import {
  ActionApprovalDetails,
  formatRelativeTime,
  PENDING_CHECKING_COPY,
  PENDING_ERROR_COPY,
  type ActivityView,
} from './Activity'
import { useActions } from './useActions'
import { useAlwaysApproveTag } from './useAlwaysApproveTag'
import { useResolveAction } from './useResolveAction'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

interface ActivityNotificationsProps {
  overseer: RpcStub<Overseer>
  onViewActivity: (view: ActivityView) => void
  /** Show a labelled approval control only while requests are pending, instead of the Activity icon. */
  pendingOnly?: boolean
}

const PREVIEW_LIMIT = 3

export default function ActivityNotifications({
  overseer,
  onViewActivity,
  pendingOnly = false,
}: ActivityNotificationsProps) {
  const [open, setOpen] = useState(false)
  const [processing, setProcessing] = useState<Set<number>>(new Set())
  const [confirmAutoApprove, setConfirmAutoApprove] = useState<{
    actionId: number
    gatekeeperId: number
    resourceTitle: string
    resourceUrl?: string
    actionKind: ActionKind
  } | null>(null)
  const resolveAction = useResolveAction(overseer, setProcessing)
  const { alwaysApproveTag, isTagAutoApproved } = useAlwaysApproveTag(overseer, setProcessing)
  const { status, pending } = useActions(overseer)

  useEffect(() => {
    if (pendingOnly && pending.length === 0) setOpen(false)
  }, [pendingOnly, pending.length])

  const openFullView = (view: ActivityView) => {
    setOpen(false)
    onViewActivity(view)
  }

  if (pendingOnly && pending.length === 0) return null

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          pendingOnly ? (
            <WorkshopButton
              aria-label={`Needs approval: ${pending.length} ${pending.length === 1 ? 'request' : 'requests'}`}
              className="gap-1.5 whitespace-nowrap !px-2 text-kumo-strong sm:!px-3"
            >
              Needs approval
              <CountBadge count={pending.length} max={99} />
            </WorkshopButton>
          ) : (
            <button
              type="button"
              aria-label={pending.length > 0
                ? `Activity — ${pending.length} ${pending.length === 1 ? 'request needs' : 'requests need'} review`
                : 'Activity'}
              className={`relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
                pending.length > 0 ? 'text-kumo-strong' : 'text-kumo-subtle hover:text-kumo-default'
              }`}
            >
              <Pulse size={16} weight={pending.length > 0 ? 'bold' : 'regular'} />
              <CountBadge count={pending.length} tone="solid" className="absolute -right-0.5 -top-0.5" />
            </button>
          )
        }
      />
      {/* Kumo always renders base-ui's arrow as the popup's first child; hide it so this sits flush
          like the header's profile menu, which has no arrow. */}
      <Popover.Content
        align="end"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(340px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-lg border border-kumo-line !outline-none bg-kumo-base !p-0 [&>:first-child]:hidden"
      >
        <div className="flex items-center justify-between gap-2 px-3.5 pb-1 pt-2.5">
          <Popover.Title className="text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
            {pendingOnly ? 'Needs approval' : 'Needs review'}
          </Popover.Title>
          <CountBadge count={pending.length} />
        </div>

        {pending.length === 0 ? (
          <p className="m-0 px-3.5 pb-3 pt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            {status === 'error' ? PENDING_ERROR_COPY
              : status === 'checking' ? PENDING_CHECKING_COPY
              : 'Nothing is waiting on you.'}
          </p>
        ) : (
          <div className="max-h-[min(58vh,420px)] overflow-y-auto pb-1">
            {pending.slice(0, PREVIEW_LIMIT).map((action, index) => {
              const isProcessing = processing.has(action.id)
              const autoApproveTarget =
                action.type === 'action' && action.gatekeeperId !== undefined &&
                action.description.actionKind !== undefined &&
                action.description.autoApprovable === true
                  ? {
                      actionId: action.id,
                      gatekeeperId: action.gatekeeperId,
                      resourceTitle: action.resourceTitle,
                      resourceUrl: action.resourceUrl,
                      actionKind: action.description.actionKind,
                    }
                  : undefined
              return (
                <div
                  key={action.id}
                  className={`px-3.5 py-2.5 ${index === 0 ? '' : 'border-t border-kumo-line'}`}
                >
                  <div>
                    <h3 className="m-0 text-[14px] font-medium text-kumo-default">Allow this action?</h3>
                    <span className="text-[11.5px] text-kumo-inactive">{formatRelativeTime(action.createdAt)}</span>
                    <ActionApprovalDetails record={action} collapsible />
                    <button
                      type="button"
                      onClick={() => openFullView('review')}
                      className="min-h-11 cursor-pointer text-left text-[13px] font-medium text-kumo-default underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                    >
                      Review details
                    </button>
                    <div className="mt-1 flex flex-wrap items-center justify-end gap-2 [&>button]:min-h-11 [&>button]:min-w-11">
                      {autoApproveTarget &&
                        !isTagAutoApproved(autoApproveTarget.gatekeeperId, autoApproveTarget.actionKind.tag) && (
                        <AlwaysApproveButton
                          disabled={isProcessing}
                          onClick={() => {
                            setOpen(false)
                            setConfirmAutoApprove(autoApproveTarget)
                          }}
                        />
                      )}
                      <ResolveButton
                        tone="deny"
                        disabled={isProcessing}
                        onClick={() => void resolveAction(action.id, 'deny')}
                      />
                      <ResolveButton
                        tone="approve"
                        variant="filled"
                        disabled={isProcessing}
                        onClick={() => void resolveAction(action.id, 'approve')}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="border-t border-kumo-line p-1">
          <button
            type="button"
            onClick={() => openFullView(pending.length > 0 ? 'review' : 'history')}
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
          >
            <span>
              {pending.length > PREVIEW_LIMIT
                ? `View all ${pending.length} requests`
                : 'View all activity'}
            </span>
            <ArrowRight size={13} className="text-kumo-inactive" />
          </button>
        </div>
      </Popover.Content>
    </Popover>
    {confirmAutoApprove && (
      <AutoApproveConfirmDialog
        open
        actionKind={confirmAutoApprove.actionKind}
        gatekeeperId={confirmAutoApprove.gatekeeperId}
        resourceTitle={confirmAutoApprove.resourceTitle}
        resourceUrl={confirmAutoApprove.resourceUrl}
        isProcessing={processing.has(confirmAutoApprove.actionId)}
        onOpenChange={(next) => { if (!next) setConfirmAutoApprove(null) }}
        onConfirm={() => {
          const { actionId, gatekeeperId, actionKind } = confirmAutoApprove
          void alwaysApproveTag(actionId, gatekeeperId, actionKind).then(ok => {
            if (ok) setConfirmAutoApprove(null)
          })
        }}
      />
    )}
    </>
  )
}
