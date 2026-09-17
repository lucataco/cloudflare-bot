// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, BlueprintOutput, BlueprintPublicInfo, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import docs from '../../../workshop-backend/format-blueprints/workspace-docs.json'
import BlueprintList from './BlueprintList'
import GadgetList from './GadgetList'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment })

const api = vi.hoisted(() => ({
  listOwnBlueprints: vi.fn<AuthenticatedApi['listOwnBlueprints']>(),
  listLibraryBlueprints: vi.fn<AuthenticatedApi['listLibraryBlueprints']>(),
  importBlueprint: vi.fn<AuthenticatedApi['importBlueprint']>(),
  listGadgets: vi.fn<AuthenticatedApi['listGadgets']>(),
  listFeaturedBlueprints: vi.fn<AuthenticatedApi['listFeaturedBlueprints']>(),
  whoami: vi.fn<AuthenticatedApi['whoami']>(),
}))
const toast = vi.hoisted(() => vi.fn<(toast: unknown) => void>())
vi.mock('../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: toast }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...props }: ComponentProps<'a'> & { to: string; params?: { id: string } }) => (
    <a href={to.replace('$id', params?.id ?? '')} {...props}>{children}</a>
  ),
}))

const owned: BlueprintUserSummary = {
  id: 'blueprint-one', title: 'Gadget Blueprint', description: 'A Blueprint for my Gadget',
  source: { type: 'workspace', workspaceId: 'workspace-one', workspaceTitle: 'My Gadget' },
  version: 1, lastUpdated: new Date('2026-08-24T00:00:00Z'),
}
const featured: BlueprintPublicInfo = {
  id: docs.blueprintId,
  metadata: {
    title: docs.title, description: docs.description,
    output: docs.output as BlueprintOutput,
    author: { type: 'user', id: docs.author.id, name: docs.author.name },
    created: new Date('2026-08-24T00:00:00Z'), lastUpdated: new Date('2026-08-24T00:00:00Z'),
    version: docs.revision, bindings: {},
  },
}

describe('template lists and import journey', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    vi.resetAllMocks()
    api.listOwnBlueprints.mockResolvedValue([])
    api.listLibraryBlueprints.mockResolvedValue([])
    api.importBlueprint.mockResolvedValue('imported-blueprint')
    api.listGadgets.mockResolvedValue([])
    api.listFeaturedBlueprints.mockResolvedValue([])
    api.whoami.mockResolvedValue({ type: 'user', id: 'user', name: 'User' })
  })
  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  async function render(component = <BlueprintList />) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(component))
  }

  it.each([false, true])('offers Import template with secondary archive text (populated=%s)', async populated => {
    api.listOwnBlueprints.mockResolvedValue(populated ? [owned, { ...owned, id: 'untitled', title: '' }] : [])
    await render()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toBe('.gadget')
    expect(input.getAttribute('aria-label')).toBe('Import template archive')
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === 'Import template')!
    expect(button).toBeDefined()
    expect(button.getAttribute('title')).toBe('Import template from a .gadget archive')
    expect(button.nextElementSibling?.textContent).toBe('.gadget archive')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    await act(async () => button.click())
    expect(click).toHaveBeenCalledOnce()

    const stream = new ReadableStream<Uint8Array>()
    const file = Object.assign(new File(['archive'], 'Gadget Blueprint.gadget'), { stream: () => stream })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(api.importBlueprint).toHaveBeenCalledExactlyOnceWith(stream)
    expect(toast).toHaveBeenCalledWith({ title: 'Template uploaded', variant: 'success' })
  })

  it('preserves authored names and template routes while labeling search and actions', async () => {
    api.listOwnBlueprints.mockResolvedValue([owned, { ...owned, id: 'untitled', title: '' }])
    await render()
    expect(document.querySelector('a[href="/blueprint/blueprint-one"]')?.textContent).toContain('Gadget Blueprint')
    expect(document.body.textContent).toContain(owned.description)
    expect(document.body.textContent).toContain('Untitled template')
    expect(document.querySelector('[aria-label="Search templates"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="More template actions"]')).not.toBeNull()
  })

  it('offers templates in the empty state', async () => {
    await render()
    expect(document.body.textContent).toContain('No templates yet')
    expect(document.body.textContent).toContain('Publish an output as a template')
    expect(document.querySelector('a[href="/explore"]')?.textContent).toContain('Explore templates')
  })

  it('uses template copy on list load failure', async () => {
    api.listOwnBlueprints.mockRejectedValue(new Error('failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render()
    expect(document.body.textContent).toContain('Something went wrong loading your templates.')
  })

  it('offers featured templates without changing workspace terminology or destination routes', async () => {
    api.listFeaturedBlueprints.mockResolvedValue(Array.from({ length: 7 }, (_, index) => ({ ...featured, id: `${featured.id}-${index}` })))
    await render(<GadgetList />)
    expect(document.body.textContent).toContain('Your workspaces')
    expect(document.body.textContent).toContain('Start from a featured template.')
    expect(document.querySelector('a[aria-label="Open template Workspace Docs"]')?.getAttribute('href')).toBe('/blueprint/format.document-0')
    expect(document.querySelector('a[href="/explore"]')?.textContent).toContain('Browse all templates')
  })
})
