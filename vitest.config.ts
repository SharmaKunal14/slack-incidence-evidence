import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html'],
    },
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});
