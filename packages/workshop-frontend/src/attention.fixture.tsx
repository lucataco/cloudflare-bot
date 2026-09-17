// Dev-only visual fixture: no backend session, permission prompt, or real push enrollment.
import { createRoot } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { RpcStub, RpcTarget } from 'capnweb'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import type { AttentionItem, AttentionPage, AttentionSubscriber, AuthenticatedApi, ConnectedAccountsSubscriber, PushSettings } from '@gadgets/workshop-shared/api'
import { AuthProvider } from './AuthContext'
import { AttentionProvider } from './AttentionContext'
import { FeatureFlagsProvider } from './FeatureFlagsContext'
import { ThemeProvider } from './ThemeContext'
import MessengerShell from './components/AppShell/MessengerShell'
import AttentionPageView from './AttentionPage'
import './styles.css'

if (!import.meta.env.DEV) throw new Error('Synthetic fixture is development-only.')

class Fixture extends RpcTarget {
  revision = 0
  subscriber?: RpcStub<AttentionSubscriber>
  entries: AttentionItem[] = ['action', 'proposal', 'run', 'connection', 'human', 'changes'].map((kind, index) => ({
    id: `source-${index}`, sourceId: `source-${index}`, workspaceId: `workspace-${index}`, chatId: 7,
    workspaceTitle: ['Research desk', 'Daily brief', 'Weekly market report', 'Calendar assistant', 'Travel planning', 'Notes'][index],
    kind: kind as AttentionItem['kind'], state: index === 2 ? 'finished' : 'pending',
    version: 1, order: 100 - index, seen: index === 1, updatedAt: new Date('2026-09-08T12:00:00Z'),
  }))
  async whoami() { return { type: 'user', id: 'synthetic-owner', name: 'Synthetic Owner' } }
  async amIAdmin() { return false }
  async getAvatar() { return null }
  async getUiFeatureFlags() { return { agentShell: true } }
  async listAgents() { return [] }
  async listGroups() { return [] }
  async listModels() { return [] }
  async listGadgets() { return [] }
  async listOutputs() { return { outputs: [] } }
  async subscribeConnectedAccounts(subscriber: RpcStub<ConnectedAccountsSubscriber>) {
    await subscriber.ready()
    return new RpcStub(new RpcTarget())
  }
  async getPushSettings(): Promise<PushSettings> {
    return { available: false, devices: [{ id: 'synthetic-device', createdAt: new Date('2026-09-01T12:00:00Z'), delivery: 'accepted' }] }
  }
  async removePushSubscription() {}
  async listAttention(before?: number): Promise<AttentionPage> {
    return {
      entries: before ? this.entries.slice(3) : this.entries.slice(0, 3),
      nextBeforeOrder: before ? undefined : 98,
      unseen: this.entries.filter(entry => !entry.seen).length, catchingUp: true, truncated: true,
    }
  }
  async markAttentionSeen(id: string, version: number) {
    this.entries = this.entries.map(entry => entry.id === id && entry.version === version ? { ...entry, seen: true } : entry)
    await this.subscriber?.changed(++this.revision)
  }
  async subscribeAttention(subscriber: RpcStub<AttentionSubscriber>) {
    this.subscriber = subscriber.dup()
    return new RpcStub(new RpcTarget())
  }
}
const api = new RpcStub(new Fixture()) as unknown as RpcStub<AuthenticatedApi>
const root = createRootRoute({ component: () => (
  <AuthProvider authenticatedApi={api} onLogout={() => {}}>
    <AttentionProvider api={api}><FeatureFlagsProvider><ThemeProvider><TooltipProvider><Toasty>
      <div className="h-dvh"><MessengerShell><AttentionPageView /></MessengerShell></div>
    </Toasty></TooltipProvider></ThemeProvider></FeatureFlagsProvider></AttentionProvider>
  </AuthProvider>
) })
const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/attention'] }), routeTree: root.addChildren([
  createRoute({ getParentRoute: () => root, path: '$', component: () => null }),
]) })
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
