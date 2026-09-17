import { DurableObject, WorkerEntrypoint, RpcTarget, RpcStub } from 'cloudflare:workers';
import { validateRpc } from 'capnweb-validate';
import { z } from 'zod';
import type { Gatekeeper, GatekeeperVendor as Vendor, GatekeeperUser, GatekeeperUserVerifier,
  GatekeeperConnectCallback, ApprovalQueue, SupportedResource, ResourceDescription } from '@gadgets/workshop-shared/gatekeeper';
import { grantsSchema, operationSchema, resultSchema, readJson, type LocalGrants, type LocalOperation, type LocalResult } from './protocol';
import type { LocalFolderSession, LocalExecutionSession, LocalNetworkSession, LocalJob } from './types';
import TYPES from './types.txt';
import CONFIGURATOR from './generated/local-configurator-ui.txt';

type Env = Cloudflare.Env & { BASE_URL?: string };
const resources: SupportedResource[] = [
  { urlPattern: 'localhost://:deviceId/folders/:grantId', title: 'Local folder', description: 'An explicitly shared desktop folder.' },
  { urlPattern: 'localhost://:deviceId/execution', title: 'Local execution', description: 'Machine-level process access as the desktop user.' },
  { urlPattern: 'localhost://:deviceId/network/:grantId', title: 'Desktop network', description: 'Requests through selected desktop-network origins.' },
];
const base = (env: Env) => (env.BASE_URL ?? 'http://localhost:8787/gatekeeper/localhost').replace(/\/$/, '');
const digest = async (token: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toHex();
type DeviceJob = { id: string; operation: LocalOperation; created: number; dispatched: boolean; result?: LocalResult };

/** Pairing and bounded, at-most-once delivery channel for one desktop. */
@validateRpc()
export class LocalDevice extends DurableObject<Env> {
  #waiters = new Map<string, (result: LocalResult) => void>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS local_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  #jobs(): DeviceJob[] {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM local_jobs WHERE json_extract(value, '$.result') IS NULL ORDER BY rowid")]
      .map(row => JSON.parse(row.value) as DeviceJob);
  }
  #job(id: string): DeviceJob | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM local_jobs WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.value) as DeviceJob : undefined;
  }
  #put(job: DeviceJob) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO local_jobs VALUES (?, ?)', job.id, JSON.stringify(job)); }
  async initialize(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    this.ctx.storage.kv.put('callback', callback);
    this.ctx.storage.kv.put('nonce', { hash: await digest(nonce), expires: Date.now() + 600_000 });
    await this.ctx.storage.setAlarm(Date.now() + 600_000);
  }
  async pair(nonce: string, grants: LocalGrants): Promise<string> {
    const hash = await digest(nonce);
    const expected = this.ctx.storage.kv.get<{ hash: string; expires: number }>('nonce');
    if (!expected || expected.expires < Date.now() || expected.hash !== hash) throw new Error('Pairing expired');
    this.ctx.storage.kv.delete('nonce');
    const token = crypto.randomUUID() + crypto.randomUUID();
    this.ctx.storage.kv.put('tokenHash', await digest(token));
    this.ctx.storage.kv.put('grants', grants);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>('callback');
    if (!callback) throw new Error('Pairing expired');
    await callback.complete(this.ctx.exports.LocalAccount({ props: { deviceId: this.ctx.id.toString() } }));
    this.ctx.storage.kv.delete('callback');
    await this.ctx.storage.deleteAlarm();
    return token;
  }
  async authorize(token: string): Promise<boolean> {
    return await digest(token) === this.ctx.storage.kv.get<string>('tokenHash');
  }
  async getGrants(): Promise<LocalGrants> {
    const grants = this.ctx.storage.kv.get<LocalGrants>('grants');
    if (!grants) throw new Error('Desktop is not paired');
    return grants;
  }
  async command(id: string, operation: LocalOperation): Promise<LocalResult> {
    await this.getGrants();
    const existing = this.#job(id);
    if (existing?.result) return existing.result;
    if (!existing) {
      if (this.#jobs().length >= 16) throw new Error('Too many outstanding local jobs');
      this.#put({ id, operation, created: Date.now(), dispatched: false });
    }
    if (this.#waiters.has(id)) throw new Error('Local operation already in progress');
    return new Promise<LocalResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiters.delete(id); reject(new Error('Desktop unavailable or operation outcome unknown')); }, 35_000);
      this.#waiters.set(id, result => { clearTimeout(timer); this.#waiters.delete(id); resolve(result); });
    });
  }
  async poll(): Promise<{ id: string; operation: LocalOperation } | null> {
    await this.getGrants();
    for (const job of this.#jobs()) {
      if (job.result) continue;
      if (job.dispatched) {
        if (job.created < Date.now() - 65_000) {
          this.#put({ ...job, result: { ok: false, error: 'Local operation failed' } });
        }
        continue;
      }
      if (job.created < Date.now() - 30_000) {
        this.#put({ ...job, result: { ok: false, error: 'Local operation failed' } });
        continue;
      }
      this.#put({ ...job, dispatched: true });
      return { id: job.id, operation: job.operation };
    }
    return null;
  }
  async complete(id: string, result: LocalResult): Promise<void> {
    const job = this.#job(id);
    if (!job?.dispatched || job.result) return;
    this.#put({ ...job, result });
    this.#waiters.get(id)?.(result);
  }
  /** Remove an observation whose result was delivered; observation IDs are never retried. */
  async forgetObservation(id: string): Promise<void> {
    const job = this.#job(id);
    if (job && (job.operation.op === 'read' || job.operation.op === 'list')) this.ctx.storage.sql.exec('DELETE FROM local_jobs WHERE id = ?', id);
  }
  async revoke(): Promise<void> {
    this.ctx.storage.kv.delete('grants');
    this.ctx.storage.kv.delete('tokenHash');
    this.ctx.storage.kv.delete('nonce');
    this.ctx.storage.kv.delete('callback');
    this.ctx.storage.sql.exec('DELETE FROM local_jobs');
    for (const finish of this.#waiters.values()) finish({ ok: false, error: 'Local operation failed' });
  }
  async alarm(): Promise<void> { if (!this.ctx.storage.kv.get('grants')) await this.revoke(); }
}

