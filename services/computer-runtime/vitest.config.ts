import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import capnwebValidate from 'capnweb-validate/vite';

export default defineConfig({ plugins: [capnwebValidate(), cloudflareTest({ main: './src/index.ts', miniflare: {
  compatibilityDate: '2026-08-08', compatibilityFlags: ['nodejs_compat'],
  r2Buckets: ['WORKSPACES'], bindings: { SANDBOX_TRANSPORT: 'rpc' },
  durableObjects: { Workspaces: { className: 'ComputerWorkspace', useSQLite: true }, Sandbox: { className: 'BotSandbox', useSQLite: true } },
} })], test: { include: ['__tests__/*.test.ts'], setupFiles: ['../../scripts/assert-workerd.ts'] } });
