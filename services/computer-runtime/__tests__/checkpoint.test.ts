import { env, DurableObject, RpcStub } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { getSandbox } from '@cloudflare/sandbox';
import type { ComputerWorkspace } from '../src/index';

vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class extends DurableObject {}, getSandbox: vi.fn() }));
declare module 'cloudflare:workers' {
  interface ProvidedEnv { Workspaces: DurableObjectNamespace<ComputerWorkspace>; WORKSPACES: R2Bucket }
}
afterEach(() => vi.resetAllMocks());

function fakeSandbox() {
  let files: Record<string, string> = {};
  let operation = '';
  let archive = '';
  const sdk = {
    destroy: vi.fn(async () => { files = {} }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, content: string | ReadableStream) => {
      if (path === '/tmp/operation.json') operation = String(content);
      else archive = await new Response(content).text();
    }),
    exec: vi.fn(async (command: string) => {
      if (command.startsWith('tar -xf')) files = JSON.parse(archive);
      else if (command.startsWith('tar -cf')) archive = JSON.stringify(files);
      else {
        const op = JSON.parse(operation);
        if (op.kind === 'write') files[op.path] = op.data;
        return { success: true, stdout: JSON.stringify({ exitCode: 0, stdout: '', stderr: '', ...(op.kind === 'read' ? { data: files[op.path] } : {}) }) };
      }
      return { success: true, stdout: '' };
    }),
    readFile: vi.fn(async () => ({ size: new TextEncoder().encode(archive).length, content: new Response(archive).body! })),
  };
  vi.mocked(getSandbox).mockReturnValue(sdk as ReturnType<typeof getSandbox>);
  return sdk;
}

it('restores acknowledged files into a fresh sandbox, with a separate checkpoint per bot', async () => {
  const sdk = fakeSandbox();
  using check = new RpcStub(async () => {});
  const first = env.Workspaces.getByName('bot-a');
  const second = env.Workspaces.getByName('bot-b');
  await first.run({ kind: 'write', path: 'result.txt', data: 'cmVzdWx0' }, check);
  expect((await first.run({ kind: 'read', path: 'result.txt' }, check)).data).toBe('cmVzdWx0');
  expect((await second.run({ kind: 'read', path: 'result.txt' }, check)).data).toBeUndefined();
  expect(sdk.destroy).toHaveBeenCalledTimes(3);
  expect((await env.WORKSPACES.list()).objects).toHaveLength(1);
});

it('does not checkpoint or retry an operation whose permission is revoked', async () => {
  const sdk = fakeSandbox();
  let allowed = true;
  using check = new RpcStub(async () => { if (!allowed) throw new Error('revoked'); });
  const previous = sdk.exec.getMockImplementation()!;
  sdk.exec.mockImplementation(async command => {
    const result = await previous(command);
    if (command.startsWith('python')) allowed = false;
    return result;
  });
  const workspace = env.Workspaces.getByName('revoked');
  const result = await workspace.run({ kind: 'exec', command: 'write something' }, check).then(() => '', error => error.message);
  expect(result).toContain('not retried');
  expect(sdk.exec.mock.calls.filter(([command]) => command.startsWith('python'))).toHaveLength(1);
  expect((await env.WORKSPACES.list({ prefix: `${workspace.id}/` })).objects).toHaveLength(0);
});
