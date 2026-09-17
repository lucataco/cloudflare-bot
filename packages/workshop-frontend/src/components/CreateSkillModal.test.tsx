// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import CreateSkillModal from './CreateSkillModal'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

const api = vi.hoisted(() => ({ createSkill: vi.fn<AuthenticatedApi['createSkill']>() }))
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))

const agent: AgentProfile = {
  id: 'bot-1', name: 'Riley', title: 'Personal assistant', description: '', defaultModelId: null,
  workspaceId: 'workspace-1', created: new Date(0), updated: new Date(0),
}
const draft = {
  name: '  Meeting follow-up  ',
  description: '  After a meeting, organize the notes.\n  ',
  body: '    Preserve this indentation.\n\n1. Summarize decisions.\n   - List owners and due dates.\n\n',
}
const savedSkill: Awaited<ReturnType<AuthenticatedApi['createSkill']>> = {
  id: 'skill-1', slug: 'meeting-follow-up', name: draft.name.trim(), description: draft.description.trim(),
  body: draft.body, created: new Date(0), updated: new Date(0),
}

function button(label: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent) === label)
  expect(matches).toHaveLength(1)
  return matches[0]
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const element = [...document.querySelectorAll('label')].find(candidate => candidate.textContent === label)!
  const control = document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement
  expect(control.getAttribute('aria-labelledby')).toBe(element.id)
  return control
}

