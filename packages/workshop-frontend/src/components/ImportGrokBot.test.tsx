// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi, BotBlueprintProfile } from '@gadgets/workshop-shared/api'
import { makeTestRoot } from '../action-test-harness'
import ImportGrokBot from './ImportGrokBot'

const view = makeTestRoot()
const bot: BotBlueprintProfile = { name: 'Reader', title: 'Imported Grok bot', description: 'Read sources', skills: [], routines: [], pluginIds: [] }
afterEach(() => view.cleanup())

describe('Grok preview form', () => {
  it('requires a preview click and ignores results arriving after bot creation starts', async () => {
    let resolve!: (profile: BotBlueprintProfile) => void
    const preview = vi.fn<AuthenticatedApi['previewGrokBot']>().mockReturnValue(new Promise(done => { resolve = done }))
    using api = new RpcStub(new class extends RpcTarget {
      previewGrokBot(url: string) { return preview(url) }
    }() as AuthenticatedApi)
    const onPreview = vi.fn<(profile: BotBlueprintProfile) => void>()
    await view.render(<ImportGrokBot api={api} onPreview={onPreview} />)
    const input = document.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://x.ai/bot/abc')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(preview).not.toHaveBeenCalled()
    await act(async () => document.querySelector('button')!.click())
    expect(preview).toHaveBeenCalledExactlyOnceWith('https://x.ai/bot/abc')
    await view.render(<ImportGrokBot api={api} onPreview={onPreview} disabled />)
    await act(async () => resolve(bot))
    expect(onPreview).not.toHaveBeenCalled()
    expect(input.disabled).toBe(true)
    await view.render(<ImportGrokBot api={api} onPreview={onPreview} />)
    await act(async () => document.querySelector('button')!.click())
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(bot)
  })
})
