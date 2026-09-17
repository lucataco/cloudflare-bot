// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import CreateRoutineModal from './CreateRoutineModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const api = vi.hoisted(() => ({ createRoutine: vi.fn<AuthenticatedApi['createRoutine']>() }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))

describe('routine dialog with real Kumo controls', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('labels the form, keeps the footer outside the scroll body, and requires confirmation', async () => {
    const agent: AgentProfile = {
      id: 'bot-1', name: 'Riley', title: 'Research assistant', description: '', defaultModelId: null,
      workspaceId: 'workspace-1', created: new Date(0), updated: new Date(0),
    }
    const onClose = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<CreateRoutineModal agent={agent} initialName="Issue review" initialPrompt="Review new issues." onCreated={() => {}} onClose={onClose} />))

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Create routine')
    expect(dialog.classList.contains('responsive-dialog')).toBe(true)
    expect(dialog.classList.contains('!flex')).toBe(true)
    const input = dialog.querySelector('input')!
    expect(dialog.querySelector(`label[for="${input.id}"]`)?.textContent).toBe('Routine name')
    expect(input.value).toBe('Issue review')
    const selects = dialog.querySelectorAll('[role="combobox"]')
    expect(selects).toHaveLength(2)
    expect(selects[0].textContent).toBe('Interval')
    expect(selects[1].textContent).toBe('Starts enabled')

    const review = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Review routine')!
    const scrollBody = dialog.querySelector('.overflow-y-auto')!
    expect(scrollBody.contains(input)).toBe(true)
    expect(scrollBody.contains(review)).toBe(false)
    expect(review.parentElement?.classList.contains('shrink-0')).toBe(true)
    await act(async () => review.click())
    expect(dialog.textContent).toContain('Confirm and enable')
    expect(api.createRoutine).not.toHaveBeenCalled()

    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close routine"]')!.click())
    expect(onClose).toHaveBeenCalledOnce()
  })
})
