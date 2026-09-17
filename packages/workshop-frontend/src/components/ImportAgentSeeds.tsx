import { useRef, useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

export default function ImportAgentSeeds({ api, disabled, onSuccess, onBusyChange }: {
  api: RpcStub<AuthenticatedApi>
  disabled: boolean
  onSuccess: (id: string, workspaceId: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const toasts = useKumoToastManager()
  async function importFile(file: File) {
    if (disabled || busy) return
    setBusy(true)
    onBusyChange(true)
    try {
      if (file.size > 64 * 1024) throw new Error('agents.yaml exceeds 64 KiB.')
      const result = await api.seedAgents(await file.text())
      toasts.add({ title: `${result.created.length} bots created`,
        description: `${result.skipped.length} existing seed keys skipped. Routines start paused.`, variant: 'success' })
      const first = result.created[0]
      if (first) onSuccess(first.id, first.workspaceId)
    } catch (error) {
      toasts.add({ title: 'Could not import agents.yaml',
        description: error instanceof Error ? error.message : 'Import failed.', variant: 'error' })
    } finally { setBusy(false); onBusyChange(false) }
  }
  return <div>
    <input ref={input} type="file" accept=".yaml,.yml" hidden disabled={disabled || busy} aria-label="Agent seed file"
      onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void importFile(file)
      }} />
    <Button type="button" size="sm" variant="secondary" disabled={disabled || busy}
      onClick={() => input.current?.click()}>{busy ? 'Importing…' : 'Import agents.yaml'}</Button>
    <p className="mt-1 text-xs text-kumo-subtle">Create bots once per seed key. Reimporting preserves your edits.</p>
  </div>
}
