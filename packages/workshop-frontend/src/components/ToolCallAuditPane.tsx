import { useCallback, useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, ToolCallAuditEntry } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../rpcErrors'

function formatRecordedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString()
}

function ToolCallAuditRow({ entry }: { entry: ToolCallAuditEntry }) {
  return (
    <article className="border-b border-kumo-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className="text-[12px] font-medium tracking-[-0.15px] text-kumo-default">
          {entry.calls.length} {entry.calls.length === 1 ? 'tool call' : 'tool calls'}
        </span>
        <span className="text-[11.5px] text-kumo-inactive">{formatRecordedAt(entry.recordedAt)}</span>
      </div>
      <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0">
        {entry.calls.map((call) => (
          <li
            key={call.toolCallId}
            className="rounded-md bg-kumo-tint px-2 py-0.5 font-mono text-[11.5px] leading-5 text-kumo-default"
          >
            {call.toolName}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1 text-[11.5px] leading-4 text-kumo-inactive">
        Model {entry.modelId}
        {entry.execution && ` · run ${entry.execution.id} · attempt ${entry.execution.attempt}`}
      </p>
    </article>
  )
}

/**
 * Read-only view of the workspace's append-only pre-dispatch tool-call evidence for one chat.
 * Records prove a batch was admitted for dispatch, not that any tool ran or succeeded, and they
 * never include arguments, results, prompts or credentials.
 */
export default function ToolCallAuditPane({
  overseer,
  chatId,
}: {
  overseer: RpcStub<Overseer>
  chatId: number
}) {
  const [entries, setEntries] = useState<ToolCallAuditEntry[]>([])
  const [nextBefore, setNextBefore] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (before?: number) => {
    setLoading(true)
    setFailed(false)
    try {
      const page = await overseer.listToolCallAudits(chatId, before)
      setEntries(previous => before === undefined ? page.entries : [...previous, ...page.entries])
      setNextBefore(page.nextBeforeSequence)
    } catch (err) {
      logRpcFailure('Failed to load tool-call audit:', err)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [overseer, chatId])

  useEffect(() => { void load() }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-kumo-line px-4 py-3">
        <h2 className="m-0 text-[13px] font-medium text-kumo-default">Tool-call audit</h2>
        <p className="m-0 mt-1 text-[12px] leading-4 text-kumo-subtle">
          Pre-dispatch evidence that a model step proposed a tool batch. Names only — never arguments,
          results, prompts or credentials. Admission is not proof that a tool ran or succeeded.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {entries.length === 0 && !loading && !failed && (
          <p className="py-6 text-center text-[12px] text-kumo-inactive">
            No tool calls recorded for this chat yet.
          </p>
        )}
        {entries.map((entry) => <ToolCallAuditRow key={entry.id} entry={entry} />)}
        {failed && (
          <p className="py-3 text-center text-[12px] text-kumo-inactive">
            Could not load the audit log.
          </p>
        )}
        {loading && (
          <p className="py-3 text-center text-[12px] text-kumo-inactive">Loading…</p>
        )}
        {nextBefore !== undefined && !loading && (
          <div className="flex justify-center py-3">
            <button
              type="button"
              onClick={() => void load(nextBefore)}
              className="min-h-9 cursor-pointer rounded-md border border-kumo-line px-3 text-[12.5px] font-medium text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring"
            >
              Load older
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
