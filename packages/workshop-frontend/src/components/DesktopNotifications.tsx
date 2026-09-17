import { useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { Bell } from '@phosphor-icons/react'
import { useAttention } from '../AttentionContext'
import { useAuthenticatedApi } from '../AuthContext'

/** Native notifications contain fixed text only and respect the source bot's notification setting. */
export default function DesktopNotifications({ collapsed = false }: { collapsed?: boolean }) {
  const { authenticatedApi: api } = useAuthenticatedApi()
  const attention = useAttention()
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState(false)
  const previous = useRef<Set<string> | null>(null)
  useEffect(() => { setEnabled(false); previous.current = null }, [api])
  useEffect(() => {
    if (!isTauri() || !enabled || !attention.page) { previous.current = null; return }
    const current = new Set(attention.page.entries.map(item => `${item.id}:${item.version}`))
    const fresh = previous.current && attention.page.entries.filter(item => !item.seen && !previous.current!.has(`${item.id}:${item.version}`))
    previous.current = current
    if (!fresh?.length || document.hasFocus()) return
    let cancelled = false
    api.listAgents().then(agents => {
      if (cancelled || !fresh.some(item => !item.agentId || agents.some(agent => agent.id === item.agentId && agent.notifyOnUpdates !== false))) return
      return invoke('notify_attention')
    }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [api, enabled, attention.page])
  if (!isTauri()) return null
  return <div>
    <button type="button" title="Desktop notifications" aria-label="Desktop notifications" aria-pressed={enabled}
      onClick={() => { setEnabled(!enabled); setError(false) }} className="min-h-10 rounded px-3 text-sm text-kumo-subtle hover:bg-kumo-tint">
      {collapsed ? <Bell size={17} /> : enabled ? 'Desktop notifications on' : 'Enable desktop notifications'}
    </button>
    {error && <p role="status" className="px-3 text-xs text-kumo-subtle">Notifications are unavailable. Check system notification settings.</p>}
  </div>
}
