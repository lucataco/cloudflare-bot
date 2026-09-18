// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Overseer, ToolCallAuditEntry, ToolCallAuditPage } from '@gadgets/workshop-shared/api'
import { flushFrames, makeOverseer, makeTestRoot } from '../action-test-harness'
import ToolCallAuditPane from './ToolCallAuditPane'

const view = makeTestRoot()
afterEach(() => { view.cleanup(); vi.restoreAllMocks() })

function entry(id: string, toolName: string): ToolCallAuditEntry {
  return {
    id,
    chatId: 7,
    modelId: 'model',
    recordedAt: new Date('2026-09-08T12:00:00Z'),
    calls: [{ toolCallId: `call-${id}`, toolName }],
  }
}

function button(name: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === name)
  expect(match, `button ${name}`).toBeDefined()
  return match!
}

it('lists the newest records, pages older ones, and shows only tool names', async () => {
  const { overseer } = makeOverseer()
  const listToolCallAudits = vi.fn<Overseer['listToolCallAudits']>()
    .mockResolvedValueOnce({
      entries: [entry('b', 'executeCode'), entry('a', 'setGadgetBinding')],
      nextBeforeSequence: 1,
    } satisfies ToolCallAuditPage)
    .mockResolvedValueOnce({ entries: [entry('z', 'readFile')] } satisfies ToolCallAuditPage)
  Object.assign(overseer, { listToolCallAudits, [Symbol.dispose]: vi.fn<() => void>() })

  await view.render(<ToolCallAuditPane overseer={overseer} chatId={7} />)
  flushFrames()
  expect(listToolCallAudits).toHaveBeenCalledWith(7, undefined)
  expect(document.body.textContent).toContain('executeCode')
  expect(document.body.textContent).toContain('setGadgetBinding')
  expect(document.body.textContent).toContain('Model model')

  await act(async () => { button('Load older').click() })
  flushFrames()
  expect(listToolCallAudits).toHaveBeenLastCalledWith(7, 1)
  expect(document.body.textContent).toContain('readFile')
})

it('shows an empty state when no batches were recorded', async () => {
  const { overseer } = makeOverseer()
  const listToolCallAudits = vi.fn<Overseer['listToolCallAudits']>()
    .mockResolvedValue({ entries: [] } satisfies ToolCallAuditPage)
  Object.assign(overseer, { listToolCallAudits, [Symbol.dispose]: vi.fn<() => void>() })
  await view.render(<ToolCallAuditPane overseer={overseer} chatId={7} />)
  flushFrames()
  expect(document.body.textContent).toContain('No tool calls recorded for this chat yet.')
  expect([...document.querySelectorAll('button')].some(candidate => candidate.textContent?.trim() === 'Load older')).toBe(false)
})
