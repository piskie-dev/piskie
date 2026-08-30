import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
  test: {
    include: ['shared/**/*.test.ts', 'electron/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: [
      './electron/testing/feishu-cjs-source-resolver.setup.ts',
      './src/testing/i18n.setup.ts',
    ],
    environment: 'node',
  },
});
