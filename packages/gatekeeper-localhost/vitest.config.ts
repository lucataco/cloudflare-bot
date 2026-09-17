import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import capnwebValidate from 'capnweb-validate/vite';

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({ main: './__tests__/worker.ts', miniflare: {
    compatibilityDate: '2026-08-08', compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
    durableObjects: { DEVICE: { className: 'LocalDevice', useSQLite: true }, HARNESS: { className: 'TestHarness', useSQLite: true }, RESOURCE: { className: 'LocalGatekeeper', useSQLite: true } },
  } })],
  test: { include: ['__tests__/*.test.ts'], setupFiles: ['../../scripts/assert-workerd.ts'] },
});
