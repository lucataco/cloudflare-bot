// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { initializePwa } from '../pwa'
import { makeTestRoot } from '../action-test-harness'
import InstallApp from './InstallApp'

const view = makeTestRoot()
afterEach(() => { view.cleanup(); vi.unstubAllGlobals() })

it('uses the browser install prompt once, offers manual installation, and hides after installation', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('isSecureContext', false)
  initializePwa()
  await view.render(<InstallApp />)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Install app"]')!.click())
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Add to Home Screen')

  const prompt = vi.fn<() => Promise<{ outcome: 'dismissed' }>>().mockResolvedValue({ outcome: 'dismissed' })
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt })
  await act(async () => window.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Install app"]')!.click())
  expect(prompt).toHaveBeenCalledOnce()
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Install app"]')!.click())
  expect(prompt).toHaveBeenCalledOnce()

  await act(async () => window.dispatchEvent(new Event('appinstalled')))
  expect(document.querySelector('[aria-label="Install app"]')).toBeNull()
})
