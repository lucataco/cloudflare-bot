import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import type { Group } from '@gadgets/workshop-shared/api'
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

export const Route = createFileRoute('/groups/$id')({
  component: GroupThreadPage,
  validateSearch: (search: Record<string, unknown>): ThreadSearch => ({
    chat: typeof search.chat === 'number' ? search.chat
      : typeof search.chat === 'string' ? Number(search.chat) || undefined
      : undefined,
    w: parseIntParam(search.w),
    pane: typeof search.pane === 'string' ? search.pane : undefined,
  }),
})

function GroupThreadPage() {
  const { id } = Route.useParams()
  const { authenticatedApi } = useAuthenticatedApi()
  const [group, setGroup] = useState<Group | null>(null)
  const [missing, setMissing] = useState(false)

  useDocumentTitle(group?.name)

  useEffect(() => {
    let cancelled = false
    persistLastThread({ kind: 'group', id })
    authenticatedApi.listGroups()
      .then((groups: Group[]) => {
        if (cancelled) return
        const found = groups.find((item) => item.id === id) ?? null
        setGroup(found)
        setMissing(found === null)
      })
      .catch((err: unknown) => {
        logRpcFailure('Failed to load group:', err)
        if (!cancelled) setMissing(true)
      })
    return () => { cancelled = true }
  }, [authenticatedApi, id])

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-kumo-subtle">Group not found</p>
      </div>
    )
  }

  if (!group) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <GadgetEditor workspaceId={group.workspaceId} messenger={{ group }} />
}
