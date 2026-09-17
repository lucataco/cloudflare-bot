// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { ComputerSession, Overseer } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import ComputerWorkspacePane from './ComputerWorkspacePane'

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('requires the workspace grant and human control before dispatching a shell command', async () => {
  const execute = vi.fn<ComputerSession['workspace']>().mockResolvedValue({ exitCode: 0, stdout: 'done', stderr: '' })
  const enable = vi.fn<Overseer['setComputerWorkspaceAccess']>().mockResolvedValue(undefined)
  using api = new RpcStub(new class extends RpcTarget {
    async getComputerWorkspaceAccess() { return { available: true, enabled: false } }
    setComputerWorkspaceAccess(...args: Parameters<Overseer['setComputerWorkspaceAccess']>) { return enable(...args) }
    async getComputerSession() { return new RpcStub(new class extends RpcTarget {
      workspace(...args: Parameters<ComputerSession['workspace']>) { return execute(...args) }
    }() as ComputerSession) }
  }())
  await view.render(<ComputerWorkspacePane overseer={api} agentId="bot" humanControl={false} />)
  const run = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Run command')!
  expect(run().disabled).toBe(true)
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  expect(enable).toHaveBeenCalledExactlyOnceWith('bot', true)
  expect(run().disabled).toBe(true)
  await view.render(<ComputerWorkspacePane overseer={api} agentId="bot" humanControl />)
  await act(async () => run().click())
  expect(execute).toHaveBeenCalledExactlyOnceWith({ kind: 'exec', command: 'pwd && ls -la' })
  expect(document.body.textContent).toContain('done')
})
