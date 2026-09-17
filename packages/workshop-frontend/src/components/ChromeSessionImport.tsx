import { useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'

/** Owner-only file input; exports go directly to the private browser RPC, never chat attachments. */
export default function ChromeSessionImport({ overseer, agentId, disabled }: {
  overseer: RpcStub<Overseer>; agentId: string; disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return <label className="block text-xs text-kumo-subtle">Import Chrome session export (JSON, up to 1 MiB)
    <input type="file" accept="application/json,.json" aria-label="Import Chrome session" disabled={disabled || busy}
      className="mt-1 block max-w-full" onChange={async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file || disabled || busy) return
        if (file.size > 1024 * 1024) { setMessage('The session export is too large.'); return }
        setBusy(true); setMessage('')
        let bytes: Uint8Array | undefined
        try {
          bytes = new Uint8Array(await file.arrayBuffer())
          await overseer.importComputerCookies(agentId, bytes)
          setMessage('Session imported. Navigate to the site to check it before resuming the bot.')
        } catch { setMessage('Import failed. Keep human control enabled and check the export format.') }
        finally { bytes?.fill(0); setBusy(false) }
      }} />
    {message && <span role="status" className="mt-1 block">{message}</span>}
  </label>
}
