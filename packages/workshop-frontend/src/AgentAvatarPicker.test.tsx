// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTestRoot } from './action-test-harness'
import AgentAvatarPicker from './components/AgentAvatarPicker'

const view = makeTestRoot()

afterEach(() => view.cleanup())

async function chooseFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve)) })
}

describe('AgentAvatarPicker', () => {
  it('reads a chosen PNG into an inline data URL', async () => {
    const onChange = vi.fn<(avatar: { url: string } | null) => void>()
    await view.render(<AgentAvatarPicker onChange={onChange} />)
    await chooseFile(new File([new Uint8Array([1, 2, 3])], 'bot.png', { type: 'image/png' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ url: 'data:image/png;base64,AQID' })
  })

  it('rejects unsupported types and oversized files without calling onChange', async () => {
    const onChange = vi.fn<(avatar: { url: string } | null) => void>()
    await view.render(<AgentAvatarPicker onChange={onChange} />)
    await chooseFile(new File(['x'], 'bot.txt', { type: 'text/plain' }))
    expect(document.body.textContent).toContain('Choose a PNG, JPEG, or WebP image.')
    await chooseFile(new File([new Uint8Array(65 * 1024)], 'big.png', { type: 'image/png' }))
    expect(document.body.textContent).toContain('Images must be 64 KB or smaller.')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes an existing photo', async () => {
    const onChange = vi.fn<(avatar: { url: string } | null) => void>()
    await view.render(<AgentAvatarPicker avatar={{ url: 'data:image/png;base64,AQID' }} onChange={onChange} />)
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
    await act(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove')!.click()
    })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null)
  })
})
