// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useAuth } from './useAuth'
import { disableBrowserPush, invalidatePushEnrollment, PUSH_DISABLED_MESSAGE, reconcilePushOwner } from './browserPush'

vi.mock('./browserPush', () => ({
  disableBrowserPush: vi.fn<typeof disableBrowserPush>(async () => 'Notifications are off in this browser.'),
  invalidatePushEnrollment: vi.fn<typeof invalidatePushEnrollment>(),
  PUSH_DISABLED_MESSAGE: 'Notifications are off in this browser.',
  reconcilePushOwner: vi.fn<typeof reconcilePushOwner>(async () => {}),
}))

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))

const memoryStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memoryStore.get(key) ?? null,
  setItem: (key: string, value: string) => { memoryStore.set(key, value) },
  removeItem: (key: string) => { memoryStore.delete(key) },
  clear: () => { memoryStore.clear() },
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** A public API whose authenticated stub resolves `whoami` to `author`, or rejects without one. */
function stubPublicApi(author?: AiChatAuthorInfo): RpcStub<PublicApi> {
  const authenticated = {
    whoami: async () => {
      if (!author) throw new Error('session gone')
      return author
    },
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  }
  return {
    authenticate: () => authenticated,
    authenticateFromCfAccess: () => authenticated,
  } as unknown as RpcStub<PublicApi>
}

/**
 * A public API whose `whoami` stays pending until released, for the window in which an answer can
 * arrive after a logout or a newer authentication has superseded it.
 *
 * Each authentication gets its own deferred, so `release(nth, ...)` can answer an earlier lookup
 * after a later one — the ordering a shared promise could not express.
 */
function deferredPublicApi(): {
  api: RpcStub<PublicApi>
  release: (nth: number, author: AiChatAuthorInfo) => void
} {
  const releases: ((author: AiChatAuthorInfo) => void)[] = []
  const authenticate = () => {
    let release: (author: AiChatAuthorInfo) => void = () => {}
    const pending = new Promise<AiChatAuthorInfo>((resolve) => { release = resolve })
    releases.push(release)
    return { whoami: () => pending, [Symbol.dispose]: () => {} }
  }
  return {
    api: { authenticate, authenticateFromCfAccess: authenticate } as unknown as RpcStub<PublicApi>,
    release: (nth, author) => releases[nth](author),
  }
}

type Controls = Pick<ReturnType<typeof useAuth>, 'login' | 'logout' | 'isAuthenticated' | 'pushCleanupNotice'>

