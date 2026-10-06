import { defineConfig } from 'vitest/config';

// catalog/ holds the tasks' own tests (run with node --test inside the sandbox), not ours.
// Fake herdr panes cannot host a sandboxed shell: jail.ts is tested on its own.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, env: { AILOVEBENCH_NO_SANDBOX: '1', AILOVEBENCH_LANG: 'fr' } } });
