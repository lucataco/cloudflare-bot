import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AiChatMessage, AiChatMetadata, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { useConnectionLost } from './RpcContext'

type InboxApi = Pick<AuthenticatedApi, 'listGadgets' | 'listOutputs'>

export type BotInboxSummary = {
  kind: 'activity' | 'reply' | 'result' | 'status'
  text: string
  context?: string
  timestamp: number
  live: boolean
}

type Snapshot = {
  status: 'loading' | 'ready' | 'error'
  summaries: ReadonlyMap<string, BotInboxSummary>
}

const EMPTY: Snapshot = { status: 'loading', summaries: new Map() }
const ACTIVITY_FALLBACK = 'Workspace activity'
const stores = new WeakMap<InboxApi, InboxStore>()

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180)
}

/** Only durable, already-loaded data: never prompts, reasoning, tool output or streamed text. */
export function summarizeBotInbox(
  chats: readonly AiChatMetadata[],
  messages: ReadonlyMap<number, readonly (AiChatMessage | undefined)[]>,
): BotInboxSummary | undefined {
  let summary: BotInboxSummary | undefined
  let priority = -1
  const consider = (kind: BotInboxSummary['kind'], text: string, timestamp: Date, rank: number, context?: string) => {
    if (rank > priority || (rank === priority && timestamp.getTime() > summary!.timestamp)) {
      summary = { kind, text, timestamp: timestamp.getTime(), live: true, ...(context ? { context } : {}) }
      priority = rank
    }
  }
  for (const chat of chats) {
    // The server uses "New Chat" until title generation completes.
    const title = chat.title === 'New Chat' ? '' : snippet(chat.title)
    consider('activity', title ? `Chat: ${title}` : ACTIVITY_FALLBACK, chat.lastActive, 0)
    if (chat.hasProposedChanges) consider('status', 'Changes to review', chat.lastActive, 2, title)
    if (chat.activeAgent) consider('status', 'Working', chat.lastActive, 3, title)
    for (const message of messages.get(chat.id) ?? []) {
      if (!message || message.chatId !== chat.id) continue
      if ((message.type === 'action' && message.actionLog?.type === 'action' && message.actionLog.state === 'pending') ||
          (message.type === 'agentProposal' && (message.state === 'pending' || message.state === 'accepting')) ||
          ((message.type === 'connectionRequest' || message.type === 'computerHumanTakeover') &&
            message.state === 'pending')) {
        consider('status', 'Needs approval', message.timestamp, 4, title)
      } else if (message.type === 'message' && message.author.type === 'agent' &&
          message.generatedBySlashCommandSequence === undefined) {
        const text = snippet(message.message)
        if (text) consider('reply', text, message.timestamp, 1, title)
      }
    }
  }
  return summary
}

// Session-only plain data. Neither the store nor its snapshots own any RPC stubs or histories.
class InboxStore {
  snapshot = EMPTY
  indexed = new Map<string, BotInboxSummary>()
  observed = new Map<string, BotInboxSummary>()
  listeners = new Set<() => void>()
  started = false

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = () => this.snapshot

  commit(status = this.snapshot.status) {
    const summaries = new Map(this.indexed)
    for (const [id, summary] of this.observed) {
      const indexed = summaries.get(id)
      // Workspace activity is not a reply/result timestamp. A result keeps its creation time.
      if (!indexed || summary.kind === 'status' || indexed.kind === 'activity' ||
          (summary.kind === 'reply' && summary.timestamp >= indexed.timestamp)) {
        summaries.set(id, summary.kind === 'activity' && summary.text === ACTIVITY_FALLBACK && indexed?.kind === 'activity'
          ? { ...summary, text: indexed.text }
          : summary)
      }
    }
    this.snapshot = { status, summaries }
    for (const listener of this.listeners) listener()
  }

