import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { classifyRpcError } from './rpcErrors'
import { disableBrowserPush, invalidatePushEnrollment, PUSH_DISABLED_MESSAGE, reconcilePushOwner } from './browserPush'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export { CF_ACCESS_MODE }

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  // Track current authenticated API stub for cleanup on unmount.
  // State closures go stale in cleanup functions, so we use a ref.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi
  const signingOutRef = useRef<object | null>(null)
  const pushCleanupRef = useRef<object | null>(null)
  const [pushCleanupNotice, setPushCleanupNotice] = useState<string | null>(null)

  function cleanupPush(api?: RpcStub<AuthenticatedApi>) {
    const request = {}
    pushCleanupRef.current = request
    setPushCleanupNotice(null)
    // disableBrowserPush duplicates the API before its first await; the auth reference can go now.
    return disableBrowserPush(api).then(message => {
      if (pushCleanupRef.current === request && message !== PUSH_DISABLED_MESSAGE) setPushCleanupNotice(message)
    }, () => {
      if (pushCleanupRef.current === request) setPushCleanupNotice('Notification cleanup could not be completed. Block notifications in browser settings on this shared device.')
    })
  }

  /**
   * Names the signed-in user on error reports, for as long as this stub is the current one.
   *
   * Keyed on the stub rather than called from each authenticate path, so it covers however the
   * session was established — stored token, inline login, or CF Access. This is why the claim lives
   * in the hook and not in `AuthProvider`: the public blueprint page renders outside that provider
   * and logs in inline, so reports from the rest of its session would otherwise name nobody.
   *
   * `whoami` is pipelined rather than awaited, so its answer can outlive the session that asked.
   * The cleanup drops it when the stub is replaced or cleared, which is what stops a logout or a
   * newer login from being overwritten by the previous user. Disposal would not be enough on its
   * own: capnweb does not guarantee that disposing a stub rejects calls already in flight.
   *
   * Nothing is cleared here. Cleanup also runs on unmount, and two instances of this hook can be
   * mounted at once — the blueprint page runs its own inside the root's — so an inner one going
   * away must not blank an identity the outer still holds. `logout` is the only thing that clears.
   */
  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      // Only a real user account names a person: for a gadget author `id` is its owner's id.
      if (!cancelled && !signingOutRef.current && info.type === 'user') {
        setReportedUserId(info.id)
        void reconcilePushOwner(info.id, authenticatedApi, () => !cancelled && !signingOutRef.current).then(message => {
          if (!cancelled && !signingOutRef.current && message && message !== PUSH_DISABLED_MESSAGE) setPushCleanupNotice(message)
        }).catch(() => {
          if (!cancelled && !signingOutRef.current) setPushCleanupNotice('Could not confirm notification cleanup for the previous account. Block notifications in browser settings on this shared device.')
        })
      }
    }).catch((err: unknown) => {
      if (cancelled) return
      if (classifyRpcError(err) === 'auth') logout()
    })
    return () => { cancelled = true }
  }, [authState.authenticatedApi])

  useEffect(() => {
    if (signingOutRef.current) return
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        void cleanupPush()
        setAuthState(prev => ({ ...prev, isLoading: false }))
      }
    }
    return () => {
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      if (authenticatedApiRef.current) {
        invalidatePushEnrollment(authenticatedApiRef.current)
        authenticatedApiRef.current[Symbol.dispose]()
      }
    }
  }, [publicApi])

  const authenticateWithCfAccess = () => {
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return { ...prev, authenticatedApi: null, isLoading: true, error: null }
    })

    // Use promise pipelining - no need to await. The CF Access JWT is already attached
    // to the request by the browser (injected by the Access service worker/cookie), so
    // the server validates it and returns an authenticated stub immediately.
    const authenticatedApi = publicApi.authenticateFromCfAccess()
    setAuthState({
      token: null,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const authenticateWithToken = (token: string) => {
    setAuthState(prev => {
      // Dispose the previous authenticated API stub if it exists
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        ...prev,
        authenticatedApi: null, // Clear the disposed stub
        isLoading: true,
        error: null
      }
    })

    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting. Authentication errors will be handled when the stub is actually used.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const login = (token: string) => {
    signingOutRef.current = null
    if (authenticatedApiRef.current) invalidatePushEnrollment(authenticatedApiRef.current)
    void cleanupPush(authenticatedApiRef.current ?? undefined)
    authenticateWithToken(token)
  }

  const logout = async () => {
    if (signingOutRef.current) return
    const request = {}
    signingOutRef.current = request
    setReportedUserId(undefined)
    if (!CF_ACCESS_MODE) localStorage.removeItem('authToken')
    const api = authenticatedApiRef.current
    if (api) invalidatePushEnrollment(api)
    const cleanup = cleanupPush(api ?? undefined)
    authenticatedApiRef.current = null
    setAuthState({ token: null, authenticatedApi: null, isLoading: false, error: null })
    api?.[Symbol.dispose]()

    // Only the Access navigation waits. The authenticated UI and enrollment authority are gone.
    await cleanup
    if (signingOutRef.current !== request) return // A newer explicit login superseded this logout.
    if (CF_ACCESS_MODE) window.location.assign('/cdn-cgi/access/logout')
  }

  return {
    ...authState,
    login,
    logout,
    pushCleanupNotice,
    isSigningOut: !!signingOutRef.current,
    isAuthenticated: !!authState.authenticatedApi
  }
}
