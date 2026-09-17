// Dev-only visual fixture. All reads/writes below are in-memory, with no backend session or tasks.
import { createRoot } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { AgentProfile, NamedDelegationConfig, NamedDelegationReceipt, NamedDelegationResult, Overseer } from '@gadgets/workshop-shared/api'
import DelegationSettings from './components/DelegationSettings'
import NamedDelegationCard from './components/NamedDelegationCard'
import './styles.css'

if (!import.meta.env.DEV) throw new Error('Synthetic fixture is development-only.')

const timestamp = new Date('2026-09-08T12:00:00Z')
const agents: AgentProfile[] = ['Source bot', 'Research helper', 'A target with a longer name for narrow screens'].map((name, index) => ({
  id: `bot-${index}`, name, workspaceId: `workspace-${index}`, title: 'Research', description: '',
  defaultModelId: 'synthetic-model', created: timestamp, updated: timestamp,
}))
let config: NamedDelegationConfig = { revision: 0, targets: [], resources: [
  { id: 1, title: 'Project reports (source-workspace resource)' },
  { id: 2, title: 'Customer research notes with a longer resource title for narrow screens' },
] }
const receipt: NamedDelegationReceipt = { id: 'child-run', parentRunId: 'parent-run', parentChatId: 1, parentAttempt: 1,
  parentSequence: 2, childChatId: 8, targetAgentId: 'bot-1', targetName: agents[1].name }
const result: NamedDelegationResult = { receipt, deleted: false, canceled: false,
  run: { id: receipt.id, chatId: 8, sourceSequence: 0, lastSequence: 2, status: 'waiting', reason: 'action_approval',
    attempt: 1, startedAt: timestamp, updatedAt: timestamp, source: { type: 'delegation' } },
  response: 'An action awaits approval. This response is unverified task output.',
}
const api = { listAgents: async () => agents }
const overseer: Pick<Overseer, 'getNamedDelegationConfig' | 'setNamedDelegationConfig' | 'getNamedDelegation'> = {
  async getNamedDelegationConfig() { return config },
  async setNamedDelegationConfig(targets, expectedRevision) {
    if (expectedRevision !== config.revision) throw new Error('Synthetic revision conflict')
    config = { ...config, targets, revision: config.revision + 1 }
    return config
  },
  async getNamedDelegation(id) { return id === receipt.id ? result : { receipt: deletedReceipt, canceled: true, deleted: true } },
}
const deletedReceipt = { ...receipt, id: 'deleted-child', childChatId: 9, targetName: agents[2].name }
const root = createRootRoute({ component: () => <main className="min-h-dvh bg-kumo-base p-4 text-kumo-default sm:p-8">
  <h1 className="mb-2 text-xl font-semibold">Named delegation: synthetic QA</h1>
  <p className="mb-6 text-sm text-kumo-subtle">No backend connection. Settings saves modify this page's memory only.</p>
  <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
    <div className="min-w-0"><DelegationSettings authenticatedApi={api} overseer={overseer}
      workspaceId="workspace-0" sourceAgentId="bot-0" isOwner /></div>
    <div className="min-w-0 space-y-4">
      <NamedDelegationCard delegation={receipt} result={result} overseer={overseer} workspaceId="workspace-0" />
      <NamedDelegationCard delegation={deletedReceipt} result={{ receipt: deletedReceipt, canceled: true, deleted: true }} overseer={overseer} workspaceId="workspace-0" />
    </div>
  </div>
</main> })
const router = createRouter({ history: createMemoryHistory(), routeTree: root })
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
