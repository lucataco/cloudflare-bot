import { exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { newWebSocketRpcSession, type RpcStub } from 'capnweb';
import type { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api';
import { launch, type Browser, type Page } from '@cloudflare/puppeteer';
import type { OverseerDurableObject } from '../src/overseer';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/puppeteer', () => ({ launch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

async function account(api: RpcStub<PublicApi>) {
  const name = 'secret' + crypto.randomUUID().replaceAll('-', '');
  const token = await api.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error('Account creation failed');
  return api.authenticate(token);
}

it('keeps a one-shot secret outside durable history and model data and rejects collaborators', async () => {
  const response = await exports.default.fetch(new Request('https://workshop.invalid/api', { headers: { Upgrade: 'websocket' } }));
  response.webSocket!.accept();
  using publicApi = newWebSocketRpcSession<PublicApi>(response.webSocket!);
  using api: RpcStub<AuthenticatedApi> = await account(publicApi);
  using other = await account(publicApi);
  const agent = await api.createAgent('Login helper', 'Browser', '', null);
  using owner = await api.openGadget(agent.workspaceId);
  const { key } = await owner.createShareLink('build');
  using collaborator = await other.openGadget(agent.workspaceId, key);
  await owner.setComputerControl(agent.id, 'agent');
  const workspace = exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(agent.workspaceId));
  const requestId = await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
    const impl = instance['impl'];
    impl.storage.chatMeta.put({ id: 1, title: 'Login', started: new Date(), lastActive: new Date() });
    impl.requestComputerHumanTakeover(1, 'Sign in', 'https://example.com/login', 'password');
    const messages = impl.consumeCapturedComputerHumanTakeovers(1);
    impl.addChatMessages(1, { type: 'agent', id: 'model', name: 'Model' }, messages);
    const request = messages[0];
    if (request.type !== 'computerHumanTakeover') throw new Error('Expected takeover');
    return request.requestId;
  });
  const typed = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const field = { evaluate: async () => {}, type: typed, dispose: async () => {} };
  const page = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, setViewport: async () => {},
    goto: async () => null, url: () => 'https://example.com/login', $: async () => field };
  vi.mocked(launch).mockResolvedValue({ connected: true, newPage: async () => page as Page, close: async () => {} } as Browser);
  const denied = await collaborator.submitComputerSecret(requestId, 'SYNTHETIC-SECRET').then(() => '', error => error.message);
  expect(denied).toContain('owner-only');
  expect(typed).not.toHaveBeenCalled();
  await owner.submitComputerSecret(requestId, 'SYNTHETIC-SECRET');
  expect(typed.mock.calls.flat().join('')).toBe('SYNTHETIC-SECRET');
  expect(await owner.getComputerControl(agent.id)).toBe('human');
  const replay = await owner.submitComputerSecret(requestId, 'REPLAY').then(() => '', error => error.message);
  expect(replay).toContain('no longer available');
  const history = await owner.getChatHistory(1);
  expect(JSON.stringify(history)).not.toContain('SYNTHETIC-SECRET');
  expect(history.messages[0]).toMatchObject({ secretInput: { kind: 'password', submitted: true }, state: 'pending' });
  await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
    expect(JSON.stringify([...instance['impl'].storage.chats.list()])).not.toContain('SYNTHETIC-SECRET');
  });
});
