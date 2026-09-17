import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { createInterface } from 'node:readline/promises';
import { operationSchema, resultSchema, readJson } from '../src/protocol.ts';
import { executeLocal } from './operations.ts';

const grantsSchema = z.object({ folders: z.record(z.string(), z.string()), execution: z.boolean(), network: z.record(z.string(), z.array(z.string().url())) });
const configSchema = z.object({ endpoint: z.string().url(), token: z.string(), grants: grantsSchema });
const [mode, file] = process.argv.slice(2);
if (!file || !['pair', 'run'].includes(mode ?? '')) throw new Error('Usage: daemon pair <grants.json> | daemon run <session.json>');

function endpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use HTTPS, or HTTP on loopback for development');
  }
  return url;
}

if (mode === 'pair') {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let pairingUrl: string;
  try { pairingUrl = await terminal.question('Paste the pairing URL from Workshop: '); }
  finally { terminal.close(); }
  const url = endpoint(pairingUrl);
  const nonce = url.hash.slice(1);
  url.hash = '';
  const grants = grantsSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, grants: { folders: Object.keys(grants.folders).map(id => ({ id, label: id })),
      execution: grants.execution, network: Object.entries(grants.network).map(([id, origins]) => ({ id, origins })) } }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Pairing failed');
  const { token } = z.object({ token: z.string().max(100) }).parse(await readJson(response));
  const deviceId = url.pathname.split('/').at(-1)!;
  url.pathname = url.pathname.replace('/pair/', '/device/');
  await writeFile(`${file}.session.json`, JSON.stringify({ endpoint: url.href, token, grants }), { mode: 0o600, flag: 'wx' });
  console.info(`Paired. Start with: daemon run ${file}.session.json`);
  for (const id of Object.keys(grants.folders)) console.info(`Folder: localhost://${deviceId}/folders/${id}`);
  if (grants.execution) console.info(`Execution: localhost://${deviceId}/execution`);
  for (const id of Object.keys(grants.network)) console.info(`Network: localhost://${deviceId}/network/${id}`);
} else {
  const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const url = endpoint(config.endpoint);
  let stopped = false;
  process.once('SIGINT', () => { stopped = true });
  process.once('SIGTERM', () => { stopped = true });
  const call = (suffix: string, body?: unknown) => fetch(`${url.href}/${suffix}`, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
  console.info('Local bridge running. Introduce a printed resource URL to a bot to grant access.');
  while (!stopped) {
    try {
      const response = await call('poll');
      if (response.status === 401) { stopped = true; console.error('Pairing revoked.'); continue; }
      if (!response.ok) { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
      const job = z.object({ id: z.string().uuid(), operation: operationSchema }).nullable().parse(await readJson(response));
      if (job) {
        const result = resultSchema.parse(await executeLocal(job.operation, config.grants));
        // Delivery can be retried, execution cannot. An uncertain result never reruns the command.
        for (let attempt = 0; attempt < 3; ++attempt) {
          if (stopped) break;
          try { if ((await call('complete', { id: job.id, result })).ok) break; } catch { /* retry only result delivery */ }
        }
      }
    } catch { console.error('Local bridge unavailable; stop and re-pair if access was revoked.'); }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
