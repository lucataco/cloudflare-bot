import { Link } from '@tanstack/react-router'
import { Bell, ArrowRight } from '@phosphor-icons/react'
import type { AttentionKind, AttentionState } from '@gadgets/workshop-shared/api'
import { useAttention } from './AttentionContext'
import { useDocumentTitle } from './useDocumentTitle'
import { WorkshopButton } from './components/WorkshopControls'
import PushSettingsPanel from './PushSettingsPanel'

const categories: Record<AttentionKind, string> = {
  run: 'Run', action: 'Action', proposal: 'Proposal', connection: 'Connection', human: 'Human input', changes: 'Changes',
}
const states: Record<AttentionState, string> = {
  pending: 'Pending', accepting: 'Accepting', resolved: 'Resolved', finished: 'Finished', failed: 'Failed', incomplete: 'Incomplete', canceled: 'Canceled',
}

export default function AttentionPage() {
  useDocumentTitle('Attention')
  const { page, loading, paging, error, store, isMarking } = useAttention()
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10 [&_button]:min-h-11 sm:[&_button]:min-h-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-kumo-default"><Bell size={24} /> Attention</h1>
          <p className="mt-2 text-sm text-kumo-subtle">Recent updates across your workspaces.</p>
        </div>
        <WorkshopButton disabled={loading || paging} onClick={() => store?.refresh()}>Refresh</WorkshopButton>
      </header>
      <section aria-label="Recent attention" className="rounded-xl border border-kumo-line bg-kumo-base">
        <div className="border-b border-kumo-line p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-kumo-default">{page ? `${page.unseen} recent unseen` : 'Recent unseen'}</h2>
          <p className="mt-1 text-sm text-kumo-subtle">Seen is only an acknowledgement of this version. It never approves or resolves a request.</p>
          <p className="mt-1 text-sm text-kumo-subtle">Open the workspace to review and act. Finished does not mean verified success.</p>
        </div>
        <div aria-live="polite" className="px-4 sm:px-5">
          {loading && <p role="status" className="py-3 text-sm text-kumo-subtle">Refreshing recent items...</p>}
          {error && <p role="alert" className="py-3 text-sm text-kumo-danger">{error} <button className="underline" onClick={() => store?.refresh()}>Retry</button></p>}
          {page?.catchingUp && <p role="status" className="py-3 text-sm text-kumo-subtle">Catching up: some workspace updates have not reached this inbox yet.</p>}
          {page?.truncated && <p className="py-3 text-sm text-kumo-subtle">Retention limit: older items may no longer appear here. Requests remain in their workspaces.</p>}
          {page?.entries.length === 0 && !loading && <div className="py-8 text-sm text-kumo-subtle">
            <p className="font-medium text-kumo-default">No recent items to show.</p>
            <p className="mt-1">This is not a complete inventory of requests needing attention. Check your workspaces for canonical records.</p>
          </div>}
        </div>
        <ul className="divide-y divide-kumo-line">
          {page?.entries.map(item => <li key={item.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
                <span className="rounded bg-kumo-tint px-2 py-1 font-medium text-kumo-default">{categories[item.kind]}</span>
                <span>Source: {states[item.state]}</span>
                <span className={item.seen ? '' : 'font-semibold text-kumo-default'}>{item.seen ? 'Seen' : 'Unseen'}</span>
              </div>
              <h3 className="mt-2 break-words text-sm font-medium text-kumo-default">{item.workspaceTitle || 'Workspace'}</h3>
              <time className="mt-1 block text-xs text-kumo-subtle" dateTime={item.updatedAt.toISOString()}>{item.updatedAt.toLocaleString()}</time>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <WorkshopButton aria-label={`Mark version ${item.version} of ${item.workspaceTitle || 'Workspace'} seen`} disabled={item.seen || isMarking(item)} onClick={() => void store?.markSeen(item)}>
                {isMarking(item) ? 'Marking...' : 'Mark seen'}
              </WorkshopButton>
              <Link to="/workspace/$id" params={{ id: item.workspaceId }} search={{ chat: item.chatId }}
                className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-kumo-link focus-visible:outline-2 focus-visible:outline-kumo-ring">
                Open <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </li>)}
        </ul>
        {page?.nextBeforeOrder !== undefined && <div className="border-t border-kumo-line p-4 sm:p-5">
          <WorkshopButton disabled={loading || paging} onClick={() => void store?.loadMore()}>{paging ? 'Loading older items...' : 'Load older items'}</WorkshopButton>
          <p className="mt-2 text-xs text-kumo-subtle">Live updates refresh the newest page. Load older items again after a refresh.</p>
        </div>}
      </section>
      <PushSettingsPanel />
    </div>
  )
}
