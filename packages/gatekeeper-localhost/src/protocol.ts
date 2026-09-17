import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const path = z.string().max(4096);
const relativePath = path.refine(value => !/^(?:[\\/]|[A-Za-z]:)/.test(value) && !value.includes('\0') &&
  !value.split(/[\\/]/).includes('..'), 'Use a relative folder path')
  .transform(value => value.split(/[\\/]/).filter(part => part && part !== '.').join('/'));
/** Bounded desktop-owner grant metadata. Actual folder paths stay on the desktop. */
export const grantsSchema = z.object({
  folders: z.array(z.object({ id, label: z.string().min(1).max(100) })).max(32),
  execution: z.boolean(),
  network: z.array(z.object({ id, origins: z.array(z.string().url().max(2048)).max(32) })).max(32),
});
/** Pairing-time display and authorization metadata. */
export type LocalGrants = z.infer<typeof grantsSchema>;
/** Untrusted wire operations. A desktop applies its own grant checks to every operation. */
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), grant: id, path: relativePath }),
  z.object({ op: z.literal('read'), grant: id, path: relativePath }),
  z.object({ op: z.literal('write'), grant: id, path: relativePath.refine(value => !!value), data: z.string().max(1_400_000) }),
  z.object({ op: z.literal('copy'), grant: id, source: relativePath, destination: relativePath }),
  z.object({ op: z.literal('execute'), command: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(100),
    cwd: path.optional(), timeoutMs: z.number().int().min(1).max(30_000).optional() }),
  z.object({ op: z.literal('request'), grant: id, url: z.string().url().max(8192), method: z.enum(['GET', 'POST']), body: z.string().max(1_048_576).optional() }),
]);
/** A validated command on the cloud-to-desktop channel. */
export type LocalOperation = z.infer<typeof operationSchema>;
/** Bounded reply value; the consuming session further validates its operation-specific shape. */
export const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.union([z.null(), z.string().max(1_400_000),
    z.array(z.object({ name: z.string().max(4096), kind: z.enum(['file', 'directory']) })).max(1000),
    z.object({ output: z.string().max(1_048_576), exitCode: z.number().int().optional() })]) }),
  z.object({ ok: z.literal(false), error: z.literal('Local operation failed') }),
]);
/** Validated local result. */
export type LocalResult = z.infer<typeof resultSchema>;

/** Consume at most two MiB before parsing HTTP JSON. */
export async function readJson(request: Pick<Request, 'body'>): Promise<unknown> {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Request too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
