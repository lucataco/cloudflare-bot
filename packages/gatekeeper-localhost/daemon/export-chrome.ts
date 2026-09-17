import { cp, mkdtemp, mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { z } from 'zod';

// Explicit, local-owner operation. Chrome itself decrypts its copied profile using the OS keychain;
// this utility never extracts keychain keys or sends cookies to a network service.
const [profile, destination, executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] = process.argv.slice(2);
if (!profile || !destination) throw new Error('Usage: export:chrome <Chrome profile directory> <output.json> [Chrome executable]');
const scratch = await mkdtemp(join(tmpdir(), 'workshop-chrome-'));
let child: ReturnType<typeof spawn> | undefined;
try {
  await mkdir(join(scratch, 'Default'));
  const copy = async (source: string, target: string, optional = false) => {
    try {
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Unsupported profile file');
      await cp(source, target);
    } catch (error) {
      if (!(optional && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
  await copy(join(profile, '..', 'Local State'), join(scratch, 'Local State'));
  await copy(join(profile, 'Preferences'), join(scratch, 'Default', 'Preferences'));
  for (const directory of ['', 'Network']) {
    if (directory) await mkdir(join(scratch, 'Default', directory));
    await copy(join(profile, directory, 'Cookies'), join(scratch, 'Default', directory, 'Cookies'), true);
  }
  child = spawn(executable, ['--headless=new', `--user-data-dir=${scratch}`, '--profile-directory=Default', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let exited = false;
  child.on('error', () => { exited = true });
  child.on('exit', () => { exited = true });
  let address = '';
  for (let i = 0; i < 100; ++i) {
    if (exited) break;
    try {
      const [port, path] = (await readFile(join(scratch, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (!/^\d{1,5}$/.test(port) || !path.startsWith('/devtools/browser/')) throw new Error('Invalid browser endpoint');
      address = `ws://127.0.0.1:${port}${path}`;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!address) throw new Error('Could not start the selected Chrome profile');
  const cookies = await new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(address);
    const timer = setTimeout(() => { socket.close(); reject(new Error('Chrome session export timed out')); }, 10_000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })));
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome session export failed')); });
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) throw new Error('Chrome response too large');
        const reply = z.object({ id: z.literal(1), result: z.object({ cookies: z.array(z.object({
          name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
          httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
        })).max(1000) }) }).parse(JSON.parse(event.data));
        clearTimeout(timer); socket.close(); resolve(reply.result.cookies);
      } catch { clearTimeout(timer); socket.close(); reject(new Error('Could not read Chrome session')); }
    });
  });
  await writeFile(destination, JSON.stringify(cookies), { mode: 0o600, flag: 'wx' });
  console.info('Session export written. Import it from the destination bot’s Computer view, then delete the export.');
} finally {
  child?.kill('SIGKILL');
  await rm(scratch, { recursive: true, force: true });
}