type LocalAction = { id: number; jobId: string; operation: LocalOperation;
  state: 'submitting' | 'pending' | 'running' | 'applied' | 'rejected' | 'failed'; result?: LocalResult };

/** Explicit connect flow; this vendor never declares ambient account provisioning. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements Vendor {
  async describe() { return { displayName: 'Local computer', url: 'https://workers.cloudflare.com', tagline: 'Introduce a desktop folder, process runner or network route', description: 'Pair your own desktop and explicitly introduce each resource to a bot.' }; }
  async getSupportedResources() { return resources; }
  async getTypeScriptTypes() { return TYPES; }
  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: { resourceUrlPatterns?: string[] }) {
    const id = this.ctx.exports.LocalDevice.newUniqueId();
    const nonce = crypto.randomUUID() + crypto.randomUUID();
    await this.ctx.exports.LocalDevice.get(id).initialize(callback, nonce);
    return { url: `${base(this.env)}/pair/${id}#${nonce}` };
  }
}

type AccountProps = { deviceId: string };
type ResourceProps = AccountProps & { kind: 'folders' | 'execution' | 'network'; grant: string };
/** Account capability backed by the device's pairing, not a claimed username. */
@validateRpc()
export class LocalAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  #device() { return this.ctx.exports.LocalDevice.get(this.ctx.exports.LocalDevice.idFromString(this.ctx.props.deviceId)); }
  async describe() { await this.#device().getGrants(); return { displayName: 'Paired desktop', avatar: { url: '' } }; }
  async getSupportedResources() {
    const grants = await this.#device().getGrants();
    return resources.filter((_, index) => index === 0 ? grants.folders.length > 0 : index === 1 ? grants.execution : grants.network.length > 0);
  }
  async getGatekeeperClassFor(value: string) {
    const url = new URL(value);
    const [kind, grant = ''] = url.pathname.slice(1).split('/');
    const grants = await this.#device().getGrants();
    if (url.protocol !== 'localhost:' || url.host !== this.ctx.props.deviceId || url.search || url.hash ||
        url.pathname !== `/${kind}${grant ? '/' + grant : ''}` ||
        !(kind === 'folders' && grants.folders.some(item => item.id === grant) ||
          kind === 'execution' && !grant && grants.execution || kind === 'network' && grants.network.some(item => item.id === grant))) {
      throw new Error('Desktop resource is not granted');
    }
    if (kind !== 'folders' && kind !== 'execution' && kind !== 'network') throw new Error('Unknown resource');
    return { class: this.ctx.exports.LocalGatekeeper({ props: { ...this.ctx.props, kind, grant } }),
      resource: resources[kind === 'folders' ? 0 : kind === 'execution' ? 1 : 2] };
  }
  async startResourceConfigurator(pattern: string) {
    if (!resources.some(resource => resource.urlPattern === pattern)) throw new Error('Unsupported resource');
    return { iframeHtml: CONFIGURATOR, ui: new RpcStub(new LocalConfigurator(this, pattern)) };
  }
  async revoke() { await this.#device().revoke(); }
  async reconnect(): Promise<never> { throw new Error('Remove this connection and pair the desktop again.'); }
  async getAuthenticatedEmail() { return null; }
  async ensureResources(_patterns: string[]) { return {}; }
  async getVerifier() { return this.ctx.exports.LocalVerifier({}); }
}
/** Private resources never accept collaborators through this verifier. */
@validateRpc()
export class LocalVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier { async verify() {} }

@validateRpc()
class LocalConfigurator extends RpcTarget {
  #account: LocalAccount;
  #pattern: string;
  constructor(account: LocalAccount, pattern: string) { super(); this.#account = account; this.#pattern = pattern; }
  async resourceUrl(url: string): Promise<string> {
    const resource = await this.#account.getGatekeeperClassFor(url);
    if (resource.resource.urlPattern !== this.#pattern) throw new Error('Choose the requested resource type');
    return url;
  }
}

/** Explicitly introduced resource, with writes represented by queued actions and a file overlay. */
@validateRpc()
export class LocalGatekeeper extends DurableObject<Env, ResourceProps> implements Gatekeeper<LocalFolderSession | LocalExecutionSession | LocalNetworkSession> {
  constructor(ctx: DurableObjectState<ResourceProps>, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS local_actions (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  }
  #actions(): LocalAction[] {
    return [...this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM local_actions WHERE json_extract(value, '$.state') IN ('submitting', 'pending', 'running') ORDER BY id")]
      .map(row => JSON.parse(row.value) as LocalAction);
  }
  #action(id: number): LocalAction | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM local_actions WHERE id = ?', id).toArray()[0];
    return row ? JSON.parse(row.value) as LocalAction : undefined;
  }
  #put(action: LocalAction) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO local_actions VALUES (?, ?)', action.id, JSON.stringify(action)); }
  #device() { return this.ctx.exports.LocalDevice.get(this.ctx.exports.LocalDevice.idFromString(this.ctx.props.deviceId)); }
  #assertScope(operation: LocalOperation) {
    const { kind, grant } = this.ctx.props;
    if (kind === 'execution' ? operation.op !== 'execute' : kind === 'network' ? operation.op !== 'request' || operation.grant !== grant
      : !['read', 'list', 'write', 'copy'].includes(operation.op) || !('grant' in operation) || operation.grant !== grant) {
      throw new Error('Operation outside resource scope');
    }
  }
  async describe(): Promise<ResourceDescription> {
    return { title: `Local ${this.ctx.props.kind}: ${this.ctx.props.grant || 'desktop'}`,
      url: `localhost://${this.ctx.props.deviceId}/${this.ctx.props.kind}${this.ctx.props.grant ? '/' + this.ctx.props.grant : ''}`,
      snippet: 'Private paired-desktop resource',
      tsType: this.ctx.props.kind === 'folders' ? 'LocalFolderSession' : this.ctx.props.kind === 'execution' ? 'LocalExecutionSession' : 'LocalNetworkSession',
      suggestedBindingName: 'LOCAL_COMPUTER' };
  }
  async getTypeScriptTypes() { return TYPES; }
  async getAutoApprovableActions() { return this.ctx.props.kind === 'folders' ? [{ tag: 'write-file', label: 'Write local files' }] : []; }
  async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error('Local computer resources are private to their owner'); }
  async removeObserver(_id: string) {}
  async startSession(queue: RpcStub<ApprovalQueue>) { return new LocalSession(this, queue.dup(), this.ctx.props.grant); }
  async applyAction(id: number): Promise<void> {
    const action = this.#action(id);
    if (!action || action.state === 'rejected' || action.state === 'failed') throw new Error('Local action is not available');
    if (action.state === 'applied') return;
    action.state = 'running'; this.#put(action);
    const result = await this.#device().command(action.jobId, action.operation);
    action.result = result; action.state = result.ok ? 'applied' : 'failed'; this.#put(action);
    if (!result.ok) throw new Error(result.error);
  }
  async rejectAction(id: number): Promise<void> {
    const action = this.#action(id);
    if (!action || action.state === 'applied' || action.state === 'running') throw new Error('Local action cannot be rejected');
    action.state = 'rejected'; this.#put(action);
  }
  async revertAction(_id: number): Promise<void> { throw new Error('Local actions cannot be reverted'); }
  async observe(operation: LocalOperation, queue: RpcStub<ApprovalQueue>): Promise<LocalResult> {
    operation = operationSchema.parse(operation);
    this.#assertScope(operation);
    if (operation.op !== 'read' && operation.op !== 'list') throw new Error('Not an observation');
    await this.#device().getGrants();
    await queue.authorizeObservation({ title: 'Read local folder', description: 'Read from the explicitly introduced folder' });
    await this.#device().getGrants();
    if (operation.op === 'read') {
      const pending = this.#actions().findLast(action => (action.state === 'pending' || action.state === 'running') &&
        action.operation.op === 'write' && action.operation.path === operation.path);
      if (pending?.operation.op === 'write') return { ok: true, value: pending.operation.data };
    }
    const id = crypto.randomUUID();
    const result = await this.#device().command(id, operation);
    await this.#device().forgetObservation(id);
    await this.#device().getGrants();
    if (operation.op === 'list' && result.ok) {
      const entries = z.array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']) })).parse(result.value);
      const directory = operation.path ? operation.path + '/' : '';
      const byName = new Map(entries.map(entry => [entry.name, entry]));
      for (const action of this.#actions()) {
        if (action.state !== 'pending' && action.state !== 'running') continue;
        if (action.operation.op !== 'write' || !action.operation.path.startsWith(directory)) continue;
        const name = action.operation.path.slice(directory.length);
        if (name && !name.includes('/')) byName.set(name, { name, kind: 'file' });
      }
      return { ok: true, value: [...byName.values()] };
    }
    return result;
  }
  async enqueue(operation: LocalOperation, queue: RpcStub<ApprovalQueue>): Promise<string> {
    operation = operationSchema.parse(operation);
    this.#assertScope(operation);
    if (operation.op === 'read' || operation.op === 'list') throw new Error('Not an action');
    await this.#device().getGrants();
    const actions = this.#actions();
    if (actions.length >= 16) throw new Error('Too many pending local actions');
    const id = this.ctx.storage.sql.exec<{ id: number }>('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM local_actions').one().id;
    const action: LocalAction = { id, jobId: crypto.randomUUID(), operation, state: 'submitting' };
    this.#put(action);
    // Keep uncertain submissions addressable for an approval already recorded by the Workshop,
    // but do not simulate them until submission has been confirmed.
    await queue.submitAction(id, { title: operation.op === 'write' ? `Write local file: ${operation.path}` : operation.op === 'execute' ? 'Run local process' : 'Use desktop network',
        description: operation.op === 'execute' ? JSON.stringify({ command: operation.command, args: operation.args, cwd: operation.cwd })
          : operation.op === 'request' ? `${operation.method} ${operation.url}` : 'Update the explicitly introduced folder',
        implementsRevert: false, autoApprovable: operation.op === 'write',
        actionKind: { tag: operation.op === 'write' ? 'write-file' : operation.op, label: operation.op === 'write' ? 'Write local files' : operation.op === 'execute' ? 'Run local processes' : 'Use desktop network' } });
    const current = this.#action(id);
    if (current?.state === 'submitting') this.#put({ ...current, state: 'pending' });
    return action.jobId;
  }
  async job(id: string, queue: RpcStub<ApprovalQueue>): Promise<LocalJob> {
    await this.#device().getGrants();
    await queue.authorizeObservation({ title: 'Read local job result', description: 'Read this connection’s asynchronous job result' });
    await this.#device().getGrants();
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM local_actions WHERE json_extract(value, '$.jobId') = ?", id).toArray()[0];
    const action = row ? JSON.parse(row.value) as LocalAction : undefined;
    if (!action) throw new Error('No local job');
    if (action.state === 'pending' || action.state === 'submitting') return { state: 'scheduled' };
    if (action.state === 'running') return { state: 'running' };
    if (action.state !== 'applied' || !action.result?.ok) return { state: 'failed', error: 'Local operation failed' };
    const result = z.object({ output: z.string(), exitCode: z.number().optional() }).parse(action.result.value);
    return { state: 'finished', ...result };
  }
}

