// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestRoot } from '../action-test-harness'
import BotThreadHeader from './BotThreadHeader'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const view = makeTestRoot()
const onInspectorChange = vi.fn<ComponentProps<typeof BotThreadHeader>['onInspectorChange']>()
const onOpenActivity = vi.fn<ComponentProps<typeof BotThreadHeader>['onOpenActivity']>()
const agent = {
  id: 'bot', name: 'Research bot', title: 'Research assistant', description: '',
  workspaceId: 'workspace', defaultModelId: null, created: new Date(), updated: new Date(),
}

function renderHeader(props: Partial<ComponentProps<typeof BotThreadHeader>> = {}) {
  return view.render(
    <BotThreadHeader
      agent={agent}
      inspector="none"
      onInspectorChange={onInspectorChange}
      onOpenActivity={onOpenActivity}
      overseer={null}
      reconnecting={false}
      {...props}
    />,
  )
}

async function click(label: string) {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === label)
  expect(element).toBeDefined()
  await act(async () => { element!.click() })
}

afterEach(() => {
  view.cleanup()
  vi.clearAllMocks()
})

describe('BotThreadHeader', () => {
  it('keeps the bot identity and toggles the files inspector through labelled Results', async () => {
    await renderHeader({ reconnecting: true })
    expect(document.body.textContent).toContain(agent.name)
    expect(document.body.textContent).toContain(agent.title)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Reconnecting')
    expect(document.querySelector('[aria-label="Results"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[role="menuitem"]')).toBeNull()

    await click('Results')
    expect(onInspectorChange).toHaveBeenLastCalledWith('files')
    await renderHeader({ inspector: 'files' })
    expect(document.querySelector('[aria-label="Results"]')?.getAttribute('aria-pressed')).toBe('true')
    await click('Results')
    expect(onInspectorChange).toHaveBeenLastCalledWith('none')
  })

  it('keeps every secondary inspector reachable and toggleable from More', async () => {
    const actions = [
      ['App preview', 'gadget'], ['Computer', 'computer'], ['Skills', 'skills'],
      ['Memory', 'memory'], ['Routines', 'routines'], ['Bot settings', 'settings'],
    ] as const

    for (const [label, inspector] of actions) {
      await renderHeader()
      await click('More')
      expect(document.querySelector('[aria-label="More"]')?.getAttribute('aria-expanded')).toBe('true')
      await click(label)
      expect(onInspectorChange).toHaveBeenLastCalledWith(inspector)
      expect(document.querySelector('[aria-label="More"]')?.getAttribute('aria-expanded')).toBe('false')

      await renderHeader({ inspector })
      await click('More')
      await click(label)
      expect(onInspectorChange).toHaveBeenLastCalledWith('none')
    }
    await click('More')
    await click('Activity history')
    expect(onOpenActivity).toHaveBeenCalledWith('history')
  })

  it('preserves group identity and excludes bot-only inspectors from the menu', async () => {
    await renderHeader({
      agent: undefined,
      group: {
        id: 'group', name: 'Research team', memberAgentIds: ['a', 'b'],
        workspaceId: 'group-workspace', created: new Date(), updated: new Date(),
      },
    })
    expect(document.body.textContent).toContain('Research team')
    expect(document.body.textContent).toContain('2 members')
    await click('Results')
    expect(onInspectorChange).toHaveBeenCalledWith('files')
    await click('More')
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()))
      .toEqual(['App preview', 'Activity history'])
    await click('Activity history')
    expect(onOpenActivity).toHaveBeenCalledWith('history')
  })

  it('opens More from the keyboard and dismisses it with Escape', async () => {
    await renderHeader()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More"]')!
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu).not.toBeNull()
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
