// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import type { AdminApi } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import AutoReviewPage from './AutoReviewPage'

const auth = vi.hoisted(() => ({ api: {} }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: auth.api }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
const view = makeTestRoot()
afterEach(() => view.cleanup())

it('shows a deployment lock to users and exposes edits only through the admin capability', async () => {
  const boundaries = [{ vendorId: 'github', tag: 'write' }]
  const save = vi.fn<AdminApi['setAutoReviewBoundaries']>().mockResolvedValue(undefined)
  using admin = new RpcStub(new class extends RpcTarget {
    async getAutoReviewBoundaries() { return boundaries }
    setAutoReviewBoundaries(...args: Parameters<AdminApi['setAutoReviewBoundaries']>) { return save(...args) }
  }())
  let isAdmin = false
  using api = new RpcStub(new class extends RpcTarget {
    async getAutoReviewBoundaries() { return boundaries }
    async listGadgets() { return [] }
    async getAdminApi() { return isAdmin ? admin.dup() : null }
  }())
  auth.api = api
  await view.render(<AutoReviewPage />)
  expect(document.body.textContent).toContain('Ask first · github · write')
  expect(document.querySelector('form')).toBeNull()
  expect(save).not.toHaveBeenCalled()
  isAdmin = true
  await view.render(<AutoReviewPage adminMode />)
  expect(document.querySelector('[aria-label="Deployment review boundaries"]')).not.toBeNull()
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(save).toHaveBeenCalledExactlyOnceWith([...boundaries, { vendorId: null, tag: null }])
});
