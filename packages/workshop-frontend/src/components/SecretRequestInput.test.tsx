// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import SecretRequestInput from './SecretRequestInput'

const view = makeTestRoot()
afterEach(() => view.cleanup())
it('clears the masked field before delivery and never renders a provider error or the secret', async () => {
  let reject!: (error: Error) => void
  const delivery = new Promise<void>((_resolve, fail) => { reject = fail })
  const submit = vi.fn<Overseer['submitComputerSecret']>().mockReturnValue(delivery)
  using api = new RpcStub(new class extends RpcTarget {
    async getMetadata() { return { id: 'workspace', title: 'Test', role: 'build' as const } }
    submitComputerSecret(id: string, value: string) { return submit(id, value) }
  }() as Overseer)
  await view.render(<SecretRequestInput overseer={api} requestId="request" submitted={false} />)
  const input = document.querySelector('input')!
  expect(input.type).toBe('password')
  input.value = 'SYNTHETIC-SECRET'
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(input.value).toBe('')
  expect(submit).toHaveBeenCalledExactlyOnceWith('request', 'SYNTHETIC-SECRET')
  expect(document.body.textContent).not.toContain('SYNTHETIC-SECRET')
  await act(async () => reject(new Error('provider echoed SYNTHETIC-SECRET')))
  expect(document.body.textContent).not.toContain('SYNTHETIC-SECRET')
  expect(document.querySelector('input')).toBeNull()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm delivery')
})

it('does not solicit a secret from a collaborator', async () => {
  using api = new RpcStub(new class extends RpcTarget {
    async getMetadata() { return { id: 'workspace', title: 'Test', role: 'build' as const, owner: { id: 'other', name: 'Owner', type: 'user' as const } } }
  }() as Overseer)
  await view.render(<SecretRequestInput overseer={api} requestId="request" submitted={false} />)
  expect(document.querySelector('input')).toBeNull()
  expect(document.body.textContent).toContain('Only the workspace owner')
})
