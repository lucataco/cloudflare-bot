// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import ImportAgentSeeds from './ImportAgentSeeds'

const toast = vi.hoisted(() => vi.fn<ReturnType<typeof import('@cloudflare/kumo').useKumoToastManager>['add']>())
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(), useKumoToastManager: () => ({add: toast}),
}))
const view = makeTestRoot()
afterEach(() => { view.cleanup(); vi.clearAllMocks() })

async function choose(file: File) {
  const input = document.querySelector('input')!
  Object.defineProperty(input, 'files', {value: [file], configurable: true})
  await act(async () => input.dispatchEvent(new Event('change', {bubbles: true})))
}

it('imports the selected text, blocks competing creation and reports skipped keys without navigation', async () => {
  let finish!: (result: Awaited<ReturnType<AuthenticatedApi['seedAgents']>>) => void
  const seed = vi.fn<AuthenticatedApi['seedAgents']>().mockReturnValue(new Promise(resolve => { finish = resolve }))
  using api = new RpcStub(new class extends RpcTarget { seedAgents(text: string) { return seed(text) } }() as AuthenticatedApi)
  const onSuccess = vi.fn<(id: string, workspaceId: string) => void>()
  const onBusyChange = vi.fn<(busy: boolean) => void>()
  await view.render(<ImportAgentSeeds api={api} disabled={false} onSuccess={onSuccess} onBusyChange={onBusyChange} />)
  const file = new File(['version: 1'], 'agents.yaml')
  Object.defineProperty(file, 'text', {value: async () => 'version: 1'})
  await choose(file)
  expect(seed).toHaveBeenCalledExactlyOnceWith('version: 1')
  expect(onBusyChange).toHaveBeenLastCalledWith(true)
  expect(document.querySelector('button')!.disabled).toBe(true)
  await act(async () => finish({created: [], skipped: ['research']}))
  expect(onBusyChange).toHaveBeenLastCalledWith(false)
  expect(onSuccess).not.toHaveBeenCalled()
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({title: '0 bots created', description: expect.stringContaining('1 existing seed keys skipped')}))
})

it('rejects oversized files before upload', async () => {
  const seed = vi.fn<AuthenticatedApi['seedAgents']>()
  using api = new RpcStub(new class extends RpcTarget { seedAgents(text: string) { return seed(text) } }() as AuthenticatedApi)
  const onBusyChange = vi.fn<(busy: boolean) => void>()
  await view.render(<ImportAgentSeeds api={api} disabled={false} onSuccess={vi.fn<() => void>()} onBusyChange={onBusyChange} />)
  await choose(new File(['x'.repeat(65537)], 'agents.yaml'))
  expect(seed).not.toHaveBeenCalled()
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({variant: 'error'}))
  expect(onBusyChange).toHaveBeenLastCalledWith(false)
})