describe('useAuth error reporting identity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    memoryStore.clear()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  /** Mounts an independent `useAuth` instance, returning its login/logout handles. */
  async function mount(
    publicApi: RpcStub<PublicApi>,
    hook: typeof useAuth = useAuth,
  ): Promise<{ controls: Controls; getControls: () => Controls; root: Root }> {
    const captured: { controls?: Controls } = {}
    function Consumer() {
      const { login, logout, isAuthenticated, pushCleanupNotice } = hook(publicApi)
      captured.controls = { login, logout, isAuthenticated, pushCleanupNotice }
      return null
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<Consumer />))
    return { controls: captured.controls!, getControls: () => captured.controls!, root }
  }

  it('names the user when a stored token authenticates on mount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user after an inline login with no provider mounted', async () => {
    // The public blueprint page renders outside AuthProvider and logs in through its own useAuth
    // instance. Attaching identity in the provider left that whole session reporting anonymously.
    const { controls } = await mount(stubPublicApi(person))
    expect(setReportedUserId).not.toHaveBeenCalled()

    await act(async () => controls.login('fresh-token'))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user when CF Access authenticates without a token', async () => {
    vi.stubEnv('VITE_CF_ACCESS_MODE', 'true')
    vi.resetModules()
    // Both imports must come from the reset registry, or the assertion would watch a mock instance
    // that the freshly imported hook never calls.
    const { setReportedUserId: setId } = await import('./errorReporting')
    const { useAuth: cfAccessUseAuth } = await import('./useAuth')

    await mount(stubPublicApi(person), cfAccessUseAuth)

    expect(setId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('keeps the identity when one instance unmounts while another stays mounted', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person)
    await mount(api)
    const { root: inner } = await mount(api)

    // The blueprint page nests its own instance inside the root's. Clearing on unmount would let
    // navigating away from that page blank an identity the root still holds.
    act(() => inner.unmount())
    roots.splice(roots.indexOf(inner), 1)

    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
  })

  it('clears the identity on logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))

    await act(async () => { await controls.logout() })

    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
    expect(disableBrowserPush).toHaveBeenCalledWith(expect.objectContaining({ whoami: expect.any(Function) }))
  })

  it('reconciles push ownership without disabling the same owner on a reconnect or unmount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))
    expect(reconcilePushOwner).toHaveBeenCalledWith(person.id, expect.anything(), expect.any(Function))
    expect(disableBrowserPush).not.toHaveBeenCalled()
  })

  it('ignores a lookup that resolves after logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)

    await act(async () => { await controls.logout() })
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)

    // Disposing the stub is not a defence: capnweb does not guarantee that disposal rejects a call
    // already in flight, so a slow lookup could otherwise name a user who has just signed out.
    await act(async () => release(0, person))

    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup superseded by a newer authentication', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)
    await act(async () => controls.login('fresh-token'))

    // The newer authentication supersedes the first lookup, so answering that one last must not let
    // it win. Only the generation distinguishes them; arrival order alone would pick the stale id.
    await act(async () => release(0, { ...person, id: 'stale@example.com' }))
    expect(setReportedUserId).not.toHaveBeenCalledWith('stale@example.com')

    await act(async () => release(1, person))
    expect(setReportedUserId).toHaveBeenLastCalledWith('person@example.com')
  })

  it('does not name a person for an author that is not a user account', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('immediately clears auth/enrollment authority, ignores identity during cleanup, and preserves a newer login', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls, getControls } = await mount(api)
    let finish!: (message: string) => void
    vi.mocked(disableBrowserPush).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    let pending: unknown
    await act(async () => { pending = controls.logout() })
    expect(getControls().isAuthenticated).toBe(false)
    expect(invalidatePushEnrollment).toHaveBeenCalledWith(expect.objectContaining({ whoami: expect.any(Function) }))
    await act(async () => { release(0, { ...person, id: 'old-person' }) })
    expect(setReportedUserId).not.toHaveBeenCalledWith('old-person')
    await act(async () => controls.login('new-token'))
    localStorage.setItem('authToken', 'new-token')
    await act(async () => { release(1, person) })
    await act(async () => { finish('Notifications are off.'); await pending })
    expect(localStorage.getItem('authToken')).toBe('new-token')
    expect(getControls().isAuthenticated).toBe(true)
    expect(setReportedUserId).toHaveBeenLastCalledWith(person.id)
    expect(getControls().pushCleanupNotice).toBeNull()
  })

  it('preserves an asynchronous cleanup warning after auth has been cleared', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls, getControls } = await mount(stubPublicApi(person))
    let finish!: (message: string) => void
    vi.mocked(disableBrowserPush).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    let pending: Promise<void> | undefined
    await act(async () => { pending = controls.logout() })
    expect(getControls().isAuthenticated).toBe(false)
    const warning = 'Notifications are off locally. Browser unsubscribe could not be confirmed; block notifications in browser settings.'
    await act(async () => { finish(warning); await pending })
    expect(getControls().pushCleanupNotice).toBe(warning)
  })

  it('does not discard cleanup failures on account change or let an older warning overwrite newer cleanup', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls, getControls } = await mount(stubPublicApi(person))
    let finish!: (message: string) => void
    vi.mocked(disableBrowserPush).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => controls.login('second-token'))
    expect(invalidatePushEnrollment).toHaveBeenCalled()
    await act(async () => { finish('Browser unsubscribe could not be confirmed.') })
    expect(getControls().pushCleanupNotice).toContain('unsubscribe')
    await act(async () => controls.login('third-token'))
    expect(getControls().pushCleanupNotice).toBeNull()
    vi.mocked(disableBrowserPush).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => controls.login('fourth-token'))
    vi.mocked(disableBrowserPush).mockResolvedValueOnce(PUSH_DISABLED_MESSAGE)
    await act(async () => controls.login('fifth-token'))
    await act(async () => { finish('Old cleanup warning') })
    expect(getControls().pushCleanupNotice).toBeNull()
  })

  it('warns without retaining authentication if cleanup unexpectedly rejects', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls, getControls } = await mount(stubPublicApi(person))
    vi.mocked(disableBrowserPush).mockRejectedValueOnce(new Error('secret endpoint'))
    await act(async () => { await controls.logout() })
    expect(getControls().isAuthenticated).toBe(false)
    expect(getControls().pushCleanupNotice).toContain('Block notifications in browser settings')
    expect(getControls().pushCleanupNotice).not.toContain('secret endpoint')
  })

  it('names nobody when the identity lookup fails', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi())

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('clears a stored invalid session token', async () => {
    localStorage.setItem('authToken', 'stale-token')
    const authenticated = {
      whoami: async () => {
        throw new Error('invalid session token')
      },
      [Symbol.dispose]: () => {},
    }
    const api = {
      authenticate: () => authenticated,
      authenticateFromCfAccess: () => authenticated,
    } as unknown as RpcStub<PublicApi>

    await mount(api)
    await act(async () => {})

    expect(localStorage.getItem('authToken')).toBeNull()
    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
  })
})
