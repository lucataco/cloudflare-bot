import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

/** Owner-only secret transport: the value never goes through a chat message or a React state prop. */
export default function SecretRequestInput({ overseer, requestId, submitted }: {
  overseer: RpcStub<Overseer>; requestId: string; submitted: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState(false)
  const [owner, setOwner] = useState<{ api: RpcStub<Overseer>; allowed: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    overseer.getMetadata().then(metadata => {
      if (!cancelled) setOwner({ api: overseer, allowed: !metadata.owner && metadata.role !== 'use' })
    }).catch(() => { if (!cancelled) setOwner({ api: overseer, allowed: false }) })
    return () => { cancelled = true }
  }, [overseer])
  if (owner?.api !== overseer) return <p role="status" className="mt-2 text-xs">Checking secure-entry access…</p>
  if (!owner.allowed) return <p className="mt-2 text-xs">Only the workspace owner can provide this value.</p>
  return <form className="mt-3 space-y-2" onSubmit={async event => {
    event.preventDefault()
    if (!input.current || busy || attempted || submitted) return
    let value = input.current.value
    if (!value) return
    input.current.value = ''
    setBusy(true)
    setError(false)
    try { await overseer.submitComputerSecret(requestId, value) }
    catch { setError(true) }
    finally { value = ''; setBusy(false); setAttempted(true) }
  }}>
    <p className="text-xs">Secure entry goes directly to the focused browser field. The bot remains paused under human control. Complete the form in Computer view before resuming.</p>
    {!submitted && !attempted && <div className="flex flex-wrap gap-2">
      <input ref={input} type="password" aria-label="Secure value" autoComplete="off" spellCheck={false}
        maxLength={4096} disabled={busy} className="min-w-0 rounded border border-kumo-line bg-kumo-base p-2" />
      <button type="submit" disabled={busy} className="rounded bg-kumo-brand px-3 py-2 text-white">{busy ? 'Sending…' : 'Send securely'}</button>
    </div>}
    {(submitted || attempted) && <p role="status" className="text-xs">Entry attempted. Check Computer view to finish.</p>}
    {error && <p role="alert" className="text-xs text-kumo-danger">Could not confirm delivery. Complete this step in Computer view.</p>}
  </form>
}
