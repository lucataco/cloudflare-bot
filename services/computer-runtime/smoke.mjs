import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinEntry } from '../../scripts/bin-entry.ts';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const wrangler = resolveBinEntry(cwd, 'wrangler');
if (!wrangler) throw new Error('Install workspace dependencies first');
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const storage = await mkdtemp(join(tmpdir(), 'workshop-computer-smoke-'));
const child = spawn(process.execPath, [wrangler, 'dev', '.wrangler/validate/smoke-worker.ts', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', storage],
  { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
let logs = '';
const collect = bytes => { logs = (logs + bytes.toString()).slice(-32_000); };
child.stdout.on('data', collect); child.stderr.on('data', collect);
const exited = new Promise(resolve => child.once('exit', resolve));
const call = async path => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(120_000) });
  assert.equal(response.status, 200, `Smoke endpoint failed: ${path}`);
  return response.json();
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 180; ++attempt) {
    if (child.exitCode !== null) throw new Error('Wrangler exited before becoming ready');
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Wrangler did not become ready');
  assert.equal((await call('/write')).exitCode, 0);
  assert.equal(Buffer.from((await call('/read')).data, 'base64').toString(), 'persistent');
  assert.deepEqual((await call('/other')).entries, []);
  console.info('Live Sandbox smoke passed: shell execution, durable restore, and separate bot workspaces.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group exited */ }
  await rm(storage, { recursive: true, force: true });
}
