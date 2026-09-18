// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { flushFrames, makeTestRoot } from './action-test-harness'

const auth = vi.hoisted(() => ({ api: {} }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: auth.api }) }))
vi.mock('./SandboxedGatekeeperApp', () => ({
  default: ({ gatekeeperVendorId }: { gatekeeperVendorId: string }) => (
    <div data-testid="hosted-app">{gatekeeperVendorId}</div>
  ),
}))

import GatekeeperAppPage from './GatekeeperAppPage'

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('opens the bot-scoped account when agentId is given', async () => {
  const calls: [string, string | undefined][] = []
  using api = new RpcStub(new class extends RpcTarget {
    async getGatekeeperApp(id: string, agentId?: string) {
      calls.push([id, agentId])
      return null
    }
  }())
  auth.api = api
  await view.render(<GatekeeperAppPage appId="context" agentId="bot-1" />)
  flushFrames()
  expect(calls).toEqual([['context', 'bot-1']])
})

it('opens the user-global account when agentId is omitted', async () => {
  const calls: [string, string | undefined][] = []
  using api = new RpcStub(new class extends RpcTarget {
    async getGatekeeperApp(id: string, agentId?: string) {
      calls.push([id, agentId])
      return null
    }
  }())
  auth.api = api
  await view.render(<GatekeeperAppPage appId="context" />)
  flushFrames()
  expect(calls).toEqual([['context', undefined]])
})
