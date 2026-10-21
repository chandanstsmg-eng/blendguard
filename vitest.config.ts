import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Same import shortcuts as the screens (vite.config.ts), so screen logic can be tested too.
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup-db.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
