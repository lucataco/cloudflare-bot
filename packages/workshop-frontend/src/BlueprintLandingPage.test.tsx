// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintOutput,
  BlueprintPublicInfo,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import docs from '../../workshop-backend/format-blueprints/workspace-docs.json'
import slides from '../../workshop-backend/format-blueprints/workspace-slides.json'
import sheets from '../../workshop-backend/format-blueprints/workspace-sheets.json'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as RpcStub<AuthenticatedApi> | null,
  isAuthenticated: true,
  id: 'blueprint-one',
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn<() => void>(),
  useParams: () => ({ id: testState.id }),
  useRouter: () => ({ history: { back: vi.fn<() => void>(), canGoBack: () => false } }),
}))

vi.mock('./useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: testState.isAuthenticated,
    authenticatedApi: testState.authenticatedApi,
    isLoading: false,
    login: vi.fn<(token: string) => void>(),
  }),
}))

vi.mock('./LoginPage', () => ({ default: () => <div>Template journey login</div> }))

import BlueprintLandingPage from './BlueprintLandingPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const originalInnerWidth = window.innerWidth

const MODEL: AiChatAuthorInfo = {
  type: 'agent',
  id: 'model-one',
  name: 'Model one',
}

const BLUEPRINT: BlueprintPublicInfo = {
  id: 'blueprint-one',
  metadata: {
    title: 'Model blueprint',
    description: 'Requires an AI model.',
    author: { type: 'user', id: 'author', name: 'Author' },
    created: new Date('2026-08-24T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-08-24T00:00:00Z'),
    bindings: {
      AI: {
        type: 'aiModel',
        title: 'Claude Sonnet 5',
        description: '',
      },
    },
  },
}

function subscription() {
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), {
    [Symbol.dispose]() {},
  })
}

function authenticatedApi(overrides: Partial<AuthenticatedApi> = {}): RpcStub<AuthenticatedApi> {
  return {
    listModels: async () => [MODEL],
    listGatekeeperVendors: async () => [],
    subscribeConnectedAccounts: subscription,
    getAdminApi: async () => null,
    isBlueprintInLibrary: async () => null,
    isBlueprintPinned: async () => false,
    getOwnBlueprint: async () => null,
    ...overrides,
  } as unknown as RpcStub<AuthenticatedApi>
}

function publicApi(blueprint: BlueprintPublicInfo | null = BLUEPRINT, overrides: Partial<PublicApi> = {}): RpcStub<PublicApi> {
  return {
    getBlueprint: async () => blueprint,
    ...overrides,
  } as unknown as RpcStub<PublicApi>
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button'))
    .find(candidate => candidate.textContent === label)
}

const FORMAT_CASES: { name: string; output: BlueprintOutput | undefined; noun: string }[] = [
  { name: 'Doc', output: docs.output as BlueprintOutput, noun: 'document' },
  { name: 'Slides', output: slides.output as BlueprintOutput, noun: 'slides' },
  { name: 'Sheet', output: sheets.output as BlueprintOutput, noun: 'sheet' },
  { name: 'custom noun', output: { id: 'document', noun: 'Contract', plural: 'Contracts', icon: 'fileText' }, noun: 'contract' },
  { name: 'App', output: { id: 'app', noun: 'App', plural: 'Apps', icon: 'appWindow' }, noun: 'app' },
  { name: 'missing format', output: undefined, noun: 'app' },
  // A newer deployment can declare an icon the cached frontend does not know yet.
  { name: 'unknown icon', output: { ...docs.output, icon: 'futureIcon' as BlueprintOutput['icon'] }, noun: 'app' },
]

