// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import AddModelModal from './AddModelModal'

vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({add: vi.fn<() => void>()}),
}))
const view = makeTestRoot()
afterEach(() => view.cleanup())
async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

it('offers remote agents in gateway mode and preserves their endpoint credentials', async () => {
  const add = vi.fn<AuthenticatedApi['addModel']>().mockResolvedValue(undefined)
  using api = new RpcStub(new class extends RpcTarget {
    addModel(...args: Parameters<AuthenticatedApi['addModel']>) { return add(...args) }
  }() as AuthenticatedApi)
  const success = vi.fn<() => void>()
  await view.render(<AddModelModal visible onCancel={vi.fn<() => void>()} onSuccess={success}
    authenticatedApi={api} aiConfig={{enabled: true, enabledProviders: ['anthropic']}} />)
  await act(async () => document.querySelector<HTMLElement>('[role="combobox"]')!.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(element => element.textContent?.includes('Remote agent (Cap’n Web)'))!
  expect(option).toBeDefined()
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      option.dispatchEvent(new MouseEvent(type, {bubbles: true, button: 0}))
    }
  })
  expect(document.querySelector('[role="combobox"]')?.textContent).toContain('Remote agent')
  expect([...document.querySelectorAll('input')].map(input => input.placeholder)).toContain('e.g., research-agent')
  await fill('input[placeholder="e.g., research-agent"]', 'research-agent')
  await fill('input[placeholder="e.g., Remote researcher"]', 'Research agent')
  await fill('input[placeholder="https://agent.example.com/rpc"]', 'https://agent.example.com/rpc')
  await fill('input[placeholder="(optional bearer token)"]', 'REMOTE_TOKEN')
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Add Model')!.click())
  expect(add).toHaveBeenCalledExactlyOnceWith({type: 'agent', id: 'research-agent', name: 'Research agent'},
    {provider: 'capnweb', model: 'research-agent', apiUrl: 'https://agent.example.com/rpc', apiToken: 'REMOTE_TOKEN'})
  expect(success).toHaveBeenCalledOnce()
})
