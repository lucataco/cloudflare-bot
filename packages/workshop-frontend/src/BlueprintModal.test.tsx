// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BlueprintGadgetSummary, GadgetClient, Overseer } from '@gadgets/workshop-shared/api'
import BlueprintModal from './BlueprintModal'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

const toast = vi.hoisted(() => vi.fn<(toast: unknown) => void>())
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toast }),
}))

const blueprint: BlueprintGadgetSummary = {
  id: 'blueprint-one', title: 'Gadget Blueprint', description: 'My Blueprint for Gadgets',
  version: 1, codeVersionDate: new Date('2026-08-24T00:00:00Z'),
  screenshotUrl: 'https://example.com/blueprint-screenshot/one', dirty: true,
}
const overseer = {
  listBlueprints: vi.fn<Overseer['listBlueprints']>(),
  updateBlueprint: vi.fn<Overseer['updateBlueprint']>(),
  deleteBlueprint: vi.fn<Overseer['deleteBlueprint']>(),
  retryBlueprintPublish: vi.fn<Overseer['retryBlueprintPublish']>(),
}
const gadget = {
  listBindings: vi.fn<GadgetClient['listBindings']>(),
  createBlueprint: vi.fn<GadgetClient['createBlueprint']>(),
}

function button(label: string): HTMLButtonElement {
  const matches = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .filter(element => (element.getAttribute('aria-label') ?? element.textContent)?.startsWith(label))
  expect(matches).toHaveLength(1)
  return matches[0]
}

describe('template publication', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    vi.resetAllMocks()
    overseer.listBlueprints.mockResolvedValue([])
    gadget.listBindings.mockResolvedValue([])
    gadget.createBlueprint.mockResolvedValue(blueprint)
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<BlueprintModal
      open onClose={() => {}}
      overseer={overseer as unknown as RpcStub<Overseer>}
      gadget={gadget as unknown as RpcStub<GadgetClient>}
      metadata={{ id: 'workspace-one', title: 'Gadget Blueprint' }}
    />))
  }

  it('publishes an output as a template, preserving the authored title', async () => {
    await render()
    expect(document.body.textContent).toContain('Templates')
    expect(document.body.textContent).toContain('Turn this output into a reusable starting point.')
    expect(document.body.textContent).toContain('No templates yet.')
    expect(button('Create template').textContent).toContain('Publish this output as a reusable template.')
    await act(async () => button('Create template').click())

    expect(document.querySelector<HTMLInputElement>('[aria-label="Template title"]')?.value).toBe('Gadget Blueprint')
    expect(document.querySelector('[aria-label="Template description"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Describe what people get when they start from this template.')
    expect(document.body.textContent).not.toContain('Create output')
    await act(async () => button('Create template').click())

    expect(gadget.createBlueprint).toHaveBeenCalledExactlyOnceWith('Gadget Blueprint', undefined, undefined)
    expect(toast).toHaveBeenCalledWith({ title: 'Template created.', variant: 'success' })
  })

  it('edits template details without rewriting authored text', async () => {
    overseer.listBlueprints.mockResolvedValue([blueprint])
    await render()
    expect(document.body.textContent).toContain('Existing templates')
    await act(async () => button('Edit template').click())
    expect(document.querySelector<HTMLInputElement>('[aria-label="Template title"]')?.value).toBe(blueprint.title)
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Template description"]')?.value).toBe(blueprint.description)
    expect(document.querySelector('img')?.alt).toBe('Template screenshot preview')
    expect(document.body.textContent).toContain('template detail page')
    await act(async () => button('Save').click())

    expect(overseer.updateBlueprint).toHaveBeenCalledExactlyOnceWith(blueprint.id, {
      title: blueprint.title, description: blueprint.description, updateBindings: true, screenshot: undefined,
    })
    expect(toast).toHaveBeenCalledWith({ title: 'Template updated.', variant: 'success' })
  })

  it('explains that deleting a template leaves existing outputs unaffected', async () => {
    overseer.listBlueprints.mockResolvedValue([blueprint])
    await render()
    await act(async () => button('Delete template').click())
    expect(document.body.textContent).toContain('Delete "Gadget Blueprint"?')
    expect(document.body.textContent).toContain("People who created an output from this template won't be affected, but the link will stop working.")
    await act(async () => button('Delete').click())
    expect(overseer.deleteBlueprint).toHaveBeenCalledExactlyOnceWith(blueprint.id)
    expect(toast).toHaveBeenCalledWith({ title: 'Template deleted.', variant: 'success' })
  })

  it('uses template copy for code updates and publication retries', async () => {
    overseer.listBlueprints.mockResolvedValue([blueprint])
    await render()
    await act(async () => button('Update code').click())
    expect(overseer.updateBlueprint).toHaveBeenCalledExactlyOnceWith(blueprint.id, { updateCode: true })
    expect(toast).toHaveBeenCalledWith({ title: 'Template updated to current code.', variant: 'success' })
    await act(async () => button('Retry publish').click())
    expect(overseer.retryBlueprintPublish).toHaveBeenCalledExactlyOnceWith(blueprint.id)
    expect(toast).toHaveBeenCalledWith({ title: 'Template published successfully.', variant: 'success' })
  })

  it.each([
    ['', 'Could not create template.'],
    ['Blueprint service rejected Gadget Blueprint', 'Blueprint service rejected Gadget Blueprint'],
  ])('changes only the publication-error fallback, not upstream copy (%s)', async (message, expected) => {
    gadget.createBlueprint.mockRejectedValue(new Error(message))
    await render()
    await act(async () => button('Create template').click())
    await act(async () => button('Create template').click())
    expect(document.body.textContent).toContain(expected)
  })

  it('uses template copy for the load failure toast', async () => {
    overseer.listBlueprints.mockRejectedValue(new Error('failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    expect(toast).toHaveBeenCalledWith({ title: 'Failed to load templates', variant: 'error' })
  })
})
