import config from '../../scripts/gatekeeper-configurator-vite-config.js';

export default { ...config, run: { ...config.run, tasks: {
  ...config.run.tasks,
  build: { ...config.run.tasks.build, command: 'tsc && tsc -p tsconfig.daemon.json' },
  test: { command: "node --test 'daemon/*.test.ts' && vitest run", dependsOn: ['build:configurator'], cache: false },
} } };
