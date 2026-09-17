import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeLocal } from './operations.ts';
import { operationSchema } from '../src/protocol.ts';

test('folder operations reject traversal and symlinks and read/write only their grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-grant-'));
  const outside = await mkdtemp(join(tmpdir(), 'local-outside-'));
  try {
    await writeFile(join(outside, 'private.txt'), 'outside');
    await symlink(outside, join(root, 'escape'));
    const grants = { folders: { docs: root }, execution: false, network: {} };
    for (const path of ['../private.txt', '/etc/passwd', 'escape/private.txt']) {
      assert.deepEqual(await executeLocal({ op: 'read', grant: 'docs', path }, grants), { ok: false, error: 'Local operation failed' });
    }
    assert.equal(operationSchema.safeParse({ op: 'write', grant: 'docs', path: '../escape', data: '' }).success, false);
    assert.deepEqual(await executeLocal({ op: 'write', grant: 'docs', path: 'report.txt', data: Buffer.from('report').toString('base64') }, grants), { ok: true, value: null });
    assert.equal(await readFile(join(root, 'report.txt'), 'utf8'), 'report');
    assert.deepEqual(await executeLocal({ op: 'copy', grant: 'docs', source: 'report.txt', destination: 'copy.txt' }, grants), { ok: true, value: null });
    assert.equal(await readFile(join(root, 'copy.txt'), 'utf8'), 'report');
    assert.deepEqual(await executeLocal({ op: 'read', grant: 'other', path: 'report.txt' }, grants), { ok: false, error: 'Local operation failed' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('execution and network access require their own desktop grants', async () => {
  const grants = { folders: {}, execution: false, network: {} };
  assert.deepEqual(await executeLocal({ op: 'execute', command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] }, grants), { ok: false, error: 'Local operation failed' });
  assert.deepEqual(await executeLocal({ op: 'request', grant: 'internal', url: 'http://localhost:1234/', method: 'GET' }, grants), { ok: false, error: 'Local operation failed' });
  assert.deepEqual(await executeLocal({ op: 'execute', command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] }, { ...grants, execution: true }), { ok: true, value: { output: 'ok', exitCode: 0 } });
});
