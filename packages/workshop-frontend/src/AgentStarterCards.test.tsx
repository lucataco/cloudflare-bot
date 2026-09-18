// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTestRoot } from './action-test-harness'
import AgentStarterCards from './components/AgentStarterCards'

const view = makeTestRoot()

afterEach(() => view.cleanup())

it('seeds only the selected prompt', async () => {
  const onSelect = vi.fn<(starter: string) => void>()
  await view.render(<AgentStarterCards starters={['Plan my day', 'Summarize my week']} onSelect={onSelect} />)
  const buttons = [...document.querySelectorAll('button')]
  expect(buttons.map(candidate => candidate.textContent)).toEqual(['Plan my day', 'Summarize my week'])
  await act(async () => { buttons[1].click() })
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('Summarize my week')
})
