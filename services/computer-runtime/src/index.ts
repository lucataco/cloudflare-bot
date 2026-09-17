import { DurableObject, WorkerEntrypoint, type RpcStub } from 'cloudflare:workers';
import { Sandbox, getSandbox } from '@cloudflare/sandbox';
import { validateRpc } from 'capnweb-validate';
import { z } from 'zod';
import type { ComputerOperation, ComputerResult, ComputerRuntimeApi } from '@gadgets/workshop-shared/computer';

/** Each bot's container has no deployment credentials and public internet access is disabled. */
export class BotSandbox extends Sandbox { override enableInternet = false; }
const MAX_CHECKPOINT = 64 * 1024 * 1024;
const resultSchema = z.object({ exitCode: z.number().int(), stdout: z.string().max(256 * 1024), stderr: z.string().max(256 * 1024),
  data: z.string().max(6 * 1024 * 1024).optional(), entries: z.array(z.object({ name: z.string().max(4096), kind: z.enum(['file', 'directory']) })).max(1000).optional() });

/** Serializes a bot's operations and owns the durable checkpoint pointer. */
@validateRpc()
export class ComputerWorkspace extends DurableObject<Cloudflare.Env> {
  #tail: Promise<unknown> = Promise.resolve();
  async run(operation: ComputerOperation, check: RpcStub<() => Promise<void>>): Promise<ComputerResult> {
    const pending = this.#tail.then(() => this.#run(operation, check));
    this.#tail = pending.catch(() => {});
    return pending;
  }

  async #run(operation: ComputerOperation, check: RpcStub<() => Promise<void>>): Promise<ComputerResult> {
    if (JSON.stringify(operation).length > 6 * 1024 * 1024 || (operation.kind === 'exec' && operation.command.length > 32_000)) {
      throw new Error('Computer operation too large');
    }
    await check();
    const old = this.ctx.storage.kv.get<string>('activeSandbox');
    if (old) await getSandbox(this.env.Sandbox, old).destroy();
    await check();
    // Durable identity stays in this controller. Each private incarnation gets a fresh name,
    // avoiding SDK transport/session state surviving destroy() and fitting its 63-character limit.
    const sandboxId = `bot-${crypto.randomUUID()}`;
    this.ctx.storage.kv.put('activeSandbox', sandboxId);
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    const checked = async <T>(call: () => Promise<T>) => { await check(); const value = await call(); await check(); return value; };
    let next: string | undefined;
    let committed = false;
    try {
      // A fresh container per transaction eliminates hidden shell/environment state on recovery.
      await checked(() => sandbox.mkdir('/workspace', { recursive: true }));
      const previous = await this.ctx.storage.get<string>('checkpoint');
      if (previous) {
        const checkpoint = await checked(() => this.env.WORKSPACES.get(previous));
        if (!checkpoint) throw new Error('Checkpoint missing');
        await checked(() => sandbox.writeFile('/tmp/workspace.tar', checkpoint.body));
        const restored = await checked(() => sandbox.exec('tar -xf /tmp/workspace.tar -C /workspace', { timeout: 60_000 }));
        if (!restored.success) throw new Error('Checkpoint restore failed');
      }
      await checked(() => sandbox.writeFile('/tmp/operation.json', JSON.stringify(operation)));
      const response = await checked(() => sandbox.exec('python3 /opt/workshop/run.py < /tmp/operation.json', { timeout: 45_000 }));
      const result = resultSchema.parse(JSON.parse(response.stdout));
      if (operation.kind === 'exec' || operation.kind === 'write' || operation.kind === 'delete') {
        const packed = await checked(() => sandbox.exec('tar -cf /tmp/workspace.tar -C /workspace .', { timeout: 60_000 }));
        if (!packed.success) throw new Error('Checkpoint failed');
        const archive = await checked(() => sandbox.readFile('/tmp/workspace.tar', { encoding: 'none' }));
        if (!Number.isSafeInteger(archive.size) || archive.size > MAX_CHECKPOINT) throw new Error('Workspace exceeds checkpoint limit');
        next = `${this.ctx.id}/checkpoints/${crypto.randomUUID()}.tar`;
        await checked(() => this.env.WORKSPACES.put(next!, archive.content.pipeThrough(new FixedLengthStream(archive.size))));
        await check();
        this.ctx.storage.kv.put('checkpoint', next);
        committed = true;
        if (previous) this.ctx.waitUntil(this.env.WORKSPACES.delete(previous).catch(() => {}));
      }
      return result;
    } catch {
      throw new Error('Computer operation could not be confirmed. The last durable workspace checkpoint is retained; the command was not retried.');
    } finally {
      await sandbox.destroy().then(() => {
        if (this.ctx.storage.kv.get('activeSandbox') === sandboxId) this.ctx.storage.kv.delete('activeSandbox');
      }).catch(() => {}); // Keep the pointer on cleanup failure so the next call must stop it first.
      if (next && !committed) this.ctx.waitUntil(this.env.WORKSPACES.delete(next).catch(() => {}));
    }
  }

  /** Interrupt running work without deleting its last acknowledged filesystem. */
  async stop(): Promise<void> {
    const id = this.ctx.storage.kv.get<string>('activeSandbox');
    if (id) await getSandbox(this.env.Sandbox, id).destroy();
    if (this.ctx.storage.kv.get('activeSandbox') === id) this.ctx.storage.kv.delete('activeSandbox');
  }
}

/** Private service binding entrypoint; never exposes a public shell HTTP endpoint. */
@validateRpc()
export class ComputerRuntime extends WorkerEntrypoint<Cloudflare.Env> implements ComputerRuntimeApi {
  async run(key: string, operation: ComputerOperation, check: RpcStub<() => Promise<void>>): Promise<ComputerResult> {
    return this.env.Workspaces.getByName(key).run(operation, check);
  }
  async stop(key: string): Promise<void> { await this.env.Workspaces.getByName(key).stop(); }
}
export default { fetch() { return new Response('Not found', { status: 404 }); } };
