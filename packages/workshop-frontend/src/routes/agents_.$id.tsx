import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import type { AgentProfile } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import GadgetEditor from '../GadgetEditor'
import { persistLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'
import { useDocumentTitle } from '../useDocumentTitle'

type ThreadSearch = {
  chat?: number
  w?: number
  pane?: string
}

function parseIntParam(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

/**
 * Flat `/agents/$id` thread. The filename uses a trailing underscore so this is not nested
 * inside the `/agents` roster/redirect page.
 */
export const Route = createFileRoute('/agents_/$id')({
  component: AgentThreadPage,
  validateSearch: (search: Record<string, unknown>): ThreadSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
    pane: typeof search.pane === 'string' ? search.pane : undefined,
  }),
})

function AgentThreadPage() {
  const { id } = Route.useParams()
  const { authenticatedApi } = useAuthenticatedApi()
  const [agent, setAgent] = useState<AgentProfile | null>(null)
  const [missing, setMissing] = useState(false)

  useDocumentTitle(agent?.name)

  useEffect(() => {
    let cancelled = false
    persistLastThread({ kind: 'agent', id })
    authenticatedApi.listAgents()
      .then((agents: AgentProfile[]) => {
        if (cancelled) return
        const found = agents.find((item) => item.id === id) ?? null
        setAgent(found)
        setMissing(found === null)
      })
      .catch((err: unknown) => {
        logRpcFailure('Failed to load agent:', err)
        if (!cancelled) setMissing(true)
      })
    return () => { cancelled = true }
  }, [authenticatedApi, id])

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-kumo-subtle">Bot not found</p>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <GadgetEditor workspaceId={agent.workspaceId} messenger={{ agent }} />
}
