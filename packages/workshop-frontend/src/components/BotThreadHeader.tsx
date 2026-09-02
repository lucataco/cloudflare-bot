import {
  AppWindow,
  Book,
  Brain,
  Clock,
  Desktop,
  Folder,
  Gear,
  Users,
} from '@phosphor-icons/react'
import type { AgentProfile, Group } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './WorkshopControls'
import ActivityNotifications from '../ActivityNotifications'
import ReconnectingChip from './ReconnectingChip'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActivityView } from '../Activity'
import type { MessengerInspector } from '../inspectorPane'

export type { MessengerInspector }

export default function BotThreadHeader({
  agent,
  group,
  inspector,
  onInspectorChange,
  onOpenActivity,
  overseer,
  reconnecting,
}: {
  agent?: AgentProfile
  group?: Group
  inspector: MessengerInspector
  onInspectorChange: (next: MessengerInspector) => void
  onOpenActivity: (view: ActivityView) => void
  overseer: RpcStub<Overseer> | null
  reconnecting: boolean
}) {
  const name = agent?.name ?? group?.name ?? 'Bot'
  const subtitle = agent?.title ?? (group ? `${group.memberAgentIds.length} members` : '')

  const toggle = (next: MessengerInspector) => {
    onInspectorChange(inspector === next ? 'none' : next)
  }

  return (
    <div className="relative flex h-14 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-brand text-white">
          {agent?.avatar?.url ? (
            <img src={agent.avatar.url} alt="" className="h-full w-full object-cover" />
          ) : group ? (
            <Users size={16} weight="bold" />
          ) : (
            <span className="text-[12px] font-semibold">{name[0]?.toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {name}
          </p>
          {subtitle && (
            <p className="truncate text-[12px] leading-4 text-kumo-subtle">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {reconnecting && <ReconnectingChip />}
        {overseer && (
          <ActivityNotifications overseer={overseer} onViewActivity={onOpenActivity} />
        )}
        <WorkshopIconButton
          title="Files"
          aria-label="Files"
          onClick={() => toggle('files')}
          className={inspector === 'files' ? 'bg-kumo-tint text-kumo-default' : undefined}
        >
          <Folder size={15} />
        </WorkshopIconButton>
        <WorkshopIconButton
          title="Gadget"
          aria-label="Gadget"
          onClick={() => toggle('gadget')}
          className={inspector === 'gadget' ? 'bg-kumo-tint text-kumo-default' : undefined}
        >
          <AppWindow size={15} />
        </WorkshopIconButton>
        {agent && (
          <>
            <WorkshopIconButton
              title="Computer"
              aria-label="Computer"
              onClick={() => toggle('computer')}
              className={inspector === 'computer' ? 'bg-kumo-tint text-kumo-default' : undefined}
            >
              <Desktop size={15} />
            </WorkshopIconButton>
            <WorkshopIconButton
              title="Skills"
              aria-label="Skills"
              onClick={() => toggle('skills')}
              className={inspector === 'skills' ? 'bg-kumo-tint text-kumo-default' : undefined}
            >
              <Book size={15} />
            </WorkshopIconButton>
            <WorkshopIconButton
              title="Memory"
              aria-label="Memory"
              onClick={() => toggle('memory')}
              className={inspector === 'memory' ? 'bg-kumo-tint text-kumo-default' : undefined}
            >
              <Brain size={15} />
            </WorkshopIconButton>
            <WorkshopIconButton
              title="Routines"
              aria-label="Routines"
              onClick={() => toggle('routines')}
              className={inspector === 'routines' ? 'bg-kumo-tint text-kumo-default' : undefined}
            >
              <Clock size={15} />
            </WorkshopIconButton>
            <WorkshopIconButton
              title="Settings"
              aria-label="Settings"
              onClick={() => toggle('settings')}
              className={inspector === 'settings' ? 'bg-kumo-tint text-kumo-default' : undefined}
            >
              <Gear size={15} />
            </WorkshopIconButton>
          </>
        )}
      </div>
    </div>
  )
}
