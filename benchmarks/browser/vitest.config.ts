import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir();

export default defineConfig({
  root: workspace,
  cacheDir: join(artifactRoot, 'browser-benchmark-vite'),
  resolve: {
    alias: {
      '@': join(workspace, 'src'),
      '@shared': join(workspace, 'shared'),
      '@electron': join(workspace, 'electron'),
    },
  },
  test: {
    include: ['benchmarks/browser/tests/core.integration.test.ts'],
    environment: 'node',
    env: { PISKIE_TEST_ARTIFACT_DIR: artifactRoot },
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
