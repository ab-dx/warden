import { defineConfig } from 'vitest/config';

// the temporal test server downloads and boots on first use
export default defineConfig({ test: { hookTimeout: 120_000, testTimeout: 60_000 } });