/** Session lifetime owns the approval-queue reference. */
@validateRpc()
class LocalSession extends RpcTarget implements LocalFolderSession, LocalExecutionSession, LocalNetworkSession {
  #resource: LocalGatekeeper;
  #queue: RpcStub<ApprovalQueue>;
  #grant: string;
  constructor(resource: LocalGatekeeper, queue: RpcStub<ApprovalQueue>, grant: string) { super(); this.#resource = resource; this.#queue = queue; this.#grant = grant; }
  [Symbol.dispose]() { this.#queue[Symbol.dispose](); }
  async list(path: string) {
    const result = await this.#resource.observe({ op: 'list', grant: this.#grant, path }, this.#queue);
    if (!result.ok) throw new Error(result.error);
    return z.array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']) })).parse(result.value);
  }
  async readFile(path: string) {
    const result = await this.#resource.observe({ op: 'read', grant: this.#grant, path }, this.#queue);
    if (!result.ok) throw new Error(result.error);
    return Uint8Array.fromBase64(z.string().parse(result.value));
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > 1_048_576) throw new Error('File exceeds one MiB');
    await this.#resource.enqueue({ op: 'write', grant: this.#grant, path, data: data.toBase64() }, this.#queue);
  }
  async copyFile(source: string, destination: string): Promise<void> { await this.writeFile(destination, await this.readFile(source)); }
  async execute(command: string, args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<string> {
    return this.#resource.enqueue({ op: 'execute', command, args, ...options }, this.#queue);
  }
  async request(url: string, options: { method: 'GET' | 'POST'; body?: string }): Promise<string> {
    return this.#resource.enqueue({ op: 'request', grant: this.#grant, url, ...options }, this.#queue);
  }
  async getJob(id: string): Promise<LocalJob> { return this.#resource.job(id, this.#queue); }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const prefix = new URL(base(env)).pathname.replace(/\/$/, '');
    const match = new RegExp(`^${prefix}/(pair|device)/([a-f0-9]{64})(?:/(poll|complete))?$`).exec(url.pathname);
    if (!match) return new Response('Not found', { status: 404 });
    const device = ctx.exports.LocalDevice.get(ctx.exports.LocalDevice.idFromString(match[2]));
    if (match[1] === 'pair' && request.method === 'GET') return new Response(
      '<!doctype html><meta name="referrer" content="no-referrer"><title>Pair desktop</title><h1>Pair your desktop</h1><p>Copy this page’s full URL, including its fragment, into the local daemon pairing command. Pairing expires in ten minutes.</p>',
      { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    try {
      if (match[1] === 'pair') {
        const input = z.object({ nonce: z.string().max(100), grants: grantsSchema }).parse(await readJson(request));
        return Response.json({ token: await device.pair(input.nonce, input.grants) }, { headers: { 'cache-control': 'no-store' } });
      }
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (!await device.authorize(token)) return new Response('Unauthorized', { status: 401 });
      if (match[3] === 'poll') return Response.json(await device.poll());
      if (match[3] === 'complete') {
        const input = z.object({ id: z.string().uuid(), result: resultSchema }).parse(await readJson(request));
        await device.complete(input.id, input.result);
        return new Response(null, { status: 204 });
      }
    } catch { return new Response('Local bridge request failed', { status: 400 }); }
    return new Response('Not found', { status: 404 });
  },
};
