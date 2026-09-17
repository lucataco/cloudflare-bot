import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ComputerOperation, ComputerResult } from '@gadgets/workshop-shared/computer'

export default function ComputerWorkspacePane({ overseer, agentId, humanControl }: {
  overseer: Pick<RpcStub<Overseer>, 'getComputerWorkspaceAccess' | 'setComputerWorkspaceAccess' | 'getComputerSession'>;
  agentId: string; humanControl: boolean
}) {
  const [access, setAccess] = useState<{ available: boolean; enabled: boolean }>()
  const [command, setCommand] = useState('pwd && ls -la')
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<ComputerResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void (async () => {
      try { const value = await overseer.getComputerWorkspaceAccess(agentId); if (active) setAccess(value) }
      catch { if (active) setError('Could not load shell/files access.') }
    })()
    return () => { active = false }
  }, [overseer, agentId])
  const run = async (operation: ComputerOperation) => {
    if (busy || !access?.available || !access.enabled || !humanControl) return
    setBusy(true); setError('')
    try {
      using session = await overseer.getComputerSession(agentId)
      const value = await session.workspace(operation)
      setResult(value)
      if (value.data !== undefined) setText(new TextDecoder().decode(Uint8Array.from(atob(value.data), character => character.charCodeAt(0))))
    } catch { setError('Operation could not be confirmed. No command was retried; check the last durable workspace before continuing.') }
    finally { setBusy(false) }
  }
  const disabled = busy || !access?.available || !access.enabled || !humanControl
  return <section aria-label="Computer shell and files" className="space-y-3 p-4 text-sm">
    <h3 className="font-medium">Shell and durable /workspace</h3>
    <p className="text-xs text-kumo-subtle">Each operation uses this bot’s isolated container. Files are checkpointed after mutations. Shell state and background processes do not persist. Internet access is disabled.</p>
    {access && !access.available && <p>Deploy and bind the optional computer runtime to enable this feature.</p>}
    {access?.available && <label className="flex items-center gap-2">
      <input type="checkbox" checked={access.enabled} disabled={busy} onChange={async event => {
        const enabled = event.target.checked
        setBusy(true); setError('')
        try { await overseer.setComputerWorkspaceAccess(agentId, enabled); setAccess({ ...access, enabled }) }
        catch { setError('Could not change shell/files access.') }
        finally { setBusy(false) }
      }} />Enable shell/files for this bot (also available to the bot when bot control is allowed)
    </label>}
    {!humanControl && <p>Take human control before using the shell or editing files here.</p>}
    <label className="block">Command<textarea aria-label="Computer command" value={command} onChange={event => setCommand(event.target.value)} disabled={disabled} rows={3} className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2 font-mono" /></label>
    <button disabled={disabled} onClick={() => void run({ kind: 'exec', command })} className="rounded bg-kumo-brand px-3 py-2 text-white disabled:opacity-50">{busy ? 'Working…' : 'Run command'}</button>
    <div className="flex flex-wrap gap-2">
      <input aria-label="Workspace file path" value={path} onChange={event => setPath(event.target.value)} placeholder="Relative path in /workspace" className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base p-2" />
      <button disabled={disabled} onClick={() => void run({ kind: 'list', path })}>List</button>
      <button disabled={disabled || !path} onClick={() => void run({ kind: 'read', path })}>Read</button>
    </div>
    <textarea aria-label="Workspace file text" value={text} onChange={event => setText(event.target.value)} disabled={disabled} rows={4} className="w-full rounded border border-kumo-line bg-kumo-base p-2 font-mono" />
    <button disabled={disabled || !path} onClick={() => void run({ kind: 'write', path, data: btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')) })}>Save file</button>
    {result && <div><p>Exit code: {result.exitCode}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap">{result.stdout}{result.stderr}</pre>
      {result.entries?.map(entry => <p key={entry.name} className="font-mono text-xs">{entry.kind === 'directory' ? '📁 ' : ''}{entry.name}</p>)}
    </div>}
    {error && <p role="alert" className="text-kumo-danger">{error}</p>}
  </section>
}