async function fill(values = draft) {
  await act(async () => {
    for (const [label, value] of [['Name', values.name], ['When to use', values.description], ['Instructions', values.body]]) {
      const control = field(label)
      const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
      control.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

async function escape() {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

async function clickBackdrop() {
  const backdrop = document.querySelector<HTMLElement>('[role="presentation"][data-open]')!
  expect(backdrop).not.toBeNull()
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      if (type.startsWith('pointer')) Object.assign(event, { pointerType: 'mouse' })
      backdrop.dispatchEvent(event)
    }
  })
}

describe('CreateSkillModal with real Kumo controls', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => { api.createSkill.mockReset().mockResolvedValue(savedSkill) })
  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  async function render() {
    const onClose = vi.fn<() => void>()
    const onCreated = vi.fn<() => void>()
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" onClick={() => setOpen(true)}>Add skill</button>
        {open && <CreateSkillModal agent={agent} onClose={() => { onClose(); setOpen(false) }} onCreated={() => { onCreated(); setOpen(false) }} />}
      </>
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Harness />))
    const trigger = button('Add skill')
    await act(async () => { trigger.focus(); trigger.click() })
    // Kumo schedules initial focus on the next animation frame.
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    return { onClose, onCreated, trigger, dialog: document.querySelector<HTMLElement>('[role="dialog"]')! }
  }

  it('labels the dialog and fields, with a solid responsive panel and footer outside the scroll body', async () => {
    const { dialog } = await render()
    expect(dialog).not.toBeNull()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Create skill')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('reusable instructions')
    for (const token of ['responsive-dialog', '!top-[clamp(28px,10vh,96px)]', '!flex', 'flex-col', 'overflow-hidden', 'bg-kumo-base', '!-translate-y-0']) {
      expect(dialog.classList.contains(token)).toBe(true)
    }
    const controls = ['Name', 'When to use', 'Instructions'].map(field)
    expect(new Set(controls.map(control => control.id)).size).toBe(3)
    expect(controls.every(control => control.required && control.value === '')).toBe(true)
    expect(controls[0].placeholder).toBe('Meeting follow-up')
    expect(document.getElementById(controls[2].getAttribute('aria-describedby')!)?.textContent).toContain('Markdown formatting is optional')
    const scrollBody = dialog.querySelector('.overflow-y-auto')!
    expect(controls.every(control => scrollBody.contains(control))).toBe(true)
    expect(scrollBody.contains(button('Create skill'))).toBe(false)
    expect(button('Create skill').parentElement?.classList.contains('shrink-0')).toBe(true)
    expect(button('Create skill').parentElement?.classList.contains('bg-kumo-base')).toBe(true)
    expect(api.createSkill).not.toHaveBeenCalled()
  })

  it.each(['Escape', 'Cancel', 'Close skill', 'backdrop click'])('moves focus into the dialog and restores it after %s without creating', async dismissal => {
    const { dialog, trigger, onClose, onCreated } = await render()
    expect(dialog.contains(document.activeElement)).toBe(true)
    await fill()
    expect(api.createSkill).not.toHaveBeenCalled()
    if (dismissal === 'Escape') await escape()
    else if (dismissal === 'backdrop click') await clickBackdrop()
    else await act(async () => button(dismissal).click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
    expect(onCreated).not.toHaveBeenCalled()
    expect(api.createSkill).not.toHaveBeenCalled()
  })

  it.each([
    [{ name: '', description: '', body: '' }, 'Name is required'],
    [{ ...draft, name: '   ' }, 'Name is required'],
    [{ ...draft, description: '\n  ' }, 'When to use is required'],
    [{ ...draft, body: '\n  ' }, 'Instructions are required'],
  ])('validates empty fields without an RPC (%s)', async (values, message) => {
    const { onClose, onCreated } = await render()
    await fill(values)
    await act(async () => button('Create skill').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message)
    expect(api.createSkill).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('creates only on submit, trimming name and when-to-use but preserving exact Markdown instructions', async () => {
    const { onClose, onCreated, trigger } = await render()
    await fill()
    await act(async () => { field('Instructions').focus(); field('Instructions').blur() })
    expect(api.createSkill).not.toHaveBeenCalled()
    await act(async () => button('Create skill').click())
    expect(api.createSkill).toHaveBeenCalledExactlyOnceWith(agent.id, draft.name.trim(), draft.description.trim(), draft.body)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('blocks dismissal and double submission until the pending create finishes', async () => {
    let resolve!: (value: typeof savedSkill) => void
    api.createSkill.mockReturnValue(new Promise(next => { resolve = next }))
    const { dialog, onClose, onCreated } = await render()
    await fill()
    const submit = button('Create skill')
    await act(async () => { submit.click(); submit.click() })
    expect(api.createSkill).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector('form')?.getAttribute('aria-busy')).toBe('true')
    for (const label of ['Close skill', 'Cancel', 'Creating...']) expect(button(label).disabled).toBe(true)
    for (const label of ['Name', 'When to use', 'Instructions']) expect(field(label).disabled).toBe(true)
    await act(async () => {
      button('Close skill').click()
      button('Cancel').click()
      dialog.querySelector('form')!.requestSubmit()
    })
    await escape()
    await clickBackdrop()
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    expect(api.createSkill).toHaveBeenCalledTimes(1)
    await act(async () => resolve(savedSkill))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('announces failure, preserves all fields and allows an explicit retry', async () => {
    api.createSkill.mockRejectedValueOnce(new Error('Could not save the skill. Try again.'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { dialog, onClose, onCreated } = await render()
    await fill()
    await act(async () => button('Create skill').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not save the skill. Try again.')
    expect(field('Name').value).toBe(draft.name)
    expect(field('When to use').value).toBe(draft.description)
    expect(field('Instructions').value).toBe(draft.body)
    for (const label of ['Name', 'When to use', 'Instructions']) expect(field(label).disabled).toBe(false)
    for (const label of ['Close skill', 'Cancel', 'Create skill']) expect(button(label).disabled).toBe(false)
    expect(dialog.querySelector('form')?.getAttribute('aria-busy')).toBe('false')
    expect(onClose).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
    await act(async () => button('Create skill').click())
    expect(api.createSkill).toHaveBeenCalledTimes(2)
    expect(api.createSkill).toHaveBeenLastCalledWith(agent.id, draft.name.trim(), draft.description.trim(), draft.body)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith()
  })
})
