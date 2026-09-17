import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { LocalOperation, LocalResult } from '../src/protocol.ts';

/** Desktop-owned resource grants; never accepted from the cloud's job payload. */
export type DesktopGrants = {
  folders: Record<string, string>;
  execution: boolean;
  network: Record<string, string[]>;
};
const MAX_BYTES = 1024 * 1024;

/** Resolve only an ordinary descendant path. Folder grants do not follow symlinks. */
export async function folderPath(root: string, path: string, allowMissingLeaf = false): Promise<string> {
  if (isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) throw new Error('Invalid relative path');
  const base = await realpath(root);
  const target = resolve(base, path || '.');
  const child = relative(base, target);
  if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw new Error('Path outside folder');
  const parts = child.split(sep).filter(Boolean);
  let current = base;
  for (let i = 0; i < parts.length; ++i) {
    current = join(current, parts[i]);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are not supported'); }
    catch (error) {
      if (allowMissingLeaf && i === parts.length - 1 && error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return target;
}

async function readFile(root: string, path: string): Promise<Buffer> {
  const file = await open(await folderPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Unsupported file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('File too large');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

async function writeFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_BYTES) throw new Error('File too large');
  const file = await open(await folderPath(root, path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a file');
    await file.truncate(0);
    await file.writeFile(bytes);
  } finally { await file.close(); }
}

async function runProcess(operation: Extract<LocalOperation, { op: 'execute' }>): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolveJob, reject) => {
    const child = spawn(operation.command, operation.args, { cwd: operation.cwd, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, SYSTEMROOT: process.env.SYSTEMROOT } });
    const chunks: Buffer[] = [];
    let length = 0;
    let exceeded = false;
    const kill = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { exceeded = true; kill(); }, operation.timeoutMs ?? 30_000);
    const consume = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BYTES) { exceeded = true; kill(); } else chunks.push(chunk);
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Local operation failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (exceeded) reject(new Error('Local operation failed'));
      else resolveJob({ output: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? -1 });
    });
  });
}

/** Apply an already authorized operation, enforcing the desktop's independent resource grants. */
export async function executeLocal(operation: LocalOperation, grants: DesktopGrants): Promise<LocalResult> {
  try {
    if (operation.op === 'execute') {
      if (!grants.execution) throw new Error('Execution not granted');
      return { ok: true, value: await runProcess(operation) };
    }
    if (operation.op === 'request') {
      const url = new URL(operation.url);
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) ||
          !grants.network[operation.grant]?.includes(url.origin)) throw new Error('Origin not granted');
      const response = await fetch(url, { method: operation.method, body: operation.body, redirect: 'error', signal: AbortSignal.timeout(25_000) });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return { ok: true, value: { output: Buffer.concat(chunks).toString('utf8'), exitCode: response.status } };
    }
    const root = Object.hasOwn(grants.folders, operation.grant) ? grants.folders[operation.grant] : undefined;
    if (!root) throw new Error('Folder not granted');
    if (operation.op === 'list') {
      const entries = await readdir(await folderPath(root, operation.path), { withFileTypes: true });
      if (entries.length > 1000) throw new Error('Directory too large');
      return { ok: true, value: entries.filter(entry => entry.isFile() || entry.isDirectory())
        .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const })) };
    }
    if (operation.op === 'read') return { ok: true, value: (await readFile(root, operation.path)).toString('base64') };
    if (operation.op === 'write') await writeFile(root, operation.path, Buffer.from(operation.data, 'base64'));
    else await writeFile(root, operation.destination, await readFile(root, operation.source));
    return { ok: true, value: null };
  } catch { return { ok: false, error: 'Local operation failed' }; }
}