describe('BlueprintLandingPage template journey', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    rootContainer?.remove()
    testState.authenticatedApi = null
    testState.isAuthenticated = true
    testState.id = 'blueprint-one'
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  async function render(rpcStub = publicApi()) {
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={rpcStub} />))
    await act(async () => { await Promise.resolve() })
  }

  it('previews a bot and installs it with the recipient model, without creating a gadget', async () => {
    const newAgentFromBlueprint = vi.fn<AuthenticatedApi['newAgentFromBlueprint']>().mockResolvedValue({
      id: 'new-bot', workspaceId: 'fresh', name: 'Writer', title: 'Editor', description: '',
      defaultModelId: MODEL.id, created: new Date(), updated: new Date(),
    })
    const newGadgetFromBlueprint = vi.fn<AuthenticatedApi['newGadgetFromBlueprint']>()
    testState.isAuthenticated = true
    testState.authenticatedApi = authenticatedApi({ newAgentFromBlueprint, newGadgetFromBlueprint })
    await render(publicApi({ ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, bindings: {}, bot: {
      name: 'Writer', title: 'Editor', description: 'Use plain words', skills: [{name: 'Edit', description: 'Polish', body: 'Remove jargon'}],
      routines: [], pluginIds: ['google'],
    } } }))
    expect(document.querySelector('[aria-label="Bot profile"]')?.textContent).toContain('Use plain words')
    expect(document.body.textContent).toContain('installed paused')
    expect(document.body.textContent).not.toContain('This template can create an output')
    const model = document.querySelector<HTMLSelectElement>('[aria-label="Bot default model"]')!
    await act(async () => { model.value = MODEL.id; model.dispatchEvent(new Event('change', {bubbles: true})) })
    await act(async () => button('Add to my bots')!.click())
    expect(newAgentFromBlueprint).toHaveBeenCalledWith('blueprint-one', MODEL.id)
    expect(newGadgetFromBlueprint).not.toHaveBeenCalled()
  })

  it('keeps the current share preview when an older route finishes loading later', async () => {
    let resolveFirst!: (value: BlueprintPublicInfo) => void
    const first = new Promise<BlueprintPublicInfo>(resolve => { resolveFirst = resolve })
    const second = { ...BLUEPRINT, id: 'blueprint-two', metadata: { ...BLUEPRINT.metadata, title: 'Current bot', bindings: {}, bot: {
      name: 'Current bot', title: 'Editor', description: 'Current instructions', skills: [], routines: [], pluginIds: [],
    } } }
    const api = publicApi(null, { getBlueprint: async id => id === 'blueprint-one' ? first : second })
    testState.authenticatedApi = authenticatedApi()
    await render(api)
    testState.id = 'blueprint-two'
    await act(async () => root!.render(<BlueprintLandingPage rpcStub={api} />))
    expect(document.querySelector('h1')?.textContent).toBe('Current bot')
    await act(async () => resolveFirst(BLUEPRINT))
    expect(document.querySelector('h1')?.textContent).toBe('Current bot')
    expect(button('Add to my bots')).toBeDefined()
  })

  it('offers the signed-out bot landing flow without allocating a bot', async () => {
    testState.isAuthenticated = false
    await render(publicApi({ ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, bot: {
      name: 'Writer', title: 'Editor', description: 'Use plain words', skills: [], routines: [], pluginIds: [],
    } } }))
    expect(document.querySelector('[aria-label="Bot profile"]')?.textContent).toContain('Use plain words')
    await act(async () => button('Log in to add to my bots')!.click())
    expect(document.body.textContent).toContain('Template journey login')
  })

  describe.each([true, false])('authenticated=%s', (isAuthenticated) => {
    it.each(FORMAT_CASES)('uses the declared noun for $name, not the template title or ID', async ({ output, noun }) => {
      testState.isAuthenticated = isAuthenticated
      testState.authenticatedApi = isAuthenticated ? authenticatedApi() : null
      const blueprint: BlueprintPublicInfo = {
        ...BLUEPRINT,
        metadata: { ...BLUEPRINT.metadata, title: 'Gadget Blueprint Slides', output, bindings: {} },
      }
      await render(publicApi(blueprint))

      expect(button(`${isAuthenticated ? 'Create' : 'Log in to create'} ${noun}`)).toBeDefined()
      expect(document.querySelector('h1')?.textContent).toBe('Gadget Blueprint Slides')
      expect(document.body.textContent).toContain('This template can create an output without configuring external resources.')
      expect(document.querySelector(`[aria-label="${isAuthenticated ? 'Add template to library' : 'Log in to add template to library'}"]`)).not.toBeNull()
    })
  })

  it('opens login rather than connection configuration when logged out', async () => {
    testState.isAuthenticated = false
    await render(publicApi({ ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, output: slides.output as BlueprintOutput } }))
    expect(button('Configure 1 remaining connection')).toBeUndefined()
    await act(async () => button('Log in to create slides')!.click())
    expect(document.body.textContent).toContain('Template journey login')
  })

  it('keeps the plural incomplete-connection CTA', async () => {
    testState.authenticatedApi = authenticatedApi()
    await render(publicApi({
      ...BLUEPRINT,
      metadata: {
        ...BLUEPRINT.metadata,
        output: slides.output as BlueprintOutput,
        bindings: { ...BLUEPRINT.metadata.bindings, SECOND_AI: BLUEPRINT.metadata.bindings.AI },
      },
    }))
    expect(button('Configure 2 remaining connections')).toBeDefined()
    expect(button('Create slides')).toBeUndefined()
  })

  it('downloads a Template archive with the original .gadget extension and authored name', async () => {
    const picker = vi.fn<() => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>>(async () => ({
      createWritable: async () => new WritableStream<Uint8Array>(),
    }))
    Object.assign(window, { showSaveFilePicker: picker })
    const downloadBlueprint = vi.fn<PublicApi['downloadBlueprint']>(async () => new ReadableStream<Uint8Array>({
      start(controller) { controller.close() },
    }))
    await render(publicApi({
      ...BLUEPRINT,
      metadata: { ...BLUEPRINT.metadata, title: 'Gadget Blueprint', bindings: {} },
    }, { downloadBlueprint }))
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More template actions"]')!.click())
    const download = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent === 'Download archive')!
    await act(async () => download.click())

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Gadget-Blueprint-v1.gadget',
      types: [{ description: 'Template archive', accept: { 'application/octet-stream': ['.gadget'] } }],
    })
    expect(downloadBlueprint).toHaveBeenCalledWith('blueprint-one')
  })

  it('uses template copy when the template is missing', async () => {
    await render(publicApi(null))
    expect(document.body.textContent).toContain('Template not found')
    expect(document.body.textContent).toContain('This template may have been removed or the link may be incorrect.')
  })

  it.each([true, false])('uses template deletion copy and preserves authored names (owned=%s)', async owned => {
    testState.authenticatedApi = authenticatedApi({
      isBlueprintInLibrary: async () => owned ? null : { uploaded: true },
      getOwnBlueprint: async () => owned ? {
        id: BLUEPRINT.id, title: 'Gadget Blueprint', description: '', version: 1,
        lastUpdated: BLUEPRINT.metadata.lastUpdated,
        source: { type: 'workspace', workspaceId: 'workspace-one', workspaceTitle: 'My Gadget' },
      } : null,
    })
    await render(publicApi({ ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, title: 'Gadget Blueprint' } }))
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="More template actions"]')!.click())
    const remove = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(item => item.textContent === 'Delete template')!
    await act(async () => remove.click())
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Delete template')
    expect(dialog.textContent).toContain('Delete "Gadget Blueprint"?')
    expect(dialog.textContent).toContain(owned
      ? 'This template link will stop working, but outputs already created from it won’t be affected.'
      : 'This template was uploaded manually and cannot be recovered.')
  })

  it.each([
    ['', 'Failed to load template.'],
    ['Blueprint service rejected Gadget Blueprint', 'Blueprint service rejected Gadget Blueprint'],
  ])('changes only the load-error fallback, not upstream copy (%s)', async (message, expected) => {
    await render(publicApi(null, { getBlueprint: async () => { throw new Error(message) } }))
    expect(document.body.textContent).toContain('Couldn’t load template')
    expect(document.body.textContent).toContain(expected)
  })

  it('portals model options above the configure dialog and accepts a selection', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    testState.authenticatedApi = authenticatedApi()
    await render(publicApi({ ...BLUEPRINT, metadata: { ...BLUEPRINT.metadata, output: docs.output as BlueprintOutput } }))

    expect(button('Create document')).toBeUndefined()
    await act(async () => button('Configure 1 remaining connection')!.click())
    expect(document.body.textContent).toContain('Choose the resource or model this new output should use.')

    const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose an AI model"]')!
    await act(async () => trigger.click())

    const option = document.body.querySelector<HTMLElement>('[role="option"]')!
    const portalHost = option.closest('[data-base-ui-portal]')!.parentElement!
    expect(portalHost.parentElement).toBe(document.body)
    expect(portalHost.style.position).toBe('relative')
    expect(portalHost.style.zIndex).toBe('1100')

    await act(async () => option.click())
    expect(trigger.textContent).toContain('Model one')

    const save = button('Save connection')!
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(button('Create document')).toBeDefined()
    expect(button('Configure 1 remaining connection')).toBeUndefined()
    expect(document.body.textContent).toContain('Everything is ready. You can change any connection before creating the output.')
  })
})
