import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type { AdminApi, GadgetMetadataWithTimestamps, Overseer } from '@gadgets/workshop-shared/api'
import { requiresManualReview, type AutoReviewBoundary } from '@gadgets/workshop-shared/auto-review'
import { useAuthenticatedApi } from './AuthContext'
import { useAutoApproval, autoApprovalKey } from './useAutoApproval'
import { useDocumentTitle } from './useDocumentTitle'

export default function AutoReviewPage({ adminMode = false }: { adminMode?: boolean }) {
  const { authenticatedApi: api } = useAuthenticatedApi()
  useDocumentTitle(adminMode ? 'Review boundaries' : 'Auto-review rules')
  const [workspaces, setWorkspaces] = useState<GadgetMetadataWithTimestamps[]>([])
  const [boundaries, setBoundaries] = useState<AutoReviewBoundary[] | null>(null)
  const [admin, setAdmin] = useState<{ api: RpcStub<AdminApi> } | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    let capability: RpcStub<AdminApi> | null = null
    setBoundaries(null); setAdmin(null); setWorkspaces([]); setSelected(''); setError('')
    void Promise.all([api.getAutoReviewBoundaries(), api.listGadgets()]).then(([policy, list]) => {
      if (cancelled) return
      setBoundaries(policy); setWorkspaces(list)
    }).catch(() => { if (!cancelled) setError('Could not load review rules.') })
    api.getAdminApi().then(result => {
      if (cancelled) { result?.[Symbol.dispose](); return }
      capability = result
      if (result) setAdmin({ api: result })
    }).catch(() => { if (!cancelled && adminMode) setError('Could not load administrator access.') })
    return () => { cancelled = true; capability?.[Symbol.dispose]() }
  }, [api, attempt, adminMode])

  return <div className="mx-auto max-w-4xl space-y-5 p-6">
    <h1 className="text-xl font-semibold">{adminMode ? 'Review boundaries' : 'Auto-review rules'}</h1>
    <p className="text-sm text-kumo-subtle">Ask first is the default. Allow automatically applies only to an exact action kind on a specific workspace connection, when the connector declares that action eligible. Administrator locks always require a human decision.</p>
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {!boundaries && !error && <p role="status">Loading rules…</p>}
    {boundaries && <>
      {adminMode ? admin ? <BoundaryEditor api={admin.api} boundaries={boundaries} onSaved={setBoundaries} />
        : <p>Administrator access is required to change deployment boundaries.</p>
        : <>
          <section className="rounded-xl border border-kumo-line p-4">
            <h2 className="font-medium">Locked by administrator</h2>
            {boundaries.length === 0 ? <p className="text-sm text-kumo-subtle">No deployment locks.</p>
              : boundaries.map((rule, index) => <p key={index} className="mt-2 text-sm">Ask first · {rule.vendorId ?? 'All connectors'} · {rule.tag ?? 'All action kinds'}</p>)}
            {admin && <Link to="/admin/boundaries" className="mt-2 inline-block text-sm text-kumo-brand">Manage boundaries</Link>}
          </section>
          <label className="flex flex-col gap-2 text-sm">Workspace or bot
            <select value={selected} onChange={event => setSelected(event.target.value)} className="rounded border border-kumo-line bg-kumo-base p-2">
              <option value="">Choose a workspace</option>
              {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
            </select>
          </label>
          {selected && <WorkspaceRules key={selected} workspaceId={selected} boundaries={boundaries} />}
        </>}
    </>}
  </div>
}

