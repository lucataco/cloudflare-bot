import { useEffect, useRef, useState } from 'react'
import type { AuthenticatedApi, BotBlueprintProfile } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'

export default function ImportGrokBot({ api, onPreview, disabled = false }: {
  api: RpcStub<AuthenticatedApi>
  onPreview: (bot: BotBlueprintProfile) => void
  disabled?: boolean
}) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    ++generation.current
    setLoading(false)
    setError('')
    return () => { ++generation.current }
  }, [api, disabled])
  return <details className="mt-4 rounded-xl border border-kumo-line p-3 text-sm">
    <summary>Import a public Grok bot profile</summary>
    <p className="my-2 text-xs text-kumo-subtle">Imports the public name and description for you to review below. Grok share pages do not expose skills, routines, private instructions or plugin IDs.</p>
    <label className="flex flex-col gap-2">Public share URL<input aria-label="Grok share URL" type="url" value={url} onChange={e => setUrl(e.target.value)} className="rounded border border-kumo-line bg-kumo-base p-2" placeholder="https://x.ai/bot/…" disabled={disabled || loading} /></label>
    <button type="button" disabled={disabled || loading || !url.trim()} className="mt-2 min-h-10 rounded bg-kumo-brand px-3 text-white disabled:opacity-50" onClick={async () => {
      const request = generation.current
      setLoading(true)
      setError('')
      try {
        const bot = await api.previewGrokBot(url.trim())
        if (request === generation.current) onPreview(bot)
      } catch (err) {
        if (request === generation.current) setError(err instanceof Error ? err.message : 'Could not import profile')
      } finally { if (request === generation.current) setLoading(false) }
    }}>{loading ? 'Reading public profile…' : 'Preview profile'}</button>
    {error && <p role="alert" className="mt-2 text-kumo-danger">{error}</p>}
  </details>
}
