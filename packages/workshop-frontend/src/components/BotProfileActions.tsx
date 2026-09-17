import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import type { AgentProfile, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { notifyAgentsChanged } from '../agentsChanged'
import { persistLastThread } from '../lastThread'

/** Shared lifecycle controls for the roster dialog and the mobile/desktop settings pane. */
export default function BotProfileActions({ agent, api, disabled, onBusyChange, onUpdated, onDuplicated }: {
  agent: AgentProfile
  api: RpcStub<AuthenticatedApi>
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onUpdated: (agent: AgentProfile) => void
  onDuplicated?: () => void
}) {
  const navigate = useNavigate()
  const toasts = useKumoToastManager()
  const [shareUrl, setShareUrl] = useState('')
  const [shareReview, setShareReview] = useState(false)
  const linkInput = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const pending = useRef(false)

  useEffect(() => {
    ++generation.current
    pending.current = false
    setShareUrl('')
    setShareReview(false)
    return () => { ++generation.current }
  }, [api, agent.id])

  const lifecycle = async (action: 'duplicate' | 'hide' | 'share') => {
    if (disabled || pending.current) return
    const request = generation.current
    pending.current = true
    onBusyChange(true)
    try {
      if (action === 'share') {
        const id = await api.publishAgentBlueprint(agent.id)
        if (request !== generation.current) return
        setShareUrl(new URL(`/blueprint/${id}`, window.location.origin).href)
        setShareReview(false)
      } else if (action === 'duplicate') {
        const copy = await api.duplicateAgent(agent.id)
        if (request !== generation.current) return
        notifyAgentsChanged()
        persistLastThread({ kind: 'agent', id: copy.id })
        onBusyChange(false)
        onDuplicated?.()
        await navigate({ to: '/agents/$id', params: { id: copy.id }, search: {} })
      } else {
        const updated = await api.updateAgent(agent.id, { hidden: !agent.hidden })
        if (request !== generation.current) return
        notifyAgentsChanged()
        onBusyChange(false)
        onUpdated(updated)
      }
    } catch (err) {
      if (request !== generation.current) return
      toasts.add({ title: 'Could not update bot', description: err instanceof Error ? err.message : 'Try again', variant: 'error' })
    } finally {
      if (request === generation.current) {
        pending.current = false
        onBusyChange(false)
      }
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      toasts.add({ title: 'Bot link copied', variant: 'success' })
    } catch {
      linkInput.current?.focus()
      linkInput.current?.select()
      toasts.add({ title: 'Select and copy the public bot link below', variant: 'info' })
    }
  }

  const shareLink = async () => {
    try {
      await navigator.share({ title: agent.name, url: shareUrl })
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) await copyLink()
    }
  }

  return <section aria-label="Bot actions" className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={disabled} onClick={() => void lifecycle('duplicate')}>Duplicate bot</Button>
      <Button variant="secondary" disabled={disabled} onClick={() => void lifecycle('hide')}>{agent.hidden ? 'Show bot' : 'Hide bot'}</Button>
      <Button variant="secondary" disabled={disabled} onClick={() => setShareReview(true)}>Share bot</Button>
    </div>
    <p className="text-xs text-kumo-subtle">Hiding only removes this bot from the roster; its routines keep running. Duplicates use the saved profile and start with paused routines and no connected accounts.</p>
    {shareReview && <div className="space-y-2 rounded-lg border border-kumo-line p-3">
      <p className="text-sm">Publish the saved profile, avatar, skill instructions, routine prompts and connector names? Anyone with the link can read and copy them. History, memory, files and credentials are excluded.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={() => void lifecycle('share')}>Publish public bot link</Button>
        <Button variant="secondary" disabled={disabled} onClick={() => setShareReview(false)}>Cancel sharing</Button>
      </div>
    </div>}
    {shareUrl && <div className="space-y-2 text-sm">
      <label className="block">Public bot link
        <input ref={linkInput} aria-label="Public bot link" readOnly value={shareUrl} onFocus={e => e.target.select()} className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void copyLink()}>Copy link</Button>
        {typeof navigator.share === 'function' && <Button variant="secondary" onClick={() => void shareLink()}>Send link</Button>}
        <a href={shareUrl} className="text-kumo-brand">Preview shared bot</a>
      </div>
      <p className="text-xs text-kumo-subtle">Remove the uploaded template from your Templates library to revoke this link.</p>
    </div>}
    {!!agent.pluginIds?.length && <p className="text-xs text-kumo-subtle">Suggested connections: {agent.pluginIds.join(', ')}. Assign your own accounts in bot settings.</p>}
  </section>
}