function WorkspaceRules({ workspaceId, boundaries }: { workspaceId: string; boundaries: AutoReviewBoundary[] }) {
  const { authenticatedApi: api } = useAuthenticatedApi()
  const [session, setSession] = useState<{ api: RpcStub<Overseer> } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<Overseer> | undefined
    const pending = api.openGadget(workspaceId)
    pending.then(result => {
      if (cancelled) result[Symbol.dispose]()
      else { stub = result; setSession({ api: result }) }
    }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true; stub?.[Symbol.dispose]() }
  }, [api, workspaceId])
  const rules = useAutoApproval(session?.api ?? null)
  if (error || rules.loadError) return <p role="alert">Could not load this workspace's rules.</p>
  if (!session || rules.isLoading) return <p role="status">Loading workspace rules…</p>
  return <section className="space-y-3" aria-label="Workspace rules">
    {rules.entries.length === 0 && <p className="text-sm text-kumo-subtle">No eligible connection actions or standing rules in this workspace.</p>}
    {rules.entries.map(entry => {
      const key = autoApprovalKey(entry)
      const locked = requiresManualReview(boundaries, entry.vendorId, entry.actionKind.tag)
      return <div key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kumo-line p-4">
        <div><p className="font-medium">{entry.actionKind.label}</p>
          <p className="text-xs text-kumo-subtle">{entry.resourceTitle || `Connection ${entry.gatekeeperId}`} · {entry.actionKind.tag}</p>
          <p className="text-xs text-kumo-subtle">{locked ? 'Ask first · Locked by administrator' : entry.orphaned ? 'Orphaned standing rule — may be revoked' : 'Applies to every gadget using this connection in this workspace'}</p>
        </div>
        <select aria-label={`Review mode for ${entry.actionKind.label}`} value={entry.enabled ? 'allow' : 'ask'}
          disabled={rules.pending.has(key)} className="rounded border border-kumo-line bg-kumo-base p-2 text-sm"
          onChange={event => void rules.setEnabled(entry, event.target.value === 'allow')}>
          <option value="ask">Ask first</option>
          <option value="allow" disabled={locked || entry.orphaned}>{locked ? 'Saved allow rule (overridden)' : 'Allow automatically'}</option>
        </select>
      </div>
    })}
  </section>
}

function BoundaryEditor({ api, boundaries, onSaved }: {
  api: RpcStub<AdminApi>; boundaries: AutoReviewBoundary[]; onSaved: (rules: AutoReviewBoundary[]) => void
}) {
  const [vendor, setVendor] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (next: AutoReviewBoundary[]) => {
    setBusy(true); setError('')
    try { await api.setAutoReviewBoundaries(next); onSaved(await api.getAutoReviewBoundaries()) }
    catch { setError('Could not save boundaries. Reload before retrying.') }
    finally { setBusy(false) }
  }
  return <section className="space-y-3" aria-label="Deployment review boundaries">
    <p className="text-sm">Each entry locks matching actions to Ask first. Removing a lock restores the owner's saved rules. These boundaries govern queued connector actions, not coarse browser-control grants.</p>
    {boundaries.map((rule, index) => <div key={index} className="flex justify-between gap-3 rounded border border-kumo-line p-3 text-sm">
      <span>{rule.vendorId ?? 'All connectors'} · {rule.tag ?? 'All action kinds'} · Ask first</span>
      <button disabled={busy} onClick={() => void save(boundaries.filter((_, i) => i !== index))}>Remove lock</button>
    </div>)}
    <form className="flex flex-wrap gap-3" onSubmit={event => {
      event.preventDefault()
      void save([...boundaries, { vendorId: vendor.trim() || null, tag: tag.trim() || null }])
    }}>
      <input aria-label="Connector ID" placeholder="Connector ID (empty = all)" value={vendor} onChange={event => setVendor(event.target.value)} disabled={busy} className="rounded border border-kumo-line bg-kumo-base p-2" />
      <input aria-label="Action tag" placeholder="Exact action tag (empty = all)" value={tag} onChange={event => setTag(event.target.value)} disabled={busy} className="rounded border border-kumo-line bg-kumo-base p-2" />
      <button disabled={busy || boundaries.length >= 100} className="rounded bg-kumo-brand px-3 py-2 text-white">Lock to Ask first</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>
}
