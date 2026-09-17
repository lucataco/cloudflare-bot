import { useState } from 'react'
import { DownloadSimple } from '@phosphor-icons/react'
import { useAppInstall } from '../pwa'

export default function InstallApp({ collapsed = false }: { collapsed?: boolean }) {
  const { available, install } = useAppInstall()
  const [help, setHelp] = useState(false)
  if (available === 'installed') return null
  return <div>
    <button type="button" title="Install app" aria-label="Install app" className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-kumo-subtle hover:bg-kumo-tint"
      onClick={() => { if (available === 'prompt') void install().catch(() => setHelp(true)); else setHelp(!help) }}>
      <DownloadSimple size={17} />{!collapsed && 'Install app'}
    </button>
    {help && <p role="status" className="px-3 py-2 text-xs text-kumo-subtle">On iPhone or iPad, open in Safari, tap Share, then Add to Home Screen. On Android or desktop, use your browser’s Install app menu. An internet connection is required.</p>}
  </div>
}