  async load(api: InboxApi) {
    if (this.started) return
    this.started = true
    const [workspaces, outputs] = await Promise.allSettled([api.listGadgets(), api.listOutputs()])
    if (workspaces.status === 'fulfilled') {
      for (const workspace of workspaces.value) {
        const title = snippet(workspace.title)
        this.indexed.set(workspace.id, {
          kind: 'activity', text: title ? `Workspace: ${title}` : ACTIVITY_FALLBACK,
          timestamp: workspace.lastActive.getTime(), live: false,
        })
      }
    }
    if (outputs.status === 'fulfilled') {
      for (const output of outputs.value.outputs) {
        const previous = this.indexed.get(output.workspaceId)
        if (!previous || previous.kind === 'activity' || output.created.getTime() > previous.timestamp) {
          this.indexed.set(output.workspaceId, {
            kind: 'result', text: `Result: ${snippet(output.title) || 'Untitled'}`,
            timestamp: output.created.getTime(), live: false,
          })
        }
      }
    }
    // A partial/unfinished index is not proof that a workspace has no replies or results.
    this.commit(workspaces.status === 'rejected' || outputs.status === 'rejected' ? 'error' : 'ready')
  }

  publish(id: string, summary: BotInboxSummary | undefined) {
    const previous = this.observed.get(id)
    if (previous?.kind === summary?.kind && previous?.text === summary?.text &&
        previous?.context === summary?.context &&
        previous?.timestamp === summary?.timestamp && previous?.live === summary?.live) return
    if (summary) this.observed.set(id, summary)
    else this.observed.delete(id)
    this.commit()
  }

  deactivate(id: string) {
    const previous = this.observed.get(id)
    if (previous?.live) this.publish(id, { ...previous, live: false })
  }
}

function getStore(api: InboxApi): InboxStore {
  let store = stores.get(api)
  if (!store) {
    store = new InboxStore()
    stores.set(api, store)
  }
  return store
}

const subscribeToNothing = () => () => {}
const getEmpty = () => EMPTY

/** One bulk snapshot per authenticated API, shared by all roster instances; no polling. */
export function useBotInboxSummaries(api: InboxApi | null): Snapshot {
  const store = api ? getStore(api) : undefined
  useEffect(() => {
    if (api && store) void store.load(api).catch(() => store.commit('error'))
  }, [api, store])
  return useSyncExternalStore(store?.subscribe ?? subscribeToNothing, store?.getSnapshot ?? getEmpty, getEmpty)
}

/** Reuses ChatInterface's existing cache and connection signals without issuing any RPCs. */
export function usePublishBotInboxSummary(
  api: InboxApi | null,
  workspaceId: string | undefined,
  source: object,
  chats: readonly AiChatMetadata[],
  messages: ReadonlyMap<number, readonly (AiChatMessage | undefined)[]>,
  ready: boolean,
  version: number,
) {
  const connectionLost = useConnectionLost()
  // ChatInterface's cache is mount-owned. Never copy it into a different auth/workspace scope.
  const owner = useRef({ api, workspaceId })
  const session = useRef({ source, chats, refreshed: true })
  const store = api ? getStore(api) : undefined
  useEffect(() => {
    if (!store || !workspaceId) return
    return () => store.deactivate(workspaceId)
  }, [store, workspaceId, source])
  useEffect(() => {
    if (!store || !workspaceId || owner.current.api !== api || owner.current.workspaceId !== workspaceId) return
    if (session.current.source !== source) {
      session.current = { source, chats, refreshed: false }
    } else if (session.current.chats !== chats) {
      session.current = { source, chats, refreshed: true }
    }
    if (!ready || connectionLost || !session.current.refreshed) {
      // Recovery needs fresh chat metadata, not just the socket becoming available again.
      session.current.refreshed = false
      store.deactivate(workspaceId)
      return
    }
    store.publish(workspaceId, summarizeBotInbox(chats, messages))
  }, [api, store, workspaceId, source, chats, messages, ready, version, connectionLost])
}

export function botInboxText(summary: BotInboxSummary): string {
  const text = !summary.context ? summary.text : summary.kind === 'status'
    ? `${summary.text}: ${summary.context}`
    : `${summary.context}: ${summary.text}`
  return summary.live ? text : `Last seen: ${text}`
}

/** Absolute compact time, so an idle roster needs no timer just to keep relative labels honest. */
export function botInboxTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp)
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], {
      month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    })
}
