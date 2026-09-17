import { env, RpcTarget, RpcStub } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ApprovalQueue, ActionDescription, ObservationDescription } from '@gadgets/workshop-shared/gatekeeper';
import type { LocalDevice } from '../src/localhost';
import type { TestHarness } from './worker';

declare module 'cloudflare:workers' {
  interface ProvidedEnv { DEVICE: DurableObjectNamespace<LocalDevice>; HARNESS: DurableObjectNamespace<TestHarness> }
}

class Queue extends RpcTarget {
  actions: number[] = [];
  observations = 0;
  async submitAction(id: number, _description: ActionDescription) { this.actions.push(id); }
  async authorizeObservation(_description: ObservationDescription) { ++this.observations; }
}

async function fixture(kind: 'folders' | 'execution', run: (fixture: {
  device: DurableObjectStub<LocalDevice>; resource: Awaited<ReturnType<TestHarness['resource']>>; harness: TestHarness;
}) => Promise<void>) {
  const device = env.DEVICE.getByName(crypto.randomUUID());
  await runInDurableObject(device, async (_instance, state) => {
    state.storage.kv.put('grants', { folders: [{ id: 'docs', label: 'Documents' }], execution: true, network: [] });
  });
  const harness = env.HARNESS.getByName(crypto.randomUUID());
  await runInDurableObject(harness, async (instance: TestHarness) => {
    const localDevice = env.DEVICE.get(env.DEVICE.idFromString(device.id.toString()));
    const resource = await instance.resource(device.id.toString(), kind, kind === 'folders' ? 'docs' : '');
    await run({ device: localDevice, resource, harness: instance });
  });
}

async function nextJob(device: DurableObjectStub<LocalDevice>) {
  for (let i = 0; i < 100; ++i) {
    const job = await device.poll();
    if (job) return job;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Expected a local job');
}

async function failure(operation: PromiseLike<unknown>): Promise<string> {
  try { await operation; return ''; } catch (error) { return error instanceof Error ? error.message : 'error'; }
}

describe('local capability and approval transport', () => {
  it('simulates a pending file write, sends nothing before approval, and never reapplies a completed action', () => fixture('folders', async ({ resource, device }) => {
    const queue = new Queue();
    using queueStub = new RpcStub(queue as ApprovalQueue);
    using session = await resource.startSession(queueStub);
    await session.writeFile('./report.txt', new TextEncoder().encode('draft'));
    expect(queue.actions).toEqual([1]);
    expect(await device.poll()).toBeNull();
    expect(new TextDecoder().decode(await session.readFile('report.txt'))).toBe('draft');
    expect(queue.observations).toBe(1);
    const applying = resource.applyAction(1);
    const job = await nextJob(device);
    expect(job.operation).toMatchObject({ op: 'write', grant: 'docs', path: 'report.txt' });
    expect(await device.poll()).toBeNull();
    await device.complete(job.id, { ok: true, value: null });
    await applying;
    await resource.applyAction(1);
    expect(await device.poll()).toBeNull();
    await session.writeFile('another.txt', new Uint8Array([1]));
    await resource.rejectAction(2);
    expect(await failure(resource.applyAction(2))).toContain('not available');
    expect(await failure(session.execute('sh', [], {}))).toContain('outside resource scope');
  }));

  it('exposes real job results only after approval and rejects foreign job IDs', () => fixture('execution', async ({ resource, device }) => {
    using queue = new RpcStub(new Queue() as ApprovalQueue);
    using session = await resource.startSession(queue);
    const id = await session.execute('node', ['--version'], {});
    expect(await session.getJob(id)).toEqual({ state: 'scheduled' });
    expect(await device.poll()).toBeNull();
    const applying = resource.applyAction(1);
    const job = await nextJob(device);
    await device.complete(job.id, { ok: true, value: { output: 'v26', exitCode: 0 } });
    await applying;
    expect(await session.getJob(id)).toEqual({ state: 'finished', output: 'v26', exitCode: 0 });
    expect(await failure(session.getJob(crypto.randomUUID()))).toContain('No local job');
  }));

  it('rejects resource URL expansion, observers and reads after pairing revocation', () => fixture('folders', async ({ resource, device, harness }) => {
    const account = await harness.account(device.id.toString());
    expect(await failure(account.getGatekeeperClassFor(`localhost://${device.id}/folders/docs/extra`))).toContain('not granted');
    expect(await failure(account.getGatekeeperClassFor(`localhost://${device.id}/folders/other`))).toContain('not granted');
    expect(await harness.rejectObserver(device.id.toString())).toContain('private');
    using queue = new RpcStub(new Queue() as ApprovalQueue);
    using session = await resource.startSession(queue);
    await session.writeFile('pending.txt', new Uint8Array([1]));
    await device.revoke();
    expect(await failure(session.readFile('pending.txt'))).toContain('not paired');
    expect(await device.authorize('wrong-token')).toBe(false);
  }));
});
