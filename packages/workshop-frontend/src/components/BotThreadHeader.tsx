import { DropdownMenu } from '@cloudflare/kumo'
import type { ReactNode } from 'react'
import {
  AppWindow,
  Book,
  Brain,
  Clock,
  Desktop,
  DotsThree,
  Folder,
  Gear,
  Pulse,
  Users,
} from '@phosphor-icons/react'
import type { AgentProfile, Group } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from './menuStyles'
import ActivityNotifications from '../ActivityNotifications'
import ReconnectingChip from './ReconnectingChip'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActivityView } from '../Activity'
import type { MessengerInspector } from '../inspectorPane'

export type { MessengerInspector }

const inspectorActions = [
  { pane: 'gadget', label: 'App preview', icon: AppWindow },
  { pane: 'computer', label: 'Computer', icon: Desktop },
  { pane: 'skills', label: 'Skills', icon: Book },
  { pane: 'memory', label: 'Memory', icon: Brain },
  { pane: 'routines', label: 'Routines', icon: Clock },
  { pane: 'settings', label: 'Bot settings', icon: Gear },
] as const

export default function BotThreadHeader({
  agent,
  group,
  inspector,
  onInspectorChange,
  onOpenActivity,
  overseer,
  reconnecting,
  automationControl,
}: {
  agent?: AgentProfile
  group?: Group
  inspector: MessengerInspector
  onInspectorChange: (next: MessengerInspector) => void
  onOpenActivity: (view: ActivityView) => void
  overseer: RpcStub<Overseer> | null
  reconnecting: boolean
  automationControl?: ReactNode
}) {
  const name = agent?.name ?? group?.name ?? 'Bot'
  const subtitle = agent?.title ?? (group ? `${group.memberAgentIds.length} members` : '')

  const toggle = (next: MessengerInspector) => {
    onInspectorChange(inspector === next ? 'none' : next)
  }

  return (
    <div className="relative flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-kumo-line bg-kumo-base px-3 py-2 sm:flex-nowrap sm:px-4">
      <div className="flex min-w-24 flex-1 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-brand text-white">
          {agent?.avatar?.url ? (
            <img src={agent.avatar.url} alt="" className="h-full w-full object-cover" />
          ) : group ? (
            <Users size={16} weight="bold" />
          ) : (
            <span className="text-[12px] font-semibold">{name[0]?.toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {name}
          </p>
          {subtitle && (
            <p className="truncate text-[12px] leading-4 text-kumo-subtle">{subtitle}</p>
          )}
        </div>
        {reconnecting && <ReconnectingChip />}
      </div>

      <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
        <WorkshopButton
          aria-label="Results"
          aria-pressed={inspector === 'files'}
          onClick={() => toggle('files')}
          className={`gap-1.5 !px-2 sm:!px-3 ${inspector === 'files' ? 'bg-kumo-tint' : ''}`}
        >
          <Folder size={15} aria-hidden="true" className="hidden sm:block" />
          Results
        </WorkshopButton>
        {overseer && (
          <ActivityNotifications overseer={overseer} onViewActivity={onOpenActivity} pendingOnly />
        )}
        {automationControl}
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <WorkshopButton aria-label="More" className="gap-1.5 !px-2 sm:!px-3">
                <DotsThree size={16} aria-hidden="true" className="hidden sm:block" />
                More
              </WorkshopButton>
            }
          />
          <DropdownMenu.Content
            align="end"
            collisionPadding={12}
            className={`${MENU_CONTENT} !w-[min(220px,calc(100vw-24px))] !min-w-0`}
            style={MENU_POSITIONER_STYLE}
          >
            {inspectorActions.filter(({ pane }) => pane === 'gadget' || agent).map(({ pane, label, icon }) => (
              <DropdownMenu.Item
                key={pane}
                icon={icon}
                selected={inspector === pane}
                onClick={() => toggle(pane)}
                className={MENU_ITEM}
              >
                {label}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              icon={Pulse}
              onClick={() => onOpenActivity('history')}
              className={MENU_ITEM}
            >
              Activity history
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
  )
}
