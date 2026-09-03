const OAUTH_POPUP_FEATURES = 'popup,width=520,height=680'

/** Open a gatekeeper OAuth window that `window.close()` can dismiss after redirect. */
export function openOAuthPopup(url: string): Window | null {
  return window.open(url, 'gatekeeper-oauth', OAUTH_POPUP_FEATURES)
}
