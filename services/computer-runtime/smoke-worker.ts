// Test-only entrypoint. Production's default fetch handler remains a 404.
import { RpcStub } from 'cloudflare:workers';
export { BotSandbox, ComputerWorkspace, ComputerRuntime } from './src/index';

export default {
  async fetch(request: Request, _env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health') return new Response('ready');
    using check = new RpcStub(async () => {});
    const runtime = ctx.exports.ComputerRuntime({});
    if (path === '/write') return Response.json(await runtime.run('synthetic-bot-a', { kind: 'exec', command: 'printf persistent > proof.txt' }, check));
    if (path === '/read') return Response.json(await runtime.run('synthetic-bot-a', { kind: 'read', path: 'proof.txt' }, check));
    if (path === '/other') return Response.json(await runtime.run('synthetic-bot-b', { kind: 'list', path: '.' }, check));
    return new Response('Not found', { status: 404 });
  },
};
